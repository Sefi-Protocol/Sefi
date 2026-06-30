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
  /** Resource's last_modified_ledger if present in the body. */
  ledger?: number;
  /** Horizon node's latest ledger, from the `Latest-Ledger` response header. */
  latestLedger?: number;
  headers?: Record<string, string>;
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
    const { body, headers } = await this.fetchJsonWithHeaders(url.toString());
    const ledger =
      (body as any)?.last_modified_ledger ??
      (body as any)?._embedded?.records?.[0]?.last_modified_ledger;
    // Horizon returns the node's latest ledger in the `Latest-Ledger` header.
    const headerLedger = headers["latest-ledger"];
    const latestLedger = headerLedger ? Number(headerLedger) : undefined;
    return {
      endpoint: url.toString(),
      ledger: ledger ?? latestLedger,
      latestLedger,
      headers,
      body,
    };
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
  /** Build a BytesN ScVal from a 0x-prefixed or raw hex string. */
  async bytesScVal(hex: string): Promise<any> {
    const sdk = await this.sdk();
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    return sdk.xdr.ScVal.scvBytes(Buffer.from(clean, "hex"));
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

  private async rpcServer(): Promise<any> {
    const sdk = await this.sdk();
    return new sdk.rpc.Server(this.rpcUrl, { allowHttp: true });
  }

  /** Latest ledger sequence as seen by the RPC node. */
  async getLatestLedger(): Promise<number> {
    const server = await this.rpcServer();
    const res = await server.getLatestLedger();
    return res.sequence;
  }

  /**
   * Soroban RPC `getEvents` for a contract (spec §4.1 A). Supports checkpointed
   * ingestion: pass `cursor` to resume, or `startLedger` for a fresh window.
   * Returns decoded events plus the cursor/ledger to checkpoint on.
   */
  async getEvents(opts: {
    contractIds: string[];
    startLedger?: number;
    cursor?: string;
    topics?: string[][];
    limit?: number;
  }): Promise<{
    events: Array<{
      ledger: number;
      contractId: string;
      type: string;
      topic: unknown[];
      value: unknown;
      txHash?: string;
      id: string;
      pagingToken: string;
    }>;
    latestLedger: number;
    cursor?: string;
  }> {
    const sdk = await this.sdk();
    const { scValToNative } = sdk;
    const server = await this.rpcServer();
    const filters = [
      {
        type: "contract",
        contractIds: opts.contractIds,
        topics: opts.topics,
      },
    ];
    const req: any = { filters, limit: opts.limit ?? 100 };
    // getEvents requires exactly one of startLedger / cursor.
    if (opts.cursor) req.cursor = opts.cursor;
    else req.startLedger = opts.startLedger ?? (await this.getLatestLedger()) - 100;
    const res = await server.getEvents(req);
    const events = (res.events ?? []).map((e: any) => ({
      ledger: e.ledger,
      contractId: e.contractId?.toString?.() ?? String(e.contractId),
      type: e.type,
      topic: (e.topic ?? []).map((t: any) => safeNative(scValToNative, t)),
      value: safeNative(scValToNative, e.value),
      txHash: e.txHash,
      id: e.id,
      pagingToken: e.pagingToken ?? e.id,
    }));
    const cursor = events.length ? events[events.length - 1].pagingToken : res.cursor;
    return { events, latestLedger: res.latestLedger, cursor };
  }

  /**
   * Soroban RPC `getLedgerEntries` for raw state capture (spec §4.1 A / §10.2).
   * `keys` are base64 XDR LedgerKey strings (or sdk LedgerKey objects). Returns
   * each entry's key/value XDR so source records can capture proof-grade state.
   */
  async getLedgerEntries(keys: Array<string | any>): Promise<{
    entries: Array<{ keyXdr: string; valXdr: string; lastModifiedLedger?: number }>;
    latestLedger: number;
  }> {
    const sdk = await this.sdk();
    const server = await this.rpcServer();
    const ledgerKeys = keys.map((k) =>
      typeof k === "string" ? sdk.xdr.LedgerKey.fromXDR(k, "base64") : k,
    );
    const res = await server.getLedgerEntries(...ledgerKeys);
    const entries = (res.entries ?? []).map((e: any) => ({
      keyXdr: typeof e.key === "string" ? e.key : e.key?.toXDR?.("base64"),
      valXdr: typeof e.val === "string" ? e.val : e.val?.toXDR?.("base64"),
      lastModifiedLedger: e.lastModifiedLedgerSeq,
    }));
    return { entries, latestLedger: res.latestLedger };
  }

  private async fetchJson(url: string): Promise<unknown> {
    return (await this.fetchJsonWithHeaders(url)).body;
  }

  /** Allows tests to inject a fetch implementation (e.g. mocked headers). */
  fetchImpl: typeof fetch = (...args) => fetch(...(args as Parameters<typeof fetch>));

  private async fetchJsonWithHeaders(
    url: string,
  ): Promise<{ body: unknown; headers: Record<string, string> }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      return { body: await res.json(), headers };
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeNative(scValToNative: (v: any) => unknown, v: unknown): unknown {
  if (v == null) return v;
  try {
    return scValToNative(v);
  } catch {
    try {
      return (v as any).toXDR?.("base64") ?? String(v);
    } catch {
      return String(v);
    }
  }
}
