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

## Faucet & dashboard

devstack's built-in dashboard auto-surfaces the `coinType:<DEEP>` and
`coinType:<USDC>` strategies as editable-amount faucet actions — confirm with
`pnpm verify:dashboard-faucet`. How that wires into the dashboard + the
`POST /faucet` HTTP endpoint (and what's deferred to the devstack runtime
migration) is in
[`faucet-dashboard-integration.md`](./faucet-dashboard-integration.md).

## ⚠️ Known blocker — sui-fork

Executing a non-SUI coin transfer **or mint** on a **stock** sui-fork aborts the
fork process: the SDK enriches the tx's balance-changes via `GetCoinInfo`, which
on the fork misses the (un-materialized) shared CoinRegistry `Currency` object and
hits an unimplemented index `todo!()`. Until sui-fork fixes that, the live path
needs the **patched** fork image. Full report + the patch:
[`../scripts/spikes/devstack-funding/SUI-FORK-NOTES.md`](../scripts/spikes/devstack-funding/SUI-FORK-NOTES.md).
The plugin's logic is correct and unit-tested regardless; the e2e test needs the
patched fork.

## Tests

```bash
pnpm install --ignore-workspace   # nested under sandbox/'s workspace
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
