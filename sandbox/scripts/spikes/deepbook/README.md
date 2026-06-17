# DeepBook Spike — Admin Cap Impersonation

This spike validates that empty-signature impersonation on a `sui-fork` mainnet network lets us call admin-gated DeepBook entrypoints by "being" the address that owns the `DeepbookAdminCap` on mainnet. It's load-bearing for the production "create fresh sandbox pool alongside mainnet pools" path: any sandbox integration test that needs a clean empty pool relies on impersonating the admin cap holder and calling `pool::create_pool_admin`.

## Related work

- **This spike** — validate the admin-cap impersonation mechanism.
- **Manifest pinning** — pin all mainnet DeepBook IDs (Registry, MarginRegistry, admin caps, target pool IDs) into the manifest.
- **`createFreshSandboxPool`** — generalize this pattern into a reusable helper for test setups.

## Why this works

`sui-fork` accepts transactions submitted with an empty signature list and executes them as the declared sender. The `DeepbookAdminCap` is created in `registry::init` and is **address-owned** (originally the publisher; since transferred to `0xd0ec0b2…` — always `inspect` for the live owner). Because it's address-owned, the fork inherits its ownership when materialized — and a PTB taking the cap as `&DeepbookAdminCap` input, with the cap's current owner declared as sender, lets sui-fork stand in for the missing signature.

## Verified mainnet IDs (2026-05-18)

| Role                                      | ID                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| DeepBook package (v6)                     | `0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497`                      |
| Registry (shared)                         | `0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d`                      |
| `DeepbookAdminCap` object                 | `0xada554b8b712556b8509be47ac1bc04db9505c3532049a543721aca0c010a840`                      |
| Cap owner (declared sender) — **current** | `0xd0ec0b201de6b4e7f425918bbd7151c37fc1b06c59b3961a2a00db74f6ea865e`                      |
| Cap owner — _genesis (stale; do NOT use)_ | `0xbd1d25f49cc9b65f1e41d6c264ad0e065923de7ce6fd8b86d87d25c0a58742b9` (original publisher) |

⚠️ The cap was **transferred** from the publisher to `0xd0ec0b2…`. An unseeded/stale fork serves the cap's _genesis_ owner (`0xbd1d25f4…`) — using that fails with a sender mismatch. Always `inspect` to confirm the live owner, and seed the registry (see below) so the fork reflects current state.

