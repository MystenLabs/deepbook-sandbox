# DeepBook SDK Examples — Implementation Guide

A detailed plan for adding runnable TypeScript examples that demonstrate common DeepBook V3 integrations using the `@mysten/deepbook-v3` SDK against the sandbox environment.

## 1. Codebase Findings

### Project Structure

- **Package manager**: pnpm, ESM (`"type": "module"`)
- **Runtime**: `tsx` (TypeScript executor, no build step)
- **Config**: `dotenv` for `.env` loading, `zod` for validation
- **Sui SDK version**: `@mysten/sui@^1.45.2` (`sandbox/package.json:15`)

### Key Files

| File                                              | Role                                                        |
| ------------------------------------------------- | ----------------------------------------------------------- |
| `sandbox/package.json`                            | Dependencies — uses `@mysten/sui@^1.45.2`                   |
| `sandbox/tsconfig.json`                           | ES2022, ESNext modules, Bundler resolution                  |
| `sandbox/scripts/utils/config.ts`                 | `getClient()`, `getSigner()`, `getNetwork()` — reads `.env` |
| `sandbox/scripts/utils/helpers.ts`                | `ensureMinimumBalance()` — faucet helper                    |
| `sandbox/scripts/utils/env.ts`                    | `updateEnvFile()` — .env reader/writer                      |
| `sandbox/scripts/market-maker/order-manager.ts`   | Places limit orders via raw Move calls (not the SDK)        |
| `sandbox/scripts/market-maker/balance-manager.ts` | Creates BalanceManager + deposits via raw Move calls        |
| `sandbox/scripts/market-maker/types.ts`           | `DeploymentManifest`, `PoolConfig`, constants               |
| `sandbox/scripts/deploy-all.ts`                   | Writes `sandbox/deployments/{network}.json` manifest        |
| `sandbox/.env.example`                            | Documents all env vars                                      |

### Deployment Manifest

After `pnpm deploy-all`, a JSON manifest is written to `sandbox/deployments/localnet.json`:

```json
{
  "network": { "type": "localnet", "rpcUrl": "...", "faucetUrl": "..." },
  "packages": {
    "deepbook": { "packageId": "0x...", "objects": [{ "objectId": "0x...", "objectType": "...::Registry" }, ...], "transactionDigest": "..." },
    "token":    { "packageId": "0x...", "objects": [{ "objectId": "0x...", "objectType": "...::ProtectedTreasury" }, ...], "transactionDigest": "..." },
    "usdc":     { "packageId": "0x...", "objects": [...], "transactionDigest": "..." },
    "pyth":     { "packageId": "0x...", "objects": [...], "transactionDigest": "..." },
    "deepbook_margin": { "packageId": "0x...", "objects": [...], "transactionDigest": "..." }
  },
  "pools": {
    "DEEP_SUI": { "poolId": "0x...", "baseCoinType": "0x<token-pkg>::deep::DEEP", "quoteCoinType": "0x2::sui::SUI" },
    "SUI_USDC": { "poolId": "0x...", "baseCoinType": "0x2::sui::SUI", "quoteCoinType": "0x<usdc-pkg>::usdc::USDC" }
  },
  "pythOracles": { "deepPriceInfoObjectId": "0x...", "suiPriceInfoObjectId": "0x..." },
  "marginPools": { "SUI": "0x...", "USDC": "0x..." },
  "deployerAddress": "0x...",
  "deploymentTime": "..."
}
```

### Critical Finding: SDK Version Incompatibility

`@mysten/deepbook-v3@1.1.5` requires **`@mysten/sui >= 2.5.1`** as a peer dependency. The sandbox uses **`@mysten/sui@^1.45.2`**. The Sui SDK v1 → v2 is a major breaking change (different import paths, API surface). The examples **cannot** share the sandbox's `node_modules` — they need their own package.

### How DeepBook Is Currently Used

The market maker builds raw `Transaction` objects with `tx.moveCall()` calls to `pool::place_limit_order`, `balance_manager::new`, `balance_manager::deposit`, etc. **None of the existing code uses `@mysten/deepbook-v3`.**

### SDK Capabilities Summary

The `@mysten/deepbook-v3` SDK provides:

