# Phase 3 — Full Multi-Protocol Proof Coverage

Status: **COMPLETE** — all four recipes prove, verify locally, verify on Stellar
testnet (`stellar_verified`), and survive a durable reload. Aquarius runs over
**live** mainnet data; Blend/SDEX/Composite run over live-or-deterministic data.

Trust model (unchanged): **proof-of-data-used**, not proof-of-data-origin. Sefi
proves a deterministic policy was evaluated over the exact context capsule the
SDK selected (every fact bound into `zkFactsRoot` via an in-circuit Poseidon
Merkle proof), with private thresholds never revealed.

## Architecture — one verifier per circuit

Blend, Aquarius, SDEX and Composite circuits have **different** verification
keys, so each recipe has its own deployed Groth16 verifier contract. A verifier
initialised with the Blend VK cannot verify an Aquarius/SDEX/Composite proof
(demonstrated on-chain by the negative control in `pnpm phase3:testnet`).

```
RECIPE_CIRCUIT = {
  "blend-utilization-policy":     "blend_utilization",
  "aquarius-route-policy":        "aquarius_route",
  "sdex-exit-policy":             "sdex_exit",
  "composite-borrow-exit-policy": "composite_borrow_exit",
}
```

## Final acceptance table

| Recipe | Local proof | Local verify | Reload verify | Testnet verify | ProofCard stellar_verified |
|---|---|---|---|---|---|
| blend-utilization-policy | yes | yes | yes | yes | yes |
| aquarius-route-policy | yes | yes | yes | yes | yes |
| sdex-exit-policy | yes | yes | yes | yes | yes |
| composite-borrow-exit-policy | yes | yes | yes | yes | yes |

## Testnet deployment (`deployments/phase3-testnet.json`)

- Network: `testnet`
- Deployer: `GAUTESFW2APS3ZUE4J5Y7EA26UPMQKHCWRWF5D4YGQLKFSUJZVJNW6TV`

| Recipe | Circuit | Verifier contract | VK hash | Deploy tx |
|---|---|---|---|---|
| blend-utilization-policy | blend_utilization | `CAH6K6R2XRNDDMPFF7VRDNCW33RS5TD3NEO5LMCNQFF2UXLZ3RDSYVOG` | `0x63d0c894…` | `cd04fe6d…` |
| aquarius-route-policy | aquarius_route | `CAW6VOXHEZL6GW7T5G7GYGEIVTYLSHOMDNMSWPFHODQP5OOULGZDI6FO` | `0x53f4bb02…` | `a657b025…` |
| sdex-exit-policy | sdex_exit | `CDUWJJWIVDP4F7VA2ZX6NXKVMYA6HBRQORQGK5BW65LW7M3ALASYUUJ7` | `0x609de4ad…` | `36b310e1…` |
| composite-borrow-exit-policy | composite_borrow_exit | `CAJ4CHE6FBPBQEPQYYMJZNVEMTZTZKR6APEYPCVU5WQG4VPEYLZ27YFP` | `0xf4db9377…` | `38fb9179…` |

