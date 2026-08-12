# devstack-plugins

Production [`@mysten-incubation/devstack`](https://www.npmjs.com/package/@mysten-incubation/devstack)
plugins for the DeepBook sandbox running against a mainnet **fork**. Isolated
package (own `node_modules`) so it pins the exact devstack/SDK versions.

## `deep-funding.ts` — DEEP funding strategy

DEEP is fixed-supply (its `TreasuryCap` is locked in a `ProtectedTreasury`), so
the sandbox can't mint it — it **transfers DEEP from an impersonated mainnet
whale**. `deepFundingFromWhale({ sui, whale })` returns a devstack plugin that
contributes a `coinType:<DEEP>` funding strategy, so:

```ts
const suiRef = sui({ mode: "fork", upstream: "mainnet" });
const whale = account("deepWhale", { kind: "impersonate", address: DEEP_DONOR_ADDRESS });
const deep = coin.known(DEEP_COIN_TYPE);
const deepFunding = deepFundingFromWhale({ sui: suiRef, whale });

defineDevstack({
  members: [
    suiRef,
    whale,
    deepFunding,
    deep,
    // `via: deepFunding` forces the provider→funding dep edge so the strategy is
    // registered before the funding pass (non-SUI funding silently no-ops otherwise).
    account("alice", { funding: [{ coin: deep, amount: 1000n, via: deepFunding }] }),
  ],
});
```

funds `alice` with DEEP at boot.

How it works:

- **Contribution** — `defineFaucetStrategy` is SUI-only, so a non-SUI coin is
  contributed imperatively via `ctx.provides({ kind: "strategy-contributor", … })`
  (`PluginContext`, inside `start`) under a `coinType:<fullType>` key, at
  **priority 1** (the built-in `coin.known` mint strategy sits at 0 — wrong for
  fixed-supply DEEP — and ours wins). Targets `@mysten-incubation/devstack@0.7.0`.
- **Body** — impersonation: no signing (the whale has no key) and no SDK gas
  auto-select. A mainnet fork lazily materializes objects on direct-by-id access
  (`getObject`) but does **not** build an owner→coins index, so
  `listCoins`/`getOwnedObjects` return empty on the fork — the donor's coins can
  only be resolved by **known object id**. It `getObject`s the donor's DEEP source
  coin + a SUI gas coin (ids default to the known whale coins; override via
  `DEEP_DONOR_COIN_ID` / `SUI_GAS_COIN_ID`), builds the PTB offline with those
  concrete refs, and executes empty-sig via
  `sdk.core.executeTransaction({ signatures: [] })`. Refresh stale default ids with
  `node scripts/refresh-donor-coins.mjs` (queries real mainnet, where `listCoins`
  works).
- **Caps** — per-request (`MAX_DEEP_PER_REQUEST`, default 100k DEEP) and total
  session draw (`MAX_DEEP_PER_SESSION`, default 10M DEEP); breaches surface as a
  `FaucetBodyError`, transport failures as `FaucetUnreachable`.
- **Published value** — the plugin's resolved value exposes `{ donor, coinType,
perRequestCap, sessionCap, sessionDrawn(), remainingDeep }`. `remainingDeep` is
  a best-effort read of the donor's funding-source coin **by known id**
  (`getObject` with `include: { json: true }` — the only balance read that works
  on a fork, which has no owner→coins index for `getBalance`). It decrements as
  sessions draw; 0 on any miss.

The donor address, rationale, risk profile, and caps live in
[`../deployments/fork-impersonation.md`](../deployments/fork-impersonation.md).

## `usdc-funding.ts` — USDC funding strategy

USDC is **mintable**, so (unlike DEEP) there's no donor or session-drain
ceiling — only a per-request cap. `usdcFundingFromCapOwner({ sui, minter })`
contributes a `coinType:<USDC>` strategy that mints native USDC on the fork.

How it works:

- **Regulated coin** — native USDC's `TreasuryCap<USDC>` is **not** address-owned;
  it lives under a shared `Treasury<USDC>` gated by a controller → minter
  allowlist, so `coin::mint` doesn't work. Minting goes through the stablecoin
  framework's `treasury::mint` as a configured minter.
- **Impersonation** — impersonate Circle's master-minter (empty-sig). One-time
  per fork: `configure_new_controller` + `configure_minter` mints a `MintCap`
  (discovered from the tx's `changedObjects`; reuse a known id via
  `USDC_MINT_CAP_ID`). Per request: `treasury::mint(treasury, mintCap, denyList,
amount, recipient)`.
- **Sponsored gas** — the master-minter holds no SUI on the fork, so every tx is
  sponsored: sender = master-minter, gas owner = a SUI donor (the DEEP whale,
  resolved by known coin id — the fork can't enumerate coins). All minter txs are
  serialized (they share the donor's gas coin + the one-time configure).
- **Cap** — per-request (`MAX_USDC_PER_FAUCET_REQUEST`, default 1M USDC); breaches
  surface as `FaucetBodyError`, transport failures as `FaucetUnreachable`.
- **Published value** — `{ minter, coinType, perRequestCap }`.

The minter identities (package, `Treasury<USDC>`, master-minter) + the
master-minter re-derivation are in
[`../deployments/fork-impersonation.md`](../deployments/fork-impersonation.md)
(re-verify after a Circle rotation with `pnpm verify:usdc-minter`). Minting trips
the same sui-fork `GetCoinInfo` blocker as DEEP — the patched fork is required.

### Legacy `sandbox/packages/usdc/` (deferred drop)

This plugin replaces the custom `sandbox/packages/usdc/` Move package — but only
on the **fork** runtime. The current **localnet** stack still publishes that
package (`scripts/utils/deployer.ts`) and uses its id for pool creation + the
faucet, so dropping it from the publish path is part of the devstack runtime
migration (the `MoveDeployer` collapse), not this change — dropping it now would
break `pnpm deploy-all`. The Move source stays as the localnet/escape-hatch path
until then.

**Migration plan of record** (2026-07-24 devstack-docs review, details on
SEDEFI-326): the runtime migration builds on devstack's **first-party
[`deepbook()` member](https://ts-sdks-incubation.vercel.app/devstack/deepbook)**
(already in our pinned 0.7.0 — publish, `DeepbookPoolSpec` pools, seed
liquidity, mock-Pyth initial feeds, codegen bindings) rather than porting
`MoveDeployer`/`pool.ts`. The member does **not** cover the indexer, server,
market-maker, the oracle-service's ongoing price updates, or non-SUI funding on
a mainnet fork — this package's funding plugins remain necessary alongside it.

## `deepbook-known.ts` — DeepBook on the fork (DBSF-017)

Implements the plan of record for the **fork** runtime: devstack's first-party
`deepbook()` member in **mode `'known'`**, pinned to the mainnet ids DBSF-016
verified into [`deployments/mainnet-fork.json`](../deployments/mainnet-fork.json)
(drift-checked by `pnpm verify:deepbook-ids`). The local-mode machinery the plan
of record lists above (publish, `DeepbookPoolSpec` pools, seed liquidity,
mock-Pyth feeds) doesn't apply here — nothing publishes; the fork already
carries mainnet's deployment.

- `deepbookFromManifest()` — the member. Explicit manifest ids override
  devstack's SDK-derived `.mainnet()` defaults — they match today, but SDK
  constants have lagged mainnet before (`@mysten/deepbook-v3` 1.5.0 pins margin
  v5; mainnet is v6), and explicit pins mean a future lag can't silently move
  them; `network: 'mainnet'` keeps the known-table extras (deepTreasuryId, Pyth
  state ids).
- `deepbookMarginPackagesFromManifest()` — verify-only `knownPackage` members
  for `deepbook_margin` + `margin_liquidation`. Devstack 0.7.0's known mode
  hardcodes `margin: null`, so this is the cheap sibling-exposure path (vs. an
  upstream PR); the members' boot probes double as fork-serves-the-pins checks.
- `deepbookAdminAccountFromManifest()` — the impersonated mainnet admin wallet
  (holds **both** `DeepbookAdminCap` and `MarginAdminCap`; known mode's
  `adminCapId` is `null` by design). DBSF-020's create-pool action builds on it.
- `mainnetForkDeepbookIds()` — the raw pins (registries with initial shared
  versions, caps, default pools) for anything the member doesn't model.

Live check: `pnpm verify:deepbook-member` boots a fork + the member + package
probes for all three package pins (a STOCK image suffices — nothing funds,
nothing executes non-SUI coins) and asserts every row settles (`done` for these
task-role members) with the pinned package ids chain-proven on the fork; the
registry object ids ride in from the drift-checked manifest.

Swapping the legacy manifest reads (market-maker, examples, dashboard) over to
the member's codegen bindings happens with the runtime composition
(SEDEFI-325/326), same as the faucet/dashboard wiring below.

## `devstack.config.ts` — the production stack (DBSF-021)

The composed fork runtime `devstack up` boots: fork + DEEP/USDC funding +
`deepbook()` (known) + margin/liquidation pins + the impersonated DeepBook
admin + devstack's `dashboard()` + `wallet({ accounts: 'all' })`. Run it from
`sandbox/`:

```bash
pnpm stack:up     # devstack up (cwd devstack-plugins, so the CLI finds the config)
pnpm stack:wipe   # devstack wipe --stack deepbook-sandbox (wipe ignores the config's stackName)
```

- Stack name `deepbook-sandbox` (override: `SANDBOX_STACK`); image precedence
  as in the scripts: `DEVSTACK_SUI_FORK_IMAGE` (pull) → `FORK_IMAGE_CONTEXT` /
  default patched context (build) → devstack default (STOCK — survives
  boot-and-teardown checks like the smoke, but a sustained stack crashes
  seconds after boot when the funding members' donor-coin reads hit the
  fork's unimplemented store path; the patched image is required for real
  sessions. See the Known blocker below).
- Deliberately not composed yet: the oracle hostService (SEDEFI-317) and the
  create-sandbox-pool action (SEDEFI-324) — additive when their tickets land.
- Smoke: `pnpm smoke` here, or `pnpm test:integration devstack-up` from
  `sandbox/` (< 3 min on a warm image; skips without Docker/Node 24).
- The `__tests__/devstack.config.ts` fixture (funded alice) stays e2e-only.

## Faucet & dashboard

devstack's built-in dashboard auto-surfaces the `coinType:<DEEP>` and
`coinType:<USDC>` strategies as editable-amount faucet actions — confirm with
`pnpm verify:dashboard-faucet`. How that wires into the dashboard + the
`POST /faucet` HTTP endpoint (and what's deferred to the devstack runtime
migration) is in
[`faucet-dashboard-integration.md`](./faucet-dashboard-integration.md).

## Patched devstack dependency (Pyth feeds on the DeepBook page)

`@mysten-incubation/devstack@0.7.0` is consumed **patched** (SEDEFI-444):
upstream's known-mode `deepbook()` hardcodes `pyth.feeds: []`, so the
dashboard's DeepBook page renders no oracle data. The patch
([`patches/@mysten-incubation__devstack@0.7.0.patch`](./patches/@mysten-incubation__devstack@0.7.0.patch)) makes
known-mode `start` read the DEEP/SUI/USDC `PriceInfoObject`s (ids from
`@mysten/deepbook-v3`'s coin tables) and fill `pyth.feeds` with real
price/expo — values are as of the fork's checkpoint pin until an updater
pushes fresh prices (SEDEFI-317). Reads are lenient: an unreadable feed is
skipped with a warning, never a boot failure. The patch fills the
runtime/dashboard value only — the generated bindings tree
(`src/generated/deepbook.ts`) still carries `feeds: []` (codegen is
synchronous). On testnet only DEEP/SUI resolve (`testnetCoins` has no USDC
entry in `@mysten/deepbook-v3@1.5.0`).

Mechanics: the patch is declared in [`pnpm-workspace.yaml`](./pnpm-workspace.yaml)
`patchedDependencies` (pnpm 11 no longer reads `package.json#pnpm`), which also
makes this directory its own workspace root — so installs here must **not**
use `--ignore-workspace` (it would silently skip the patch; the root
`stack:up`/`stack:wipe` scripts and the devstack-up smoke were updated
accordingly). Drop the patch when devstack ships the feature natively — the
upstream ask is recorded on SEDEFI-444.

