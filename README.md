# DeepBook Sandbox

A one-command local development environment for DeepBook V3 — the decentralized
central limit order book (CLOB) on Sui.

The sandbox runs a **fork of real Sui mainnet**: every DeepBook package, pool,
and order that exists on mainnet exists on your machine, frozen at a pinned
checkpoint, and you can transact on top of that state locally. A single
orchestrator (**devstack**) boots the chain, the indexer/REST stack, a trade
simulator that keeps prices moving, and a trading dashboard.

## How it works

`pnpm deploy-all` boots one devstack supervisor
(`sandbox/devstack-plugins/devstack.config.ts`) that runs every part of the
stack as a devstack member:

| Member                | Runs as    | What it does                                                                        |
| --------------------- | ---------- | ----------------------------------------------------------------------------------- |
| **sui-fork**          | container  | The forked mainnet chain (gRPC; RPC port is brokered, not fixed)                    |
| **postgres**          | container  | Database for the indexer (port 5432)                                                |
| **indexer**           | container  | Ingests DeepBook events from the fork into Postgres                                 |
| **server**            | container  | DeepBook REST API on :9008 (Postgres-backed endpoints; live-RPC ones degraded¹)     |
| **trade-sim**         | in-process | Continuous self-fills strictly inside each pool's real spread — keeps prices live   |
| **clock-driver**      | in-process | Holds the fork's on-chain Clock at wall time (the fork clock never ticks by itself) |
| **trading-dashboard** | in-process | The web dashboard's Vite dev server on :5173                                        |
| **sandbox-api**       | in-process | `GET /manifest` + `POST /faucet` on :9009                                           |
| funding + setup tasks | in-process | DEEP/USDC funding, registry init, pools-table seeding                               |

¹ The fork speaks gRPC only, so the server's JSON-RPC-backed endpoints
(/orderbook, /status, …) don't work there; everything indexer-backed
(/ticker, /trades, /ohclv, /orders) does. Full architecture notes live in
[`CLAUDE.md`](./CLAUDE.md) ("The Stack").

**Not running:** the localnet-era market-maker and oracle-service containers
are retired (see Q&A below), and `docker-compose.yml` is gone — devstack is
the only orchestrator.

## Prerequisites

- **Docker Desktop** — allocate at least 8 GB of memory
- **Node.js 24+** and **pnpm**
- **(Optional) Sui CLI** — only for working on the Move code in the submodule
- **(Optional) pre-commit** — `brew install pre-commit` for the git hooks

## Quickstart

```bash
git clone --recurse-submodules https://github.com/MystenLabs/deepbook-sandbox.git
cd deepbook-sandbox/sandbox
pnpm install

pnpm deploy-all   # boot everything, wait for every member to settle
pnpm down         # stop + wipe (removes member containers, resets the chain)
```

> **The first run builds the indexer image from source — a full Rust release
> build that can take an hour.** Later boots reuse the cached images and take
> a few minutes. `STACK_SETTLE_TIMEOUT_MS` overrides the settle budget.
>
> Member containers have **no restart policy**: if one crashes, recover with
> `pnpm down && pnpm deploy-all`. Supervisor logs:
> `tail -f sandbox/.devstack-supervisor.log`.

Once it's up:

