#!/bin/sh
# Compiles the native helpers into out/: app-events, and fan control's root
# helper and bridge. Only macOS can build or use them; elsewhere (CI on Ubuntu)
# this is a no-op. Without app-events the app falls back to polling; without
# the fan pieces it hides fan control.
set -e
if [ "$(uname)" != "Darwin" ] || ! command -v swiftc >/dev/null 2>&1; then
  echo "native helpers: skipped (needs macOS with swiftc)"
  exit 0
fi
cd "$(dirname "$0")/../.."
mkdir -p out
swiftc -O -o out/app-events src/native/app-events.swift
echo "app-events: built out/app-events"
F=src/native/fans
swiftc -O -swift-version 5 -o out/fan-helper $F/smc.swift $F/shared.swift $F/helper/main.swift
swiftc -O -swift-version 5 -o out/fan-bridge $F/smc.swift $F/shared.swift $F/bridge/main.swift
echo "fans: built out/fan-helper and out/fan-bridge"
