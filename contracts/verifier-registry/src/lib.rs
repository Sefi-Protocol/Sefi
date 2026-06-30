#![no_std]
//! Sefi Verifier Registry (Phase 2B, spec §15).
//!
//! HONEST SCOPE: this contract is a registry + proof-card *commitment* layer.
//! `verify` performs the registry/commitment path and returns whether a proof
//! card was committed. It does NOT perform on-chain Groth16/PLONK verification
//! yet; callers must label this `proof_card_commitment_only`. Do not present a
//! commitment as cryptographic proof verification.

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env, Symbol, Vec,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Verifier(Symbol),     // proof_type -> registered verifier address
    VerifierHash(Symbol), // proof_type -> verifier hash
    Card(BytesN<32>),     // proof_id -> committed context root
}

#[contract]
pub struct SefiVerifierRegistry;

#[contractimpl]
impl SefiVerifierRegistry {
    /// Register a verifier for a proof type. (Admin auth omitted for the MVP.)
    pub fn register_verifier(
        env: Env,
        proof_type: Symbol,
        verifier: Address,
        verifier_hash: BytesN<32>,
    ) {
        env.storage().persistent().set(&DataKey::Verifier(proof_type.clone()), &verifier);
        env.storage().persistent().set(&DataKey::VerifierHash(proof_type), &verifier_hash);
    }

    /// Commitment-only "verify": records the public inputs were submitted for a
    /// registered proof type. Returns true when a verifier is registered. This
    /// is NOT cryptographic verification of `proof`.
    pub fn verify(
        env: Env,
        envelope_hash: BytesN<32>,
        proof_type: Symbol,
        public_inputs: Vec<BytesN<32>>,
        proof: Bytes,
    ) -> bool {
        let _ = (envelope_hash, public_inputs, proof);
        env.storage()
            .persistent()
            .has(&DataKey::Verifier(proof_type))
    }

    /// Emit a proof card event and persist its context-root commitment.
    pub fn emit_proof_card(
        env: Env,
        proof_id: BytesN<32>,
        context_root: BytesN<32>,
        result_hash: BytesN<32>,
    ) {
        env.storage()
            .persistent()
            .set(&DataKey::Card(proof_id.clone()), &context_root);
        env.events().publish(
            (symbol_short!("SefiCard"), proof_id),
            (context_root, result_hash, env.ledger().sequence()),
        );
    }

    /// Read back a committed proof card's context root (if any).
    pub fn get_card(env: Env, proof_id: BytesN<32>) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::Card(proof_id))
    }
}
