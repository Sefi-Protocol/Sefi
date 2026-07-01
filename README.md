# Sefi — Stellar Indexing + Agent SDK (Part 1)

Sefi is a **protocol-scoped semantic layer** for Stellar. It indexes selected
protocol surfaces — **Blend**, **Aquarius AMM**, and **Stellar DEX / AMM** — and
converts raw protocol data into a unified semantic vocabulary that AI agents and
developers can query through an SDK and an API. Every answer carries raw source
records and context-capsule roots, preparing the system for proof-of-data and ZK
verification in the next phase.

> This repository is the Stellar port of Sefi. The previous Hedera-oriented
> stack (mirror client, Cube modeling, contract manifests) has been replaced by
> the Stellar protocol adapters and semantic layer below.

**Everything is live** — adapters read real ledger state from Soroban RPC,
Horizon, the Blend SDK, and the Aquarius AMM router. There is no mock mode.

## Monorepo layout (spec §3.1)

```
apps/
  api/            Express API server (spec §15)
  worker/         background ingestion (spec §16)
  demo-agent/     sample agent for the four use cases (spec §19)
  dashboard/      legacy Next.js explorer (pending Stellar re-point)
packages/
  shared-types/   SourceRecord / SemanticFact / ContextCapsule / SefiAnswer
  source-records/ canonical hashing + Merkle roots
  semantic-core/  ontology + computations + fact/answer builders
  stellar-client/ live Horizon + Soroban simulate + asset/ScVal helpers
  store/          Postgres + in-memory SefiStore
  context-capsules/ roots, capsule builder, replay verification
  protocol-blend/ live Blend adapter (Blend SDK)
  protocol-aquarius/ live Aquarius adapter (router get_pools + estimate_swap)
  protocol-sdex/  live Stellar DEX / AMM adapter (Horizon)
  sdk-ts/         @sefi/sdk public client
  agent-tools/    @sefi/agent-tools tool schemas
services/postgres/migrations/  canonical schema (spec §7)
scripts/          ingest-*, smoke-test, replay
docs/             architecture, sdk, adapters, proof-of-data handoff
```

## Quick start

```bash
pnpm install

# End-to-end live smoke (Blend + Aquarius + SDEX + composite capsule + replay)
pnpm smoke

# Four live use cases through the SDK + agent tools
pnpm demo

# Unit tests (hashing, computations, capsule roots)
pnpm test
```

### API server

```bash
# in-memory store
pnpm api
# with PostgreSQL (runs migrations on boot)
DATABASE_URL=postgres://sefi:sefi@localhost:5432/sefi pnpm api

curl localhost:8080/health
curl -XPOST localhost:8080/v1/aquarius/ask -H 'content-type: application/json' \
  -d '{"question":"<1% slippage?","tokenIn":"USDC","tokenOut":"XLM","amountIn":"1000000000"}'
```

### Docker (spec §17)

```bash
cp .env.example .env
docker compose up --build      # postgres + api + worker
```

## Endpoints (spec §15.1)

```
GET  /health
POST /v1/blend/context      POST /v1/blend/ask
POST /v1/aquarius/context   POST /v1/aquarius/ask
POST /v1/sdex/context       POST /v1/sdex/ask
POST /v1/context/compose    POST /v1/ask
POST /v1/facts/query
GET  /v1/context/:id        GET /v1/context/:id/verify
GET  /v1/source-records/:id
```

## Key live addresses

- Blend Fixed XLM-USDC pool (mainnet): `CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP`
- Aquarius AMM router (mainnet): `CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK`

## Phase 2 — ComputeKit + ProofKit

Sefi can now **prove a deterministic policy was evaluated over the exact context
capsule the SDK selected** (proof-of-data-used), returning a durable proof card.

```bash
pnpm demo:phase2        # live: capsule → compile → prove → verify → proof card
pnpm prove:blend        # live Blend utilization policy proof
curl -XPOST localhost:8080/v1/compute/prove -H 'content-type: application/json' -d @intent.json
```

