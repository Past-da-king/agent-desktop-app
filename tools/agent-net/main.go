// Command agent-net is the optional overlay-network sidecar for the Agent app's Devices feature.
// It runs an embedded Tailscale-compatible node (tsnet) in user space, forwards overlay TCP connections on the
// node port to a local port, and offers a local SOCKS5 / HTTP CONNECT proxy that dials through the overlay.
// See README.md. The auth key is never printed or logged.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"tailscale.com/net/netns"
	"tailscale.com/tsnet"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

// stdinReader is shared by --authkey-stdin (first line) and --stdin-control (the lines after it).
var stdinReader = bufio.NewReader(os.Stdin)

type options struct {
	controlURL   string
	authKey      string
	authStdin    bool
	hostname     string
	stateDir     string
	forward      int
	listenPort   int
	socks        string
	status       string
	ephemeral    bool
	logoutOnExit bool
	verbose      bool
	noNetns      bool
	stdinControl bool
}

func parseFlags(args []string) (options, error) {
	var o options
	fs := flag.NewFlagSet("agent-net", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.StringVar(&o.controlURL, "control-url", "", "control server URL (empty = Tailscale default; set for Headscale)")
	fs.StringVar(&o.authKey, "authkey", "", "auth key (manual use only; prefer env AGENT_NET_AUTHKEY or --authkey-stdin)")
	fs.BoolVar(&o.authStdin, "authkey-stdin", false, "read the auth key from the first line of stdin")
	fs.StringVar(&o.hostname, "hostname", "", "node name on the overlay")
	fs.StringVar(&o.stateDir, "state-dir", "", "directory for the node's state (required)")
	fs.IntVar(&o.forward, "forward", 0, "forward overlay TCP on --listen-port to 127.0.0.1:<port>")
	fs.IntVar(&o.listenPort, "listen-port", 7787, "overlay port used by --forward")
	fs.StringVar(&o.socks, "socks", "", "local SOCKS5 / HTTP CONNECT proxy address, e.g. 127.0.0.1:0")
	fs.StringVar(&o.status, "status", "", "local HTTP status address, e.g. 127.0.0.1:0")
	fs.BoolVar(&o.ephemeral, "ephemeral", false, "register as an ephemeral node")
	fs.BoolVar(&o.logoutOnExit, "logout-on-exit", false, "log the node out on shutdown")
	fs.BoolVar(&o.verbose, "verbose", false, "embedded node logs to stderr")
	// Tests on a single machine talk to a DERP relay on loopback; socket marking gets in the way there.
	fs.BoolVar(&o.noNetns, "test-no-netns", false, "testing only: disable socket network-namespace marking")
	fs.BoolVar(&o.stdinControl, "stdin-control", false, "read control lines from stdin: quit, logout; stdin closing also quits")
	showVersion := fs.Bool("version", false, "print the version and exit")
	if err := fs.Parse(args); err != nil {
		return o, err
	}
	if *showVersion {
		fmt.Println(version)
		os.Exit(0)
	}
	if o.stateDir == "" {
		return o, errors.New("--state-dir is required")
	}
	if o.forward < 0 || o.forward > 65535 || o.listenPort <= 0 || o.listenPort > 65535 {
		return o, errors.New("bad port")
	}
	if o.authKey == "" {
		o.authKey = strings.TrimSpace(os.Getenv("AGENT_NET_AUTHKEY"))
	}
	if o.authStdin {
		line, err := stdinReader.ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return o, fmt.Errorf("reading auth key from stdin: %w", err)
		}
		if k := strings.TrimSpace(line); k != "" {
			o.authKey = k
		}
	}
	// Keep the key out of child environments.
	os.Unsetenv("AGENT_NET_AUTHKEY")
	return o, nil
}

// emitter writes one JSON object per line to stdout and keeps the last status for the HTTP endpoint.
type emitter struct {
	mu   sync.Mutex
	out  io.Writer
	last []byte
}

