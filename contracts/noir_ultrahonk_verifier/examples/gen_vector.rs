//! Emit a real Groth16/BN254 verification vector (VK + proof + public inputs)
//! serialised into Soroban's EIP-197 byte layout, as a JSON blob the
//! verify-groth16-testnet script feeds to `stellar contract invoke`.
//!
//!   cargo run --example gen_vector --release > /tmp/sefi-groth16-vector.json

use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::Groth16;
use ark_relations::{
    lc,
    r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError},
};
use ark_snark::SNARK;
use ark_std::rand::{rngs::StdRng, SeedableRng};

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

fn hx(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}
fn fq_be(f: &Fq) -> [u8; 32] {
    let v = f.into_bigint().to_bytes_be();
    let mut o = [0u8; 32];
    o[32 - v.len()..].copy_from_slice(&v);
    o
}
fn fr_be(f: &Fr) -> [u8; 32] {
    let v = f.into_bigint().to_bytes_be();
    let mut o = [0u8; 32];
    o[32 - v.len()..].copy_from_slice(&v);
    o
}
fn g1(p: &G1Affine) -> [u8; 64] {
    let mut o = [0u8; 64];
    if p.infinity {
        return o;
    }
    o[..32].copy_from_slice(&fq_be(&p.x));
    o[32..].copy_from_slice(&fq_be(&p.y));
    o
}
fn fq2(x: &Fq2, o: &mut [u8]) {
    o[..32].copy_from_slice(&fq_be(&x.c1));
    o[32..64].copy_from_slice(&fq_be(&x.c0));
}
fn g2(p: &G2Affine) -> [u8; 128] {
    let mut o = [0u8; 128];
    if p.infinity {
        return o;
    }
    fq2(&p.x, &mut o[0..64]);
    fq2(&p.y, &mut o[64..128]);
    o
}

fn main() {
    let mut rng = StdRng::seed_from_u64(42);
    let a = Fr::from(3u64);
    let b = Fr::from(11u64);
    let c = a * b;
    let (pk, vk) =
        Groth16::<Bn254>::circuit_specific_setup(MulCircuit { a: Some(a), b: Some(b) }, &mut rng)
            .unwrap();
    let proof =
        Groth16::<Bn254>::prove(&pk, MulCircuit { a: Some(a), b: Some(b) }, &mut rng).unwrap();
    assert!(Groth16::<Bn254>::verify(&vk, &[c], &proof).unwrap());

    let ic: Vec<String> = vk.gamma_abc_g1.iter().map(|p| hx(&g1(p))).collect();
    let ic_json = ic
        .iter()
        .map(|s| format!("\"{}\"", s))
        .collect::<Vec<_>>()
        .join(",");
    println!(
        "{{\"alpha_g1\":\"{}\",\"beta_g2\":\"{}\",\"gamma_g2\":\"{}\",\"delta_g2\":\"{}\",\"ic\":[{}],\"proof_a\":\"{}\",\"proof_b\":\"{}\",\"proof_c\":\"{}\",\"pub\":[\"{}\"],\"pub_wrong\":[\"{}\"]}}",
        hx(&g1(&vk.alpha_g1)),
        hx(&g2(&vk.beta_g2)),
        hx(&g2(&vk.gamma_g2)),
        hx(&g2(&vk.delta_g2)),
        ic_json,
        hx(&g1(&proof.a)),
        hx(&g2(&proof.b)),
        hx(&g1(&proof.c)),
        hx(&fr_be(&c)),
        hx(&fr_be(&(c + Fr::from(1u64)))),
    );
}
