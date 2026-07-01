pragma circom 2.1.6;

include "sefi_merkle.circom";
include "comparators.circom";

// Sefi aquarius-route-policy as a Groth16 circom circuit (Option B).
//
// routeSafe = (estimated_out >= min_out) && (route_hops <= 4)
//
// Public signals (snarkjs order = output, then public inputs):
//   routeSafe, zkContextRoot, zkFactsRoot, computeHash, resultHash
//
// Binds the policy result to the EXACT capsule the SDK selected:
//  - every fact value is included in zkFactsRoot via a Poseidon Merkle proof,
//  - zkContextRoot = Poseidon3(zkFactsRoot, sourceRoot, adapterSetHash),
//  - route predicate over the committed values, min_out stays private.
template AquariusRoute(depth) {
    // public
    signal input zkContextRoot;
    signal input zkFactsRoot;
    signal input computeHash;
    signal input resultHash;
    // private: capsule binding
    signal input sourceRoot;
    signal input adapterSetHash;
    // private: estimated_out fact
    signal input estimated_out;
    signal input estimated_out_path_id;
    signal input estimated_out_adapter;
    signal input estimated_out_ledger;
    signal input estimated_out_path[depth];
    signal input estimated_out_bits[depth];
    // private: route_hops fact
    signal input route_hops;
    signal input route_hops_path_id;
    signal input route_hops_adapter;
    signal input route_hops_ledger;
    signal input route_hops_path[depth];
    signal input route_hops_bits[depth];
    // private threshold
    signal input min_out;

    signal output routeSafe;

    // 1. zkContextRoot binds zkFactsRoot | sourceRoot | adapterSetHash.
    component ctx = ContextRoot();
    ctx.zkFactsRoot <== zkFactsRoot;
    ctx.sourceRoot <== sourceRoot;
    ctx.adapterSetHash <== adapterSetHash;
    zkContextRoot === ctx.out;

    // 2. Each fact is included in zkFactsRoot.
    component fo = VerifiedFact(depth);
    fo.value <== estimated_out; fo.pathId <== estimated_out_path_id; fo.adapterHash <== estimated_out_adapter; fo.ledgerSeq <== estimated_out_ledger;
    for (var i = 0; i < depth; i++) { fo.siblings[i] <== estimated_out_path[i]; fo.bits[i] <== estimated_out_bits[i]; }
    fo.zkFactsRoot <== zkFactsRoot;

    component fh = VerifiedFact(depth);
    fh.value <== route_hops; fh.pathId <== route_hops_path_id; fh.adapterHash <== route_hops_adapter; fh.ledgerSeq <== route_hops_ledger;
    for (var i = 0; i < depth; i++) { fh.siblings[i] <== route_hops_path[i]; fh.bits[i] <== route_hops_bits[i]; }
    fh.zkFactsRoot <== zkFactsRoot;

    // 3. Predicate: estimated_out >= min_out AND route_hops <= 4.
    component outOk = GreaterEqThan(160);
    outOk.in[0] <== estimated_out;
    outOk.in[1] <== min_out;

    component hopsOk = LessEqThan(16);
    hopsOk.in[0] <== route_hops;
    hopsOk.in[1] <== 4;

    routeSafe <== outOk.out * hopsOk.out;

    // Bind computeHash + resultHash as public inputs (carried for the envelope).
    signal chBind;
    chBind <== computeHash * computeHash;
    signal rhBind;
    rhBind <== resultHash * resultHash;
}

component main { public [zkContextRoot, zkFactsRoot, computeHash, resultHash] } = AquariusRoute(8);
