# Phase 2 Audit Fix Log

## Part A — baseline

- Starting commit SHA: `0f9f06d09d41294c30f3e5081c0b0d5bff1a3574`
- `git pull origin main`: already up to date.

### Baseline command results (before audit fixes)

| Command | Result |
|---|---|
| `pnpm install` | OK |
| `pnpm build` (`tsc -b`) | OK, exit 0 |
| `pnpm test` | 51 tests, 51 pass, 0 fail |
| `pnpm smoke` | ✅ passed (live mainnet, replay verify OK) |
| `pnpm demo:phase2` | ✅ Blend policy SAFE; composite skipped (needs `SEFI_DEMO_WALLET`) |

### Toolchain availability in this environment

| Tool | Status | Notes |
|---|---|---|
| `cargo` / `rustc` | ✅ 1.89.0 (Homebrew) | Rust contracts can build/test |
| `stellar` CLI | ✅ 27.0.0 | contract build/deploy available |
| `nargo` (Noir) | ❌ not installed | **Blocker** (see below) |
| `bb` (Barretenberg) | ❌ not installed | **Blocker** (see below) |
| `soroban` (legacy) | ❌ | superseded by `stellar` CLI |

### Documented blocker: Noir toolchain install

The sandbox's auto-mode policy blocks executing remote installer scripts
(`curl … | bash`), which is the official install path for `noirup`/`bbup`.
Therefore `nargo` and `bb` cannot be auto-installed in this environment.

Consequence and mitigation (per the audit's "install it or document the exact
blocker and continue" rule):

- All repo-side parts (B, C, D, E, H, I, J, K) are implemented and tested here.
- Part C ships a **TypeScript reference** for the BN254 Fr mapping + Poseidon
  zk roots with golden-vector tests that run without any toolchain — this is the
  spec the Noir circuits bind to.
- Part F ships the **real Noir circuits** (source) plus `noir-build/prove/verify`
  scripts that invoke `nargo`/`bb`. These run on any machine with the toolchain
  (`SEFI_REQUIRE_BN254=1` enforces it); here they skip with an explicit reason.
- Part G ships the **real Rust Soroban contracts** (registry + BN254 verifier)
  and `cargo test`; BN254 host functions require a Protocol 25/26 localnet, so
  the on-chain pairing test is gated and documented.

To complete the toolchain-gated acceptance on a configured machine:

```bash
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
noirup --version 1.0.0-beta.x      # or matching nargo
curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/master/barretenberg/bbup/install | bash
bbup
REQUIRE_NOIR=1 pnpm zk:test
```

## Change log

(entries appended per part below as fixes land)

## Part G — live testnet deployment

Deployed to Stellar **testnet** (Protocol 25+, BN254 host functions) with
soroban-sdk 25 + rustc 1.96 (rustup) + stellar CLI 27.0.0.

- Deployer: `GAUTESFW2APS3ZUE4J5Y7EA26UPMQKHCWRWF5D4YGQLKFSUJZVJNW6TV`
- **Verifier contract** (`noir_ultrahonk_verifier`): `CC2HYEYVFQ6RH6NECDRJWKJBN4XP3XBGXPG4XNAQLGP4KA6PCFL7HGDN`
- **Registry contract** (`sefi_verifier_registry`): `CBAYTGH524MS6WILWGUB5LLOQO3JCRHO77NP6OVQAJUMX5J4O3GR4UWT`

On-chain checks (real testnet):
- `bn254_smoke_g1_double` → `true` (G + G == 2*G via host BN254)
- `bn254_smoke_g1_triple` → `true` (3*G == G + 2*G)
- `emit_proof_card` committed; `get_card` returns the committed context root.

Reproduce: `pnpm deploy:verifier:testnet` (auto-generates + funds a key if none set).
