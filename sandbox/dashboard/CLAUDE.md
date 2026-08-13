# Dashboard

`nginx.conf` replicates the Vite dev-server proxy for the Dockerized build — keep
the two in sync when adding proxied routes.

Routes render inside a pathname-keyed error boundary (`App.tsx`): a page's
render error shows an in-page card instead of unmounting the whole root. A
fully black page with only the dev-wallet widget (its own separate React root)
means a render crash escaped the boundary — check the browser console.

## Fork mode (SEDEFI-456)

The dashboard runs against the devstack mainnet fork as the `trading-dashboard`
member (`devstack-plugins/trading-dashboard.ts` spawns `vite` with resolved
proxy targets + a pre-funded PRIVATE_KEY; `sandbox-api` serves /manifest and
/faucet on 9009). Two fork facts shape the code — both verified live:

- **Everything that touches `simulate_transaction` is dead** (SUI-FORK-ISSUES
  #7): every `@mysten/deepbook-v3` read helper, AND the build-time resolution
  of any unresolved `tx.object(id)` input (`resolveTransactionData` simulates).
  Fork writes must use concrete `objectRef`/`sharedObjectRef` args plus
  explicit gas budget/price/payment (`tx.object.clock()` is safe — inlined).
- **No owner→coins/balance index**: `listBalances`/`listCoins` return `[]`
  even for fork-local coins; `listOwnedObjects` + BCS content parsing is the
  only balance read, and only fork-local (faucet-funded) objects enumerate.
- **Only the bundled dev wallet can transact.** External wallets register
  themselves through the wallet standard (the Slush _extension_ — note
  `slushWalletConfig: null` only blocks the Slush _web_ wallet) and connect
  fine, then fail at signing: they reject the `sui:localnet` chain (`Value
"localnet" does not exist in "Network" enum`) and, if approved anyway,
  execute against their own 127.0.0.1:9000 localnet default ("Failed to
  fetch") — the fork is on a brokered port reachable only via this page's
  same-origin `/api/sui` proxy. The connect modal is therefore filtered to
  `DEV_WALLET_NAME` (`ConnectButton modalOptions.filterFn`) and `WalletGuard`
  banners any other wallet restored from a prior session by autoConnect.
- **Gas budget is a ceiling, not a constant** (`setForkGas`): Sui rejects any
  tx whose gas balance is below the budget, and fork SUI is faucet-sized — the
  sandbox-api faucet grants exactly 0.1 SUI, which equalled the old fixed
  `FORK_GAS_BUDGET`, so every wallet fell below it after its FIRST tx and all
  later writes died with a raw percent-encoded node error. The budget is now
  capped to the sender's actual SUI, with a `FORK_GAS_MIN_BUDGET` (0.02 SUI)
  floor that raises an actionable "top up from the Faucet page" message.

`src/lib/fork.ts` holds all substitutes: derived-dynamic-field reads (BM
discovery via the registry map — note the `BalanceManagerKey` DEFINING package
id constant; BM balances via the Bag), server-backed prices/open orders
(`/ticker`, `/orders/{pool}/{bm}?…&start_time=0` — start_time=0 escapes the
7-day lookback vs the frozen fork clock), and raw PTB builders for
deposit/withdraw/orders. Hooks branch on `isForkManifest(manifest)`
(`use-deepbook-client.ts` — the manifest union covers localnet.json and
mainnet-fork.json shapes). The localnet SDK paths are unchanged.

## Trading Page

The dashboard's Trading page is the user-facing interface for the deepbook protocol. Architecture notes for agents working in this area:

- **BM creation is user-driven, not deploy-time.** `pnpm deploy-all` no longer auto-creates a BalanceManager. Instead, users click "Create Balance Manager" on the Trading page, which builds a single PTB containing `balance_manager::new_with_custom_owner` + `register_balance_manager` + `public_share_object`. Two are SDK helpers (`createBalanceManagerWithOwner`, `shareBalanceManager`); the middle one is a raw `moveCall` because the SDK's `registerBalanceManager` helper takes a config-lookup key and can't reference a freshly-created BM ref.
- **BM discovery is on-chain.** The dashboard calls `client.deepbook.getBalanceManagerIds(address)` (which simulates a tx against `registry::get_balance_manager_ids`) to find the user's registered BMs. No env var, no localStorage, no API endpoint. The deepbook Registry's owner→BM map is the single source of truth.
- **The registry's BM map must be initialized first.** `init_balance_manager_map` is an admin-gated one-time call that creates the dynamic field `register_balance_manager` writes into. We bundle that call into `createDeepbookPools` (`sandbox/scripts/utils/pool.ts`) so it runs as part of `pnpm deploy-all`. It's idempotent (`if !exists`), so re-running deploy-all is safe.
- **Wallet swap correctness:** the BM discovery query is keyed by `account?.address`, and the BM-balances / open-orders queries are keyed by `balanceManagerId`. Disconnecting Wallet A and connecting Wallet B immediately re-runs discovery and shows the empty state for B until B creates its own BM.
- **Trading hooks live at** `sandbox/dashboard/src/components/trading/hooks.ts` — read this file before touching any trading flow. `useCreateBalanceManager` is the canonical BM-creation path; do not duplicate it elsewhere.
