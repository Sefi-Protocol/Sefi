# Sefi ComputeKit — Phase 2 Agent Build Specification

**Target repo:** `Sefi-Protocol/Sefi`  
**Starting point:** Part 1 already has protocol adapters, semantic facts, source records, SDK/API routes, context capsules, and replay verification.  
**Phase 2 goal:** Add ComputeKit + ProofKit: ComputeIntent DSL, context-bound deterministic compute, proof envelopes, proof router, first real proof workflow, optional Soroban verifier registry, and agent-safe prove/verify tools.

---

## 0. Non-negotiable product boundary

Build **proof-of-data-used** first, not proof-of-data-origin.

MVP claim allowed:

> Sefi proves that a deterministic policy computation was evaluated over the exact context capsule/fact bundle selected by the SDK, and returns a durable proof card.

MVP claim not allowed:

> Sefi trustlessly proves the raw Stellar ledger state originated from canonical consensus.

The repo must keep this language everywhere: API responses, README, proof cards, demo logs, and agent prompts.

---

## 1. Phase 2 scope

Phase 2 adds the following packages and capabilities:

```txt
packages/
  compute/                  # ComputeIntent DSL, parser, AST, resolver, interpreter
  proofs/                   # proof router, proof envelope, backend interfaces, Noir/prebuilt adapters
  proof-types/              # reusable recipes: blend-utilization, aqua-route, sdex-exit, composite-borrow-exit
  verifier-registry-client/ # TypeScript wrapper for Soroban registry calls
contracts/
  verifier-registry/        # Soroban verifier registry contract
  noir-verifier-example/    # optional verifier contract / placeholder interface
apps/
  proof-worker/             # async proof job runner
scripts/
  prove-blend-utilization.ts
  prove-aqua-route.ts
  prove-sdex-exit.ts
  prove-composite-borrow-exit.ts
  verify-proof.ts
  deploy-verifier-registry.ts
  emit-proof-card.ts
```

Modify existing packages:

```txt
packages/shared-types       # add ComputeIntent, ExpressionAst, ProofEnvelope, ProofCard, ProofJob
packages/context-capsules   # add v2 fact commitment hashing and Merkle proofs
packages/sdk-ts             # add sefi.compute, sefi.proofs, sefi.verify namespaces
packages/agent-tools        # add sefi_compute_prove, sefi_verify_local, sefi_verify_on_stellar
apps/api                    # add /v1/compute/* and /v1/proofs/* endpoints
apps/worker                 # keep indexer worker; do not mix heavy proof jobs here
services/postgres           # add compute_intents, proof_envelopes, proof_jobs, proof_cards
```

---

## 2. Required Phase 2 developer experience

This must work from the SDK:

```ts
const sefi = new SefiClient({
  network: "mainnet",
  rpcUrl: process.env.SEFI_RPC_URL,
  horizonUrl: process.env.SEFI_HORIZON_URL,
  aquariusRouter: process.env.AQUARIUS_ROUTER,
});

const proof = await sefi.compute().prove({
  name: "blend-utilization-policy",
  context: {
    blend: {
      poolId,
      include: ["reserves", "oracle"],
    },
  },
  compute: `
    utilization = blend.reserve.USDC.totalBorrowed * SCALE / max(blend.reserve.USDC.totalSupplied, 1);
    safe = utilization < private.maxUtilization && blend.oracle.isFresh;
  `,
  privateInputs: {
    maxUtilization: "820000", // 0.82 scaled by 1e6
  },
  reveal: ["safe"],
  hide: ["maxUtilization"],
  proof: {
    backend: "auto",
    verifyOn: "offchain",
    proveDataUsed: true,
  },
});

console.log(proof.proofCard.result);          // "verified" | "failed"
console.log(proof.proofCard.publicResult);    // { safe: true }
console.log(proof.publicInputs.contextRoot);
console.log(proof.publicInputs.computeHash);
```

And this must work for the flagship multi-protocol path:

```ts
const proof = await sefi.compute().prove({
  name: "composite-borrow-exit-policy",
  context: {
    blend: { poolId, wallet, include: ["reserves", "oracle", "positions"] },
    aquarius: { route: { tokenIn: "USDC", tokenOut: "XLM", amountIn } },
    sdex: { path: { sourceAsset: "USDC", destinationAsset: "XLM", sourceAmount: amountIn } },
  },
  compute: `
    blendSafe = blend.healthAfterAction > private.minHealth;
    aquaExit = aquarius.estimatedOut >= private.minReceive && aquarius.routeHops <= 4;
    sdexExit = sdex.pathEstimatedOut >= private.minReceive;
    allowed = blendSafe && (aquaExit || sdexExit);
  `,
  privateInputs: {
    minHealth: "1250000",
    minReceive: "99000000",
  },
  reveal: ["allowed"],
  hide: ["minHealth", "minReceive"],
  proof: {
    backend: "auto",
    verifyOn: "offchain",
    proveDataUsed: true,
  },
});
```

