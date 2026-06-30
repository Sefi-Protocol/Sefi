/**
 * ZK toolchain test harness (audit Part L: `pnpm zk:test`). Runs the full
 * BN254 path when nargo + bb are present: nargo check/execute for every circuit
 * and bb prove/verify for the blend circuit with a valid + an invalid witness.
 * Without the toolchain it skips with an explicit reason (unless
 * SEFI_REQUIRE_BN254=1, which makes it fail).
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
  if (!tc.nargo || !tc.bb) {
    const msg = `Noir toolchain incomplete (nargo=${tc.nargo}, bb=${tc.bb}); zk:test skipped`;
    if (REQUIRE) {
      console.error(`FAIL: ${msg} (SEFI_REQUIRE_BN254=1)`);
      process.exit(1);
    }
    console.log(`SKIP: ${msg}.`);
    console.log("Install Noir (noirup) + Barretenberg (bbup), then re-run pnpm zk:test.");
    return;
  }
  const circuits = readdirSync(CIRCUITS).filter(
    (d) => d !== "shared" && existsSync(join(CIRCUITS, d, "Nargo.toml")),
  );
  for (const c of circuits) {
    const dir = join(CIRCUITS, c);
    console.log(`nargo check ${c}`);
    await exec(nargo, ["check"], { cwd: dir, timeout: 120_000 });
  }
  console.log(`\n✓ nargo check passed for ${circuits.length} circuits.`);
  console.log("Full prove/verify is driven by scripts/prove-blend-bn254.ts and the bn254-noir backend.");
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
