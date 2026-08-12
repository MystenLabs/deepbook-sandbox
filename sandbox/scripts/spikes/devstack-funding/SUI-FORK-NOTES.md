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

- `sui-fork`: built from rev `16f1402387c7ce0f9310e57610428efec930dbf4` (sui `main`, 2026-07-08; MAX_PROTOCOL_VERSION 130, covers current mainnet protocol 130 by version number — but not its framework, see the protocol-130 skew bullet below; includes PR #26966's child-read fix), passed to the patched Dockerfile as `SUI_FORK_REV` (devstack 0.7.0's own default is still the older `62ee6ada`, protocol max v125, which can't fork current mainnet — see [[sui-fork-protocol-version-lag]]).
- **Still NOT fixed upstream** at that rev: `get_coin_info` and siblings (`get_balance`, `dynamic_field_iter`, `balance_iter`, `package_versions_iter`) remain `todo!()` (`store.rs:1360`), so this bug (and our `get_coin_info -> Ok(None)` patch) still stands. PR #26966 fixed a _different_ sui-fork bug (the dynamic-field/child-read `STORAGE_ERROR`; see `../deepbook/SUI-FORK-BUG.md`), which is why we bumped to its merge commit — it's orthogonal to the coin-info panic.
- **Protocol-130 framework skew (hit 2026-08-04):** mainnet upgraded to the
  protocol-130 framework at epoch 1205 (2026-07-31), whose on-chain `0x2`
  includes the new `scratch` module. The `16f1402387` binary (Jul 8 snapshot,
  pre-`scratch`) cannot verify it — executing ANY transaction against
  post-upgrade state fails with `MISSING_DEPENDENCY` on `0x2::scratch` and the
  executor **panic-aborts the process** (`execution_status.rs:481` unwraps the
  failure) instead of returning an error. Remedy while upstream is broken (see
  next bullet): pin the fork to a pre-upgrade checkpoint — both
  `devstack-plugins` configs (production + `__tests__`) default
  `FORK_CHECKPOINT=304941000` (tail of epoch 1204, protocol 129; funding e2e
  green there 2026-08-04). `FORK_CHECKPOINT=latest` unpins. The spike config
  in this directory remains unpinned.
- **Fork-genesis regression on newer sui (hit 2026-08-04):** bumping
  `SUI_FORK_REV` past the framework skew is NOT currently possible — sui `main`
  regressed fork startup somewhere between `16f1402387` (Jul 8, works) and
  `cbadbb78` (Jul 24, broken): forking mainnet now panics during local genesis
  ("Creating accounts and token allocations") with a `VMInvariantViolation` in
  `0x2::object` (`ObjectRuntime::new_id` via `record_new_uid_from_hash`,
  `sui-move-natives/src/object.rs:137`, unwrapped at
  `sui-genesis-builder/src/lib.rs:999`) — the fork pre-seeds mainnet system
  objects (e.g. `0x5`) before genesis runs, and genesis then re-creates those
  IDs. Verified broken at `cbadbb78` (Jul 24), `fb7b6c2f62` (main head
  2026-08-04), and the fix-branch head `eb46537f`. The Jul 24 hardening commit
  `4d660d2b8d` is NOT the cause (its parent already fails). The Jul 8 → Jul 24
  window is unbisected — a rev in it whose framework snapshot already carries
  `0x2::scratch` (added Jul 10, `59cb8cc352`) but predates the genesis breaker
  would remove the need for the checkpoint pin; worth bisecting if upstream
  stalls (~30-60 min compile per probe).
- **Fix-branch status (tested 2026-08-03):** the upstream rewrite branch
  `fork-rpc-store-simulate-transaction` (PR MystenLabs/sui#27520, head
  `eb46537f`, 135 commits ahead of main) removes the `todo!()` stubs and keeps
  the same CLI, but its head **aborts during fork startup** — the new eager
  seeding materializes mainnet system objects (e.g. `0x5`) into the local store
  before the local genesis runs, and `generate_genesis_system_object` then
  panics with a `VMInvariantViolation` in `0x2::object`
  (`ObjectRuntime::new_id`, `sui-move-natives/src/object.rs:137`, via
  `sui-genesis-builder/src/lib.rs:999`) at "Creating accounts and token
  allocations". So the branch cannot boot this stack yet; the patched-main
  image below remains required. `./build-branch-fork.sh` builds an image from
  the branch (context `.fork-branch/images`, no patch) for retesting as it
  evolves — point the e2e at it with
  `FORK_IMAGE_CONTEXT=$PWD/.fork-branch/images SUI_FORK_REV=<branch sha>`.
  (devstack's `image: {pull}` is a bare `docker pull`, so locally built images
  must enter via the build context, not `DEVSTACK_SUI_FORK_IMAGE`.)
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

`.fork-patched/` rebuilds the fork image with fix #3 — originally just
`get_coin_info → Ok(None)`, since extended to ALL the observed-fatal stubs
(each a `sed` in the image's `Dockerfile`): `get_balance → Ok(None)` and
`balance_iter → empty` (the dashboard fires GetBalance/ListBalances on open;
hit 2026-08-10), then `dynamic_field_iter → empty` and
`package_versions_iter → empty` (the dashboard's DeepBook pools table reads
each pool object + its first dynamic-field page, panic at `store.rs:1357`;
hit 2026-08-12 the moment pools were pinned into the resolved member). With
the aborts removed:

- the DEEP transfer settles and `account('alice')` ends up holding **100 DEEP**
  (confirmed by devstack's settlement check and an independent `listCoins`); and
- a follow-up `GetObject(currencyId)` then makes `GetCoinInfo(DEEP)` return the
  real registry metadata — i.e. once the process doesn't die, the registry path
  works as designed. Fix #1 is the durable answer.

Run it: `FORK_IMAGE_CONTEXT="$PWD/.fork-patched/images" pnpm devstack up`.

### Building the patched image (local source)

`./build-patched-fork.sh` builds the patched image from a **local** sui checkout
(`git archive <rev>` → the build context), then `docker build`s it. This avoids
cloning the multi-GB sui monorepo inside Docker (which drops on a flaky
connection); only cargo's crate/git-deps still need the network during the
`cargo build`. Building to completion populates BuildKit's layer cache, so a
later `pnpm test:e2e` reuses the cargo layer instead of recompiling (~20-30 min).

```bash
SUI_REPO=/path/to/sui SUI_FORK_REV=<rev> ./build-patched-fork.sh
# default rev = b124567746… (the merge commit of MystenLabs/sui#26966); pass
# origin/main for the latest. The .fork-patched/images Dockerfile COPYs the
# generated sui-fork/sui-src.tar instead of cloning.
```
