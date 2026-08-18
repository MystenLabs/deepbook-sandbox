# sui-fork bug report — stale shared-object version breaks dynamic-field (child) reads during execution

> **✅ FIXED upstream (2026-06-19).** MystenLabs/sui PR
> [#26966](https://github.com/MystenLabs/sui/pull/26966) — "[sui-fork] Fix child
> object reads to support bounded versions" — adds bounded child-object reads
> (`read_child_object` → `get_object_lt_or_eq_version`), resolving this panic.
> Merged to `main` as `b124567746b3a78a7e294ac2de265f693401ec9d`. Our patched
> fork image is built from a later `main` rev that includes it (`SUI_FORK_REV`,
> currently `16f1402387`), so the DeepBook admin path works without a workaround.
>
> **Validated end-to-end (2026-06-22)** against a `sui-fork` built from `main`
> (`1.75.0-cf371176`): `pool::create_pool_admin` on the mainnet DeepBook Registry
> (the call that used to panic) now **executes successfully** via empty-sig
> impersonation — `$kind=Transaction, status: success`, the fork process stays
> alive, no `INVARIANT VIOLATION` / `read_child_object` panic in the log.
>
> (The _separate_ `get_coin_info` panic that blocks non-SUI coin funding is still
> `todo!()` on `main` — see `../devstack-funding/SUI-FORK-NOTES.md`.) Report kept
> for the record.

## Summary

When executing a transaction that takes a **long-lived shared object whose `Versioned`/dynamic-field inner has been mutated since creation** as a mutable input, `sui-fork` loads the shared object at a **stale version** (its `initial_shared_version` / genesis state) instead of the version current at the fork checkpoint. Its dynamic-field child is then fetched at the child's _latest_ version, which is newer than the (stale) parent's Lamport bound. `DataStore::read_child_object` does not support bounded reads, so this raises a `STORAGE_ERROR`, and the executor aborts with an **INVARIANT VIOLATION panic** that kills the RPC handler (the client sees an `h2` stream reset).

Real DeepBook example: a `pool::create_pool_admin` (or any call that hits `registry::load_inner_mut`) against the mainnet DeepBook `Registry` panics the fork.

## Environment

- `sui-fork --version`: `sui-fork/1.74.0-31537d4d9235`
- Confirmed present in latest `main` too: there are **0 commits touching `crates/sui-fork`** between the built commit `31537d4d92` and `main` HEAD `004a12a0fe` (verified with `git log 31537d4d92..HEAD -- crates/sui-fork`). So this is **not** fixed in the latest source.
- Network: `--network mainnet` (GraphQL upstream `https://graphql.mainnet.sui.io/graphql`).

## The panic (from the fork log)

```
ERROR sui_execution::latest: INVARIANT VIOLATION! Txn Digest: <...>, Source:
Some(VMError { major_status: STORAGE_ERROR, sub_status: None,
  message: Some("Use of disabled feature: DataStore::read_child_object does not yet support bounded reads"),
  location: Module(ModuleId { address: 0000...0002, name: Identifier("dynamic_field") }), ... }) fatal=true
thread 'tokio-rt-worker' panicked at sui-execution/src/latest.rs:303:13:
INVARIANT VIOLATION! ... "DataStore::read_child_object does not yet support bounded reads" ...
```

## Minimal reproducer

DeepBook mainnet objects used below:

| Object                                                      | ID                                                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `Registry` (shared)                                         | `0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d`                          |
| `Registry.inner` versioned UID                              | `0x4cc3af2ff1f4b5d41526a0a2cc24723b46e1236a216b24de022b1bf355bb01c2`                          |
| `RegistryInner` dynamic field (`Field<u64, RegistryInner>`) | `0x0248830b9f259b94f7e9d89c9d4cf8e0af4f78e1ced3a2d7256d8c40f36d06a7`                          |
| DeepBook package (v6)                                       | `0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497`                          |
| `DeepbookAdminCap`                                          | `0xada554b8b712556b8509be47ac1bc04db9505c3532049a543721aca0c010a840` (owner `0xd0ec0b2…865e`) |

```bash
# 1. Fresh fork, NO --object seeding.
sui-fork start --network mainnet --data-dir /tmp/sui-fork-repro
sui client new-env --alias fork --rpc http://127.0.0.1:9000 && sui client switch --env fork

# 2. Execute any tx that takes the Registry as a mutable input and calls
#    registry::load_inner_mut. Easiest is create_pool_admin via empty-sig
#    impersonation of the cap owner (fund it first from any mainnet SUI holder).
#    See create-pool-as-admin.mjs in this directory; or any equivalent PTB:
sui client ptb --sender @0xd0ec0b2...865e --gas-coin @<owner SUI coin> --gas-budget 200000000 \
  --move-call 0x337f4f...7497::pool::create_pool_admin \
  "<0x...::eth::ETH, 0x2::sui::SUI>" @0xaf16199a...549d 1000 10000 100000 false false @0xada554b8...0a840 \
  --serialize-unsigned-transaction
# submit the bytes with an empty signature list:
sui client execute-signed-tx --tx-bytes <BYTES>
#  => h2 stream reset on the client; INVARIANT VIOLATION panic in the fork log.
```

The same panic occurs for any sender/caller — it is not about impersonation; it is about the shared object + its mutated child.

## Root cause

1. `crates/sui-fork/src/store.rs` — `impl ChildObjectResolver for DataStore::read_child_object` (≈ line 844):

   ```rust
   fn read_child_object(&self, parent, child, child_version_upper_bound) -> SuiResult<Option<Object>> {
       let child_object = match self.get_object(child).ok().flatten() { ... };   // <-- LATEST, ignores the bound
       ...
       if child_object.version() > child_version_upper_bound {
           return Err(... "DataStore::read_child_object does not yet support bounded reads" ...);  // <-- hard error
       }
       Ok(Some(child_object))
   }
   ```

   `get_object` → `get_latest_object` → remote `multiGetObjects(atCheckpoint: forked_at)`. It fetches the child at its _latest_ version and **ignores `child_version_upper_bound`**; if the child is newer than the bound it errors instead of returning the correct bounded version.

2. During execution the **shared parent** (`Registry`) is loaded at a stale version (its genesis / `initial_shared_version` `336155480`, not the checkpoint-current `914861990`), so `child_version_upper_bound` is stale. The child's latest (`914861990`) exceeds it → the error path → executor panic.

   (Symmetrically, when the child happens to be cached at genesis too, no bound error fires but the Move code then sees stale state — e.g. DeepBook's `allowed_versions` reads `{1}` and `pools` reads empty, producing a misleading `EPackageVersionNotEnabled` / "pool doesn't exist" instead of the real `{1,2,3,4,5,6,8}` / 72 pools.)

## The GraphQL backend is NOT at fault

`graphql.mainnet.sui.io` returns the correct, checkpoint-consistent versions for both objects:

```
multiGetObjects(keys:[{address: <shell>, atCheckpoint: <forked_at>}]) -> version 914861990
multiGetObjects(keys:[{address: <inner>, atCheckpoint: <forked_at>}]) -> version 914861990
```

Both shell and inner resolve to `914861990` at the fork checkpoint. The wrong versions are produced inside `sui-fork`, not by the upstream.

## Suggested fix

- `read_child_object` should perform a **bounded** read of the child (≤ `child_version_upper_bound`) rather than fetching `get_object` (latest). The GraphQL `ObjectKey` already supports `rootVersion` (`crates/sui-fork/src/gql/queries.rs`, `VersionQuery::RootVersion`), which is the natural way to fetch a child consistently with its parent's version.
- And/or: load shared-object inputs at their **current** (checkpoint) version during execution, rather than `initial_shared_version`, so the Lamport bound is consistent with the children that get fetched.

## Workaround (validated)

Seed the shared object (and its inner/versioned wrapper) at fork start so they are materialized at the current checkpoint version:

```bash
sui-fork start --network mainnet --data-dir /tmp/sui-fork-deepbook \
  --object 0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d \
  --object 0x4cc3af2ff1f4b5d41526a0a2cc24723b46e1236a216b24de022b1bf355bb01c2 \
  --object 0x0248830b9f259b94f7e9d89c9d4cf8e0af4f78e1ced3a2d7256d8c40f36d06a7
```

With seeding, the shell loads at `914861990`, the bound is current, the child (`914861990`) is `≤` bound, no panic — and the registry reflects real state (`allowed_versions = {1,2,3,4,5,6,8}`, `pools.size = 72`). `create_pool_admin` then succeeds, registering a 73rd pool alongside the real mainnet pools.
