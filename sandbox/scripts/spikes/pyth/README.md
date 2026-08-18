# Pyth Spike — Real Hermes VAA Flow Against Forked Mainnet

This spike validates that the deepbook-sandbox can replace its mock `pyth::pyth` Move package by submitting **real Hermes-signed VAAs** to the forked `wormhole::State` on a `sui-fork` mainnet network. It also covers the `advance-clock` mitigation for the price-freshness check that `pyth::get_price_no_older_than` does against the on-chain `Clock`.

## Spikes covered here

- **Adopted Pyth POC** — the POC brought into the repo (✅ this folder; files `problem.md`, `codex-execution-plan.md`, `build-pyth-suiusd-fork-tx.mjs`).
- **advance-clock + Pyth update integration** (✅ `advance-clock-and-update-pyth.mjs`). Builds on the adopted Pyth POC to validate the clock-drift fix that makes mainnet's 60-second freshness contract work on the fork.

## Why this works

Wormhole VAA signatures are produced off-chain by guardians and are **not bound to any destination chain**. The signed payload contains an emitter chain, an emitter address, a sequence number, a timestamp, a nonce, the price update bytes, and a consistency level — nothing about _where_ the VAA is consumed. As long as the forked `wormhole::State` knows about the guardian set Hermes is currently signing with (which it will, if the fork checkpoint is recent), a fresh Hermes VAA verifies byte-for-byte on the fork the same way it does on mainnet.

See `problem.md` for the longer write-up.

## Files

| File                                | Spike                | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `problem.md`                        | adopted Pyth POC     | Research notes — establishes the "VAAs are not chain-bound" insight, the high-level Hermes → PTB → fork flow, and the two practical gotchas (clock drift, guardian rotation). No code.                                                                                                                                                                                                                                                                                                                                                                            |
| `codex-execution-plan.md`           | adopted Pyth POC     | Operational recipe — locks down the specific mainnet object IDs (Pyth State, Wormhole State, package IDs, SUI/USD `PriceInfoObject`, feed ID), the whale address to impersonate, the 8-step sequence to run the POC, and the critical implementation details that aren't obvious from Pyth's docs (e.g. that `create_authenticated_price_infos_using_accumulator` takes the _full accumulator message bytes_ and a _separately-verified_ VAA, not `WormholeState`). Includes refresh commands for re-fetching the IDs if Pyth or Wormhole upgrade their packages. |
| `build-pyth-suiusd-fork-tx.mjs`     | adopted Pyth POC     | Stefan's working implementation (~220 lines). Fetches the accumulator update from `hermes.pyth.network/v2/updates/price/latest`, parses out the embedded VAA bytes, builds the PTB with `parse_and_verify` → `create_authenticated_price_infos_using_accumulator` → `splitCoins` (1 MIST fee) → `update_single_price_feed` → `hot_potato_vector::destroy`, serializes unsigned, and submits via `sui client execute-signed-tx` for empty-sig impersonation.                                                                                                       |
| `advance-clock-and-update-pyth.mjs` | advance-clock + Pyth | Orchestration spike that wraps the same Pyth update flow with a `sui-fork advance-clock` pre-step. Reads current Clock via `sui-fork --json status`, fetches Hermes, computes the delta to bring Clock up to `publish_time`, advances the fork, submits the update, then runs a verification PTB calling `pyth::get_price_no_older_than(price_info, clock, 60)` to confirm the 60-second freshness check passes without the 3600s relaxation Stefan's POC needed. This is the reference loop the production oracle-service will run on a timer.                   |

## The three-step tick (advance-clock + Pyth reference loop)

The new oracle-service will run this loop on a timer. The spike script `advance-clock-and-update-pyth.mjs` is the runnable reference.

