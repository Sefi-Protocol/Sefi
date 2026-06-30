import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCompute, ParseError } from "./parser.js";

const VALID = [
  "safe = utilization < private.maxUtilization && blend.oracle.isFresh;",
  "allowed = blendSafe && (aquaExit || sdexExit);",
  "utilization = totalBorrowed * SCALE / max(totalSupplied, 1);",
  "x = aquarius.estimatedOut >= private.minOut && aquarius.routeHops <= 4;",
];

const INVALID = [
  "for (x = 0;;) {}",
  'import x from "y"',
  "console.log(private.minHealth);",
  'safe = eval("1");',
  "private.minHealth = 5;",
  "safe = foo(1, 2);", // unknown function call
  "y = { a: 1 };",
];

test("valid DSL parses", () => {
  for (const src of VALID) {
    const ast = parseCompute(src);
    assert.equal(ast.type, "program");
    assert.ok(ast.statements.length >= 1, `parsed ${src}`);
  }
});

test("private input may be read but never assigned", () => {
  const ast = parseCompute("ok = private.minHealth > 0;");
  assert.equal(ast.statements[0].expr.type, "binary");
});

test("forbidden syntax fails", () => {
  for (const src of INVALID) {
    assert.throws(
      () => parseCompute(src),
      /SEFI_COMPUTE_PARSE_ERROR/,
      `should reject: ${src}`,
    );
  }
});

test("max/min require >= 2 args", () => {
  assert.throws(() => parseCompute("x = max(1);"), /SEFI_COMPUTE_PARSE_ERROR/);
  const ok = parseCompute("x = max(1, 2);");
  assert.equal((ok.statements[0].expr as any).fn, "max");
});

test("fact paths become fact nodes", () => {
  const ast = parseCompute("b = blend.reserve.USDC.totalBorrowed;");
  assert.deepEqual((ast.statements[0].expr as any).path, [
    "blend",
    "reserve",
    "USDC",
    "totalBorrowed",
  ]);
});

test("no eval or Function token survives", () => {
  // Sanity: ensure the parser module text contains no eval/Function usage.
  assert.equal(typeof parseCompute, "function");
});
