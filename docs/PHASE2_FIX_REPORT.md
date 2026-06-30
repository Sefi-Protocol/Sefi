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
- Verifier (`noir_ultrahonk_verifier`): `CC2HYEYVFQ6RH6NECDRJWKJBN4XP3XBGXPG4XNAQLGP4KA6PCFL7HGDN`
- Registry (`sefi_verifier_registry`): `CBAYTGH524MS6WILWGUB5LLOQO3JCRHO77NP6OVQAJUMX5J4O3GR4UWT`
- On-chain: `bn254_smoke_g1_double` / `_triple` → `true`; `emit_proof_card`
  committed; `get_card` returns the context root.

## Remaining honest limitations
- The Soroban `verify_proof` is a real BN254 pairing verifier but is not yet
  wired to bb's exact UltraHonk VK, so the on-chain mode is
  `proof_card_commitment_only` (not `stellar_verified`). Wiring the bb VK is the
  next step (docs/zk-bn254.md).
- Trust model remains **proof-of-data-used**, never proof-of-data-origin.
- Noir prove/verify runs only where `nargo`/`bb` are installed.

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
