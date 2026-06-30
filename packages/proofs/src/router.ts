import type {
  CompiledComputeIntent,
  ComputeIntent,
  ProofBackendId,
} from "@sefi/shared-types";
import {
  Bn254Groth16Backend,
  Bn254NoirBackend,
  LocalDevBackend,
  NoirBackend,
  PrebuiltBackend,
  Risc0Backend,
  isPrebuiltRecipe,
  isSmallArithmeticPolicy,
  type ProofBackend,
} from "./backends.js";

const REGISTRY: Record<ProofBackendId, () => ProofBackend> = {
  "local-dev": () => new LocalDevBackend(),
  prebuilt: () => new PrebuiltBackend(),
  noir: () => new NoirBackend(),
  "bn254-noir": () => new Bn254NoirBackend(),
  "bn254-groth16": () => new Bn254Groth16Backend(),
  risc0: () => new Risc0Backend(),
};

export function getBackend(id: ProofBackendId): ProofBackend {
  return REGISTRY[id]();
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export class BackendPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendPolicyError";
  }
}

/**
 * Select a concrete backend id for an intent (audit Part H routing rules).
 *
 *  - Explicit backend is honored (subject to policy gates in resolveBackend).
 *  - `auto`:
 *      * prebuilt only if SEFI_ALLOW_PREBUILT_PROOFS=1 (for tests)
 *      * otherwise bn254-noir for named recipes by default
 *      * local-dev only if SEFI_ALLOW_LOCAL_DEV_PROOFS=1
 *  - Production must never auto-fall-back to local-dev or prebuilt.
 */
export function selectBackend(
  intent: ComputeIntent,
  compiled: CompiledComputeIntent,
): ProofBackendId {
  if (intent.proof.backend !== "auto") return intent.proof.backend;

  const allowPrebuilt = process.env.SEFI_ALLOW_PREBUILT_PROOFS === "1";
  const allowLocalDev = process.env.SEFI_ALLOW_LOCAL_DEV_PROOFS === "1";

  if (isPrebuiltRecipe(intent.name)) {
    if (allowPrebuilt) return "prebuilt";
    // bn254-groth16 is the default real path for named recipes: it produces a
    // genuine Groth16 proof of the actual ComputeIntent that verifies on the
    // Soroban BN254 verifier (stellar_verified). bn254-noir remains available
    // via explicit backend selection for the UltraHonk path.
    return "bn254-groth16";
  }
  if (isSmallArithmeticPolicy(compiled.ast)) {
    if (allowLocalDev && !isProduction()) return "local-dev";
    return "bn254-groth16";
  }
  return "risc0";
}

/**
 * Resolve the backend instance to run, enforcing the Part H policy gates.
 * Throws BackendPolicyError rather than silently downgrading.
 */
export function resolveBackend(
  intent: ComputeIntent,
  compiled: CompiledComputeIntent,
): ProofBackend {
  const chosen = selectBackend(intent, compiled);

  if (isProduction()) {
    if (chosen === "local-dev" && process.env.SEFI_ALLOW_LOCAL_DEV_PROOFS !== "1")
      throw new BackendPolicyError(
        "SEFI_BACKEND_BLOCKED: local-dev proofs are blocked in production (set SEFI_ALLOW_LOCAL_DEV_PROOFS=1 to override)",
      );
    if (chosen === "prebuilt" && process.env.SEFI_ALLOW_PREBUILT_PROOFS !== "1")
      throw new BackendPolicyError(
        "SEFI_BACKEND_BLOCKED: prebuilt proofs are blocked in production (set SEFI_ALLOW_PREBUILT_PROOFS=1 to override)",
      );
  }

  return getBackend(chosen);
}

/** Whether a verifier contract is configured for on-chain verification (Part H §2). */
export function isStellarVerifierConfigured(): boolean {
  return Boolean(process.env.SEFI_VERIFIER_CONTRACT_ID && process.env.SEFI_REGISTRY_CONTRACT_ID);
}
