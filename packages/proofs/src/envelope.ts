import { randomUUID } from "node:crypto";
import type {
  CompiledComputeIntent,
  ComputeEvaluation,
  ProofBackendId,
  ProofEnvelope,
} from "@sefi/shared-types";

/** Serialize revealed outputs to plain JSON scalars. */
export function serializeRevealed(
  revealed: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(revealed)) out[k] = v;
  return out;
}

/**
 * Build the canonical proof envelope (spec §13). Every backend returns this
 * exact shape; only `backend` and `proofBytes` differ.
 */
export function buildProofEnvelope(input: {
  backend: ProofBackendId;
  compiled: CompiledComputeIntent;
  evaluation: ComputeEvaluation;
  proofBytes: string;
  verifierContractId?: string;
  status?: ProofEnvelope["status"];
}): ProofEnvelope {
  return {
    proofId: `proof_${randomUUID().slice(0, 12)}`,
    proofType: "compute_intent",
    backend: input.backend,
    publicInputs: {
      contextRoot: input.compiled.contextRoot,
      sourceRoot: input.compiled.sourceRoot,
      semanticFactsRoot: input.compiled.semanticFactsRoot,
      adapterSetHash: input.compiled.adapterSetHash,
      computeHash: input.compiled.computeHash,
      resultHash: input.evaluation.resultHash,
      zkFactsRoot: input.compiled.zkFactsRoot,
      zkContextRoot: input.compiled.zkContextRoot,
    },
    revealed: serializeRevealed(input.evaluation.revealed),
    proofBytes: input.proofBytes,
    verifierContractId: input.verifierContractId,
    status: input.status ?? "verified",
    createdAt: new Date().toISOString(),
  };
}
