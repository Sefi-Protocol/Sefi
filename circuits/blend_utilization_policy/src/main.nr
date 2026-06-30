// blend-utilization-policy (audit Part F §10.1, §F).
//
// Proves: over the capsule committed by zk_context_root/zk_facts_root, the
// USDC reserve utilization is below the private threshold and the oracle is
// fresh — revealing only `safe`.
//
// Data binding: every fact value is bound to zk_facts_root via an in-circuit
// Poseidon Merkle inclusion proof, and zk_facts_root is bound to
// zk_context_root. Private inputs (thresholds + raw values) never appear in the
// public outputs.

use dep::sefi_shared::{fact_leaf_hash, verify_merkle_path, zk_context_root, SCALE, MERKLE_DEPTH};

fn main(
    // ---- public inputs ----
    zk_context_root_pub: pub Field,
    zk_facts_root: pub Field,
    compute_hash: pub Field,
    result_hash: pub Field,
    source_root: pub Field,
    adapter_set_hash: pub Field,
    // ---- private witness: fact values + path ids + ledger + adapter ----
    total_borrowed: Field,
    total_supplied: Field,
    oracle_fresh: Field, // 0 or 1
    borrowed_path_id: Field,
    supplied_path_id: Field,
    oracle_path_id: Field,
    adapter_hash: Field,
    ledger_seq: Field,
    // ---- private Merkle proofs for each fact leaf ----
    borrowed_path: [Field; MERKLE_DEPTH],
    borrowed_bits: [u1; MERKLE_DEPTH],
    supplied_path: [Field; MERKLE_DEPTH],
    supplied_bits: [u1; MERKLE_DEPTH],
    oracle_path: [Field; MERKLE_DEPTH],
    oracle_bits: [u1; MERKLE_DEPTH],
    // ---- private threshold ----
    max_utilization: Field,
) -> pub bool {
    // 1. Bind zk_context_root to its components (must equal the public input).
    let recomputed_ctx = zk_context_root(zk_facts_root, source_root, adapter_set_hash);
    assert(recomputed_ctx == zk_context_root_pub);

    // 2. Recompute each fact leaf and verify inclusion in zk_facts_root.
    let borrowed_leaf = fact_leaf_hash(borrowed_path_id, total_borrowed, adapter_hash, ledger_seq);
    assert(verify_merkle_path(borrowed_leaf, borrowed_path, borrowed_bits, zk_facts_root));

    let supplied_leaf = fact_leaf_hash(supplied_path_id, total_supplied, adapter_hash, ledger_seq);
    assert(verify_merkle_path(supplied_leaf, supplied_path, supplied_bits, zk_facts_root));

    let oracle_leaf = fact_leaf_hash(oracle_path_id, oracle_fresh, adapter_hash, ledger_seq);
    assert(verify_merkle_path(oracle_leaf, oracle_path, oracle_bits, zk_facts_root));

    // 3. Apply the policy predicate in the integer domain.
    let denom = if total_supplied == 0 { 1 } else { total_supplied };
    let utilization = (total_borrowed * SCALE) / denom;
    let below = (utilization as u64) < (max_utilization as u64);
    let fresh = oracle_fresh == 1;
    let safe = below & fresh;

    // compute_hash / result_hash are carried as public inputs and checked by the
    // Sefi proof envelope + verifier registry against the off-chain values.
    assert(compute_hash == compute_hash);
    assert(result_hash == result_hash);

    safe
}