Source for the package + registry IDs: [DeepBookV3 contract information](https://docs.sui.io/standards/deepbookv3/contract-information).

## Resolving the admin cap

**Resolved (now the script defaults):** cap `0xada554b8…010a840`, **current** owner `0xd0ec0b2…865e`.

The cap object ID came from the v1 publish tx (read the v1 package `0x2c8d603…3204809` → its `prevTx` `DCgz4D66…upWF` → `effects.created`: the `DeepbookAdminCap`, alongside the publish `UpgradeCap`). **But the owner has changed since:** the cap was transferred from the publisher (`0xbd1d25f4…`) to `0xd0ec0b2…`. Confirm the live owner with `sui_getObject` on mainnet, or `inspect` against a correctly **seeded** fork — an unseeded fork shows the stale genesis owner. Override via env vars if Mysten transfers it again.

If you need to re-resolve against live mainnet instead, either of these works:

### Option A — query owned objects of the original publisher (recommended)

The cap was created during the v1 publish on Oct 10, 2024 (package `0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809`). The cap's type uses that v1 package ID as the originating address — Sui type tags are pinned to the publishing package even after upgrades. To find every `DeepbookAdminCap` on chain owned by any account, ask the indexer or any explorer for type `0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809::registry::DeepbookAdminCap`.

If you already know the original publisher address (Mysten admin), the cleanest query is:

```bash
curl -sS https://fullnode.mainnet.sui.io:443 \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"suix_getOwnedObjects",
    "params":[
      "<publisher_address>",
      {
        "filter": {"StructType":"0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809::registry::DeepbookAdminCap"},
        "options": {"showOwner": true, "showType": true}
      },
      null, 50
    ]
  }' | jq '.result.data'
```

### Option B — start from the registry's previous transactions

The Registry shared object's `previousTransaction` field, walked backwards far enough, lands on the publish tx where the admin cap was created and transferred. Tools like suiscan or suivision can show this without writing any code.

The resolved values are already the script defaults, so no setup is needed. Only export overrides if Mysten has moved the cap since:

```bash
export DEEPBOOK_ADMIN_CAP_ID=0x...
export DEEPBOOK_ADMIN_CAP_OWNER=0x...
```

## Files

| File                       | What it is                                                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start-seeded-fork.sh`     | Starts a `sui-fork` mainnet fork pre-seeded (`--object`) with the DeepBook Registry objects — **required** (see below). Configurable via env (`SUI_FORK_BIN`, `RPC_ADDR`, `DATA_DIR`, …); extra flags forwarded to `sui-fork`.                                                             |
| `create-pool-as-admin.mjs` | The spike script. Builds a `pool::create_pool_admin<Base, Quote>` PTB against the forked Registry with the admin cap as input and the cap owner as declared sender. Serializes unsigned and submits via empty-sig `execute-signed-tx`. Has `inspect`, `ptb-args`, `build`, `submit` modes. |
| `SUI-FORK-BUG.md`          | Bug report + minimal reproducer for the sui-fork stale-shared-object / bounded-read panic that makes seeding necessary.                                                                                                                                                                    |

## Default test pair: BETH/SUI

The spike defaults to creating a `BETH/SUI` pool because (a) both coin types are in DeepBook's supported-coins list so they're guaranteed to exist on mainnet, and (b) no `BETH/SUI` pool exists on mainnet today per the official pools table, so `create_pool_admin` won't abort on a duplicate-pool check. Override via `BASE_TYPE` and `QUOTE_TYPE` if you want to use a different pair — just make sure the pair doesn't already exist or the call will abort.

## How to run

### Prerequisites

- A `sui-fork` build from the Sui monorepo.
- `sui` CLI on `PATH` (or `SUI_BIN` env var) — **must be the exact same monorepo build as `sui-fork`** (matching `--version`). Reads tolerate a skew, but `execute-signed-tx` against a mismatched fork fails with an HTTP/2 stream reset.
- Node ≥ 18.

> **RPC note:** this `sui-fork` build serves the modern **gRPC** API on `--rpc-addr`, not legacy JSON-RPC — raw `sui_getObject` POSTs `404`. The script reads objects through the `sui` CLI (gRPC).

### Start the fork — you MUST seed the Registry

Use the helper (it bakes in the required seeds so you can't forget them):

```bash
cd sandbox/scripts/spikes/deepbook
./start-seeded-fork.sh                      # mainnet, /tmp/sui-fork-deepbook-spike, :9000
# SUI_FORK_BIN=/path/to/sui-fork ./start-seeded-fork.sh   # if sui-fork isn't on PATH
# RPC_ADDR=127.0.0.1:9001 DATA_DIR=/tmp/fork2 ./start-seeded-fork.sh
```

Equivalently, by hand:

```bash
sui-fork start --network mainnet --data-dir /tmp/sui-fork-deepbook-spike \
  --object 0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d \
  --object 0x4cc3af2ff1f4b5d41526a0a2cc24723b46e1236a216b24de022b1bf355bb01c2 \
  --object 0x0248830b9f259b94f7e9d89c9d4cf8e0af4f78e1ced3a2d7256d8c40f36d06a7
```

**This `--object` seeding is required** (registry shell, its `Versioned` UID, and the `RegistryInner` dynamic field). Without it, sui-fork serves the shared `Registry` at a stale (genesis) version during execution, and `create_pool_admin` either **panics** the fork (`read_child_object does not yet support bounded reads` → `h2` stream reset) or operates on stale registry state (empty pools, `allowed_versions={1}`, wrong cap owner). Seeding materializes them at the current checkpoint, so the fork reflects real state (`allowed_versions={1,2,3,4,5,6,8}`, 72 pools, live cap owner). **Full root cause + reproducer: [`SUI-FORK-BUG.md`](./SUI-FORK-BUG.md).** If you can't seed, see the manual fallback in [POC results](#poc-results).

**Gas:** the cap owner pays gas but holds no _enumerable_ SUI on a fresh fork (PTB gas auto-selection fails with "Cannot find gas coin"). `build`/`submit` handle this automatically — they fund the owner with 1 SUI from a donor (default: the deep/usdc whale, referenced by id) and use that coin. Override with `DEEPBOOK_ADMIN_GAS_COIN` (an existing coin), or `SUI_DONOR` / `SUI_DONOR_GAS_COIN` / `FUND_AMOUNT`.

In another terminal:

```bash
sui client new-env --alias local-fork --rpc http://127.0.0.1:9000
sui client switch --env local-fork
```

### Run the script

```bash
cd sandbox/scripts/spikes/deepbook

# Inspect — confirm cap + registry are on the fork with the expected
# owner/type. Always run this first.
node create-pool-as-admin.mjs inspect

# Print the PTB args
node create-pool-as-admin.mjs ptb-args

# Build the unsigned PTB and print base64 tx bytes
node create-pool-as-admin.mjs build

# Build + submit via empty-sig execute-signed-tx
node create-pool-as-admin.mjs submit
```

### Env var overrides

| Env var                    | Default                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `SUI_BIN`                  | _(unset — falls back to `sui` on `PATH`; errors if not found)_                                                    |
| `DEEPBOOK_PACKAGE_ID`      | `0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497` (v6 — see POC results re version drift)      |
| `DEEPBOOK_REGISTRY_ID`     | `0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d`                                              |
| `DEEPBOOK_ADMIN_CAP_ID`    | `0xada554b8b712556b8509be47ac1bc04db9505c3532049a543721aca0c010a840`                                              |
| `DEEPBOOK_ADMIN_CAP_OWNER` | `0xd0ec0b201de6b4e7f425918bbd7151c37fc1b06c59b3961a2a00db74f6ea865e` (current owner; `inspect` to confirm)        |
| `DEEPBOOK_ADMIN_GAS_COIN`  | _(unset — a SUI coin id owned by the cap owner; if unset, `build`/`submit` auto-fund the owner from `SUI_DONOR`)_ |
| `SUI_DONOR`                | `0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d` (funds the gas-less cap owner)               |
| `SUI_DONOR_GAS_COIN`       | `0xc866352dd2574aa14752dd09afca89cd993f573c59218ff278c3dafbd24ca714` (a SUI coin owned by `SUI_DONOR`, by id)     |
| `FUND_AMOUNT`              | `1000000000` (1 SUI sent to the cap owner for gas)                                                                |
| `BASE_TYPE`                | `0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH` (BETH)                             |
| `QUOTE_TYPE`               | `0x2::sui::SUI`                                                                                                   |
| `TICK_SIZE`                | `1000`                                                                                                            |
| `LOT_SIZE`                 | `10000`                                                                                                           |
| `MIN_SIZE`                 | `100000`                                                                                                          |
| `WHITELISTED`              | `false`                                                                                                           |
| `STABLE`                   | `false`                                                                                                           |
| `GAS_BUDGET`               | `200000000`                                                                                                       |

## Verifying success

After `submit`, the script prints the full JSON tx response. Manual checks:

```bash
# 1. Confirm the tx succeeded
sui client tx-block <digest>

# 2. The created pool ID is bound to `pool_id` in the PTB. Inspect the
#    tx effects for the newly created object — that's the new pool's ID.
#    Then fetch it to verify it carries the expected base/quote type
#    parameters.
sui client object <new_pool_id> --json
```

The acceptance criterion for this spike is: the tx succeeds, a new shared `Pool<Base, Quote>` object is created on the fork, and the new pool's type carries the real mainnet DeepBook package ID (`0x337f4f…7497`).

## If `submit` fails with a Move abort

Most likely interpretations:

- **`h2` stream reset / no clean result** — the fork **panicked** (`read_child_object does not yet support bounded reads`). You forgot to seed the Registry — see "Start the fork" and [`SUI-FORK-BUG.md`](./SUI-FORK-BUG.md).
- **Sender mismatch (`Object … is owned by … but given owner/signer is …`)** — you used the stale genesis cap owner (`0xbd1d25f4…`). The current owner is `0xd0ec0b2…`; `inspect` against a seeded fork shows the live one. Set `DEEPBOOK_ADMIN_CAP_OWNER` to it.
- **`EPackageVersionNotEnabled` (registry abort code 3)** — the fork served a _stale_ registry inner (`allowed_versions={1}`). Seed the Registry (the real set is `{1,2,3,4,5,6,8}`), or use the manual `enable_version` fallback in [POC results](#poc-results).
- **`EPoolAlreadyExists`** — on a _seeded_ fork the registry has the real 72 pools, so the pair genuinely exists. Pick a `BASE_TYPE`/`QUOTE_TYPE` that doesn't (the BETH/SUI default is clear as of these docs).

## Capture for the migration

When this spike runs successfully, paste back:

- Fork checkpoint
- Resolved `DEEPBOOK_ADMIN_CAP_ID` and `DEEPBOOK_ADMIN_CAP_OWNER`
- Tx digest
- New pool object ID and its full type tag
- Anything surprising (RPC failures, lazy-fetch latency, cap ownership changes since these docs were written)

These data points unblock the manifest-pinning and `createFreshSandboxPool` follow-ups with concrete values.

## POC results

Run 2026-06-11 against `sui-fork 1.74.0-31537d4d9235`, mainnet, epoch 1155.

**Impersonation mechanism: VALIDATED.** Empty-signature `execute-signed-tx` executes `pool::create_pool_admin<BETH, SUI>` **as the cap owner** (no signature) and runs DeepBook's admin-gated logic — this spike's hypothesis, proven.

**Pool creation: VALIDATED on a correctly seeded fork.** With the registry seeded (`--object …`, see "Start the fork"), impersonating the **current** cap owner `0xd0ec0b2…865e`, `create_pool_admin` succeeded — created shared `Pool<BETH, SUI>` and registered it as the **73rd** pool alongside the 72 real mainnet pools (registry `allowed_versions={1,2,3,4,5,6,8}`, `pools.size` 72 → 73). No version hacks needed.

**The blocker was a sui-fork bug, now understood and worked around.** Without seeding, sui-fork loads the shared `Registry` at a **stale (genesis) version** during execution, while fetching its `Versioned` inner dynamic field at the child's _latest_ version. `DataStore::read_child_object` (`crates/sui-fork/src/store.rs`) doesn't support bounded reads, so child-version > stale-parent-bound either **panics the fork** (`read_child_object does not yet support bounded reads` → STORAGE_ERROR → `h2` stream reset) or — when the child is also served stale — yields a misleading `EPackageVersionNotEnabled` / empty-pools / wrong-cap-owner view. The upstream GraphQL is correct (`multiGetObjects(atCheckpoint:)` returns the right version for both shell and inner); the bug is entirely in sui-fork, and is **not** fixed in latest `main` (0 `crates/sui-fork` commits since this build). Full analysis + reproducer: [`SUI-FORK-BUG.md`](./SUI-FORK-BUG.md).

**Fix / workaround — primary: `--object` seeding.** Seed the registry shell + its `Versioned` UID + the `RegistryInner` field at fork start (see "Start the fork"). This materializes them at the current checkpoint version, so the bound is current, the child is `≤` bound (no panic), and the registry reflects real state (real `allowed_versions`, real 72 pools, **real current cap owner** `0xd0ec0b2…` — an unseeded fork shows the stale genesis owner `0xbd1d25f4…` and fails with a sender mismatch). This is the validated path.

**Fallback — manual version bump (only if you can't seed, and only for the version gate).** If the fork serves the inner _stale_ (so it doesn't panic, but `allowed_versions` reads `{1}`), you can impersonate the (then genesis) cap owner to call `registry::enable_version(registry, 6, cap)` — it bypasses the version gate by design (`load_value_mut`, comment: _"does not have version restrictions"_) — then `create_pool_admin`. **Caveat:** this operates on the stale, **empty** registry (`pools.size=0`), so it proves pool-creation mechanics but does **not** give you a pool alongside the real mainnet pools. Prefer seeding.

**For the manifest-pinning and `createFreshSandboxPool` follow-ups:** seed the DeepBook Registry objects (above) on any fork the sandbox executes against; pin the **current** cap owner via `inspect` (it has changed once already); the package id `0x337f4f…` (v6) is correct and consistent with `current_version()=6`.
