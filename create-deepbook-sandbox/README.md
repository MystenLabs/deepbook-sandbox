# create-deepbook-sandbox

Scaffold a [DeepBook V3](https://github.com/MystenLabs/deepbook-sandbox) sandbox environment with a single command.

## Usage

```bash
npx create-deepbook-sandbox my-sandbox
cd my-sandbox/sandbox
pnpm deploy-all
```

## Options

| Flag                | Description                                      | Default            |
| ------------------- | ------------------------------------------------ | ------------------ |
| `--version <tag>`   | GitHub release tag to download                   | `latest`           |
| `--deploy`          | Run `pnpm deploy-all` after scaffolding          | off                |
| `--network <name>`  | Network for deploy: `localnet` or `testnet`      | `localnet`         |

## Prerequisites

- **Node.js 18+**
- **Docker** (running)
- **pnpm** (`npm install -g pnpm`)

## What it does

1. Downloads the repo tarball from the latest GitHub release
2. Extracts it to `<project-name>/`
3. Detects CPU architecture and configures `.env` (ARM64 vs x86_64 Docker images)
4. Runs `pnpm install` in the sandbox directory
5. Optionally runs `pnpm deploy-all` to start localnet and deploy contracts

## Building from source

If you need to build the indexer/server Docker images from source (rather than using pre-built images), initialize the git submodule after scaffolding:

```bash
cd my-sandbox
git init
git submodule add https://github.com/MystenLabs/deepbookv3.git external/deepbook
cd sandbox
pnpm deploy-all  # will build Rust images from source
```

## License

Apache-2.0
