# Phase 0 Spikes — sui-fork Migration

This folder holds throwaway scripts that validate load-bearing assumptions for the sui-fork migration **before** any production code in `sandbox/` changes. Each subfolder corresponds to one Phase 0 ticket in the backlog and is intended to be run manually against a local `sui-fork` instance.

These scripts are **not part of the production sandbox**. They are evaluation harnesses. Production wiring of the patterns they prove lives under their respective phase tickets (DEEP → `sandbox/scripts/utils/impersonation.ts`, oracle → `sandbox/scripts/oracle-service/`, etc.).

## Backlog mapping

| Folder      | Spike                                  | What it validates                                                         |
| ----------- | -------------------------------------- | ------------------------------------------------------------------------- |
| `pyth/`     | Adopted Pyth POC + advance-clock spike | Real Hermes VAA + `advance-clock` flow against forked Pyth/Wormhole state |
| `deep/`     | DEEP whale-transfer spike              | `splitCoins + transferObjects` from an impersonated DEEP whale            |
| `usdc/`     | USDC mint spike                        | `mint` from an impersonated USDC TreasuryCap owner                        |
| `deepbook/` | DeepBook admin-cap spike               | `pool::create_pool_admin` impersonating the `DeepbookAdminCap` holder     |

## Common requirements

All spike scripts assume:

- A locally-built `sui-fork` binary on `PATH` (or referenced via the `SUI_FORK_BIN` env var per-script).
- A locally-built `sui` CLI from the same monorepo as `sui-fork`, configured against `http://127.0.0.1:9000`.
- Network access to mainnet for the first-touch object fetches that sui-fork performs on demand.

## Running a spike

Each subfolder has its own README with the specific seed objects, sender addresses, and command sequence. The general shape is:

```bash
# 1. Start the fork (commonly with --address / --object seeds the script needs)
sui-fork start --network mainnet --data-dir /tmp/sui-fork-<spike-name> [seed flags...]

# 2. Point the Sui CLI at the fork
sui client new-env --alias local-fork --rpc http://127.0.0.1:9000
sui client switch --env local-fork

# 3. Run the spike script
cd sandbox/scripts/spikes/<spike-name>
node <spike-script>.mjs   # or similar — see the spike's README
```

## After a spike passes

- Capture the resulting tx digest(s), mutated object versions, and any new constants discovered (mainnet object IDs, whale/minter addresses) in the spike's README.
- Open the corresponding implementation ticket and link back to the spike folder.
- Leave the spike script in-tree — it doubles as the reference implementation we'll generalize during the production phase.

## After all Phase 0 spikes pass

Phases 1 through 4 are unblocked. This folder can stay in the repo indefinitely as worked examples — the spikes get repurposed into the partner-facing cookbook.