- **`DeepBookClient`** — main class aggregating all modules
- **Transaction builders** (curried `(tx: Transaction) => void` pattern):
  - `client.deepBook.placeLimitOrder()` / `placeMarketOrder()`
  - `client.deepBook.swapExactBaseForQuote()` / `swapExactQuoteForBase()`
  - `client.deepBook.cancelOrder()` / `cancelAllOrders()`
  - `client.balanceManager.createAndShareBalanceManager()`
  - `client.balanceManager.depositIntoManager()` / `withdrawFromManager()`
- **Read-only queries** (async, return parsed data):
  - `client.getLevel2TicksFromMid()` — order book snapshot
  - `client.midPrice()` — current mid price
  - `client.accountOpenOrders()` — list open orders
  - `client.getAccountOrderDetails()` — detailed order info
  - `client.checkManagerBalance()` — balance in manager

**Custom network support**: When `packageIds` is provided to the constructor, the SDK bypasses hardcoded testnet/mainnet defaults. You must also provide `coins` and `pools` maps (they default to `{}` in custom mode).

---

## 2. Requirements Interpretation

### Concrete Engineering Requirements

1. **New package at `examples/sandbox/`** — own `package.json` with `@mysten/deepbook-v3` and `@mysten/sui@^2`
2. **5 runnable TypeScript files** — each self-contained, executable via `tsx`
3. **Shared config loader (`setup.ts`)** — reads `sandbox/deployments/localnet.json` to get deployment-specific IDs
4. **README** — run instructions assuming sandbox is already deployed

### What "Self-Contained" Means

Each example must:

- Import only from `@mysten/deepbook-v3`, `@mysten/sui`, and a shared config helper
- Initialize the `DeepBookClient` with custom `packageIds`, `coins`, and `pools` from the deployment manifest
- Handle keypair creation, faucet funding, and BalanceManager creation (where needed) within the script
- Print meaningful output (transaction digests, order IDs, prices, etc.)
- Be runnable with `npx tsx <file>` from the examples directory

### Per-Example Requirements

| Example                 | Needs Signer? | Needs Balance Manager? | Read-only? |
| ----------------------- | ------------- | ---------------------- | ---------- |
| `place-limit-order.ts`  | Yes           | Yes                    | No         |
| `place-market-order.ts` | Yes           | Yes                    | No         |
| `check-order-book.ts`   | No\*          | No                     | Yes        |
| `swap-tokens.ts`        | Yes           | No (direct swap)       | No         |
| `query-user-orders.ts`  | Yes           | Yes                    | Partially  |

> \* `DeepBookClient` still requires an `address` parameter — use a dummy/zero address for read-only.

### "swap-tokens.ts" Interpretation

The SDK provides `swapExactBaseForQuote()` / `swapExactQuoteForBase()` — direct wallet swaps that **don't require a BalanceManager**. This is the correct implementation approach. The example swaps SUI → DEEP on the DEEP/SUI pool using `swapExactQuoteForBase`.

This is distinct from `placeMarketOrder()` which requires a BalanceManager. The swap functions take coins directly from the user's wallet and return coins to the wallet — the simplest DeFi interaction pattern.

### Hidden Requirements

- Must construct `CoinMap` and `PoolMap` at runtime from the deployment manifest (localnet coin addresses change per deployment)
- Must use full 0x-prefixed, 64-char addresses for SUI type (`0x0000...0002::sui::SUI`)
- The `DeepBookClient` needs `packageIds.REGISTRY_ID` — must be extracted from `manifest.packages.deepbook.objects` (look for type ending in `::Registry`, excluding `MarginRegistry`)
- `DEEP_TREASURY_ID` lives in `manifest.packages.token.objects` (type containing `ProtectedTreasury`)
- Pools are whitelisted → `payWithDeep: false` for all trading operations

---

## 3. Implementation Plan

### 3.1 Directory Structure

```
examples/
└── sandbox/
    ├── package.json            # @mysten/deepbook-v3, @mysten/sui@^2, tsx, dotenv
    ├── tsconfig.json           # ESM, ES2022
    ├── README.md               # Run instructions
    ├── setup.ts                # Shared: load manifest, build DeepBookClient config
    ├── place-limit-order.ts
    ├── place-market-order.ts
    ├── check-order-book.ts
    ├── swap-tokens.ts
    └── query-user-orders.ts
```

