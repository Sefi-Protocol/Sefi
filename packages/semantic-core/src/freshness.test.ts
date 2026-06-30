import { test } from "node:test";
import assert from "node:assert/strict";
import type { SemanticFact } from "@sefi/shared-types";
import { checkFreshness } from "./freshness.js";

function fact(field: string, ageSeconds: number): SemanticFact {
  return {
    id: "f",
    network: "mainnet",
    protocol: "aquarius",
    entityType: "route",
    entityId: "e",
    field,
    value: "1",
    sourceRecordIds: [],
    rawHash: "0x",
    adapterHash: "0x",
    confidence: "high",
    createdAt: new Date(NOW - ageSeconds * 1000).toISOString(),
  };
}

const NOW = Date.parse("2026-06-30T12:00:00Z");

test("fresh facts produce no warnings", () => {
  const r = checkFreshness([fact("slippage.estimated", 1)], undefined, NOW);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.staleFields.length, 0);
});

test("stale swap estimate warns past 20s", () => {
  const r = checkFreshness([fact("slippage.estimated", 45)], undefined, NOW);
  assert.equal(r.staleFields[0], "slippage.estimated");
  assert.match(r.warnings[0], /older than the 20s/);
});

test("non-freshness-sensitive fields are ignored", () => {
  const r = checkFreshness([fact("pool.fee_bps", 9999)], undefined, NOW);
  assert.equal(r.warnings.length, 0);
});

test("each field warns once and maxAge is tracked", () => {
  const r = checkFreshness(
    [fact("market.spread_bps", 90), fact("market.spread_bps", 120)],
    undefined,
    NOW,
  );
  assert.equal(r.warnings.length, 1);
  assert.equal(Math.round(r.maxAgeSeconds), 120);
});
