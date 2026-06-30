# Testing

## Commands

```bash
pnpm install
pnpm build                 # tsc -b across all packages
pnpm test                  # all unit/integration tests (85)
pnpm smoke                 # live mainnet end-to-end (Blend + Aquarius + SDEX + capsule + replay)
pnpm demo:phase2           # live ComputeKit/ProofKit flow + proof card
pnpm prove:blend           # live Blend utilization proof
pnpm prove:composite       # live composite proof (set SEFI_DEMO_WALLET for the health fact)
pnpm verify:proof <id>     # local proof verification
```

### ZK / BN254 (toolchain-gated)

```bash
pnpm noir:build            # nargo check + compile circuits (skips without nargo)
pnpm zk:test               # nargo check all circuits (skips without nargo/bb)
pnpm contracts:test        # cargo test both Soroban contracts (incl real BN254 smoke)
pnpm contracts:build       # build both contracts to wasm32v1-none
pnpm deploy:verifier:testnet
SEFI_REGISTRY_CONTRACT_ID=C... pnpm verify:proof:testnet <proofId>
```

`zk:test` / `noir:build` skip with an explicit message when `nargo`/`bb` are
absent; set `SEFI_REQUIRE_BN254=1` (or `REQUIRE_NOIR=1`) to make them fail
instead.

## Postgres-backed tests

The Postgres roundtrip + checkpoint tests skip with a clear reason when
`DATABASE_URL` is unset, and run for real when it is set:

```bash
DATABASE_URL=postgres://sefi:sefi@localhost:5432/sefi pnpm test
```

With `DATABASE_URL` set, all 85 tests run with 0 skips.

## What the tests cover

| Area | Tests |
|---|---|
| Source hashing + Merkle (incl. inclusion proofs) | `packages/source-records/src/hash.test.ts` |
| ZK field roots (BN254 Fr + Poseidon) golden vectors | `packages/source-records/src/zk-hash.test.ts` |
| Protocol computations | `packages/semantic-core/src/compute.test.ts` |
| Freshness policy | `packages/semantic-core/src/freshness.test.ts` |
| Capsule v2/v3 roots + verify (tamper) | `packages/context-capsules/src/*.test.ts` |
| Store v2/v3 roundtrip (memory + Postgres) | `packages/store/src/roundtrip.test.ts` |
| Ingestion checkpoint resume | `packages/store/src/checkpoint.test.ts` |
| Horizon latest-ledger headers (mocked fetch) | `packages/stellar-client/src/horizon-headers.test.ts` |
| DSL parser (valid + forbidden syntax) | `packages/compute/src/parser.test.ts` |
| Fact binding + deterministic evaluation | `packages/compute/src/{bindings,evaluate}.test.ts` |
| Decimal fixed-point normalization | `packages/compute/src/fixed-point.test.ts` |
| Private-input redaction | `packages/compute/src/private-redaction.test.ts` |
| Proof router + backends + local verify (tamper) | `packages/proofs/src/proofs.test.ts` |
| Strong proof verification chain | `packages/sdk-ts/src/verify-strong.test.ts` |
| Agent-tool redaction + no-fallback | `packages/agent-tools/src/agent-tools.test.ts` |
| Soroban registry storage | `contracts/sefi_verifier_registry` cargo test |
| Real BN254 host identities | `contracts/noir_ultrahonk_verifier` cargo test |

## Security tests (non-negotiable assertions)

- private inputs never appear in proof envelopes, cards, API responses, or agent
  output (`private-redaction.test.ts`, `agent-tools.test.ts`);
- tampered revealed result / contextRoot / computeHash fail `verifyLocal`;
- tampered fact value changes `semanticFactsRoot` and `zkFactsRoot` and fails
  capsule replay;
- proving against an unverified capsule is rejected
  (`SEFI_COMPUTE_CAPSULE_UNVERIFIED`);
- `local-dev` / `prebuilt` backends are blocked in production without explicit
  opt-in;
- `bn254-noir` throws (never falls back) when the toolchain is missing.
