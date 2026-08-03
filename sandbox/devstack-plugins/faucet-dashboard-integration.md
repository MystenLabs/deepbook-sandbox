# Faucet & dashboard integration for the DEEP & USDC funding plugins

How the DEEP and USDC funding plugins reach users — the dashboard's Faucet panel
and the sandbox's `POST /faucet` HTTP endpoint — and what's decided vs. deferred.

## TL;DR

- **Verified:** devstack's built-in dashboard auto-surfaces our contributed
  `coinType:<DEEP>` **and** `coinType:<USDC>` strategies as **editable-amount**
  faucet actions — no UI code needed. Run `pnpm verify:dashboard-faucet` to
  reproduce.
- **Decided:** drop the sandbox's custom Faucet page in favor of devstack's panel;
  keep `POST /faucet` as a **thin proxy** into devstack's faucet for builders on
  the legacy HTTP endpoint.
- **Deferred:** the actual wiring lands when the sandbox runtime migrates to
  `devstack.config.ts` (the infra-swap phase) — there's no devstack faucet to
  proxy to, or dashboard to switch, until then.

## Why deferred

The plugin is **fork-mode** (impersonate a mainnet whale) and is composed into a
running stack only by `devstack.config.ts`. Today the sandbox runs the **custom
localnet stack** (`docker-compose.yml` + `deploy-all.ts`, a custom React
dashboard, and `sandbox/api/src/services/coin-faucet.ts` which transfers
_localnet_ DEEP from the deployer). The plugin can't run there. So the faucet/
dashboard rework is part of the same change that replaces the custom runtime with
devstack — retiring `coin-faucet.ts`'s DEEP path now would just break the current
localnet faucet.

## What's verified now

`pnpm verify:dashboard-faucet` boots `sui({ mode: 'fork' })` + the DEEP and USDC
funding plugins + devstack's `dashboard()` and queries the dashboard's GraphQL
`fundableCoins`. It confirms both are listed as editable-amount actions:

```json
[
  {
    "symbol": "DEEP",
    "coinType": "0xdeeb7a46…::deep::DEEP",
    "honorsAmount": true,
    "requiresAccountSigner": false
  },
  {
    "symbol": "USDC",
    "coinType": "0xdba34672…::usdc::USDC",
    "honorsAmount": true,
    "requiresAccountSigner": false
  }
]
```

devstack's dashboard derives this from the strategy registry — any
`coinType:<X>` contributor becomes a fund action automatically (built-in SUI is
listed too, fixed-amount). The strategy only needs to be **registered**, so this
verifies without funding anything.

The DEEP plugin also publishes `remainingDeep` (a best-effort donor balance) for
a "DEEP available: N" indicator next to the panel. (USDC has no equivalent — it
mints, so there's no donor balance to drain.)

## Decisions (implemented at runtime composition)

1. **Dashboard** — drop the custom Faucet page (`sandbox/dashboard/src/components/faucet-page.tsx`).
   devstack's panel covers SUI + every contributed coin strategy (DEEP and
   USDC), with editable amounts, for free.
2. **`POST /faucet`** — keep as a **thin proxy** that routes DEEP through
   devstack's faucet (the contributed strategy / the dashboard's `fundCoin`
   mutation), for backward compatibility with builders/scripts pointing at the
   legacy endpoint. Retire it entirely only if no legacy consumers remain — final
   call when the proxy target exists.
3. **Remaining-balance indicator** — surface `remainingDeep`. It reads the
   donor's funding-source coin by known id (`getObject` with
   `include: { json: true }` — see `deep-funding.ts`), which works on the fork
   and decrements as sessions draw; it falls back to `0` only if the coin is
   missing/unreadable.

## Deferred work (runtime-composition / infra-swap phase)

- Implement the `POST /faucet` thin proxy (or retire `coin-faucet.ts`'s DEEP path
  and update `CLAUDE.md` to point builders at the devstack-managed faucet).
- Switch the dashboard to devstack's built-in panel.
- Add an integration test confirming `POST /faucet { coin: 'deep', … }` routes
  through the plugin against the running stack.

## Re-verify

```bash
nvm use 24
FORK_IMAGE_CONTEXT="$PWD/../scripts/spikes/devstack-funding/.fork-patched/images" \
pnpm verify:dashboard-faucet
```

Needs Docker + Node ≥ 24 + a fork image. Without `FORK_IMAGE_CONTEXT` the default
devstack fork image cold-builds (~12 min); the patched build context is cached.
