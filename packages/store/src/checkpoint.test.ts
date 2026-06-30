import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "./memory.js";

test("checkpoint saves and resumes (audit Part J §1)", async () => {
  const store = new MemoryStore();
  const id = "blend-event-worker:blend:CPOOL";
  assert.equal(await store.getCheckpoint(id), null);
  await store.saveCheckpoint({
    id, worker: "blend-event-worker", protocol: "blend", contractId: "CPOOL",
    cursor: "cursor-1", latestLedger: 100, updatedAt: "2026-06-30T00:00:00Z",
  });
  let cp = await store.getCheckpoint(id);
  assert.equal(cp!.cursor, "cursor-1");
  assert.equal(cp!.latestLedger, 100);
  // Simulate a second poll advancing the cursor.
  await store.saveCheckpoint({ ...cp!, cursor: "cursor-2", latestLedger: 200, updatedAt: "2026-06-30T00:01:00Z" });
  cp = await store.getCheckpoint(id);
  assert.equal(cp!.cursor, "cursor-2");
  assert.equal(cp!.latestLedger, 200);
});
