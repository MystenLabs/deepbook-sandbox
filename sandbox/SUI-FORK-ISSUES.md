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

| #   | Issue                                                | Blast radius                                 | Local mitigation                            | Upstream status                             |
| --- | ---------------------------------------------------- | -------------------------------------------- | ------------------------------------------- | ------------------------------------------- |
| 1   | `todo!()` index stubs SIGABRT the whole fork process | any RPC touching them kills the chain        | image patch: stubs → benign empties         | SEDEFI-447; sui#27520 (unmergeable, see #3) |
| 2   | execution-path child reads don't lazy-fetch          | most Move calls touching mainnet state       | pre-warm objects by id via gRPC             | SEDEFI-448                                  |
| 3   | fork-genesis regression on every rev after ~Jul 8    | can't bump the rev; blocks the #27520 fix    | stay pinned to `16f1402387`                 | SEDEFI-449                                  |
| 4   | protocol-130 framework skew panic-aborts execution   | any tx against post-2026-07-31 state         | `FORK_CHECKPOINT=304941000` pin             | SEDEFI-450                                  |
| 5   | `availableRange` phones home uncached                | flaky checkpoint reads, boots, indexer       | image patch: memoize first answer           | SEDEFI-452                                  |
| 6   | checkpoint timestamps frozen at the on-chain Clock   | fills invisible to time-windowed readers     | `pnpm clock:sync` / advance around trading  | SEDEFI-453                                  |
| 7   | `simulate_transaction` unsupported                   | all SDK read paths (devInspect)              | none — SDK examples stay blocked            | SEDEFI-358 / sui#27520                      |
| 8   | (devstack) `advanceClock` mutation no-ops on fork    | silent — returns `ok: true`                  | shell out to the `sui-fork` CLI             | SEDEFI-454                                  |
| 9   | fresh-chain first commit panic-aborts (framework)    | first fork-local commit on a fresh chain     | registry-init pre-warms 0x1/0x2/0x3/0x5/0x6 | new (SEDEFI-456 find) — ticket TBD          |
| 10  | a Bag entry can go permanently unreadable (VM + RPC) | that coin's deposits vanish; its sells abort | none — abandon the poisoned BalanceManager  | new (SEDEFI-459/460 find) — ticket TBD      |

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
For a DeepBook pool the set IS enumerable, so the dashboard now walks it:
`prewarmPoolBook` (`dashboard/src/lib/fork.ts`) reads the pool's `Versioned`
inner, then both `BigVector` order books root-slice-first down to every leaf,
before any order is built. Without it a market order that crosses
mainnet-inherited liquidity aborts the moment matching reaches an unread leaf.
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

## 9. Fresh-chain first commit panic-aborts on the framework package

On a chain with NO fork-local checkpoints yet (`current checkpoint ==
forked_at`), the first commit's `ConsensusCommitPrologueV3` panic-aborts the
process (exit 134): `LINKER_ERROR: Cannot find package 0x…02 in data cache`
(`execution_engine.rs:1026 "ConsensusCommitPrologueV3 cannot fail"`). Nothing
has lazily materialized the framework packages into the store yet, and the
prologue's system tx doesn't trigger the lazy upstream fetch that a user tx's
input loading would. Observed live when trade-sim's boot-time clock catch-up
(`advanceClock`) was the chain's first action (SEDEFI-456); resumed chains
never hit it, which is why weeks of restarts on a long-lived data dir masked
it. `pnpm clock:sync` as the first action on a fresh chain would trigger the
same abort.

**Local:** the `registry-init` boot member pre-warms `0x1/0x2/0x3/0x5/0x6` by
id before the stack's first execution (the established issue-#2 pre-warm
recipe, applied to system state).
**Upstream ask:** seed the framework packages (and other system state) into
the store at fork genesis instead of relying on lazy materialization.

## 10. A container's dynamic-field child can go permanently unreadable

A `Bag` entry stopped resolving — for BOTH gRPC `GetObject` and, decisively,
the Move VM during execution — while the container kept accepting writes to
it. Every access re-`add`s the entry rather than finding it, so value written
into it is unrecoverable and the container's `size` counter inflates.

Confirmed on the SEDEFI-459/460 BalanceManager
(`0x02eef3b40975c107592eca19b2ba8bb5c8eeca1cf12b5cbdb9970a4ca3e504aa`), whose
`BalanceKey<DEEP>` entry is dead while `BalanceKey<SUI>` on the same Bag reads
fine:

- `deposit<DEEP>` of 20 DEEP → success, effects list the entry as **Created**
  (`0x1936246a…`, byte-for-byte the derived
  `deriveDynamicFieldID(bag, "<original>::balance_manager::BalanceKey<DEEP>", [0])`)
  — it is reported Created by every tx that touches it, never Modified.
- `withdraw<DEEP>` of 1 DEEP immediately after → `MoveAbort … abort code: 3`
  (`EBalanceManagerBalanceTooLow`) in `balance_manager::withdraw_with_proof`:
  `balances.contains(key)` read FALSE inside the VM, so it added a fresh zero
  balance and asserted against it.
- `withdraw_all<DEEP>` → succeeds and returns **0**, with the emitted
  BalanceEvent recording amount 0 against the 20 000 000 deposited two
  checkpoints earlier.
- Bag `size` climbed 3 → 6 across these accesses; `GetObject` on the derived id
  404s throughout, and `pnpm clock:sync` does not flush it.

NOT a general rule about fork-created children: a second BalanceManager
created on the same fork (`0x1c3c2131…`) round-trips DEEP correctly
(deposit 5, withdraw 1, balance reads back 4 000 000 by derived id), so
fork-local dynamic fields normally work. What poisons an individual entry is
not yet isolated — the dead one belongs to a Bag that had a full-balance
`withdraw_all` (which does `Bag::remove`) earlier in its history, so a
create → remove → re-create cycle on the same derived id is the prime suspect.

**Blast radius:** silent and value-losing — deposits into the affected coin
vanish, the UI reads 0 for it, and every sell of it aborts with code 3. Only
that (BalanceManager, coin) pair is affected; other coins and other managers
keep working.
**Local:** none for a poisoned entry — abandon it and use a different
BalanceManager. `listDynamicFields` cannot help (index-backed, returns `[]`
like `listBalances`/`listCoins`); the Bag's `size` counter is not a reliable
signal either, since it counts the phantom re-adds.
**Upstream ask:** make child-object reads (VM and RPC) resolve what the
execution write-set committed, and make `Bag::add` on an existing derived id a
detectable error rather than a silent second insert.
