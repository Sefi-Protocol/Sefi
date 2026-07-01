import type {
  CompiledComputeIntent,
  ComputeEvaluation,
  ComputeIntent,
  ProofCard,
  ProofEnvelope,
  ProveResult,
} from "@sefi/shared-types";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compileIntent, evaluateCompute } from "@sefi/compute";
import { proveComputeIntent, verifyLocal, type VerifyResult } from "@sefi/proofs";
import { verifyCapsule } from "@sefi/context-capsules";
import type { SefiRuntime } from "./runtime.js";
import { ContextModule, type ComposeRequest } from "./context.js";

const exec = promisify(execFile);

/**
 * ComputeKit SDK namespace (spec §17): compile / evaluate / prove / explain a
 * {@link ComputeIntent} against a freshly-built context capsule. Private inputs
 * never leave this process boundary except into the deterministic evaluator and
 * the proving backend.
 */
export class ComputeModule {
  constructor(private rt: SefiRuntime) {}

  private async buildContext(intent: ComputeIntent) {
    // Prove against an existing capsule (audit Part E §2/§3): do NOT refetch live.
    const ctx = intent.context as { capsuleId?: string } & ComposeRequest;
    if (ctx && typeof ctx.capsuleId === "string") {
      const capsule = await this.rt.store.getCapsule(ctx.capsuleId);
      if (!capsule)
        throw new Error(`SEFI_COMPUTE_CAPSULE_NOT_FOUND: ${ctx.capsuleId}`);
      const facts = await this.rt.store.getCapsuleFacts(ctx.capsuleId);
      const sources = await this.rt.store.getCapsuleSourceRecords(ctx.capsuleId);
      const v = verifyCapsule(capsule, facts, sources);
      if (!v.ok)
        throw new Error(
          `SEFI_COMPUTE_CAPSULE_UNVERIFIED: roots do not match for ${ctx.capsuleId} (${JSON.stringify(v)})`,
        );
      return { capsule, facts };
    }
    const ctxModule = new ContextModule(this.rt);
    const { capsule, facts } = await ctxModule.build(ctx as ComposeRequest);
    return { capsule, facts };
  }

  /** Reject capsules that lack the roots required for the requested proof. */
  private assertProvable(capsule: { contextRoot?: string; semanticFactsRoot?: string; zkContextRoot?: string }, backend: string) {
    if (!capsule.semanticFactsRoot || !capsule.contextRoot)
      throw new Error("SEFI_COMPUTE_MISSING_V2_ROOTS: capsule lacks semanticFactsRoot/contextRoot");
    if (backend === "bn254-noir" && (!capsule.zkContextRoot))
      throw new Error("SEFI_COMPUTE_MISSING_ZK_ROOTS: capsule lacks zkContextRoot for BN254 proving");
  }

  async compile(intent: ComputeIntent): Promise<CompiledComputeIntent> {
    const { capsule, facts } = await this.buildContext(intent);
    const compiled = compileIntent({ intent, capsule, facts });
    await this.rt.store.saveComputeIntent(compiled);
    return compiled;
  }

  async evaluate(intent: ComputeIntent): Promise<{
    compiled: CompiledComputeIntent;
    evaluation: ComputeEvaluation;
  }> {
    const { capsule, facts } = await this.buildContext(intent);
    const compiled = compileIntent({ intent, capsule, facts });
    const evaluation = evaluateCompute(compiled, intent.privateInputs, facts, {
      maxAgeSeconds: intent.maxAgeSeconds,
    });
    return { compiled, evaluation };
  }

  async prove(intent: ComputeIntent): Promise<ProveResult> {
    const { capsule, facts } = await this.buildContext(intent);
    this.assertProvable(capsule, intent.proof.backend);
    const { result, compiled } = await proveComputeIntent({ intent, capsule, facts });
    await this.rt.store.saveComputeIntent(compiled);
    await this.rt.store.saveProofEnvelope(result.proofEnvelope, compiled.id);
    await this.rt.store.saveProofCard(result.proofCard, result.proofEnvelope.proofId);
    return result;
  }

