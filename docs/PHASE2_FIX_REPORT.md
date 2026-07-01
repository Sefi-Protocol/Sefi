# Sefi ComputeKit/ProofKit Fix Report

Tracks the BN254 hardening work for `Sefi-Protocol/Sefi`.

- Base commit before fixes: `0f9f06d09d41294c30f3e5081c0b0d5bff1a3574`
- Head at report time: `53ff15afa9582e65ea51f3338811ca6a3da49092`
- Environment: macOS, Node 22, pnpm 11, rustc 1.89 (Homebrew) + 1.96 (rustup,
  for wasm), stellar CLI 27.0.0. `nargo`/`bb` not installable here (sandbox
  blocks `curl|bash`); all toolchain-gated work skips with explicit reasons.

## Issue → change map

### Capsule roots (persist + verify v2/v3)
- `services/postgres/migrations/0003_capsule_v2_roots.sql` adds
  `semantic_facts_root`, `context_root`, `adapter_set_hash`, `zk_facts_root`,
  `zk_context_root`, `root_version` columns.
- `packages/store/src/pg.ts` — `saveCapsule` / `rowToCapsule` persist + restore
  all roots and `adapter_set_hash` as a column.
- `packages/shared-types` — `ContextCapsule` gains `zkFactsRoot`,
  `zkContextRoot`, `rootVersion`.
- `packages/context-capsules/src/index.ts` — `verifyCapsule` returns
  `sourceRootOk`, `factsRootOk`, `semanticFactsRootOk`, `compositeRootOk`,
  `contextRootOk`, `zkFactsRootOk`, `zkContextRootOk`, `ok`, `rootVersion`.
- `apps/api` `/v1/context/:id/verify` exposes the full result.
- Tests: `packages/context-capsules/src/verify-roots.test.ts`,
  `packages/store/src/roundtrip.test.ts` (memory + real Postgres).

### ZK-friendly fact roots (BN254 Fr + Poseidon)
- `packages/source-records/src/zk-hash.ts` — `bytes32ToFr` (mod BN254 Fr),
  `FACT_PATH_IDS` registry, `ZkFactLeaf`, Poseidon `zkFactLeafHash`,
  `zkFactsRoot`, `zkContextRoot`.
- Capsule build emits `zkFactsRoot` / `zkContextRoot` (`rootVersion=v3`).
- Golden vectors: `packages/source-records/src/zk-hash.test.ts`.

### Private input normalization (decimals)
- `packages/compute/src/normalize.ts` — `fixed_1e6` scales decimals
  (`"0.82"`→820000, `"1.25"`→1250000); `u64/u128/i128` stay raw; ambiguous
  values throw. Explicit `privateInputSchema` honored in compile.
- Tests: `packages/compute/src/fixed-point.test.ts`.

### Strengthened ComputeIntent + proof verification
- Prove against `{ capsuleId }` (no silent refetch); roots re-verified before
  proving; `assertProvable` requires v2 (and zk for bn254) roots.
- `verify().local(envelope, { compiledIntentId?, capsuleId?, dev? })` recomputes
  intent→capsule→roots→result and rejects envelope-only unless `dev`.
- `store.getComputeIntentByProof`; API `verify-local` strong path +
  `verify-bn254-local`.
- Tests: `packages/sdk-ts/src/verify-strong.test.ts`.

### Real Noir circuits
- `circuits/shared` (Poseidon leaf/Merkle/zkContextRoot) +
  `circuits/{blend_utilization,aquarius_route,sdex_exit,composite_borrow_exit}_policy`.
  Each verifies Poseidon Merkle inclusion of every fact against `zkFactsRoot`,
  binds `zkContextRoot`, applies private thresholds, reveals only the boolean.
- `packages/proofs/src/bn254.ts` (nargo+bb) + `scripts/noir-build.ts`,
  `scripts/zk-test.ts`.

