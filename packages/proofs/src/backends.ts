import { createHmac } from "node:crypto";
import type {
  CompiledComputeIntent,
  ComputeEvaluation,
  ContextCapsule,
  MerkleProof,
  ProofBackendId,
  ProofEnvelope,
} from "@sefi/shared-types";
import { stableStringify } from "@sefi/source-records";
import { buildProofEnvelope } from "./envelope.js";

export interface ProofRequest {
  compiled: CompiledComputeIntent;
  evaluation: ComputeEvaluation;
  capsule: ContextCapsule;
  factMerkleProofs: MerkleProof[];
  privateInputs: Record<string, unknown>;
}

export interface ProofBackend {
  id: ProofBackendId;
  supports(compiled: CompiledComputeIntent): boolean;
  prove(input: ProofRequest): Promise<ProofEnvelope>;
  verifyLocal(envelope: ProofEnvelope): Promise<boolean>;
}

/**
 * Deterministic checksum over the envelope's public commitments + revealed
 * outputs. NOT a ZK proof — it is a tamper-evident binding so verifyLocal can
 * reject any altered public input or revealed value (spec §11/§14).
 */
export function proofChecksum(
  key: string,
  publicInputs: ProofEnvelope["publicInputs"],
  revealed: Record<string, string | number | boolean>,
  backend: ProofBackendId,
): string {
  return (
    "0x" +
    createHmac("sha256", key)
      .update(stableStringify({ backend, publicInputs, revealed }))
      .digest("hex")
  );
}

const LOCAL_DEV_KEY = "sefi.local-dev.v1";
/** Prebuilt recipes are signed with a recipe-scoped key. */
function prebuiltKey(recipe: string): string {
  return `sefi.prebuilt.v1:${recipe}`;
}

/**
 * local-dev backend (spec §11): test verifier only. Disabled in production
 * unless SEFI_ALLOW_LOCAL_DEV_PROOFS=1. proofBytes is a checksum, never a ZK proof.
 */
export class LocalDevBackend implements ProofBackend {
  id = "local-dev" as const;
  supports(): boolean {
    return true;
  }
  async prove(input: ProofRequest): Promise<ProofEnvelope> {
    if (
      process.env.NODE_ENV === "production" &&
      process.env.SEFI_ALLOW_LOCAL_DEV_PROOFS !== "1"
    ) {
      throw new Error(
        "SEFI_LOCAL_DEV_DISABLED: local-dev proofs are disabled in production",
      );
    }
    const env0 = buildProofEnvelope({
      backend: this.id,
      compiled: input.compiled,
      evaluation: input.evaluation,
      proofBytes: "",
    });
    const checksum = proofChecksum(LOCAL_DEV_KEY, env0.publicInputs, env0.revealed, this.id);
    return { ...env0, proofBytes: checksum };
  }
  async verifyLocal(envelope: ProofEnvelope): Promise<boolean> {
    const expected = proofChecksum(LOCAL_DEV_KEY, envelope.publicInputs, envelope.revealed, this.id);
    return constantTimeEqual(expected, envelope.proofBytes);
  }
}

/**
 * prebuilt backend (spec §11): a real signed envelope over deterministic recipe
 * outputs. Used for the named recipes. Still proof-of-data-used, not ZK.
 */
export class PrebuiltBackend implements ProofBackend {
  id = "prebuilt" as const;
  supports(compiled: CompiledComputeIntent): boolean {
    return isPrebuiltRecipe(compiled.name);
  }
  async prove(input: ProofRequest): Promise<ProofEnvelope> {
    const key = prebuiltKey(input.compiled.name);
    const env0 = buildProofEnvelope({
      backend: this.id,
      compiled: input.compiled,
      evaluation: input.evaluation,
      proofBytes: "",
    });
    const checksum = proofChecksum(key, env0.publicInputs, env0.revealed, this.id);
    return { ...env0, proofBytes: checksum };
  }
  async verifyLocal(envelope: ProofEnvelope): Promise<boolean> {
    // The recipe name is not in the envelope; recompute against all known recipes.
    for (const recipe of PREBUILT_RECIPES) {
      const expected = proofChecksum(prebuiltKey(recipe), envelope.publicInputs, envelope.revealed, this.id);
      if (constantTimeEqual(expected, envelope.proofBytes)) return true;
    }
    return false;
  }
}

/** Noir backend interface — proving requires the toolchain (see ./noir.ts). */
export class NoirBackend implements ProofBackend {
  id = "noir" as const;
  supports(compiled: CompiledComputeIntent): boolean {
    return isSmallArithmeticPolicy(compiled.ast);
  }
  async prove(): Promise<ProofEnvelope> {
    throw new Error(
      "SEFI_NOIR_NOT_AVAILABLE: Noir proving requires nargo+bb; run with REQUIRE_NOIR=1 on a configured machine",
    );
  }
  async verifyLocal(): Promise<boolean> {
    throw new Error("SEFI_NOIR_NOT_AVAILABLE: Noir verification not available");
  }
}

/** RISC Zero backend — interface only for Phase 2 (spec §11). */
export class Risc0Backend implements ProofBackend {
  id = "risc0" as const;
  supports(): boolean {
    return false;
  }
  async prove(): Promise<ProofEnvelope> {
    throw new Error("SEFI_RISC0_NOT_SUPPORTED: risc0 backend is interface-only in Phase 2");
  }
  async verifyLocal(): Promise<boolean> {
    throw new Error("SEFI_RISC0_NOT_SUPPORTED");
  }
}

export const PREBUILT_RECIPES = [
  "blend-utilization-policy",
  "aquarius-route-policy",
  "sdex-exit-policy",
  "composite-borrow-exit-policy",
];

export function isPrebuiltRecipe(name: string): boolean {
  return PREBUILT_RECIPES.includes(name);
}

/** Small arithmetic policy = bounded statements, no loops (spec §11). */
export function isSmallArithmeticPolicy(ast: CompiledComputeIntent["ast"]): boolean {
  return ast.statements.length <= 16;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
