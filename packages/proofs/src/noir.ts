import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Noir toolchain detection (spec §12.1). Returns whether `nargo` and `bb` are
 * available. Used to decide whether Noir integration tests run or skip. When
 * REQUIRE_NOIR=1, callers should fail if this returns false.
 */
export async function detectNoirToolchain(): Promise<{
  nargo: boolean;
  bb: boolean;
  version?: string;
}> {
  let nargo = false;
  let bb = false;
  let version: string | undefined;
  try {
    const { stdout } = await exec("nargo", ["--version"]);
    nargo = true;
    version = stdout.trim().split("\n")[0];
  } catch {
    nargo = false;
  }
  try {
    await exec("bb", ["--version"]);
    bb = true;
  } catch {
    bb = false;
  }
  return { nargo, bb, version };
}

/** Map a recipe name to its Noir template directory (spec §12.2). */
export const NOIR_TEMPLATES: Record<string, string> = {
  "blend-utilization-policy": "blend_utilization_policy",
  "aquarius-route-policy": "aqua_route_policy",
  "sdex-exit-policy": "sdex_exit_policy",
  "composite-borrow-exit-policy": "composite_borrow_exit_policy",
};