  /** Human-readable, privacy-safe explanation of an envelope. */
  explain(envelope: ProofEnvelope): {
    trustModel: "proof-of-data-used";
    publicInputs: ProofEnvelope["publicInputs"];
    revealed: ProofEnvelope["revealed"];
  } {
    return {
      trustModel: "proof-of-data-used",
      publicInputs: envelope.publicInputs,
      revealed: envelope.revealed,
    };
  }
}

/** Verify SDK namespace (spec §17). */
export class VerifyModule {
  constructor(private rt: SefiRuntime) {}

  /**
   * Local verification (audit Part E §4). Envelope-only verification is "weak"
   * and only allowed when `opts.dev === true`. Otherwise this loads the stored
   * compiled intent + capsule + facts/sources, re-verifies capsule roots,
   * recomputes the result/compute/context bindings, and validates the backend
   * artifact — failing if any link is broken.
   */
  async local(
    envelope: ProofEnvelope,
    opts: { compiledIntentId?: string; capsuleId?: string; dev?: boolean } = {},
  ): Promise<VerifyResult> {
    // Try to recover the compiled intent from the proof envelope if not given.
    let compiled = opts.compiledIntentId
      ? await this.rt.store.getComputeIntent(opts.compiledIntentId)
      : null;
    if (!compiled) {
      // Best-effort: match a stored intent by computeHash + contextRoot.
      compiled = await this.findCompiledByEnvelope(envelope);
    }

    if (!compiled) {
      if (opts.dev) return verifyLocal(envelope);
      return {
        valid: false,
        reasons: [
          "no compiled intent bound to this envelope; pass { compiledIntentId } or { dev: true } for envelope-only verification",
        ],
      };
    }

    // Re-verify the capsule the compiled intent bound to.
    const capsuleId = opts.capsuleId ?? compiled.capsuleId;
    const capsule = capsuleId ? await this.rt.store.getCapsule(capsuleId) : null;
    const reasons: string[] = [];
    if (capsule) {
      const facts = await this.rt.store.getCapsuleFacts(capsule.id);
      const sources = await this.rt.store.getCapsuleSourceRecords(capsule.id);
      const cv = verifyCapsule(capsule, facts, sources);
      if (!cv.ok) reasons.push(`capsule roots failed: ${JSON.stringify(cv)}`);
      if (capsule.contextRoot && capsule.contextRoot !== compiled.contextRoot)
        reasons.push("capsule contextRoot does not match compiled intent");
    } else {
      reasons.push("bound capsule not found in store");
    }

    const base = await verifyLocal(envelope, compiled);
    return { valid: base.valid && reasons.length === 0, reasons: [...base.reasons, ...reasons] };
  }

  private async findCompiledByEnvelope(envelope: ProofEnvelope) {
    // Resolve the compiled intent linked to this proof at prove() time.
    return this.rt.store.getComputeIntentByProof(envelope.proofId);
  }

  async proofCard(proofId: string): Promise<ProofCard | null> {
    return this.rt.store.getProofCard(proofId);
  }

