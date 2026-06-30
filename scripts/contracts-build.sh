#!/usr/bin/env bash
# Build both Sefi Soroban contracts to wasm (audit Part G / Part L).
# Uses the rustup toolchain (1.91+ for soroban-sdk 25.3 + wasm32v1-none target).
set -euo pipefail

# Prefer the rustup toolchain so the wasm std/core for wasm32v1-none is available.
if command -v rustup >/dev/null 2>&1; then
  TC_BIN="$(rustup which rustc 2>/dev/null | xargs dirname || true)"
  [ -n "$TC_BIN" ] && export PATH="$TC_BIN:$PATH"
fi
echo "rustc: $(rustc --version)"

for c in sefi_verifier_registry noir_ultrahonk_verifier; do
  echo "== building $c =="
  if command -v stellar >/dev/null 2>&1; then
    (cd "contracts/$c" && stellar contract build) || \
      (cd "contracts/$c" && cargo build --target wasm32v1-none --release)
  else
    (cd "contracts/$c" && cargo build --target wasm32v1-none --release)
  fi
done

echo "wasm artifacts:"
ls -la contracts/*/target/wasm32v1-none/release/*.wasm 2>/dev/null || true
