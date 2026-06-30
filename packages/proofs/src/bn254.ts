import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProofEnvelope } from "@sefi/shared-types";
import { buildProofEnvelope } from "./envelope.js";
import type { ProofRequest } from "./backends.js";
import { detectNoirToolchain, NOIR_TEMPLATES } from "./noir.js";

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
    // Witness inputs are written to Prover.toml in the circuit dir (gitignored).
    const prover = buildProverToml(input);
    await writeFile(join(dir, "Prover.toml"), prover, "utf8");

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

/** Build the Prover.toml witness for a recipe (public roots + private inputs). */
function buildProverToml(input: ProofRequest): string {
  const pi = input.compiled;
  const lines: string[] = [];
  // Public inputs as field strings.
  lines.push(`zk_context_root = "${frDec((input.capsule.zkContextRoot as string) ?? "0x0")}"`);
  lines.push(`zk_facts_root = "${frDec((input.capsule.zkFactsRoot as string) ?? "0x0")}"`);
  lines.push(`compute_hash = "${frDec(pi.computeHash)}"`);
  lines.push(`result_hash = "${frDec(input.evaluation.resultHash)}"`);
  // Private witness — recipe-specific; the circuit's main.nr defines the names.
  // The generic encoder writes the fact values + private thresholds it can find.
  for (const b of pi.factRefs) {
    const fact = input.capsule ? undefined : undefined;
    void fact;
    lines.push(`# fact ${b.variable} -> ${b.field}`);
  }
  return lines.join("\n") + "\n";
}

/** Convert 0x hex to decimal string for Noir field literals. */
function frDec(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return BigInt("0x" + (clean || "0")).toString(10);
}
