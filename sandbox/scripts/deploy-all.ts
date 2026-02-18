import path from "path";
import { getClient, getFaucetUrl, getNetwork, getRpcUrl, getSigner } from "./utils/config";
import {
    getSandboxRoot,
    startLocalnet,
    startRemote,
    configureAndStartLocalnetServices,
    startOracleService,
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
    log.banner(`DeepBook ${network} Deployment`);

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
        log.info("This will take several minutes...");
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
            });
            log.success("Updated .env with pyth oracle IDs");

            log.spin("Starting oracle service container...");
            await startOracleService(sandboxRoot);
            log.success("Oracle service started");
        }

        // Phase 5: Create DEEP/SUI pool
        log.phase("Phase 5/6: Creating DEEP/SUI pool");
        const pool = await poolCreator.createPool(deployedPackages);

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
            pool: {
                poolId: pool.poolId,
                baseCoin: `${deployedPackages.get("token")!.packageId}::deep::DEEP`,
                quoteCoin: "0x2::sui::SUI",
                transactionDigest: pool.transactionDigest,
            },
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

        // Note: Seed liquidity is skipped by default.
        // The market maker will place its own grid when it starts.
        // Run `pnpm seed-liquidity` manually if you need orders before the MM starts.

        // Build summary — only user-facing URLs and key identifiers
        const summaryEntries: Array<{ label: string; value: string }> = [
            { label: "DEEP/SUI Pool", value: pool.poolId },
            { label: "Deployment File", value: deploymentPath },
        ];
        if (network === "testnet") {
            summaryEntries.push({ label: "DeepBook Server", value: "http://127.0.0.1:9008" });
        }

        log.summary("DeepBook Environment Ready", summaryEntries);
        log.warn("Containers are running. Stop with: pnpm down");
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
