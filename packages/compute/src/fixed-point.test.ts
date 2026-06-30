import { test } from "node:test";
import assert from "node:assert/strict";
import { toFixed1e6, fromFixed1e6, normalizePrivateInput, ComputeTypeError } from "./normalize.js";

test("toFixed1e6 scales decimals (audit Part D)", () => {
  assert.equal(toFixed1e6("0.82"), 820000n);
  assert.equal(toFixed1e6("1.25"), 1250000n);
  assert.equal(toFixed1e6("1"), 1000000n);
  assert.equal(toFixed1e6("0"), 0n);
  assert.equal(toFixed1e6("0.000001"), 1n);
});

test("fromFixed1e6 round-trips", () => {
  assert.equal(fromFixed1e6(820000n), "0.82");
  assert.equal(fromFixed1e6(1250000n), "1.25");
  assert.equal(fromFixed1e6(1000000n), "1");
});

test("fixed_1e6 private input accepts decimals", () => {
  assert.equal(normalizePrivateInput("maxUtilization", "0.82", "fixed_1e6"), 820000n);
  assert.equal(normalizePrivateInput("minHealth", "1.25", "fixed_1e6"), 1250000n);
});

test("u128 private input is raw integer (pre-scaled mode)", () => {
  assert.equal(normalizePrivateInput("minReceive", "820000", "u128"), 820000n);
  assert.equal(normalizePrivateInput("minReceive", "99000000", "u128"), 99000000n);
});

test("non-numeric private input fails with a clear error", () => {
  assert.throws(() => normalizePrivateInput("x", "not-a-number", "fixed_1e6"), ComputeTypeError);
  assert.throws(() => normalizePrivateInput("x", "abc", "u128"), ComputeTypeError);
});