Verifier contract source: `contracts/noir_ultrahonk_verifier` (BN254 pairing
check over Soroban's `env.crypto().bn254()` host functions).

### Example testnet E2E run (verify_proof tx hashes)

```
blend-utilization-policy:     stellar_verified  tx 451c39c710a5bb8cb271f0eff44af509542a2c6ca5db59a858d0143e32403264
aquarius-route-policy (live): stellar_verified  tx f973d25d19d45dda9864f55185d623b3cd5b653937c09c15809ba78f94c6bcfe
sdex-exit-policy:             stellar_verified  tx f976a2135a7cdd54ce3c44d0cf6b8ea374585653e28a29c016ed59a8a0321e2c
composite-borrow-exit-policy: stellar_verified  tx dc876a661dbc38a48e8d5b03eef76e76297d01a79c891d8f861c0e07cf233b80
```

(Proofs are re-generated fresh each run, so `verify_proof` tx hashes differ per
run; the verifier contract IDs above are stable.)

## Circuits

Each recipe circuit binds the policy result to the capsule:

- `zkContextRoot === Poseidon3(zkFactsRoot, sourceRoot, adapterSetHash)`
- every fact bound into `zkFactsRoot` via `VerifiedFact(8)` (Poseidon Merkle)
- public-signal order (snarkjs): `[result, zkContextRoot, zkFactsRoot, computeHash, resultHash]`

| Circuit | Predicate |
|---|---|
| `blend_utilization` | `safe = utilization < private.maxUtilization && oracle.isFresh` |
| `aquarius_route` | `routeSafe = estimatedOut >= private.minOut && routeHops <= 4` |
| `sdex_exit` | `sdexSafe = pathAvailable && (pathEstimatedOut >= private.minReceive || spreadBps <= private.maxSpreadBps)` |
| `composite_borrow_exit` | `allowed = health > private.minHealth && ((estimatedOut >= private.minReceive && hops <= 4) \|\| (pathAvailable && pathEstimatedOut >= private.minReceive))` |

## Checklist

- [x] `blend-utilization-policy` proves + verifies locally
- [x] `aquarius-route-policy` proves + verifies locally
- [x] `sdex-exit-policy` proves + verifies locally
- [x] `composite-borrow-exit-policy` proves + verifies locally
- [x] All four produce `bn254-groth16` proof envelopes
- [x] All four serialize to the Soroban verifier format (EIP-197)
- [x] All four verify on Stellar testnet (`stellar_verified`)
- [x] Stored + reloaded envelopes still verify
- [x] Proof cards upgraded to `stellar_verified` after on-chain verification
- [x] Private thresholds never appear in cards, public inputs, API responses, logs, or saved records
- [x] Tampering fails: revealed result, resultHash, computeHash, zkFactsRoot, zkContextRoot, fact value, Merkle sibling, public signal, verifier key, verifier contract, proof bytes
- [x] `pnpm phase3:testnet` runs the full suite and exits 0
- [x] One verifier per circuit / VK (registry in `deployments/phase3-testnet.json`)

## Exact commands

```bash
pnpm install --no-frozen-lockfile
pnpm build
pnpm test
pnpm contracts:test
pnpm contracts:build

SEFI_REQUIRE_BN254=1 pnpm circom:setup      # build all 4 circuits
SEFI_REQUIRE_BN254=1 pnpm zk:test

pnpm prove:blend:bn254
pnpm prove:aquarius:bn254
pnpm prove:sdex:bn254
pnpm prove:composite:bn254

# Live-data proofs (fail loudly under SEFI_REQUIRE_LIVE=1 when data is missing):
SEFI_REQUIRE_LIVE=1 pnpm prove:aquarius:live
SEFI_REQUIRE_LIVE=1 pnpm prove:sdex:live
SEFI_DEMO_WALLET=G... SEFI_REQUIRE_LIVE=1 pnpm prove:composite:live

# Offline acceptance (no network) — proves all 4 + local verify + durable reload:
pnpm phase3:fixture

# On-chain acceptance:
pnpm deploy:phase3:testnet
SEFI_REQUIRE_BN254=1 pnpm phase3:testnet
```

Selective circuit build: `SEFI_CIRCUITS=aquarius_route pnpm circom:setup`
(also `sdex_exit`, `composite_borrow_exit`, `blend_utilization`, `all`).

## Tests (Groth16 matrix)

- `packages/proofs/src/groth16-blend.test.ts`
- `packages/proofs/src/groth16-aquarius.test.ts`
- `packages/proofs/src/groth16-sdex.test.ts`
- `packages/proofs/src/groth16-composite.test.ts`
- `packages/proofs/src/groth16-security.test.ts` (result/hash/root/signal/proof/vkey tamper)
- `packages/sdk-ts/src/durable-roundtrip.test.ts` (prove → save → reload → verify → serialize, all 4)
- `apps/api/src/api.test.ts` (prove-bn254 / verify / card / no-leak, all 4)
- `packages/agent-tools/src/agent-tools.test.ts` (required tool names + groth16 flow)

Tamper tests drive snarkjs directly on a tampered circom input and assert the
CIRCUIT rejects it (Merkle inclusion constraint fails), not just the JS verifier.

## Example proof card (offchain_local, before on-chain verification)

```json
{
  "proofId": "proof_c9216924-ac8",
  "proofType": "compute_intent",
  "contextRoot": "0x519254e928659945ff59d320c5566839a6399f5da4546a388c0f367a019c249f",
  "computeHash": "0x9d26da074b13657ef9d63ae3a826db3dc2090e64a7a20d4c265b4ac8652bbc73",
  "publicResultHash": "0x01c61d21f802cdb529256a347ef7f39e4957307b5af6663b95e7ac6c5621a97e",
  "publicResult": { "routeAcceptable": true },
  "result": "verified",
  "trustModel": "proof-of-data-used",
  "verificationMode": "offchain_local",
  "warnings": [
    "Sefi proves a deterministic policy was evaluated over the selected context capsule (proof-of-data-used), not that raw ledger state originated from canonical consensus.",
    "bn254-groth16: real Groth16/BN254 proof of the ComputeIntent; verified locally with snarkjs and verifiable on the Soroban BN254 verifier (stellar_verified)."
  ]
}
```

After `verify().onStellar(...)` returns true, the stored card's
`verificationMode` becomes `stellar_verified` and a `Verified on Stellar
(testnet) by verifier C…, tx …` warning is appended. No private threshold
(`minOut`, `maxUtilization`, `minReceive`, `maxSpreadBps`, `minHealth`) ever
appears in the card, public inputs, or envelope.

## Known limitations

- **Live SDEX spread**: the `market.spread_bps` fact requires an active mainnet
  orderbook for the pair; USDC→XLM sometimes returns no spread, so `sdex-exit`
  live proving falls back to deterministic accepted data (or fails under
  `SEFI_REQUIRE_LIVE=1`). Live path facts (`path.available`,
  `path.estimated_out`) do come through.
- **Live composite** needs `SEFI_DEMO_WALLET` (a wallet with a Blend position)
  for the `health.factor` fact.
- **zkey reproducibility**: snarkjs `contribute` mixes OS randomness, so zkeys
  are not bit-for-bit reproducible. Every flow derives the on-chain VK from the
  current zkey at runtime, so the proving key and verifying key are always a
  matched pair. Committed artifacts are a matched set.
- Verifier contract is a real BN254 Groth16 pairing-check verifier; it is not the
  bb UltraHonk verifier (that path stays commitment-only until wired in).
