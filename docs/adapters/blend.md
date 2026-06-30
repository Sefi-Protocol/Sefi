# Blend Adapter (live)

Turns Blend lending state into lending semantics (spec §8). Reads **live** via
`@blend-capital/blend-sdk` (`PoolV2.load` / `PoolV1.load`, `loadOracle`,
`loadUser`, `PositionsEstimate.build`), which fetches ledger entries over
Soroban RPC.

## Inputs
- `poolId` — a real Blend pool contract id (e.g. mainnet Fixed XLM-USDC
  `CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP`).
- `wallet` — optional; produces live position facts.

## Facts produced
| field | entity | meaning |
|---|---|---|
| `pool.status` | pool | active / on_ice / frozen |
| `pool.utilization` | reserve | `totalBorrowed / totalSupplied` |
| `reserve.totalSupplied` / `reserve.totalBorrowed` | reserve | reserve sizes |
| `oracle.freshness` | oracle | fresh / unknown (+ ledger) |
| `health.factor` | position | `effectiveCollateral / effectiveLiabilities` |
| `borrow.limit` / `borrow.used` | position | effective collateral / liabilities |

## Risk read (spec §8.7)
Utilization above 80% on any reserve flags the pool as moderately risky; oracle
freshness and user health factor are reported alongside. Risk direction follows
spec §8.5: SUPPLY/REPAY reduce risk, BORROW/WITHDRAW increase it.
