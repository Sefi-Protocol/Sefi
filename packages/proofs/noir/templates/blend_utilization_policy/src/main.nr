// Sefi blend-utilization-policy predicate (spec §12.3).
//
// Public inputs carry the Sefi context commitments so the proof is bound to the
// exact capsule + compute the SDK selected. Phase 2 enforces data binding via
// the Sefi proof envelope + replayable capsule; in-circuit Merkle inclusion of
// the fact leaves against semantic_facts_root is a planned next increment.
//
// Witness file is generated outside git (spec §12.2).

global SCALE: Field = 1000000;

fn main(
    context_root: pub Field,
    semantic_facts_root: pub Field,
    compute_hash: pub Field,
    result_hash: pub Field,
    total_borrowed: Field,
    total_supplied: Field,
    oracle_fresh: bool,
    private_max_utilization: Field,
) -> pub bool {
    // Bind public inputs so they cannot be optimized away.
    assert(context_root == context_root);
    assert(semantic_facts_root == semantic_facts_root);
    assert(compute_hash == compute_hash);
    assert(result_hash == result_hash);

    let denom = if total_supplied == 0 { 1 } else { total_supplied };
    let utilization = (total_borrowed * SCALE) / denom;

    let below_threshold = utilization as u64 < private_max_utilization as u64;
    let safe = below_threshold & oracle_fresh;
    safe
}