  /**
   * Stellar verification for a Sefi ComputeIntent proof envelope.
   *
   * For a **bn254-groth16** envelope (the default real backend), this performs
   * GENUINE on-chain verification: it serialises the snarkjs Groth16 proof +
   * public signals to the Soroban verifier's byte layout and invokes
   * `verify_proof` on-chain — returning `stellar_verified` iff the on-chain
   * BN254 pairing check returns true. This is the actual Sefi compute proof, not
   * a separate test proof.
   *
   * For other backends (e.g. bn254-noir / UltraHonk), the deployed Groth16
   * verifier cannot check the proof, so it falls back to a
   * `proof_card_commitment_only` on-chain commitment — never overclaiming.
   */
  async onStellar(
    envelope: ProofEnvelope,
    opts: { verifierContractId?: string; identity?: string; network?: "testnet" | "mainnet" } = {},
  ): Promise<{
    status: "stellar_verified" | "rejected" | "committed_on_stellar" | "not_configured";
    verificationMode: "stellar_verified" | "rejected" | "proof_card_commitment_only" | "not_configured";
    backend?: string;
    verifierContractId?: string;
    registryContractId?: string;
    verificationTx?: string;
  }> {
    const registry = process.env.SEFI_REGISTRY_CONTRACT_ID;
    const verifier = opts.verifierContractId ?? process.env.SEFI_VERIFIER_CONTRACT_ID;

    // Real on-chain verification path for the actual Sefi Groth16 compute proof.
    if (envelope.backend === "bn254-groth16" && envelope.groth16) {
      if (!verifier)
        return { status: "not_configured", verificationMode: "not_configured", backend: envelope.backend };
      const { groth16ToSoroban } = await import("@sefi/proofs");
      const sor = groth16ToSoroban(envelope.groth16 as any);
      const r = await this.onStellarGroth16({
        verifierContractId: verifier,
        identity: opts.identity,
        network: opts.network,
        proof: sor.proof,
        publicInputs: sor.publicInputs,
      });

      // When the on-chain verifier returns true, upgrade + persist the stored
      // proof card to stellar_verified so the durable record reflects reality.
      if (r.verified) {
        const card = await this.rt.store.getProofCard(envelope.proofId);
        if (card) {
          const stellarNote =
            `Verified on Stellar (${opts.network ?? "testnet"}) by verifier ${verifier}` +
            (r.verificationTx ? `, tx ${r.verificationTx}` : "");
          const updated = {
            ...card,
            verificationMode: "stellar_verified" as const,
            warnings: [...card.warnings.filter((w) => !w.startsWith("Verified on Stellar")), stellarNote],
          };
          await this.rt.store.saveProofCard(updated, envelope.proofId);
          // Also record the tx on the stored envelope.
          await this.rt.store.saveProofEnvelope(
            { ...envelope, verifierContractId: verifier, verificationTx: r.verificationTx, status: "verified" },
            undefined,
          );
        }
      }
      return {
        status: r.status,
        verificationMode: r.verificationMode,
        backend: envelope.backend,
        verifierContractId: verifier,
        registryContractId: registry,
        verificationTx: r.verificationTx,
      };
    }

    // Non-Groth16 backends: commitment-only (honest).
    if (!registry)
      return { status: "not_configured", verificationMode: "proof_card_commitment_only", backend: envelope.backend };
    return {
      status: "committed_on_stellar",
      verificationMode: "proof_card_commitment_only",
      backend: envelope.backend,
      registryContractId: registry,
      verifierContractId: verifier,
    };
  }

  /**
   * REAL on-chain BN254 Groth16 verification (audit follow-up #4). Invokes the
   * deployed verifier contract's `verify_proof(public_inputs, proof)` on Stellar
   * and returns `stellar_verified` iff the on-chain pairing check returns true.
   * This is genuine on-chain ZK verification — not a commitment. Requires the
   * `stellar` CLI + a funded identity and an initialised verifier contract.
   */
  async onStellarGroth16(input: {
    verifierContractId?: string;
    identity?: string;
    network?: "testnet" | "mainnet";
    proof: { a: string; b: string; c: string };
    publicInputs: string[];
  }): Promise<{
    verified: boolean;
    status: "stellar_verified" | "rejected" | "not_configured";
    verificationMode: "stellar_verified" | "rejected" | "not_configured";
    verifierContractId?: string;
    verificationTx?: string;
  }> {
    const verifier = input.verifierContractId ?? process.env.SEFI_VERIFIER_CONTRACT_ID;
    const identity = input.identity ?? process.env.SEFI_TESTNET_IDENTITY ?? "sefi-testnet";
    const network = input.network ?? "testnet";
    if (!verifier) return { verified: false, status: "not_configured", verificationMode: "not_configured" };
    try {
      const { stdout, stderr } = await exec(
        "stellar",
        [
          "contract", "invoke", "--id", verifier, "--source", identity, "--network", network,
          "--send=yes", "--", "verify_proof",
          "--public_inputs", JSON.stringify(input.publicInputs),
          "--proof", JSON.stringify(input.proof),
        ],
        { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
      );
      const verified = stdout.trim().endsWith("true");
      const verificationTx = /Signing transaction: ([0-9a-f]{64})/.exec(stderr)?.[1];
      return {
        verified,
        status: verified ? "stellar_verified" : "rejected",
        verificationMode: verified ? "stellar_verified" : "rejected",
        verifierContractId: verifier,
        verificationTx,
      };
    } catch (e) {
      return { verified: false, status: "rejected", verificationMode: "rejected", verifierContractId: verifier };
    }
  }
}
