#!/usr/bin/env bash
# Cross-compile agent-net for every platform the Agent app ships on. CGO off, stripped.
# Outputs:
#   dist/agent-net-<goos>-<goarch>[.exe]          the binaries (the headless tarball takes linux-amd64)
#   dist/electron/<os>-<arch>/agent-net[.exe]     the same, laid out for electron-builder's ${os}-${arch}
#                                                 (apps/desktop/electron-builder.yml extraResources)
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${AGENT_NET_VERSION:-0.1.0}"
mkdir -p dist
for target in linux/amd64 linux/arm64 windows/amd64 darwin/arm64 darwin/amd64; do
  os="${target%/*}"
  arch="${target#*/}"
  ext=""
  [ "$os" = windows ] && ext=".exe"
  out="dist/agent-net-${os}-${arch}${ext}"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o "$out" .
  case "$os" in windows) eos=win ;; darwin) eos=mac ;; *) eos=linux ;; esac
  case "$arch" in amd64) earch=x64 ;; *) earch="$arch" ;; esac
  mkdir -p "dist/electron/${eos}-${earch}"
  cp "$out" "dist/electron/${eos}-${earch}/agent-net${ext}"
  echo "$out $(stat -c %s "$out")"
done