---

## 3. Critical correction before proof work: fact commitment hashing

The existing capsule code may compute `factsRoot` from source response hashes or raw hashes. That is not enough for Phase 2.

Phase 2 must bind the exact **semantic fact values** used by the compute to the context root.

Add this canonical fact commitment:

```ts
export interface SemanticFactV2 extends SemanticFact {
  schemaVersion: "sefi.semantic_fact.v2";
  factHash: HexString;
}

export function canonicalFactForHash(fact: SemanticFact): unknown {
  return {
    schemaVersion: "sefi.semantic_fact.v2",
    network: fact.network,
    protocol: fact.protocol,
    entityType: fact.entityType,
    entityId: fact.entityId,
    field: fact.field,
    value: fact.value,
    unit: fact.unit ?? null,
    ledgerSeq: fact.ledgerSeq ?? null,
    sourceRecordIds: [...fact.sourceRecordIds].sort(),
    adapterHash: fact.adapterHash,
  };
}

export function hashSemanticFact(fact: SemanticFact): HexString {
  return sha256Hex(stableStringify(canonicalFactForHash(fact)));
}
```

Then update capsule v2 roots:

```ts
semanticFactsRoot = merkleRoot(facts.map(hashSemanticFact));
sourceRoot = merkleRoot(sources.map(s => s.responseHash));
contextRoot = sha256Hex(`${sourceRoot}|${semanticFactsRoot}|${adapterSetHash}`);
```

Keep the old fields for backwards compatibility, but all Phase 2 proof envelopes must use the v2 root names:

```ts
publicInputs: {
  contextRoot,
  sourceRoot,
  semanticFactsRoot,
  adapterSetHash,
  computeHash,
  resultHash,
}
```

### Test that must fail until fixed

Create a capsule with two facts, then change only the `value` of one semantic fact while keeping the same source hash. `semanticFactsRoot` must change. If it does not change, Phase 2 is invalid.

---

## 4. ComputeIntent core types

Add to `packages/shared-types`:

```ts
export type HexString = `0x${string}`;

export type SefiScalarType =
  | "u64"
  | "u128"
  | "i128"
  | "fixed_1e6"
  | "bool"
  | "enum";

export interface ComputeIntent {
  id?: string;
  name: string;
  context: Record<string, unknown>;
  compute: string | ExpressionAst;
  privateInputs: Record<string, string | number | boolean>;
  reveal: string[];
  hide: string[];
  proof: {
    backend: "auto" | "noir" | "risc0" | "prebuilt" | "local-dev";
    verifyOn: "stellar" | "offchain";
    proveDataUsed: boolean;
  };
}

export interface CompiledComputeIntent {
  id: string;
  name: string;
  intentHash: HexString;
  computeHash: HexString;
  contextRoot: HexString;
  sourceRoot: HexString;
  semanticFactsRoot: HexString;
  adapterSetHash: HexString;
  ast: ExpressionAst;
  factRefs: FactBinding[];
  privateInputSchema: Record<string, SefiScalarType>;
  reveal: string[];
  hide: string[];
  createdAt: string;
}

export interface FactBinding {
  variable: string;
  protocol: "blend" | "aquarius" | "stellar_dex" | "stellar_amm";
  entityType: string;
  entitySelector: Record<string, string>;
  field: string;
  valueType: SefiScalarType;
  factId: string;
  factHash: HexString;
  merkleProof?: MerkleProof;
}

export interface MerkleProof {
  leaf: HexString;
  leafIndex: number;
  siblings: HexString[];
  root: HexString;
}

export interface ProofEnvelope {
  proofId: string;
  proofType: "compute_intent" | "proof_of_funds" | "allowlist" | "credential";
  backend: "noir" | "risc0" | "prebuilt" | "local-dev";
  publicInputs: {
    contextRoot: HexString;
    sourceRoot: HexString;
    semanticFactsRoot: HexString;
    adapterSetHash: HexString;
    computeHash: HexString;
    resultHash: HexString;
  };
  revealed: Record<string, string | number | boolean>;
  proofBytes: string;
  verifierContractId?: string;
  verificationTx?: string;
  status: "created" | "proving" | "verified" | "failed";
  createdAt: string;
}

export interface ProofCard {
  proofId: string;
  proofType: string;
  contextRoot: HexString;
  computeHash: HexString;
  publicResultHash: HexString;
  publicResult: Record<string, string | number | boolean>;
  verifierHash?: HexString;
  timestampLedger?: number;
  result: "verified" | "failed";
  trustModel: "proof-of-data-used" | "proof-of-data-origin";
  warnings: string[];
}
```

---

## 5. ComputeIntent DSL restrictions

