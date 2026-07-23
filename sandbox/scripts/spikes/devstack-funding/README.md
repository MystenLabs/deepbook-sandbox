# Devstack Spike — Non-SUI coinType funding-strategy authoring API (DBSF-031)

Confirms **how a devstack plugin funds an account with a non-SUI coin type**
(DEEP, USDC) — the load-bearing authoring question for the DEEP/USDC funding
plugins in Phases 1–2 (DBSF-007 / DBSF-010). Read against
`@mysten-incubation/devstack@0.1.1`, on a `mode: 'fork'` mainnet stack.

## TL;DR

1. **Contribution API** — `defineFaucetStrategy` is SUI-only. A non-SUI coin
   funding strategy is contributed with the generic `strategyContributor({
capabilityKey: 'coinType:<fullCoinType>', strategy })`, wrapping an
   `AccountFundingStrategy`. **Validated** at the type level _and_ at runtime:
   `devstack up` mounts the plugin, registers the `coinType:<DEEP>` strategy, and
   the account-funding pass **dispatches `alice`'s `{ coin: DEEP, amount }` entry
   to our strategy**.
2. **Strategy body (fork)** — you can't sign (the impersonated whale has no key)
   and can't let the SDK auto-select gas (a fork can't enumerate the sender's
   coins). devstack's own fork faucet solves this with three primitives that are
   **not exported from the package root**; a custom plugin reaches the runtime
   surfaces through the **public `sui` plugin value** (`deps.sui.fork`,
   `deps.sui.sdk.core`) and **re-implements** the build helper. Our body builds
   and submits the empty-sig transfer. **Validated** up to execution.
