# Dashboard

`nginx.conf` replicates the Vite dev-server proxy for the Dockerized build — keep
the two in sync when adding proxied routes.

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
