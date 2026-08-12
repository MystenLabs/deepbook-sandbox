# sui-fork issues found by the sandbox (upstream hand-off list)

Every sui-fork problem this repo has hit, in one place, so they can be filed
and fixed in the owning repo (`MystenLabs/sui`, `crates/sui-fork`; one devstack
item at the end). Each entry has a `devstack-patch`-labeled Linear ticket in
the "Education around Local Forking" project (SEDEFI-447-450 and 452-454; #7 was already
SEDEFI-358). Each entry: symptom → root cause → how the sandbox works
around it → the upstream fix we actually want. Deep-dives live in
[`scripts/spikes/devstack-funding/SUI-FORK-NOTES.md`](./scripts/spikes/devstack-funding/SUI-FORK-NOTES.md)
and [`scripts/spikes/deepbook/SUI-FORK-BUG.md`](./scripts/spikes/deepbook/SUI-FORK-BUG.md).

Findings are against rev `16f1402387c7ce0f9310e57610428efec930dbf4`
(sui main, 2026-07-08) forking mainnet unless noted; local mitigations live in the patched
image context (`scripts/spikes/devstack-funding/.fork-patched/images/sui-fork/`,
gitignored — the Dockerfile applies the patches at build time).

| #   | Issue                                                | Blast radius                              | Local mitigation                           | Upstream status                             |
| --- | ---------------------------------------------------- | ----------------------------------------- | ------------------------------------------ | ------------------------------------------- |
| 1   | `todo!()` index stubs SIGABRT the whole fork process | any RPC touching them kills the chain     | image patch: stubs → benign empties        | SEDEFI-447; sui#27520 (unmergeable, see #3) |
| 2   | execution-path child reads don't lazy-fetch          | most Move calls touching mainnet state    | pre-warm objects by id via gRPC            | SEDEFI-448                                  |
| 3   | fork-genesis regression on every rev after ~Jul 8    | can't bump the rev; blocks the #27520 fix | stay pinned to `16f1402387`                | SEDEFI-449                                  |
| 4   | protocol-130 framework skew panic-aborts execution   | any tx against post-2026-07-31 state      | `FORK_CHECKPOINT=304941000` pin            | SEDEFI-450                                  |
| 5   | `availableRange` phones home uncached                | flaky checkpoint reads, boots, indexer    | image patch: memoize first answer          | SEDEFI-452                                  |
| 6   | checkpoint timestamps frozen at the on-chain Clock   | fills invisible to time-windowed readers  | `pnpm clock:sync` / advance around trading | SEDEFI-453                                  |
| 7   | `simulate_transaction` unsupported                   | all SDK read paths (devInspect)           | none — SDK examples stay blocked           | SEDEFI-358 / sui#27520                      |
| 8   | (devstack) `advanceClock` mutation no-ops on fork    | silent — returns `ok: true`               | shell out to the `sui-fork` CLI            | SEDEFI-454                                  |

## 1. `todo!()` index stubs panic-abort the process

`RpcIndexes` in `crates/sui-fork/src/store.rs` (~1330–1390) leaves five
methods as `todo!("not supported yet")`: `get_coin_info`, `get_balance`,
`balance_iter`, `dynamic_field_iter`, `package_versions_iter`. The fork is
built to abort on panic, so ANY gRPC request that reaches one — a wallet
enriching balance changes, the devstack dashboard opening (GetBalance /
ListBalances), the dashboard pools table reading an object's dynamic fields —
SIGABRTs the entire chain (exit 134, no restart policy; everything downstream
then reports opaque dead-socket errors). We hit each of these live, weeks
apart, as new UI surfaces exercised new calls.

**Local:** the patched image rewrites them to `Ok(None)` / empty iterators.
**Upstream ask:** at minimum return recoverable errors (`CoinNotFound`, empty
pages) instead of `todo!()` — a process-killing panic is never acceptable for
a server fed arbitrary mainnet state. The #27520 storage rewrite removes the
stubs properly but cannot ship while #3 stands.

## 2. Execution-path child reads don't lazy-fetch

gRPC `GetObject` lazy-fetches and caches un-materialized mainnet objects, but
the same read DURING MOVE EXECUTION does not — `dynamic_field::borrow_child_object`
aborts with `EFieldDoesNotExist` (code 1) for objects that exist on mainnet.
Consequences hit constantly once you execute anything real: DeepBook
`place_limit_order` aborts on the pool's `Versioned` inner; crossing certain
pin-era makers aborts in `vec_set::remove` (the maker's account structures are
half-materialized); the original find (shared-object variant) is
`scripts/spikes/deepbook/SUI-FORK-BUG.md`.