### Soroban BN254 verifier path
- `contracts/sefi_verifier_registry` — register/get/verify(→cross-contract)/
  emit_proof_card/get_card.
- `contracts/noir_ultrahonk_verifier` — Groth16 `verify_proof` over
  `env.crypto().bn254()` (`g1_add`, `g1_mul`, `pairing_check`) +
  `bn254_smoke_g1_double/_triple`.

### Backend policy (no silent fallback)
- `packages/proofs/src/router.ts` — `auto` routes named recipes to `bn254-noir`;
  prebuilt only with `SEFI_ALLOW_PREBUILT_PROOFS=1`, local-dev only with
  `SEFI_ALLOW_LOCAL_DEV_PROOFS=1`; production hard-blocks both
  (`SEFI_BACKEND_BLOCKED`); `bn254-noir` throws `SEFI_BN254_TOOLCHAIN_MISSING`
  rather than downgrading.

### API + agent tools
- API: `/v1/compute/prove-bn254`, `/v1/proofs/verify-bn254-local`,
  `/v1/proofs/verify-on-stellar`, `/v1/proofs/:id/card`, full
  `/v1/context/:id/verify`, SDEX offers/strict-receive/liquidity-pools.
- Agent prompt forbids "ZK proven" unless backend=`bn254-noir` & verified, and
  `stellar_verified` only when the on-chain verifier returns true; tools redact
  private inputs (`packages/agent-tools/src/agent-tools.test.ts`).

### Phase 1 reliability
- `0004_ingestion_checkpoints.sql` + store `saveCheckpoint/getCheckpoint`;
  event worker resumes from the persisted cursor (verified live; also fixed a
  real BigInt-serialization crash in event ingestion).
- `StellarClient.horizonGet` returns headers + `latestLedger` from the Horizon
  `Latest-Ledger` header, stored in `SourceRecord.latestLedger`.
- `.github/workflows/ci.yml` (node+postgres, cargo, nargo; toolchain jobs skip
  with reasons).

## Commands run (this environment)

| Command | Result |
|---|---|
| `pnpm build` | OK (tsc -b, exit 0) |
| `pnpm test` | 85 pass, 0 fail (0 skip with `DATABASE_URL` set; 1 skip without) |
| `pnpm smoke` | ✅ live mainnet, replay verify OK |
| `pnpm demo:phase2` | ✅ Blend SAFE; composite needs `SEFI_DEMO_WALLET` |
| `pnpm prove:blend` | ✅ `{ safe: true }`, prebuilt backend |
| `pnpm zk:test` | SKIP (nargo/bb absent) — explicit reason |
| `pnpm noir:build` | SKIP (nargo absent) — explicit reason |
| `pnpm contracts:test` | 3 pass (1 registry + 2 real BN254 g1 identities) |
| `pnpm contracts:build` | both wasm32v1-none artifacts produced |
| `pnpm deploy:verifier:testnet` | deployed live (below) |

## Skipped tests + why
- Noir `nargo`/`bb` integration: `nargo`/`bb` cannot be installed here (sandbox
  blocks the official `curl|bash` installers). Circuits + scripts ship and run
  on any machine with the toolchain (`REQUIRE_NOIR=1` enforces).
- Postgres roundtrip: skips only when `DATABASE_URL` is unset; runs + passes
  against a real local Postgres.

## Live testnet contract IDs
- Network: Stellar **testnet** (Protocol 25+).
- Deployer: `GAUTESFW2APS3ZUE4J5Y7EA26UPMQKHCWRWF5D4YGQLKFSUJZVJNW6TV`.
- Verifier (`noir_ultrahonk_verifier`): `CB3RIXWBHZLDTKYUX2EV3AKGQ73B4WRFPEATULLCMHLPXOINFSGBO5XZ`
- Registry (`sefi_verifier_registry`): `CBAYTGH524MS6WILWGUB5LLOQO3JCRHO77NP6OVQAJUMX5J4O3GR4UWT`
- On-chain: `bn254_smoke_g1_double` / `_triple` → `true`; `emit_proof_card`
  committed; `get_card` returns the context root.

