// Sefi shared circuit library (audit Part F).
//
// Recomputes the ZK fact-leaf hashes and Poseidon Merkle roots that the
// TypeScript reference (packages/source-records/src/zk-hash.ts) computes, so the
// circuit can bind specific facts to the capsule's zkFactsRoot / zkContextRoot.
//
// Poseidon instantiation MUST match the TS `poseidon-lite` (circomlib BN254
// Poseidon). The cross-check is enforced by circuits/shared tests + the TS
// golden vectors. SCALE matches packages/compute SCALE.

use dep::std::hash::poseidon;

global SCALE: Field = 1000000;
global MERKLE_DEPTH: u32 = 8; // supports up to 256 facts per capsule

// zk fact leaf hash = Poseidon4(pathId, value, adapterHash, ledgerSeq)
pub fn fact_leaf_hash(path_id: Field, value: Field, adapter_hash: Field, ledger_seq: Field) -> Field {
    poseidon::bn254::hash_4([path_id, value, adapter_hash, ledger_seq])
}

// Poseidon2 of an ordered pair (matches TS poseidonMerkleRoot internal node).
pub fn hash_pair(left: Field, right: Field) -> Field {
    poseidon::bn254::hash_2([left, right])
}

// Verify a Merkle inclusion path. `path` holds sibling hashes bottom-up;
// `index_bits` are the position bits (0 = current is left, 1 = current is right),
// matching the sorted-leaves construction used by the TS reference.
pub fn verify_merkle_path<let N: u32>(
    leaf: Field,
    path: [Field; N],
    index_bits: [u1; N],
    root: Field,
) -> bool {
    let mut current = leaf;
    for i in 0..N {
        let sibling = path[i];
        if index_bits[i] == 0 {
            current = hash_pair(current, sibling);
        } else {
            current = hash_pair(sibling, current);
        }
    }
    current == root
}

// zkContextRoot = Poseidon3(zkFactsRoot, sourceRootFr, adapterSetHashFr)
pub fn zk_context_root(zk_facts_root: Field, source_root: Field, adapter_set_hash: Field) -> Field {
    poseidon::bn254::hash_3([zk_facts_root, source_root, adapter_set_hash])
}
