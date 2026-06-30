# Sefi BN254 / ZK Proof Path

This document describes Sefi's BN254-based proof path: what is a real ZK/BN254
proof, what is still proof-of-data-used, and what is explicitly NOT
proof-of-origin.

## Trust model (honest boundaries)

- **proof-of-data-used** — Sefi proves a deterministic policy was evaluated over
  the exact context capsule / fact bundle the SDK selected. This is what every
  Sefi proof claims today.
- **proof-of-data-origin** — proving the raw Stellar ledger state originated from
  canonical consensus. Sefi does **NOT** claim this. There is no ledger
  inclusion / state-proof system yet.

A BN254 proof strengthens *how* the policy result is bound to the committed
data; it does not turn proof-of-data-used into proof-of-origin.

## Field-friendly commitments (v3 roots)

The SHA-256 `semanticFactsRoot` is the off-chain replay commitment. For
in-circuit verification Sefi adds BN254-field commitments
(`packages/source-records/src/zk-hash.ts`):

- `bytes32ToFr(hex)` reduces a 32-byte hash modulo the BN254 scalar field
  `Fr = 21888242871839275222246405745257275088548364400416034343698204186575808495617`.
- Each fact maps to a stable `pathId` (registry in `FACT_PATH_IDS`) and a
  `zkFactLeaf { pathId, valueField, adapterHashField, ledgerSeq }`.
- `zkFactLeafHash = Poseidon4(pathId, value, adapterHash, ledgerSeq)` (circomlib
  BN254 Poseidon via `poseidon-lite`). Ratio fields (`pool.utilization`,
  `health.factor`, …) are committed as 1e6 fixed point so the leaf value equals
  the predicate input.
- `zkFactsRoot = fixed-depth (8) Poseidon Merkle root` over the leaf hashes in
  insertion order, zero-padded — the exact tree the Noir circuit's
  `verify_merkle_path` reproduces. Built sparsely (only the populated path is
  hashed). Inclusion proofs: `zkFactMerkleProof(facts, index)`.
- `zkContextRoot = Poseidon3(zkFactsRoot, sourceRootFr, adapterSetHashFr)`.

These are stored on the capsule (`zkFactsRoot`, `zkContextRoot`, `rootVersion`
= `v3`) and re-verified by `verifyCapsule`.

## Noir circuits

`circuits/` (Noir, BN254):

| Circuit | Predicate |
|---|---|
| `blend_utilization_policy` | `utilization < maxUtilization && oracleFresh` |
| `aquarius_route_policy` | `estimatedOut >= minOut && routeHops <= 4` |
| `sdex_exit_policy` | `pathAvailable && (pathOut >= minReceive || spread <= maxSpread)` |
| `composite_borrow_exit_policy` | `blendSafe && (aquaExit || sdexExit)` |

Each circuit (`circuits/shared/src/lib.nr` provides the helpers):
1. recomputes `zkContextRoot` from `zkFactsRoot | sourceRoot | adapterSetHash`
   and asserts it equals the public input;
2. recomputes each fact leaf hash and verifies a Poseidon Merkle inclusion path
   against `zkFactsRoot`;
3. applies the private thresholds in the integer domain;
4. reveals only the boolean result.

Public inputs: `zkContextRoot`, `zkFactsRoot`, `computeHash`, `resultHash`,
`sourceRoot`, `adapterSetHash`, and the revealed boolean.

The Poseidon instantiation must match `poseidon-lite`; verify with the TS golden
vectors (`packages/source-records/src/zk-hash.test.ts`) and `nargo test`.

### Building / proving (requires the toolchain)

```bash
# Install Noir + Barretenberg
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/master/barretenberg/bbup/install | bash
bbup

pnpm noir:build        # nargo check + compile all circuits
REQUIRE_NOIR=1 pnpm zk:test
```

The `bn254-noir` proof backend (`packages/proofs/src/bn254.ts`) shells out to
`nargo` + `bb`. With no toolchain it throws `SEFI_BN254_TOOLCHAIN_MISSING` and
never silently falls back.

