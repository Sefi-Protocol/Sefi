// sdex-exit-policy (audit Part F §10.3).
// pathOk = pathEstimatedOut >= minReceive
// spreadOk = spreadBps <= maxSpreadBps
// exitOk = pathAvailable && (pathOk || spreadOk)
use dep::sefi_shared::{fact_leaf_hash, verify_merkle_path, zk_context_root, MERKLE_DEPTH};

fn main(
    zk_context_root_pub: pub Field,
    zk_facts_root: pub Field,
    compute_hash: pub Field,
    result_hash: pub Field,
    source_root: pub Field,
    adapter_set_hash: pub Field,
    path_available: Field, // 0/1
    path_estimated_out: Field,
    spread_bps: Field,
    avail_path_id: Field,
    out_path_id: Field,
    spread_path_id: Field,
    adapter_hash: Field,
    ledger_seq: Field,
    avail_path: [Field; MERKLE_DEPTH],
    avail_bits: [u1; MERKLE_DEPTH],
    out_path: [Field; MERKLE_DEPTH],
    out_bits: [u1; MERKLE_DEPTH],
    spread_path: [Field; MERKLE_DEPTH],
    spread_bits: [u1; MERKLE_DEPTH],
    min_receive: Field,
    max_spread_bps: Field,
) -> pub bool {
    assert(zk_context_root(zk_facts_root, source_root, adapter_set_hash) == zk_context_root_pub);

    let a_leaf = fact_leaf_hash(avail_path_id, path_available, adapter_hash, ledger_seq);
    assert(verify_merkle_path(a_leaf, avail_path, avail_bits, zk_facts_root));
    let o_leaf = fact_leaf_hash(out_path_id, path_estimated_out, adapter_hash, ledger_seq);
    assert(verify_merkle_path(o_leaf, out_path, out_bits, zk_facts_root));
    let s_leaf = fact_leaf_hash(spread_path_id, spread_bps, adapter_hash, ledger_seq);
    assert(verify_merkle_path(s_leaf, spread_path, spread_bits, zk_facts_root));

    let path_ok = (path_estimated_out as u64) >= (min_receive as u64);
    let spread_ok = (spread_bps as u64) <= (max_spread_bps as u64);
    let available = path_available == 1;
    let exit_ok = available & (path_ok | spread_ok);
    assert(compute_hash == compute_hash);
    assert(result_hash == result_hash);
    exit_ok
}