## ⚠️ Known blocker — sui-fork

A **stock** sui-fork crashes on any access to donor coins (transfer, mint, or
balance-read via `getObject`): the SDK enriches the tx's balance-changes via
`GetCoinInfo`, which on the fork misses the (un-materialized) shared
CoinRegistry `Currency` object and hits an unimplemented index `todo!()` in
`store.rs:1361`. Dashboard faucet requests and the `remainingDeep` Effect both
touch donor coins and thus both crash a stock fork. Until sui-fork fixes that,
the live path needs the **patched** fork image. Full report + the patch:
[`../scripts/spikes/devstack-funding/SUI-FORK-NOTES.md`](../scripts/spikes/devstack-funding/SUI-FORK-NOTES.md).
The plugin's logic is correct and unit-tested regardless; the e2e test needs the
patched fork.

**Additionally (since 2026-07-31)** the fork must be pinned to a
pre-protocol-130 mainnet checkpoint: mainnet's epoch-1205 framework upgrade
added `0x2::scratch`, which the pinned fork rev can't verify (any tx execution
aborts with `MISSING_DEPENDENCY`), while every newer sui rev — current `main`
and the sui#27520 fix branch alike — crashes fork _genesis_ on mainnet forks
(`new_id` VMInvariantViolation). Both configs therefore default
`FORK_CHECKPOINT` to `304941000` (tail of epoch 1204, protocol 129); pass
`FORK_CHECKPOINT=latest` to fork the live tip once upstream fixes land. Donor
coin ids are resolved at that checkpoint; `node scripts/refresh-donor-coins.mjs`
rediscovers them from the **live tip** (not the pin), so after a refresh confirm
the printed id also existed at the pinned checkpoint (a funding "Object … not
found" at boot is the symptom when it didn't).

## Tests

```bash
pnpm install                      # NO --ignore-workspace — it would skip the devstack patch (see above)
pnpm test                         # unit tests (stubbed fork sdk.core); excludes *.e2e

# E2E (boots a real fork via devstack's vitest harness) — requires Node >= 24 +
# Docker. The fixture defaults to the patched fork image (required — a stock fork
# aborts; see above), so no env is needed. The FIRST run compiles sui-fork from
# source (~15-20 min; cached after).
pnpm test:e2e

# Skip the source build with a prebuilt patched image (the CI path — push the
# image built by build-patched-fork.sh to a registry once, then):
# DEVSTACK_SUI_FORK_IMAGE=<registry-ref> pnpm test:e2e
# (Must be set explicitly — devstack ignores this env var when the config passes
# an explicit image.build, so our configs resolve the precedence themselves.)

# Override the fork image build context if needed:
# FORK_IMAGE_CONTEXT=/abs/path/to/images pnpm test:e2e
```

`pnpm test:e2e` uses `@mysten-incubation/devstack/vitest`: a `globalSetup`
(`__tests__/global-setup.ts`) boots + tears down the fork fixture stack
(`__tests__/devstack.config.ts`), `__tests__/e2e-setup.ts` captures its manifest
for `getStackContext()`, and the tests confirm the boot then query `alice`'s
DEEP + USDC (the fixture funds her with both — one fork boot covers both plugins).
`alice` is a fixed-keypair recipient (`__tests__/alice.ts`), so the tests query a
deterministic address. They reach the fork via its **direct host port**
(`docker port`) — the manifest's routed `*.localhost` URL isn't gRPC-reachable
from the host.

If the donor's default coin ids ever go stale (the whale spent them), set
`DEEP_DONOR_COIN_ID` / `SUI_GAS_COIN_ID` from
`node scripts/refresh-donor-coins.mjs` before running.

For the full manual shakedown (devstack stack + Pyth loop + the exploratory
compose-services-on-fork pass), see [`../SMOKE-TEST.md`](../SMOKE-TEST.md).