## Follow-up fixes (witness, zk roots, real on-chain verification)
- BN254 witness generation is complete: `packages/proofs/src/witness.ts` writes
  every circuit input (public roots + per-fact value/pathId/adapter/ledger +
  full Poseidon Merkle path/bits + thresholds), validated by a TS reference
  circuit (`witness.test.ts`, 7 tests incl. tamper detection).
- `zkFactsRoot` is now a fixed-depth (8) Poseidon tree matching the circuit's
  `verify_merkle_path`; `factValueToFr` commits ratio fields as 1e6 so the leaf
  value equals the predicate input.
- ProofEnvelope `publicInputs` now include `zkFactsRoot` + `zkContextRoot`;
  `verifyLocal` requires them for `bn254-noir`.
- `noir_ultrahonk_verifier.verify_proof` is a REAL Groth16 BN254 verifier:
  `cargo test groth16_test` proves a genuine ark-groth16 proof verifies (true)
  and a wrong input fails (false). LIVE on testnet: verifier
  `CB3RIXWBHZLDTKYUX2EV3AKGQ73B4WRFPEATULLCMHLPXOINFSGBO5XZ`, tx
  `fbccaba320188490de79991b7e73ae8cae414a3565c4642c12c32f1feb1e4384`.
- `sefi.verify().onStellarGroth16(...)` returns `stellar_verified` for a real
  on-chain pass. Scripts: `pnpm zk:testnet`, `prove:blend:bn254`,
  `prove:composite:bn254`, `verify:proof:bn254`, `zk:localnet`.

## Follow-up — actual ComputeIntent proof is now stellar_verified (Option B)

The missing bridge (Sefi ComputeIntent proof → Soroban verifier →
`stellar_verified`) is now closed with a real Groth16 path:

- `bn254-groth16` backend (`packages/proofs/src/groth16.ts`) generates a REAL
  Groth16/BN254 proof of the actual ComputeIntent via **circom + snarkjs**.
- The circom circuit (`circuits/circom/blend_utilization.circom`) uses circomlib
  Poseidon, which is byte-identical to the `poseidon-lite` used for
  `zkFactsRoot`/`zkContextRoot` (golden-vector verified), so the proof binds to
  the EXACT roots the capsule commits. Public signals:
  `[safe, zkContextRoot, zkFactsRoot, computeHash, resultHash]`.
- The SAME proof verifies on the Soroban BN254 verifier.
  `sefi.verify().onStellar(envelope)` returns `verificationMode:
  "stellar_verified"` for bn254-groth16 envelopes.
- Verified LIVE on testnet: the actual Sefi compute proof returned **true**
  on-chain (tx `1abbf6e729fd952d504cde2f3b67dba64f00085ab5b0b6ebb875ec0d49ad820a`),
  wrong public input returned **false**; full SDK flow returned
  `stellar_verified` (tx `5e3cf2fa0a85c18a63dd27addb49978c1dd10a4db84b373340498836d2363ca1`).
- ProofEnvelope `publicInputs` now carry `zkFactsRoot` + `zkContextRoot`;
  `verifyLocal` checks the proof's public signals against them (mod-r reduced).
- Reproducible: `pnpm circom:setup` (deterministic VK) + `pnpm zk:test` (real
  proof + verify, no account needed) + `pnpm prove:compute:testnet`. circom +
  snarkjs are available; CI runs `SEFI_REQUIRE_BN254=1 pnpm zk:test`.
- `auto` now defaults named recipes to `bn254-groth16`. `bn254-noir` (UltraHonk)
  remains available via explicit selection.

## Follow-up — production hardening (review round 3)

- **Result binding (security).** `verifyLocal` now enforces that the circuit's
  output public signal (`publicSignals[0]`) equals the single revealed boolean;
  a proof of `safe=1` paired with a claimed `safe=false` is rejected. Tests:
  `groth16.test.ts` "SECURITY: … FLIPPED revealed result".
