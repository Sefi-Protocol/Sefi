import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProofEnvelope } from "@sefi/shared-types";
import { buildProofEnvelope } from "./envelope.js";
import type { ProofRequest } from "./backends.js";
import { detectNoirToolchain, NOIR_TEMPLATES } from "./noir.js";
import { buildWitness, witnessToToml, referenceEvaluate } from "./witness.js";

const exec = promisify(execFile);

function nargoBin(): string {
  return process.env.SEFI_NOIR_NARGO_PATH || "nargo";
}
function bbBin(): string {
  return process.env.SEFI_NOIR_BB_PATH || "bb";
}

/** Circuits live in repo `circuits/<template>` (audit Part F). */
function circuitDir(template: string): string {
  // Resolve relative to repo root; SEFI_CIRCUITS_DIR overrides.
  const base = process.env.SEFI_CIRCUITS_DIR || join(process.cwd(), "circuits");
  return join(base, template);
}

export class Bn254NotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Bn254NotAvailableError";
  }
}

/**
 * Generate a real BN254/UltraHonk proof for a named recipe. Writes a Prover.toml
 * with the witness (public roots + private fact values + private thresholds +
 * Merkle paths), runs `nargo execute` then `bb prove`, and embeds the proof
 * bytes + verification key in the envelope. Private values live only in the temp
 * Prover.toml (deleted) and never enter the envelope.
 */
export async function proveBn254(input: ProofRequest): Promise<ProofEnvelope> {
  const tc = await detectNoirToolchain();
  if (!tc.nargo || !tc.bb) {
    throw new Bn254NotAvailableError(
      "SEFI_BN254_TOOLCHAIN_MISSING: nargo and bb are required for bn254-noir proving. " +
        "Install Noir (noirup) + Barretenberg (bbup), or run with a non-bn254 backend. " +
        "This backend never silently falls back.",
    );
  }
  const template = NOIR_TEMPLATES[input.compiled.name];
  if (!template)
    throw new Bn254NotAvailableError(
      `SEFI_BN254_NO_CIRCUIT: no Noir circuit template for recipe "${input.compiled.name}"`,
    );

  const dir = circuitDir(template);
  const work = await mkdtemp(join(tmpdir(), "sefi-bn254-"));
  try {
    // Build the COMPLETE witness (public roots + per-fact value/pathId/adapter/
    // ledger/Merkle path/bits + private thresholds) and write Prover.toml.
    const witness = buildWitness({
      recipe: input.compiled.name,
      compiled: input.compiled,
      capsule: input.capsule,
      facts: input.facts,
      evaluation: input.evaluation,
      privateInputs: input.privateInputs,
    });
    // Validate the witness against the TS reference circuit before invoking
    // nargo — a complete + correct witness is required for `nargo execute`.
    const ref = referenceEvaluate(input.compiled.name, witness.facts, witness.thresholds, {
      zkContextRoot: witness.public.zkContextRoot,
      zkFactsRoot: witness.public.zkFactsRoot,
      sourceRoot: witness.public.sourceRoot,
      adapterSetHash: witness.public.adapterSetHash,
    });
    if (!ref.contextRootOk || !ref.merkleOk)
      throw new Bn254NotAvailableError(
        `SEFI_BN254_WITNESS_INVALID: contextRootOk=${ref.contextRootOk} merkleOk=${ref.merkleOk}`,
      );
    await writeFile(join(dir, "Prover.toml"), witnessToToml(witness), "utf8");

    // 1) execute -> witness
    await exec(nargoBin(), ["execute", "witness"], { cwd: dir, timeout: 120_000 });
    // 2) bb prove -> proof + vk
    const proofPath = join(work, "proof");
    const vkPath = join(work, "vk");
    await exec(
      bbBin(),
      ["prove", "-b", join(dir, "target", `${template}.json`), "-w", join(dir, "target", "witness.gz"), "-o", proofPath],
      { cwd: dir, timeout: 300_000 },
    );
    await exec(
      bbBin(),
      ["write_vk", "-b", join(dir, "target", `${template}.json`), "-o", vkPath],
      { cwd: dir, timeout: 300_000 },
    );

    const proofBytes = (await readFile(proofPath)).toString("base64");
    const vkBytes = (await readFile(vkPath)).toString("base64");

    const envelope = buildProofEnvelope({
      backend: "bn254-noir",
      compiled: input.compiled,
      evaluation: input.evaluation,
      proofBytes,
    });
    // Stash the VK alongside the proof (verifier needs it). Keep it out of public inputs.
    (envelope as any).verificationKey = vkBytes;
    return envelope;
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(join(dir, "Prover.toml"), { force: true });
  }
}

/** Verify a BN254 proof locally with `bb verify`. */
export async function verifyBn254Local(envelope: ProofEnvelope): Promise<boolean> {
  const tc = await detectNoirToolchain();
  if (!tc.bb)
    throw new Bn254NotAvailableError("SEFI_BN254_TOOLCHAIN_MISSING: bb required to verify bn254-noir proofs");
  const vk = (envelope as any).verificationKey as string | undefined;
  if (!vk || !envelope.proofBytes) return false;
  const work = await mkdtemp(join(tmpdir(), "sefi-bn254-verify-"));
  try {
    const proofPath = join(work, "proof");
    const vkPath = join(work, "vk");
    await writeFile(proofPath, Buffer.from(envelope.proofBytes, "base64"));
    await writeFile(vkPath, Buffer.from(vk, "base64"));
    await exec(bbBin(), ["verify", "-k", vkPath, "-p", proofPath], { cwd: work, timeout: 120_000 });
    return true;
  } catch {
    return false;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

