pragma circom 2.1.6;

include "sefi_merkle.circom";
include "comparators.circom";

// Sefi blend-utilization-policy as a Groth16-friendly circom circuit (Option B).
//
// Public signals (snarkjs order = output, then public inputs):
//   safe, zkContextRoot, zkFactsRoot, computeHash, resultHash
//
// Binds the policy result to the EXACT capsule the SDK selected:
//  - every fact value is included in zkFactsRoot via a Poseidon Merkle proof,
//  - zkContextRoot = Poseidon3(zkFactsRoot, sourceRoot, adapterSetHash),
//  - utilization predicate over the committed values.
//
// Poseidon parameters match circomlibjs == poseidon-lite (the TS zkFactsRoot),
// so this circuit verifies against the roots already stored on the capsule.
template BlendUtilization(depth) {
    // public
    signal input zkContextRoot;
    signal input zkFactsRoot;
    signal input computeHash;
    signal input resultHash;
    // private: capsule binding
    signal input sourceRoot;
    signal input adapterSetHash;
    // private: borrowed fact
    signal input borrowed;
    signal input borrowed_path_id;
    signal input borrowed_adapter;
    signal input borrowed_ledger;
    signal input borrowed_path[depth];
    signal input borrowed_bits[depth];
    // private: supplied fact
    signal input supplied;
    signal input supplied_path_id;
    signal input supplied_adapter;
    signal input supplied_ledger;
    signal input supplied_path[depth];
    signal input supplied_bits[depth];
    // private: oracle fact
    signal input oracle;
    signal input oracle_path_id;
    signal input oracle_adapter;
    signal input oracle_ledger;
    signal input oracle_path[depth];
    signal input oracle_bits[depth];
    // private threshold
    signal input max_utilization;

    signal output safe;

    // 1. zkContextRoot binds zkFactsRoot | sourceRoot | adapterSetHash.
    component ctx = ContextRoot();
    ctx.zkFactsRoot <== zkFactsRoot;
    ctx.sourceRoot <== sourceRoot;
    ctx.adapterSetHash <== adapterSetHash;
    zkContextRoot === ctx.out;

    // 2. Each fact is included in zkFactsRoot.
    component fb = VerifiedFact(depth);
    fb.value <== borrowed; fb.pathId <== borrowed_path_id; fb.adapterHash <== borrowed_adapter; fb.ledgerSeq <== borrowed_ledger;
    for (var i = 0; i < depth; i++) { fb.siblings[i] <== borrowed_path[i]; fb.bits[i] <== borrowed_bits[i]; }
    fb.zkFactsRoot <== zkFactsRoot;

    component fs = VerifiedFact(depth);
    fs.value <== supplied; fs.pathId <== supplied_path_id; fs.adapterHash <== supplied_adapter; fs.ledgerSeq <== supplied_ledger;
    for (var i = 0; i < depth; i++) { fs.siblings[i] <== supplied_path[i]; fs.bits[i] <== supplied_bits[i]; }
    fs.zkFactsRoot <== zkFactsRoot;

    component fo = VerifiedFact(depth);
    fo.value <== oracle; fo.pathId <== oracle_path_id; fo.adapterHash <== oracle_adapter; fo.ledgerSeq <== oracle_ledger;
    for (var i = 0; i < depth; i++) { fo.siblings[i] <== oracle_path[i]; fo.bits[i] <== oracle_bits[i]; }
    fo.zkFactsRoot <== zkFactsRoot;

    // 3. Predicate (division-free): floor(borrowed*1e6/denom) < maxUtilization
    //    <=> borrowed*1e6 < maxUtilization*denom  (denom = supplied==0 ? 1 : supplied).
    component isZeroS = IsZero();
    isZeroS.in <== supplied;
    signal denom;
    denom <== supplied + isZeroS.out;

    signal lhs;
    lhs <== borrowed * 1000000;
    signal rhs;
    rhs <== max_utilization * denom;

    component lt = LessThan(160);
    lt.in[0] <== lhs;
    lt.in[1] <== rhs;

    // oracle must be boolean and fresh (==1).
    oracle * (oracle - 1) === 0;
    safe <== lt.out * oracle;

    // Bind computeHash + resultHash as public inputs (carried for the envelope).
    signal chBind;
    chBind <== computeHash * computeHash;
    signal rhBind;
    rhBind <== resultHash * resultHash;
}

component main { public [zkContextRoot, zkFactsRoot, computeHash, resultHash] } = BlendUtilization(8);
