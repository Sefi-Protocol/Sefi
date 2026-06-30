/**
 * Parse a Sefi asset string into Horizon query parameters. Accepts:
 *  - "XLM" or "native"            -> native
 *  - "CODE:ISSUER"                -> credit_alphanum4/12
 */
export interface HorizonAsset {
  type: "native" | "credit_alphanum4" | "credit_alphanum12";
  code?: string;
  issuer?: string;
  label: string;
}

export function parseAsset(asset: string): HorizonAsset {
  if (asset === "XLM" || asset === "native") {
    return { type: "native", label: "XLM" };
  }
  const [code, issuer] = asset.split(":");
  if (!issuer) {
    // Bare code with no issuer — treat as native-ish label; Horizon needs issuer
    // for credit assets, so callers should pass CODE:ISSUER on mainnet.
    return { type: "native", label: code };
  }
  return {
    type: code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
    code,
    issuer,
    label: code,
  };
}

/** Build prefixed Horizon query params, e.g. selling_asset_type=... */
export function assetParams(
  prefix: string,
  asset: HorizonAsset,
): Record<string, string | undefined> {
  if (asset.type === "native") {
    return { [`${prefix}_asset_type`]: "native" };
  }
  return {
    [`${prefix}_asset_type`]: asset.type,
    [`${prefix}_asset_code`]: asset.code,
    [`${prefix}_asset_issuer`]: asset.issuer,
  };
}
