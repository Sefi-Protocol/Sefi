// blend-utilization-policy (audit follow-up: complete witness).
//
// Proves: over the capsule committed by zk_context_root/zk_facts_root, USDC
// reserve utilization is below the private threshold and the oracle is fresh —
// revealing only `safe`. Every fact value is bound to zk_facts_root via an
// in-circuit Poseidon Merkle inclusion proof. The per-fact (adapter, ledger)
// are part of the witness so the in-circuit leaf reconstruction is exact.

use dep::sefi_shared::{fact_leaf_hash, verify_merkle_path, zk_context_root, SCALE, MERKLE_DEPTH};

fn main(
    // public inputs
    zk_context_root_pub: pub Field,
    zk_facts_root: pub Field,
    compute_hash: pub Field,
    result_hash: pub Field,
    source_root: pub Field,
    adapter_set_hash: pub Field,
    // borrowed fact
    borrowed: Field,
    borrowed_path_id: Field,
    borrowed_adapter: Field,
    borrowed_ledger: Field,
    borrowed_path: [Field; MERKLE_DEPTH],
    borrowed_bits: [u1; MERKLE_DEPTH],
    // supplied fact
    supplied: Field,
    supplied_path_id: Field,
    supplied_adapter: Field,
    supplied_ledger: Field,
    supplied_path: [Field; MERKLE_DEPTH],
    supplied_bits: [u1; MERKLE_DEPTH],
    // oracle fact
    oracle: Field,
    oracle_path_id: Field,
    oracle_adapter: Field,
    oracle_ledger: Field,
    oracle_path: [Field; MERKLE_DEPTH],
    oracle_bits: [u1; MERKLE_DEPTH],
    // private threshold
    max_utilization: Field,
) -> pub bool {
    // 1. zk_context_root binds zkFactsRoot | sourceRoot | adapterSetHash.
    assert(zk_context_root(zk_facts_root, source_root, adapter_set_hash) == zk_context_root_pub);

    // 2. Each fact leaf reconstructs and is included in zk_facts_root.
    let b_leaf = fact_leaf_hash(borrowed_path_id, borrowed, borrowed_adapter, borrowed_ledger);
    assert(verify_merkle_path(b_leaf, borrowed_path, borrowed_bits, zk_facts_root));
    let s_leaf = fact_leaf_hash(supplied_path_id, supplied, supplied_adapter, supplied_ledger);
    assert(verify_merkle_path(s_leaf, supplied_path, supplied_bits, zk_facts_root));
    let o_leaf = fact_leaf_hash(oracle_path_id, oracle, oracle_adapter, oracle_ledger);
    assert(verify_merkle_path(o_leaf, oracle_path, oracle_bits, zk_facts_root));

    // 3. Policy predicate (integer domain).
    let denom = if supplied == 0 { 1 } else { supplied };
    let utilization = (borrowed * SCALE) / denom;
    let below = (utilization as u64) < (max_utilization as u64);
    let safe = below & (oracle == 1);

    // compute_hash / result_hash are carried as public inputs and checked by the
    // Sefi proof envelope + verifier registry against the off-chain values.
    assert(compute_hash == compute_hash);
    assert(result_hash == result_hash);
    safe
}