- **Durable proofs.** Migration `0005_proof_groth16.sql` + `PgStore` persist the
  full `groth16 {proof, publicSignals, vkey}` (JSONB) + `verification_key`, so a
  reloaded envelope still verifies on-chain. Test:
  `proof-groth16-roundtrip.test.ts` (memory + real Postgres).
- **ProofCard upgrade.** `onStellar()` upgrades + persists the stored ProofCard
  to `verificationMode: "stellar_verified"` (with verifier + tx) when the
  on-chain check passes; `saveProofCard` now upserts.
- **API endpoint.** `/v1/compute/prove-bn254` now forces `bn254-groth16` (the
  stellar_verified path); `/v1/compute/prove-noir` is the explicit UltraHonk path.
- **Composite recipe wired.** `composite_borrow_exit.circom` (5 facts) is built
  + proven end-to-end (`allowed`), same pattern as blend. Aquarius/SDEX single-
  policy circuits are the natural next subset.
- **Live-data E2E.** `scripts/prove-blend-live-groth16.ts` fetches LIVE mainnet
  Blend data via the adapter (22 facts + source record) → capsule → real Groth16
  proof → local verify → **on-chain stellar_verified** (tx
  `4404b1a4325bbfd1b2aa9565f25c3b2a2f102acfedf8ce42cadb5d05338b3e64`; proof card
  upgraded to stellar_verified). `pnpm prove:blend:live`.

## Remaining honest limitations
- bn254-noir (UltraHonk) proofs are still committed-only on-chain (no UltraHonk
  Soroban verifier yet); the default bn254-groth16 path is fully
  `stellar_verified`.
- Aquarius-only and SDEX-only recipes reuse the composite circuit pattern but do
  not yet each have a dedicated circom circuit (blend + composite are wired).
- Trust model remains **proof-of-data-used**, never proof-of-data-origin.

## Sample proof card (private values redacted)
```json
{
  "proofId": "proof_dc102227-b6c",
  "proofType": "compute_intent",
  "contextRoot": "0x77caea015decd6ea115c1e64c859a3813afcac1151d2d49097fb626446708cfa",
  "computeHash": "0x543ab88602448af7fe6f2bb0ece1d3ef29d38c8835c526419f027b118deb67d1",
  "publicResultHash": "0x2a8182c79a651bbd336b6ec1a3ac9b2a54803ad4fdac7423069a4b229400815c",
  "publicResult": { "safe": true },
  "result": "verified",
  "trustModel": "proof-of-data-used",
  "verificationMode": "offchain_local",
  "warnings": [
    "Sefi proves a deterministic policy was evaluated over the selected context capsule (proof-of-data-used), not that raw ledger state originated from canonical consensus.",
    "prebuilt backend is a signed policy proof over deterministic recipe outputs, NOT a ZK proof."
  ]
}
```
No private input (`maxUtilization`) appears in the card, envelope, public inputs,
or API responses (asserted by the redaction tests).

---

## Phase 3 follow-up — full multi-protocol proof coverage

Phase 2 shipped the Blend Groth16 path. Phase 3 extends real `bn254-groth16`
proving + on-chain `stellar_verified` verification to **all four** recipes:

- New circuits `aquarius_route` and `sdex_exit`; composite audited + kept.
- One Groth16 verifier contract per circuit (different VKs) deployed to testnet;
  registry in `deployments/phase3-testnet.json`.
- Full Groth16 test matrix (per-recipe correctness + circuit-level tamper +
  cross-cutting security + durable roundtrip + API + agent tools).
- `pnpm phase3:testnet` proves all four, verifies each on-chain against its own
  verifier, and asserts every reloaded proof card is `stellar_verified`.

Details: [PHASE3_MULTI_PROTOCOL_PROOF_COVERAGE.md](PHASE3_MULTI_PROTOCOL_PROOF_COVERAGE.md).
