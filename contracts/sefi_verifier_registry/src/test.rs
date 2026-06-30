#![cfg(test)]
use super::*;
use soroban_sdk::{symbol_short, testutils::Address as _, Address, BytesN, Env, Vec};

#[test]
fn register_get_and_card_roundtrip() {
    let env = Env::default();
    let id = env.register(SefiVerifierRegistry, ());
    let client = SefiVerifierRegistryClient::new(&env, &id);

    let proof_type = symbol_short!("blendutil");
    let verifier = Address::generate(&env);
    let vk_hash = BytesN::from_array(&env, &[7u8; 32]);

    client.register_verifier(&proof_type, &verifier, &vk_hash);
    assert_eq!(client.get_verifier(&proof_type), Some(verifier));
    assert_eq!(client.get_verifier_hash(&proof_type), Some(vk_hash));

    // No verifier for an unknown type -> verify returns false (no stub-true).
    let empty: Vec<BytesN<32>> = Vec::new(&env);
    let proof = Groth16Proof {
        a: BytesN::from_array(&env, &[0u8; 64]),
        b: BytesN::from_array(&env, &[0u8; 128]),
        c: BytesN::from_array(&env, &[0u8; 64]),
    };
    assert_eq!(client.verify(&symbol_short!("unknown"), &empty, &proof), false);

    // Proof-card commitment roundtrip.
    let proof_id = BytesN::from_array(&env, &[1u8; 32]);
    let ctx = BytesN::from_array(&env, &[2u8; 32]);
    let ch = BytesN::from_array(&env, &[3u8; 32]);
    let rh = BytesN::from_array(&env, &[4u8; 32]);
    client.emit_proof_card(&proof_id, &proof_type, &ctx, &ch, &rh, &symbol_short!("verified"));
    assert_eq!(client.get_card(&proof_id), Some(ctx));
}
