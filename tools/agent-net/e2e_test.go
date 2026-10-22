package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/net/proxy"
	"tailscale.com/tailcfg"
	"tailscale.com/tstest/integration"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/logger"
)

var binPath string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "agent-net-test-")
	if err != nil {
		panic(err)
	}
	binPath = filepath.Join(dir, "agent-net")
	if runtime.GOOS == "windows" {
		binPath += ".exe"
	}
	cmd := exec.Command("go", "build", "-o", binPath, ".")
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Run(); err != nil {
		panic(err)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// echoServer answers every connection by echoing what it reads.
func echoServer(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(c, c) }()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func roundTrip(t *testing.T, c net.Conn, msg string) {
	t.Helper()
	defer c.Close()
	c.SetDeadline(time.Now().Add(20 * time.Second))
	if _, err := c.Write([]byte(msg)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != msg {
		t.Fatalf("echo mismatch: %q", buf)
	}
}

func TestProxyAgainstLoopbackStub(t *testing.T) {
	port := echoServer(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var d net.Dialer
	go serveProxy(ctx, ln, d.DialContext)
	target := fmt.Sprintf("127.0.0.1:%d", port)

	sd, err := proxy.SOCKS5("tcp", ln.Addr().String(), nil, proxy.Direct)
	if err != nil {
		t.Fatal(err)
	}
	c, err := sd.Dial("tcp", target)
	if err != nil {
		t.Fatal(err)
	}
	roundTrip(t, c, "socks hello")

	c2 := httpConnectDial(t, ln.Addr().String(), target)
	roundTrip(t, c2, "connect hello")

	// A dead target gets a proper failure, not a hang.
	dead, _ := net.Listen("tcp", "127.0.0.1:0")
	deadAddr := dead.Addr().String()
	dead.Close()
	if _, err := sd.Dial("tcp", deadAddr); err == nil {
		t.Fatal("expected socks dial to a closed port to fail")
	}
}

func httpConnectDial(t *testing.T, proxyAddr, target string) net.Conn {
	t.Helper()
	c, err := net.Dial("tcp", proxyAddr)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("CONNECT status %d", resp.StatusCode)
	}
	return c
}

type node struct {
	cmd   *exec.Cmd
	mu    sync.Mutex
	lines []map[string]any
	last  statusLine
	done  chan error
}

func startNode(t *testing.T, controlURL, name string, extra ...string) *node {
	t.Helper()
	n, _ := startNodeWithStdin(t, controlURL, name, extra...)
	return n
}

func startNodeWithStdin(t *testing.T, controlURL, name string, extra ...string) (*node, io.WriteCloser) {
	t.Helper()
	args := append([]string{
		"--control-url", controlURL,
		"--hostname", name,
		"--state-dir", filepath.Join(t.TempDir(), name),
		"--ephemeral",
		"--test-no-netns",
	}, extra...)
	cmd := exec.Command(binPath, args...)
	cmd.Env = append(os.Environ(), "AGENT_NET_AUTHKEY=")
	if testing.Verbose() {
		cmd.Stderr = os.Stderr
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	n := &node{cmd: cmd, done: make(chan error, 1)}
	go func() {
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			var m map[string]any
			if json.Unmarshal(sc.Bytes(), &m) != nil {
				continue
			}
			n.mu.Lock()
			n.lines = append(n.lines, m)
			if m["type"] == "status" {
				var st statusLine
				json.Unmarshal(sc.Bytes(), &st)
				n.last = st
			}
			n.mu.Unlock()
		}
		n.done <- cmd.Wait()
	}()
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			cmd.Process.Kill()
		}
	})
	return n, stdin
}

func (n *node) status() statusLine {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.last
}

func (n *node) hasLine(typ string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, l := range n.lines {
		if l["type"] == typ {
			return true
		}
	}
	return false
}

