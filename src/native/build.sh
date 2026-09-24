#!/bin/sh
# Compiles the app-events helper into out/. Only macOS can build or use it;
# elsewhere (CI on Ubuntu) this is a no-op and the app falls back to polling.
set -e
if [ "$(uname)" != "Darwin" ] || ! command -v swiftc >/dev/null 2>&1; then
  echo "app-events: skipped (needs macOS with swiftc)"
  exit 0
fi
cd "$(dirname "$0")/../.."
mkdir -p out
swiftc -O -o out/app-events src/native/app-events.swift
echo "app-events: built out/app-events"
