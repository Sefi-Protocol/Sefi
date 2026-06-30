import type { Network, Protocol, SemanticFact, SourceRecord } from "@sefi/shared-types";
import { buildSourceRecord } from "@sefi/source-records";
import { buildFact } from "@sefi/semantic-core";
import { buildCapsule } from "@sefi/context-capsules";

/** Build a source record + facts for a protocol, for deterministic tests. */
export function mkSource(protocol: Protocol, network: Network = "mainnet"): SourceRecord {
  return buildSourceRecord({
    network,
    protocol,
    sourceKind: "stellar_rpc_simulate",
    response: { test: protocol },
    ledgerSeq: 1000,
    adapterName: protocol,
    adapterVersion: "1.0.0",
    adapterHash: `0xada_${protocol}`,
  });
}

export function mkFact(
  protocol: Protocol,
  entityType: SemanticFact["entityType"],
  entityId: string,
  field: string,
  value: unknown,
  source: SourceRecord,
  unit?: string,
): SemanticFact {
  return buildFact({
    network: "mainnet",
    protocol,
    entityType,
    entityId,
    field,
    value,
    unit,
    sources: [source],
    confidence: "high",
  });
}

/** Build a single-protocol Blend capsule with USDC reserve + oracle facts. */
export function blendCapsule(opts: {
  totalBorrowed: string;
  totalSupplied: string;
  oracle: "fresh" | "stale" | "unknown";
  health?: string;
}) {
  const src = mkSource("blend");
  const facts: SemanticFact[] = [
    mkFact("blend", "reserve", "blend_pool:C:USDC", "reserve.totalBorrowed", opts.totalBorrowed, src),
    mkFact("blend", "reserve", "blend_pool:C:USDC", "reserve.totalSupplied", opts.totalSupplied, src),
    mkFact("blend", "oracle", "oracle:C", "oracle.freshness", opts.oracle, src),
  ];
  if (opts.health)
    facts.push(mkFact("blend", "position", "blend_position:C:G", "health.factor", opts.health, src, "ratio"));
  const capsule = buildCapsule({ network: "mainnet", protocols: ["blend"], facts, sourceRecords: [src] });
  return { capsule, facts };
}

/** Composite Blend + Aquarius + SDEX capsule for the flagship policy. */
export function compositeCapsule(opts: {
  health: string;
  aquaOut: string;
  aquaHops: number;
  sdexAvailable: boolean;
  sdexOut: string;
}) {
  const blendSrc = mkSource("blend");
  const aquaSrc = mkSource("aquarius");
  const sdexSrc = mkSource("stellar_dex");
  const facts: SemanticFact[] = [
    mkFact("blend", "position", "blend_position:C:G", "health.factor", opts.health, blendSrc, "ratio"),
    mkFact("aquarius", "route", "aqua_route:USDC:XLM:1", "slippage.estimated_out", opts.aquaOut, aquaSrc, "stroops"),
    mkFact("aquarius", "route", "aqua_route:USDC:XLM:1", "route.hops", opts.aquaHops, aquaSrc, "count"),
    mkFact("stellar_dex", "route", "path:USDC:XLM:1", "path.available", opts.sdexAvailable, sdexSrc, "bool"),
    mkFact("stellar_dex", "route", "path:USDC:XLM:1", "path.estimated_out", opts.sdexOut, sdexSrc, "stroops"),
  ];
  const capsule = buildCapsule({
    network: "mainnet",
    protocols: ["blend", "aquarius", "stellar_dex"],
    facts,
    sourceRecords: [blendSrc, aquaSrc, sdexSrc],
  });
  return { capsule, facts };
}
