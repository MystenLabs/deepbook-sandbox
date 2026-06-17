# sui-fork bug report — `GetCoinInfo` aborts the fork for migrated coins (DEEP/USDC): the shared `Currency` object is never materialized, and the index fallback is `todo!()`

## Summary

Executing **any non-SUI coin transfer (DEEP, USDC) through the fork's gRPC
`ExecuteTransaction` aborts the fork process** (SIGABRT; exit 134; the client
sees `RpcError: fetch failed`). Root cause is a two-part gap in `sui-fork`:

1. DEEP and USDC **are migrated** into the on-chain CoinRegistry — their
   `Currency<T>` objects exist on mainnet (DEEP: `0x3f2afb7c…`, **Shared**,
   `initial_shared_version 749938930`). `StateService.GetCoinInfo` is
   registry-first (`get_coin_info_from_registry` →
   `object_store.get_object(currencyId)`). But on the fork that **internal**
   store read does **not lazy-fetch** the shared `Currency`, so it returns
   `None`, and the call falls to `get_coin_info_from_index` →
   `RpcIndexes::get_coin_info`.
2. `RpcIndexes::get_coin_info` is **`todo!("not supported yet")`**
   (`crates/sui-fork/src/store.rs:1332`). So the registry-miss doesn't degrade to
   `CoinNotFound` — it **panics**, and the fork is built to abort on panic.

`GetCoinInfo` is invoked by the `@mysten/sui` v2 client whenever it enriches a
coin transfer's balance-changes — so the DEEP funding transfer trips it. (A bare
`getObject` on any coin-typed object trips it too.)

SUI is unaffected because its `Currency` is part of genesis state (already
materialized), so the registry path resolves and never reaches the index.

## Environment

- `sui-fork`: `1.74.0`, built from rev `62ee6ada958cd61b3c8a4466dd33c9aba3cdff8a` (devstack 0.1.1's pinned fork-image rev).
- Still present on latest `main` `8c1a5dbc40` (2026-06-13): `get_coin_info` and siblings (`get_balance`, `dynamic_field_iter`, `balance_iter`, `package_versions_iter`) are all `todo!()`; only one (unrelated) commit touched `crates/sui-fork` since the pinned rev. **Not fixed upstream.**
- Network: `--upstream mainnet`.

## The panic (fork container log)

```
sui_fork::startup: forked network running, waiting for shutdown signal (Ctrl+C)
thread 'tokio-rt-worker' panicked at crates/sui-fork/src/store.rs:1332:9:
not yet implemented: not supported yet
Aborted
```

## Evidence (all verified against a running fork on this spike)

| Check                                                                    | Result                                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `sui_getObject(DEEP Currency)` on mainnet                                | exists, `0x2::coin_registry::Currency<…DEEP>`, **Shared** @ `749938930`                                                                    |
| `suix_getCoinMetadata(DEEP)` on mainnet                                  | returns `0x3f2afb7c…` (the derived Currency id ⇒ served from the registry)                                                                 |
| gRPC `GetObject(currencyId)` on the fork                                 | **lazy-fetches + caches** it (returns `Currency<DEEP>` @ `749938930`) …                                                                    |
| gRPC `GetCoinInfo(DEEP)` on the fork _after_ that GetObject              | … now returns **real** info (`decimals 6, symbol DEEP, regulated`) — i.e. the internal read _does_ see a previously-materialized object    |
| `GetCoinInfo(DEEP)` / `ExecuteTransaction(DEEP transfer)` on a cold fork | **abort** (store.rs:1332) — the Currency was never materialized                                                                            |
| `--object <DEEP Currency>` fork seeding                                  | **refused**: `WARN sui_fork::seed: object seed is not owned by an address and will not be added to the seed manifest` (it's shared)        |
| `GetObject(DEEP Currency)` on a cold (unpatched) fork                    | **aborts** — the object is coin-typed, so the GetObject response enrichment itself calls the unimplemented `GetCoinInfo` (chicken-and-egg) |

The 3rd/4th rows are the key insight: a gRPC `GetObject` _would_ materialize the
shared Currency so the registry path resolves — but you can't issue that
`GetObject` on a cold fork without it self-aborting.

## Why the usual workarounds don't apply

The Currency must be **materialized** in the fork's store for the registry path
to resolve — but every way to do that on a stock fork is itself blocked:

- **Seeding (`--object`)** — refused for shared objects (`WARN sui_fork::seed:
object seed is not owned by an address`).
- **Priming via `getObject(currencyId)`** — self-aborts: the object is
  coin-typed, so the GetObject response enrichment calls the same `GetCoinInfo`.
- **Priming via a transaction** — also self-aborts at `store.rs:1332`. A no-coin
  `coin_registry::decimals<DEEP>(&Currency)` PTB (and folding that call into the
  funding PTB) was tried: referencing the coin-typed `Currency<DEEP>` as a tx
  input triggers the same `GetCoinInfo` during `ExecuteTransaction`. Verified.

Chicken-and-egg: you can't materialize the Currency without referencing it, and
any reference (read or tx-input) hits the unimplemented `GetCoinInfo`. Only a
sui-fork fix (below) unblocks a stock fork. (A gRPC `getObject` _does_ materialize
it once the abort is removed — see the evidence table — which is why the patch
works.)

## Suggested fix

1. **Lazy-fetch the shared `Currency` in the registry path** — make the
   `object_store.get_object(currencyId)` that `get_coin_info_from_registry` uses
   materialize the object from upstream (as the gRPC `GetObject` path already
   does). Then `GetCoinInfo` resolves the real registry entry for migrated coins.
   This is the same shared-object materialization gap as the DeepBook admin-cap
   spike's bug (`sandbox/scripts/spikes/deepbook/SUI-FORK-BUG.md`).
2. **And/or implement `RpcIndexes::get_coin_info`** (the index fallback) to read
   coin metadata lazily.
3. **At minimum, don't `todo!()`-panic** — return `Ok(None)` so `GetCoinInfo`
   answers `CoinNotFound` (a normal gRPC status) instead of aborting the process.
   Same for `get_balance` / `balance_iter` / `dynamic_field_iter` /
   `package_versions_iter`. Turning a process-killing panic into a recoverable
   error is the floor for a tool that serves arbitrary mainnet state.
4. Optional: let `--object` seeding accept shared objects, so the Currency can be
   pre-seeded as a stopgap.

## Impact

- Blocks **devstack fork-mode funding of any migrated non-SUI coin** (DEEP,
  USDC) — the live path for the DEEP/USDC funding-strategy plugins. SUI funding is unaffected.
- Any consumer that reads coin info / balances for such a coin against the fork
  crashes it.

## Workaround (validated)

`.fork-patched/` rebuilds the fork image with fix #3 (`get_coin_info → Ok(None)`;
a one-line `sed` in the image's `Dockerfile`). With the abort removed:

- the DEEP transfer settles and `account('alice')` ends up holding **100 DEEP**
  (confirmed by devstack's settlement check and an independent `listCoins`); and
- a follow-up `GetObject(currencyId)` then makes `GetCoinInfo(DEEP)` return the
  real registry metadata — i.e. once the process doesn't die, the registry path
  works as designed. Fix #1 is the durable answer.

Run it: `FORK_IMAGE_CONTEXT="$PWD/.fork-patched/images" pnpm devstack up`.
