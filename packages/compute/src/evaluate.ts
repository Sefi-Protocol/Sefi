import type {
  CompiledComputeIntent,
  ComputeEvaluation,
  ExprNode,
  FactBinding,
  HexString,
  SemanticFact,
} from "@sefi/shared-types";
import { sha256Hex, stableStringify } from "@sefi/source-records";
import { checkFreshness } from "@sefi/semantic-core";
import { SCALE, normalizeFactValue, normalizePrivateInput, ComputeTypeError } from "./normalize.js";

export class ComputeEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputeEvalError";
  }
}

type Value = bigint | boolean;

function asBig(v: Value): bigint {
  if (typeof v === "boolean") return v ? 1n : 0n;
  return v;
}
function asBool(v: Value): boolean {
  if (typeof v === "boolean") return v;
  return v !== 0n;
}

export interface EvaluateOptions {
  /** Reject facts older than this many seconds (spec §9 / §20). */
  maxAgeSeconds?: number;
  nowMs?: number;
}

/**
 * Deterministic interpreter (spec §9). Reference implementation for tests and
 * proof-witness generation. Resolves fact bindings only from the supplied
 * capsule facts, evaluates the AST in integer/boolean domain, and returns ONLY
 * the revealed outputs. Never logs or returns private values.
 */
export function evaluateCompute(
  compiled: CompiledComputeIntent,
  privateInputs: Record<string, unknown>,
  facts: SemanticFact[],
  options: EvaluateOptions = {},
): ComputeEvaluation {
  // Freshness gate.
  if (options.maxAgeSeconds !== undefined) {
    const usedFields = new Set(compiled.factRefs.map((r) => r.field));
    const usedFacts = facts.filter((f) => usedFields.has(f.field));
    const policy: Record<string, number> = {};
    for (const f of usedFacts) policy[f.field] = options.maxAgeSeconds;
    const fresh = checkFreshness(usedFacts, policy, options.nowMs);
    if (fresh.staleFields.length)
      throw new ComputeEvalError(
        `SEFI_COMPUTE_STALE_CONTEXT: ${fresh.warnings.join("; ")}`,
      );
  }

  // Resolve fact values keyed by their dotted variable path.
  const factByVar = new Map<string, FactBinding>();
  for (const b of compiled.factRefs) factByVar.set(b.variable, b);
  const factValues = new Map<string, Value>();
  const hiddenUsed: string[] = [];

  for (const b of compiled.factRefs) {
    const fact = facts.find((f) => f.id === b.factId);
    if (!fact)
      throw new ComputeEvalError(
        `SEFI_COMPUTE_FACT_NOT_FOUND: ${b.variable} (${b.factId}) not in capsule`,
      );
    factValues.set(b.variable, normalizeFactValue(b, fact));
  }

  // Normalize private inputs by their inferred schema type.
  const privValues = new Map<string, Value>();
  for (const [name, type] of Object.entries(compiled.privateInputSchema)) {
    if (!(name in privateInputs))
      throw new ComputeEvalError(`SEFI_COMPUTE_MISSING_PRIVATE: private.${name}`);
    privValues.set(name, normalizePrivateInput(name, privateInputs[name], type));
    if (compiled.hide.includes(name)) hiddenUsed.push(name);
  }

  const vars = new Map<string, Value>();

  const evalNode = (n: ExprNode): Value => {
    switch (n.type) {
      case "literal": {
        if (typeof n.value === "boolean") return n.value;
        const s = String(n.value);
        // Decimal literal -> floor to integer (DSL constants are integers/ratios already scaled).
        return s.includes(".") ? BigInt(s.split(".")[0]) : BigInt(s);
      }
      case "identifier":
        if (n.name === "SCALE") return SCALE;
        if (vars.has(n.name)) return vars.get(n.name)!;
        throw new ComputeEvalError(`SEFI_COMPUTE_UNDEFINED_VAR: ${n.name}`);
      case "fact": {
        const key = n.path.join(".");
        if (!factValues.has(key))
          throw new ComputeEvalError(`SEFI_COMPUTE_FACT_NOT_FOUND: ${key}`);
        return factValues.get(key)!;
      }
      case "private": {
        if (!privValues.has(n.name))
          throw new ComputeEvalError(`SEFI_COMPUTE_MISSING_PRIVATE: private.${n.name}`);
        return privValues.get(n.name)!;
      }
      case "unary": {
        const v = evalNode(n.expr);
        if (n.op === "!") return !asBool(v);
        return -asBig(v);
      }
      case "call": {
        const args = n.args.map(evalNode);
        switch (n.fn) {
          case "max":
            return args.map(asBig).reduce((a, b) => (a > b ? a : b));
          case "min":
            return args.map(asBig).reduce((a, b) => (a < b ? a : b));
          case "any":
            return args.some(asBool);
          case "all":
            return args.every(asBool);
        }
        break;
      }
      case "binary": {
        const op = n.op;
        if (op === "&&") return asBool(evalNode(n.left)) && asBool(evalNode(n.right));
        if (op === "||") return asBool(evalNode(n.left)) || asBool(evalNode(n.right));
        const l = asBig(evalNode(n.left));
        const r = asBig(evalNode(n.right));
        switch (op) {
          case "+": return l + r;
          case "-": return l - r;
          case "*": return l * r;
          case "/":
            if (r === 0n) throw new ComputeEvalError("SEFI_COMPUTE_DIV_ZERO");
            return l / r;
          case "<": return l < r;
          case "<=": return l <= r;
          case ">": return l > r;
          case ">=": return l >= r;
          case "==": return l === r;
          case "!=": return l !== r;
        }
      }
    }
    throw new ComputeEvalError("SEFI_COMPUTE_BAD_NODE");
  };

  const outputs: Record<string, string | boolean> = {};
  for (const stmt of compiled.ast.statements) {
    const v = evalNode(stmt.expr);
    vars.set(stmt.name, v);
    outputs[stmt.name] = typeof v === "boolean" ? v : v.toString();
  }

  // Revealed outputs only (spec §9: reject hidden in reveal already at compile).
  const revealed: Record<string, string | number | boolean> = {};
  for (const name of compiled.reveal) {
    if (!(name in outputs))
      throw new ComputeEvalError(`SEFI_COMPUTE_REVEAL_MISSING: ${name} was not produced`);
    revealed[name] = outputs[name];
  }

  const resultHash = sha256Hex(
    stableStringify({
      schemaVersion: "sefi.compute_result.v1",
      reveal: revealed,
    }),
  ) as HexString;

  return {
    outputs,
    revealed,
    hiddenUsed,
    factBindings: compiled.factRefs,
    resultHash,
  };
}
