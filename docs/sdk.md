# Sefi SDK

```ts
import { SefiClient } from "@sefi/sdk";

const sefi = new SefiClient({ network: "mainnet" });
```

All calls hit live Stellar data. Pass a `@sefi/store` instance as the second
constructor argument to persist source records / facts / capsules to PostgreSQL.

## Blend (spec §8.6)

```ts
const ctx = await sefi.blend().getPoolContext({
  poolId: "CDVQVKOY...",          // a real Blend pool contract id
  wallet: "G...",                  // optional -> live user-position facts
});

const answer = await sefi.blend().ask({
  question: "Is this pool risky right now?",
  poolId: "CDVQVKOY...",
});
// answer.decision, answer.text, answer.facts, answer.evidence, answer.warnings
```

## Aquarius (spec §9.6)

```ts
await sefi.aquarius().getPools({ tokenA: "USDC", tokenB: "XLM" });

const est = await sefi.aquarius().estimateSwap({
  tokenIn: "USDC", tokenOut: "XLM", amountIn: "1000000000", // 100 USDC (7dp)
});

await sefi.aquarius().ask({
  question: "Can I swap 100 USDC to XLM with less than 1% slippage?",
  tokenIn: "USDC", tokenOut: "XLM", amountIn: "1000000000",
});
```

Assets resolve from a built-in registry (`XLM`, `USDC`, `AQUA`) or `CODE:ISSUER`.
On testnet, set `aquariusRouter` in the config (no default router).

## SDEX (spec §10.6)

```ts
await sefi.sdex().getMarket({ base: "XLM", counter: "USDC" });
await sefi.sdex().findPath({ sourceAsset: "USDC", destinationAsset: "XLM", sourceAmount: "1000000000" });
await sefi.sdex().ask({ question: "Enough liquidity to exit?", sourceAsset: "USDC", destinationAsset: "XLM", amount: "1000000000" });
```

## Composite + unified ask (spec §11.4 / §13.4)

```ts
const ctx = await sefi.context().compose({
  blend:    { poolId: "CDVQVKOY...", wallet: "G..." },
  aquarius: { route: { tokenIn: "USDC", tokenOut: "XLM", amountIn: "1000000000" } },
  sdex:     { path:  { sourceAsset: "USDC", destinationAsset: "XLM", sourceAmount: "1000000000" } },
});
// ctx.roots.compositeRoot is the future ZK public input; ctx.capsuleId is persisted

const answer = await sefi.ask({
  question: "Can I borrow from Blend and exit through Aquarius or SDEX?",
  context: { blend: {...}, aquarius: {...}, sdex: {...} },
});
```

## Facts query (spec §15.1)

```ts
await sefi.facts().query({ protocol: "blend", field: "pool.utilization" });
```

## Answer shape (spec §13.5)

```ts
interface SefiAnswer {
  text: string;
  confidence: "high" | "medium" | "low";
  decision?: "safe" | "unsafe" | "conditional" | "unknown";
  recommendedActions: string[];
  facts: SemanticFact[];
  sourceRecords: { id; protocol; ledgerSeq; responseHash }[];
  evidence: { fact; value; sourceRecordId? }[];
  contextCapsuleId?: string;
  warnings: string[];
}
```
