package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

type dialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// serveForward accepts overlay connections and pipes each one to a local address.
func serveForward(ctx context.Context, ln net.Listener, to string) {
	for {
		c, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go func() {
			defer c.Close()
			var d net.Dialer
			dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			up, err := d.DialContext(dctx, "tcp", to)
			cancel()
			if err != nil {
				return
			}
			pipe(c, up)
		}()
	}
}

// serveProxy is a local SOCKS5 (no auth, CONNECT only) and HTTP CONNECT proxy that dials through dial.
// The first byte tells the two apart: 0x05 is SOCKS5, anything else is read as an HTTP request.
func serveProxy(ctx context.Context, ln net.Listener, dial dialFunc) {
	for {
		c, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go handleProxyConn(ctx, c, dial)
	}
}

func handleProxyConn(ctx context.Context, c net.Conn, dial dialFunc) {
	defer c.Close()
	c.SetDeadline(time.Now().Add(30 * time.Second))
	br := bufio.NewReader(c)
	first, err := br.Peek(1)
	if err != nil {
		return
	}
	var target string
	var reply func(ok bool) error
	if first[0] == 0x05 {
		target, reply, err = socks5Handshake(br, c)
	} else {
		target, reply, err = httpConnect(br, c)
	}
	if err != nil {
		return
	}
	dctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	up, err := dial(dctx, "tcp", target)
	cancel()
	if err != nil {
		reply(false)
		return
	}
	defer up.Close()
	if err := reply(true); err != nil {
		return
	}
	c.SetDeadline(time.Time{})
	// Bytes the client sent after the handshake may already sit in the reader.
	if n := br.Buffered(); n > 0 {
		b, _ := br.Peek(n)
		if _, err := up.Write(b); err != nil {
			return
		}
	}
	pipe(c, up)
}

func socks5Handshake(br *bufio.Reader, c net.Conn) (string, func(bool) error, error) {
	hdr := make([]byte, 2)
	if _, err := io.ReadFull(br, hdr); err != nil {
		return "", nil, err
	}
	methods := make([]byte, int(hdr[1]))
	if _, err := io.ReadFull(br, methods); err != nil {
		return "", nil, err
	}
	noAuth := false
	for _, m := range methods {
		if m == 0x00 {
			noAuth = true
		}
	}
	if !noAuth {
		c.Write([]byte{0x05, 0xff})
		return "", nil, errors.New("socks: no acceptable auth method")
	}
	if _, err := c.Write([]byte{0x05, 0x00}); err != nil {
		return "", nil, err
	}
	req := make([]byte, 4)
	if _, err := io.ReadFull(br, req); err != nil {
		return "", nil, err
	}
	fail := func(code byte) { c.Write([]byte{0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0}) }
	if req[0] != 0x05 || req[1] != 0x01 {
		fail(0x07)
		return "", nil, errors.New("socks: only CONNECT is supported")
	}
	var host string
	switch req[3] {
	case 0x01:
		b := make([]byte, 4)
		if _, err := io.ReadFull(br, b); err != nil {
			return "", nil, err
		}
		host = net.IP(b).String()
	case 0x04:
		b := make([]byte, 16)
		if _, err := io.ReadFull(br, b); err != nil {
			return "", nil, err
		}
		host = net.IP(b).String()
	case 0x03:
		l, err := br.ReadByte()
		if err != nil {
			return "", nil, err
		}
		b := make([]byte, int(l))
		if _, err := io.ReadFull(br, b); err != nil {
			return "", nil, err
		}
		host = string(b)
	default:
		fail(0x08)
		return "", nil, errors.New("socks: bad address type")
	}
	pb := make([]byte, 2)
	if _, err := io.ReadFull(br, pb); err != nil {
		return "", nil, err
	}
	port := binary.BigEndian.Uint16(pb)
	target := net.JoinHostPort(host, strconv.Itoa(int(port)))
	reply := func(ok bool) error {
		if !ok {
			fail(0x05)
			return nil
		}
		_, err := c.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return err
	}
	return target, reply, nil
}

func httpConnect(br *bufio.Reader, c net.Conn) (string, func(bool) error, error) {
	req, err := http.ReadRequest(br)
	if err != nil {
		return "", nil, err
	}
	if req.Method != http.MethodConnect {
		fmt.Fprint(c, "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
		return "", nil, errors.New("http proxy: only CONNECT is supported")
	}
	target := req.Host
	if _, _, err := net.SplitHostPort(target); err != nil {
		fmt.Fprint(c, "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
		return "", nil, err
	}
	reply := func(ok bool) error {
		if !ok {
			_, err := fmt.Fprint(c, "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
			return err
		}
		_, err := fmt.Fprint(c, "HTTP/1.1 200 Connection established\r\n\r\n")
		return err
	}
	return target, reply, nil
}

// pipe copies both ways and closes write halves so each side sees EOF.
func pipe(a, b net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)
	cp := func(dst, src net.Conn) {
		defer wg.Done()
		io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			cw.CloseWrite()
		} else {
			dst.Close()
		}
	}
	go cp(a, b)
	go cp(b, a)
	wg.Wait()
}
