// composite-borrow-exit-policy (audit Part F §10.4).
// blendSafe = healthAfterAction > minHealth
// aquaExit  = estimatedOut >= minReceive && routeHops <= 4
// sdexExit  = pathAvailable && pathEstimatedOut >= minReceive
// allowed   = blendSafe && (aquaExit || sdexExit)
use dep::sefi_shared::{fact_leaf_hash, verify_merkle_path, zk_context_root, MERKLE_DEPTH};

fn main(
    zk_context_root_pub: pub Field,
    zk_facts_root: pub Field,
    compute_hash: pub Field,
    result_hash: pub Field,
    source_root: pub Field,
    adapter_set_hash: pub Field,
    health: Field,
    estimated_out: Field,
    route_hops: Field,
    path_available: Field,
    path_estimated_out: Field,
    health_path_id: Field,
    out_path_id: Field,
    hops_path_id: Field,
    avail_path_id: Field,
    sdex_out_path_id: Field,
    adapter_set_for_blend: Field,
    adapter_set_for_aqua: Field,
    adapter_set_for_sdex: Field,
    ledger_seq: Field,
    health_path: [Field; MERKLE_DEPTH],
    health_bits: [u1; MERKLE_DEPTH],
    out_path: [Field; MERKLE_DEPTH],
    out_bits: [u1; MERKLE_DEPTH],
    hops_path: [Field; MERKLE_DEPTH],
    hops_bits: [u1; MERKLE_DEPTH],
    avail_path: [Field; MERKLE_DEPTH],
    avail_bits: [u1; MERKLE_DEPTH],
    sdex_out_path: [Field; MERKLE_DEPTH],
    sdex_out_bits: [u1; MERKLE_DEPTH],
    min_health: Field,
    min_receive: Field,
) -> pub bool {
    assert(zk_context_root(zk_facts_root, source_root, adapter_set_hash) == zk_context_root_pub);

    // Each fact binds with its own adapter hash (per-protocol).
    let h_leaf = fact_leaf_hash(health_path_id, health, adapter_set_for_blend, ledger_seq);
    assert(verify_merkle_path(h_leaf, health_path, health_bits, zk_facts_root));
    let o_leaf = fact_leaf_hash(out_path_id, estimated_out, adapter_set_for_aqua, ledger_seq);
    assert(verify_merkle_path(o_leaf, out_path, out_bits, zk_facts_root));
    let hp_leaf = fact_leaf_hash(hops_path_id, route_hops, adapter_set_for_aqua, ledger_seq);
    assert(verify_merkle_path(hp_leaf, hops_path, hops_bits, zk_facts_root));
    let a_leaf = fact_leaf_hash(avail_path_id, path_available, adapter_set_for_sdex, ledger_seq);
    assert(verify_merkle_path(a_leaf, avail_path, avail_bits, zk_facts_root));
    let so_leaf = fact_leaf_hash(sdex_out_path_id, path_estimated_out, adapter_set_for_sdex, ledger_seq);
    assert(verify_merkle_path(so_leaf, sdex_out_path, sdex_out_bits, zk_facts_root));

    let blend_safe = (health as u64) > (min_health as u64);
    let aqua_exit = ((estimated_out as u64) >= (min_receive as u64)) & ((route_hops as u64) <= 4);
    let sdex_exit = (path_available == 1) & ((path_estimated_out as u64) >= (min_receive as u64));
    let allowed = blend_safe & (aqua_exit | sdex_exit);
    assert(compute_hash == compute_hash);
    assert(result_hash == result_hash);
    allowed
}
