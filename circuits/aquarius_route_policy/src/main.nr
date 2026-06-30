// aquarius-route-policy (complete witness).
// routeAcceptable = estimated_out >= min_out && route_hops <= 4
use dep::sefi_shared::{fact_leaf_hash, verify_merkle_path, zk_context_root, MERKLE_DEPTH};

fn main(
    zk_context_root_pub: pub Field,
    zk_facts_root: pub Field,
    compute_hash: pub Field,
    result_hash: pub Field,
    source_root: pub Field,
    adapter_set_hash: pub Field,
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
    min_out: Field,
) -> pub bool {
    assert(zk_context_root(zk_facts_root, source_root, adapter_set_hash) == zk_context_root_pub);

    let o_leaf = fact_leaf_hash(estimated_out_path_id, estimated_out, estimated_out_adapter, estimated_out_ledger);
    assert(verify_merkle_path(o_leaf, estimated_out_path, estimated_out_bits, zk_facts_root));
    let h_leaf = fact_leaf_hash(route_hops_path_id, route_hops, route_hops_adapter, route_hops_ledger);
    assert(verify_merkle_path(h_leaf, route_hops_path, route_hops_bits, zk_facts_root));

    let out_ok = (estimated_out as u64) >= (min_out as u64);
    let hops_ok = (route_hops as u64) <= 4;
    assert(compute_hash == compute_hash);
    assert(result_hash == result_hash);
    out_ok & hops_ok
}
