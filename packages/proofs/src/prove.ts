import type {
  CompiledComputeIntent,
  ComputeEvaluation,
  ComputeIntent,
  ContextCapsule,
  MerkleProof,
  ProofCard,
  ProofEnvelope,
  ProveResult,
  SemanticFact,
} from "@sefi/shared-types";
import { compileIntent, evaluateCompute } from "@sefi/compute";
import { resolveBackend } from "./router.js";

const DATA_USED_WARNING =
  "Data binding is enforced by the Sefi proof envelope and replayable capsule, not by in-circuit Merkle inclusion yet.";

/** Assemble a proof card (spec §4 / §16) from a verified envelope. */
export function buildProofCard(
  envelope: ProofEnvelope,
  evaluation: ComputeEvaluation,
  extraWarnings: string[] = [],
): ProofCard {
  const verified = envelope.status === "verified";
  return {
    proofId: envelope.proofId,
    proofType: envelope.proofType,
    contextRoot: envelope.publicInputs.contextRoot,
    computeHash: envelope.publicInputs.computeHash,
    publicResultHash: envelope.publicInputs.resultHash,
    publicResult: evaluation.revealed,
    result: verified ? "verified" : "failed",
    trustModel: "proof-of-data-used",
    verificationMode: "offchain_local",
    warnings: [
      "Sefi proves a deterministic policy was evaluated over the selected context capsule (proof-of-data-used), not that raw ledger state originated from canonical consensus.",
      ...(envelope.backend === "local-dev"
        ? ["local-dev backend is a test verifier, not a ZK proof."]
        : []),
      ...(envelope.backend === "noir" ? [] : [DATA_USED_WARNING]),
      ...extraWarnings,
    ],
  };
}

export interface ProveInput {
  intent: ComputeIntent;
  capsule: ContextCapsule;
  facts: SemanticFact[];
}

/**
 * Full prove pipeline (spec §2): compile → evaluate (deterministic witness) →
 * route to a backend → build envelope + proof card. Private inputs flow only
 * into evaluation/proving and never into the envelope, card, or warnings.
 */
export async function proveComputeIntent(input: ProveInput): Promise<{
  result: ProveResult;
  compiled: CompiledComputeIntent;
  evaluation: ComputeEvaluation;
}> {
  const compiled = compileIntent({
    intent: input.intent,
    capsule: input.capsule,
    facts: input.facts,
  });
  const evaluation = evaluateCompute(compiled, input.intent.privateInputs, input.facts, {
    maxAgeSeconds: input.intent.maxAgeSeconds,
  });

  const backend = resolveBackend(input.intent, compiled);
  const factMerkleProofs: MerkleProof[] = compiled.factRefs
    .map((b) => b.merkleProof)
    .filter((p): p is MerkleProof => Boolean(p));

  const envelope = await backend.prove({
    compiled,
    evaluation,
    capsule: input.capsule,
    factMerkleProofs,
    privateInputs: input.intent.privateInputs,
  });

  const card = buildProofCard(envelope, evaluation);
  return {
    result: { proofEnvelope: envelope, proofCard: card, publicInputs: envelope.publicInputs },
    compiled,
    evaluation,
  };
}