MVP DSL must be intentionally small.

Allowed:

```txt
- assignments: x = expression;
- arithmetic: + - * /
- comparison: < <= > >= == !=
- boolean logic: && || !
- parentheses
- constants: integer, decimal string, true, false
- named private inputs: private.minHealth
- named fact references: blend.reserve.USDC.totalBorrowed
- explicit reducers: max(a,b), min(a,b), any(a,b,c), all(a,b,c)
```

Forbidden:

```txt
- loops
- arbitrary JS/TS execution
- function declarations
- dynamic property access
- external HTTP calls
- imports
- logging private inputs
- returning hidden variables
- undeclared private inputs
- facts not found in the context capsule
```

### Parser implementation options

Use one of these approaches:

1. **Fast build:** write a small tokenizer + Pratt parser for expressions and assignment statements.
2. **Safer medium build:** use a parser generator only if it does not bloat the repo.

Do not use `eval`, `Function`, or runtime JS execution.

### AST shape

```ts
export type ExpressionAst = {
  type: "program";
  statements: AssignmentNode[];
};

export interface AssignmentNode {
  type: "assignment";
  name: string;
  expr: ExprNode;
}

export type ExprNode =
  | { type: "literal"; value: string | number | boolean }
  | { type: "private"; name: string }
  | { type: "fact"; path: string[] }
  | { type: "identifier"; name: string }
  | { type: "binary"; op: "+" | "-" | "*" | "/" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||"; left: ExprNode; right: ExprNode }
  | { type: "unary"; op: "!" | "-"; expr: ExprNode }
  | { type: "call"; fn: "max" | "min" | "any" | "all"; args: ExprNode[] };
```

---

## 6. Fact reference binding map

The compiler must convert DSL paths into concrete semantic facts from the context capsule.

Required bindings:

```txt
blend.reserve.<SYMBOL>.totalSupplied     -> protocol=blend, entityType=reserve, entityId contains :<SYMBOL>, field=reserve.totalSupplied
blend.reserve.<SYMBOL>.totalBorrowed     -> protocol=blend, entityType=reserve, entityId contains :<SYMBOL>, field=reserve.totalBorrowed
blend.reserve.<SYMBOL>.utilization       -> protocol=blend, entityType=reserve, entityId contains :<SYMBOL>, field=pool.utilization
blend.oracle.isFresh                     -> protocol=blend, entityType=oracle, field=oracle.freshness == "fresh"
blend.healthAfterAction                  -> protocol=blend, entityType=position, field=health.factor
blend.borrowLimit                        -> protocol=blend, entityType=position, field=borrow.limit
blend.liabilityUsed                      -> protocol=blend, entityType=position, field=borrow.used

aquarius.estimatedOut                    -> protocol=aquarius, entityType=route, field=slippage.estimated_out
aquarius.slippageBps                     -> protocol=aquarius, entityType=route, field=slippage.estimated
aquarius.routeHops                       -> protocol=aquarius, entityType=route, field=route.hops
aquarius.routeAvailable                  -> protocol=aquarius, entityType=route, field=route.available != false

sdex.pathAvailable                       -> protocol=stellar_dex, entityType=route, field=path.available
sdex.pathEstimatedOut                    -> protocol=stellar_dex, entityType=route, field=path.estimated_out
sdex.spreadBps                           -> protocol=stellar_dex, entityType=market, field=market.spread_bps
sdex.bestBid                             -> protocol=stellar_dex, entityType=market, field=market.best_bid
sdex.bestAsk                             -> protocol=stellar_dex, entityType=market, field=market.best_ask
```

Missing facts must produce a typed compile error:

```txt
SEFI_COMPUTE_FACT_NOT_FOUND: blend.reserve.USDC.totalBorrowed was not found in capsule <id>
```

Do not silently convert missing values to zero.

---

## 7. Fixed-point and type normalization

Use deterministic integer math.

```ts
export const SCALE = 1_000_000n;
```

Rules:

```txt
- Ratios like 0.82 become 820000.
- Stellar stroop-like integer strings remain integer strings.
- Horizon decimal amounts convert to 7-decimal integer units when needed.
- Boolean facts convert true/false.
- Enum freshness converts: fresh=true, stale=false, unknown=false.
- Infinity is not allowed inside proof witnesses; compile must reject or require a finite substitute.
```

Add helper functions:

```ts
toFixed1e6(value: string | number): bigint
fromFixed1e6(value: bigint): string
normalizeFactValue(binding: FactBinding, fact: SemanticFact): bigint | boolean | string
normalizePrivateInput(name: string, value: unknown, expected: SefiScalarType): bigint | boolean | string
```

---

## 8. Compute hash and intent hash rules

Private input values must never enter `computeHash` or logs.

