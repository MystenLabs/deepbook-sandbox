import path from 'path';
import { getClient, getFaucetUrl, getNetwork, getRpcUrl, getSigner } from './utils/config';
import { getSandboxRoot, startLocalnet, startRemote, startLocalnetIndexerAndServer } from './utils/docker-compose';
import { MoveDeployer } from './utils/deployer';
import { updateEnvFile } from './utils/env';
import { ensureMinimumBalance, getDeploymentEnv } from './utils/helpers';
import { PoolCreator } from './utils/pool';
import fs from 'fs/promises';

async function main() {
	const network = getNetwork();
	console.log(`🚀 Starting DeepBook ${network} deployment...\n`);

	try {
		// Start localnet network if localnet is selected
		if (network === 'localnet') {
			console.log('📦 Starting localnet (docker compose)...');
			const { rpcPort, faucetPort } = await startLocalnet(getSandboxRoot());
			console.log(`  ✅ RPC: http://127.0.0.1:${rpcPort}`);
			console.log(`  ✅ Faucet: http://127.0.0.1:${faucetPort}\n`);
		}

		// Phase 1: Setup Sui client and keypair
		console.log('🔑 Phase 1: Setting up Sui client...');
		const signer = getSigner();
		const signerAddress = signer.getPublicKey().toSuiAddress();
		console.log(`  Signer address: ${signerAddress}`);
		console.log(`  Network: ${network}`);

		const client = getClient(network);

		// Verify RPC is working
		try {
			const chainId = await client.getChainIdentifier();
			console.log(`  ✅ Connected to chain: ${chainId}\n`);
		} catch (error) {
			throw new Error(`Failed to connect to Sui RPC: ${error}`);
		}

		// Phase 2: Fund deployer address
		console.log('💰 Phase 2: Funding deployer address...');
		const poolCreator = new PoolCreator(client, signer, getFaucetUrl(network));
		await ensureMinimumBalance(client, signerAddress, getFaucetUrl(network));

		// Phase 3: Deploy Move packages
		console.log('📝 Phase 3: Deploying Move packages...');
		console.log('  This will take several minutes...\n');
		const deployer = new MoveDeployer(client, signer, network);
		const deployedPackages = await deployer.deployAll();

		console.log('\n  📦 Deployment Summary:');
		for (const [name, result] of deployedPackages.entries()) {
			console.log(`    - ${name}: ${result.packageId}`);
		}
		console.log();

		const sandboxRoot = getSandboxRoot();
		let firstCheckpoint: string | undefined;
		if (network === 'testnet') {
			const tokenResult = deployedPackages.get('token')!;
			await client.waitForTransaction({ digest: tokenResult.transactionDigest });
			const tx = await client.getTransactionBlock({
				digest: tokenResult.transactionDigest,
				options: {},
			});
			firstCheckpoint = tx.checkpoint ?? undefined;
		}
		const envUpdates = getDeploymentEnv(deployedPackages, { firstCheckpoint });
		if (network === 'localnet') {
			envUpdates.FIRST_CHECKPOINT = '0';
		}

		updateEnvFile(sandboxRoot, envUpdates);
		console.log('  ✅ Updated .env with deployment IDs and FIRST_CHECKPOINT\n');		

		// Phase 4: Start deepbook-indexer and server (testnet only)
		if (network === 'testnet') {
			console.log('📡 Phase 4: Starting deepbook-indexer and server (docker compose --profile remote)...');
			const { serverPort } = await startRemote(sandboxRoot, envUpdates);
			console.log(`  ✅ DeepBook server: http://127.0.0.1:${serverPort}\n`);
		} else {
			console.log('📡 Phase 4: Starting custom server and indexer for localnet\n');
			const deepbookPkg = deployedPackages.get('deepbook')!;
			const marginPkg = deployedPackages.get('deepbook_margin');
			await startLocalnetIndexerAndServer(
				{
					corePackageId: deepbookPkg.packageId,
					...(marginPkg && { marginPackageId: marginPkg.packageId }),
				},
				sandboxRoot,
			);
		}

		// Phase 5: Create DEEP/SUI pool
		console.log('🏊 Phase 5: Creating DEEP/SUI pool...');
		console.log(deployedPackages);
		const pool = await poolCreator.createPool(deployedPackages);
		console.log();

		// Phase 6: Write configuration file
		console.log('📄 Phase 6: Writing configuration...');
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
			pool: {
				poolId: pool.poolId,
				baseCoin: `${deployedPackages.get('deepbook')!.packageId}::deep::DEEP`,
				quoteCoin: '0x2::sui::SUI',
				transactionDigest: pool.transactionDigest,
			},
			deploymentTime: new Date().toISOString(),
			deployerAddress: signerAddress,
		};

		const now = new Date();
		const date = now.toISOString().slice(0, 10);
		const time = now.toISOString().slice(11, 19).replace(/:/g, '-');
		const deploymentsDir = path.join(getSandboxRoot(), 'deployments');
		const deploymentPath = path.join(deploymentsDir, `${date}_${time}_${network}.json`);
		await fs.mkdir(deploymentsDir, { recursive: true });
		await fs.writeFile(deploymentPath, JSON.stringify(config, null, 2));

		console.log(`  ✅ Deployment written to ${deploymentPath}\n`);

		// Phase 8: Success!
		console.log('✨ DeepBook environment ready!\n');
		console.log('📋 Deployment Info:');
		console.log(`  • RPC URL: ${getRpcUrl(network)}`);
		console.log(`  • Faucet URL: ${getFaucetUrl(network)}`);
		if (network === 'testnet') {
			console.log(`  • DeepBook Server: http://127.0.0.1:9008`);
		}
		console.log(`  • Deployer Address: ${signerAddress}`);
		console.log(`  • DEEP/SUI Pool: ${pool.poolId}`);
		console.log(`  • Deployment File: ${deploymentPath}\n`);
		console.log('⚠️  Containers are running. Stop with:');
		console.log('   pnpm down\n');
	} catch (error) {
		console.error('\n❌ Deployment failed:');
		console.error(error);
		console.error(
			'\n⚠️  Containers may still be running. Check with: docker ps',
		);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});
