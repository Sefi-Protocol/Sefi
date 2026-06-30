import type {
  CompiledComputeIntent,
  ComputeEvaluation,
  ComputeIntent,
  ProofCard,
  ProofEnvelope,
  ProveResult,
} from "@sefi/shared-types";
import { compileIntent, evaluateCompute } from "@sefi/compute";
import { proveComputeIntent, verifyLocal, type VerifyResult } from "@sefi/proofs";
import { verifyCapsule } from "@sefi/context-capsules";
import type { SefiRuntime } from "./runtime.js";
import { ContextModule, type ComposeRequest } from "./context.js";

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
   * Stellar verification (audit Part G). When a registry contract is configured
   * (SEFI_REGISTRY_CONTRACT_ID) this reports the commitment-only mode; the real
   * on-chain commit is performed by scripts/verify-proof-testnet.ts via the
   * stellar CLI. `stellar_verified` is only returned when the on-chain
   * verify_proof path is wired to bb's UltraHonk VK (not yet — see zk-bn254.md),
   * so we never overclaim here.
   */
  async onStellar(envelope: ProofEnvelope): Promise<{
    status: "committed_on_stellar" | "not_configured";
    verificationMode: "proof_card_commitment_only";
    verifierContractId?: string;
    registryContractId?: string;
    verificationTx?: string;
  }> {
    void envelope;
    const registry = process.env.SEFI_REGISTRY_CONTRACT_ID;
    const verifier = process.env.SEFI_VERIFIER_CONTRACT_ID;
    if (!registry) {
      return { status: "not_configured", verificationMode: "proof_card_commitment_only" };
    }
    return {
      status: "committed_on_stellar",
      verificationMode: "proof_card_commitment_only",
      registryContractId: registry,
      verifierContractId: verifier,
    };
  }
}