```ts
computeHash = sha256Hex(stableStringify({
  schemaVersion: "sefi.compute.v1",
  name,
  ast,
  factRefs: factRefs.map(ref => ({
    variable: ref.variable,
    protocol: ref.protocol,
    entityType: ref.entityType,
    entitySelector: ref.entitySelector,
    field: ref.field,
    valueType: ref.valueType,
    factHash: ref.factHash,
  })),
  privateInputSchema,
  reveal: sorted(reveal),
  hide: sorted(hide),
}));
```

`intentHash` may include `contextRoot` and `computeHash`, but still must not include private input values.

```ts
intentHash = sha256Hex(stableStringify({
  schemaVersion: "sefi.compute_intent.v1",
  contextRoot,
  computeHash,
  backend,
  verifyOn,
  proveDataUsed,
}));
```

`resultHash`:

```ts
resultHash = sha256Hex(stableStringify({
  schemaVersion: "sefi.compute_result.v1",
  reveal: sortedRevealObject,
}));
```

---

## 9. Deterministic interpreter

Before proof generation, build a deterministic interpreter. It is the reference implementation for tests and proof witness generation.

```ts
export interface ComputeEvaluation {
  outputs: Record<string, bigint | boolean | string>;
  revealed: Record<string, string | number | boolean>;
  hiddenUsed: string[];
  factBindings: FactBinding[];
  resultHash: HexString;
}

export function evaluateCompute(
  compiled: CompiledComputeIntent,
  privateInputs: Record<string, unknown>,
  facts: SemanticFact[],
): ComputeEvaluation;
```

The interpreter must:

```txt
- verify capsule roots before evaluation
- resolve fact bindings only from the context capsule
- reject stale context when policy includes maxAgeSeconds
- reject hidden values in reveal list
- never print privateInputs
- return revealed outputs only
```

---

## 10. First proof recipes

### 10.1 `blend-utilization-policy`

Intent:

```txt
utilization = totalBorrowed * SCALE / max(totalSupplied, 1)
safe = utilization < private.maxUtilization && oracleFresh
```

Inputs from facts:

```txt
blend.reserve.USDC.totalBorrowed
blend.reserve.USDC.totalSupplied
blend.oracle.isFresh
```

Private:

```txt
maxUtilization: fixed_1e6
```

Reveal:

```txt
safe: bool
```

Acceptance:

```txt
- safe=true when borrowed/supplied < private.maxUtilization and oracle is fresh
- safe=false when utilization is above threshold
- proof envelope public inputs include contextRoot, semanticFactsRoot, computeHash, resultHash
```

### 10.2 `aquarius-route-policy`

Intent:

```txt
routeAcceptable = aquarius.estimatedOut >= private.minOut && aquarius.routeHops <= 4
```

Inputs from facts:

```txt
aquarius.estimatedOut
aquarius.routeHops
```

Private:

```txt
minOut: u128
```

Reveal:

```txt
routeAcceptable: bool
```

### 10.3 `sdex-exit-policy`

Intent:

```txt
pathOk = sdex.pathEstimatedOut >= private.minReceive
spreadOk = sdex.spreadBps <= private.maxSpreadBps
exitOk = sdex.pathAvailable && (pathOk || spreadOk)
```

Private:

```txt
minReceive: u128
maxSpreadBps: u64
```

Reveal:

```txt
exitOk: bool
```

### 10.4 `composite-borrow-exit-policy`

Intent:

```txt
blendSafe = blend.healthAfterAction > private.minHealth
aquaExit = aquarius.estimatedOut >= private.minReceive && aquarius.routeHops <= 4
sdexExit = sdex.pathAvailable && sdex.pathEstimatedOut >= private.minReceive
allowed = blendSafe && (aquaExit || sdexExit)
```

Private:

```txt
minHealth: fixed_1e6
minReceive: u128
```

Reveal:

```txt
allowed: bool
```

---

## 11. Proof router

Add `packages/proofs`.

```ts
export interface ProofBackend {
  id: "noir" | "risc0" | "prebuilt" | "local-dev";
  supports(compiled: CompiledComputeIntent): boolean;
  prove(input: ProofRequest): Promise<ProofEnvelope>;
  verifyLocal(envelope: ProofEnvelope): Promise<boolean>;
}

export interface ProofRequest {
  compiled: CompiledComputeIntent;
  evaluation: ComputeEvaluation;
  capsule: ContextCapsule;
  factMerkleProofs: MerkleProof[];
  privateInputs: Record<string, unknown>;
}
```

Routing rules:

```ts
function selectBackend(intent: ComputeIntent, compiled: CompiledComputeIntent): ProofBackendId {
  if (intent.proof.backend !== "auto") return intent.proof.backend;
  if (isPrebuiltRecipe(intent.name)) return "prebuilt";
  if (isSmallArithmeticPolicy(compiled.ast)) return "noir";
  if (usesLoopsOrCustomRust(compiled.ast)) return "risc0";
  return "noir";
}
```

