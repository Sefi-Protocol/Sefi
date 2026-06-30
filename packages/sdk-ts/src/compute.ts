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
    const ctxModule = new ContextModule(this.rt);
    const { capsule, facts } = await ctxModule.build(
      intent.context as ComposeRequest,
    );
    return { capsule, facts };
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

  async local(envelope: ProofEnvelope): Promise<VerifyResult> {
    return verifyLocal(envelope);
  }

  async proofCard(proofId: string): Promise<ProofCard | null> {
    return this.rt.store.getProofCard(proofId);
  }

  /** Stellar verification is commitment-only in Phase 2 (spec §15). */
  async onStellar(envelope: ProofEnvelope): Promise<{
    status: "committed_on_stellar" | "not_configured";
    verificationMode: "proof_card_commitment_only";
    verificationTx?: string;
  }> {
    void envelope;
    return {
      status: "not_configured",
      verificationMode: "proof_card_commitment_only",
    };
  }
}
