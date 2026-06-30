import type {
  CompositeContext,
  ContextCapsule,
  ProtocolContext,
  SemanticFact,
  SourceRecord,
} from "@sefi/shared-types";
import { composeContexts } from "@sefi/context-capsules";
import type { SefiRuntime } from "./runtime.js";

export interface ComposeRequest {
  blend?: {
    poolId: string;
    wallet?: string;
    include?: string[];
  };
  aquarius?: {
    route?: { tokenIn: string; tokenOut: string; amountIn: string };
    pools?: { tokenA: string; tokenB: string };
    include?: string[];
  };
  sdex?: {
    market?: { base: string; counter: string };
    path?: { sourceAsset: string; destinationAsset: string; sourceAmount: string };
    liquidityPools?: { base: string; counter: string };
    include?: string[];
  };
}

/**
 * Context composition module (spec §11.4 / §13). Runs the requested protocol
 * adapters, merges their contexts into a {@link CompositeContext}, builds the
 * capsule (roots) and persists everything.
 */
export class ContextModule {
  constructor(private rt: SefiRuntime) {}

  async compose(req: ComposeRequest): Promise<CompositeContext> {
    const { composite } = await this.build(req);
    return composite;
  }

  /**
   * Build a composite context AND return the underlying capsule + facts +
   * sources. Used by the compute pipeline (which needs the capsule object with
   * its v2 roots), and by compose() which only needs the composite view.
   */
  async build(req: ComposeRequest): Promise<{
    composite: CompositeContext;
    capsule: ContextCapsule;
    facts: SemanticFact[];
    sourceRecords: SourceRecord[];
    warnings: string[];
  }> {
    const contexts: ProtocolContext[] = [];
    const warnings: string[] = [];

    if (req.blend) {
      const c = await this.rt.blend.getPoolContext({
        poolId: req.blend.poolId,
        wallet: req.blend.wallet,
        include: req.blend.include as any,
      });
      contexts.push(c);
      warnings.push(...c.warnings);
    }
    if (req.aquarius) {
      const c = await this.rt.aquarius.createContext({
        route: req.aquarius.route,
        pools: req.aquarius.pools,
      });
      contexts.push(c);
      warnings.push(...c.warnings);
    }
    if (req.sdex) {
      const c = await this.rt.sdex.createContext({
        market: req.sdex.market,
        path: req.sdex.path,
        liquidityPools: req.sdex.liquidityPools,
      });
      contexts.push(c);
      warnings.push(...c.warnings);
    }

    const { composite, capsule } = composeContexts(
      this.rt.config.network,
      contexts,
    );
    await this.rt.store.saveCapsule(capsule);
    return {
      composite: { ...composite, capsuleId: capsule.id },
      capsule,
      facts: composite.facts,
      sourceRecords: composite.sourceRecords,
      warnings,
    };
  }

  /** Collected warnings helper for the unified ask(). */
  static collectWarnings(contexts: ProtocolContext[]): string[] {
    return contexts.flatMap((c) => c.warnings);
  }
}
