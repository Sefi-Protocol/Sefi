import { test } from "node:test";
import assert from "node:assert/strict";
import {
  utilization,
  borrowCapacity,
  riskDirection,
  spreadBps,
  slippageBps,
  routeHopsOk,
  constantProductOut,
} from "./compute.js";

test("utilization = borrowed / supplied", () => {
  assert.equal(utilization("840", "1000"), 0.84);
  assert.equal(utilization("10", "0"), 0); // no supply -> 0
});

test("borrowCapacity computes health factor", () => {
  const cap = borrowCapacity(
    [{ value: 100, factor: 0.9 }],
    [{ value: 50, factor: 1 }],
  );
  assert.equal(cap.collateralAdjusted, 90);
  assert.equal(cap.liabilityAdjusted, 50);
  assert.equal(cap.borrowCapacityRemaining, 40);
  assert.equal(cap.healthFactor, 1.8);
});

test("borrowCapacity with no debt is infinite health", () => {
  const cap = borrowCapacity([{ value: 100, factor: 0.9 }], []);
  assert.equal(cap.healthFactor, Infinity);
});

test("riskDirection follows spec table", () => {
  assert.equal(riskDirection("SUPPLY"), "risk_reducing");
  assert.equal(riskDirection("REPAY"), "risk_reducing");
  assert.equal(riskDirection("BORROW"), "risk_increasing");
  assert.equal(riskDirection("WITHDRAW"), "risk_increasing");
  assert.equal(riskDirection("SWAP"), "neutral");
});

test("spreadBps over midpoint", () => {
  // bid 0.0999 ask 0.1001 -> mid 0.1 -> spread 0.0002/0.1 = 0.002 -> 20 bps
  assert.equal(Math.round(spreadBps(0.0999, 0.1001)), 20);
});

test("slippageBps non-negative", () => {
  assert.equal(Math.round(slippageBps(1000, 990)), 100); // 1%
  assert.equal(slippageBps(1000, 1010), 0); // better than ideal -> 0
});

test("routeHopsOk default max 4", () => {
  assert.equal(routeHopsOk(4), true);
  assert.equal(routeHopsOk(5), false);
});

test("constantProductOut respects fee and curve", () => {
  const out = constantProductOut(1000, 1000, 100, 30);
  assert.ok(out > 0 && out < 100); // price impact + fee keep it under naive 100
});
