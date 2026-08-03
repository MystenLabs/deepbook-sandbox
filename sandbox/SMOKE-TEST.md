# First Smoke (Beta) Test — fork sandbox

Manual, end-to-end shakedown of the `dbsf-005` fork-sandbox work: the devstack
stack (fork + funding plugins + dashboard), the Pyth update loop, and a
first **exploratory** pass at pointing the legacy docker-compose services at a
fork. Run it top to bottom; each phase stands alone.

**Honest readiness, up front** — this is a _beta_ smoke test. Phases 1–3 are
expected green (their pieces have been verified individually). Phase 4 is
exploratory: the compose services are still wired for the localnet workflow,
and part of the value of this run is recording exactly where they break.

| Piece                                  | Expectation                                                    |
| -------------------------------------- | -------------------------------------------------------------- |
| Unit tests + mainnet id checks         | ✅ green (verified 2026-07-24)                                 |
| devstack stack + dashboard DEEP faucet | ✅ green with the **patched** fork image                       |
| Pyth update loop on a fork             | ✅ green with the pre-warm pass (verified on 1.76.0)           |
| market-maker against the fork          | ⚠️ transport OK (gRPC) — config/funding wiring missing         |
| indexer against the fork               | ❌ expected fail — ingests from a volume the fork never writes |
| server against the fork                | ⚠️ Postgres reads OK — live RPC endpoints expected to fail     |
| sandbox dashboard against the fork     | ⚠️ depends on API/manifest wiring that assumes localnet        |

## Phase 0 — prerequisites (one-time)

1. **Docker running**, **Node ≥ 24** (`nvm use 24`; the repo default may be 23).
2. **Patched fork image** (needed by Phases 1–2 — a stock fork aborts on any
   DEEP/USDC execution, killing the process):

   ```bash
   cd sandbox/scripts/spikes/devstack-funding
   SUI_REPO=/path/to/local/sui/checkout ./build-patched-fork.sh   # ~20-30 min cold, cached after
   ```

   Or skip the build with a prebuilt image: `DEVSTACK_SUI_FORK_IMAGE=<registry-ref>`.

3. **Matched `sui` + `sui-fork` CLIs** for the manual-CLI phases — both built
   from the _same_ sui checkout (`cargo build --bin sui --bin sui-fork`), both
   printing the same version. A mismatched CLI fails at `execute-signed-tx`
   with a raw `h2 … Reset(CANCEL)` stream error, not a version message.
4. Never run `sui client dynamic-field <obj>` against a fork — enumeration hits
   an unimplemented path and kills the fork process. By-id reads only.

## Phase 1 — devstack stack + faucet (expected ✅)

```bash
cd sandbox/devstack-plugins
pnpm install --ignore-workspace
pnpm typecheck && pnpm test          # 28 unit tests
pnpm verify:usdc-minter              # Circle minter ids still current (mainnet read)

FORK_IMAGE_CONTEXT="$PWD/../scripts/spikes/devstack-funding/.fork-patched/images" \
pnpm dashboard:up                    # boots fork + DEEP/USDC plugins + dashboard()
```

Then, in the printed `http://127.0.0.1:<port>/` UI:

- [ ] Stack members all show healthy; `alice` exists.
- [ ] Faucet panel lists **DEEP** and **USDC** (editable amounts) and **SUI**.
- [ ] Faucet 100 DEEP to any address → success; repeat with an amount over
      `MAX_DEEP_PER_REQUEST` (default 100k DEEP) → clean cap error, stack stays up.
- [ ] `pnpm verify:dashboard-faucet` (scripted equivalent) passes.

Peek inside while it runs: `docker ps` / `docker logs -f <fork-container>`
(aborts surface here first), `node_modules/.bin/devstack status`, and the
`.devstack/` runtime dir (manifest per stack name).

Full e2e (DEEP **and** USDC in one fork boot): `pnpm test:e2e`.

## Phase 2 — Pyth update loop (expected ✅)

Proves a real Hermes price lands on the **real** Pyth contract and a
DeepBook-style consumer reads it at mainnet's 60-second freshness contract.
Uses a standalone fork (simplest); see `scripts/spikes/pyth/README.md` for the
full command sequence. Outline:

1. `sui-fork start --network mainnet --data-dir /tmp/sui-fork-pyth` (fresh dir).
2. Point the matched `sui` CLI at it (`sui client new-env/switch`).
3. **Pre-warm the Wormhole/Pyth objects by id** (`sui client object <id>` over
   the ~10 ids listed in PR #83's verification comment — States, their
   version/guardian children, packages, the `PriceInfoObject`). Without this
   the update aborts (`assert_version` / "Dependent package not found").
4. `cd sandbox/scripts/spikes/pyth && node advance-clock-and-update-pyth.mjs inspect`
   then `… run`.

- [ ] `advance-clock` lands, `update_single_price_feed` → `success`,
      verify PTB `get_price_no_older_than(price_info, clock, 60)` → `success`.

## Phase 3 — DeepBook interaction on the fork (expected ✅)

```bash
cd sandbox/scripts/spikes/deepbook
./start-seeded-fork.sh               # seeds the Registry — REQUIRED (else fork panics)
node create-pool-as-admin.mjs        # impersonates the DeepbookAdminCap holder
```

- [ ] `create_pool_admin` succeeds against the seeded Registry.

## Phase 4 — compose services against the fork (exploratory ⚠️ — record findings)

Goal: learn precisely what the DBSF-021/022 migration must fix. Point each
legacy service at a running fork (any of the above) and record behavior.
Nothing here is expected to fully work — that's the point of the beta.

**Known constraints going in:**

- The fork serves **gRPC only** on its RPC port; legacy JSON-RPC POSTs
  (`suix_*`) return 404.
- The **indexer** ingests checkpoints from the `checkpoint_data` volume that
  only the `sui-localnet` container writes. A devstack/standalone fork never
  writes it → the indexer has nothing to read. Expected: no progress (record
  the exact behavior). Fixing this is a migration design question (can the
  fork emit checkpoint files? RPC ingestion?), not a config tweak.
- The **server** reads Postgres (fine, but empty without the indexer) and
  makes live JSON-RPC calls for orderbook/supply → those endpoints are
  expected to fail against the fork. The `pools` table is manual config —
  seed it with **mainnet** pool ids if you get that far.
- The **market-maker** is already on `SuiGrpcClient`, so transport-wise it can
  talk to the fork. What's missing is wiring: it reads the deploy manifest
  (`deployments/localnet.json`) for localnet package/pool ids, and needs a
  funded key. On a fork the correct inputs are the **mainnet** DeepBook ids +
  mainnet pool ids, SUI gas via devstack's faucet, DEEP/USDC via our funding
  plugins. Attempt: hand-craft its env against the fork's `docker port`,
  record the first failure.
- The **sandbox dashboard** gets its data from the API/server, so it inherits
  their gaps; its direct chain reads (v2 SDK) could work pointed at the fork.

**Per attempt, record:** service, config used, first failure (verbatim), and
whether it's transport (JSON-RPC vs gRPC), data (missing manifest/volume), or
protocol (fork limitation). File findings on SEDEFI-321/325/326; fork-tool
bugs on SEDEFI-358.

## Cleanup

Ctrl+C `dashboard:up`; `node_modules/.bin/devstack wipe` / `devstack prune` for
strays; kill standalone forks and `rm -rf` their data dirs;
`sui client switch --env <your usual env>` (the CLI env switch is global).

## Findings log

| Date | Phase | What | Result / first failure | Filed where |
| ---- | ----- | ---- | ---------------------- | ----------- |
|      |       |      |                        |             |
