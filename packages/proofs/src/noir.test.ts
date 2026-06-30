import { test } from "node:test";
import assert from "node:assert/strict";
import { detectNoirToolchain, NOIR_TEMPLATES } from "./noir.js";

test("noir toolchain detection runs (skips integration when absent)", async () => {
  const tc = await detectNoirToolchain();
  assert.equal(typeof tc.nargo, "boolean");
  assert.equal(typeof tc.bb, "boolean");
  if (process.env.REQUIRE_NOIR === "1") {
    assert.ok(tc.nargo && tc.bb, "REQUIRE_NOIR=1 but nargo/bb not found");
  } else if (!tc.nargo) {
    // Integration skipped — this is expected without the toolchain.
    console.log("[noir] toolchain not installed; integration proof tests skipped");
  }
});

test("every recipe has a Noir template mapping", () => {
  for (const name of [
    "blend-utilization-policy",
    "aquarius-route-policy",
    "sdex-exit-policy",
    "composite-borrow-exit-policy",
  ]) {
    assert.ok(NOIR_TEMPLATES[name], `template for ${name}`);
  }
});
