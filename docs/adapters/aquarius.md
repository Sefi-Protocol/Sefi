# Aquarius Adapter (live)

Turns Aquarius AMM state into liquidity / route / swap semantics (spec §9). All
reads use Soroban `simulateTransaction` against the AMM router and pools.

## Contracts
- Mainnet router (default): `CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK`
  (docs.aqua.network). Override with `AQUARIUS_ROUTER` / config `aquariusRouter`.

## Flow
1. Resolve `tokenIn`/`tokenOut` to SAC contract ids and order them
   (`order_token_ids`, raw-byte sort).
2. `router.get_pools([tokenA, tokenB])` → pool contract ids.
3. `pool.estimate_swap(in_idx, out_idx, amount_in_u128)` → estimated out.
4. A second small-amount `estimate_swap` derives the spot price, giving real
   slippage in bps.

## Facts produced
| field | entity | meaning |
|---|---|---|
| `pool.exists` | pool | a pool exists for the pair |
| `slippage.estimated_out` | route | estimated output (stroops) |
| `slippage.estimated` | route | slippage in bps (vs spot) |
| `route.hops` | route | number of pools |
| `route.pool_id` | route | chosen pool |
| `route.available` | route | false when no pool exists |

## Policy checks (spec §9.5)
`route_acceptable = estimatedOut >= minOut`, `slippage_ok = slippageBps <= max`
(default 100 bps), `route_hops_ok = hops <= 4`.