1. **Read current Clock.** `sui-fork --json status` returns `timestamp_ms` for the fork's on-chain `Clock` object.
2. **Fetch the latest Hermes update** for the target feed. The response carries both the accumulator binary (for the PTB) and the `publish_time` (in seconds, in `parsed[0].price.publish_time` — request with `parsed=true` to get it). Convert to ms.
3. **Compute the delta**: `target = publish_time_ms + slack ; delta = max(0, target - clock_now)`. If `delta > 0`, call `sui-fork advance-clock --duration-ms <delta>`. This atomically bumps `Clock` and seals a new checkpoint with the matching `timestamp_ms` (verified against `src/rpc/forking_service.rs`). After the call, `Clock.now ≈ publish_time`.
4. **Submit the Pyth update PTB.** Same five-call PTB as Stefan's POC — `parse_and_verify` → `create_authenticated_price_infos_using_accumulator` → `splitCoins` for the 1-MIST fee → `update_single_price_feed` → `hot_potato_vector::destroy`. Empty-sig impersonation as the configured whale.
5. **(Verification in the spike, not in production)** Submit a one-call PTB invoking `pyth::get_price_no_older_than(price_info, clock, 60)`. If it succeeds, the 60s freshness check passed and the clock-drift fix is doing its job. Without the advance-clock pre-step, this exact call aborts on `check_price_is_fresh` — that's the failure mode Stefan documented in the original POC results below.

The mitigation preserves mainnet's real 60-second freshness contract end-to-end, so DeepBook integration tests run with the same `max_age` mainnet uses instead of a relaxed sandbox-only value.

## Original POC results (2026-05-14, validated by Stefan)

- Fork: mainnet at checkpoint **275561499**
- Sender: whale `0xb4f42571101827758f55a9b998a1251892402fbd4dce90da3373625298091627`, impersonated via empty-sig
- Tx digest: **`BBJ3ksPyouDe4YKx4zG1oJGK7xQr5WWT9jxBGnc9nK3a`** (landed in checkpoint 275561500)
- SUI/USD `PriceInfoObject` `0x801dbc…6c37` mutated from version **880933128 → 880933129**, emitted `PriceFeedUpdateEvent`
- Downstream consumption verified with `pyth::get_price_no_older_than(clock, 3600)` (success). The same call with `max_age = 60` aborted on `check_price_is_fresh` — this is the clock-drift symptom the advance-clock + Pyth spike exists to fix.

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

The `--address` seed is optional for `advance-clock-and-update-pyth.mjs` — its `run` mode auto-funds the sender (see the gas note below). It still matters for the original POC script (`build-pyth-suiusd-fork-tx.mjs`), which doesn't auto-fund.

In another terminal, point the Sui CLI at the fork:

```bash
sui client new-env --alias local-fork --rpc http://127.0.0.1:9000
sui client switch --env local-fork
```

### Run the original POC script (adopted Pyth POC)

```bash
cd sandbox/scripts/spikes/pyth

# Just build the unsigned PTB and print base64 tx bytes:
node build-pyth-suiusd-fork-tx.mjs build

# Or print the PTB args (for debugging):
node build-pyth-suiusd-fork-tx.mjs ptb-args

# Build + submit via execute-signed-tx in one shot:
node build-pyth-suiusd-fork-tx.mjs submit
```

### Run the orchestration spike (advance-clock + Pyth)

```bash
cd sandbox/scripts/spikes/pyth

# Dry-run: show current clock, fetched publish_time, and the
# advance-clock delta the script would apply. No transactions submitted.
node advance-clock-and-update-pyth.mjs inspect

# Full run: status → Hermes fetch → advance-clock → submit Pyth
# update → verify with get_price_no_older_than(clock, 60).
node advance-clock-and-update-pyth.mjs run
```

`run` mode logs each step to stderr as a JSON line so you can pipe the script through `| jq` for structured progress. The final result (success or the abort reason) is written to stdout.

**Gas is automatic.** The impersonated `SENDER` holds no enumerable SUI on a fresh fork, so PTB gas auto-selection would fail with "Cannot find gas coin". `run` funds the sender 1 SUI from the donor whale (referenced by id) before submitting; pass `SENDER_GAS_COIN` to use an existing coin instead. (`inspect` submits nothing, so it never funds.)

**Validated 2026-06-11 on a plain fresh fork** (no `--object` seeding): Clock advanced 53s to match a Hermes VAA, `update_single_price_feed` landed (`status: success`), and the `get_price_no_older_than(price_info, clock, 60)` verify **passed at 60s**. Unlike the DeepBook Registry (see `../deepbook/SUI-FORK-BUG.md`), the Pyth/Wormhole shared objects did **not** trip sui-fork's stale-shared-object / bounded-read bug, so no seeding is needed here. If a future run _does_ hit that panic (`h2` stream reset, `read_child_object does not yet support bounded reads`), seed the relevant shared object with `--object` per that bug report.