### 3.2 Existing Files to Modify

| File                    | Change                                                        |
| ----------------------- | ------------------------------------------------------------- |
| `sandbox/tsconfig.json` | Add `"../examples"` to `exclude`                              |
| `.gitignore`            | Add `examples/sandbox/node_modules/` (if not already covered) |
| `CLAUDE.md`             | Add a section documenting the examples directory              |

### 3.3 No Reuse of Existing Sandbox Utilities

The existing `sandbox/scripts/utils/config.ts` uses `@mysten/sui@v1` APIs. Examples use `@mysten/sui@v2`. These are **incompatible** (different import paths, different `SuiClient` constructor, different `Transaction` class). The `setup.ts` must be written from scratch against the v2 API.

### 3.4 Dependency Specification

**`examples/sandbox/package.json`**:

```json
{
  "name": "deepbook-sandbox-examples",
  "type": "module",
  "private": true,
  "scripts": {
    "place-limit-order": "tsx place-limit-order.ts",
    "place-market-order": "tsx place-market-order.ts",
    "check-order-book": "tsx check-order-book.ts",
    "swap-tokens": "tsx swap-tokens.ts",
    "query-user-orders": "tsx query-user-orders.ts"
  },
  "dependencies": {
    "@mysten/deepbook-v3": "^1.1.5",
    "@mysten/sui": "^2.5.1",
    "dotenv": "^17.2.3"
  },
  "devDependencies": {
    "tsx": "^4.21.0",
    "typescript": "^5.9.3"
  }
}
```

### 3.5 Shared Setup Module (`setup.ts`)

This is the most critical piece. Responsibilities:

1. **Read `../../sandbox/deployments/localnet.json`** (the deployment manifest)
2. **Extract IDs** from the manifest:
   - `DEEPBOOK_PACKAGE_ID` → `manifest.packages.deepbook.packageId`
   - `REGISTRY_ID` → find in `manifest.packages.deepbook.objects` where `objectType` ends with `::Registry` (not `MarginRegistry`)
   - `DEEP_TREASURY_ID` → find in `manifest.packages.token.objects` where `objectType` contains `ProtectedTreasury`
3. **Build SDK types** (`DeepbookPackageIds`, `CoinMap`, `PoolMap`)
4. **Create `SuiClient`** pointing to `http://127.0.0.1:9000`
5. **Generate a keypair** (or load `PRIVATE_KEY` from environment)
6. **Fund via sandbox faucet** at `http://127.0.0.1:9009/faucet` (distributes both SUI and DEEP)

**Exports**:

```typescript
// Types
interface SandboxConfig {
  suiClient: SuiClient;
  keypair: Ed25519Keypair;
  address: string;
  manifest: DeploymentManifest;
  deepBookClient: DeepBookClient;
}

// Factory that does all setup
async function setupSandbox(): Promise<SandboxConfig>;

// Read-only variant (no signer, no funding)
function createReadOnlyClient(): { suiClient: SuiClient; deepBookClient: DeepBookClient };
```

**Coin definitions** (runtime-constructed from manifest):

```typescript
const coins = {
  DEEP: {
    address: manifest.packages.token.packageId,
    type: manifest.pools.DEEP_SUI.baseCoinType, // "0x<pkg>::deep::DEEP"
    scalar: 1_000_000, // 6 decimals
  },
  SUI: {
    address: "0x0000000000000000000000000000000000000000000000000000000000000002",
    type: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
    scalar: 1_000_000_000, // 9 decimals
  },
  USDC: {
    address: manifest.packages.usdc.packageId,
    type: manifest.pools.SUI_USDC.quoteCoinType, // "0x<pkg>::usdc::USDC"
    scalar: 1_000_000, // 6 decimals
  },
};
```

**Pool definitions** (runtime-constructed):

```typescript
const pools = {
  DEEP_SUI: {
    address: manifest.pools.DEEP_SUI.poolId,
    baseCoin: "DEEP",
    quoteCoin: "SUI",
  },
  SUI_USDC: {
    address: manifest.pools.SUI_USDC.poolId,
    baseCoin: "SUI",
    quoteCoin: "USDC",
  },
};
```

### 3.6 BalanceManager Lifecycle

