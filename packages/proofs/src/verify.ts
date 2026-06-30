import type { CompiledComputeIntent, ProofEnvelope } from "@sefi/shared-types";
import { sha256Hex, stableStringify, BN254_FR_MODULUS } from "@sefi/source-records";
import { getBackend } from "./router.js";

const HEX32 = /^0x[0-9a-f]{64}$/;
const BN254_FR = BN254_FR_MODULUS;

export interface VerifyResult {
  valid: boolean;
  reasons: string[];
}

/**
 * Local proof verification (spec §14). Validates envelope schema, hash formats,
 * the backend checksum, and — when the compiled intent is supplied — that the
 * envelope's computeHash and resultHash bind to it. Never returns true merely
 * because the envelope exists.
 */
export async function verifyLocal(
  envelope: ProofEnvelope,
  compiled?: CompiledComputeIntent,
): Promise<VerifyResult> {
  const reasons: string[] = [];
  const pi = envelope.publicInputs;

  if (!pi) reasons.push("missing publicInputs");
  else {
    for (const field of [
      "contextRoot",
      "sourceRoot",
      "semanticFactsRoot",
      "adapterSetHash",
      "computeHash",
      "resultHash",
    ] as const) {
      if (!HEX32.test(String(pi[field] ?? "")))
        reasons.push(`publicInputs.${field} is not a 0x 32-byte hash`);
    }
    // ZK roots are optional but, when present, must be well-formed.
    for (const field of ["zkFactsRoot", "zkContextRoot"] as const) {
      if (pi[field] !== undefined && !HEX32.test(String(pi[field])))
        reasons.push(`publicInputs.${field} is not a 0x 32-byte hash`);
    }
    // bn254-noir proofs MUST carry the ZK roots the circuit binds.
    if (envelope.backend === "bn254-noir" && (!pi.zkFactsRoot || !pi.zkContextRoot))
      reasons.push("bn254-noir envelope is missing zkFactsRoot/zkContextRoot public inputs");
  }

  if (!envelope.proofBytes) reasons.push("missing proofBytes");

  // resultHash must match the revealed result it claims to commit to.
  if (pi) {
    const recomputed = sha256Hex(
      stableStringify({ schemaVersion: "sefi.compute_result.v1", reveal: envelope.revealed }),
    );
    if (recomputed !== pi.resultHash)
      reasons.push("resultHash does not match revealed result");
  }

  // Optional binding to the compiled intent.
  if (compiled && pi) {
    if (compiled.computeHash !== pi.computeHash)
      reasons.push("computeHash does not match compiled intent");
    if (compiled.contextRoot !== pi.contextRoot)
      reasons.push("contextRoot does not match compiled intent");
  }

  // For bn254-groth16, the proof's public signals must match the envelope's
  // committed zk roots + computeHash + resultHash (snarkjs order:
  // [result, zkContextRoot, zkFactsRoot, computeHash, resultHash]). The circuit
  // works over BN254 Fr, so each commitment is the field-reduced (mod r) value.
  if (envelope.backend === "bn254-groth16" && pi) {
    const ps = envelope.groth16?.publicSignals;
    if (!ps || ps.length < 5) reasons.push("bn254-groth16 envelope missing public signals");
    else {
      // Reduce mod BN254 Fr before comparing (sha256 roots/hashes can exceed r).
      const toFr = (hex?: string) => (hex ? (BigInt(hex) % BN254_FR).toString(10) : "");
      if (toFr(pi.zkContextRoot) !== ps[1])
        reasons.push("groth16 public signal zkContextRoot != envelope zkContextRoot");
      if (toFr(pi.zkFactsRoot) !== ps[2])
        reasons.push("groth16 public signal zkFactsRoot != envelope zkFactsRoot");
      if (toFr(pi.computeHash) !== ps[3])
        reasons.push("groth16 public signal computeHash != envelope computeHash");
      if (toFr(pi.resultHash) !== ps[4])
        reasons.push("groth16 public signal resultHash != envelope resultHash");
    }
  }

  // Backend checksum / proof artifact must validate.
  try {
    const backend = getBackend(envelope.backend);
    const ok = await backend.verifyLocal(envelope);
    if (!ok) reasons.push(`${envelope.backend} proof artifact failed verification`);
  } catch (e) {
    reasons.push(`backend verify error: ${(e as Error).message}`);
  }

  return { valid: reasons.length === 0, reasons };
}
