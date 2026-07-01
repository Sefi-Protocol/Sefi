pragma circom 2.1.6;

include "sefi_merkle.circom";
include "comparators.circom";

// Sefi composite-borrow-exit-policy as a Groth16 circom circuit (Option B).
//
// allowed = (health > minHealth) && ((estimatedOut >= minReceive && hops <= 4)
//                                     || (pathAvailable && pathOut >= minReceive))
//
// Public signals: allowed, zkContextRoot, zkFactsRoot, computeHash, resultHash.
// Each of the 5 facts is bound to zkFactsRoot via a Poseidon Merkle proof.
template CompositeBorrowExit(depth) {
    signal input zkContextRoot;
    signal input zkFactsRoot;
    signal input computeHash;
    signal input resultHash;
    signal input sourceRoot;
    signal input adapterSetHash;

    // 5 facts: health, estimated_out, route_hops, path_available, path_estimated_out
    signal input health; signal input health_path_id; signal input health_adapter; signal input health_ledger; signal input health_path[depth]; signal input health_bits[depth];
    signal input estimated_out; signal input estimated_out_path_id; signal input estimated_out_adapter; signal input estimated_out_ledger; signal input estimated_out_path[depth]; signal input estimated_out_bits[depth];
    signal input route_hops; signal input route_hops_path_id; signal input route_hops_adapter; signal input route_hops_ledger; signal input route_hops_path[depth]; signal input route_hops_bits[depth];
    signal input path_available; signal input path_available_path_id; signal input path_available_adapter; signal input path_available_ledger; signal input path_available_path[depth]; signal input path_available_bits[depth];
    signal input path_estimated_out; signal input path_estimated_out_path_id; signal input path_estimated_out_adapter; signal input path_estimated_out_ledger; signal input path_estimated_out_path[depth]; signal input path_estimated_out_bits[depth];

    signal input min_health;
    signal input min_receive;

    signal output allowed;

    // Context binding.
    component ctx = ContextRoot();
    ctx.zkFactsRoot <== zkFactsRoot; ctx.sourceRoot <== sourceRoot; ctx.adapterSetHash <== adapterSetHash;
    zkContextRoot === ctx.out;

    // Fact inclusion.
    component fh = VerifiedFact(depth);
    fh.value <== health; fh.pathId <== health_path_id; fh.adapterHash <== health_adapter; fh.ledgerSeq <== health_ledger;
    for (var i=0;i<depth;i++){ fh.siblings[i]<==health_path[i]; fh.bits[i]<==health_bits[i]; } fh.zkFactsRoot <== zkFactsRoot;
    component fo = VerifiedFact(depth);
    fo.value <== estimated_out; fo.pathId <== estimated_out_path_id; fo.adapterHash <== estimated_out_adapter; fo.ledgerSeq <== estimated_out_ledger;
    for (var i=0;i<depth;i++){ fo.siblings[i]<==estimated_out_path[i]; fo.bits[i]<==estimated_out_bits[i]; } fo.zkFactsRoot <== zkFactsRoot;
    component fhp = VerifiedFact(depth);
    fhp.value <== route_hops; fhp.pathId <== route_hops_path_id; fhp.adapterHash <== route_hops_adapter; fhp.ledgerSeq <== route_hops_ledger;
    for (var i=0;i<depth;i++){ fhp.siblings[i]<==route_hops_path[i]; fhp.bits[i]<==route_hops_bits[i]; } fhp.zkFactsRoot <== zkFactsRoot;
    component fa = VerifiedFact(depth);
    fa.value <== path_available; fa.pathId <== path_available_path_id; fa.adapterHash <== path_available_adapter; fa.ledgerSeq <== path_available_ledger;
    for (var i=0;i<depth;i++){ fa.siblings[i]<==path_available_path[i]; fa.bits[i]<==path_available_bits[i]; } fa.zkFactsRoot <== zkFactsRoot;
    component fso = VerifiedFact(depth);
    fso.value <== path_estimated_out; fso.pathId <== path_estimated_out_path_id; fso.adapterHash <== path_estimated_out_adapter; fso.ledgerSeq <== path_estimated_out_ledger;
    for (var i=0;i<depth;i++){ fso.siblings[i]<==path_estimated_out_path[i]; fso.bits[i]<==path_estimated_out_bits[i]; } fso.zkFactsRoot <== zkFactsRoot;

    // blendSafe = health > min_health
    component blendSafe = GreaterThan(160);
    blendSafe.in[0] <== health; blendSafe.in[1] <== min_health;
    // aquaOut = estimated_out >= min_receive
    component aquaOut = GreaterEqThan(160);
    aquaOut.in[0] <== estimated_out; aquaOut.in[1] <== min_receive;
    // hopsOk = route_hops <= 4
    component hopsOk = LessEqThan(16);
    hopsOk.in[0] <== route_hops; hopsOk.in[1] <== 4;
    // aquaExit = aquaOut && hopsOk
    signal aquaExit; aquaExit <== aquaOut.out * hopsOk.out;
    // sdexOut = path_estimated_out >= min_receive
    component sdexOut = GreaterEqThan(160);
    sdexOut.in[0] <== path_estimated_out; sdexOut.in[1] <== min_receive;
    // path_available boolean
    path_available * (path_available - 1) === 0;
    signal sdexExit; sdexExit <== path_available * sdexOut.out;
    // anyExit = aquaExit || sdexExit  = 1 - (1-aquaExit)(1-sdexExit)
    signal notAqua; notAqua <== 1 - aquaExit;
    signal notSdex; notSdex <== 1 - sdexExit;
    signal noneExit; noneExit <== notAqua * notSdex;
    signal anyExit; anyExit <== 1 - noneExit;
    // allowed = blendSafe && anyExit
    allowed <== blendSafe.out * anyExit;

    signal chBind; chBind <== computeHash * computeHash;
    signal rhBind; rhBind <== resultHash * resultHash;
}

component main { public [zkContextRoot, zkFactsRoot, computeHash, resultHash] } = CompositeBorrowExit(8);
