/**
 * @sefi/shared-types
 *
 * Canonical type vocabulary shared across every Sefi package. These types are
 * the contract between protocol adapters, the semantic core, the store, the
 * SDK, the API and the future proof-of-data / ZK layer.
 *
 * See AGENT_BUILD_SPEC sections 5, 6, 11, 12, 13.
 */

export type Network = "testnet" | "mainnet";

export type Protocol = "blend" | "aquarius" | "stellar_dex" | "stellar_amm";

export type Confidence = "high" | "medium" | "low";

export type Decision = "safe" | "unsafe" | "conditional" | "unknown";

// ---------------------------------------------------------------------------
// Source records (spec §5)
// ---------------------------------------------------------------------------

export type SourceKind =
  | "stellar_rpc_simulate"
  | "stellar_rpc_events"
  | "stellar_rpc_ledger_entries"
  | "horizon_orderbook"
  | "horizon_offers"
  | "horizon_trades"
  | "horizon_paths"
  | "horizon_liquidity_pools"
  | "protocol_api";

export interface SourceRecord {
  id: string;
  network: Network;
  protocol: Protocol;
  sourceKind: SourceKind;
  endpoint?: string;
  contractId?: string;
  functionName?: string;
  argsXdr?: string;
  requestBodyHash: string;
  responseHash: string;
  /** Reference/locator for the raw response (here: same as id; raw stored in DB). */
  rawResponseRef: string;
  /** Inlined raw response so capsules/replay are self-contained. */
  rawResponse?: unknown;
  rawXdr?: string;
  ledgerSeq?: number;
  latestLedger?: number;
  fetchedAt: string;
  adapterName: string;
  adapterVersion: string;
  adapterHash: string;
}

// ---------------------------------------------------------------------------
// Semantic facts (spec §6)
// ---------------------------------------------------------------------------

export type EntityType =
  | "asset"
  | "pool"
  | "reserve"
  | "market"
  | "position"
  | "route"
  | "oracle"
  | "backstop"
  | "reward";

