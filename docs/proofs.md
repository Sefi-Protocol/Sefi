# Sefi Proofs

Sefi turns a policy decision over live Stellar protocol data into a **real
Groth16/BN254 proof** that verifies on a Soroban contract, while keeping the
policy's private thresholds hidden.

## What Sefi proves — and what it does not

**Proves (proof-of-data-used):** a deterministic policy (a `ComputeIntent`) was
evaluated over the *exact* context capsule the SDK selected. Every fact is bound
into `zkFactsRoot` by an in-circuit Poseidon Merkle proof, and
`zkContextRoot = Poseidon3(zkFactsRoot, sourceRoot, adapterSetHash)`. The revealed
boolean result is the circuit output signal — you cannot pair a valid proof with
a different claimed result.

**Does NOT prove (proof-of-data-origin):** that the raw ledger state originated
from canonical Stellar consensus. Sefi binds to the capsule the adapters
produced; it does not attest the adapters read honest chain state. That remains
the trust boundary.

**Private inputs stay private:** thresholds like `maxUtilization`, `minOut`,
`minReceive`, `maxSpreadBps`, `minHealth` are circuit-private. They never appear
in the proof card, public inputs, API responses, logs, or saved records.

## Recipes and circuits

| Recipe | Circuit | Predicate |
|---|---|---|
| `blend-utilization-policy` | `blend_utilization` | `safe = utilization < private.maxUtilization && oracle.isFresh` |
| `aquarius-route-policy` | `aquarius_route` | `routeSafe = estimatedOut >= private.minOut && routeHops <= 4` |
| `sdex-exit-policy` | `sdex_exit` | `sdexSafe = pathAvailable && (pathEstimatedOut >= private.minReceive \|\| spreadBps <= private.maxSpreadBps)` |
| `composite-borrow-exit-policy` | `composite_borrow_exit` | `allowed = health > private.minHealth && ((estOut >= private.minReceive && hops <= 4) \|\| (pathAvailable && pathOut >= private.minReceive))` |

Public-signal order (snarkjs): `[result, zkContextRoot, zkFactsRoot, computeHash, resultHash]`.

## Writing a ComputeIntent

```ts
const intent = {
  name: "aquarius-route-policy",
  context: { capsuleId },                    // or { aquarius: { route: {...} } }
  compute: RECIPES["aquarius-route-policy"], // fixed DSL -> stable computeHash
  privateInputs: { minOut: "99000000" },
  privateInputSchema: { minOut: "u128" },
  reveal: ["routeAcceptable"],
  hide: ["minOut"],
  proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true },
};
```

Private-input schema types: `fixed_1e6` (decimal scaled by 1e6), `u128`, `u64`.

## Run a local proof

```bash
SEFI_REQUIRE_BN254=1 pnpm circom:setup   # build circuits (blend/aquarius/sdex/composite)
pnpm prove:blend:bn254
pnpm prove:aquarius:bn254
pnpm prove:sdex:bn254
pnpm prove:composite:bn254
```

Each prints the proof id, public result, `zkFactsRoot`, `zkContextRoot`, and the
local verification result. Proving fails loudly (no silent fallback) if the
circom artifacts are missing under `SEFI_REQUIRE_BN254=1`.

## Verify on Stellar testnet

One verifier contract per circuit (different circuits have different VKs):

```bash
pnpm deploy:phase3:testnet          # deploy + init 4 verifiers -> deployments/phase3-testnet.json
SEFI_REQUIRE_BN254=1 pnpm phase3:testnet
```

`phase3:testnet` proves each recipe, verifies locally, then calls the deployed
verifier's `verify_proof(public_inputs, proof)` on testnet. Only when the on-chain
pairing check returns `true` does the stored proof card become
`verificationMode = "stellar_verified"`. Contract IDs + tx hashes live in
[`PHASE3_MULTI_PROTOCOL_PROOF_COVERAGE.md`](./PHASE3_MULTI_PROTOCOL_PROOF_COVERAGE.md).

From the SDK:

```ts
const r = await sefi.verify().onStellar(envelope, { verifierContractId, network: "testnet" });
// r.verificationMode === "stellar_verified" iff the on-chain check passed
```

## Inspect a ProofCard

```ts
const card = await sefi.verify().proofCard(proofId);
// { proofId, publicResult, trustModel: "proof-of-data-used", verificationMode, warnings }
```

`verificationMode` progression: `offchain_local` → `stellar_verified` (after a
successful on-chain verification). The card carries the context/compute/result
hashes and the revealed boolean — never the private inputs.

## Serialization (Soroban / EIP-197)

`groth16ToSoroban(envelope.groth16)` emits the verifier's byte layout: G1 =
`be(x)||be(y)` (64 bytes), G2 = `be(x.c1)||be(x.c0)||be(y.c1)||be(y.c0)` (128
bytes), and `publicInputs` as 32-byte big-endian field elements. `IC` has one
base point plus one per public signal.

## Tamper resistance

The circuit rejects any witness where a fact value, Merkle sibling, or root does
not reconcile (Poseidon Merkle inclusion + context-root binding). The local
verifier additionally rejects a flipped revealed result, a mutated
computeHash/resultHash/zkFactsRoot/zkContextRoot, a mutated public signal,
tampered proof bytes, and the wrong verification key. On-chain, a proof sent to
the wrong circuit's verifier (different VK) is rejected by the pairing check.
See `packages/proofs/src/groth16-security.test.ts` and the negative control in
`pnpm phase3:testnet`.
