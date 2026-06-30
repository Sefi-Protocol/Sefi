import type { FactBinding, SefiScalarType, SemanticFact } from "@sefi/shared-types";

/** Fixed-point scale (spec §7): ratios are represented as integers * 1e6. */
export const SCALE = 1_000_000n;

export class ComputeTypeError extends Error {
  constructor(message: string) {
    super(`SEFI_COMPUTE_TYPE_ERROR: ${message}`);
    this.name = "ComputeTypeError";
  }
}

/** Parse a decimal/integer string or number into 1e6 fixed-point bigint. */
export function toFixed1e6(value: string | number): bigint {
  const s = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new ComputeTypeError(`not a number: ${s}`);
  const neg = s.startsWith("-");
  const [intPart, fracPart = ""] = s.replace("-", "").split(".");
  const frac = (fracPart + "000000").slice(0, 6);
  const scaled = BigInt(intPart) * SCALE + BigInt(frac || "0");
  return neg ? -scaled : scaled;
}

export function fromFixed1e6(value: bigint): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const intPart = v / SCALE;
  const frac = (v % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${intPart}${frac ? "." + frac : ""}`;
}

/** Integer string (no scaling) → bigint, rejecting non-finite. */
function toIntBig(value: string | number, label: string): bigint {
  const s = String(value).trim();
  if (s === "Infinity" || s === "-Infinity" || s === "NaN")
    throw new ComputeTypeError(`${label} is non-finite (${s}); not allowed in witnesses`);
  if (/^-?\d+$/.test(s)) return BigInt(s);
  if (/^-?\d+\.\d+$/.test(s)) return BigInt(s.split(".")[0]); // floor decimals to integer units
  throw new ComputeTypeError(`${label} is not an integer: ${s}`);
}

function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const s = String(value).toLowerCase();
  // Enum freshness conversion (spec §7): fresh=true, stale/unknown=false.
  if (s === "fresh" || s === "true") return true;
  if (s === "stale" || s === "unknown" || s === "false") return false;
  return Boolean(value);
}

/**
 * Normalize a semantic fact value into a deterministic numeric/boolean per the
 * binding's declared type (spec §7). Returns bigint for numeric types, boolean
 * for bool. Internally numbers are 1e6 fixed-point bigints.
 */
export function normalizeFactValue(
  binding: FactBinding,
  fact: SemanticFact,
): bigint | boolean {
  const v = fact.value;
  switch (binding.valueType) {
    case "bool":
      // route.available special-case: anything !== false is true (spec §6).
      if (binding.field === "route.available") return v !== false;
      return toBool(v);
    case "fixed_1e6":
      if (typeof v === "boolean") return v ? SCALE : 0n;
      return toFixed1e6(v as string | number);
    case "u64":
    case "u128":
    case "i128":
      return toIntBig(v as string | number, `${binding.variable}`);
    default:
      throw new ComputeTypeError(`unsupported value type ${binding.valueType}`);
  }
}

/**
 * Normalize a private input per its declared scalar type (audit Part D).
 *
 * Disambiguation rule (no guessing):
 *  - `fixed_1e6` values are DECIMAL ratios and are scaled by 1e6:
 *      "0.82" -> 820000, "1.25" -> 1250000, "1" -> 1000000.
 *    This matches the whitepaper examples and keeps them in the same 1e6 domain
 *    as the fixed-point facts they are compared against.
 *  - `u64` / `u128` / `i128` values are RAW integers, never scaled:
 *      "820000" -> 820000. Use these for pre-scaled or count/amount inputs.
 *  - `bool` accepts true/false.
 * Non-numeric values throw a clear ComputeTypeError.
 */
export function normalizePrivateInput(
  name: string,
  value: unknown,
  expected: SefiScalarType,
): bigint | boolean {
  switch (expected) {
    case "bool":
      return toBool(value);
    case "fixed_1e6":
      return toFixed1e6(value as string | number);
    case "u64":
    case "u128":
    case "i128":
      return toIntBig(value as string | number, `private.${name}`);
    default:
      throw new ComputeTypeError(`unsupported private input type ${expected}`);
  }
}
