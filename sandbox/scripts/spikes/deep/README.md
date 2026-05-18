# DEEP Spike — Transfer From an Impersonated Whale

This spike validates that empty-signature impersonation on a `sui-fork` mainnet network lets us transfer DEEP from a real on-chain holder we don't have a private key for. It's load-bearing for the production DEEP funding path: DEEP is fixed-supply with a `ProtectedTreasury` that intentionally locks the `TreasuryCap` away, so the sandbox cannot mint — it has to source DEEP by transferring from an existing holder.

## Backlog tickets

- **DBSF-001** — this spike (validate the mechanism).
- **DBSF-006** — formally pick the production donor address and document rationale + per-session ceiling.
- **DBSF-007** — generalize this pattern into `sandbox/scripts/utils/impersonation.ts` and replace the `transferCoin(deployer → MM)` calls in `deploy-all.ts`.
- **DBSF-008** — switch the faucet's DEEP path to the same mechanism.

## Why this works

`sui-fork` accepts transactions submitted with an **empty signature list** via `sui client execute-signed-tx --tx-bytes ...` and executes them as the declared sender. Because the donor's `Coin<DEEP>` objects are address-owned and the fork inherits mainnet's ownership graph, the donor can `splitCoins` and `transferObjects` from their own balance without ever signing anything — sui-fork stands in for the missing signature.

> **RPC note:** this `sui-fork` build serves the modern **gRPC** API on `--rpc-addr` (default `127.0.0.1:9000`), not the legacy JSON-RPC fullnode API. Raw JSON-RPC POSTs (`suix_getCoins`, `suix_getBalance`, …) return `404`. Everything here goes through the `sui` CLI, which speaks gRPC to the active env — so coin discovery, building, submitting, and verification all use `sui client ...` rather than `curl` against an RPC URL.

## Candidate donor

`0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d`

This is currently the largest DEEP holder on Sui mainnet. For the spike it's a fine choice — the spike just needs a donor with enough DEEP to make `splitCoins + transferObjects` succeed. **Formal production selection is DBSF-006**, which will document the donor's stability profile, the per-faucet-request ceiling, and the per-session ceiling, and choose either this address or a different one depending on what survives that audit (e.g. an LP wallet might be more stable than the literal top holder if the latter is an exchange).

## Files

| File                      | What it is                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `transfer-from-whale.mjs` | The spike script. Queries the donor's `Coin<DEEP>` objects via `sui client balance`, picks the largest, builds a `splitCoins + transferObjects` PTB, serializes unsigned, and submits via empty-sig `execute-signed-tx`. |

## How to run

### Prerequisites

- A `sui-fork` build from the Sui monorepo. The fork must be **started with `--address` seeding** for the donor so its `Coin<DEEP>` objects are materialized.
- `sui` CLI on `PATH` (or `SUI_BIN` env var) — **must be the exact same monorepo build as `sui-fork`** (same `--version`, e.g. both `1.74.0-<hash>`). Reads (coin discovery) tolerate a version skew because the gRPC LedgerService is stable, but the transaction-execution service is not: submitting with a mismatched CLI fails at `execute-signed-tx` with an HTTP/2 stream reset (`h2 protocol error ... Reset(StreamId, CANCEL, Remote)`), not a clean error. The monorepo usually only builds `sui-fork`; build the matching CLI with `cargo build --bin sui` from the same checkout and point `SUI_BIN` at `target/debug/sui`.
- Node ≥ 18.
- The `sui` CLI pointed at the fork (`sui client switch --env local-fork`) — the script shells out to it for coin discovery, building, and submitting.

### Start the fork seeded with the donor

```bash
sui-fork start \
  --network mainnet \
  --data-dir /tmp/sui-fork-deep-spike \
  --address 0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d
```

In another terminal, point the Sui CLI at the fork:

```bash
sui client new-env --alias local-fork --rpc http://127.0.0.1:9000
sui client switch --env local-fork
```

### Run the script

```bash
cd sandbox/scripts/spikes/deep

# Inspect mode — print the discovered donor coin and the resolved config
# without building anything. Useful first step to confirm seeding worked.
node transfer-from-whale.mjs inspect

# Print the PTB args that would be passed to `sui client ptb`
node transfer-from-whale.mjs ptb-args

# Build the unsigned PTB and print base64 tx bytes to stdout
node transfer-from-whale.mjs build

# Build + submit via empty-sig execute-signed-tx in one shot
node transfer-from-whale.mjs submit
```

### Env var overrides

| Env var           | Default                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `SUI_BIN`         | _(unset — falls back to `sui` on `PATH`; errors if not found)_                   |
| `DEEP_COIN_TYPE`  | `0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP` |
| `DEEP_DONOR`      | `0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d`             |
| `RECIPIENT`       | `0x0000000000000000000000000000000000000000000000000000000000000abc`             |
| `TRANSFER_AMOUNT` | `1000000000` (1000 DEEP at 6 decimals, raw units)                                |
| `GAS_BUDGET`      | `200000000`                                                                      |

