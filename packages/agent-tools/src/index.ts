import type { SefiClient } from "@sefi/sdk";

/** Agent system prompt verbatim from spec §14.4. */
export const SEFI_AGENT_SYSTEM_PROMPT = `You are a Stellar DeFi agent powered by Sefi.

Rules:
1. Use Sefi tools for factual claims about Blend, Aquarius, Stellar DEX, or Stellar AMM.
2. Do not invent pool values, APYs, liquidity, slippage, or health metrics.
3. Every recommendation must be tied to semantic facts returned by Sefi.
4. If data is stale, missing, or low-confidence, say so.
5. Explain actions in protocol language: borrow, repay, supply, withdraw, swap, route, LP deposit, LP withdraw.
6. Never claim ZK proof unless a proof object is returned by the proof layer.
7. For now, you can say "source-backed" or "capsule-backed," not "cryptographically proven."`;

export interface AgentToolSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: AgentToolSchema;
  execute: (args: any) => Promise<unknown>;
}

/**
 * Build the Sefi tool set (spec §14.2) bound to a {@link SefiClient}. These
 * schemas are framework-agnostic; helpers below adapt them to Anthropic /
 * OpenAI tool-call formats.
 */
export function createSefiTools(sefi: SefiClient): AgentTool[] {
  return [
    {
      name: "sefi_blend_get_pool_context",
      description:
        "Fetch Blend pool/reserve/oracle/backstop semantic facts for a pool.",
      parameters: {
        type: "object",
        properties: {
          poolId: { type: "string" },
          wallet: { type: "string" },
        },
        required: ["poolId"],
      },
      execute: (a) => sefi.blend().getPoolContext(a),
    },
    {
      name: "sefi_blend_get_user_context",
      description: "Fetch a Blend user's position facts (health, borrow limit).",
      parameters: {
        type: "object",
        properties: {
          poolId: { type: "string" },
          wallet: { type: "string" },
        },
        required: ["poolId", "wallet"],
      },
      execute: (a) => sefi.blend().getUserContext(a),
    },
    {
      name: "sefi_blend_ask",
      description:
        "Answer questions about Blend lending pools, reserves, user positions, borrow risk, and actions using Sefi semantic facts.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          poolId: { type: "string" },
          wallet: { type: "string" },
        },
        required: ["question", "poolId"],
      },
      execute: (a) => sefi.blend().ask(a),
    },
    {
      name: "sefi_aquarius_get_pool_context",
      description: "Fetch Aquarius AMM pool facts for a token pair.",
      parameters: {
        type: "object",
        properties: {
          tokenA: { type: "string" },
          tokenB: { type: "string" },
        },
        required: ["tokenA", "tokenB"],
      },
      execute: (a) => sefi.aquarius().getPools(a),
    },
    {
      name: "sefi_aquarius_estimate_swap",
      description:
        "Estimate an Aquarius swap output, slippage and route hops for an amount.",
      parameters: {
        type: "object",
        properties: {
          tokenIn: { type: "string" },
          tokenOut: { type: "string" },
          amountIn: { type: "string" },
        },
        required: ["tokenIn", "tokenOut", "amountIn"],
      },
      execute: (a) => sefi.aquarius().estimateSwap(a),
    },
    {
      name: "sefi_aquarius_ask",
      description:
        "Answer Aquarius swap/route/slippage questions using Sefi semantic facts.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          tokenIn: { type: "string" },
          tokenOut: { type: "string" },
          amountIn: { type: "string" },
        },
        required: ["question", "tokenIn", "tokenOut", "amountIn"],
      },
      execute: (a) => sefi.aquarius().ask(a),
    },
    {
      name: "sefi_sdex_get_market_context",
      description: "Fetch Stellar DEX market facts (best bid/ask, spread).",
      parameters: {
        type: "object",
        properties: {
          base: { type: "string" },
          counter: { type: "string" },
        },
        required: ["base", "counter"],
      },
      execute: (a) => sefi.sdex().getMarket(a),
    },
    {
      name: "sefi_sdex_find_path",
      description:
        "Find a Stellar DEX strict-send path and estimated output for an amount.",
      parameters: {
        type: "object",
        properties: {
          sourceAsset: { type: "string" },
          destinationAsset: { type: "string" },
          sourceAmount: { type: "string" },
        },
        required: ["sourceAsset", "destinationAsset", "sourceAmount"],
      },
      execute: (a) => sefi.sdex().findPath(a),
    },
    {
      name: "sefi_sdex_ask",
      description:
        "Answer Stellar DEX liquidity/spread/path questions using Sefi semantic facts.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          sourceAsset: { type: "string" },
          destinationAsset: { type: "string" },
          amount: { type: "string" },
        },
        required: ["question", "sourceAsset", "destinationAsset", "amount"],
      },
      execute: (a) => sefi.sdex().ask(a),
    },
    {
      name: "sefi_context_compose",
      description:
        "Compose a multi-protocol context capsule across Blend, Aquarius and SDEX.",
      parameters: {
        type: "object",
        properties: {
          context: { type: "object" },
        },
        required: ["context"],
      },
      execute: (a) => sefi.context().compose(a.context),
    },
    {
      name: "sefi_facts_query",
      description: "Query stored semantic facts by protocol/entity/field.",
      parameters: {
        type: "object",
        properties: {
          protocol: { type: "string" },
          entityType: { type: "string" },
          entityId: { type: "string" },
          field: { type: "string" },
        },
        required: [],
      },
      execute: (a) => sefi.facts().query(a),
    },
  ];
}

/** Adapt Sefi tools to Anthropic Messages API `tools` format. */
export function toAnthropicTools(tools: AgentTool[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

/** Adapt Sefi tools to OpenAI `tools` (function) format. */
export function toOpenAITools(tools: AgentTool[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
