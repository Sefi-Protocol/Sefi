/**
 * Tokenizer for the ComputeIntent DSL (spec §5). Intentionally tiny: it only
 * recognises the allowed token classes and rejects anything else (no strings,
 * no JS keywords, no member-call syntax beyond the four named reducers). There
 * is no eval / Function anywhere in this package.
 */

export type TokenType =
  | "number"
  | "ident" // bare identifier or dotted path segment chain
  | "op"
  | "lparen"
  | "rparen"
  | "comma"
  | "semicolon"
  | "assign"
  | "eof";

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const MULTI_OPS = ["<=", ">=", "==", "!=", "&&", "||"];
const SINGLE_OPS = ["+", "-", "*", "/", "<", ">", "!"];

export class TokenizeError extends Error {
  constructor(message: string) {
    super(`SEFI_COMPUTE_PARSE_ERROR: ${message}`);
    this.name = "TokenizeError";
  }
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
  const isIdentPart = (c: string) => /[A-Za-z0-9_.]/.test(c);
  const isDigit = (c: string) => /[0-9]/.test(c);

  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    // Reject comments / blocks / strings outright (forbidden syntax §5).
    if (c === '"' || c === "'" || c === "`") {
      throw new TokenizeError(`string literals are not allowed at ${i}`);
    }
    if (c === "{" || c === "}" || c === "[" || c === "]") {
      throw new TokenizeError(`'${c}' is not allowed at ${i}`);
    }
    if (c === "=" && src[i + 1] !== "=") {
      tokens.push({ type: "assign", value: "=", pos: i });
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ type: "lparen", value: "(", pos: i });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "rparen", value: ")", pos: i });
      i++;
      continue;
    }
    if (c === ",") {
      tokens.push({ type: "comma", value: ",", pos: i });
      i++;
      continue;
    }
    if (c === ";") {
      tokens.push({ type: "semicolon", value: ";", pos: i });
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (MULTI_OPS.includes(two)) {
      tokens.push({ type: "op", value: two, pos: i });
      i += 2;
      continue;
    }
    if (SINGLE_OPS.includes(c)) {
      tokens.push({ type: "op", value: c, pos: i });
      i++;
      continue;
    }
    if (isDigit(c)) {
      let j = i + 1;
      let dots = 0;
      while (j < n && (isDigit(src[j]) || src[j] === ".")) {
        if (src[j] === ".") dots++;
        j++;
      }
      if (dots > 1) throw new TokenizeError(`malformed number at ${i}`);
      tokens.push({ type: "number", value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      const value = src.slice(i, j);
      if (value.endsWith(".") || value.includes(".."))
        throw new TokenizeError(`malformed identifier "${value}"`);
      tokens.push({ type: "ident", value, pos: i });
      i = j;
      continue;
    }
    throw new TokenizeError(`unexpected character '${c}' at ${i}`);
  }
  tokens.push({ type: "eof", value: "", pos: n });
  return tokens;
}
