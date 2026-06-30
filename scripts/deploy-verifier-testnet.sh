#!/usr/bin/env bash
# Deploy verifier + registry to Stellar testnet, register the verifier, and run
# the on-chain BN254 smoke (audit Part G testnet acceptance).
#
# Auth: pass a funded testnet identity via SEFI_TESTNET_IDENTITY (a `stellar keys`
# alias) or STELLAR_TESTNET_SECRET (S... secret). If neither is set, this script
# generates + funds a throwaway testnet key automatically.
set -euo pipefail

if ! command -v stellar >/dev/null 2>&1; then
  echo "testnet skipped: stellar CLI not found."
  exit 0
fi

# Prefer the rustup toolchain so wasm32v1-none + soroban-sdk 25.3 build.
if command -v rustup >/dev/null 2>&1; then
  TC_BIN="$(rustup which rustc 2>/dev/null | xargs dirname || true)"
  [ -n "$TC_BIN" ] && export PATH="$TC_BIN:$PATH"
fi

# Resolve the signing source.
if [ -n "${STELLAR_TESTNET_SECRET:-}" ]; then
  SRC="$STELLAR_TESTNET_SECRET"
elif [ -n "${SEFI_TESTNET_IDENTITY:-}" ]; then
  SRC="$SEFI_TESTNET_IDENTITY"
else
  SRC="sefi-testnet"
  if ! stellar keys address "$SRC" >/dev/null 2>&1; then
    echo "Generating + funding throwaway testnet key '$SRC'..."
    stellar keys generate "$SRC" --network testnet --fund
  fi
fi
echo "Deployer: $(stellar keys address "$SRC" 2>/dev/null || echo "$SRC")"

bash scripts/contracts-build.sh

REG=contracts/sefi_verifier_registry/target/wasm32v1-none/release/sefi_verifier_registry.wasm
VER=contracts/noir_ultrahonk_verifier/target/wasm32v1-none/release/noir_ultrahonk_verifier.wasm

echo "== deploy verifier =="
VID=$(stellar contract deploy --wasm "$VER" --source "$SRC" --network testnet 2>/dev/null | tail -1)
echo "VERIFIER_CONTRACT_ID=$VID"

echo "== deploy registry =="
RID=$(stellar contract deploy --wasm "$REG" --source "$SRC" --network testnet 2>/dev/null | tail -1)
echo "REGISTRY_CONTRACT_ID=$RID"

echo "== register verifier for proof_type 'blendutil' =="
VK_HASH=$(printf '%064d' 0)
stellar contract invoke --id "$RID" --source "$SRC" --network testnet --send=yes \
  -- register_verifier --proof_type blendutil --verifier "$VID" --verifier_hash "$VK_HASH" \
  >/dev/null 2>&1 && echo "registered."

echo "== on-chain BN254 smoke (g1 double) =="
stellar contract invoke --id "$VID" --source "$SRC" --network testnet \
  -- bn254_smoke_g1_double

echo
echo "Save these:"
echo "  export SEFI_VERIFIER_CONTRACT_ID=$VID"
echo "  export SEFI_REGISTRY_CONTRACT_ID=$RID"
echo "  export SEFI_NETWORK=testnet"
