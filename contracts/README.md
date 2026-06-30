# Sefi Contracts

## verifier-registry (Phase 2B, spec §15)

A Soroban contract that registers proof-type verifiers and **commits** proof
cards on-chain.

> **Honest scope:** `verify` is a registry/commitment path. It records that a
> proof card's public inputs were submitted for a registered proof type. It does
> **not** perform on-chain Groth16/PLONK verification yet. Any flow using this
> contract must label the result `proof_card_commitment_only` and must not call
> it cryptographic proof verification.

### Build & deploy (testnet, manual)

```bash
cd contracts/verifier-registry
soroban contract build
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/sefi_verifier_registry.wasm \
  --source $SEFI_TESTNET_SECRET --network testnet
export SEFI_VERIFIER_REGISTRY_ID=<deployed id>
```

Then the off-chain path stays the source of truth; the registry only adds a
durable on-chain commitment of the proof card (`emit_proof_card`).

### Client

`@sefi/verifier-registry-client` wraps the read/commitment surface over Soroban
simulate and always reports `verificationMode: "proof_card_commitment_only"`.