For Phase 2:

```txt
- Implement local-dev backend for deterministic tests only.
- Implement prebuilt backend as a real signed proof envelope over deterministic recipe outputs.
- Implement Noir backend interface and one working Noir template if the toolchain is available.
- RISC Zero backend can be interface-only with explicit NOT_SUPPORTED errors.
```

Do not call local-dev a ZK proof. It is a test verifier only.

---

## 12. Noir backend plan

### 12.1 Toolchain detection

```ts
export async function detectNoirToolchain(): Promise<{
  nargo: boolean;
  bb: boolean;
  version?: string;
}>;
```

If `REQUIRE_NOIR=1`, tests must fail when Noir is missing. Otherwise, unit tests should run and Noir integration tests should skip with a clear message.

### 12.2 Circuit generation strategy

Do not generate arbitrary circuits in Phase 2. Use templates for the first recipes.

```txt
packages/proofs/noir/templates/
  blend_utilization_policy/
    Nargo.toml
    src/main.nr
  aqua_route_policy/
    Nargo.toml
    src/main.nr
  sdex_exit_policy/
    Nargo.toml
    src/main.nr
  composite_borrow_exit_policy/
    Nargo.toml
    src/main.nr
```

The generated witness file must not be committed.

### 12.3 Blend Noir predicate pseudocode

```rust
fn main(
  context_root: pub Field,
  semantic_facts_root: pub Field,
  compute_hash: pub Field,
  result_hash: pub Field,
  total_borrowed: Field,
  total_supplied: Field,
  oracle_fresh: bool,
  private_max_utilization: Field,
) -> pub bool {
  let denom = if total_supplied == 0 { 1 } else { total_supplied };
  let utilization = total_borrowed * SCALE / denom;
  let safe = utilization < private_max_utilization & oracle_fresh;
  // result_hash binding should be supported by a template-specific public result hash.
  safe
}
```

For the first implementation, `context_root`, `semantic_facts_root`, and `compute_hash` can be public inputs carried by the proof envelope. If Merkle inclusion inside Noir is not implemented yet, mark the proof card warning:

```txt
"ZK predicate verified. Data binding is enforced by the Sefi proof envelope and replayable capsule, not by in-circuit Merkle inclusion yet."
```

The next increment should add in-circuit Merkle proof verification for selected facts.

---

## 13. Proof envelope creation

Every backend must return the same envelope.

```ts
export function buildProofEnvelope(input: {
  proofType: "compute_intent";
  backend: ProofEnvelope["backend"];
  compiled: CompiledComputeIntent;
  evaluation: ComputeEvaluation;
  proofBytes: string;
  verifierContractId?: string;
}): ProofEnvelope {
  return {
    proofId: `proof_${randomUUID().slice(0, 12)}`,
    proofType: "compute_intent",
    backend: input.backend,
    publicInputs: {
      contextRoot: input.compiled.contextRoot,
      sourceRoot: input.compiled.sourceRoot,
      semanticFactsRoot: input.compiled.semanticFactsRoot,
      adapterSetHash: input.compiled.adapterSetHash,
      computeHash: input.compiled.computeHash,
      resultHash: input.evaluation.resultHash,
    },
    revealed: serializeRevealed(input.evaluation.revealed),
    proofBytes: input.proofBytes,
    verifierContractId: input.verifierContractId,
    status: "verified",
    createdAt: new Date().toISOString(),
  };
}
```

---

## 14. Local verification

`sefi.verify().local(envelope)` must verify:

```txt
- proof envelope schema is valid
- contextRoot/sourceRoot/semanticFactsRoot are 0x-prefixed 32-byte hashes
- computeHash matches stored compiled intent
- resultHash matches revealed result
- local-dev/prebuilt signature or checksum validates
- Noir verifier validates if backend=noir and proof artifacts are present
```

Do not return `true` just because the envelope exists.

---

## 15. Soroban verifier registry

Build this as Phase 2B if time allows. Do not block the off-chain proof path on it.

### Contract surface

```rust
pub trait SefiVerifierRegistry {
  fn register_verifier(
    env: Env,
    proof_type: Symbol,
    verifier: Address,
    verifier_hash: BytesN<32>
  );

  fn verify(
    env: Env,
    envelope_hash: BytesN<32>,
    proof_type: Symbol,
    public_inputs: Vec<BytesN<32>>,
    proof: Bytes
  ) -> bool;

  fn emit_proof_card(
    env: Env,
    proof_id: BytesN<32>,
    context_root: BytesN<32>,
    result_hash: BytesN<32>
  );
}
```

### Events

