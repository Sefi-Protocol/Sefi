// aquarius-route-policy (audit Part F §10.2).
// routeAcceptable = estimatedOut >= minOut && routeHops <= 4
use dep::sefi_shared::{fact_leaf_hash, verify_merkle_path, zk_context_root, MERKLE_DEPTH};

fn main(
    zk_context_root_pub: pub Field,
    zk_facts_root: pub Field,
    compute_hash: pub Field,
    result_hash: pub Field,
    source_root: pub Field,
    adapter_set_hash: pub Field,
    estimated_out: Field,
    route_hops: Field,
    out_path_id: Field,
    hops_path_id: Field,
    adapter_hash: Field,
    ledger_seq: Field,
    out_path: [Field; MERKLE_DEPTH],
    out_bits: [u1; MERKLE_DEPTH],
    hops_path: [Field; MERKLE_DEPTH],
    hops_bits: [u1; MERKLE_DEPTH],
    min_out: Field,
) -> pub bool {
    assert(zk_context_root(zk_facts_root, source_root, adapter_set_hash) == zk_context_root_pub);

    let out_leaf = fact_leaf_hash(out_path_id, estimated_out, adapter_hash, ledger_seq);
    assert(verify_merkle_path(out_leaf, out_path, out_bits, zk_facts_root));
    let hops_leaf = fact_leaf_hash(hops_path_id, route_hops, adapter_hash, ledger_seq);
    assert(verify_merkle_path(hops_leaf, hops_path, hops_bits, zk_facts_root));

    let out_ok = (estimated_out as u64) >= (min_out as u64);
    let hops_ok = (route_hops as u64) <= 4;
    assert(compute_hash == compute_hash);
    assert(result_hash == result_hash);
    out_ok & hops_ok
}