func (e *emitter) emit(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if st, ok := v.(statusLine); ok && st.Type == "status" {
		if string(b) == string(e.last) {
			return
		}
		e.last = b
	}
	e.out.Write(append(b, '\n'))
}

func (e *emitter) lastStatus() []byte {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.last
}

func fatal(em *emitter, err error) {
	em.emit(map[string]string{"type": "error", "error": err.Error()})
	os.Exit(1)
}

func main() {
	em := &emitter{out: os.Stdout}
	o, err := parseFlags(os.Args[1:])
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			os.Exit(0)
		}
		fatal(em, err)
	}
	if o.noNetns {
		netns.SetEnabled(false)
	}
	if err := os.MkdirAll(o.stateDir, 0o700); err != nil {
		fatal(em, err)
	}

	srv := &tsnet.Server{
		Dir:        o.stateDir,
		Hostname:   o.hostname,
		ControlURL: o.controlURL,
		AuthKey:    o.authKey,
		Ephemeral:  o.ephemeral,
		UserLogf:   func(string, ...any) {},
		Logf:       func(string, ...any) {},
	}
	if o.verbose {
		l := log.New(os.Stderr, "", log.LstdFlags)
		srv.Logf = l.Printf
		srv.UserLogf = l.Printf
	}
	o.authKey = ""

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, os.Interrupt)

	if err := srv.Start(); err != nil {
		fatal(em, fmt.Errorf("start: %w", err))
	}
	lc, err := srv.LocalClient()
	if err != nil {
		fatal(em, err)
	}

	var extra extraInfo
	var closers []io.Closer

	if o.socks != "" {
		ln, err := net.Listen("tcp", o.socks)
		if err != nil {
			fatal(em, fmt.Errorf("socks listen: %w", err))
		}
		closers = append(closers, ln)
		extra.Socks = ln.Addr().String()
		go serveProxy(ctx, ln, srv.Dial)
	}
	if o.forward > 0 {
		ln, err := srv.Listen("tcp", ":"+strconv.Itoa(o.listenPort))
		if err != nil {
			fatal(em, fmt.Errorf("overlay listen: %w", err))
		}
		closers = append(closers, ln)
		extra.Forward = &forwardInfo{Port: o.listenPort, To: o.forward}
		go serveForward(ctx, ln, "127.0.0.1:"+strconv.Itoa(o.forward))
	}
	if o.status != "" {
		ln, err := net.Listen("tcp", o.status)
		if err != nil {
			fatal(em, fmt.Errorf("status listen: %w", err))
		}
		closers = append(closers, ln)
		extra.StatusAddr = ln.Addr().String()
		mux := http.NewServeMux()
		mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			b := em.lastStatus()
			if b == nil {
				b = []byte(`{"type":"status","state":"NoState"}`)
			}
			w.Write(b)
		})
		go http.Serve(ln, mux)
	}

	go watchStatus(ctx, lc, em, extra)

	// Shutdown comes from a signal, or (with --stdin-control) a "quit" / "logout" line or stdin closing, which is
	// how a parent on Windows (no SIGTERM) stops it, and how it stops when the parent dies.
	stop := make(chan string, 2)
	go func() {
		<-sigs
		stop <- "signal"
	}()
	if o.stdinControl {
		go func() {
			for {
				line, err := stdinReader.ReadString('\n')
				switch strings.TrimSpace(line) {
				case "quit":
					stop <- "quit"
					return
				case "logout":
					stop <- "logout"
					return
				}
				if err != nil {
					stop <- "eof"
					return
				}
			}
		}()
	}
	reason := <-stop
	cancel()
	if o.logoutOnExit || reason == "logout" {
		lctx, lcancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := lc.Logout(lctx); err != nil {
			em.emit(map[string]string{"type": "warning", "warning": "logout: " + err.Error()})
		}
		lcancel()
	}
	for _, c := range closers {
		c.Close()
	}
	done := make(chan struct{})
	go func() { srv.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
	em.emit(map[string]string{"type": "exit"})
}