If the `DEEP_COIN_TYPE` default is stale (mainnet DEEP package was re-published or upgraded since this was written), `inspect` mode will fail with "No `<type>` coins owned by `<donor>`" — override the env var to fix.

## Verifying success

After `submit`, the script prints the full JSON tx response. Manual checks via the `sui` CLI (this fork serves gRPC, not JSON-RPC — see the RPC note above, so use the CLI rather than `curl`):

```bash
# 1. Confirm the tx succeeded
sui client tx-block <digest>

# 2. Confirm the recipient now holds Coin<DEEP> (filter the JSON for the DEEP type)
sui client balance 0x0000000000000000000000000000000000000000000000000000000000000abc --json \
  | jq '[.[0][][1][] | select(.coinType | endswith("::deep::DEEP"))]'

# 3. Confirm the donor's balance dropped by the same amount
sui client balance "$DEEP_DONOR" --json \
  | jq '[.[0][][1][] | select(.coinType == "'"$DEEP_COIN_TYPE"'") | .balance | tonumber] | add'
```

The acceptance criterion for DBSF-001 is: the recipient ends up with a `Coin<DEEP>` at the real mainnet DEEP package ID equal to `TRANSFER_AMOUNT`, and the donor's balance drops by the same amount.

## Capture for the migration

When this spike runs, paste the following back into the migration plan / this README's "POC results" section (to be added):

- Fork checkpoint
- Tx digest
- Largest donor coin's pre-tx balance, post-tx balance
- Recipient's post-tx `Coin<DEEP>` object ID and balance
- Anything surprising (RPC failures, slow first-touch fetches, unexpected gas costs)

These data points unblock DBSF-007 with concrete numbers to plan against.

## POC results

**DBSF-001 validated — empty-sig impersonation transfers real mainnet DEEP on the fork.** Run on 2026-06-04 against a `sui-fork` mainnet fork (`sui-fork`/`sui` both `1.74.0-31537d4d9235`).

| Field                        | Value                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Fork                         | mainnet, epoch `1148`, checkpoint height ~`283010596` (started at latest, no `--checkpoint`)                          |
| Tx digest                    | `2FTkAHtLEf8kopFW8CtHci6J1tATdDbuvNZhbEkyi5uG`                                                                        |
| Status                       | `success`                                                                                                             |
| Sender                       | `0x9548…c70d` (the whale), **no signature** — executed via empty-sig `execute-signed-tx`                              |
| Donor source coin            | `0x9cf7988b…91615ff`: pre `4580129121380000` → post `4580128121380000` (−`1000000000`)                                |
| Donor total (this DEEP type) | pre `4583221556380000` → post `4583220556380000` (−`1000000000`)                                                      |
| Recipient post-tx coin       | `0x8984b95f…0921e6d4`, balance `1000000000` (real `0xdeeb7a4…::deep::DEEP`)                                           |
| Gas                          | computation `100000`, storage `3632800`, rebate `2287296` (net ~`1.45M` MIST), paid from the whale's own SUI gas coin |
| created / mutated            | 1 created (recipient coin) / 2 mutated (donor source coin + gas coin)                                                 |

**Surprises worth carrying into DBSF-007 / DBSF-008:**

1. **This `sui-fork` build serves gRPC, not legacy JSON-RPC.** The original `suix_getCoins` JSON-RPC `fetch` 404'd; coin discovery had to move to `sui client balance --json` (gRPC via the CLI). Plan the production impersonation util around the CLI/gRPC, not JSON-RPC.
2. **CLI and `sui-fork` must be the exact same monorepo build.** A `1.73.0` CLI against the `1.74.0` fork failed `execute-signed-tx` with an HTTP/2 stream reset (`Reset(StreamId, CANCEL, Remote)`) — reads still worked, so the skew was invisible until submit. The monorepo only builds `sui-fork`; the matching `sui` needs a separate `cargo build --bin sui`.
3. **Transient first-touch index error.** The first `sui client balance` after the CLI swap failed once with `Failed to query availableRange for type 'Checkpoint'` (the fork lazily fetches/indexes checkpoint data); an immediate retry succeeded. Production tooling should retry this class of internal error.
4. **The whale holds DEEP under three package addresses** (`0xdeeb7a4…`, `0x4e164bf…`, `0xf91e818…`). Exact-type filtering is mandatory — DBSF-006 should pin the canonical mainnet DEEP type, not match on `::deep::DEEP`.
5. **Gas is negligible** (~1.45M MIST net) and is paid from the donor's own SUI, so the donor must hold SUI as well as DEEP — a selection constraint for DBSF-006.