| Endpoint           | URL                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Trading dashboard  | [http://localhost:5173](http://localhost:5173) (Trading, Market Maker, Faucet, Deployment) |
| devstack dashboard | http://api.deepbook-sandbox.devstack-plugins.localhost:9810 (stack status, DeepBook panel) |
| DeepBook REST API  | [http://localhost:9008](http://localhost:9008)                                             |
| Sandbox API        | [http://localhost:9009](http://localhost:9009) (`/manifest`, `/faucet`)                    |
| Postgres           | `localhost:5432`                                                                           |

The fork's RPC port is **brokered** (random per boot) — the dashboard reaches
it through its own `/api/sui` proxy; scripts resolve it with
`docker port $(docker ps -qf name=sui-fork) 9000/tcp`.

## Verifying and testing

```bash
# Prices moving? (trade-sim fills every ~600ms)
curl -s localhost:9008/ticker

# The local trades tape (the sim's fills — and yours)
curl -s "localhost:9008/trades/DEEP_SUI?limit=5"

# Fund an address (fixed grants: 100 SUI / 1000 DEEP / 1000 USDC per request)
curl -X POST localhost:9009/faucet \
  -H "Content-Type: application/json" \
  -d '{"address":"0x<your-address>","token":"DEEP"}'

# Unit tests
pnpm test:unit                          # sandbox scripts
pnpm -C devstack-plugins test           # devstack members (incl. trade-sim, clock-driver)

# Boot smoke test (needs Docker + warm images — run deploy-all once first)
pnpm test:integration devstack-up

# Fork clock drifted while the supervisor was down? Pull it back to wall time
pnpm clock:sync
```

In the browser: **`/trading`** to place real orders with the pre-funded dev
wallet, **`/market-maker`** to watch the live order book, depth, and trades
tape.

## Q&A

**How are trades happening right now?**
All continuous trading comes from the **trade-sim** member. Every ~600ms it
reads a pool's real best bid/ask directly off the chain, rests a tiny buy+sell
pair strictly _inside_ that spread, and fills one side against itself in the
same transaction. Because the pair sits inside the real spread it never
executes against the frozen mainnet book and never loses money, so it runs
forever — those self-fills are what keep `/ticker`, the candles, and the
trades tape alive.

**What does the market maker do, and how is it different from trade-sim?**
The market maker is a _liquidity provider_: a grid quoter that maintained ~30
resting orders per side around an oracle-derived mid, rebalancing every 10s.
Trade-sim is an _activity generator_: one self-fill per tick, priced off the
book itself, no oracle dependency. The MM service (and the oracle service that
fed it) are **retired** pending their devstack rework, which is blocked on an
upstream fork issue (gas funding, sui#27520). The dashboard's Market Maker
page therefore reads the pool's book straight off the chain instead of the
MM's API.

**If I place a trade at `/trading`, will it show up?**
Yes. Your order executes on the same fork chain and the indexer picks it up
like any other fill: it appears in the Market Maker page's **Recent Trades**
tape, in the **order book/depth** panels while it rests, in `/ticker` and the
candles if it's the latest fill, and under your own Open Orders. One caveat:
only the bundled pre-funded **dev wallet** can sign on the fork — external
wallets connect but reject the chain.

**Does everything run as a devstack plugin?**
Yes — one supervisor, every service a member (see the table above). Four
members are containers (chain, Postgres, indexer, server); the rest run
in-process inside the supervisor. There is no docker-compose and no separately
managed service.

**Does the sandbox use real Pyth prices from Hermes?**
Three-part answer. (1) The spot DeepBook contract never reads an oracle — a
CLOB's only prices are its orders. (2) The fork _does_ carry the real Pyth
`PriceInfoObject`s with genuine mainnet prices, frozen at the fork checkpoint.
(3) Pushing **live** Hermes updates through the fork's Wormhole verification
is proven and pinned (`deployments/mainnet-fork.json` → `pyth`, spike script
in `sandbox/scripts/spikes/pyth/`), but the service that does it continuously
is not built yet (SEDEFI-317, second half). Until then, on-chain Pyth prices
are real-but-stale; trade-sim deliberately doesn't depend on them.

**Something on the fork behaves strangely — is that known?**
Probably: every fork defect the sandbox has hit (and its workaround) is
cataloged in [`sandbox/SUI-FORK-ISSUES.md`](./sandbox/SUI-FORK-ISSUES.md) —
frozen clock, missing indexes, unsupported simulation, hanging enumeration,
and more.

## Working on the DeepBook Move code

The contracts live in a git submodule at `external/deepbook/`:

```bash
git submodule update --init --recursive     # if not cloned with --recurse-submodules
cd external/deepbook/packages/deepbook
sui move build && sui move test
```

## Digging deeper

- [`CLAUDE.md`](./CLAUDE.md) — full stack architecture, member wiring, commands
- [`sandbox/devstack-plugins/README.md`](./sandbox/devstack-plugins/README.md) — the plugin implementations
- [`sandbox/dashboard/CLAUDE.md`](./sandbox/dashboard/CLAUDE.md) — dashboard fork-mode internals
- [`sandbox/SUI-FORK-ISSUES.md`](./sandbox/SUI-FORK-ISSUES.md) — the fork defect catalog / upstream hand-off list
- `examples/sandbox/` — SDK integration examples (localnet-era; currently blocked on fork limitations)

## Contributing

Install the git hooks with `pre-commit install` (prettier, editorconfig,
whitespace checks). When bumping `@mysten/sui` or `@mysten/deepbook-v3`, bump
the pin in every `package.json` (`sandbox/`, `sandbox/dashboard/`,
`sandbox/api/`, `examples/sandbox/`) and regenerate every lockfile together —
mismatched pins cause type drift between subprojects.
