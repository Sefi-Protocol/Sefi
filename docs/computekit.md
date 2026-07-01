# Sefi ComputeKit + ProofKit (Phase 2)

> **Trust model:** Sefi proves that a deterministic policy was evaluated over the
> exact context capsule / fact bundle selected by the SDK — **proof-of-data-used**,
> not proof-of-data-origin. It does not prove raw Stellar ledger state originated
> from canonical consensus.

## Flow

```
ComputeIntent (DSL + context + private inputs)
   │  compile
   ▼
CompiledComputeIntent  ── binds DSL fact paths → capsule facts (with Merkle proofs)
   │                       computeHash / intentHash (never include private values)
   │  evaluate (deterministic interpreter, integer/bool domain)
   ▼
ComputeEvaluation  ── revealed outputs only; resultHash
   │  prove (router → backend)
   ▼
ProofEnvelope + ProofCard  ── public roots, revealed result, warnings
```

## Packages

| Package | Role |
|---|---|
| `@sefi/compute` | DSL tokenizer/parser/AST, fact bindings, fixed-point normalize, compile, deterministic evaluate, named recipes |
| `@sefi/proofs` | proof router, backends (**bn254-groth16** real ZK, bn254-noir, local-dev, prebuilt, risc0 iface), witness builder, envelope, local + on-chain verify |
| `@sefi/verifier-registry-client` | Soroban verifier-registry client |

The default backend is **bn254-groth16**: a real Groth16/BN254 proof of the
actual ComputeIntent (circom + snarkjs) that verifies on the Soroban BN254
verifier — `sefi.verify().onStellar(envelope)` returns `stellar_verified`. See
[BN254 / ZK](zk-bn254.md).

## v2 fact commitment (spec §3)

Capsules now carry `semanticFactsRoot` = `merkleRoot(facts.map(hashSemanticFact))`
and `contextRoot` = `H(sourceRoot | semanticFactsRoot | adapterSetHash)`.
`hashSemanticFact` includes the fact **value**, so changing a value changes the
root. Per-fact Merkle proofs bind individual facts to the root.

## DSL (spec §5)

Allowed: assignments, `+ - * /`, comparisons, `&& || !`, parentheses, integer/
decimal/bool constants, `private.<name>`, dotted fact paths, and the reducers
`max/min/any/all`. Forbidden: loops, function declarations, dynamic access,
imports, `eval`/`Function`, revealing private inputs. There is **no** runtime JS
execution anywhere in the parser/evaluator.

```ts
const proof = await sefi.compute().prove({
  name: "blend-utilization-policy",
  context: { blend: { poolId, include: ["reserves", "oracle"] } },
  compute: `
    utilization = blend.reserve.USDC.totalBorrowed * SCALE / max(blend.reserve.USDC.totalSupplied, 1);
    safe = utilization < private.maxUtilization && blend.oracle.isFresh;
  `,
  privateInputs: { maxUtilization: "820000" }, // 0.82 × 1e6, stays private
  reveal: ["safe"],
  hide: ["maxUtilization"],
  proof: { backend: "auto", verifyOn: "offchain", proveDataUsed: true },
});
proof.proofCard.publicResult; // { safe: true }
proof.publicInputs.contextRoot;
```

Numeric private inputs are passed **already scaled** (e.g. `"820000"` = 0.82×1e6)
and are parsed as raw integers, keeping them in the same 1e6 domain as the
fixed-point facts they compare against.

## Recipes (spec §10)

`blend-utilization-policy`, `aquarius-route-policy`, `sdex-exit-policy`,
`composite-borrow-exit-policy` — exported from `@sefi/compute` as `RECIPES`.

## Backends (spec §11)

- **prebuilt** — signed envelope over named-recipe outputs (default for recipes).
- **local-dev** — deterministic test verifier; disabled in production unless
  `SEFI_ALLOW_LOCAL_DEV_PROOFS=1`. Not a ZK proof.
- **noir** — interface + circuit templates + toolchain detection; integration
  proving runs only with `nargo`+`bb` present (`REQUIRE_NOIR=1` to enforce).
- **risc0** — interface only (NOT_SUPPORTED in Phase 2).

`auto` routing picks prebuilt for named recipes, otherwise falls back to the
deterministic off-chain path so proving never blocks on an absent toolchain.

## Verification (spec §14)

`sefi.verify().local(envelope)` checks envelope schema, 0x-32-byte hash formats,
that `resultHash` matches the revealed result, optional binding to the compiled
intent, and the backend checksum. It catches tampered `contextRoot`,
`computeHash`, `resultHash`, and revealed outputs.

## On-chain (spec §15)

`contracts/verifier-registry` + `@sefi/verifier-registry-client` provide a
**commitment-only** path (`proof_card_commitment_only`). Not on-chain ZK
verification.

## Demo

```bash
pnpm demo:phase2     # full live flow: capsule → compile → prove → verify → card
pnpm prove:blend     # live Blend utilization proof
pnpm prove:composite # set SEFI_DEMO_WALLET=G... for the health fact
```

## Security (spec §20)

Private inputs are redacted from logs, API bodies, proof cards, and agent tool
outputs. `reveal` cannot include `private.*`. Every fact path must resolve to a
fact in the selected capsule (else `SEFI_COMPUTE_FACT_NOT_FOUND`); missing facts
are never coerced to zero. Stale facts are rejected when `maxAgeSeconds` is set.
