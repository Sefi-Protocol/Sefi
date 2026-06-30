import type {
  CompiledComputeIntent,
  ComputeIntent,
  ProofBackendId,
} from "@sefi/shared-types";
import {
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
  risc0: () => new Risc0Backend(),
};

export function getBackend(id: ProofBackendId): ProofBackend {
  return REGISTRY[id]();
}

/** Select a concrete backend for an intent (spec §11 routing rules). */
export function selectBackend(
  intent: ComputeIntent,
  compiled: CompiledComputeIntent,
): ProofBackendId {
  if (intent.proof.backend !== "auto") return intent.proof.backend;
  if (isPrebuiltRecipe(intent.name)) return "prebuilt";
  if (isSmallArithmeticPolicy(compiled.ast)) return "noir";
  return "risc0";
}

/**
 * Resolve the backend that will actually run. Phase 2 prefers prebuilt for named
 * recipes; if `auto` selects noir but the toolchain is unavailable, fall back to
 * local-dev so the deterministic off-chain path always works (spec §11: do not
 * block the off-chain proof path).
 */
export function resolveBackend(
  intent: ComputeIntent,
  compiled: CompiledComputeIntent,
): ProofBackend {
  const chosen = selectBackend(intent, compiled);
  if (chosen === "noir" || chosen === "risc0") {
    // Off-chain default path: use prebuilt for named recipes else local-dev.
    if (isPrebuiltRecipe(intent.name)) return getBackend("prebuilt");
    return getBackend("local-dev");
  }
  return getBackend(chosen);
}
