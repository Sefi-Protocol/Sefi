import type { Network, ProofEnvelope } from "@sefi/shared-types";
import { sha256Hex, stableStringify } from "@sefi/source-records";
import { StellarClient } from "@sefi/stellar-client";

/**
 * TypeScript client for the Sefi Verifier Registry (spec §15). Phase 2 supports
 * the read/commitment surface over Soroban simulate. Submitting transactions
 * (register/emit) requires a funded signer and is labelled honestly as
 * `proof_card_commitment_only` — never as cryptographic verification.
 */
export class VerifierRegistryClient {
  private client: StellarClient;
  constructor(
    private contractId: string,
    opts: { network: Network; rpcUrl?: string },
  ) {
    this.client = new StellarClient({ network: opts.network, rpcUrl: opts.rpcUrl });
  }

  /** Deterministic hash of a proof envelope for on-chain commitment. */
  static envelopeHash(envelope: ProofEnvelope): string {
    return sha256Hex(
      stableStringify({
        publicInputs: envelope.publicInputs,
        revealed: envelope.revealed,
        backend: envelope.backend,
      }),
    );
  }

  /**
   * Read a committed proof card's context root via simulate (read-only).
   * `proofIdHex` must be a 32-byte hex string (the on-chain proof id).
   */
  async getCard(proofIdHex: string): Promise<unknown> {
    const res = await this.client.simulate(this.contractId, "get_card", [
      await this.client.bytesScVal(proofIdHex),
    ]);
    return res.value;
  }

  /**
   * Phase 2 verification mode. Until a real verifier contract performs in-circuit
   * verification, this returns commitment-only semantics.
   */
  describeMode(): {
    verificationMode: "proof_card_commitment_only";
    note: string;
  } {
    return {
      verificationMode: "proof_card_commitment_only",
      note: "Registry commits/records the proof card on Stellar; it does not perform on-chain ZK verification yet.",
    };
  }
}
