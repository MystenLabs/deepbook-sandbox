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

Run `ls`/`find` to explore the tree. Top-level: `sandbox/` (docker-compose stack, `dashboard/`, `api/`, `scripts/`), `examples/sandbox/` (SDK integration examples), and `external/deepbook/` (DeepBookV3 git submodule). Subsystem-specific guidance lives in nested `CLAUDE.md` files (`sandbox/dashboard/`, `sandbox/scripts/oracle-service/`, `sandbox/scripts/market-maker/`).

## The Stack (devstack mainnet fork + compose remnant)

The sandbox runs on a **mainnet fork** orchestrated by devstack
(`sandbox/devstack-plugins/devstack.config.ts`): the `sui-fork` chain container,
DEEP/USDC funding plugins, and the devstack dashboard (GraphQL `fund` mutation,
routed by Host header `api.deepbook-sandbox.devstack-plugins.localhost` on port
9810). `./sandbox/docker-compose.yml` carries only the **remnant** devstack
doesn't provide (DBSF-022):

| Service              | Description                                              | Ports                |
| -------------------- | -------------------------------------------------------- | -------------------- |
| **PostgreSQL**       | Database for the indexer                                 | 5432                 |
| **DeepBook Indexer** | Ingests DeepBook events from the fork over gRPC          | 9184 (metrics)       |
| **DeepBook Server**  | REST API for indexed data (live-RPC endpoints degraded¹) | 9008, 9186 (metrics) |

¹ Degraded on the fork: the server's live reads are JSON-RPC and the fork is gRPC-only — see the compose file header.

The indexer image is built from `sandbox/docker/deepbook-indexer-fork/`
(submodule source + `rpc-ingestion.patch`); background in
`sandbox/scripts/spikes/fork-indexer-checkpoints/SPIKE-NOTES.md`. The fork chain
resumes mainnet checkpoint numbering from the `FORK_CHECKPOINT` pin — wipe
Postgres (`down -v`) whenever the fork chain is reset (watermarks ignore
`--first-checkpoint`).

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
patch. `deploy-all` also seeds the server's manual `pools` config table from
`sandbox/deployments/mainnet-fork.json` (`scripts/seed-pools.ts`, idempotent).

### Running the Stack

```bash
cd sandbox

pnpm deploy-all   # everything: boots devstack detached (waits for fund-ready),
                  # then the compose remnant. Idempotent — re-run freely.
pnpm down         # everything: compose down -v + stop supervisor + devstack wipe

# Supervisor logs (devstack up runs detached; PID in .devstack-supervisor.pid)
tail -f .devstack-supervisor.log

# Remnant logs / explicit image rebuild
docker compose logs -f deepbook-indexer
docker compose build
```

Both commands live in `scripts/stack.ts`. Prefer attached devstack logs? `pnpm
stack:up` in its own terminal still works — `deploy-all` detects the live
supervisor and skips the boot, and `down` refuses to wipe under a
terminal-attached supervisor it doesn't own (Ctrl-C it first, then re-run
`pnpm down`). Orphaned supervisors (no terminal — e.g. a dead session's
background process) are stopped automatically.

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

# Devstack boot smoke (needs Docker + warm patched fork image; local-only)
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

The trading dashboard's localnet container and the `sandbox/api/` faucet/trading
service were retired with the compose stack (DBSF-022); the dashboard code stays
pending its devstack `hostService` reshape with fork-mode wiring (DBSF-022 AC).
Architecture notes for the user-facing Trading page — user-driven BM creation,
on-chain BM discovery, registry-map init, wallet-swap keying — live in
`sandbox/dashboard/CLAUDE.md` (loads when you work under `sandbox/dashboard/`).
Read that before touching any trading flow.

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
