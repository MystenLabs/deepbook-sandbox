# Codex Execution Plan: Update Pyth SUI/USD on a `sui-fork` Mainnet Fork

## Summary

Goal: mutate the live SUI/USD `PriceInfoObject` on a fresh `sui-fork` mainnet fork using a real Hermes accumulator update, then consume that updated object in a follow-up PTB or in the same PTB.

Use the whale address below for fork seeding and sender impersonation:

- `0xb4f42571101827758f55a9b998a1251892402fbd4dce90da3373625298091627`

The key execution constraint remains the same: `sui client ptb` can serialize unsigned transaction bytes, but impersonation happens only when those bytes are submitted to `sui-fork` with an empty signature list via `sui client execute-signed-tx --tx-bytes ...`.

Recommended build method: use a short one-off TypeScript helper to assemble the PTB and print base64 unsigned transaction bytes. Do not hand-assemble the accumulator-message parsing and nested PTB result wiring in shell.

## Prefetched Mainnet Data

Prefetched on May 14, 2026 from Pyth docs, Hermes, and live Sui mainnet RPC:

- Pyth State ID: `0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8`
- Current Pyth Package ID: `0x04e20ddf36af412a4096f9014f4a565af9e812db9a05cc40254846cf6ed0ad91`
- Pyth state object version: `880903491`
- Pyth state type prefix for dynamic-field lookups: `0x8d97f1cd6ac663735be08d1d2b6d02a159e711586461306ce60a2b7a6a565a9e`
- Pyth `base_update_fee`: `1` MIST per feed
- Pyth `stale_price_threshold`: `60` seconds
- Pyth `price_info` registry table ID: `0x234c9ffca44613ab87a2711325b6e17bad9ece0449b917c8bd9c0ad7a0506cc2`

- Wormhole State ID: `0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c`
- Current Wormhole Package ID: `0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a`
- Wormhole state object version: `880910981`
- Wormhole guardian set index: `6`

- Live mainnet SUI/USD feed ID: `0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744`
- Live mainnet SUI/USD `PriceInfoObject` ID: `0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37`
- Current SUI/USD `PriceInfoObject` version: `880916128`

Important correction: do not use `0x50c67b3fd225db8912a424dd4baed60ffdde625ed2feaaf283724f9608fea266` for mainnet SUI/USD. That value is not present in the live mainnet Pyth registry as of May 14, 2026.

## Execution Sequence

1. Build or locate `sui-fork`.

2. Start a fresh mainnet fork seeded with the whale address:

```bash
~/src/sui/target/debug/sui-fork start \
  --network mainnet \
  --data-dir /tmp/sui-fork-pyth \
  --address 0xb4f42571101827758f55a9b998a1251892402fbd4dce90da3373625298091627
```

3. Point the Sui CLI at the fork and confirm the whale has gas coins materialized on the fork:

```bash
sui client new-env --alias local-fork --rpc http://127.0.0.1:9000
sui client switch --env local-fork
sui client gas 0xb4f42571101827758f55a9b998a1251892402fbd4dce90da3373625298091627
```

4. Fetch a fresh Hermes accumulator update for the live mainnet SUI/USD feed ID:

```bash
SUI_USD_FEED_ID=0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744
```

Use Hermes update data for that feed only. Keep the raw accumulator message bytes available to the PTB builder.

5. Build an unsigned PTB with a small TypeScript helper that mirrors the current upstream Pyth Sui SDK flow exactly:

- Extract the embedded VAA bytes from the accumulator message.
- Call `wormhole::vaa::parse_and_verify(wormhole_state, vaa_bytes, &Clock)`.
- Call `pyth::create_authenticated_price_infos_using_accumulator(pyth_state, accumulator_message, verified_vaa, &Clock)`.
- Split gas into one fee coin of `1` MIST for the single SUI/USD update.
- Call `pyth::update_single_price_feed(pyth_state, hot_potato, &mut price_info_object, fee_coin, &Clock)`.
- Call `pyth::hot_potato_vector::destroy<pyth::price_info::PriceInfo>(hot_potato)`.

Use these concrete objects in the PTB:

- `pyth_state`: `0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8`
- `wormhole_state`: `0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c`
- `price_info_object`: `0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37`
- `clock`: `0x6`
- `sender`: `0xb4f42571101827758f55a9b998a1251892402fbd4dce90da3373625298091627`

