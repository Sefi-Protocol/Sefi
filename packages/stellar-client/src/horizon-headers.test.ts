import { test } from "node:test";
import assert from "node:assert/strict";
import { StellarClient } from "./index.js";

/** Mock a fetch Response with a Latest-Ledger header (audit Part J §2). */
function mockFetch(body: unknown, headers: Record<string, string>) {
  return async () =>
    ({
      ok: true,
      headers: new Headers(headers),
      json: async () => body,
    }) as unknown as Response;
}

test("horizonGet extracts the Latest-Ledger header into latestLedger", async () => {
  const client = new StellarClient({ network: "mainnet" });
  (client as any).fetchImpl = mockFetch(
    { bids: [], asks: [] },
    { "Latest-Ledger": "63264999", "content-type": "application/json" },
  );
  const r = await client.horizonGet("order_book", {});
  assert.equal(r.latestLedger, 63264999);
  assert.equal(r.headers?.["latest-ledger"], "63264999");
  // ledger falls back to latestLedger when no last_modified_ledger in body.
  assert.equal(r.ledger, 63264999);
});

test("horizonGet prefers resource last_modified_ledger for ledger, keeps header in latestLedger", async () => {
  const client = new StellarClient({ network: "mainnet" });
  (client as any).fetchImpl = mockFetch(
    { last_modified_ledger: 100, total_shares: "1" },
    { "Latest-Ledger": "63265000" },
  );
  const r = await client.horizonGet("liquidity_pools/abc", {});
  assert.equal(r.ledger, 100);
  assert.equal(r.latestLedger, 63265000);
});
