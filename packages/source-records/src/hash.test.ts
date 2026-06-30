import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stableStringify,
  sha256Hex,
  hashResponse,
  merkleRoot,
} from "./hash.js";

test("stableStringify is key-order independent", () => {
  assert.equal(
    stableStringify({ b: 1, a: 2 }),
    stableStringify({ a: 2, b: 1 }),
  );
});

test("hashResponse is deterministic and prefixed", () => {
  const h1 = hashResponse({ x: [1, 2], y: "z" });
  const h2 = hashResponse({ y: "z", x: [1, 2] });
  assert.equal(h1, h2);
  assert.match(h1, /^0x[0-9a-f]{64}$/);
});

test("sha256Hex matches known vector", () => {
  // sha256("") = e3b0c442...
  assert.equal(
    sha256Hex(""),
    "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("merkleRoot is order-independent and stable", () => {
  const a = ["0x01", "0x02", "0x03"];
  const b = ["0x03", "0x01", "0x02"];
  assert.equal(merkleRoot(a), merkleRoot(b));
});

test("merkleRoot of single leaf differs from empty", () => {
  assert.notEqual(merkleRoot(["0xaa"]), merkleRoot([]));
});
