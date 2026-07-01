pragma circom 2.1.6;

include "sefi_merkle.circom";
include "comparators.circom";

// Sefi sdex-exit-policy as a Groth16 circom circuit (Option B).
//
// sdexSafe = path_available && ( path_estimated_out >= min_receive
//                                || spread_bps <= max_spread_bps )
//
// Public signals (snarkjs order = output, then public inputs):
//   sdexSafe, zkContextRoot, zkFactsRoot, computeHash, resultHash
//
// Binds the policy result to the EXACT capsule the SDK selected:
//  - every fact value is included in zkFactsRoot via a Poseidon Merkle proof,
//  - zkContextRoot = Poseidon3(zkFactsRoot, sourceRoot, adapterSetHash),
//  - the exit predicate over the committed values; min_receive and
//    max_spread_bps stay private.
template SdexExit(depth) {
    // public
    signal input zkContextRoot;
    signal input zkFactsRoot;
    signal input computeHash;
    signal input resultHash;
    // private: capsule binding
    signal input sourceRoot;
    signal input adapterSetHash;
    // private: path_available fact
    signal input path_available;
    signal input path_available_path_id;
    signal input path_available_adapter;
    signal input path_available_ledger;
    signal input path_available_path[depth];
    signal input path_available_bits[depth];
    // private: path_estimated_out fact
    signal input path_estimated_out;
    signal input path_estimated_out_path_id;
    signal input path_estimated_out_adapter;
    signal input path_estimated_out_ledger;
    signal input path_estimated_out_path[depth];
    signal input path_estimated_out_bits[depth];
    // private: spread_bps fact
    signal input spread_bps;
    signal input spread_bps_path_id;
    signal input spread_bps_adapter;
    signal input spread_bps_ledger;
    signal input spread_bps_path[depth];
    signal input spread_bps_bits[depth];
    // private thresholds
    signal input min_receive;
    signal input max_spread_bps;

    signal output sdexSafe;

    // 1. zkContextRoot binds zkFactsRoot | sourceRoot | adapterSetHash.
    component ctx = ContextRoot();
    ctx.zkFactsRoot <== zkFactsRoot;
    ctx.sourceRoot <== sourceRoot;
    ctx.adapterSetHash <== adapterSetHash;
    zkContextRoot === ctx.out;

    // 2. Each fact is included in zkFactsRoot.
    component fa = VerifiedFact(depth);
    fa.value <== path_available; fa.pathId <== path_available_path_id; fa.adapterHash <== path_available_adapter; fa.ledgerSeq <== path_available_ledger;
    for (var i = 0; i < depth; i++) { fa.siblings[i] <== path_available_path[i]; fa.bits[i] <== path_available_bits[i]; }
    fa.zkFactsRoot <== zkFactsRoot;

    component fo = VerifiedFact(depth);
    fo.value <== path_estimated_out; fo.pathId <== path_estimated_out_path_id; fo.adapterHash <== path_estimated_out_adapter; fo.ledgerSeq <== path_estimated_out_ledger;
    for (var i = 0; i < depth; i++) { fo.siblings[i] <== path_estimated_out_path[i]; fo.bits[i] <== path_estimated_out_bits[i]; }
    fo.zkFactsRoot <== zkFactsRoot;

    component fs = VerifiedFact(depth);
    fs.value <== spread_bps; fs.pathId <== spread_bps_path_id; fs.adapterHash <== spread_bps_adapter; fs.ledgerSeq <== spread_bps_ledger;
    for (var i = 0; i < depth; i++) { fs.siblings[i] <== spread_bps_path[i]; fs.bits[i] <== spread_bps_bits[i]; }
    fs.zkFactsRoot <== zkFactsRoot;

    // 3. path_available must be boolean.
    path_available * (path_available - 1) === 0;

    // pathOk = path_estimated_out >= min_receive
    component pathOk = GreaterEqThan(160);
    pathOk.in[0] <== path_estimated_out;
    pathOk.in[1] <== min_receive;

    // spreadOk = spread_bps <= max_spread_bps
    component spreadOk = LessEqThan(64);
    spreadOk.in[0] <== spread_bps;
    spreadOk.in[1] <== max_spread_bps;

    // eitherOk = pathOk || spreadOk = 1 - (1-pathOk)(1-spreadOk)
    signal notPath; notPath <== 1 - pathOk.out;
    signal notSpread; notSpread <== 1 - spreadOk.out;
    signal neither; neither <== notPath * notSpread;
    signal eitherOk; eitherOk <== 1 - neither;

    // sdexSafe = path_available && eitherOk
    sdexSafe <== path_available * eitherOk;

    // Bind computeHash + resultHash as public inputs (carried for the envelope).
    signal chBind;
    chBind <== computeHash * computeHash;
    signal rhBind;
    rhBind <== resultHash * resultHash;
}

component main { public [zkContextRoot, zkFactsRoot, computeHash, resultHash] } = SdexExit(8);
