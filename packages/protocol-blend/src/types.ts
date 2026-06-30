import type { Network } from "@sefi/shared-types";
import type { StellarClient } from "@sefi/stellar-client";
import type { SefiStore } from "@sefi/store";

export interface AdapterContext {
  network: Network;
  client: StellarClient;
  store?: SefiStore;
}

/** Blend semantic field shapes (spec §8.4). */
export interface BlendReserveFacts {
  asset: string;
  symbol: string;
  totalSupplied: string;
  totalBorrowed: string;
  utilization: string;
  collateralFactor?: string;
  liabilityFactor?: string;
  /** max_util — the configured utilization cap (ratio). */
  utilizationCap?: string;
  /** supply_cap in underlying token units (V2 reserves). */
  supplyCap?: string;
  borrowApr?: string;
  supplyApr?: string;
  /** Supply-side emissions per second (BLND), if active. */
  emissionsPerSecond?: string;
  enabled?: boolean;
}

export interface BlendPoolFacts {
  protocol: "blend";
  poolId: string;
  poolName?: string;
  poolStatus: "active" | "on_ice" | "frozen" | "unknown";
  reserves: BlendReserveFacts[];
  oracle?: {
    contractId: string;
    status: "fresh" | "stale" | "unknown";
    lastUpdatedLedger?: number;
  };
  backstop?: {
    contractId?: string;
    status: "healthy" | "weak" | "unknown";
    totalSpotValue?: number;
    q4wPercentage?: number;
  };
  ledger?: number;
}

export interface BlendUserPositionFacts {
  poolId: string;
  wallet: string;
  totalEffectiveCollateral: number;
  totalEffectiveLiabilities: number;
  borrowCapRemaining: number;
  healthFactor: number;
  ledger?: number;
}

export interface PoolContextRequest {
  poolId: string;
  wallet?: string;
  include?: string[];
}

export interface UserContextRequest {
  poolId: string;
  wallet: string;
  include?: string[];
}