```txt
SefiProofCard {
  proofId: bytes32,
  proofType: string,
  contextRoot: bytes32,
  computeHash: bytes32,
  publicResultHash: bytes32,
  verifierHash: bytes32,
  timestampLedger: u32,
  result: "verified" | "failed"
}
```

### Testnet scripts

```txt
scripts/deploy-verifier-registry.ts
scripts/register-verifier.ts
scripts/verify-on-stellar.ts
scripts/emit-proof-card.ts
```

`verify-on-stellar` may start as a registry/proof-card commitment if actual Groth16 verification is not ready, but the API must label it honestly:

```txt
status: "committed_on_stellar"
verificationMode: "proof_card_commitment_only"
```

Do not label a commitment-only transaction as proof verification.

---

## 16. API endpoints

Add to `apps/api`:

```txt
POST /v1/compute/compile
POST /v1/compute/evaluate
POST /v1/compute/prove
GET  /v1/compute/intents/:id

POST /v1/proofs/verify-local
POST /v1/proofs/verify-on-stellar
GET  /v1/proofs/:id
GET  /v1/proofs/:id/card

POST /v1/context/:id/fact-proofs
```

### `POST /v1/compute/prove`

Request:

```json
{
  "name": "blend-utilization-policy",
  "context": { "blend": { "poolId": "C..." } },
  "compute": "safe = blend.reserve.USDC.totalBorrowed * SCALE / max(blend.reserve.USDC.totalSupplied, 1) < private.maxUtilization && blend.oracle.isFresh;",
  "privateInputs": { "maxUtilization": "820000" },
  "reveal": ["safe"],
  "hide": ["maxUtilization"],
  "proof": { "backend": "auto", "verifyOn": "offchain", "proveDataUsed": true }
}
```

Response:

```json
{
  "proofEnvelope": { "proofId": "proof_...", "publicInputs": { "contextRoot": "0x..." } },
  "proofCard": {
    "proofId": "proof_...",
    "publicResult": { "safe": true },
    "trustModel": "proof-of-data-used",
    "warnings": []
  }
}
```

---

## 17. SDK namespaces

Add to `SefiClient`:

```ts
sefi.compute().compile(intent)
sefi.compute().evaluate(intent)
sefi.compute().prove(intent)
sefi.compute().explain(proofEnvelope)

sefi.proofs().proofOfFunds(args)
sefi.proofs().allowlist(args)
sefi.proofs().credential(args)

sefi.verify().local(proofEnvelope)
sefi.verify().onStellar(proofEnvelope)
sefi.verify().proofCard(proofId)
```

Agent tools:

```txt
sefi_compute_compile
sefi_compute_prove
sefi_verify_local
sefi_verify_on_stellar
sefi_proof_card_get
```

Agent tool rule:

```txt
Never reveal privateInputs. Tool responses must include only `revealed`, `proofCard`, public roots, and warnings.
```

---

## 18. Database migration

Add `services/postgres/migrations/0002_compute_proofs.sql`:

```sql
CREATE TABLE IF NOT EXISTS compute_intents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  compute_hash TEXT NOT NULL,
  context_root TEXT NOT NULL,
  source_root TEXT NOT NULL,
  semantic_facts_root TEXT NOT NULL,
  adapter_set_hash TEXT NOT NULL,
  ast_json JSONB NOT NULL,
  fact_refs JSONB NOT NULL,
  private_input_schema JSONB NOT NULL,
  reveal JSONB NOT NULL,
  hide JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proof_envelopes (
  id TEXT PRIMARY KEY,
  proof_type TEXT NOT NULL,
  backend TEXT NOT NULL,
  compute_intent_id TEXT REFERENCES compute_intents(id),
  public_inputs JSONB NOT NULL,
  revealed JSONB NOT NULL,
  proof_object_uri TEXT,
  proof_bytes TEXT,
  verifier_contract_id TEXT,
  verification_tx TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proof_cards (
  id TEXT PRIMARY KEY,
  proof_envelope_id TEXT REFERENCES proof_envelopes(id),
  proof_type TEXT NOT NULL,
  context_root TEXT NOT NULL,
  compute_hash TEXT NOT NULL,
  public_result_hash TEXT NOT NULL,
  public_result JSONB NOT NULL,
  verifier_hash TEXT,
  timestamp_ledger BIGINT,
  result TEXT NOT NULL,
  trust_model TEXT NOT NULL,
  warnings JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compute_intents_context_root ON compute_intents(context_root);
CREATE INDEX IF NOT EXISTS idx_proof_envelopes_status ON proof_envelopes(status);
CREATE INDEX IF NOT EXISTS idx_proof_cards_context_root ON proof_cards(context_root);
```

---

## 19. Proof worker

Add `apps/proof-worker`.

The worker should process jobs asynchronously:

