# USDC Spike — Mint From the Impersonated TreasuryCap Owner

This spike validates that empty-signature impersonation on a `sui-fork` mainnet network lets us mint native USDC by "being" the address that owns the USDC `TreasuryCap` object on mainnet. It's load-bearing for the production USDC funding path: USDC is mintable (unlike DEEP), so once we can impersonate the cap owner, the sandbox faucet can produce arbitrary amounts on demand without any donor-drain ceiling.

## Follow-up work

- **This spike** — validate the mechanism.
- **Production USDC minter-address decision** — formally pick the production USDC minter address(es) and document them. The spike may need an update if Circle's mint path is more constrained than direct `coin::mint`.
- **USDC funding-strategy plugin** — generalize this pattern into `sandbox/scripts/utils/impersonation.ts` and replace the custom `sandbox/packages/usdc` publish.
- **Faucet USDC wiring** — switch the faucet's USDC path to the same mechanism.

## Why this should work

> **Outcome:** the naive `coin::mint` hypothesis below is disproven — the `TreasuryCap` is wrapped in a shared `Treasury<USDC>`, not address-owned. But USDC minting on the fork **is** achievable: the corrected `treasury::mint` master-minter hijack was **validated end-to-end** (fresh USDC minted, total supply increased). See [POC results](#poc-results) for the full custody chain, role-discovery method, and the exact 3-tx sequence. The hypothesis below is kept for context.

`sui-fork` accepts transactions with an empty signature list and executes them as the declared sender. Because the USDC `TreasuryCap` is an address-owned object on mainnet, the fork inherits that ownership when the cap is materialized. With the cap as `&mut` input to `0x2::coin::mint<USDC>(cap, amount, ctx)` and the cap's owner declared as sender, sui-fork should execute the mint without ever needing the owner's private key.

**Caveat:** Circle's native USDC on Sui follows the [regulated coin pattern](https://docs.sui.io/guides/developer/stablecoins). The TreasuryCap is currently address-owned, which suggests vanilla `coin::mint` works, but Circle may also expose a gated mint flow (a controller / minter allowlist on top of the cap) that's the _preferred_ path. The spike tries the simplest possible path first; if it fails with a Move abort, we learn what Circle's design actually requires and adjust the USDC funding-strategy plugin accordingly.

## Verified mainnet IDs (2026-05-18)

| Role                                | ID                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| USDC package                        | `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7`             |
| USDC coin type                      | `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC` |
| `TreasuryCap<USDC>` object          | `0x677e41a5c35d90177d401b72952c228ffa65b770e265561ad607f34d6896dcc2`             |
| stablecoin framework package        | `0xecf47609d7da919ea98e7fd04f6e0648a0a79b337aaad373fa37aac8febf19c8`             |
| shared `Treasury<USDC>`             | `0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7`             |
| master minter (impersonated sender) | `0x41c0c6d67577b39f31a5fe4052314fd3a8b7c7f890676f60e007bd390e397ac1`             |

The cap is **not** address-owned (see [POC results](#poc-results)): it is a dynamic object field under the shared `Treasury<USDC>`, so minting goes through the framework's `treasury::mint`, gated by the master minter. Override any of these via env vars if Circle rotates them.

## Files

| File                         | What it is                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mint-via-master-minter.mjs` | The working spike script. Impersonates the master minter to grant itself a minter (`configure_new_controller` + `configure_minter`), then mints USDC via `treasury::mint` — all by empty-sig `execute-signed-tx`. Handles gas funding and MintCap reuse. Dependency-free (shells out to `sui`). |

## How to run

### Prerequisites

- A `sui-fork` build from the Sui monorepo. No explicit `--object`/`--address` seeding is needed — sui-fork lazily fetches every referenced object (Treasury, cap, DenyList, donor coins) from mainnet on first touch.
- `sui` CLI on `PATH` (or `SUI_BIN` env var) — **must be the exact same monorepo build as `sui-fork`** (matching `--version`). Reads tolerate a skew, but `execute-signed-tx` against a mismatched fork fails with an HTTP/2 stream reset. The monorepo usually only builds `sui-fork`; build the matching CLI with `cargo build --bin sui` and point `SUI_BIN` at it.
- Node ≥ 18.

> **RPC note:** this `sui-fork` build serves the modern **gRPC** API on `--rpc-addr`, not the legacy JSON-RPC fullnode API — raw JSON-RPC POSTs (`sui_getObject`, `suix_getCoins`, …) return `404`. The script and the checks below go through the `sui` CLI (gRPC) rather than `curl` against an RPC URL.

> **Enumeration note:** sui-fork lazily fetches mainnet state **on reference by id**, but it cannot _enumerate_ an account's un-fetched objects. So on a fresh fork `sui client gas <donor>` returns empty — the script funds the master minter by referencing a known donor SUI coin id (`SUI_DONOR_GAS_COIN`), not by listing. If you've spent/merged that coin, override it with a current one (look up `SUI_DONOR` on an explorer). Once the master minter is funded, its coin is a fork-local object and enumerates normally on later runs.

### Start the fork

```bash
sui-fork start --network mainnet --data-dir /tmp/sui-fork-usdc-spike
```

In another terminal:

```bash
sui client new-env --alias local-fork --rpc http://127.0.0.1:9000
sui client switch --env local-fork
```

### Run the script

```bash
cd sandbox/scripts/spikes/usdc

# Inspect — print resolved config, the master minter, current total supply,
# and whether the master minter is funded / a MintCap is configured.
node mint-via-master-minter.mjs inspect

# Setup — fund the master minter (from the SUI donor) and configure it as a
# minter. Prints the MintCap id; record it to reuse via USDC_MINT_CAP_ID.
node mint-via-master-minter.mjs setup

# Mint — runs the whole flow (fund + configure if needed, then mint) and
# transfers MINT_AMOUNT USDC to RECIPIENT. Repeatable.
node mint-via-master-minter.mjs mint

# Reuse a configured MintCap to skip the one-time setup on subsequent mints:
USDC_MINT_CAP_ID=0x<cap-from-setup> node mint-via-master-minter.mjs mint
```

> One-time vs repeatable: funding the master minter and configuring the minter happen **once per fork**. `configure_new_controller` aborts if the master minter is already a controller — pass `USDC_MINT_CAP_ID` (printed by `setup`/`mint`) on later runs, or restart the fork. Only `treasury::mint` repeats per request.

### Env var overrides

| Env var                | Default                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUI_BIN`              | _(unset — falls back to `sui` on `PATH`; errors if not found)_                                                                                        |
| `STABLECOIN_PKG`       | `0xecf47609d7da919ea98e7fd04f6e0648a0a79b337aaad373fa37aac8febf19c8`                                                                                  |
| `USDC_COIN_TYPE`       | `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC`                                                                      |
| `USDC_TREASURY`        | `0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7`                                                                                  |
| `USDC_TREASURY_CAP_ID` | `0x677e41a5c35d90177d401b72952c228ffa65b770e265561ad607f34d6896dcc2` (read for total supply)                                                          |
| `USDC_MASTER_MINTER`   | `0x41c0c6d67577b39f31a5fe4052314fd3a8b7c7f890676f60e007bd390e397ac1`                                                                                  |
| `DENY_LIST`            | `0x0000000000000000000000000000000000000000000000000000000000000403`                                                                                  |
| `SUI_DONOR`            | `0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d` (funds the gas-less master minter)                                               |
| `SUI_DONOR_GAS_COIN`   | `0xc866352dd2574aa14752dd09afca89cd993f573c59218ff278c3dafbd24ca714` (a SUI coin owned by `SUI_DONOR`, referenced by id — see enumeration note below) |
| `USDC_MINT_CAP_ID`     | _(unset — reuse a MintCap from a prior `setup`/`mint` to skip configuration)_                                                                         |
| `RECIPIENT`            | `0x0000000000000000000000000000000000000000000000000000000000000abc`                                                                                  |
| `MINT_AMOUNT`          | `1000000000` (1000 USDC at 6 decimals, raw units)                                                                                                     |
| `MINT_ALLOWANCE`       | `1000000000000000` (1e9 USDC of minter headroom)                                                                                                      |
| `GAS_BUDGET`           | `100000000`                                                                                                                                           |
| `FUND_AMOUNT`          | `1000000000` (1 SUI sent to the master minter for gas)                                                                                                |

## Verifying success

`mint` mode prints `totalSupplyBefore`/`totalSupplyAfter`/`supplyDelta` and the minted coin id directly, so success is visible in its output. To double-check independently:

```bash
# 1. Confirm the tx succeeded
sui client tx-block <digest>

# 2. Confirm the recipient received Coin<USDC> (filter the JSON for the USDC type)
sui client balance 0x0000000000000000000000000000000000000000000000000000000000000abc --json \
  | jq '[.[0][][1][] | select(.coinType | endswith("::usdc::USDC"))]'
```

The acceptance criterion for this spike is: the recipient ends up with a `Coin<USDC>` at the real mainnet USDC package ID equal to `MINT_AMOUNT`, and total USDC supply increases by the same amount (proving a mint, not a transfer). This `sui-fork` build has no JSON-RPC `suix_getTotalSupply`; the script reads supply off the `TreasuryCap`'s `Supply` field (cap `content` BCS, bytes `[32..40]` u64-LE).

## If `mint` aborts

That's information, not a failure of the spike. Likely causes with this flow:

- **`configure_new_controller` aborts (already a controller).** The master minter was configured on a prior run; pass `USDC_MINT_CAP_ID=<id>` (printed earlier) to reuse it, or restart the fork. The script catches this and says so.
- **Mint allowance exhausted.** Each `treasury::mint` decrements the minter's allowance; `mint`/`setup` re-set it to `MINT_ALLOWANCE` so this shouldn't bite, but raise `MINT_ALLOWANCE` if needed.
- **Deny-list / pause flag.** The regulated-coin pattern lets the issuer pause issuance globally; if Circle has paused USDC, `configure_minter`/`mint` abort with `EPaused`. Nothing to do but note it.
- **Rotated roles/ids.** If Circle rotates the master minter or upgrades the package, re-derive per the header note and override via env vars.

## Capture for the migration

When this spike runs, paste back:

- Fork checkpoint
- `inspect` output (owner + type fields, confirming the seed worked)
- Tx digest
- Recipient's post-tx `Coin<USDC>` object ID and balance
- Pre- and post-tx total-supply values for USDC
- Anything Circle-specific the spike surfaced about the mint path

## POC results

**Finding (2026-06-04) — the configured naive path is disproven; the cap is wrapped.** `inspect` (now via the `sui` CLI / gRPC) against a `sui-fork` mainnet fork shows the `TreasuryCap<USDC>` is **not address-owned** — so `0x2::coin::mint` with `USDC_TREASURY_CAP_OWNER` declared as sender cannot work (you can't impersonate an _object_ as a transaction sender, and an object-owned cap can't be a plain owned input). This is the "Cap is wrapped" branch above, confirmed on-chain.

The custody chain (Circle's Sui stablecoin `treasury` framework, package `0xecf47609d7da919ea98e7fd04f6e0648a0a79b337aaad373fa37aac8febf19c8`):

| Object                | Type                                                                                      | Owner                                      |
| --------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------ |
| `0x677e41a5…6896dcc2` | `0x2::coin::TreasuryCap<…::usdc::USDC>`                                                   | `ObjectOwner` `0xdc55…fdd1f`               |
| `0xdc55ba85…b09fdd1f` | `0x2::dynamic_field::Field<dynamic_object_field::Wrapper<…treasury::TreasuryCapKey>, ID>` | `ObjectOwner` `0x57d6…4a6de7`              |
| `0x57d6725e…514a6de7` | `0xecf4760…::treasury::Treasury<…::usdc::USDC>`                                           | **`Shared`** (initial version `313333795`) |

So the cap lives as a dynamic object field under the **shared `Treasury<USDC>`** object `0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7`. `USDC_TREASURY_CAP_OWNER` (`0xdc55…`) in the config is that dynamic-field wrapper object, **not an address** — the spike's premise is wrong as written.

### Corrected path — VALIDATED end-to-end (2026-06-04)

Mint goes through Circle's `0xecf4760…::treasury` module against the shared `Treasury<USDC>`, which gates minting behind a controller → minter allowlist with a per-minter `MintCap<USDC>`. We validated the full **master-minter hijack** on the fork using only empty-signature impersonation — **fresh USDC was minted, total supply increased.**

**Roles discovery.** `Roles<T> = { data: Bag }`; role addresses are plain dynamic fields on that Bag (keyed `MasterMinterKey`, `OwnerKey`, …). The fork serves **no** dynamic-field enumeration (`sui client dynamic-field` h2-resets) and **no** `simulate_transaction`/dev-inspect, so getters are unusable. Instead, derive the field id offline and read it:

- The Roles `Bag` UID is `Treasury` contents bytes `[112..144]` (layout: `UID(32) + controllers:Table(40) + mint_allowances:Table(40) + roles.data:Bag(UID 32 + size 8) + …`) → `0x9ec7b95d…84a5`.
- ⚠️ **`dummy_field` gotcha:** the deployed mainnet package predates the current GitHub source — its key structs (`TreasuryCapKey`, `MasterMinterKey`, …) carry a `dummy_field: bool`, so their BCS key bytes are **`[0x00]`, not empty**. Using empty bytes derives the wrong id. (Validated against the known cap field: `deriveDynamicFieldID(0x57d6…, "0x2::dynamic_object_field::Wrapper<…::treasury::TreasuryCapKey>", [0]) == 0xdc55…`.)
- `deriveDynamicFieldID(0x9ec7…, "…::roles::MasterMinterKey", [0])` = `0x77596c98…b027`; that `Field<MasterMinterKey, address>`'s value (bytes `[33..65]`) is the **master minter `0x41c0c6d67577b39f31a5fe4052314fd3a8b7c7f890676f60e007bd390e397ac1`**.

**The hijack (3 empty-sig txs; master minter holds no SUI, so fund it first):**

| Step | Sender                     | Call                                                                                                                 | Digest                                         |
| ---- | -------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| TX0  | DEEP whale `0x9548…`       | split 1 SUI → transfer to master minter (gas)                                                                        | `DwTS5BCBhWzZ7tU87cEzH2hfDP1oixHguS1hMZbz9HQc` |
| TX1  | master minter `0x41c0…`    | `configure_new_controller<USDC>(treasury, MM, MM)` + `configure_minter<USDC>(treasury, denylist, 1_000_000_000_000)` | `6Nw8iMBkai6jG7JJPbeS78fnqG8aZNLS49CTmUvz8mpd` |
| TX2  | master minter (now minter) | `mint<USDC>(treasury, mintCap, denylist, 1_000_000_000, 0x…abc)`                                                     | `BfhTVk25VAwuDTEh5BMDatYzkPNTJmbW2zEKEMoRGZdX` |

Result: recipient `0x…abc` received `Coin<USDC>` `0x17f95299…7525` of balance `1000000000`; `TreasuryCap` total supply `307281976516739 → 307282976516739` (**+1_000_000_000 = 1000 USDC**). MintCap created: `0x52fcaba6…5a41`. DenyList is the system shared object `0x403`.

Key object/param reference:

| Role                                                | Value                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| stablecoin pkg (treasury/roles)                     | `0xecf47609d7da919ea98e7fd04f6e0648a0a79b337aaad373fa37aac8febf19c8` |
| `Treasury<USDC>` (shared)                           | `0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7` |
| master minter (gate for `configure_new_controller`) | `0x41c0c6d67577b39f31a5fe4052314fd3a8b7c7f890676f60e007bd390e397ac1` |
| DenyList (shared)                                   | `0x0000000000000000000000000000000000000000000000000000000000000403` |

**Fork gotchas hit (carry into the production USDC funding work):**

- **No enumeration of un-fetched mainnet state.** sui-fork lazily fetches objects on reference _by id_, but can't list an account's un-fetched objects — so on a fresh fork `sui client gas <donor>` is empty and PTB gas auto-selection fails (`Cannot find gas coin`). Reference the donor's SUI coin by a known id. Fork-local objects (e.g. a coin you just created/transferred) _do_ enumerate.
- **Use `--gas-coin` explicitly.** Even for fork-local coins the owned-coins query is intermittent (`sui client gas <addr>` randomly returns empty / `Failed to query availableRange`). Pass a known coin id via `--gas-coin`, and prefer reading freshly-created coin ids from tx effects over listing.
- **No dev-inspect / simulate, no dynamic-field listing.** Read state by deriving dynamic-field ids offline (`@mysten/sui`'s `deriveDynamicFieldID`) and `sui client object`, and parse BCS contents directly (TreasuryCap supply = contents `[32..40]` u64-LE).
- **Same-build CLI required** and **gRPC-not-JSON-RPC** as for the deep spike.

**For the production USDC funding work:** generalize this into `sandbox/scripts/utils/impersonation.ts` — derive the master minter from the Treasury, fund it from a SUI donor, run the 2-call configure tx, locate the `MintCap`, then mint per faucet request. The per-mint MintCap can be reused across requests once configured, so steps TX0/TX1 are one-time setup.
