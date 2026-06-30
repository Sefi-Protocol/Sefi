import type { Network } from "@sefi/shared-types";

export const DEFAULT_URLS: Record<Network, { rpc: string; horizon: string }> = {
  testnet: {
    rpc: "https://soroban-testnet.stellar.org",
    horizon: "https://horizon-testnet.stellar.org",
  },
  mainnet: {
    rpc: "https://mainnet.sorobanrpc.com",
    horizon: "https://horizon.stellar.org",
  },
};

/** Known asset registry so callers can pass a bare symbol (resolved to its SAC). */
const ASSET_REGISTRY: Record<
  Network,
  Record<string, { code: string; issuer: string } | "native">
> = {
  mainnet: {
    XLM: "native",
    USDC: {
      code: "USDC",
      issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    },
    AQUA: {
      code: "AQUA",
      issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AB2A",
    },
  },
  testnet: {
    XLM: "native",
    USDC: {
      code: "USDC",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQW8OEQ2ROACBQATBDA47T",
    },
  },
};

export interface StellarClientConfig {
  network: Network;
  rpcUrl?: string;
  horizonUrl?: string;
  timeout?: number;
}

export interface HorizonResult {
  endpoint: string;
  ledger?: number;
  body: unknown;
}

export interface SimulateResult {
  contractId: string;
  functionName: string;
  value: unknown;
  resultXdr?: string;
  latestLedger?: number;
}

/**
 * Live Stellar access layer (spec §4.1). All reads hit the real network:
 *  - Horizon REST over fetch (Classic DEX / AMM).
 *  - Soroban RPC `simulateTransaction` for read-only contract getters.
 * There is no mock/fixture path — adapters surface real ledger state or error.
 */
export class StellarClient {
  readonly network: Network;
  readonly rpcUrl: string;
  readonly horizonUrl: string;
  private readonly timeout: number;
  private sdkPromise?: Promise<any>;

  constructor(cfg: StellarClientConfig) {
    this.network = cfg.network;
    const defaults = DEFAULT_URLS[cfg.network];
    this.rpcUrl = cfg.rpcUrl ?? defaults.rpc;
    this.horizonUrl = cfg.horizonUrl ?? defaults.horizon;
    this.timeout = cfg.timeout ?? 15_000;
  }

  private sdk(): Promise<any> {
    if (!this.sdkPromise) this.sdkPromise = import("@stellar/stellar-sdk");
    return this.sdkPromise;
  }

  async passphrase(): Promise<string> {
    const sdk = await this.sdk();
    return this.network === "mainnet"
      ? sdk.Networks.PUBLIC
      : sdk.Networks.TESTNET;
  }

  /** Blend SDK `Network` object built from this client. */
  blendNetwork(): {
    rpc: string;
    passphrase: string;
    opts: { allowHttp: boolean };
  } {
    return {
      rpc: this.rpcUrl,
      passphrase:
        this.network === "mainnet"
          ? "Public Global Stellar Network ; September 2015"
          : "Test SDF Network ; September 2015",
      opts: { allowHttp: true },
    };
  }

  /** Resolve a Sefi asset ("XLM", "USDC", "CODE:ISSUER") to its SAC contract id. */
  async assetContractId(asset: string): Promise<string> {
    const a = await this.toAsset(asset);
    const passphrase = await this.passphrase();
    return a.contractId(passphrase);
  }

  /** Resolve a Sefi asset to Horizon order-book/path query parameters. */
  async horizonAsset(asset: string): Promise<{
    type: "native" | "credit_alphanum4" | "credit_alphanum12";
    code?: string;
    issuer?: string;
    label: string;
  }> {
    const a = await this.toAsset(asset);
    if (a.isNative?.() || asset === "XLM" || asset === "native")
      return { type: "native", label: "XLM" };
    const code = a.getCode();
    const issuer = a.getIssuer();
    return {
      type: code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
      code,
      issuer,
      label: code,
    };
  }

  private async toAsset(asset: string): Promise<any> {
    const sdk = await this.sdk();
    if (asset === "XLM" || asset === "native") return sdk.Asset.native();
    if (asset.includes(":")) {
      const [code, issuer] = asset.split(":");
      return new sdk.Asset(code, issuer);
    }
    const known = ASSET_REGISTRY[this.network][asset];
    if (known === "native") return sdk.Asset.native();
    if (known) return new sdk.Asset(known.code, known.issuer);
    throw new Error(`unknown asset "${asset}" on ${this.network}; pass CODE:ISSUER`);
  }

  // ---- Horizon -----------------------------------------------------------

  async horizonGet(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<HorizonResult> {
    const url = new URL(path.replace(/^\//, ""), this.horizonUrl + "/");
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const body = await this.fetchJson(url.toString());
    const ledger =
      (body as any)?.last_modified_ledger ??
      (body as any)?._embedded?.records?.[0]?.last_modified_ledger;
    return { endpoint: url.toString(), ledger, body };
  }

  // ---- Soroban ScVal helpers --------------------------------------------

  async addressScVal(id: string): Promise<any> {
    const sdk = await this.sdk();
    return sdk.Address.fromString(id).toScVal();
  }
  async u32(n: number): Promise<any> {
    const sdk = await this.sdk();
    return sdk.xdr.ScVal.scvU32(n);
  }
  async u128(v: string | bigint): Promise<any> {
    const sdk = await this.sdk();
    return new sdk.XdrLargeInt("u128", v.toString()).toU128();
  }
  async vec(items: any[]): Promise<any> {
    const sdk = await this.sdk();
    return sdk.xdr.ScVal.scvVec(items);
  }

  /** Sort token contract ids by raw 32-byte value (Aquarius `order_token_ids`). */
  async sortTokenIds(ids: string[]): Promise<string[]> {
    const sdk = await this.sdk();
    return [...ids].sort((a, b) =>
      Buffer.compare(sdk.StrKey.decodeContract(a), sdk.StrKey.decodeContract(b)),
    );
  }

  /**
   * Read-only Soroban getter via simulateTransaction. `args` are pre-built
   * ScVal objects. Returns the native-decoded result + result XDR + ledger.
   */
  async simulate(
    contractId: string,
    functionName: string,
    args: any[] = [],
  ): Promise<SimulateResult> {
    const sdk = await this.sdk();
    const { Contract, TransactionBuilder, Account, StrKey, scValToNative, rpc } = sdk;
    const passphrase = await this.passphrase();
    const server = new rpc.Server(this.rpcUrl, { allowHttp: true });
    const contract = new Contract(contractId);
    // Read-only simulation does not require a funded/real account; use the
    // canonical all-zero ed25519 account as a valid placeholder source.
    const source = new Account(
      StrKey.encodeEd25519PublicKey(Buffer.alloc(32)),
      "0",
    );
    const tx = new TransactionBuilder(source, {
      fee: "100",
      networkPassphrase: passphrase,
    })
      .addOperation(contract.call(functionName, ...args))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`simulate ${functionName} failed: ${sim.error}`);
    }
    const retval = sim.result?.retval;
    return {
      contractId,
      functionName,
      value: retval ? scValToNative(retval) : null,
      resultXdr: retval ? retval.toXDR("base64") : undefined,
      latestLedger: sim.latestLedger,
    };
  }

  private async fetchJson(url: string): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
