import { getClient, getFaucetUrl, getNetwork, getRpcUrl, getSigner } from './utils/config';
import { getSandboxRoot, startLocalnet } from './utils/docker-compose';
import { MoveDeployer } from './utils/deployer';
import { requestFaucetWithRetry } from './utils/helpers';
import { PoolCreator } from './utils/pool';
import fs from 'fs/promises';

async function main() {
	const network = getNetwork();
	console.log(`🚀 Starting DeepBook ${network} deployment...\n`);

	try {
		// Phase 1: Start containers
		if (network === 'localnet') {
			console.log('📦 Phase 1: Starting localnet (docker compose)...');
			const { rpcPort, faucetPort } = await startLocalnet(getSandboxRoot());
			console.log(`  ✅ RPC: http://127.0.0.1:${rpcPort}`);
			console.log(`  ✅ Faucet: http://127.0.0.1:${faucetPort}\n`);
		}

		// Phase 2: Setup Sui client and keypair
		console.log('🔑 Phase 2: Setting up Sui client...');
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

		// Phase 3: Fund deployer address
		console.log('💰 Phase 3: Funding deployer address...');
		const poolCreator = new PoolCreator(client, signer, getFaucetUrl(network));
		const faucetHost = getFaucetUrl(network);
		await requestFaucetWithRetry(faucetHost, signerAddress);
		// Wait for coins to be available
		await new Promise((resolve) => setTimeout(resolve, 2000));

		// Verify we have coins
		const coins = await client.getCoins({ owner: signerAddress });
		console.log(`  ✅ Received ${coins.data.length} coin(s)\n`);

		// Phase 4: Deploy Move packages
		console.log('📝 Phase 4: Deploying Move packages...');
		console.log('  This will take several minutes...\n');
		const deployer = new MoveDeployer(client, signer);
		const deployedPackages = await deployer.deployAll();

		console.log('\n  📦 Deployment Summary:');
		for (const [name, result] of deployedPackages.entries()) {
			console.log(`    - ${name}: ${result.packageId}`);
		}
		console.log();

		// Phase 5: Start indexer (testnet only)

		// Phase 6: Create DEEP/SUI pool
		console.log('🏊 Phase 6: Creating DEEP/SUI pool...');
		console.log(deployedPackages);
		const pool = await poolCreator.createPool(deployedPackages);
		console.log();

		// Phase 7: Write configuration file
		console.log('📄 Phase 7: Writing configuration...');
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

		await fs.mkdir('./scripts/config', { recursive: true });
		await fs.writeFile(
			'./scripts/config/deployed.json',
			JSON.stringify(config, null, 2),
		);

		console.log('  ✅ Config written to scripts/config/deployed.json\n');

		// Phase 8: Success!
		console.log('✨ DeepBook environment ready!\n');
		console.log('📋 Deployment Info:');
		console.log(`  • RPC URL: ${getRpcUrl(network)}`);
		console.log(`  • Faucet URL: ${getFaucetUrl(network)}`);
		console.log(`  • Deployer Address: ${signerAddress}`);
		console.log(`  • DEEP/SUI Pool: ${pool.poolId}`);
		console.log(`  • Config File: scripts/config/deployed.json\n`);

		if (network === 'localnet') {
			console.log('⚠️  Localnet is running. Stop with:');
			console.log('   docker compose --profile localnet down\n');
		} else if (network === 'testnet') {
			console.log('⚠️  Containers are running. Stop them with:');
			console.log('   docker stop $(docker ps -q)\n');
		}
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
