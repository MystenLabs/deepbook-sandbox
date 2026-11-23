# DeepBookV3 Sandbox

## Agent Guidelines

When making changes in this repository:

- Keep this file (`./CLAUDE.md`) up to date with any new patterns, commands, or architectural decisions.
- Spawn a review agent to review ongoing changes before completing.
- For git commits: keep titles short (sacrifice grammar for conciseness), but include detailed descriptions
  with one sentence explaining what the commit introduces/fixes, plus examples when helpful.

## Project Overview

This project provides a toolset for reducing builder friction with DeepBook V3: a one-command local environment that runs on a **fork of Sui mainnet** (orchestrated by [devstack](https://ts-sdks-incubation.vercel.app/devstack)), plus a web dashboard and SDK examples.

> **History:** until DBSF-022 the sandbox published everything (DeepBook, DEEP, a USDC package, mock Pyth) onto an empty localnet through docker-compose + `deploy-all.ts` + `MoveDeployer`. The migration to the fork + devstack model is tracked in the Linear project [DeepBook & Local Forking](https://linear.app/mysten-labs/project/deepbook-and-local-forking-6fa84aaea188) (tickets `DBSF-001`…`DBSF-033`). The original plan, `SUI_FORK_MIGRATION_PLAN.md`, was kept outside this repository. If you see "localnet" in older code comments or docs, it refers to that retired model.

**DeepBookV3** is included as a git submodule at `./external/deepbook/`. It's a decentralized central limit order book (CLOB) built on Sui. Key resources:

- Submodule README: `./external/deepbook/README.md`
- Move code guidelines: `./external/deepbook/CLAUDE.md` (use `/deepbookv3` skill for comprehensive Move guidance)
- [Contract Documentation](https://docs.sui.io/standards/deepbookv3)
- [SDK Documentation](https://docs.sui.io/standards/deepbookv3-sdk)

## File Structure

Run `ls`/`find` to explore the tree. Top-level: `sandbox/` (devstack stack, `dashboard/`, `api/`, `scripts/`), `examples/sandbox/` (SDK integration examples), and `external/deepbook/` (DeepBookV3 git submodule). Subsystem-specific guidance lives in nested `CLAUDE.md` files (`sandbox/dashboard/`, `sandbox/scripts/oracle-service/`, `sandbox/scripts/market-maker/`).

## Fork-State Mental Model

Read this before changing anything that touches the chain:

- **The chain is a copy of Sui mainnet at a pinned checkpoint.** Every mainnet
  object (DeepBook packages, pools and their resting orders, DEEP, USDC, Pyth
  and Wormhole state) exists locally as it was at that checkpoint. Nothing is
  published at boot. Writes stay local, and `pnpm down` throws them away.
- **The pin is deliberate.** `FORK_CHECKPOINT` defaults to
  `DEFAULT_FORK_CHECKPOINT` in `sandbox/devstack-plugins/fork-checkpoint.ts`,
  the last protocol-129 checkpoint, because the pinned fork rev can't execute
  against protocol-130+ mainnet state. Set `FORK_CHECKPOINT=<n>` to choose another
  checkpoint, or `latest` for the live tip (currently aborts). Changing the pin
  or `SUI_FORK_REV` recreates Postgres through the postgres member's
  `chainKey`.
- **Objects load lazily by ID.** The fork fetches an upstream object the first
  time something reads it by ID. It builds **no owner→objects index**, so
  `listCoins`, `getOwnedObjects` and `getBalance` come back empty for upstream
  holders. Plugins therefore resolve coins and children by known ID
  (`deployments/mainnet-fork.json`) and build PTBs from concrete refs with
  explicit gas. `simulate_transaction` is unsupported, so SDK auto-resolution
  and dry-runs fail.
- **Time doesn't move by itself.** The on-chain Clock starts at the checkpoint
  timestamp. The `clock-driver` member keeps it at wall time.
- **Mainnet IDs are the IDs.** Pool, package, registry and coin types are the
  real mainnet values: DEEP is `0xdeeb…::deep::DEEP` and USDC is Circle's
  native USDC. They are pinned in `deployments/mainnet-fork.json` and
  drift-checked by `pnpm -C devstack-plugins verify:deepbook-ids` (from `sandbox/`).
- Known fork defects and their workarounds are listed in
  `sandbox/SUI-FORK-ISSUES.md`.

### Impersonation (no private keys)

The sandbox holds **no mainnet private keys**. To act as a real mainnet
address, declare it as an impersonated account. The fork then executes
transactions for that sender with an **empty signature**
(`executeTransaction({ signatures: [] })`):

```ts
const whale = account("deepWhale", { kind: "impersonate", address: DONOR });
```

An impersonated account can't sign anything else (direct signing APIs fail)
and can't use the dev wallet. For a funded local signer, use
`kind: "ephemeral"`. The sandbox impersonates three addresses (details and
rationale in `sandbox/deployments/fork-impersonation.md`):

| Account         | Address source                                   | Used for                                                                                                                             |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `deepWhale`     | `DEEP_DONOR_ADDRESS` (~46% of DEEP supply)       | DEEP transfers (DEEP is fixed-supply, so it can't be minted). Its known SUI coin also pays gas for every DEEP transfer and USDC mint |
| `usdcMinter`    | `USDC_MINTER_ADDRESS` (Circle master-minter)     | Configures a minter and mints native USDC through `treasury::mint`                                                                   |
| `deepbookAdmin` | `adminWallet` in `deployments/mainnet-fork.json` | Holds `DeepbookAdminCap` + `MarginAdminCap`; used by `registry-init`; the SUI donor for grants                                       |

**Funding coins.** For DEEP and USDC, funding goes through devstack faucet
strategies, so account `funding:` entries, the devstack dashboard's `fund`
mutation and `POST :9009/faucet` all use the same code. SUI is handled
separately (see below). devstack's `defineFaucetStrategy` is
**SUI-only**. DEEP and USDC are therefore contributed by hand from inside a
plugin's `start`, through
`ctx.provides({ kind: "strategy-contributor", … })` under a
`coinType:<fullType>` key at priority 1, which overrides the built-in
`coin.known` mint strategy. See `deep-funding.ts` and `usdc-funding.ts`.

When an account uses `funding:` with a non-SUI coin, pass
`via: <fundingPlugin>`. Otherwise the strategy may not be registered before the
funding pass, and funding silently does nothing.

**SUI is different.** devstack's fork SUI faucet is effectively disabled on
this stack: it looks up the faucet whale through `listCoins`, which returns
empty on a fork. SUI grants (sandbox-api faucet, the trading dashboard's dev
wallet, registry-init) split from the DeepBook admin wallet's known SUI coin
instead (`fork-sui-grant.ts`; override with `SUI_DONOR_ADDRESS` /
`SUI_DONOR_COIN_ID`).

To refresh stale known coin IDs, run `node scripts/refresh-donor-coins.mjs`
from `sandbox/devstack-plugins/`. It queries real mainnet.

- **By default** it checks the DEEP whale and prints `DEEP_DONOR_COIN_ID` /
  `SUI_GAS_COIN_ID`.
- **For the SUI donor coin,** run it with `DEEP_DONOR_ADDRESS=<adminWallet>`.
  It will say that address holds no DEEP. Use the largest SUI coin it prints
  as `SUI_DONOR_COIN_ID`.

## Devstack Members (mainnet fork — single orchestrator)

The sandbox runs on a **mainnet fork** orchestrated entirely by devstack
(`sandbox/devstack-plugins/devstack.config.ts`, which is thin assembly only;
all logic lives in the plugin modules). `@mysten-incubation/devstack` is pinned
at 0.7.0 and **pnpm-patched** (see below).

Members from devstack built-ins, configured in `devstack.config.ts`:

| Member                                  | Comes from                                                                | What it does                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `sui`                                   | devstack `sui({ mode: "fork", upstream: "mainnet" })`                     | The `sui-fork` chain container (gRPC; RPC port is brokered). Image: `DEVSTACK_SUI_FORK_IMAGE` > patched build context > stock build |
| `deepWhale`, `usdcMinter`               | devstack `account({ kind: "impersonate" })`                               | Impersonated donors (see above)                                                                                                     |
| DEEP / USDC coins                       | devstack `coin.known(...)`                                                | Coin metadata for funding and bindings                                                                                              |
| `deepbook`                              | devstack `deepbook({ mode: "known" })`, wrapped by `deepbook-known.ts`    | References mainnet DeepBook by pinned ID (nothing is published). Patched to read DEEP/SUI/USDC Pyth feeds at boot                   |
| `deepbook-margin`, `margin-liquidation` | devstack `knownPackage(...)`, wrapped by `deepbook-known.ts`              | Verify-only pins (known mode hardcodes `margin: null`)                                                                              |
| DeepBook admin                          | devstack `account({ kind: "impersonate" })`, built by `deepbook-known.ts` | Impersonated mainnet admin wallet                                                                                                   |
| `dashboard`                             | devstack `dashboard()` (patched `assetsDir` → vendored `dashboard-ui/`)   | devstack dashboard on :9810, including the DeepBook panel and DEEP/USDC faucet actions                                              |
| `wallet`                                | devstack `wallet({ accounts: "all" })`                                    | devstack's browser dev wallet                                                                                                       |

Members written in this repository, in `sandbox/devstack-plugins/`:

| Member (plugin module)               | What it does                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| **deep-funding** (`deep-funding.ts`) | `coinType:<DEEP>` funding strategy: whale `splitCoins` + transfer, capped per request and per session |
| **usdc-funding** (`usdc-funding.ts`) | `coinType:<USDC>` funding strategy: impersonated-minter `treasury::mint` with sponsored gas           |

The devstack dashboard (GraphQL `fund` mutation) is routed by the Host header
`api.deepbook-sandbox.devstack-plugins.localhost` on port 9810. Since
SEDEFI-445 (DBSF-032), the former docker-compose services also run as members
of this repository (the compose file is deleted):

| Member (plugin module)                         | Description                                                                                             | Host ports            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------- |
| **postgres** (`postgres-member.ts`)            | Database for the indexer (data in the writable layer)                                                   | 5432                  |
| **indexer** (`indexer-member.ts`)              | Ingests DeepBook events from the fork over gRPC                                                         | 9184 (metrics)        |
| **server** (`server-member.ts`)                | REST API for indexed data (live-RPC endpoints degraded¹)                                                | 9008, 9186 (metrics²) |
| **pools-seed** (`pools-seed.ts`)               | Task: seeds the server's manual `pools` config table                                                    | —                     |
| **registry-init** (`registry-init.ts`)         | Task: admin-impersonated `init_balance_manager_map`³                                                    | —                     |
| **sandbox-api** (`sandbox-api.ts`)             | Old `sandbox/api` contract: GET /manifest, POST /faucet⁴                                                | 9009                  |
| **trading-dashboard** (`trading-dashboard.ts`) | The old trading dashboard's Vite dev server (SEDEFI-456)                                                | 5173                  |
| **clock-driver** (`clock-driver.ts`)           | Holds the fork's on-chain Clock at wall time⁵                                                           | —                     |
| **trade-sim** (`trade-sim.ts`)                 | Continuous self-fills strictly inside the measured real spread (SEDEFI-455) keep /ticker + candles live | —                     |

¹ Degraded on the fork: the server's live reads (/status, /orderbook,
/deep_supply, /fees, /margin_supply) are JSON-RPC and the fork is gRPC-only;
Postgres-backed endpoints work — see `server-member.ts`'s header.
² Not 9185 — the devstack router pre-claims it.
³ Mainnet never initialized the registry's owner→BalanceManager map, so
user-driven BM registration would abort without it; idempotent per chain.
⁴ In-process HTTP (not a container): the funding strategies only exist inside
the supervisor, and the devstack dashboard's `fund` mutation cannot route SUI
on a fork — DEEP/USDC only.
⁵ In-process loop (SEDEFI-317 / DBSF-013, first slice). The fork Clock never
ticks on its own (SUI-FORK-ISSUES #6) and checkpoints seal with whatever it
says, so without this every fill is stamped in the past — below the DeepBook
server's wall-relative 24h `/ticker` window, which is what the trading
dashboard prices orders off. Advances by exactly the measured deficit every
`CLOCK_INTERVAL_MS` (default 5s), forward-only and never past wall;
`CLOCK_DRIVER_DISABLED=1` opts out. It is the stack's SINGLE clock authority —
trade-sim deliberately no longer advances the Clock (two advancers, one
tracking it locally, race it past wall). The Hermes → advance-clock → Pyth
submit half of DBSF-013 lands on top of this loop.

Wiring resolves from devstack state, not env: the members get the fork RPC URL
from the sui member's `hostGateway.rpcUrl` (the ACTUAL brokered port, not a
hardcoded 51002), the Postgres DSN from the postgres member, and
`FIRST_CHECKPOINT` from the same `resolveForkCheckpoint()` pin the fork boots
from. `dependsOn` edges give readiness ordering (indexer/server gate on fork +
postgres; pools-seed on indexer migrations). One compose-parity loss to know:
devstack containers have **no restart policy** (compose had `unless-stopped`) —
a crashed member stays down until `pnpm down && pnpm deploy-all`.

The indexer image is a local build from `sandbox/docker/deepbook-indexer-fork/`
(submodule source + `rpc-ingestion.patch`; background in
`sandbox/scripts/spikes/fork-indexer-checkpoints/SPIKE-NOTES.md`). devstack's
`ensureImage` can't pass `--build-context`, so the Dockerfile uses a single
REPO-ROOT context with a `Dockerfile.dockerignore` allowlist; a COLD build is a
full Rust release build (tens of minutes, cached after). The fork chain resumes
mainnet checkpoint numbering from the `FORK_CHECKPOINT` pin — Postgres must be
wiped whenever the fork chain is reset (watermarks ignore `--first-checkpoint`),
which `devstack wipe` (run by `pnpm down`) now does structurally: the postgres
member keeps its data in the container's writable layer (PGDATA relocated off
the image's VOLUME path), so removing the container IS the wipe.

Every sui-fork defect the sandbox has found (and how each is worked around)
is cataloged in `sandbox/SUI-FORK-ISSUES.md` — the upstream hand-off list;
add new fork findings there.

The devstack package itself is consumed **pnpm-patched**
(`sandbox/devstack-plugins/patches/`, declared in that directory's
`pnpm-workspace.yaml` `patchedDependencies`): known-mode `deepbook()` reads
DEEP/SUI/USDC Pyth `PriceInfoObject`s at boot and accepts pinned
pools/server-URL options, and `dashboard()` accepts `assetsDir` — together
these feed the dashboard's DeepBook page real oracle/pool data via the
**vendored SPA build** at `sandbox/devstack-plugins/dashboard-ui/` (rebuilt
Price/Depth panels; source diff `dashboard-ui-app.patch`, recipe in that
README). All upstream asks are recorded on SEDEFI-444. Because pnpm 11 only
reads `patchedDependencies` from `pnpm-workspace.yaml`, installs in
`devstack-plugins/` must NOT use `--ignore-workspace` — it silently skips the
patch. The `pools` config table is seeded at boot by the `pools-seed` task
member from `sandbox/deployments/mainnet-fork.json` (idempotent); to re-seed a
live stack run `pnpm exec tsx scripts/seed-pools.ts` (same SQL, shared via
`devstack-plugins/pools-seed-sql.ts`).

### Running the Stack

```bash
cd sandbox

pnpm deploy-all   # everything: boots devstack detached, waits for fund-ready,
                  # then for every member (incl. containers) to settle.
                  # Idempotent while healthy — re-run freely; a FAILED member
                  # needs `pnpm down && pnpm deploy-all` (no re-drive path).
                  # First run builds the indexer image (a full Rust release
                  # build, an hour+); STACK_SETTLE_TIMEOUT_MS overrides the budget.
pnpm down         # everything: stop supervisor + devstack wipe (removes the
                  # member containers — incl. Postgres, the watermark wipe)

# Supervisor logs (devstack up runs detached; PID in .devstack-supervisor.pid)
tail -f .devstack-supervisor.log

# Member container logs (names are devstack-derived; find them by label)
docker logs -f "$(docker ps --filter label=devstack.plugin=deepbook-indexer --format '{{.Names}}')"

# Fork clock -> wall time. The clock-driver member holds it there while the
# stack is up; this is the manual mover for a stack running with
# CLOCK_DRIVER_DISABLED=1, or when the supervisor is down (SEDEFI-453).
pnpm clock:sync
```

Both commands live in `scripts/stack.ts`. Prefer attached devstack logs? `pnpm
stack:up` in its own terminal still works — `deploy-all` detects the live
supervisor and skips the boot, and `down` refuses to wipe under a
terminal-attached supervisor it doesn't own (Ctrl-C it first, then re-run
`pnpm down`). Orphaned supervisors (no terminal — e.g. a dead session's
background process) are stopped automatically — including WEDGED ones (alive
and holding devstack's per-stack lock but unserving, e.g. their router
container died), which fail the readiness probe and used to dead-end both
commands on `supervisor live` / exit 40; `deploy-all` never kills, it names
the lock holder and points at `pnpm down`. Process discovery/teardown lives
in `scripts/stack-supervisors.ts` (unit-tested; the pgrep pattern also
matches the bare devstack `main.mjs up` entry — the actual lock holder,
which can outlive its pnpm wrappers).

## Testing Unreleased DeepBook and Pyth Versions (escape hatches)

The default stack uses what mainnet runs at the fork pin. You can't swap in a
DeepBook or Pyth build that isn't on mainnet yet with a flag today. These are
the routes and their status:

### Unreleased DeepBook: `deepbook({ mode: "override" })` (DBSF-018, not wired yet)

devstack's `deepbook()` has three modes:

- `local` publishes DeepBook onto a local chain.
- `known` references an existing deployment. This is what the sandbox uses.
- `override` wraps package, registry and admin-cap IDs that you manage
  yourself.

SEDEFI-322 (DBSF-018) will make `devstack.config.ts` switch from `known` to
`override` when `DEEPBOOK_OVERRIDE_PACKAGE_ID`, `DEEPBOOK_OVERRIDE_REGISTRY_ID`
and `DEEPBOOK_OVERRIDE_ADMIN_CAP_ID` are set. It is planned to support two
workflows:

- **A — publish on top.** A parallel config adds
  `localPackage("deepbook-dev", { sourcePath: "external/deepbook/packages/deepbook", publisher: <admin account> })`
  and points the override at its resolved IDs.
- **B — pre-published.** Publish against the running fork separately
  (`sui client publish` to the fork RPC), then export the three
  `DEEPBOOK_OVERRIDE_*` IDs before `pnpm deploy-all`.

**Neither works yet.** Both need a package publish on the fork, which needs
`simulate_transaction` (SEDEFI-358 / sui#27520) and a SUI gas source the
publisher can sign with. Until then, test unreleased DeepBook Move code with
`sui move test` in `external/deepbook/`.

### Unreleased Pyth: devstack `mode: "local"` with the mock Pyth package

On the fork, Pyth is mainnet's own Pyth and Wormhole deployment, with IDs
pinned under `pyth` in `deployments/mainnet-fork.json`. Its prices stay frozen
at the pin until something pushes Hermes updates (SEDEFI-317). To run against
a Pyth you control, **leave the fork**. Use a plain local chain (`sui()`) with
`deepbook({ mode: "local", pyth: { package: localPackage("pyth", …), pusher, feeds } })`.
That publishes DeepBook plus the mock Pyth package in `sandbox/packages/pyth/`
and seeds each feed at an `initialPrice` you choose. See the devstack
[DeepBook docs](https://ts-sdks-incubation.vercel.app/devstack/deepbook) for
a full config. This is a separate config, not composed into
`devstack.config.ts`. It also gives up everything that comes from forking
mainnet: real pools, real DEEP and USDC, and the funding plugins.

> **Pyth Core upgrade (2026-08-26):** Pyth replaced its Sui Core package with
> a "Pyth Core Compatible" deployment (new package and state IDs; Hermes now
> needs an API key). The fork pin predates the upgrade, so the IDs in
> `mainnet-fork.json` are the pre-upgrade ones. Revisiting this is
> SEDEFI-357.

## Development Commands

### Git Submodules

```bash
# Initialize submodules after fresh clone
git submodule update --init --recursive

# Update submodule to latest
cd external/deepbook && git pull origin main
```

### DeepBookV3 Development

When working with Move code in `./external/deepbook/`:

```bash
cd external/deepbook/packages/deepbook
sui move build                              # Build the package
sui move test                               # Run tests
sui move test --skip-fetch-latest-git-deps  # Skip fetching deps if unchanged
bunx prettier-move -c *.move --write        # Format Move files
```

## Integration Tests

```bash
cd sandbox

# Devstack boot smoke (needs Docker + warm images — patched fork AND the
# locally-built indexer image, so run `pnpm deploy-all` once first; local-only)
pnpm test:integration devstack-up
```

Test files live in `sandbox/scripts/__tests__/**/*.integration.test.ts`. The
legacy localnet suites (deploy-pipeline, deploy-all-e2e) were deleted with the
localnet stack (DBSF-022); CI currently runs unit tests only — fork-stack
integration CI returns with DBSF-024/DBSF-025.

## Oracle Service

Pyth price-feed updater (`sandbox/scripts/oracle-service/`). Its localnet
container is retired. The fork carries real mainnet Pyth state, so the
mock-Pyth flow is only a fallback. The devstack reshape (SEDEFI-317 / DBSF-013)
landed its first slice as the `clock-driver` member and the Pyth/Wormhole
prewarm pins in `deployments/mainnet-fork.json`. The Hermes → advance-clock →
Pyth submit loop is **not** composed into `devstack.config.ts` yet, so
on-chain Pyth prices are real but frozen at the fork pin. Subsystem details
are in `sandbox/scripts/oracle-service/CLAUDE.md`.

## Market Maker

Automated market maker (`sandbox/scripts/market-maker/`). Its localnet container
is retired; the code stays pending its devstack `hostService` reshape (DBSF-022
AC — blocked on fork gas funding, sui#27520). Config env vars (`MM_*`) in
`sandbox/scripts/market-maker/CLAUDE.md`.

## Key Concepts

- **Balance Manager**: Shared object holding all balances for an account (1 owner, up to 1000 traders).
- **Pool**: Contains Book (order matching), State (user data, volumes, governance), and Vault (settlement).
- **DEEP Token**: Required for trading fees; can be staked for reduced fees and governance participation.

## Trading Page (Dashboard)

**BalanceManager creation works as it did on localnet.** It's user-driven: click
"Create Balance Manager", which runs one PTB with `new_with_custom_owner`,
`register_balance_manager` and `public_share_object`. The difference is that it
now runs against **forked mainnet DeepBook**: the real package and real
registry, with no locally published copy. That's why `registry-init` exists.
Mainnet never initialized the registry's owner→BalanceManager map, so
registration would abort without it.

The old trading dashboard is BACK as the `trading-dashboard` devstack member
(SEDEFI-456): `pnpm deploy-all` serves it at http://localhost:5173 with a
pre-funded auto-connected dev wallet (key persisted in
`devstack-plugins/.trading-dashboard-key.json`, gitignored). Fork-mode wiring:
the member passes the brokered RPC/server/api proxy targets as env to Vite;
the browser's chain traffic rides the same-origin `/api/sui` proxy. On the
fork every deepbook SDK read helper AND unresolved `tx.object(id)` build-time
resolution ride `simulate_transaction` (unsupported — SUI-FORK-ISSUES #7), so
`sandbox/dashboard/src/lib/fork.ts` provides derived-dynamic-field reads,
server-backed prices/orders, and raw concrete-ref PTB builders with explicit
gas; hooks branch on `isForkManifest`. The retired `sandbox/api/` service's
contract lives on in the `sandbox-api` member (port 9009). Architecture notes
for the Trading page — user-driven BM creation, on-chain BM discovery,
registry-map init, wallet-swap keying — live in `sandbox/dashboard/CLAUDE.md`
(loads when you work under `sandbox/dashboard/`). Read that before touching
any trading flow.

## SDK Integration Examples

`examples/sandbox/` contains runnable TypeScript examples using the `@mysten/deepbook-v3` SDK. These demonstrate how external developers integrate with DeepBook — the pattern real builders would follow.

Both `examples/sandbox/` and the sandbox dashboard use `@mysten/sui@v2` and the new SDK extension pattern (`client.$extend(deepbook(...))`). The examples have their own `package.json` and `node_modules/` for isolation, and track `@mysten/sui` independently — they sit on a newer minor (`^2.23.1`) than `sandbox/` because `@mysten/deepbook-v3@1.6.x` requires it.

> **Status:** the examples are localnet-era; localnet was decommissioned
> (DBSF-022) and fork-mode runs are blocked upstream (`simulate_transaction`,
> SEDEFI-358), so they are not currently runnable on this branch.

```bash
# Run examples (sandbox must be running first)
cd examples/sandbox
pnpm install
pnpm check-order-book     # Read-only queries
pnpm swap-tokens           # Direct wallet swap
pnpm place-limit-order     # BalanceManager + limit order
pnpm place-market-order    # Market order (needs MM running)
pnpm query-user-orders     # Full order lifecycle
```

Key architecture decisions:

- Uses `$extend` pattern with `SuiGrpcClient` (official Sui v2 SDK pattern)
- Reads deployment manifest from `sandbox/deployments/localnet.json` (written by `pnpm deploy-all`)
- Constructs `CoinMap`, `PoolMap`, and `DeepbookPackageIds` at runtime from the manifest
- Fresh keypair per run, funded via sandbox faucet (port 9009) — avoids gas conflicts with MM