The SDK's `DeepBookClient` takes `balanceManagers` at construction time. But we need to create one on-chain first. The pattern:

```typescript
// Step 1: Create initial client (no balance managers)
const client = new DeepBookClient({ ... });

// Step 2: Create BalanceManager on-chain
const tx = new Transaction();
tx.add(client.balanceManager.createAndShareBalanceManager());
const result = await suiClient.signAndExecuteTransaction({ transaction: tx, signer: keypair });

// Step 3: Extract the created object ID from transaction effects
const bmObjectId = extractCreatedObjectId(result, "BalanceManager");

// Step 4: Re-create client with balance manager registered
const clientWithBM = new DeepBookClient({
  ...sameOptions,
  balanceManagers: {
    MANAGER_1: { address: bmObjectId },
  },
});
```

The `setup.ts` should export a helper for this two-step flow:

```typescript
async function setupWithBalanceManager(): Promise<SandboxConfig & { balanceManagerKey: string }>;
```

### 3.7 Per-Example Implementation Notes

#### `check-order-book.ts` (simplest — start here)

```
1. Call createReadOnlyClient()
2. Query mid price: client.midPrice("DEEP_SUI")
3. Query order book: client.getLevel2TicksFromMid("DEEP_SUI", 5)
4. Print formatted table:
   - ASK  0.120  100.0 DEEP
   - ASK  0.115   50.0 DEEP
   - --- mid: 0.110 ---
   - BID  0.105   50.0 DEEP
   - BID  0.100  100.0 DEEP
5. Optionally query SUI_USDC pool too
```

**Comments to include**: What a CLOB is, what bids/asks mean, what the mid price represents, what tick sizes do.

#### `place-limit-order.ts`

```
1. Call setupWithBalanceManager()
2. Deposit SUI into balance manager:
   tx.add(client.balanceManager.depositIntoManager("MANAGER_1", "SUI", 1))  // 1 SUI
3. Place a limit BID below market:
   tx.add(client.deepBook.placeLimitOrder({
     poolKey: "DEEP_SUI",
     balanceManagerKey: "MANAGER_1",
     clientOrderId: "1",
     price: 0.05,          // well below market so it rests
     quantity: 10,          // 10 DEEP
     isBid: true,
     orderType: OrderType.NO_RESTRICTION,
     selfMatchingOption: SelfMatchingOptions.SELF_MATCHING_ALLOWED,
     payWithDeep: false,    // whitelisted pool
   }))
4. Execute and sign
5. Print: tx digest, confirm order placed
6. Verify by querying: client.accountOpenOrders("DEEP_SUI", "MANAGER_1")
```

**Comments to include**: What a BalanceManager is and why it's needed, limit order semantics (price, quantity, isBid), order types (NO_RESTRICTION, POST_ONLY, IOC, FOK), what `payWithDeep: false` means for whitelisted pools.

#### `place-market-order.ts`

```
1. Call setupWithBalanceManager()
2. Deposit SUI into balance manager (enough for a buy)
3. Place a market BUY:
   tx.add(client.deepBook.placeMarketOrder({
     poolKey: "DEEP_SUI",
     balanceManagerKey: "MANAGER_1",
     clientOrderId: "1",
     quantity: 10,          // 10 DEEP
     isBid: true,
     payWithDeep: false,
   }))
4. Execute and sign
5. Print: tx digest, check balance after fill
```

**Comments to include**: How market orders differ from limit orders, why a market order needs resting liquidity (the market maker provides it), expected fill behavior.

**Prerequisite note**: Market maker must be running (it is, after `pnpm deploy-all`).

#### `swap-tokens.ts`

```
1. Call setupSandbox() (no balance manager needed)
2. Print initial SUI and DEEP balances
3. Swap SUI → DEEP using direct wallet swap:
   tx.add(client.deepBook.swapExactQuoteForBase({
     poolKey: "DEEP_SUI",
     amount: 0.1,         // 0.1 SUI
     deepAmount: 0,       // no DEEP fee (whitelisted)
     minOut: 0,           // no slippage protection for simplicity
   }))
4. Execute and sign
5. Print final balances and the difference
```

**Comments to include**: Difference between swap and market order (swap uses wallet coins directly, no BalanceManager), what `minOut` does (slippage protection), what `deepAmount` is for (fee payment on non-whitelisted pools).

