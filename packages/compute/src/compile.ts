import { randomUUID } from "node:crypto";
import type {
  CompiledComputeIntent,
  ComputeIntent,
  ContextCapsule,
  ExprNode,
  ExpressionAst,
  FactBinding,
  HexString,
  SefiScalarType,
  SemanticFact,
} from "@sefi/shared-types";
import { sha256Hex, stableStringify } from "@sefi/source-records";
import { factMerkleProof } from "@sefi/context-capsules";
import { parseCompute } from "./parser.js";
import { bindFact } from "./bindings.js";

export class ComputeCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputeCompileError";
  }
}

/** Collect every distinct fact path and private name referenced by the AST. */
function collectRefs(ast: ExpressionAst): {
  factPaths: string[][];
  privates: Set<string>;
  assigned: Set<string>;
} {
  const factPaths: string[][] = [];
  const seen = new Set<string>();
  const privates = new Set<string>();
  const assigned = new Set<string>();
  const walk = (n: ExprNode) => {
    switch (n.type) {
      case "fact": {
        const key = n.path.join(".");
        if (!seen.has(key)) {
          seen.add(key);
          factPaths.push(n.path);
        }
        break;
      }
      case "private":
        privates.add(n.name);
        break;
      case "binary":
        walk(n.left);
        walk(n.right);
        break;
      case "unary":
        walk(n.expr);
        break;
      case "call":
        n.args.forEach(walk);
        break;
      default:
        break;
    }
  };
  for (const stmt of ast.statements) {
    assigned.add(stmt.name);
    walk(stmt.expr);
  }
  return { factPaths, privates, assigned };
}

/** Infer a private input's scalar type from the binary comparisons it appears in. */
function inferPrivateTypes(
  ast: ExpressionAst,
  factTypeByVar: Map<string, SefiScalarType>,
): Record<string, SefiScalarType> {
  const types: Record<string, SefiScalarType> = {};
  const typeOf = (n: ExprNode): SefiScalarType | undefined => {
    if (n.type === "fact") return factTypeByVar.get(n.path.join("."));
    if (n.type === "identifier") return undefined;
    return undefined;
  };
  const walk = (n: ExprNode) => {
    if (n.type === "binary") {
      const pair: Array<[ExprNode, ExprNode]> = [
        [n.left, n.right],
        [n.right, n.left],
      ];
      for (const [a, b] of pair) {
        if (a.type === "private") {
          const t = typeOf(b);
          if (t && !types[a.name]) types[a.name] = t;
        }
      }
      walk(n.left);
      walk(n.right);
    } else if (n.type === "unary") walk(n.expr);
    else if (n.type === "call") n.args.forEach(walk);
  };
  ast.statements.forEach((s) => walk(s.expr));
  return types;
}

export interface CompileInput {
  intent: ComputeIntent;
  capsule: ContextCapsule;
  facts: SemanticFact[];
}

/**
 * Compile a {@link ComputeIntent} against a context capsule (spec §6–§8).
 * Resolves fact bindings (with Merkle proofs), infers the private-input schema,
 * and derives computeHash / intentHash — none of which include private values.
 */
export function compileIntent(input: CompileInput): CompiledComputeIntent {
  const { intent, capsule, facts } = input;
  const ast: ExpressionAst =
    typeof intent.compute === "string" ? parseCompute(intent.compute) : intent.compute;

  // reveal cannot include private.* (spec §20).
  for (const r of intent.reveal) {
    if (r.startsWith("private.") || r.startsWith("private"))
      throw new ComputeCompileError(`SEFI_COMPUTE_REVEAL_PRIVATE: cannot reveal "${r}"`);
  }

  const { factPaths, privates } = collectRefs(ast);

  // Every referenced private must be declared (spec §5: no undeclared privates).
  for (const p of privates) {
    if (!(p in intent.privateInputs))
      throw new ComputeCompileError(`SEFI_COMPUTE_UNDECLARED_PRIVATE: private.${p} not provided`);
  }

  // Bind facts; attach Merkle proofs from the semanticFactsRoot tree.
  const factRefs: FactBinding[] = [];
  const factTypeByVar = new Map<string, SefiScalarType>();
  for (const parts of factPaths) {
    const variable = parts.join(".");
    const { binding, fact } = bindFact(variable, parts, facts, capsule.id);
    const mp = factMerkleProof(facts, fact);
    if (mp)
      binding.merkleProof = {
        leaf: mp.leaf as HexString,
        leafIndex: mp.leafIndex,
        siblings: mp.siblings as HexString[],
        root: mp.root as HexString,
      };
    factRefs.push(binding);
    factTypeByVar.set(variable, binding.valueType);
  }

  // Explicit schema (audit Part D) overrides inference; inference fills gaps.
  const privateInputSchema = inferPrivateTypes(ast, factTypeByVar);
  if (intent.privateInputSchema) {
    for (const [name, type] of Object.entries(intent.privateInputSchema))
      privateInputSchema[name] = type;
  }
  for (const p of privates) if (!privateInputSchema[p]) privateInputSchema[p] = "u128";

  const reveal = [...intent.reveal].sort();
  const hide = [...intent.hide].sort();

  // computeHash excludes any private VALUES (spec §8).
  const computeHash = sha256Hex(
    stableStringify({
      schemaVersion: "sefi.compute.v1",
      name: intent.name,
      ast,
      factRefs: factRefs.map((ref) => ({
        variable: ref.variable,
        protocol: ref.protocol,
        entityType: ref.entityType,
        entitySelector: ref.entitySelector,
        field: ref.field,
        valueType: ref.valueType,
        factHash: ref.factHash,
      })),
      privateInputSchema,
      reveal,
      hide,
    }),
  ) as HexString;

  const contextRoot = (capsule.contextRoot ?? capsule.compositeRoot) as HexString;
  const intentHash = sha256Hex(
    stableStringify({
      schemaVersion: "sefi.compute_intent.v1",
      contextRoot,
      computeHash,
      backend: intent.proof.backend,
      verifyOn: intent.proof.verifyOn,
      proveDataUsed: intent.proof.proveDataUsed,
    }),
  ) as HexString;

  return {
    id: `intent_${randomUUID().slice(0, 12)}`,
    name: intent.name,
    intentHash,
    computeHash,
    contextRoot,
    sourceRoot: capsule.sourceRoot as HexString,
    semanticFactsRoot: (capsule.semanticFactsRoot ?? capsule.factsRoot) as HexString,
    adapterSetHash: capsule.adapterSetHash as HexString,
    zkFactsRoot: capsule.zkFactsRoot as HexString | undefined,
    zkContextRoot: capsule.zkContextRoot as HexString | undefined,
    ast,
    factRefs,
    privateInputSchema,
    reveal,
    hide,
    capsuleId: capsule.id,
    createdAt: new Date().toISOString(),
  };
}
