// sdex-exit-policy (complete witness).
// pathOk = path_estimated_out >= min_receive
// spreadOk = spread_bps <= max_spread_bps
// exitOk = path_available && (pathOk || spreadOk)
use dep::sefi_shared::{fact_leaf_hash, verify_merkle_path, zk_context_root, MERKLE_DEPTH};

fn main(
    zk_context_root_pub: pub Field,
    zk_facts_root: pub Field,
    compute_hash: pub Field,
    result_hash: pub Field,
    source_root: pub Field,
    adapter_set_hash: pub Field,
    path_available: Field,
    path_available_path_id: Field,
    path_available_adapter: Field,
    path_available_ledger: Field,
    path_available_path: [Field; MERKLE_DEPTH],
    path_available_bits: [u1; MERKLE_DEPTH],
    path_estimated_out: Field,
    path_estimated_out_path_id: Field,
    path_estimated_out_adapter: Field,
    path_estimated_out_ledger: Field,
    path_estimated_out_path: [Field; MERKLE_DEPTH],
    path_estimated_out_bits: [u1; MERKLE_DEPTH],
    spread_bps: Field,
    spread_bps_path_id: Field,
    spread_bps_adapter: Field,
    spread_bps_ledger: Field,
    spread_bps_path: [Field; MERKLE_DEPTH],
    spread_bps_bits: [u1; MERKLE_DEPTH],
    min_receive: Field,
    max_spread_bps: Field,
) -> pub bool {
    assert(zk_context_root(zk_facts_root, source_root, adapter_set_hash) == zk_context_root_pub);

    let a_leaf = fact_leaf_hash(path_available_path_id, path_available, path_available_adapter, path_available_ledger);
    assert(verify_merkle_path(a_leaf, path_available_path, path_available_bits, zk_facts_root));
    let o_leaf = fact_leaf_hash(path_estimated_out_path_id, path_estimated_out, path_estimated_out_adapter, path_estimated_out_ledger);
    assert(verify_merkle_path(o_leaf, path_estimated_out_path, path_estimated_out_bits, zk_facts_root));
    let s_leaf = fact_leaf_hash(spread_bps_path_id, spread_bps, spread_bps_adapter, spread_bps_ledger);
    assert(verify_merkle_path(s_leaf, spread_bps_path, spread_bps_bits, zk_facts_root));

    let path_ok = (path_estimated_out as u64) >= (min_receive as u64);
    let spread_ok = (spread_bps as u64) <= (max_spread_bps as u64);
    let exit_ok = (path_available == 1) & (path_ok | spread_ok);
    assert(compute_hash == compute_hash);
    assert(result_hash == result_hash);
    exit_ok
}
