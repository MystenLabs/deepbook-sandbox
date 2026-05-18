# Pyth Spike — Real Hermes VAA Flow Against Forked Mainnet

This spike validates that the deepbook-sandbox can replace its mock `pyth::pyth` Move package by submitting **real Hermes-signed VAAs** to the forked `wormhole::State` on a `sui-fork` mainnet network. It also covers the `advance-clock` mitigation for the price-freshness check that `pyth::get_price_no_older_than` does against the on-chain `Clock`.

## Backlog tickets

- **DBSF-005** — Adopt this POC into the repo (✅ this folder).
- **DBSF-004** — Use the script here as the reference for the `advance-clock` + Pyth update integration spike.

## Why this works

Wormhole VAA signatures are produced off-chain by guardians and are **not bound to any destination chain**. The signed payload contains an emitter chain, an emitter address, a sequence number, a timestamp, a nonce, the price update bytes, and a consistency level — nothing about _where_ the VAA is consumed. As long as the forked `wormhole::State` knows about the guardian set Hermes is currently signing with (which it will, if the fork checkpoint is recent), a fresh Hermes VAA verifies byte-for-byte on the fork the same way it does on mainnet.

See `problem.md` for the longer write-up.

## Files

| File                            | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `problem.md`                    | Research notes — establishes the "VAAs are not chain-bound" insight, the high-level Hermes → PTB → fork flow, and the two practical gotchas (clock drift, guardian rotation). No code.                                                                                                                                                                                                                                                                                                                                                                            |
| `codex-execution-plan.md`       | Operational recipe — locks down the specific mainnet object IDs (Pyth State, Wormhole State, package IDs, SUI/USD `PriceInfoObject`, feed ID), the whale address to impersonate, the 8-step sequence to run the POC, and the critical implementation details that aren't obvious from Pyth's docs (e.g. that `create_authenticated_price_infos_using_accumulator` takes the _full accumulator message bytes_ and a _separately-verified_ VAA, not `WormholeState`). Includes refresh commands for re-fetching the IDs if Pyth or Wormhole upgrade their packages. |
| `build-pyth-suiusd-fork-tx.mjs` | The working implementation (~220 lines). Fetches the accumulator update from `hermes.pyth.network/v2/updates/price/latest`, parses out the embedded VAA bytes, builds the PTB with `parse_and_verify` → `create_authenticated_price_infos_using_accumulator` → `splitCoins` (1 MIST fee) → `update_single_price_feed` → `hot_potato_vector::destroy`, serializes unsigned, and submits via `sui client execute-signed-tx` for empty-sig impersonation.                                                                                                            |

## Original POC results (2026-05-14, validated by Stefan)

- Fork: mainnet at checkpoint **275561499**
- Sender: whale `0xb4f42571101827758f55a9b998a1251892402fbd4dce90da3373625298091627`, impersonated via empty-sig
- Tx digest: **`BBJ3ksPyouDe4YKx4zG1oJGK7xQr5WWT9jxBGnc9nK3a`** (landed in checkpoint 275561500)
- SUI/USD `PriceInfoObject` `0x801dbc…6c37` mutated from version **880933128 → 880933129**, emitted `PriceFeedUpdateEvent`
- Downstream consumption verified with `pyth::get_price_no_older_than(clock, 3600)` (success). The same call with `max_age = 60` aborted on `check_price_is_fresh` — this is the clock-drift symptom DBSF-004 exists to fix.

## How to run

### Prerequisites

- `sui-fork` and `sui` binaries from the same monorepo build. Either put both on your `PATH`, or set `SUI_BIN` to the absolute path of the `sui` binary. The script errors with a helpful message if neither is available.
- Node ≥ 18 (the script uses `fetch` natively).

### Start the fork

```bash
sui-fork start \
  --network mainnet \
  --data-dir /tmp/sui-fork-pyth \
  --address 0xb4f42571101827758f55a9b998a1251892402fbd4dce90da3373625298091627
```

In another terminal, point the Sui CLI at the fork:

```bash
sui client new-env --alias local-fork --rpc http://127.0.0.1:9000
sui client switch --env local-fork
```

### Run the script

```bash
cd sandbox/scripts/spikes/pyth

# Just build the unsigned PTB and print base64 tx bytes:
node build-pyth-suiusd-fork-tx.mjs build

# Or print the PTB args (for debugging):
node build-pyth-suiusd-fork-tx.mjs ptb-args

# Build + submit via execute-signed-tx in one shot:
node build-pyth-suiusd-fork-tx.mjs submit
```

The script accepts these env vars for retargeting (defaults are the verified mainnet 2026-05-14 values):

| Env var                | Default                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| `SUI_BIN`              | _(unset — falls back to `sui` on `PATH`; errors if not found)_                 |
| `PYTH_STATE_ID`        | `0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8`           |
| `PYTH_PACKAGE_ID`      | `0x04e20ddf36af412a4096f9014f4a565af9e812db9a05cc40254846cf6ed0ad91`           |
| `PYTH_TYPE_PREFIX`     | `0x8d97f1cd6ac663735be08d1d2b6d02a159e711586461306ce60a2b7a6a565a9e`           |
| `WORMHOLE_STATE_ID`    | `0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c`           |
| `WORMHOLE_PACKAGE_ID`  | `0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a`           |
| `PRICE_INFO_OBJECT_ID` | `0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37` (SUI/USD) |
| `PYTH_FEED_ID`         | `0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744` (SUI/USD) |
| `SENDER`               | `0xb4f42571101827758f55a9b998a1251892402fbd4dce90da3373625298091627`           |
| `CLOCK_OBJECT_ID`      | `0x6`                                                                          |
| `BASE_UPDATE_FEE`      | `1` (MIST)                                                                     |
| `GAS_BUDGET`           | `200000000`                                                                    |

To verify the update consumed correctly, run a follow-up PTB:

```bash
sui client ptb \
  --move-call 0x04e20ddf36af412a4096f9014f4a565af9e812db9a05cc40254846cf6ed0ad91::pyth::get_price_no_older_than \
    @0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37 \
    @0x6 \
    3600
```

If you get `pyth::check_price_is_fresh` aborted with code 3 at `max_age = 60`, that's the clock-drift symptom — DBSF-004 fixes it by calling `sui-fork advance-clock` before the update.

## Generalizing for DEEP and USDC

The script is feed-agnostic. Flip `PYTH_FEED_ID` and `PRICE_INFO_OBJECT_ID` env vars to update other feeds. DEEP/USD and USDC/USD `PriceInfoObject` IDs are resolved as part of DBSF-012 and will be wired in here when known.

## What to do after this spike passes

- Update the migration plan's §4 with any new mainnet object IDs or refinements.
- Move to DBSF-004 (advance-clock integration) — extend the script or write a sibling that adds the `sui-fork advance-clock --duration-ms <delta>` step before submission.
- The production version of this loop lands in `sandbox/scripts/oracle-service/` under DBSF-013.
