# Sefi Stellar — Architecture

Sefi is a **protocol-scoped semantic layer** for Stellar. It indexes selected
protocol surfaces — **Blend**, **Aquarius AMM**, and **Stellar DEX / AMM** —
and turns raw protocol data into a unified semantic vocabulary that AI agents
and developers can query, all **live** from mainnet/testnet (no fixtures).

```
Stellar sources ──▶ Protocol adapters ──▶ Source records  ─┐
                          │                                 ├─▶ Store (Postgres / memory)
                          └──▶ Semantic facts ──────────────┘
                                        │
                                   Sefi SDK ──▶ Agent tools ──▶ Answers + Context capsules
                                        │
                                        └──▶ Context capsules ──▶ (future) Proof-of-data / ZK
```

## Packages

| Package | Responsibility |
|---|---|
| `@sefi/shared-types` | Canonical types: `SourceRecord`, `SemanticFact`, `ContextCapsule`, `SefiAnswer` |
| `@sefi/source-records` | Canonical JSON hashing, sha256, Merkle roots, source-record builder |
| `@sefi/semantic-core` | Ontology, protocol computations, fact builder, answer assembler |
| `@sefi/stellar-client` | Live Horizon (fetch) + Soroban `simulateTransaction` / `getEvents` / `getLedgerEntries` + asset/ScVal helpers |
| `@sefi/store` | `SefiStore` interface with PostgreSQL and in-memory implementations |
| `@sefi/context-capsules` | Source/facts/composite roots, capsule builder, replay verification |
| `@sefi/protocol-blend` | Live Blend adapter (via `@blend-capital/blend-sdk`) |
| `@sefi/protocol-aquarius` | Live Aquarius adapter (router `get_pools` + pool `estimate_swap`) |
| `@sefi/protocol-sdex` | Live Stellar DEX / AMM adapter (Horizon order books, paths, LPs) |
| `@sefi/sdk` | `SefiClient` — blend/aquarius/sdex/context/facts modules + unified `ask()` |
| `@sefi/agent-tools` | Framework-agnostic tool schemas + Anthropic/OpenAI adapters |

## Apps

| App | Role |
|---|---|
| `apps/api` | Express API server (spec §15 endpoints) + migrations on boot |
| `apps/worker` | Seven named workers (spec §16): blend-pool, blend-event (checkpointed `getEvents`), aquarius-pool, aquarius-swap-cache, sdex-orderbook, sdex-liquiditypool, capsule-cleanup |
| `apps/demo-agent` | Sample agent exercising the four spec §19 use cases |
| `apps/dashboard` | (legacy) Next.js explorer carried over, pending a Stellar re-point |

## Data provenance (spec §5)

Every semantic fact is traceable:

```
fact → source record ids → response hash → ledger sequence / endpoint
```

Source records inline the raw response and hash it canonically, so a context
capsule can be **replayed** and its roots re-derived (see `scripts/replay.ts`).

## Live-only

There is no mock/fixture path. Adapters read real ledger state:

- **Blend** via the official Blend SDK (ledger entries over Soroban RPC).
- **Aquarius** via Soroban `simulateTransaction` against the AMM router/pools.
- **SDEX** via Horizon REST.

If data is unavailable the adapter surfaces a warning or throws — it never
fabricates values.
