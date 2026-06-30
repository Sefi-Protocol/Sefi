import type {
  CompositeContext,
  SefiAnswer,
  SefiConfig,
  SemanticFact,
} from "@sefi/shared-types";
import type { FactQuery, SefiStore } from "@sefi/store";
import { SefiRuntime } from "./runtime.js";
import { ContextModule, type ComposeRequest } from "./context.js";
import { reasonComposite } from "./reason.js";

export type { ComposeRequest } from "./context.js";
export { SefiRuntime } from "./runtime.js";
export { reasonComposite } from "./reason.js";

class BlendModule {
  constructor(private rt: SefiRuntime) {}
  getPoolContext = (args: { poolId: string; wallet?: string; include?: string[] }) =>
    this.rt.blend.getPoolContext(args as any);
  getUserContext = (args: { poolId: string; wallet: string; include?: string[] }) =>
    this.rt.blend.getUserContext(args as any);
  ask = (args: { question: string; poolId: string; wallet?: string }) =>
    this.rt.blend.ask(args.question, { poolId: args.poolId, wallet: args.wallet });
}

class AquariusModule {
  constructor(private rt: SefiRuntime) {}
  getPools = (args: { tokenA: string; tokenB: string }) =>
    this.rt.aquarius.getPools(args);
  estimateSwap = (args: { tokenIn: string; tokenOut: string; amountIn: string }) =>
    this.rt.aquarius.estimateSwap(args);
  ask = (args: {
    question: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    maxSlippageBps?: number;
  }) =>
    this.rt.aquarius.ask(args.question, {
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      amountIn: args.amountIn,
      maxSlippageBps: args.maxSlippageBps,
    });
}

class SdexModule {
  constructor(private rt: SefiRuntime) {}
  getMarket = (args: { base: string; counter: string }) =>
    this.rt.sdex.getMarket(args);
  findPath = (args: {
    sourceAsset: string;
    destinationAsset: string;
    sourceAmount: string;
  }) => this.rt.sdex.findPath(args);
  ask = (args: {
    question: string;
    sourceAsset: string;
    destinationAsset: string;
    amount: string;
  }) =>
    this.rt.sdex.ask(args.question, {
      sourceAsset: args.sourceAsset,
      destinationAsset: args.destinationAsset,
      amount: args.amount,
    });
}

class FactsModule {
  constructor(private rt: SefiRuntime) {}
  query = (q: FactQuery): Promise<SemanticFact[]> => this.rt.store.queryFacts(q);
}

/**
 * Public Sefi SDK client (spec §13.2). Default mode runs adapters in-process
 * against a configured store; pass a store for PostgreSQL persistence. The same
 * surface backs the API server.
 */
export class SefiClient {
  private rt: SefiRuntime;
  constructor(config: SefiConfig, store?: SefiStore) {
    this.rt = new SefiRuntime(config, store);
  }

  get store(): SefiStore {
    return this.rt.store;
  }

  blend() {
    return new BlendModule(this.rt);
  }
  aquarius() {
    return new AquariusModule(this.rt);
  }
  sdex() {
    return new SdexModule(this.rt);
  }
  context() {
    return new ContextModule(this.rt);
  }
  facts() {
    return new FactsModule(this.rt);
  }

  /** Unified multi-protocol ask (spec §13.4 / §23.4). */
  async ask(args: {
    question: string;
    context: ComposeRequest;
  }): Promise<SefiAnswer> {
    const composite: CompositeContext = await this.context().compose(
      args.context,
    );
    return reasonComposite(args.question, composite, []);
  }
}

export function createClient(config: SefiConfig, store?: SefiStore): SefiClient {
  return new SefiClient(config, store);
}