**Local:** pre-warm every needed object by id with a gRPC read first
(`deriveDynamicFieldID` + `GetObject`); where the object set is unknowable
(deep book structures), skip the operation (see `scripts/seed-trades.ts`).
**Upstream ask:** route execution-time child/shared-object reads through the
same lazy-fetch path gRPC reads use.

## 3. Fork-genesis regression on every sui rev after ~2026-07-08

Forking mainnet on any rev after `16f1402387` (verified: `cbadbb78` Jul 24,
`fb7b6c2f` main Aug 4, and the #27520 branch head `eb46537f`) panics during
local genesis ("Creating accounts and token allocations") with a
`VMInvariantViolation` in `0x2::object` (`ObjectRuntime::new_id` via
`record_new_uid_from_hash`, unwrapped at `sui-genesis-builder/src/lib.rs:999`)
— eager seeding pulls mainnet system objects (e.g. `0x5`) into the store
before genesis re-creates those IDs. This is the reason we cannot adopt the
#27520 fix branch, and the Jul 8 → Jul 24 window is unbisected.

**Local:** stay pinned to `16f1402387` + carry the image patches.
**Upstream ask:** fix fork genesis vs eager seeding; this unblocks everything
else.

## 4. Protocol-130 framework skew panic-aborts execution

Mainnet's epoch-1205 upgrade (2026-07-31) shipped a protocol-130 framework
with `0x2::scratch`. The Jul-8 binary's `MAX_PROTOCOL_VERSION` covers 130, but that ceiling is
not the compiled framework snapshot, which predates the upgrade — so any tx against
post-upgrade state fails `MISSING_DEPENDENCY` on `0x2::scratch` and the
executor **panic-aborts the process** (`execution_status.rs:481` unwraps)
instead of returning an execution error.

**Local:** pin the fork to the last protocol-129 checkpoint
(`FORK_CHECKPOINT=304941000`, the shipped default).
**Upstream ask:** degrade to an error, and (longer-term) decouple the fork's
framework snapshot from the binary build date.

## 5. `availableRange` phones home on every checkpoint read

`get_lowest_available_checkpoint{,_objects}` (`store.rs:284–296`) issue LIVE
GraphQL queries against the public mainnet endpoint — uncached, two per call.
Bursts (dashboard explorer, indexer polling loops) trip the public rate limit
and surface as intermittent `Failed to query availableRange for type
'Checkpoint'`: the explorer's "the node rejected the checkpoint read", the
indexer's retry WARNs, and occasional boot failures (chain-id fetch races).

**Local:** the patched image memoizes the first successful answer per process
(sound: the value is a retention-window boundary that only matters relative to
the fixed fork checkpoint).
**Upstream ask:** cache it (or compute it once at startup) — a per-read
network dependency on a rate-limited public endpoint makes every consumer
flaky.

## 6. Checkpoint timestamps are frozen at the on-chain Clock

Fork-sealed checkpoints take `timestamp_ms` from the Clock object
(`rpc/forking_service.rs`), which starts at the pin's timestamp and never
advances on its own — so all fork activity is timestamped days in the past and
invisible to every wall-relative consumer (DeepBook server 24h windows, OHLCV
aggregation). `sui-fork advance-clock` is the only mover.

**Local:** `pnpm clock:sync` (scripts/sync-fork-clock.ts) brings the Clock to
wall time on demand — run it whenever "new" activity looks stale in the
explorer; `scripts/seed-trades.ts` also advances the clock towards (never
past) wall time around trading.
**Upstream ask:** an opt-in mode where the fork's Clock tracks wall time.

## 7. `simulate_transaction` unsupported

Tracked as SEDEFI-358 / sui#27520. Kills every SDK read path (devInspect under
the hood), which keeps `examples/sandbox` blocked and forced all sandbox
tooling onto offline-built PTBs with empty-signature impersonation.

## 8. devstack: `advanceClock` GraphQL mutation no-ops on fork mode

Not a sui-fork issue but part of the same story: the dashboard's
`advanceClock` mutation returns `ok: true` against a fork-mode stack without
moving the clock (devstack 0.7.0). The sandbox shells out to the `sui-fork`
CLI instead. Recorded with the other devstack asks on SEDEFI-444.