#### `query-user-orders.ts`

```
1. Call setupWithBalanceManager()
2. Deposit and place a resting limit order (far from market, won't fill)
3. Query open orders:
   const orders = await client.accountOpenOrders("DEEP_SUI", "MANAGER_1")
4. Get order details:
   const details = await client.getAccountOrderDetails("DEEP_SUI", "MANAGER_1")
5. Print order details (price, quantity, side, status)
6. Cancel all orders:
   tx.add(client.deepBook.cancelAllOrders("DEEP_SUI", "MANAGER_1"))
7. Query again — show empty
8. Print: confirmed all orders canceled
```

**Comments to include**: How to inspect on-chain order state, what fields are available, how cancellation works, the difference between `cancelOrder` (single) and `cancelAllOrders`.

### 3.8 README Contents

**`examples/sandbox/README.md`** should include:

````markdown
# DeepBook Sandbox Examples

Runnable TypeScript examples demonstrating common DeepBook V3 integrations
using the `@mysten/deepbook-v3` SDK against a local sandbox.

## Prerequisites

1. The sandbox must be deployed and running:
   ```bash
   cd sandbox
   pnpm deploy-all
   ```
````

This starts localnet, deploys contracts, launches the oracle service
and market maker. Wait for "DeepBook Sandbox Ready!" before proceeding.

2. Install example dependencies:
   ```bash
   cd examples/sandbox
   pnpm install
   ```

## Examples

| Example              | Description                                             |
| -------------------- | ------------------------------------------------------- |
| `check-order-book`   | Query the DEEP/SUI order book (read-only)               |
| `place-limit-order`  | Create a BalanceManager and place a resting limit order |
| `place-market-order` | Place a market order that fills against MM liquidity    |
| `swap-tokens`        | Swap SUI → DEEP directly from your wallet               |
| `query-user-orders`  | Place, query, and cancel orders                         |

### Run an example

```bash
pnpm check-order-book
pnpm place-limit-order
pnpm place-market-order
pnpm swap-tokens
pnpm query-user-orders
```

## How It Works

Each example reads the deployment manifest at `sandbox/deployments/localnet.json`
(generated by `pnpm deploy-all`) to discover package IDs, pool addresses, and coin
types. A fresh keypair is generated and funded via the sandbox faucet for each run.

The shared `setup.ts` module handles:

- Reading the deployment manifest
- Constructing `DeepBookClient` with custom localnet package IDs, coins, and pools
- Generating and funding a keypair
- Creating BalanceManagers (for examples that need one)

## Troubleshooting

- **"ENOENT ... localnet.json"** — Run `pnpm deploy-all` in the sandbox directory first.
- **"fetch failed" / connection refused** — Make sure localnet is running (`docker ps`).
- **Market order / swap returns empty fill** — The market maker may not have placed orders yet. Wait 10-15 seconds after deploy-all completes and retry.
- **"Insufficient gas"** — The faucet may be slow. The setup retries automatically, but if it persists check `docker compose logs sui-localnet`.

````

### 3.9 Error Handling Approach

Each example should:
- Wrap the main logic in a `try/catch`
- Print human-readable error messages (not raw stack traces)
- Exit with non-zero code on failure
- Use `process.exit(1)` on unrecoverable errors

The `setup.ts` should:
- Throw clear errors if manifest is missing ("Run `pnpm deploy-all` first")
- Throw if faucet funding fails after retries
- Validate manifest structure before extracting IDs

### 3.10 Comment and Documentation Approach

Each example file should have:
- A top-level JSDoc comment explaining what the example demonstrates
- Inline comments before each significant step (not obvious lines)
- Comments explaining DeepBook-specific concepts (BalanceManager, trade proof, order types)
- No comments on import statements or basic language constructs

---

## 4. Risks and Open Questions

### Critical Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `@mysten/sui` v1↔v2 incompatibility | High | Isolated `package.json` in `examples/sandbox/` — no code sharing with sandbox utils |
| SDK may not work against localnet-deployed packages | Medium | Verify by running `check-order-book.ts` first (read-only, safest); fallback to raw Move calls if SDK has bugs |
| BalanceManager create-then-register lifecycle | Low | Two-step `DeepBookClient` instantiation pattern |
| `swapExactQuoteForBase` on whitelisted pools | Low | Use `deepAmount: 0`; verify against sandbox |
| Full-length SUI address required by SDK | Low | The manifest stores full-length types from on-chain; SUI address hardcoded to 64-char form |

