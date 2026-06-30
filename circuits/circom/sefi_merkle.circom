pragma circom 2.1.6;

include "poseidon.circom";
include "comparators.circom";

// Fixed-depth Poseidon Merkle inclusion, matching the TypeScript reference in
// packages/source-records/src/zk-hash.ts (fixedTreeProof / verifyZkMerkleProof):
// at each level, bit==0 -> hash(cur, sibling); bit==1 -> hash(sibling, cur).
template MerkleInclusion(depth) {
    signal input leaf;
    signal input siblings[depth];
    signal input bits[depth];
    signal input root;

    component h[depth];
    signal cur[depth + 1];
    signal l[depth];
    signal r[depth];
    cur[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        // bits[i] must be boolean.
        bits[i] * (bits[i] - 1) === 0;
        // l = bit==0 ? cur : sibling ;  r = bit==0 ? sibling : cur
        l[i] <== cur[i] + bits[i] * (siblings[i] - cur[i]);
        r[i] <== siblings[i] + bits[i] * (cur[i] - siblings[i]);
        h[i] = Poseidon(2);
        h[i].inputs[0] <== l[i];
        h[i].inputs[1] <== r[i];
        cur[i + 1] <== h[i].out;
    }
    root === cur[depth];
}

// Poseidon4 fact leaf hash, matching zkFactLeafHash:
// Poseidon([pathId, value, adapterHash, ledgerSeq]).
template FactLeaf() {
    signal input pathId;
    signal input value;
    signal input adapterHash;
    signal input ledgerSeq;
    signal output out;

    component p = Poseidon(4);
    p.inputs[0] <== pathId;
    p.inputs[1] <== value;
    p.inputs[2] <== adapterHash;
    p.inputs[3] <== ledgerSeq;
    out <== p.out;
}

// Verify a fact: reconstruct its leaf and prove inclusion in zkFactsRoot.
template VerifiedFact(depth) {
    signal input value;
    signal input pathId;
    signal input adapterHash;
    signal input ledgerSeq;
    signal input siblings[depth];
    signal input bits[depth];
    signal input zkFactsRoot;

    component leaf = FactLeaf();
    leaf.pathId <== pathId;
    leaf.value <== value;
    leaf.adapterHash <== adapterHash;
    leaf.ledgerSeq <== ledgerSeq;

    component inc = MerkleInclusion(depth);
    inc.leaf <== leaf.out;
    for (var i = 0; i < depth; i++) {
        inc.siblings[i] <== siblings[i];
        inc.bits[i] <== bits[i];
    }
    inc.root <== zkFactsRoot;
}

// zkContextRoot = Poseidon3(zkFactsRoot, sourceRoot, adapterSetHash).
template ContextRoot() {
    signal input zkFactsRoot;
    signal input sourceRoot;
    signal input adapterSetHash;
    signal output out;
    component p = Poseidon(3);
    p.inputs[0] <== zkFactsRoot;
    p.inputs[1] <== sourceRoot;
    p.inputs[2] <== adapterSetHash;
    out <== p.out;
}
