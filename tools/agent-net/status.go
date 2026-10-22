package main

import (
	"context"
	"sort"
	"strings"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn/ipnstate"
)

type forwardInfo struct {
	Port int `json:"port"`
	To   int `json:"to"`
}

type extraInfo struct {
	Socks      string
	Forward    *forwardInfo
	StatusAddr string
}

type peerLine struct {
	Name    string   `json:"name"`
	DNSName string   `json:"dnsName,omitempty"`
	IPs     []string `json:"ips"`
	Online  bool     `json:"online"`
	OS      string   `json:"os,omitempty"`
}

type statusLine struct {
	Type       string       `json:"type"`
	State      string       `json:"state"`
	AuthURL    string       `json:"authURL,omitempty"`
	TailnetIPs []string     `json:"tailnetIPs"`
	DNSName    string       `json:"dnsName,omitempty"`
	Hostname   string       `json:"hostname,omitempty"`
	Socks      string       `json:"socks,omitempty"`
	Forward    *forwardInfo `json:"forward,omitempty"`
	StatusAddr string       `json:"statusAddr,omitempty"`
	Peers      []peerLine   `json:"peers"`
	Health     []string     `json:"health,omitempty"`
}

func buildStatus(st *ipnstate.Status, extra extraInfo) statusLine {
	out := statusLine{
		Type:       "status",
		State:      st.BackendState,
		AuthURL:    st.AuthURL,
		TailnetIPs: []string{},
		Socks:      extra.Socks,
		Forward:    extra.Forward,
		StatusAddr: extra.StatusAddr,
		Peers:      []peerLine{},
		Health:     st.Health,
	}
	for _, ip := range st.TailscaleIPs {
		out.TailnetIPs = append(out.TailnetIPs, ip.String())
	}
	if st.Self != nil {
		out.DNSName = strings.TrimSuffix(st.Self.DNSName, ".")
		out.Hostname = st.Self.HostName
	}
	for _, p := range st.Peer {
		if p == nil {
			continue
		}
		pl := peerLine{
			Name:    p.HostName,
			DNSName: strings.TrimSuffix(p.DNSName, "."),
			IPs:     []string{},
			Online:  p.Online,
			OS:      p.OS,
		}
		for _, ip := range p.TailscaleIPs {
			pl.IPs = append(pl.IPs, ip.String())
		}
		out.Peers = append(out.Peers, pl)
	}
	sort.Slice(out.Peers, func(i, j int) bool {
		if out.Peers[i].Name != out.Peers[j].Name {
			return out.Peers[i].Name < out.Peers[j].Name
		}
		return out.Peers[i].DNSName < out.Peers[j].DNSName
	})
	return out
}

// watchStatus polls the embedded node once a second and prints a status line whenever it changes.
// Polling (rather than the IPN bus) keeps peer online flags fresh too; the emitter drops repeats.
func watchStatus(ctx context.Context, lc *local.Client, em *emitter, extra extraInfo) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		sctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		st, err := lc.Status(sctx)
		cancel()
		if err == nil {
			em.emit(buildStatus(st, extra))
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
