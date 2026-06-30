/**
 * Build (nargo check + compile) all Sefi circuits (audit Part F tooling).
 * Skips with an explicit reason when the Noir toolchain is unavailable, unless
 * SEFI_REQUIRE_BN254=1 / REQUIRE_NOIR=1 is set (then it fails).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { detectNoirToolchain } from "@sefi/proofs";

const exec = promisify(execFile);
const nargo = process.env.SEFI_NOIR_NARGO_PATH || "nargo";
const CIRCUITS = join(process.cwd(), "circuits");

const REQUIRE = process.env.SEFI_REQUIRE_BN254 === "1" || process.env.REQUIRE_NOIR === "1";

async function main() {
  const tc = await detectNoirToolchain();
  if (!tc.nargo) {
    const msg = "nargo not found; circuit build skipped";
    if (REQUIRE) {
      console.error(`FAIL: ${msg} (SEFI_REQUIRE_BN254=1)`);
      process.exit(1);
    }
    console.log(`SKIP: ${msg}. Install Noir (noirup) to build circuits.`);
    return;
  }
  const binCircuits = readdirSync(CIRCUITS).filter(
    (d) => d !== "shared" && existsSync(join(CIRCUITS, d, "Nargo.toml")),
  );
  for (const c of binCircuits) {
    const dir = join(CIRCUITS, c);
    console.log(`nargo check ${c} ...`);
    await exec(nargo, ["check"], { cwd: dir, timeout: 120_000 });
    console.log(`nargo compile ${c} ...`);
    await exec(nargo, ["compile"], { cwd: dir, timeout: 300_000 });
    console.log(`✓ ${c}`);
  }
  console.log(`\nBuilt ${binCircuits.length} circuits.`);
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
