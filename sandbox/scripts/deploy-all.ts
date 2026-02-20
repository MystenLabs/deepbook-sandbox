
import {
    getClient,
    getFaucetUrl,
    getNetwork,

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
import { updateEnvFile } from "./utils/env";
import { ensureMinimumBalance, getDeploymentEnv } from "./utils/helpers";
import { readContainerKey, importKeyToHostCli, defaultSuiToolsImage } from "./utils/keygen";
import { PoolCreator } from "./utils/pool";
import { setupPythOracles, type PythOracleIds } from "./utils/oracle";
import { Keypair } from "@mysten/sui/cryptography";
import log from "./utils/logger";

async function main() {
    const network = getNetwork();
    const sandboxRoot = getSandboxRoot();

    log.banner(` DeepBook sandbox [${network}] deployment`);

    try {
        // On localnet, ensure .env has SUI_TOOLS_IMAGE before starting Docker
        if (network === "localnet" && !process.env.SUI_TOOLS_IMAGE) {
            const image = defaultSuiToolsImage();
            updateEnvFile(sandboxRoot, { SUI_TOOLS_IMAGE: image });
            process.env.SUI_TOOLS_IMAGE = image;
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

        if (network === "localnet") {
            // On localnet, always read the container-generated key.
            // Each FORCE_REGENESIS=true run starts a fresh chain, so only the
            // container's key is in the node's keystore. Any PRIVATE_KEY in .env
            // is just a placeholder to satisfy docker-compose variable validation.
            console.log("  Reading key from sui-localnet container...");
            const { keypair, privateKey } = readContainerKey(sandboxRoot);
            signer = keypair;
            process.env.PRIVATE_KEY = privateKey;
            importKeyToHostCli(privateKey, keypair.getPublicKey().toSuiAddress());
            updateEnvFile(sandboxRoot, { PRIVATE_KEY: privateKey });
            console.log("  ✅ Container key imported");
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

        // Phase 6: Start market maker (localnet only)
        if (network === "localnet") {
            log.phase("Phase 6/6: Starting market maker");
            updateEnvFile(sandboxRoot, {
                DEEPBOOK_PACKAGE_ID: deployedPackages.get("deepbook")!.packageId,
                POOL_ID: pools.DEEP_SUI.poolId,
                BASE_COIN_TYPE: pools.DEEP_SUI.baseCoinType,
                DEPLOYER_ADDRESS: signerAddress,
            });
            log.success("Updated .env with market maker IDs");

            await startMarketMaker(sandboxRoot);
            log.success("Market maker started");
        }

        // Build summary — only user-facing URLs and key identifiers
        const summaryEntries: Array<{ label: string; value: string }> = [
            { label: "DEEP/SUI Pool", value: pools.DEEP_SUI.poolId },
            { label: "SUI/USDC Pool", value: pools.SUI_USDC.poolId },
            { label: "SUI Margin Pool", value: marginResult.marginPools.SUI },
            { label: "USDC Margin Pool", value: marginResult.marginPools.USDC },
        ];
        if (network === "testnet") {
            summaryEntries.push({ label: "DeepBook Server", value: "http://127.0.0.1:9008" });
        }

        log.summary("DeepBook Sandbox Ready!", summaryEntries);
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
