#![no_std]
//! Sefi BN254 pairing-check verifier (audit Part G).
//!
//! Implements the Groth16 verification equation over BN254 using Soroban's
//! BN254 host functions (`env.crypto().bn254()`): g1 add, g1 mul, and the
//! multi-pairing check. Stores a verification key (VK) and exposes
//! `verify_proof(public_inputs, proof)`.
//!
//! HONEST SCOPE: this genuinely exercises the on-chain BN254 path (the
//! `bn254_smoke_*` entrypoints + tests prove the host primitives are called,
//! not stubbed). It is a real pairing-check verifier but is NOT yet wired to
//! bb's exact UltraHonk verification key; swapping the bb-generated VK/verifier
//! in is documented in docs/zk-bn254.md. Trust model stays "proof-of-data-used".

use soroban_sdk::{
    contract, contractimpl, contracttype,
    crypto::bn254::{Bn254G1Affine, Bn254G2Affine, Fr},
    vec, BytesN, Env, Vec, U256,
};

#[contracttype]
pub enum DataKey {
    Vk,
}

#[contracttype]
#[derive(Clone)]
pub struct VerifyingKey {
    pub alpha_g1: BytesN<64>,
    pub beta_g2: BytesN<128>,
    pub gamma_g2: BytesN<128>,
    pub delta_g2: BytesN<128>,
    /// IC[0..=n]: base point plus one per public input.
    pub ic: Vec<BytesN<64>>,
}

#[contracttype]
#[derive(Clone)]
pub struct Groth16Proof {
    pub a: BytesN<64>,
    pub b: BytesN<128>,
    pub c: BytesN<64>,
}

#[contract]
pub struct NoirUltrahonkVerifier;

#[contractimpl]
impl NoirUltrahonkVerifier {
    /// Store the VK bytes (call once at deploy time).
    pub fn init(env: Env, vk: VerifyingKey) {
        env.storage().instance().set(&DataKey::Vk, &vk);
    }

    pub fn get_vk(env: Env) -> VerifyingKey {
        env.storage().instance().get(&DataKey::Vk).unwrap()
    }

    /// Verify a Groth16 proof against `public_inputs` via the BN254 host pairing
    /// check. Returns true iff the verification equation holds.
    pub fn verify_proof(env: Env, public_inputs: Vec<BytesN<32>>, proof: Groth16Proof) -> bool {
        let vk: VerifyingKey = env.storage().instance().get(&DataKey::Vk).unwrap();
        let bn = env.crypto().bn254();

        // vk_x = IC[0] + sum_i public_inputs[i] * IC[i+1]
        let mut vk_x = Bn254G1Affine::from_bytes(vk.ic.get(0).unwrap());
        let n = public_inputs.len();
        for i in 0..n {
            let scalar = Fr::from_bytes(public_inputs.get(i).unwrap());
            let ic_point = Bn254G1Affine::from_bytes(vk.ic.get(i + 1).unwrap());
            let term = bn.g1_mul(&ic_point, &scalar);
            vk_x = bn.g1_add(&vk_x, &term);
        }

        // e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1
        let a = Bn254G1Affine::from_bytes(proof.a);
        let b = Bn254G2Affine::from_bytes(proof.b);
        let c = Bn254G1Affine::from_bytes(proof.c);
        let neg_a = -&a;
        let alpha = Bn254G1Affine::from_bytes(vk.alpha_g1);
        let beta = Bn254G2Affine::from_bytes(vk.beta_g2);
        let gamma = Bn254G2Affine::from_bytes(vk.gamma_g2);
        let delta = Bn254G2Affine::from_bytes(vk.delta_g2);

        let g1s: Vec<Bn254G1Affine> = vec![&env, neg_a, alpha, vk_x, c];
        let g2s: Vec<Bn254G2Affine> = vec![&env, b, beta, gamma, delta];
        bn.pairing_check(g1s, g2s)
    }

    /// BN254 smoke (audit Part G): proves the host BN254 path is real. Uses the
    /// G1 generator (1, 2) and asserts G + G == 2*G via the host primitives.
    pub fn bn254_smoke_g1_double(env: Env) -> bool {
        let bn = env.crypto().bn254();
        let g = g1_generator(&env);
        let two = Fr::from_u256(U256::from_u32(&env, 2));
        let sum = bn.g1_add(&g, &g);
        let doubled = bn.g1_mul(&g, &two);
        sum == doubled
    }

    /// BN254 smoke: 3*G == G + 2*G (a second independent host-path check).
    pub fn bn254_smoke_g1_triple(env: Env) -> bool {
        let bn = env.crypto().bn254();
        let g = g1_generator(&env);
        let two = Fr::from_u256(U256::from_u32(&env, 2));
        let three = Fr::from_u256(U256::from_u32(&env, 3));
        let lhs = bn.g1_mul(&g, &three);
        let rhs = bn.g1_add(&g, &bn.g1_mul(&g, &two));
        lhs == rhs
    }
}

/// BN254 G1 generator point (X = 1, Y = 2), big-endian 32-byte coordinates.
fn g1_generator(env: &Env) -> Bn254G1Affine {
    let mut buf = [0u8; 64];
    buf[31] = 1; // X = 1
    buf[63] = 2; // Y = 2
    Bn254G1Affine::from_bytes(BytesN::from_array(env, &buf))
}

mod test;
