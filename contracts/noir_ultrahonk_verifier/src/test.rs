#![cfg(test)]
use super::*;
use soroban_sdk::Env;

// These tests exercise the real BN254 host primitives (g1 add/mul). If the
// local test host supports BN254 (Protocol 25+), they assert the algebraic
// identities. They run under `cargo test`.

#[test]
fn bn254_g1_double_identity() {
    let env = Env::default();
    let id = env.register(NoirUltrahonkVerifier, ());
    let client = NoirUltrahonkVerifierClient::new(&env, &id);
    assert!(client.bn254_smoke_g1_double(), "G + G must equal 2*G via host BN254");
}

#[test]
fn bn254_g1_triple_identity() {
    let env = Env::default();
    let id = env.register(NoirUltrahonkVerifier, ());
    let client = NoirUltrahonkVerifierClient::new(&env, &id);
    assert!(client.bn254_smoke_g1_triple(), "3*G must equal G + 2*G via host BN254");
}