The helper should:

- talk to the fork RPC at `http://127.0.0.1:9000`
- fetch the Hermes accumulator update for `0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744`
- build the PTB without signing
- set the sender to `0xb4f42571101827758f55a9b998a1251892402fbd4dce90da3373625298091627`
- serialize unsigned transaction bytes and print base64 to stdout

6. Serialize the PTB as unsigned transaction bytes. Do not sign it.

7. Submit those bytes through `sui-fork` with no signatures:

```bash
sui client execute-signed-tx --tx-bytes "$TX_B64"
```

This is the impersonation step. The empty signature list is what causes `sui-fork` to execute on behalf of the embedded sender.

8. After the update succeeds, either:

- run a second PTB that consumes `0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37`, or
- append the consuming call to the same PTB before destroying the hot-potato vector.

The second option is better if the goal is to exercise the exact "update then consume atomically" path.

## Critical Implementation Details

- The current upstream flow does not pass `WormholeState` directly into `pyth::create_authenticated_price_infos_using_accumulator`. Wormhole verification happens first via `wormhole::vaa::parse_and_verify`.
- The current upstream flow expects the full accumulator message bytes in `create_authenticated_price_infos_using_accumulator`, not just the VAA.
- `update_single_price_feed` charges the base fee once per feed. For this plan that means one fee coin with value `1`.
- The SUI/USD price object already exists on mainnet, so no create step is needed for this feed on May 14, 2026.
- If a future run finds a missing feed object, the one-time creation path is `pyth::create_price_feeds_using_accumulator(&mut PythState, accumulator_message, verified_vaa, &Clock, &mut TxContext)` before attempting the update PTB.
- The type prefix used in dynamic-field lookups is currently `0x8d97f1cd6ac663735be08d1d2b6d02a159e711586461306ce60a2b7a6a565a9e`, not the current package ID. That matters only if the implementer refreshes `PriceInfoObject` IDs directly from RPC.

## Verification

Success criteria:

- `sui client execute-signed-tx --tx-bytes ...` returns `Success`.
- `0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37` mutates to a version greater than `880916128`.
- The mutated object still carries feed ID `0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744`.
- The cached price timestamp is fresh relative to the fork clock.
- Re-running with a newer Hermes update succeeds again.
- A consuming call using `pyth::get_price_no_older_than(price_info_object, clock, 60)` succeeds after the update.

## Refresh Commands

Refresh the current Pyth state and fee data:

```bash
curl -sS https://fullnode.mainnet.sui.io:443 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getObject","params":["0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8",{"showContent":true}]}'
```

Refresh the `price_info` registry table:

```bash
curl -sS https://fullnode.mainnet.sui.io:443 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"suix_getDynamicFieldObject","params":["0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8",{"type":"vector<u8>","value":"price_info"}]}'
```

Refresh the live SUI/USD feed metadata:

```bash
curl -sS 'https://hermes.pyth.network/v2/price_feeds?query=SUI%2FUSD'
```

Refresh the live SUI/USD `PriceInfoObject` mapping:

```bash
curl -sS https://fullnode.mainnet.sui.io:443 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"suix_getDynamicFieldObject","params":["0x234c9ffca44613ab87a2711325b6e17bad9ece0449b917c8bd9c0ad7a0506cc2",{"type":"0x8d97f1cd6ac663735be08d1d2b6d02a159e711586461306ce60a2b7a6a565a9e::price_identifier::PriceIdentifier","value":{"bytes":[35,215,49,81,19,245,177,211,186,122,131,96,76,68,185,77,121,244,253,105,175,119,248,4,252,127,146,10,109,198,87,68]}}]}'
```

## References

- Pyth Sui contract addresses: <https://docs.pyth.network/price-feeds/core/contract-addresses/sui>
- Pyth Sui push-feed list: <https://docs.pyth.network/price-feeds/core/push-feeds/sui>
- Pyth Sui SDK source: <https://raw.githubusercontent.com/pyth-network/pyth-crosschain/main/target_chains/sui/sdk/js/src/client.ts>
- Pyth Sui Move source: <https://raw.githubusercontent.com/pyth-network/pyth-crosschain/main/target_chains/sui/contracts/sources/pyth.move>