### Open Questions

1. **Manifest vs `.env` for config source?**
   Recommendation: manifest JSON — it has structured data including Registry ID and full coin type strings. `PRIVATE_KEY` comes from env or is generated fresh.

2. **Fresh keypair or deployer's key?**
   Recommendation: generate a fresh keypair per run and fund via the sandbox faucet service (port 9009, distributes both SUI and DEEP). This avoids gas coin conflicts with the market maker.

3. **Do market order / swap examples need the market maker running?**
   Yes — without resting orders there's nothing to match against. The README must state this. `pnpm deploy-all` starts the MM automatically.

4. **Does the SDK's `createAndShareBalanceManager` return the object ID directly?**
   Needs verification. The curried function builds the tx but doesn't return the ID. We must extract it from `signAndExecuteTransaction` result's `objectChanges`. The pattern from `sandbox/scripts/market-maker/balance-manager.ts:48-56` applies.

5. **Faucet for DEEP tokens**: The sandbox faucet at port 9009 distributes both SUI and DEEP. For examples that need DEEP (market orders on non-whitelisted pools), we call the faucet with `{ token: "DEEP" }`. For our whitelisted pools, this isn't strictly needed but is useful for deposit examples.

---

## 5. Validation Plan

### Execution Order (progressive risk)

```bash
# Terminal 1: Ensure sandbox is running
cd sandbox && pnpm deploy-all

# Terminal 2: Install and run examples
cd examples/sandbox && pnpm install

# 1. Read-only (lowest risk, validates SDK config)
pnpm check-order-book
# Expected: prints bid/ask prices, mid price

# 2. Direct swap (no balance manager, validates tx signing)
pnpm swap-tokens
# Expected: prints tx digest, balance changes

# 3. Limit order (validates balance manager flow)
pnpm place-limit-order
# Expected: prints BM ID, order placed, open orders list

# 4. Market order (validates fill against MM liquidity)
pnpm place-market-order
# Expected: prints tx digest, fill confirmation

# 5. Query orders (validates full order lifecycle)
pnpm query-user-orders
# Expected: prints orders, cancels, empty list
````

### What Each Step Validates

| Step                 | Validates                                                                        |
| -------------------- | -------------------------------------------------------------------------------- |
| `check-order-book`   | SDK initialization, manifest parsing, CoinMap/PoolMap construction, read queries |
| `swap-tokens`        | Transaction signing with v2 SDK, coin handling, pool interaction                 |
| `place-limit-order`  | BalanceManager creation, deposit, limit order placement                          |
| `place-market-order` | Market order fill, interaction with MM liquidity                                 |
| `query-user-orders`  | Order query APIs, cancel flow, full lifecycle                                    |

### Failure Modes to Watch For

- **`ResourceNotFoundError`** — coin/pool key not found in SDK config → wrong CoinMap/PoolMap construction
- **`TypeError: Cannot read properties of undefined`** — SDK v2 API mismatch
- **`Transaction failed: insufficient gas`** → faucet not funded enough
- **`EquivocationError`** → gas coin conflict with market maker (mitigated by using fresh keypair)
- **Empty order book** → market maker hasn't placed orders yet (add retry/wait)

---

## 6. Implementation Sequence

Recommended order of implementation:

1. **`package.json` + `tsconfig.json`** — set up the package, install deps
2. **`setup.ts`** — manifest loader + SDK configuration (most complex piece)
3. **`check-order-book.ts`** — validate the setup works (read-only, fastest feedback)
4. **`swap-tokens.ts`** — validate transaction signing without BalanceManager
5. **`place-limit-order.ts`** — validate BalanceManager flow
6. **`place-market-order.ts`** — builds on limit order pattern
7. **`query-user-orders.ts`** — builds on limit order + adds query/cancel
8. **`README.md`** — document everything
9. **Modify `.gitignore`, `CLAUDE.md`, `sandbox/tsconfig.json`** — housekeeping