func waitFor(t *testing.T, what string, d time.Duration, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestStdinControl(t *testing.T) {
	controlURL := startTestControl(t)
	for _, how := range []string{"quit", "logout", "eof"} {
		t.Run(how, func(t *testing.T) {
			n, stdin := startNodeWithStdin(t, controlURL, "ctl-"+how, "--authkey-stdin", "--stdin-control")
			io.WriteString(stdin, "\n") // empty key line: the test control server needs none
			waitFor(t, "Running", 60*time.Second, func() bool { return n.status().State == "Running" })
			if how == "eof" {
				stdin.Close()
			} else {
				io.WriteString(stdin, how+"\n")
			}
			select {
			case err := <-n.done:
				if err != nil {
					t.Fatalf("exit: %v", err)
				}
			case <-time.After(20 * time.Second):
				t.Fatal("did not exit")
			}
			if !n.hasLine("exit") {
				t.Fatal("no exit line")
			}
		})
	}
}

func startTestControl(t *testing.T) string {
	t.Helper()
	derpMap := integration.RunDERPAndSTUN(t, logger.Discard, "127.0.0.1")
	control := &testcontrol.Server{
		DERPMap:        derpMap,
		DNSConfig:      &tailcfg.DNSConfig{Proxied: true},
		MagicDNSDomain: "test-net.ts.net",
		Logf:           logger.Discard,
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)
	return control.HTTPTestServer.URL
}

func TestTwoNodesForwardAndSocks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses SIGTERM")
	}
	derpMap := integration.RunDERPAndSTUN(t, logger.Discard, "127.0.0.1")
	control := &testcontrol.Server{
		DERPMap:        derpMap,
		DNSConfig:      &tailcfg.DNSConfig{Proxied: true},
		MagicDNSDomain: "test-net.ts.net",
		Logf:           logger.Discard,
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)
	controlURL := control.HTTPTestServer.URL

	echoPort := echoServer(t)
	a := startNode(t, controlURL, "node-a", "--forward", fmt.Sprint(echoPort), "--listen-port", "7787", "--status", "127.0.0.1:0")
	b := startNode(t, controlURL, "node-b", "--socks", "127.0.0.1:0")

	waitFor(t, "both nodes Running with each other as peers", 90*time.Second, func() bool {
		sa, sb := a.status(), b.status()
		if sa.State != "Running" || sb.State != "Running" || len(sa.TailnetIPs) == 0 || sb.Socks == "" {
			return false
		}
		for _, p := range sb.Peers {
			if p.Name == "node-a" && len(p.IPs) > 0 {
				return true
			}
		}
		return false
	})
	sa, sb := a.status(), b.status()
	t.Logf("node-a %v %s forward=%+v; node-b socks=%s peers=%d", sa.TailnetIPs, sa.DNSName, sa.Forward, sb.Socks, len(sb.Peers))
	if sa.Forward == nil || sa.Forward.Port != 7787 || sa.Forward.To != echoPort {
		t.Fatalf("forward info wrong: %+v", sa.Forward)
	}
	if !strings.HasPrefix(sa.DNSName, "node-a.") {
		t.Fatalf("dnsName %q", sa.DNSName)
	}

	// Status endpoint returns the same JSON.
	resp, err := http.Get("http://" + sa.StatusAddr + "/status")
	if err != nil {
		t.Fatal(err)
	}
	var viaHTTP statusLine
	json.NewDecoder(resp.Body).Decode(&viaHTTP)
	resp.Body.Close()
	if viaHTTP.State != "Running" || len(viaHTTP.TailnetIPs) == 0 {
		t.Fatalf("status endpoint: %+v", viaHTTP)
	}

	target := net.JoinHostPort(sa.TailnetIPs[0], "7787")
	sd, err := proxy.SOCKS5("tcp", sb.Socks, nil, proxy.Direct)
	if err != nil {
		t.Fatal(err)
	}
	// The overlay path can take a moment after the netmap arrives; retry the first dial.
	var c net.Conn
	waitFor(t, "first SOCKS dial through the overlay", 60*time.Second, func() bool {
		c, err = sd.Dial("tcp", target)
		return err == nil
	})
	roundTrip(t, c, "hello through socks5 and forward")

	c2 := httpConnectDial(t, sb.Socks, target)
	roundTrip(t, c2, "hello through http connect and forward")

	// MagicDNS name works through the proxy too.
	c3, err := sd.Dial("tcp", net.JoinHostPort(sa.DNSName, "7787"))
	if err != nil {
		t.Fatalf("dial by MagicDNS name: %v", err)
	}
	roundTrip(t, c3, "hello by name")

	// Clean shutdown on SIGTERM.
	b.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case err := <-b.done:
		if err != nil {
			t.Fatalf("node-b exit: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("node-b did not exit on SIGTERM")
	}
	if !b.hasLine("exit") {
		t.Fatal("no exit line")
	}
	a.cmd.Process.Signal(syscall.SIGTERM)
	<-a.done
}

func TestFlagsAndKeyHandling(t *testing.T) {
	// Missing state dir is a clean JSON error, and a key passed by env never reaches the output.
	cmd := exec.Command(binPath, "--hostname", "x")
	cmd.Env = append(os.Environ(), "AGENT_NET_AUTHKEY=tskey-test-not-a-real-key")
	out, _ := cmd.Output()
	if !strings.Contains(string(out), `"type":"error"`) || !strings.Contains(string(out), "state-dir") {
		t.Fatalf("unexpected output: %s", out)
	}
	if strings.Contains(string(out), "not-a-real-key") {
		t.Fatal("key leaked")
	}
	v, err := exec.Command(binPath, "--version").Output()
	if err != nil || strings.TrimSpace(string(v)) == "" {
		t.Fatalf("--version: %v %q", err, v)
	}
}
