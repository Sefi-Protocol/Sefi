import type { SefiConfig } from "@sefi/shared-types";
import { StellarClient } from "@sefi/stellar-client";
import { createStore, type SefiStore } from "@sefi/store";
import { BlendAdapter } from "@sefi/protocol-blend";
import { AquariusAdapter } from "@sefi/protocol-aquarius";
import { SdexAdapter } from "@sefi/protocol-sdex";

/**
 * Shared in-process runtime: one Stellar client + store + adapter set built
 * from a {@link SefiConfig}. Used by every SDK module so adapters share caching
 * and persistence.
 */
export class SefiRuntime {
  readonly config: SefiConfig;
  readonly client: StellarClient;
  readonly store: SefiStore;
  readonly blend: BlendAdapter;
  readonly aquarius: AquariusAdapter;
  readonly sdex: SdexAdapter;

  constructor(config: SefiConfig, store?: SefiStore) {
    this.config = config;
    this.client = new StellarClient({
      network: config.network,
      rpcUrl: config.rpcUrl,
      horizonUrl: config.horizonUrl,
    });
    this.store = store ?? createStore();
    const ctx = {
      network: config.network,
      client: this.client,
      store: this.store,
    };
    this.blend = new BlendAdapter(ctx);
    this.aquarius = new AquariusAdapter({
      ...ctx,
      routerContractId: config.aquariusRouter,
    });
    this.sdex = new SdexAdapter(ctx);
  }
}