## Soroban verifier contracts

`contracts/`:

- `sefi_verifier_registry` — `register_verifier`, `get_verifier`,
  `verify` (routes to the registered verifier), `emit_proof_card`, `get_card`.
- `noir_ultrahonk_verifier` — stores a Groth16 VK and verifies via the BN254
  host functions `env.crypto().bn254()` (`g1_add`, `g1_mul`, `pairing_check`).
  `bn254_smoke_g1_double` / `_triple` prove the host BN254 path is real (not
  stubbed); they pass under `cargo test` and on-chain.

### Live testnet deployment

Deployed to **Stellar testnet** (Protocol 25+):

| Contract | ID |
|---|---|
| verifier (`noir_ultrahonk_verifier`) | `CB3RIXWBHZLDTKYUX2EV3AKGQ73B4WRFPEATULLCMHLPXOINFSGBO5XZ` |
| registry (`sefi_verifier_registry`) | `CBAYTGH524MS6WILWGUB5LLOQO3JCRHO77NP6OVQAJUMX5J4O3GR4UWT` |

On-chain `bn254_smoke_g1_double` / `_triple` return `true`; `emit_proof_card`
commits a card and `get_card` returns the committed context root.

```bash
pnpm contracts:build
pnpm contracts:test
pnpm deploy:verifier:testnet      # auto-generates + funds a key if none set
SEFI_REGISTRY_CONTRACT_ID=C... pnpm verify:proof:testnet <proofId>
```

### Real on-chain Groth16 verification (stellar_verified)

`verify_proof(public_inputs, proof)` is a real BN254 Groth16 verifier: it
computes `vk_x = IC[0] + Σ pubᵢ·IC[i+1]` and the 4-term pairing check
`e(-A,B)·e(α,β)·e(vk_x,γ)·e(C,δ) == 1` using the host BN254 functions. It is
**not a stub** — proven by:

- `cargo test groth16_test::verify_real_groth16_proof_on_chain`: a genuine
  `ark-groth16` proof verifies in the Soroban host (true); a wrong public input
  returns false.
- Live on **Stellar testnet**: `verify_proof` returns `true` for a valid proof
  and `false` for a wrong public input (on-ledger tx
  `fbccaba320188490de79991b7e73ae8cae414a3565c4642c12c32f1feb1e4384`).
- `sefi.verify().onStellarGroth16(...)` invokes it and returns
  `verificationMode: "stellar_verified"` when the on-chain check passes.

```bash
pnpm zk:testnet     # generate a real Groth16 proof, deploy/init, verify true+false on testnet
```

### Remaining honest gap (UltraHonk wiring)

The compute-proof backend (`bn254-noir`) produces an **UltraHonk** proof via
nargo+bb, whereas the deployed verifier checks **Groth16**. Until bb's UltraHonk
verification key + proof format are wired into a verifier contract, an SDK
*compute proof* is only committed on-chain (`proof_card_commitment_only`), not
`stellar_verified`. The Groth16 verifier path above is genuinely
`stellar_verified` today. To close the gap: deploy a bb-generated UltraHonk
Soroban verifier, register its VK, and submit the bb proof bytes.

Provenance: `noir_ultrahonk_verifier` is original Sefi code built on the Soroban
BN254 host API (MIT). It is not a vendored UltraHonk verifier.

## Environment variables

```
SEFI_PROOF_BACKEND=bn254-noir
SEFI_NOIR_NARGO_PATH=/path/to/nargo
SEFI_NOIR_BB_PATH=/path/to/bb
SEFI_VERIFIER_CONTRACT_ID=C...
SEFI_REGISTRY_CONTRACT_ID=C...
STELLAR_TESTNET_SECRET=S...        # or SEFI_TESTNET_IDENTITY=<keys alias>
SEFI_REQUIRE_BN254=1               # make BN254 jobs fail (not skip) when toolchain missing
```
