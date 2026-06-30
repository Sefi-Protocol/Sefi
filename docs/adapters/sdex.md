# Stellar DEX / AMM Adapter (live)

Handles Classic Stellar liquidity (spec §10) via Horizon REST.

## Endpoints used
- `/order_book` → best bid/ask + spread
- `/paths/strict-send` (`destination_assets`, decimal `source_amount`) → path output
- `/liquidity_pools` (`reserves=A,B`) → classic AMM pools

## Facts produced
| field | entity | meaning |
|---|---|---|
| `market.best_bid` / `market.best_ask` | market | top of book |
| `market.spread_bps` | market | `((ask - bid)/mid) * 10000` |
| `path.available` | route | a strict-send path exists |
| `path.estimated_out` | route | destination amount (units) |
| `route.hops` | route | path length + 1 |
| `liquidity.available` | pool | count of classic LPs for the pair |

## Computations (spec §10.5)
`spread_bps`, exit-liquidity (path availability) and `path_ok = estimatedOut >=
minReceive`. A spread wider than 50 bps marks SDEX as a weaker fallback vs an
AMM route.

## Amounts
SDK inputs use **stroops** (7-dp fixed point). Horizon path amounts are decimal
units; the adapter converts internally. `path.estimated_out` is therefore in
destination **units**.