```ts
export interface ProofJob {
  id: string;
  intentId: string;
  backend: "noir" | "risc0" | "prebuilt" | "local-dev";
  status: "queued" | "running" | "verified" | "failed";
  error?: string;
  createdAt: string;
  updatedAt: string;
}
```

For MVP, API can run proof synchronously for small proofs, but the worker should exist so heavy proofs can move off the request path.

---

## 20. Security rules

Implement these hard checks:

```txt
- privateInputs must be redacted from logs, API error bodies, proof cards, and agent tool outputs.
- reveal cannot include any path under private.*
- every fact path used by compute must resolve to a fact in the selected context capsule.
- every selected fact must have sourceRecordIds.length > 0.
- context capsule must verify before compute.
- stale data policy must reject proofs when maxAgeSeconds is set and data is too old.
- unknown / low-confidence facts must either fail or emit proof-card warning depending on policy.
- local-dev proofs must be disabled when NODE_ENV=production unless SEFI_ALLOW_LOCAL_DEV_PROOFS=1.
```

---

## 21. Tests

### 21.1 Unit tests

Create:

```txt
packages/compute/src/parser.test.ts
packages/compute/src/bindings.test.ts
packages/compute/src/evaluate.test.ts
packages/compute/src/private-redaction.test.ts
packages/context-capsules/src/fact-hash-v2.test.ts
packages/proofs/src/router.test.ts
packages/proofs/src/envelope.test.ts
packages/proofs/src/local-verify.test.ts
```

Required test cases:

```txt
Parser valid:
- safe = utilization < private.maxUtilization && blend.oracle.isFresh;
- allowed = blendSafe && (aquaExit || sdexExit);
- utilization = totalBorrowed * SCALE / max(totalSupplied, 1);

Parser invalid:
- for (...) {}
- import x from "y"
- console.log(private.minHealth)
- safe = eval("...")
- safe = private.minHealth

Binding:
- blend.reserve.USDC.totalBorrowed resolves to reserve.totalBorrowed fact
- aquarius.estimatedOut resolves to slippage.estimated_out
- sdex.pathEstimatedOut resolves to path.estimated_out
- missing fact throws SEFI_COMPUTE_FACT_NOT_FOUND

Evaluation:
- blend utilization below threshold returns safe=true
- above threshold returns safe=false
- oracle unknown returns safe=false
- division by zero uses max(totalSupplied, 1)
- composite: Blend safe + Aqua false + SDEX true -> allowed=true
- composite: Blend unsafe + liquidity true -> allowed=false

Privacy:
- privateInputs are absent from proof card
- privateInputs are absent from logger output
- reveal private.minHealth throws

Roots:
- changing a fact value changes semanticFactsRoot
- changing source response changes sourceRoot
- changing adapterHash changes contextRoot
- replay verification fails when fact value is tampered

Router:
- blend-utilization-policy auto routes to prebuilt or noir
- complex unsupported DSL routes to risc0 or throws NOT_SUPPORTED
- local-dev is blocked in production by default
```

### 21.2 Golden vectors

Add `test-vectors/phase2`:

```txt
test-vectors/phase2/blend-safe/context.json
test-vectors/phase2/blend-safe/facts.json
test-vectors/phase2/blend-safe/intent.json
test-vectors/phase2/blend-safe/expected.json

test-vectors/phase2/blend-unsafe/...
test-vectors/phase2/aqua-route-ok/...
test-vectors/phase2/sdex-exit-ok/...
test-vectors/phase2/composite-borrow-exit-ok/...
test-vectors/phase2/stale-data-rejected/...
```

Each expected file must include:

```json
{
  "contextRoot": "0x...",
  "semanticFactsRoot": "0x...",
  "computeHash": "0x...",
  "resultHash": "0x...",
  "revealed": { "allowed": true }
}
```

### 21.3 Integration tests

```txt
- API /v1/compute/compile returns compiled intent and does not include private input values.
- API /v1/compute/prove returns proofEnvelope + proofCard.
- API /v1/proofs/verify-local validates the generated envelope.
- SDK sefi.compute().prove works with in-memory store.
- SDK sefi.compute().prove works with Postgres store.
- Agent tool sefi_compute_prove returns only public revealed fields.
```

### 21.4 Optional Stellar testnet tests

Run only when env vars are present:

```txt
SEFI_STELLAR_TESTNET=1
SEFI_TESTNET_SECRET=...
SEFI_VERIFIER_REGISTRY_ID=...
```

Tests:

```txt
- deploy registry contract
- register dummy verifier hash
- emit proof card event for off-chain verified proof
- retrieve transaction hash and include it in proof envelope
```

Do not spend mainnet funds in CI.

---

## 22. Build order for the AI coding agent

### PR 1 — Root/fact commitment upgrade

Tasks:

```txt
1. Add hashSemanticFact and semanticFactsRootV2.
2. Add Merkle proof generation for facts.
3. Keep old capsule fields working.
4. Add tamper tests.
```

