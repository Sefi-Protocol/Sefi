#![no_std]
//! Sefi Verifier Registry (audit Part G / spec §15).
//!
//! Registers BN254 verifier contracts per proof type, routes `verify` to the
//! registered verifier (real on-chain BN254 verification), and commits proof
//! cards on-chain via `emit_proof_card`.
//!
//! Honesty: `verify` returns the verifier contract's actual result. Only when
//! that returns true should callers label the proof `stellar_verified`. The
//! standalone `emit_proof_card` path (without verification) is a commitment and
//! must be labelled `proof_card_commitment_only`.

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
    Symbol, Vec,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Verifier(Symbol),
    VerifierHash(Symbol),
    Card(BytesN<32>),
}

#[contracttype]
#[derive(Clone)]
pub struct Groth16Proof {
    pub a: BytesN<64>,
    pub b: BytesN<128>,
    pub c: BytesN<64>,
}

/// Client interface for a registered verifier contract.
#[contractclient(name = "VerifierClient")]
pub trait Verifier {
    fn verify_proof(env: Env, public_inputs: Vec<BytesN<32>>, proof: Groth16Proof) -> bool;
}

#[contract]
pub struct SefiVerifierRegistry;

#[contractimpl]
impl SefiVerifierRegistry {
    /// Register a verifier address + its VK hash for a proof type.
    pub fn register_verifier(
        env: Env,
        proof_type: Symbol,
        verifier: Address,
        verifier_hash: BytesN<32>,
    ) {
        env.storage().persistent().set(&DataKey::Verifier(proof_type.clone()), &verifier);
        env.storage().persistent().set(&DataKey::VerifierHash(proof_type), &verifier_hash);
    }

    pub fn get_verifier(env: Env, proof_type: Symbol) -> Option<Address> {
        env.storage().persistent().get(&DataKey::Verifier(proof_type))
    }

    pub fn get_verifier_hash(env: Env, proof_type: Symbol) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::VerifierHash(proof_type))
    }

    /// Verify by routing to the registered verifier (real BN254 verification).
    /// Returns false if no verifier is registered for the proof type.
    pub fn verify(
        env: Env,
        proof_type: Symbol,
        public_inputs: Vec<BytesN<32>>,
        proof: Groth16Proof,
    ) -> bool {
        let verifier: Option<Address> =
            env.storage().persistent().get(&DataKey::Verifier(proof_type));
        match verifier {
            Some(addr) => {
                let client = VerifierClient::new(&env, &addr);
                client.verify_proof(&public_inputs, &proof)
            }
            None => false,
        }
    }

    /// Commit a proof card on-chain and emit a `SefiCard` event.
    pub fn emit_proof_card(
        env: Env,
        proof_id: BytesN<32>,
        proof_type: Symbol,
        context_root: BytesN<32>,
        compute_hash: BytesN<32>,
        result_hash: BytesN<32>,
        result: Symbol,
    ) {
        env.storage().persistent().set(&DataKey::Card(proof_id.clone()), &context_root);
        env.events().publish(
            (symbol_short!("SefiCard"), proof_id),
            (proof_type, context_root, compute_hash, result_hash, result, env.ledger().sequence()),
        );
    }

    pub fn get_card(env: Env, proof_id: BytesN<32>) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::Card(proof_id))
    }
}

mod test;
