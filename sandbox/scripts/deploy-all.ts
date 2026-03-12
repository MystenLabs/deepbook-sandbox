import path from "path";
import fs from "fs/promises";
import {
    getClient,
    getFaucetUrl,
    getNetwork,
    getRpcUrl,
    getSigner,
    hasPrivateKey,
} from "./utils/config";
import {
    getSandboxRoot,
    startLocalnet,
    startRemote,
    configureAndStartLocalnetServices,
    startOracleService,
    startMarketMaker,
} from "./utils/docker-compose";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { MoveDeployer } from "./utils/deployer";
import { updateEnvFile, validateEnvFile } from "./utils/env";
import { ensureMinimumBalance, getDeploymentEnv } from "./utils/helpers";
import { readContainerKey, importKeyToHostCli, defaultSuiToolsImage } from "./utils/keygen";
import { PoolCreator } from "./utils/pool";
import { setupPythOracles, type PythOracleIds } from "./utils/oracle";
import { serializePoolConfigs, type PoolConfig } from "./market-maker/types";
import { Keypair } from "@mysten/sui/cryptography";
import log, { c } from "./utils/logger";

async function main() {
    const quick = process.argv.includes("--quick");
    const network = getNetwork();
    const sandboxRoot = getSandboxRoot();

    log.banner(` DeepBook sandbox [${network}] deployment`);
    if (quick)
        log.info("Quick mode: skipping indexer and server image builds (using pre-built images)");

    // Validate .env before doing anything else.
    // On localnet, PRIVATE_KEY is auto-generated if missing, so we only
    // enforce the other required keys. Non-localnet requires everything.
    const envCheck = validateEnvFile(sandboxRoot);
    if (!envCheck.valid) {
        const missing =
            network === "localnet"
                ? envCheck.missing.filter((k) => k !== "PRIVATE_KEY")
                : envCheck.missing;

        if (!envCheck.fileExists && network === "localnet") {
            log.info("No .env found — will create one during setup");
        } else if (missing.length > 0) {
            throw new Error(
                `sandbox/.env is missing required keys: ${missing.join(", ")}. ` +
                    (envCheck.fileExists
                        ? "Your .env file exists but is incomplete — fix it before deploying."
                        : `Create a .env with the required keys before deploying to ${network}.`),
            );
        }
    }

    try {
        // On localnet, ensure .env has the minimum variables docker compose
        // needs to parse the file (even for services we don't start yet).
        const hasUserKey = hasPrivateKey();
        if (network === "localnet") {
            const defaults: Record<string, string> = {};
            if (!process.env.SUI_TOOLS_IMAGE) {
                defaults.SUI_TOOLS_IMAGE = defaultSuiToolsImage();
            }
            if (!hasUserKey) {
                // Placeholder so docker compose doesn't reject ${PRIVATE_KEY:?...}.
                // Replaced in Phase 1 with the container-generated key.
                defaults.PRIVATE_KEY = Ed25519Keypair.generate().getSecretKey();
            }
            if (Object.keys(defaults).length > 0) {
                updateEnvFile(sandboxRoot, defaults);
                Object.assign(process.env, defaults);
            }
        }

        // Start localnet network if localnet is selected
        if (network === "localnet") {
            log.phase("Starting localnet (docker compose)");
            await startLocalnet(sandboxRoot);
            log.success("RPC: http://127.0.0.1:9000");
            log.success("Faucet: http://127.0.0.1:9123");
        }

        // Phase 1: Setup Sui client and keypair
        log.phase("Phase 1/6: Setting up Sui client");

        let signer: Keypair;

        if (network === "localnet" && hasUserKey) {
            // Use the existing key from .env
            signer = getSigner();
            importKeyToHostCli(process.env.PRIVATE_KEY!, signer.getPublicKey().toSuiAddress());
            log.success("Using PRIVATE_KEY from .env");
        } else if (network === "localnet") {
            // No user key — read the container-generated key
            log.info("Reading key from sui-localnet container...");
            const { keypair, privateKey } = readContainerKey(sandboxRoot);
            signer = keypair;
            process.env.PRIVATE_KEY = privateKey;
            importKeyToHostCli(privateKey, keypair.getPublicKey().toSuiAddress());
            updateEnvFile(sandboxRoot, { PRIVATE_KEY: privateKey });
            log.success("Container key imported");
        } else if (hasPrivateKey()) {
            signer = getSigner();
        } else {
            throw new Error("PRIVATE_KEY is required for testnet deployments. Set it in .env.");
        }

        let signerAddress = signer.getPublicKey().toSuiAddress();
        log.detail(`Signer: ${signerAddress}`);
        log.detail(`Network: ${network}`);

        const client = getClient(network);

        // Verify RPC is working
        try {
            const chainId = await client.getChainIdentifier();
            log.success(`Connected to chain: ${chainId}`);
        } catch (error) {
            throw new Error(`Failed to connect to Sui RPC: ${error}`);
        }

        // Phase 2: Fund deployer address
        log.phase("Phase 2/6: Funding deployer address");
        const poolCreator = new PoolCreator(client, signer, getFaucetUrl(network));
        await ensureMinimumBalance(client, signerAddress, getFaucetUrl(network));

        // Phase 3: Deploy Move packages
        log.phase("Phase 3/6: Deploying Move packages");
        log.info("This will take a few seconds...");
        const deployer = new MoveDeployer(client, signer, network);
        const deployedPackages = await deployer.deployAll();

        let firstCheckpoint: string | undefined;
        if (network === "testnet") {
            const tokenResult = deployedPackages.get("token")!;
            await client.waitForTransaction({ digest: tokenResult.transactionDigest });
            const tx = await client.getTransactionBlock({
                digest: tokenResult.transactionDigest,
                options: {},
            });
            firstCheckpoint = tx.checkpoint ?? undefined;
        }
        const envUpdates = getDeploymentEnv(deployedPackages, { firstCheckpoint });
        if (network === "localnet") {
            envUpdates.FIRST_CHECKPOINT = "0";
        }

        updateEnvFile(sandboxRoot, envUpdates);
        log.success("Updated .env with deployment IDs and FIRST_CHECKPOINT");

        // Phase 4: Start deepbook-indexer and server (testnet only)
        if (network === "testnet") {
            log.phase("Phase 4/6: Starting deepbook-indexer and server");
            const { serverPort } = await startRemote(sandboxRoot, envUpdates);
            log.success(`DeepBook server: http://127.0.0.1:${serverPort}`);
        } else {
            log.phase("Phase 4/6: Starting indexer and services for localnet");
            const deepbookPkg = deployedPackages.get("deepbook")!;
            const marginPkg = deployedPackages.get("deepbook_margin");
            await configureAndStartLocalnetServices(
                {
                    corePackageId: deepbookPkg.packageId,
                    ...(marginPkg && { marginPackageId: marginPkg.packageId }),
                },
                sandboxRoot,
                { quick },
            );
        }

        // Setup the pyth oracles for localnet
        let pythOracleIds: PythOracleIds | undefined;
        if (network === "localnet") {
            log.phase("Setting up pyth oracles");
            log.spin("Creating price feed objects...");
            pythOracleIds = await setupPythOracles(client, signer, deployedPackages);

            const pythPkg = deployedPackages.get("pyth")!;
            updateEnvFile(sandboxRoot, {
                PYTH_PACKAGE_ID: pythPkg.packageId,
                DEEP_PRICE_INFO_OBJECT_ID: pythOracleIds.deepPriceInfoObjectId,
                SUI_PRICE_INFO_OBJECT_ID: pythOracleIds.suiPriceInfoObjectId,
                USDC_PRICE_INFO_OBJECT_ID: pythOracleIds.usdcPriceInfoObjectId,
            });
            log.success("Updated .env with pyth oracle IDs");

            // Generate a dedicated keypair for the oracle service so it
            // doesn't share gas coins with the market maker / deployer.
            log.spin("Generating oracle service keypair...");
            const oracleKeypair = Ed25519Keypair.generate();
            const oracleAddress = oracleKeypair.getPublicKey().toSuiAddress();
            const oraclePrivateKey = oracleKeypair.getSecretKey(); // bech32 suiprivkey1...
            log.detail(`Oracle signer: ${oracleAddress}`);

            await ensureMinimumBalance(client, oracleAddress, getFaucetUrl(network));
            updateEnvFile(sandboxRoot, {
                ORACLE_PRIVATE_KEY: oraclePrivateKey,
            });
            log.success("Oracle service keypair funded and saved to .env");

            log.spin("Starting oracle service container...");
            await startOracleService(sandboxRoot);
            log.success("Oracle service started");
        }

        // Phase 5: Create DEEP/SUI, SUI/USDC deepbook pools and SUI, USDC margin pools
        log.phase("Phase 5/6: Creating DEEP/SUI and SUI/USDC pools");
        const { pools } = await poolCreator.createDeepbookPools(deployedPackages);
        const marginResult = await poolCreator.createMarginPools(deployedPackages, pools);

        // Write deployment manifest (reference-only, not read by services)
        const manifest = {
            network: {
                type: network,
                rpcUrl: getRpcUrl(network),
                faucetUrl: getFaucetUrl(network),
            },
            packages: Object.fromEntries(
                Array.from(deployedPackages.entries()).map(([name, data]) => [
                    name,
                    {
                        packageId: data.packageId,
                        objects: data.createdObjects.map((obj) => ({
                            objectId: obj.objectId,
                            objectType: obj.objectType,
                        })),
                        transactionDigest: data.transactionDigest,
                    },
                ]),
            ),
            ...(pythOracleIds && {
                pythOracles: {
                    deepPriceInfoObjectId: pythOracleIds.deepPriceInfoObjectId,
                    suiPriceInfoObjectId: pythOracleIds.suiPriceInfoObjectId,
                },
            }),
            pools: {
                DEEP_SUI: pools.DEEP_SUI,
                SUI_USDC: pools.SUI_USDC,
            },
            marginPools: marginResult.marginPools,
            deploymentTime: new Date().toISOString(),
            deployerAddress: signerAddress,
        };

        const deploymentsDir = path.join(getSandboxRoot(), "deployments");
        const deploymentPath = path.join(deploymentsDir, `${network}.json`);
        await fs.mkdir(deploymentsDir, { recursive: true });
        await fs.writeFile(deploymentPath, JSON.stringify(manifest, null, 2));
        log.success(`Deployment manifest: ${deploymentPath}`);

        // Phase 6: Start market maker (localnet only)
        if (network === "localnet") {
            log.phase("Phase 6/6: Starting market maker");

            // Build multi-pool config for the market maker
            const mmPools: PoolConfig[] = [
                {
                    poolId: pools.DEEP_SUI.poolId,
                    baseCoinType: pools.DEEP_SUI.baseCoinType,
                    quoteCoinType: pools.DEEP_SUI.quoteCoinType,
                    basePriceInfoObjectId: pythOracleIds?.deepPriceInfoObjectId,
                    quotePriceInfoObjectId: pythOracleIds?.suiPriceInfoObjectId,
                    tickSize: 1_000_000n, // 0.001 SUI
                    lotSize: 1_000_000n, // 1 DEEP
                    minSize: 10_000_000n, // 10 DEEP
                    orderSizeBase: 10_000_000n, // 10 DEEP per order
                    fallbackMidPrice: 100_000_000n, // 0.1 SUI
                    baseDepositAmount: 1_000_000_000n, // 1000 DEEP
                    quoteDepositAmount: 10_000_000_000n, // 10 SUI
                    baseDecimals: 6,
                    quoteDecimals: 9,
                },
                {
                    poolId: pools.SUI_USDC.poolId,
                    baseCoinType: pools.SUI_USDC.baseCoinType,
                    quoteCoinType: pools.SUI_USDC.quoteCoinType,
                    basePriceInfoObjectId: pythOracleIds?.suiPriceInfoObjectId,
                    quotePriceInfoObjectId: pythOracleIds?.usdcPriceInfoObjectId,
                    tickSize: 1_000n, // 0.001 USDC
                    lotSize: 100_000_000n, // 0.1 SUI
                    minSize: 1_000_000_000n, // 1 SUI
                    orderSizeBase: 1_000_000_000n, // 1 SUI per order
                    fallbackMidPrice: 3_500_000n, // 3.5 USDC
                    baseDepositAmount: 10_000_000_000n, // 10 SUI
                    quoteDepositAmount: 100_000_000n, // 100 USDC
                    baseDecimals: 9,
                    quoteDecimals: 6,
                },
            ];

            updateEnvFile(sandboxRoot, {
                DEEPBOOK_PACKAGE_ID: deployedPackages.get("deepbook")!.packageId,
                DEPLOYER_ADDRESS: signerAddress,
                // Legacy single-pool vars (backward compat for tests and fallback)
                POOL_ID: pools.DEEP_SUI.poolId,
                BASE_COIN_TYPE: pools.DEEP_SUI.baseCoinType,
                // Multi-pool config for the market maker
                MM_POOLS: serializePoolConfigs(mmPools),
            });
            log.success("Updated .env with market maker config");

            await startMarketMaker(sandboxRoot);
            log.success("Market maker started (DEEP/SUI + SUI/USDC)");
        }

        // Build summary — only user-facing URLs and key identifiers
        const summaryEntries: Array<{ label: string; value: string }> = [
            { label: "DEEP/SUI Pool", value: pools.DEEP_SUI.poolId },
            { label: "SUI/USDC Pool", value: pools.SUI_USDC.poolId },
            { label: "SUI Margin Pool", value: marginResult.marginPools.SUI },
            { label: "USDC Margin Pool", value: marginResult.marginPools.USDC },
            { label: "Deployment File", value: deploymentPath },
        ];
        if (network === "testnet") {
            summaryEntries.push({ label: "DeepBook Server", value: "http://127.0.0.1:9008" });
        }

        log.summary("DeepBook Sandbox Ready!", summaryEntries);

        if (network === "localnet" && !hasUserKey) {
            const line = c.yellow("!".repeat(60));
            console.log(line);
            console.log(c.yellow(c.bold("  A NEW WALLET WAS AUTO-GENERATED FOR THIS DEPLOYMENT")));
            console.log(c.yellow(`  Address: ${signerAddress}`));
            console.log(c.yellow("  The private key has been saved to sandbox/.env"));
            console.log(c.yellow("  Back it up if you want to reuse this wallet."));
            console.log(line);
            console.log();
        }

        log.warn("The Deepbook Sandbox is running. To stop it run: pnpm down");
    } catch (error) {
        log.fail("Deployment failed");
        log.loopError("", error);
        log.warn("Containers may still be running. Check with: docker ps");
        process.exit(1);
    }
}

// Top-level await keeps the module evaluation pending, which adds a ref'd
// handle to the event loop. Without this, Node.js can exit prematurely when
// fetch() (backed by undici) is the only async operation — its unref'd sockets
// don't prevent the event loop from draining.
// The keepalive interval is a safety net: it's a ref'd timer that guarantees
// the event loop stays alive even if all other handles are momentarily unref'd.
const keepalive = setInterval(() => {}, 30_000);
try {
    await main();
} catch (error) {
    log.fail("Fatal error");
    log.loopError("", error);
    process.exit(1);
} finally {
    clearInterval(keepalive);
}
