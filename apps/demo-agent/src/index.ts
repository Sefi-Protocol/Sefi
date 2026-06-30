import type { Network } from "@sefi/shared-types";
import { SefiClient } from "@sefi/sdk";
import {
  SEFI_AGENT_SYSTEM_PROMPT,
  createSefiTools,
} from "@sefi/agent-tools";

/**
 * Sample Sefi agent app (spec §14 / §19). Demonstrates the four use cases
 * end-to-end using the in-process SDK and the agent tool set. Optionally
 * narrates with Claude when SEFI_LLM_API_KEY is set, otherwise prints the
 * deterministic source-backed answers.
 */
const NETWORK = (process.env.SEFI_NETWORK ?? "mainnet") as Network;

// Live mainnet defaults: Blend "Fixed XLM-USDC" pool (docs.blend.capital).
const POOL =
  process.env.SEFI_DEMO_POOL ??
  "CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP";
const WALLET = process.env.SEFI_DEMO_WALLET; // optional; user position only if set
const AMOUNT = process.env.SEFI_DEMO_AMOUNT ?? "1000000000"; // 100 USDC (7 dp)

function printAnswer(title: string, a: Awaited<ReturnType<SefiClient["ask"]>>) {
  console.log(`\n=== ${title} ===`);
  console.log(`decision : ${a.decision} (confidence: ${a.confidence})`);
  console.log(`answer   : ${a.text}`);
  if (a.recommendedActions.length)
    console.log(`actions  : ${a.recommendedActions.join("; ")}`);
  console.log(`evidence : ${a.evidence.length} facts, capsule=${a.contextCapsuleId ?? "-"}`);
  if (a.warnings.length) console.log(`warnings : ${a.warnings.join(" | ")}`);
}

async function main() {
  const sefi = new SefiClient({ network: NETWORK });
  const tools = createSefiTools(sefi);
  console.log(SEFI_AGENT_SYSTEM_PROMPT);
  console.log(`\n[demo] ${tools.length} Sefi tools registered; network=${NETWORK} (live)`);
  console.log(`[demo] Blend pool=${POOL}${WALLET ? ` wallet=${WALLET}` : " (no wallet)"}`);

  // Use case 1: Blend risk assistant (spec §19.1)
  printAnswer(
    "Blend risk assistant",
    await sefi.blend().ask({
      question: WALLET
        ? "Is my Blend position safe to borrow more USDC?"
        : "Is this Blend pool risky right now?",
      poolId: POOL,
      wallet: WALLET,
    }),
  );

  // Use case 2: Aquarius exit route (spec §19.2)
  printAnswer(
    "Aquarius exit route",
    await sefi.aquarius().ask({
      question: "Can I swap 100 USDC to XLM with less than 1% slippage?",
      tokenIn: "USDC",
      tokenOut: "XLM",
      amountIn: AMOUNT,
    }),
  );

  // Use case 3: SDEX fallback (spec §19.3)
  printAnswer(
    "SDEX fallback liquidity",
    await sefi.sdex().ask({
      question: "If Aquarius is unavailable, can I exit through Stellar DEX?",
      sourceAsset: "USDC",
      destinationAsset: "XLM",
      amount: AMOUNT,
    }),
  );

  // Use case 4: Multi-protocol borrow safety (spec §19.4)
  printAnswer(
    "Multi-protocol borrow safety",
    await sefi.ask({
      question: "Can my agent borrow from Blend and still have enough exit liquidity?",
      context: {
        blend: { poolId: POOL, wallet: WALLET },
        aquarius: { route: { tokenIn: "USDC", tokenOut: "XLM", amountIn: AMOUNT } },
        sdex: { path: { sourceAsset: "USDC", destinationAsset: "XLM", sourceAmount: AMOUNT } },
      },
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
