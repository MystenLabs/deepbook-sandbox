# DeepBookV3 Sandbox

## Agent Guidelines

When making changes in this repository:

- Keep this file (`./CLAUDE.md`) up to date with any new patterns, commands, or architectural decisions.
- Spawn a review agent to review ongoing changes before completing.
- For git commits: keep titles short (sacrifice grammar for conciseness), but include detailed descriptions
  with one sentence explaining what the commit introduces/fixes, plus examples when helpful.

## Project Overview

This project provides a toolset for reducing builder friction with one-liner deployments, Dockerized stack, and a web dashboard for DeepBook V3 instances.

**DeepBookV3** is included as a git submodule at `./external/deepbook/`. It's a decentralized central limit order book (CLOB) built on Sui. Key resources:

- Submodule README: `./external/deepbook/README.md`
- Move code guidelines: `./external/deepbook/CLAUDE.md` (use `/deepbookv3` skill for comprehensive Move guidance)
- [Contract Documentation](https://docs.sui.io/standards/deepbookv3)
- [SDK Documentation](https://docs.sui.io/standards/deepbookv3-sdk)

## File Structure

Run `ls`/`find` to explore the tree. Top-level: `sandbox/` (devstack stack, `dashboard/`, `api/`, `scripts/`), `examples/sandbox/` (SDK integration examples), and `external/deepbook/` (DeepBookV3 git submodule). Subsystem-specific guidance lives in nested `CLAUDE.md` files (`sandbox/dashboard/`, `sandbox/scripts/oracle-service/`, `sandbox/scripts/market-maker/`).

## The Stack (devstack mainnet fork — single orchestrator)

The sandbox runs on a **mainnet fork** orchestrated entirely by devstack
(`sandbox/devstack-plugins/devstack.config.ts`): the `sui-fork` chain container,
DEEP/USDC funding plugins, the devstack dashboard (GraphQL `fund` mutation,
routed by Host header `api.deepbook-sandbox.devstack-plugins.localhost` on port
9810), and — since SEDEFI-445 (DBSF-032) — **container-backed members** for the
former docker-compose remnant (the compose file is deleted):

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
container is retired; the code stays pending its devstack `hostService` reshape
(DBSF-013) — the fork carries real mainnet Pyth state, so the mock-Pyth flow is
a fallback only. Subsystem details in `sandbox/scripts/oracle-service/CLAUDE.md`.

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