export interface SemanticFact<T = unknown> {
  id: string;
  network: Network;
  protocol: Protocol;
  entityType: EntityType;
  entityId: string;
  field: string;
  value: T;
  unit?: string;
  ledgerSeq?: number;
  sourceRecordIds: string[];
  rawHash: string;
  adapterHash: string;
  confidence: Confidence;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Context capsules (spec §12) and composite context (spec §11)
// ---------------------------------------------------------------------------

export type CapsuleType = "single_protocol" | "multi_protocol";

export interface CapsuleRoots {
  sourceRoot: string;
  factsRoot: string;
  compositeRoot: string;
}

export interface ContextCapsule {
  id: string;
  capsuleType: CapsuleType;
  network: Network;
  protocols: string[];
  sourceRecordIds: string[];
  semanticFactIds: string[];
  sourceRoot: string;
  factsRoot: string;
  adapterSetHash: string;
  compositeRoot: string;
  /** Phase 2 v2 commitments (spec §3). Bind exact fact values to the context. */
  semanticFactsRoot?: string;
  contextRoot?: string;
  ledgerRange?: {
    minLedger?: number;
    maxLedger?: number;
  };
  createdAt: string;
}

export type HexString = `0x${string}`;

// ---------------------------------------------------------------------------
// Phase 2 — ComputeKit / ProofKit (spec §4)
// ---------------------------------------------------------------------------

export type SefiScalarType =
  | "u64"
  | "u128"
  | "i128"
  | "fixed_1e6"
  | "bool"
  | "enum";

export type ProofBackendId = "noir" | "risc0" | "prebuilt" | "local-dev";

export interface ComputeIntent {
  id?: string;
  name: string;
  context: Record<string, unknown>;
  compute: string | ExpressionAst;
  privateInputs: Record<string, string | number | boolean>;
  reveal: string[];
  hide: string[];
  proof: {
    backend: "auto" | ProofBackendId;
    verifyOn: "stellar" | "offchain";
    proveDataUsed: boolean;
  };
  /** Optional freshness policy: reject facts older than this (seconds). */
  maxAgeSeconds?: number;
}

export type ExpressionAst = {
  type: "program";
  statements: AssignmentNode[];
};

export interface AssignmentNode {
  type: "assignment";
  name: string;
  expr: ExprNode;
}

export type ExprNode =
  | { type: "literal"; value: string | number | boolean }
  | { type: "private"; name: string }
  | { type: "fact"; path: string[] }
  | { type: "identifier"; name: string }
  | {
      type: "binary";
      op: "+" | "-" | "*" | "/" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||";
      left: ExprNode;
      right: ExprNode;
    }
  | { type: "unary"; op: "!" | "-"; expr: ExprNode }
  | { type: "call"; fn: "max" | "min" | "any" | "all"; args: ExprNode[] };

export interface MerkleProof {
  leaf: HexString;
  leafIndex: number;
  siblings: HexString[];
  root: HexString;
}

export interface FactBinding {
  variable: string;
  protocol: Protocol;
  entityType: string;
  entitySelector: Record<string, string>;
  field: string;
  valueType: SefiScalarType;
  factId: string;
  factHash: HexString;
  merkleProof?: MerkleProof;
}

export interface CompiledComputeIntent {
  id: string;
  name: string;
  intentHash: HexString;
  computeHash: HexString;
  contextRoot: HexString;
  sourceRoot: HexString;
  semanticFactsRoot: HexString;
  adapterSetHash: HexString;
  ast: ExpressionAst;
  factRefs: FactBinding[];
  privateInputSchema: Record<string, SefiScalarType>;
  reveal: string[];
  hide: string[];
  capsuleId: string;
  createdAt: string;
}

export interface ComputeEvaluation {
  outputs: Record<string, string | boolean>;
  revealed: Record<string, string | number | boolean>;
  hiddenUsed: string[];
  factBindings: FactBinding[];
  resultHash: HexString;
}

export interface ProofPublicInputs {
  contextRoot: HexString;
  sourceRoot: HexString;
  semanticFactsRoot: HexString;
  adapterSetHash: HexString;
  computeHash: HexString;
  resultHash: HexString;
}

export interface ProofEnvelope {
  proofId: string;
  proofType: "compute_intent" | "proof_of_funds" | "allowlist" | "credential";
  backend: ProofBackendId;
  publicInputs: ProofPublicInputs;
  revealed: Record<string, string | number | boolean>;
  proofBytes: string;
  verifierContractId?: string;
  verificationTx?: string;
  status: "created" | "proving" | "verified" | "failed";
  createdAt: string;
}

export interface ProofCard {
  proofId: string;
  proofType: string;
  contextRoot: HexString;
  computeHash: HexString;
  publicResultHash: HexString;
  publicResult: Record<string, string | number | boolean>;
  verifierHash?: HexString;
  timestampLedger?: number;
  result: "verified" | "failed";
  trustModel: "proof-of-data-used" | "proof-of-data-origin";
  verificationMode?: "offchain_local" | "proof_card_commitment_only" | "stellar_verified";
  warnings: string[];
}

export interface ProveResult {
  proofEnvelope: ProofEnvelope;
  proofCard: ProofCard;
  publicInputs: ProofPublicInputs;
}

export interface ProofJob {
  id: string;
  intentId: string;
  backend: ProofBackendId;
  status: "queued" | "running" | "verified" | "failed";
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A protocol adapter's contribution to a composite context: the facts and
 * source records it produced for one request.
 */
export interface ProtocolContext {
  protocol: Protocol;
  network: Network;
  facts: SemanticFact[];
  sourceRecords: SourceRecord[];
  warnings: string[];
}

export interface CompositeContext {
  id: string;
  network: Network;
  protocols: Protocol[];
  facts: SemanticFact[];
  sourceRecords: SourceRecord[];
  roots: CapsuleRoots;
  capsuleId?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Answers (spec §13.5 / §14.5)
// ---------------------------------------------------------------------------

export interface AnswerEvidence {
  fact: string;
  value: unknown;
  sourceRecordId?: string;
}

export interface SefiAnswer {
  text: string;
  confidence: Confidence;
  decision?: Decision;
  recommendedActions: string[];
  facts: SemanticFact[];
  sourceRecords: Pick<
    SourceRecord,
    "id" | "protocol" | "ledgerSeq" | "responseHash"
  >[];
  evidence: AnswerEvidence[];
  contextCapsuleId?: string;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Universal vocabulary constants (spec §6.2 / §6.3)
// ---------------------------------------------------------------------------

export type UniversalAction =
  | "SUPPLY"
  | "WITHDRAW"
  | "BORROW"
  | "REPAY"
  | "SWAP"
  | "ROUTE"
  | "LP_DEPOSIT"
  | "LP_WITHDRAW"
  | "CLAIM_REWARD"
  | "PLACE_OFFER"
  | "CANCEL_OFFER"
  | "PATH_PAYMENT";

export type RiskDirection = "risk_increasing" | "risk_reducing" | "neutral";

export interface SefiConfig {
  network: Network;
  /** When set, the SDK talks to a remote Sefi API instead of running adapters in-process. */
  apiUrl?: string;
  apiKey?: string;
  rpcUrl?: string;
  horizonUrl?: string;
  /** Aquarius router contract id override (required on testnet). */
  aquariusRouter?: string;
  /** Optional LLM key for narrated answers; falls back to deterministic reasoner. */
  llmApiKey?: string;
  llmModel?: string;
}
