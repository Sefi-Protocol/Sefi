import type { AssignmentNode, ExprNode, ExpressionAst } from "@sefi/shared-types";
import { tokenize, type Token } from "./tokenizer.js";

/**
 * Pratt parser for the ComputeIntent DSL (spec §5). Produces the AST defined in
 * shared-types. Pure: no eval/Function. Rejects loops, imports, member calls,
 * undeclared constructs — anything not expressible by the grammar fails to
 * tokenize or parse.
 */

export class ParseError extends Error {
  constructor(message: string) {
    super(`SEFI_COMPUTE_PARSE_ERROR: ${message}`);
    this.name = "ParseError";
  }
}

const RESERVED = new Set([
  "for", "while", "do", "function", "fn", "return", "import", "export",
  "require", "eval", "console", "let", "const", "var", "if", "else", "class",
  "new", "this", "await", "async", "yield",
]);
const REDUCERS = new Set(["max", "min", "any", "all"]);

// Binary operator precedence (higher binds tighter).
const PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3, "!=": 3,
  "<": 4, "<=": 4, ">": 4, ">=": 4,
  "+": 5, "-": 5,
  "*": 6, "/": 6,
};

export function parseCompute(src: string): ExpressionAst {
  const tokens = tokenize(src);
  const parser = new Parser(tokens);
  const statements = parser.parseProgram();
  return { type: "program", statements };
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private expect(type: Token["type"], value?: string): Token {
    const t = this.peek();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new ParseError(`expected ${value ?? type} but got "${t.value || t.type}" at ${t.pos}`);
    }
    return this.next();
  }

  parseProgram(): AssignmentNode[] {
    const out: AssignmentNode[] = [];
    while (this.peek().type !== "eof") {
      out.push(this.parseAssignment());
    }
    if (out.length === 0) throw new ParseError("empty program");
    return out;
  }

  private parseAssignment(): AssignmentNode {
    const nameTok = this.expect("ident");
    const name = nameTok.value;
    if (name.includes("."))
      throw new ParseError(`assignment target must be a simple name, got "${name}"`);
    if (RESERVED.has(name))
      throw new ParseError(`"${name}" is a reserved word`);
    if (name.startsWith("private"))
      throw new ParseError(`cannot assign to a private input ("${name}")`);
    this.expect("assign");
    const expr = this.parseExpr(0);
    this.expect("semicolon");
    return { type: "assignment", name, expr };
  }

  private parseExpr(minPrec: number): ExprNode {
    let left = this.parseUnary();
    while (true) {
      const t = this.peek();
      if (t.type !== "op" || !(t.value in PRECEDENCE)) break;
      const prec = PRECEDENCE[t.value];
      if (prec < minPrec) break;
      this.next();
      const right = this.parseExpr(prec + 1);
      left = { type: "binary", op: t.value as any, left, right };
    }
    return left;
  }

  private parseUnary(): ExprNode {
    const t = this.peek();
    if (t.type === "op" && (t.value === "!" || t.value === "-")) {
      this.next();
      return { type: "unary", op: t.value as "!" | "-", expr: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    const t = this.peek();
    if (t.type === "lparen") {
      this.next();
      const e = this.parseExpr(0);
      this.expect("rparen");
      return e;
    }
    if (t.type === "number") {
      this.next();
      return { type: "literal", value: t.value };
    }
    if (t.type === "ident") {
      // reducer call?
      if (REDUCERS.has(t.value) && this.tokens[this.pos + 1]?.type === "lparen") {
        this.next();
        this.expect("lparen");
        const args: ExprNode[] = [];
        if (this.peek().type !== "rparen") {
          args.push(this.parseExpr(0));
          while (this.peek().type === "comma") {
            this.next();
            args.push(this.parseExpr(0));
          }
        }
        this.expect("rparen");
        if (args.length < 2)
          throw new ParseError(`${t.value}() requires at least 2 arguments`);
        return { type: "call", fn: t.value as any, args };
      }
      // a bare reducer name without parens, or any '(' following a non-reducer ident = forbidden call
      if (this.tokens[this.pos + 1]?.type === "lparen")
        throw new ParseError(`unknown function call "${t.value}"`);
      this.next();
      return this.identToNode(t.value);
    }
    throw new ParseError(`unexpected token "${t.value || t.type}" at ${t.pos}`);
  }

  private identToNode(raw: string): ExprNode {
    if (raw === "true") return { type: "literal", value: true };
    if (raw === "false") return { type: "literal", value: false };
    if (RESERVED.has(raw)) throw new ParseError(`"${raw}" is not allowed`);
    const parts = raw.split(".");
    if (parts[0] === "private") {
      if (parts.length !== 2)
        throw new ParseError(`private inputs must be private.<name>, got "${raw}"`);
      return { type: "private", name: parts[1] };
    }
    // SCALE is a built-in constant identifier.
    if (raw === "SCALE") return { type: "identifier", name: "SCALE" };
    if (parts.length > 1) {
      // dotted fact path: blend.reserve.USDC.totalBorrowed
      return { type: "fact", path: parts };
    }
    // simple identifier — a previously-assigned variable
    return { type: "identifier", name: raw };
  }
}
