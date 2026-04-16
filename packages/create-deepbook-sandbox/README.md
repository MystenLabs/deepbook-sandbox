# @mysten-incubation/create-deepbook-sandbox

A one-command scaffolder for the [DeepBook V3](https://docs.sui.io/standards/deepbookv3) sandbox: a local development environment with Sui localnet, deployed DeepBook contracts, a market maker, an oracle service, an indexer, and a web dashboard — everything you need to build and test against DeepBook without touching mainnet or testnet.

## What this package does

When you run `pnpm create @mysten-incubation/deepbook-sandbox`, it:

1. Verifies that `docker`, `sui`, `pnpm`, and `git` are installed on your machine
2. Looks up the latest `v*` release tag of the [`deepbook-sandbox`](https://github.com/MystenLabs/deepbook-sandbox) repository
3. Runs `git clone --recurse-submodules --branch <tag>` into your target directory
4. Prints the next commands to run

You get a pinned, reproducible snapshot of the upstream repo and its `external/deepbook` submodule, ready to `pnpm install`.

## Why this scaffolder uses a recursive clone

The sandbox includes [`sandbox/packages/example_contract`](https://github.com/MystenLabs/deepbook-sandbox/tree/main/sandbox/packages/example_contract) — a Move package where you can drop your own contracts and have them publish alongside DeepBook on a fresh localnet, with local Move dependencies wired up against the latest DeepBook source:

```toml
[dependencies]
token = { local = "../../.external-packages/token" }
deepbook = { local = "../../.external-packages/deepbook" }
deepbook_margin = { local = "../../.external-packages/deepbook_margin" }
```

For `example_contract` (and any Move package you add alongside it) to compile against the latest DeepBook interfaces, the Move source for `deepbook`, `token`, and `deepbook_margin` has to physically exist on disk at the paths declared by `local = "../path"`. The sandbox vendors that source via the `external/deepbook` git submodule so it always tracks the latest DeepBook V3 release.

That's why this CLI clones with `--recurse-submodules`: a recursive clone is the simplest way to land the sandbox _and_ the Move source it builds against in one step, so you can start writing and publishing your own Move packages alongside DeepBook immediately.

So this package exists for two reasons:

- **Discoverability** — `pnpm create @mysten-incubation/deepbook-sandbox` is easier to find and remember than a long `git clone` command
- **Preflight + reproducibility** — it checks your toolchain up front and pins you to a tagged release instead of `main`

The manual equivalent is:

```bash
git clone --recurse-submodules --branch <latest-tag> \
  https://github.com/MystenLabs/deepbook-sandbox.git
```

## Quick Start

```bash
pnpm create @mysten-incubation/deepbook-sandbox
```

Or with a custom directory name:

```bash
pnpm create @mysten-incubation/deepbook-sandbox my-project
```

## What you get

The scaffolded workspace includes:

- **Sui localnet** with DeepBook V3 contracts deployed
- **Market maker** providing liquidity on DEEP/SUI and SUI/USDC pools
- **Oracle service** updating Pyth price feeds every 10 seconds
- **DeepBook indexer + API server** for querying on-chain data
- **Web dashboard** for monitoring and interacting with the sandbox
- **SDK examples** demonstrating common DeepBook integrations

## Prerequisites

The CLI checks for these before scaffolding:

- [Docker](https://docs.docker.com/get-docker/)
- [Sui CLI](https://docs.sui.io/guides/developer/getting-started/sui-install)
- [pnpm](https://pnpm.io/installation)
- [git](https://git-scm.com/downloads)

## Usage

After scaffolding, install dependencies and start the sandbox:

```bash
cd <project>/sandbox
pnpm install
pnpm deploy-all
```

This starts localnet, deploys contracts, and launches all services. See the project README for full documentation.

## License

Apache-2.0
