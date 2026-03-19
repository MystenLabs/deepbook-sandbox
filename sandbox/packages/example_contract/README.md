# Custom Contracts

This is a placeholder for your own Move contracts that depend on DeepBook. The `example_contract/` is a minimal template showing how to set up dependencies and publish against a local DeepBook deployment.

## Prerequisites

- Docker installed and running
- [Sui CLI](https://docs.sui.io/guides/developer/getting-started/sui-install) installed

## Step 1: Configure the environment

Copy the env example and fill in the required values:

```bash
cd sandbox
cp .env.example .env
```

Edit `.env` and set:

- `**PRIVATE_KEY**` — Your deployer private key (`suiprivkey1...` format). Export your active key with:
  ```bash
  sui keytool export --key-identity $(sui client active-address)
  ```
- `**SUI_TOOLS_IMAGE**` — Choose based on your CPU architecture:
  - Apple Silicon (M1/M2/M3/M4): `mysten/sui-tools:mainnet-v1.63.3-arm64`
  - Intel/AMD (x86_64): `mysten/sui-tools:mainnet-v1.63.3`

## Step 2: Deploy DeepBook

From the `sandbox/` directory, run:

```bash
pnpm deploy-all
```

This will:

1. Start a local Sui node via Docker
2. Deploy all DeepBook packages (token, deepbook, pyth, usdc, deepbook_margin, margin_liquidation)
3. Create a DEEP/SUI and SUI/USDC trading pool
4. Start the oracle service and market maker
5. Save all deployment info to `**sandbox/Pub.localnet.toml**` — this file tracks every published package address and is used by the Sui CLI to resolve on-chain dependencies

## Step 3: Create your contract

Create your custom contract inside `sandbox/packages/` following the `example_contract` template. Use the available local dependencies in your `Move.toml`:

### Available local dependencies

| Dependency           | Path                                          | Description                                            |
| -------------------- | --------------------------------------------- | ------------------------------------------------------ |
| `token`              | `../../.external-packages/token`              | DEEP token definition                                  |
| `deepbook`           | `../../.external-packages/deepbook`           | Core DeepBook package (pools, orders, balance manager) |
| `deepbook_margin`    | `../../.external-packages/deepbook_margin`    | Margin trading extension                               |
| `margin_liquidation` | `../../.external-packages/margin_liquidation` | Margin liquidation logic                               |
| `pyth`               | `../pyth`                                     | Pyth oracle price feeds                                |
| `usdc`               | `../usdc`                                     | USDC coin type                                         |

> **Note:** The `.external-packages/` directory is created automatically by `pnpm deploy-all`. Your contract won't build until you've run it at least once.

Your `Move.toml` should include an `[environments]` section — this works together with the `--build-env localnet` flag at publish time to tell the compiler which network environment to target. The chain ID value is automatically set by `deploy-all` (you can find it in `Pub.localnet.toml`):

```toml
[environments]
localnet = "<chain-id>"
```

## Step 4: Publish your contract

From your contract directory, run:

```bash
cd packages/<example_contract>
sui client test-publish --build-env localnet --pubfile-path ../../Pub.localnet.toml
```

The `--pubfile-path ../../Pub.localnet.toml` flag tells the Sui CLI where to find the already-published DeepBook packages so it can resolve your dependencies against the live localnet deployment.

The `[environments]` section in your `Move.toml` and `--build-env localnet` flag work together to tell the compiler which network environment to target.

## Tips

- **Iterating on your contract**: You only need to run `pnpm deploy-all` once. After that, you can keep re-publishing your custom contract as many times as you need — the `Pub.localnet.toml` will accumulate your published packages too.
- **Fresh start**: Run `pnpm down` to tear down everything (containers, volumes, env keys), then `pnpm deploy-all` again. You'll need to re-publish your custom contract since the chain state is wiped.
- **Building without publishing**: Run `sui move build --build-env localnet` from your contract directory to check compilation without publishing.

## Troubleshooting

### Duplicate dependency error when publishing

If you get a "duplicate dependency" error for `pyth` (or another transitive dependency) when publishing, it means the compiler is resolving the same package from two different paths. This happens when your `Move.toml` uses a relative path (e.g., `../pyth`) that resolves differently than the path recorded in `Pub.localnet.toml`.

**Fix:** Replace the relative path with the full absolute path as it appears in `sandbox/Pub.localnet.toml`. For example:

```toml
# Instead of:
pyth = { local = "../pyth" }

# Use the full path (check Pub.localnet.toml for the exact value):
pyth = { local = "/Users/you/path/to/deepbook-sandbox/sandbox/packages/pyth" }
```

This ensures the compiler sees the dependency as the same package that was already published, avoiding the duplicate.
