#![cfg(test)]
//! Real Groth16 / BN254 verification test (audit follow-up #3, #4).
//!
//! Generates a genuine Groth16 proof with arkworks (the same BN254 curve backend
//! Soroban's host uses), serialises VK + proof + public inputs into Soroban's
//! EIP-197 byte layout, and asserts the contract's `verify_proof` returns TRUE
//! for a valid proof and FALSE for a wrong public input. This proves the
//! on-chain BN254 verifier actually verifies real proofs — it is not a stub.

extern crate std;

use super::*;
use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::Groth16;
use ark_relations::{
    lc,
    r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError},
};
use ark_snark::SNARK;
use ark_std::rand::{rngs::StdRng, SeedableRng};
use soroban_sdk::{BytesN, Env, Vec as SVec};

/// Tiny R1CS: prove knowledge of (a, b) with a * b == c, where c is public.
#[derive(Clone)]
struct MulCircuit {
    a: Option<Fr>,
    b: Option<Fr>,
}

impl ConstraintSynthesizer<Fr> for MulCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let a = cs.new_witness_variable(|| self.a.ok_or(SynthesisError::AssignmentMissing))?;
        let b = cs.new_witness_variable(|| self.b.ok_or(SynthesisError::AssignmentMissing))?;
        let c_val = match (self.a, self.b) {
            (Some(a), Some(b)) => Some(a * b),
            _ => None,
        };
        let c = cs.new_input_variable(|| c_val.ok_or(SynthesisError::AssignmentMissing))?;
        cs.enforce_constraint(lc!() + a, lc!() + b, lc!() + c)?;
        Ok(())
    }
}

fn fq_be(f: &Fq) -> [u8; 32] {
    let v = f.into_bigint().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - v.len()..].copy_from_slice(&v);
    out
}
fn fr_be(f: &Fr) -> [u8; 32] {
    let v = f.into_bigint().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - v.len()..].copy_from_slice(&v);
    out
}
fn g1_be(p: &G1Affine) -> [u8; 64] {
    let mut out = [0u8; 64];
    if p.infinity {
        return out;
    }
    out[..32].copy_from_slice(&fq_be(&p.x));
    out[32..].copy_from_slice(&fq_be(&p.y));
    out
}
fn fq2_be(x: &Fq2, out: &mut [u8]) {
    // EIP-197: imaginary (c1) first, then real (c0).
    out[..32].copy_from_slice(&fq_be(&x.c1));
    out[32..64].copy_from_slice(&fq_be(&x.c0));
}
fn g2_be(p: &G2Affine) -> [u8; 128] {
    let mut out = [0u8; 128];
    if p.infinity {
        return out;
    }
    fq2_be(&p.x, &mut out[0..64]);
    fq2_be(&p.y, &mut out[64..128]);
    out
}

fn build_vk(env: &Env, vk: &ark_groth16::VerifyingKey<Bn254>) -> VerifyingKey {
    let mut ic: SVec<BytesN<64>> = SVec::new(env);
    for p in vk.gamma_abc_g1.iter() {
        ic.push_back(BytesN::from_array(env, &g1_be(p)));
    }
    VerifyingKey {
        alpha_g1: BytesN::from_array(env, &g1_be(&vk.alpha_g1)),
        beta_g2: BytesN::from_array(env, &g2_be(&vk.beta_g2)),
        gamma_g2: BytesN::from_array(env, &g2_be(&vk.gamma_g2)),
        delta_g2: BytesN::from_array(env, &g2_be(&vk.delta_g2)),
        ic,
    }
}

#[test]
fn verify_real_groth16_proof_on_chain() {
    let mut rng = StdRng::seed_from_u64(42);
    let a = Fr::from(3u64);
    let b = Fr::from(11u64);
    let c = a * b;

    let (pk, vk) =
        Groth16::<Bn254>::circuit_specific_setup(MulCircuit { a: Some(a), b: Some(b) }, &mut rng)
            .expect("setup");
    let proof = Groth16::<Bn254>::prove(&pk, MulCircuit { a: Some(a), b: Some(b) }, &mut rng)
        .expect("prove");
    // Native sanity: arkworks itself accepts the proof.
    assert!(Groth16::<Bn254>::verify(&vk, &[c], &proof).expect("verify"));

    let env = Env::default();
    let id = env.register(NoirUltrahonkVerifier, ());
    let client = NoirUltrahonkVerifierClient::new(&env, &id);
    client.init(&build_vk(&env, &vk));

    let proof_sor = Groth16Proof {
        a: BytesN::from_array(&env, &g1_be(&proof.a)),
        b: BytesN::from_array(&env, &g2_be(&proof.b)),
        c: BytesN::from_array(&env, &g1_be(&proof.c)),
    };

    // Valid proof + correct public input -> on-chain BN254 pairing check returns TRUE.
    let mut pubins: SVec<BytesN<32>> = SVec::new(&env);
    pubins.push_back(BytesN::from_array(&env, &fr_be(&c)));
    assert!(
        client.verify_proof(&pubins, &proof_sor),
        "real Groth16 proof must verify on-chain"
    );

    // Wrong public input -> verification equation fails -> FALSE (not a panic, not a stub).
    let mut wrong: SVec<BytesN<32>> = SVec::new(&env);
    wrong.push_back(BytesN::from_array(&env, &fr_be(&(c + Fr::from(1u64)))));
    assert!(
        !client.verify_proof(&wrong, &proof_sor),
        "wrong public input must fail on-chain"
    );
}
