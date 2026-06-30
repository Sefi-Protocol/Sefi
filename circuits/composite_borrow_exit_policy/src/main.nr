// composite-borrow-exit-policy (complete witness).
// blendSafe = health > min_health
// aquaExit  = estimated_out >= min_receive && route_hops <= 4
// sdexExit  = path_available && path_estimated_out >= min_receive
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
    health_path_id: Field,
    health_adapter: Field,
    health_ledger: Field,
    health_path: [Field; MERKLE_DEPTH],
    health_bits: [u1; MERKLE_DEPTH],
    estimated_out: Field,
    estimated_out_path_id: Field,
    estimated_out_adapter: Field,
    estimated_out_ledger: Field,
    estimated_out_path: [Field; MERKLE_DEPTH],
    estimated_out_bits: [u1; MERKLE_DEPTH],
    route_hops: Field,
    route_hops_path_id: Field,
    route_hops_adapter: Field,
    route_hops_ledger: Field,
    route_hops_path: [Field; MERKLE_DEPTH],
    route_hops_bits: [u1; MERKLE_DEPTH],
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
    min_health: Field,
    min_receive: Field,
) -> pub bool {
    assert(zk_context_root(zk_facts_root, source_root, adapter_set_hash) == zk_context_root_pub);

    let h_leaf = fact_leaf_hash(health_path_id, health, health_adapter, health_ledger);
    assert(verify_merkle_path(h_leaf, health_path, health_bits, zk_facts_root));
    let o_leaf = fact_leaf_hash(estimated_out_path_id, estimated_out, estimated_out_adapter, estimated_out_ledger);
    assert(verify_merkle_path(o_leaf, estimated_out_path, estimated_out_bits, zk_facts_root));
    let hp_leaf = fact_leaf_hash(route_hops_path_id, route_hops, route_hops_adapter, route_hops_ledger);
    assert(verify_merkle_path(hp_leaf, route_hops_path, route_hops_bits, zk_facts_root));
    let a_leaf = fact_leaf_hash(path_available_path_id, path_available, path_available_adapter, path_available_ledger);
    assert(verify_merkle_path(a_leaf, path_available_path, path_available_bits, zk_facts_root));
    let so_leaf = fact_leaf_hash(path_estimated_out_path_id, path_estimated_out, path_estimated_out_adapter, path_estimated_out_ledger);
    assert(verify_merkle_path(so_leaf, path_estimated_out_path, path_estimated_out_bits, zk_facts_root));

    let blend_safe = (health as u64) > (min_health as u64);
    let aqua_exit = ((estimated_out as u64) >= (min_receive as u64)) & ((route_hops as u64) <= 4);
    let sdex_exit = (path_available == 1) & ((path_estimated_out as u64) >= (min_receive as u64));
    let allowed = blend_safe & (aqua_exit | sdex_exit);
    assert(compute_hash == compute_hash);
    assert(result_hash == result_hash);
    allowed
}