Acceptance:

```txt
pnpm test --filter context-capsules
Changing a semantic fact value changes semanticFactsRoot.
```

### PR 2 — ComputeIntent types + parser

Tasks:

```txt
1. Add shared ComputeIntent/ProofEnvelope/ProofCard types.
2. Add packages/compute.
3. Implement tokenizer/parser/AST canonicalization.
4. Add parser tests.
```

Acceptance:

```txt
Valid DSL parses.
Forbidden syntax fails.
No eval or Function anywhere.
```

### PR 3 — Fact resolver + deterministic evaluator

Tasks:

```txt
1. Bind DSL fact paths to context facts.
2. Normalize numeric/boolean values.
3. Evaluate AST deterministically.
4. Generate computeHash, intentHash, resultHash.
5. Redact private values.
```

Acceptance:

```txt
Golden vector blend-safe passes.
Golden vector composite-borrow-exit passes.
Private input leakage tests pass.
```

### PR 4 — Proof envelopes + local/prebuilt backend

Tasks:

```txt
1. Add packages/proofs.
2. Add proof router.
3. Add local-dev backend for tests.
4. Add prebuilt backend for named recipes.
5. Add local verification.
```

Acceptance:

```txt
sefi.compute().prove returns proofEnvelope and proofCard.
verifyLocal(proofEnvelope) returns true for valid envelope and false for tampered envelope.
```

### PR 5 — API + SDK + agent tools

Tasks:

```txt
1. Add SDK namespaces: compute, proofs, verify.
2. Add API endpoints.
3. Add agent tools: sefi_compute_prove, sefi_verify_local, sefi_proof_card_get.
4. Add docs and examples.
```

Acceptance:

```txt
curl /v1/compute/prove works.
Agent tool response does not include privateInputs.
```

### PR 6 — Noir backend, optional but preferred

Tasks:

```txt
1. Add Noir toolchain detection.
2. Add blend-utilization Noir template.
3. Generate witness/proof artifacts outside git.
4. Add verifyLocal for Noir proof.
5. Add skip behavior unless REQUIRE_NOIR=1.
```

Acceptance:

```txt
REQUIRE_NOIR=1 pnpm test:proofs passes on a machine with Noir installed.
Without Noir, normal pnpm test still passes with integration tests skipped.
```

### PR 7 — Soroban verifier registry / proof-card commitment

Tasks:

```txt
1. Add contracts/verifier-registry.
2. Add deploy/register/emit scripts.
3. Add verifier-registry-client.
4. Add optional testnet integration tests.
```

Acceptance:

```txt
A proof card can be committed/emitted on Stellar testnet.
If actual verification is not implemented, label mode as proof_card_commitment_only.
```

---

## 23. Definition of done

Phase 2 is done only when all of this is true:

```txt
[ ] Context capsules have v2 semantic fact commitments.
[ ] ComputeIntent DSL parses and rejects unsafe syntax.
[ ] Fact references bind only to selected context capsule facts.
[ ] Private inputs are never logged or returned.
[ ] At least four proof recipes exist: Blend, Aquarius, SDEX, composite.
[ ] sefi.compute().prove returns proofEnvelope + proofCard.
[ ] verifyLocal catches tampered contextRoot, computeHash, resultHash, and revealed outputs.
[ ] Agent tool sefi_compute_prove returns only revealed result + public roots.
[ ] Demo shows Blend-only proof and composite multi-protocol proof.
[ ] README clearly says proof-of-data-used, not proof-of-origin.
```

---

## 24. Demo script

The final demo should run:

```bash
pnpm install
pnpm test
pnpm smoke
pnpm prove:blend
pnpm prove:composite
pnpm verify:proof <proofId>
```

Expected terminal output:

```txt
SEFI PHASE 2 DEMO
✓ context capsule verified
✓ semantic fact root verified
✓ ComputeIntent compiled
✓ private inputs redacted
✓ proof envelope created
✓ local verification OK
✓ proof card generated

Trust model: proof-of-data-used, not proof-of-data-origin.
Blend utilization policy: SAFE
Composite borrow-exit policy: ALLOWED
```

---

## 25. Agent operating rules

The coding agent must follow these rules while building:

```txt
1. Do not build UI before compute/proof tests pass.
2. Do not add arbitrary JavaScript execution for the DSL.
3. Do not log private inputs.
4. Do not claim ZK verification unless a real proof backend verified it.
5. Do not claim proof-of-origin; use proof-of-data-used wording.
6. Do not silently skip missing facts.
7. Keep adapters deterministic and source-backed.
8. Use test vectors before live protocol calls.
9. Prefer one working end-to-end proof over many incomplete proof stubs.
10. Every proof must include contextRoot, semanticFactsRoot, adapterSetHash, computeHash, and resultHash.
```
