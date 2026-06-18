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
  fixed-supply DEEP — and ours wins). Targets `@mysten-incubation/devstack@0.3.0`.
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
  a best-effort `getBalance` for the dashboard (0 on the fork, where the coin
  registry is unavailable).

The donor address, rationale, risk profile, and caps live in
[`../deployments/fork-impersonation.md`](../deployments/fork-impersonation.md).

## ⚠️ Known blocker — sui-fork

Executing a non-SUI coin transfer on a **stock** sui-fork aborts the fork
process: the SDK enriches the tx's balance-changes via `GetCoinInfo`, which on
the fork misses the (un-materialized) shared CoinRegistry `Currency` object and
hits an unimplemented index `todo!()`. Until sui-fork fixes that, the live path
needs the **patched** fork image. Full report + the patch:
[`../scripts/spikes/devstack-funding/SUI-FORK-NOTES.md`](../scripts/spikes/devstack-funding/SUI-FORK-NOTES.md).
The plugin's logic is correct and unit-tested regardless; the e2e test needs the
patched fork.

## Tests

```bash
pnpm install --ignore-workspace   # nested under sandbox/'s workspace
pnpm test                         # unit tests (stubbed fork sdk.core); excludes *.e2e

# E2E (boots a real fork via devstack's vitest harness) — requires Node >= 24,
# Docker, and the patched fork image (the stock fork aborts; see above):
FORK_IMAGE_CONTEXT="$PWD/../scripts/spikes/devstack-funding/.fork-patched/images" \
pnpm test:e2e
```

`pnpm test:e2e` uses `@mysten-incubation/devstack/vitest`: a `globalSetup`
(`__tests__/global-setup.ts`) boots + tears down the fork fixture stack
(`__tests__/devstack.config.ts`), `__tests__/e2e-setup.ts` captures its manifest
for `getStackContext()`, and the test confirms the boot then queries `alice`'s
DEEP. `alice` is a fixed-keypair recipient (`__tests__/alice.ts`), so the test
queries a deterministic address. It reaches the fork via its **direct host port**
(`docker port`) — the manifest's routed `*.localhost` URL isn't gRPC-reachable
from the host.

If the donor's default coin ids ever go stale (the whale spent them), set
`DEEP_DONOR_COIN_ID` / `SUI_GAS_COIN_ID` from
`node scripts/refresh-donor-coins.mjs` before running.