> **Superseded 2026-08-14 (SEDEFI-317): the "no seeding is needed" line above holds only for a fork of the LIVE TIP.** Re-run at the `FORK_CHECKPOINT` pin this repo now defaults to, the same script fails twice: input-object checking rejects the update PTB with `Dependent package not found on-chain: 0x8d97f1cd…` (the pyth ORIGINAL package, the type-tag address), and with that read, execution aborts in `wormhole::package_utils::assert_version` (code 1). Neither is package skew — both package ids were verified current at the pin (wormhole UpgradeCap version 1, latest == original; pyth version 2 == the id below). Both are SUI-FORK-ISSUES #2: `assert_version` and `parse_and_verify` read **children** (each State's `Field<CurrentPackage, PackageInfo>`, and guardian set 7 out of a `Table`) that the execution path never lazy-fetches. Read the five ids pinned under `pyth.prewarm` in `deployments/mainnet-fork.json` once by id first and the same PTB lands: update `Efb7Ud4oYK1UkTmnZCtutLkmR7KVBi4TDecsVUxRMbvw`, verify `9woKJBNJt2WsQGHL4PxVZMZ4yJi8db8NobzDXzig8o1d`, `get_price_no_older_than(clock, 60)` green. Two other things that run showed: the fork's `guardian_set_index` (7) still matches what Hermes signs with, so no rotation recovery is needed at this pin; and with the `clock-driver` member holding the Clock at wall, `clockAdvancedByMs` was **0** — the advance-clock step is now a cold-start correction, not a per-tick one.

Additional env vars beyond the table below specific to this script:

| Env var                  | Default                                                              | What it does                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUI_FORK_BIN`           | _(unset — falls back to `sui-fork` on `PATH`; errors if not found)_  | Path to the sui-fork binary.                                                                                                                            |
| `FORK_RPC_URL`           | `http://127.0.0.1:9000`                                              | RPC addr passed to `sui-fork status` / `advance-clock`. Point it at your fork's `--rpc-addr`.                                                           |
| `MAX_AGE_SECS`           | `60`                                                                 | Freshness window for the verification PTB. The whole point of the spike is to make `60` succeed.                                                        |
| `ADVANCE_CLOCK_SLACK_MS` | `100`                                                                | Small safety margin added to the delta so `Clock.now` ends up slightly ahead of `publish_time` — keeps the freshness check robust against any rounding. |
| `SENDER_GAS_COIN`        | _(unset — `run` auto-funds the sender from the donor if not given)_  | Explicit SUI gas coin owned by `SENDER`.                                                                                                                |
| `SUI_DONOR`              | `0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d` | SUI source that funds the gas-less sender.                                                                                                              |
| `SUI_DONOR_GAS_COIN`     | `0xc866352dd2574aa14752dd09afca89cd993f573c59218ff278c3dafbd24ca714` | A SUI coin owned by `SUI_DONOR`, referenced by id (a fresh fork can't enumerate it).                                                                    |
| `FUND_AMOUNT`            | `1000000000`                                                         | MIST sent to the sender for gas (1 SUI).                                                                                                                |

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

If you get `pyth::check_price_is_fresh` aborted with code 3 at `max_age = 60`, that's the clock-drift symptom — the advance-clock + Pyth spike fixes it by calling `sui-fork advance-clock` before the update.

## Generalizing for DEEP and USDC

The script is feed-agnostic. Flip `PYTH_FEED_ID` and `PRICE_INFO_OBJECT_ID` env vars to update other feeds. DEEP/USD and USDC/USD `PriceInfoObject` IDs will be wired in here once the mainnet feed objects are resolved.

## What to do after these spikes pass

- Update the migration plan's §4 with any new mainnet object IDs, refinements, or surprises uncovered while running against a fresh fork.
- The production version of the orchestration loop lands in `sandbox/scripts/oracle-service/` as the production oracle-service — generalized for SUI/DEEP/USDC feeds, with a polling timer instead of the single-shot `run` mode here.
