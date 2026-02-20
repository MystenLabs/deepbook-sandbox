import path from "path";
import { getClient, getFaucetUrl, getNetwork, getRpcUrl, getSigner } from "./utils/config";
import {
    getSandboxRoot,
    startLocalnet,
    startRemote,
    configureAndStartLocalnetServices,
    startOracleService,
    startMarketMaker,
} from "./utils/docker-compose";
import { MoveDeployer } from "./utils/deployer";
import { updateEnvFile } from "./utils/env";
import { ensureMinimumBalance, getDeploymentEnv } from "./utils/helpers";
import { PoolCreator } from "./utils/pool";
import fs from "fs/promises";
import { setupPythOracles, type PythOracleIds } from "./utils/oracle";
import log from "./utils/logger";

async function main() {
    const network = getNetwork();
    log.banner(` DeepBook sandbox [${network}] deployment`);

    try {
        // Start localnet network if localnet is selected
        if (network === "localnet") {
            log.phase("Starting localnet (docker compose)");
            await startLocalnet(getSandboxRoot());
            log.success("RPC: http://127.0.0.1:9000");
            log.success("Faucet: http://127.0.0.1:9123");
        }

        // Phase 1: Setup Sui client and keypair
        log.phase("Phase 1/6: Setting up Sui client");
        const signer = getSigner();
        const signerAddress = signer.getPublicKey().toSuiAddress();
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

        const sandboxRoot = getSandboxRoot();
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

            log.spin("Starting oracle service container...");
            await startOracleService(sandboxRoot);
            log.success("Oracle service started");
        }

        // Phase 5: Create DEEP/SUI, SUI/USDC deepbook pools and SUI, USDC margin pools
        log.phase("Phase 5/6: Creating DEEP/SUI and SUI/USDC pools");
        const { pools } = await poolCreator.createDeepbookPools(deployedPackages);
        const marginResult = await poolCreator.createMarginPools(deployedPackages, pools);

        // Phase 6: Write configuration file
        log.phase("Phase 6/6: Writing configuration");
        const config = {
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
            pools: Object.fromEntries(
                Object.entries(pools).map(([pair, entry]) => [
                    pair,
                    {
                        poolId: entry.poolId,
                        baseCoin: entry.baseCoinType,
                        quoteCoin: entry.quoteCoinType,
                    },
                ]),
            ),
            marginPools: marginResult.marginPools,
            marginRegistryId: marginResult.registryId,
            deploymentTime: new Date().toISOString(),
            deployerAddress: signerAddress,
        };

        const now = new Date();
        const date = now.toISOString().slice(0, 10);
        const time = now.toISOString().slice(11, 19).replace(/:/g, "-");
        const deploymentsDir = path.join(getSandboxRoot(), "deployments");
        const deploymentPath = path.join(deploymentsDir, `${date}_${time}_${network}.json`);
        await fs.mkdir(deploymentsDir, { recursive: true });
        await fs.writeFile(deploymentPath, JSON.stringify(config, null, 2));

        log.success(`Deployment written to ${deploymentPath}`);

        // Phase 7: Start market maker (localnet only)
        if (network === "localnet") {
            console.log("🤖 Phase 7: Starting market maker...");
            updateEnvFile(sandboxRoot, {
                DEEPBOOK_PACKAGE_ID: deployedPackages.get("deepbook")!.packageId,
                POOL_ID: pools.DEEP_SUI.poolId,
                BASE_COIN_TYPE: pools.DEEP_SUI.baseCoinType,
                DEPLOYER_ADDRESS: signerAddress,
            });
            console.log("  ✅ Updated .env with market maker IDs");

            await startMarketMaker(sandboxRoot);
            console.log("  ✅ Market maker started\n");
        }

        // Note: Seed liquidity is skipped by default.
        // The market maker will place its own grid when it starts.
        // Run `pnpm seed-liquidity` manually if you need orders before the MM starts.

        // Build summary — only user-facing URLs and key identifiers
        const summaryEntries: Array<{ label: string; value: string }> = [
            ...Object.entries(pools).map(([pair, entry]) => ({
                label: `${pair} Pool`,
                value: entry.poolId,
            })),
            ...Object.entries(marginResult.marginPools).map(([coin, poolId]) => ({
                label: `Margin Pool (${coin})`,
                value: poolId,
            })),
            { label: "Deployment File", value: deploymentPath },
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

main().catch((error) => {
    log.fail("Fatal error");
    log.loopError("", error);
    process.exit(1);
});