```ts
const proof = await sefi.compute().prove({
  name: "blend-utilization-policy",
  context: { blend: { poolId, include: ["reserves", "oracle"] } },
  compute: "utilization = blend.reserve.USDC.totalBorrowed * SCALE / max(blend.reserve.USDC.totalSupplied, 1); safe = utilization < private.maxUtilization && blend.oracle.isFresh;",
  privateInputs: { maxUtilization: "820000" },   // stays private
  reveal: ["safe"], hide: ["maxUtilization"],
  proof: { backend: "auto", verifyOn: "offchain", proveDataUsed: true },
});
proof.proofCard.publicResult;   // { safe: true }
```

> Trust model: **proof-of-data-used**, not proof-of-data-origin.

The default `bn254-groth16` backend produces a **real Groth16/BN254 ZK proof of
the actual ComputeIntent** (snarkjs + circom; the circuit uses the same circomlib
Poseidon as the capsule's `zkFactsRoot`/`zkContextRoot`). The **same proof
verifies on the Soroban BN254 verifier**, so `sefi.verify().onStellar(envelope)`
returns a genuine `stellar_verified` for Sefi compute proofs — not a separate
test proof:

```bash
pnpm circom:setup              # one-time: build circuits + proving keys (deterministic)
pnpm prove:compute:testnet     # prove ComputeIntent → verify SAME proof on testnet → stellar_verified
pnpm prove:blend:live          # LIVE mainnet Blend data → capsule → proof → verify (+ on-chain if configured)
```

Full **live-data** chain proven end-to-end: real mainnet Blend state → adapter →
SemanticFacts → ContextCapsule → Groth16 proof → on-chain `stellar_verified`
(the stored proof card is upgraded + persisted). The `blend-utilization` and
`composite-borrow-exit` recipes are wired to Groth16; the proof's circuit output
signal is bound to the revealed result, and Groth16 artifacts persist in Postgres
so reloaded proofs stay verifiable.

### Real BN254 proof path (Noir + Soroban)

Sefi ships real BN254 Noir circuits (`circuits/`) and Soroban verifier contracts
(`contracts/`) **deployed live on Stellar testnet**:

| Contract | Testnet ID |
|---|---|
| verifier (`noir_ultrahonk_verifier`) | `CB3RIXWBHZLDTKYUX2EV3AKGQ73B4WRFPEATULLCMHLPXOINFSGBO5XZ` |
| registry (`sefi_verifier_registry`) | `CBAYTGH524MS6WILWGUB5LLOQO3JCRHO77NP6OVQAJUMX5J4O3GR4UWT` |

```bash
pnpm contracts:test            # cargo test incl. real BN254 g1 identities
pnpm deploy:verifier:testnet   # deploy + on-chain BN254 smoke (auto-funds a key)
pnpm zk:test                   # nargo circuit checks (skips without the toolchain)
```

Key env vars: `SEFI_PROOF_BACKEND=bn254-noir`, `SEFI_NOIR_NARGO_PATH`,
`SEFI_NOIR_BB_PATH`, `SEFI_VERIFIER_CONTRACT_ID`, `SEFI_REGISTRY_CONTRACT_ID`,
`STELLAR_TESTNET_SECRET`, `SEFI_REQUIRE_BN254=1`. See
[ComputeKit + ProofKit](docs/computekit.md) and [BN254 / ZK](docs/zk-bn254.md).

## Docs

- [Architecture](docs/architecture.md)
- [SDK](docs/sdk.md)
- [ComputeKit + ProofKit (Phase 2)](docs/computekit.md)
- Adapters: [Blend](docs/adapters/blend.md) · [Aquarius](docs/adapters/aquarius.md) · [SDEX](docs/adapters/sdex.md)
- [Proof-of-Data handoff](docs/proof-of-data-handoff.md)

## Status vs. spec

Part 1 says **source-backed / capsule-backed / auditable / replayable** — not
ZK-proven (spec §22). Agents answer and recommend; they do not execute
transactions. The capsule roots are the public inputs the next (proof) phase
will consume without re-indexing.