3. **Live transfer works once a sui-fork bug is fixed — and we proved it.**
   On a stock fork, executing a DEEP transfer aborts the process. DEEP/USDC **are
   migrated** into the on-chain CoinRegistry (shared `Currency<T>` objects exist),
   but the fork never materializes that shared object, so `GetCoinInfo` (which the
   SDK calls to enrich the transfer's balance-changes) misses the registry and
   falls to `RpcIndexes::get_coin_info`, which is `todo!("not supported yet")` →
   abort. SUI is unaffected (its Currency is in genesis). No stock-fork workaround:
   seeding refuses shared objects, and priming the Currency (via `getObject` or a
   no-coin tx) self-aborts — any reference to it trips the same `get_coin_info`.
   With a **one-line sui-fork patch** (`get_coin_info → Ok(None)`,
   see `.fork-patched/`), the full run goes green: **`alice` receives 100 DEEP**
   from the impersonated whale via our plugin. So the authoring API + body are
   correct; the blocker is purely the fork tool. See
   **[SUI-FORK-NOTES.md](./SUI-FORK-NOTES.md)**.

---

## 1. Contribution — `strategyContributor` with a `coinType:` key

`defineFaucetStrategy` contributes under the **SUI faucet** capability key, keyed
by `chainId`, not by coin type:

```ts
// dist/plugins/faucet/index.d.mts
declare function defineFaucetStrategy<ChainId extends string>(decl: {
  readonly chainId: ChainId;
  readonly strategy: FaucetStrategy;            // { request: (req:{address,amount}) => Effect<void> }
  ...
}): StrategyContributorDecl<`faucet:request:${ChainId}`, FaucetStrategy>;
```

For a non-SUI coin you use the lower-level generic it's built on —
`strategyContributor(...)` with a `coinType:<fullCoinType>` capability key. The
built-in `coin.known/fromPackage/builtin` plugins auto-contribute the same key
(a _mint-backed_ strategy at `priority: 0`); a custom plugin contributes its own
at `priority: 1` to win:

```ts
// dist/api/define-capabilities.d.mts
declare const strategyContributor: <const Key extends string, Strategy>(
  decl: Omit<StrategyContributorDecl<Key, Strategy>, "kind">,
) => StrategyContributorDecl<Key, Strategy>;
```

The strategy is an **`AccountFundingStrategy`**:

```ts
// dist/contracts/funding-strategy.d.mts
interface AccountFundingStrategy<E = unknown, A = unknown> {
  readonly request: (req: {
    address: string;
    amount: bigint;
    account?: A;
  }) => Effect.Effect<void, E>;
  readonly usesAccountSigner?: boolean; // true if the body calls account.withTransactionSigner
  readonly requiresRecipientAccount?: boolean; // true if it spends the recipient's own funds
}
```

Accounts then request it — `coin` is a **`CoinMember` ref** (`coin.known(fullType)`),
not a bare string — and devstack's boot-time funding pass resolves each
`{ coin, amount }` entry to the matching `coinType:<fullType>` contributor:

```ts
account("alice", { kind: "ephemeral", funding: [{ coin: deepCoin, amount: 100_000_000n }] });
```

## 2. Body — fork impersonation, re-implementing devstack's unexported helpers

A forked-mainnet funding body has two hard constraints:

- **No signing.** The funding source is a mainnet whale we _impersonate_; we have
  no key. Execution is empty-signature: `executeTransaction({ signatures: [] })`,
  which the fork runs as the declared sender.
- **No enumeration / no `getObject` on coins.** A fresh fork lazy-fetches state
  _by id_; it can't list an un-fetched account's coins, and (see §3) a
  `getObject` on a coin object also aborts it. So **every object is referenced by
  a concrete `{objectId, version, digest}` ref** (derived from mainnet — the fork
  is a snapshot of it) and the PTB is built **offline**.

devstack's own fork faucet does exactly this with `selectSufficientForkCoin` +
`buildForkImpersonationTransactionBytes` + `fork.impersonate` — but **none of
those are exported from `@mysten-incubation/devstack`** (they live in
`dist/plugins/sui/fork-transaction.mjs` + `fork-faucet-strategy.mjs`). So a custom
plugin:

- **reaches the runtime surfaces through the public `sui` plugin value** it
  depends on — `deps.sui.sdk.core` (the fork gRPC client) and `deps.sui.fork`
  (the `ForkAdminSurface`, non-null ⇒ fork mode); and
- **re-implements** the empty-sig tx builder on the public `@mysten/sui` surface
  (pin gas explicitly, supply object inputs as concrete refs, serialize without
  signing). See `funding-plugin.ts`.

> Authoring takeaway for DBSF-007/010: the _public_ surface is sufficient to
> author the plugin, but you re-implement ~30 lines of fork-tx plumbing. Worth
> asking the devstack/AC team to \*\*export `buildForkImpersonationTransactionBytes`
>
> - `selectSufficientForkCoin`\*\* (or expose a `fork.fundCoin(...)` helper) so each
>   coin plugin doesn't re-implement them.

### Why DEEP vs USDC

|      | Strategy body (the `request` closure)                                                       | Source mechanism |
| ---- | ------------------------------------------------------------------------------------------- | ---------------- |
| DEEP | impersonate the whale → `splitCoins` + `transferObjects` (DEEP is fixed-supply, can't mint) | DBSF-001         |
| USDC | impersonate the master-minter → Circle `treasury::mint`                                     | DBSF-002         |

Both are authored identically — a `strategyContributor({ capabilityKey:
'coinType:<X>', strategy })` whose body uses the §2 fork-impersonation plumbing —
only the PTB inside differs.

## 3. The blocker — sui-fork `get_coin_info` is `todo!()` (live transfer)

With the strategy correctly built and submitted, the **fork itself aborts** when
the transfer executes. `GetCoinInfo` (which the SDK calls to enrich the
transfer's balance-changes) is registry-first. **DEEP/USDC are migrated** into
the on-chain CoinRegistry — their shared `Currency<T>` objects exist on mainnet
(DEEP: `0x3f2afb7c…`, Shared) — but the fork's _internal_ `object_store.get_object`
doesn't lazy-fetch that shared object, so the registry lookup misses and falls to
`RpcIndexes::get_coin_info` (`crates/sui-fork/src/store.rs:1332`), which is
`todo!("not supported yet")` → panic → the fork aborts (exit 134; client sees
`RpcError: fetch failed`). SUI is unaffected (its Currency is in genesis).

No stock-fork workaround applies: `--object` seeding **refuses** shared objects,
and priming the Currency — via `getObject` **or** a no-coin
`coin_registry::decimals(&Currency)` tx — **self-aborts**, because any reference
to the coin-typed `Currency` (read or tx-input) trips the same `GetCoinInfo`
(chicken-and-egg; both verified). This is the same shared-object
materialization gap as DBSF-003, surfacing through CoinRegistry — a sui-fork gap
independent of the devstack authoring API and our plugin, but it **blocks live
non-SUI funding (DEEP/USDC) on the fork** (DBSF-007/010). Full root-cause,
evidence, and suggested fix: **[SUI-FORK-NOTES.md](./SUI-FORK-NOTES.md)**.

`.fork-patched/` rebuilds the fork image with `get_coin_info → Ok(None)` (a
one-line `sed` in the bundled `Dockerfile`) — the validated workaround; see
**Status**.

## Files

| File                             | What it is                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `devstack.config.ts`             | The stack: `sui({ mode: 'fork', upstream: 'mainnet' })` + the funding plugin + `coin.known(DEEP)` + `account('alice', { funding })`.                                                       |
| `funding-plugin.ts`              | The custom plugin — `strategyContributor({ capabilityKey: 'coinType:<DEEP>', … })` whose body re-implements the fork-impersonation transfer. The reference shape DBSF-007/010 will follow. |
| `SUI-FORK-NOTES.md`              | sui-fork bug report (`get_coin_info` `todo!()`) — the blocker for live non-SUI fork funding.                                                                                               |
| `.fork-patched/`                 | Patched fork-image build context (gitignored) used to validate the transfer past the sui-fork bug.                                                                                         |
| `package.json` / `tsconfig.json` | Pin `@mysten-incubation/devstack@0.1.1`; `tsc --noEmit` type-checks the config + plugin against the real types.                                                                            |

## Status / how to run

- **API + wiring — validated.** `pnpm typecheck` → 0 errors. `pnpm devstack up`
  (Node ≥ 24, Docker) boots the fork, mounts the `deep-funding` plugin, registers
  the `coinType:<DEEP>` strategy, and **dispatches `alice`'s DEEP funding to it**
  — the authoring wiring works end-to-end, runtime-confirmed.
- **Strategy body — validated up to execution.** It builds the by-id empty-sig
  transfer and submits it via `core.executeTransaction({ signatures: [] })`.
- **Live transfer — blocked on a stock fork, validated on a patched one.** On the
  bundled image the fork aborts on `get_coin_info` (§3 / SUI-FORK-NOTES.md) when
  the DEEP tx executes. With `.fork-patched/` (`get_coin_info → Ok(None)`) the
  run completes: `alice` (`0xf53dc99e…`) ends up holding a **100 DEEP** coin
  (`0x297902517f…`), confirmed both by devstack's settlement check
  (`fundingEntries=DEEP:100000000:funded`) and an independent `listCoins`. To
  reproduce: `FORK_IMAGE_CONTEXT="$PWD/.fork-patched/images" pnpm devstack up`.
- **Image build:** the first `mode:'fork'` run compiles `sui-fork` from source
  (~12 min). devstack enforces a build deadline that a cold compile exceeds; warm
  BuildKit's layer cache first by running the same `docker build` once (devstack's
  bundled context is `<devstack>/images`, dockerfile `sui-fork/Dockerfile`, args
  `SUI_FORK_REV` + `SUI_CLI_VERSION`), then `devstack up` cache-hits in seconds.

```bash
cd sandbox/scripts/spikes/devstack-funding
pnpm install --ignore-workspace   # this dir is inside sandbox/'s pnpm workspace
pnpm typecheck                    # validates the authoring shape (works on Node 22)
# Node >= 24 + Docker:
pnpm devstack up                  # boots the fork, dispatches alice's DEEP funding to our strategy
```

### Runtime requirements (discovered)

- **Docker** — `sui({ mode: 'fork' })` runs sui-fork in a container; the daemon must be up.
- **Node ≥ 24** — devstack `engines`. Use e.g. `nvm use 24`.
- **TS import extensions** — devstack loads the `.ts` config via Node's native
  type-stripping, which does not rewrite `.js`→`.ts`; relative imports use the
  **`.ts`** extension (e.g. `from './funding-plugin.ts'`) with
  `allowImportingTsExtensions` in `tsconfig.json`.
