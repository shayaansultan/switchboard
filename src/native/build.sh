#!/bin/sh
# Compiles the native helpers into out/: app-events, and the root system
# helper and its bridge (fan boosts and lid-closed Caffeinate). Only macOS can
# build or use them; elsewhere (CI on Ubuntu) this is a no-op. Without
# app-events the app falls back to polling; without the system pieces it hides
# Fans and the lid-closed option.
set -e
if [ "$(uname)" != "Darwin" ] || ! command -v swiftc >/dev/null 2>&1; then
  echo "native helpers: skipped (needs macOS with swiftc)"
  exit 0
fi
cd "$(dirname "$0")/../.."
mkdir -p out
swiftc -O -o out/app-events src/native/app-events.swift
echo "app-events: built out/app-events"
# In their own folder: out/system-bridge would shadow out/system-bridge.js
# for require('./system-bridge').
S=src/native/system
mkdir -p out/native
swiftc -O -swift-version 5 -o out/native/system-helper $S/smc.swift $S/shared.swift $S/helper/main.swift
swiftc -O -swift-version 5 -o out/native/system-bridge $S/smc.swift $S/shared.swift $S/bridge/main.swift
echo "system: built out/native/system-helper and out/native/system-bridge"
