import 'dotenv/config';
import { getClient, getNetwork, getSigner } from '../utils/config';
import { loadConfig, parseEnvConfig } from './config';
import type { DeploymentManifest } from './types';
import { explorerObjectUrl } from './types';
import { MarketMaker } from './market-maker';

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}. Run \`pnpm deploy-all\` first.`);
	}
	return value;
}

function loadManifestFromEnv(): DeploymentManifest {
	const network = getNetwork() as 'localnet' | 'testnet';
	const deepbookPackageId = requireEnv('DEEPBOOK_PACKAGE_ID');
	const poolId = requireEnv('POOL_ID');
	const baseCoinType = requireEnv('BASE_COIN_TYPE');
	const deployerAddress = requireEnv('DEPLOYER_ADDRESS');

	// Oracle env vars are optional (only set on localnet)
	const pythPackageId = process.env.PYTH_PACKAGE_ID;
	const deepPriceInfoObjectId = process.env.DEEP_PRICE_INFO_OBJECT_ID;
	const suiPriceInfoObjectId = process.env.SUI_PRICE_INFO_OBJECT_ID;

	return {
		network: {
			type: network,
			rpcUrl: process.env.RPC_URL ?? '',
			faucetUrl: '',
		},
		packages: {
			deepbook: {
				packageId: deepbookPackageId,
				objects: [],
				transactionDigest: '',
			},
			...(pythPackageId && {
				pyth: {
					packageId: pythPackageId,
					objects: [],
					transactionDigest: '',
				},
			}),
		},
		...(deepPriceInfoObjectId && suiPriceInfoObjectId && {
			pythOracles: {
				deepPriceInfoObjectId,
				suiPriceInfoObjectId,
			},
		}),
		pool: {
			poolId,
			baseCoin: baseCoinType,
			quoteCoin: '0x2::sui::SUI',
			transactionDigest: '',
		},
		deploymentTime: '',
		deployerAddress,
	};
}

async function main() {
	console.log('='.repeat(50));
	console.log('  DeepBook V3 Market Maker');
	console.log('='.repeat(50));

	// Build manifest from environment variables
	const manifest = loadManifestFromEnv();

	const network = manifest.network.type;
	console.log(`Network: ${network}`);
	console.log(`Pool: ${manifest.pool.poolId}`);
	console.log(`  ${explorerObjectUrl(manifest.pool.poolId, network)}`);
	console.log(`Package: ${manifest.packages.deepbook.packageId}`);

	// Load configuration
	const envConfig = parseEnvConfig();
	const config = loadConfig(envConfig);

	console.log('\nConfiguration:');
	console.log(`  Pricing: on-chain Pyth oracle (fallback: ${Number(config.fallbackMidPrice) / 1e9} DEEP/SUI)`);
	console.log(`  Spread: ${config.spreadBps} bps (${(config.spreadBps / 100).toFixed(2)}%)`);
	console.log(`  Levels per side: ${config.levelsPerSide}`);
	console.log(`  Order size: ${Number(config.orderSizeBase) / 1e6} DEEP`);
	console.log(`  Rebalance interval: ${config.rebalanceIntervalMs}ms`);

	// Create Sui client and signer
	const client = getClient();
	const signer = getSigner();
	const signerAddress = signer.getPublicKey().toSuiAddress();
	console.log(`\nSigner: ${signerAddress}`);
	console.log(`  ${explorerObjectUrl(signerAddress, network)}`);

	// Create and initialize market maker
	const marketMaker = new MarketMaker({
		client,
		signer,
		manifest,
		config,
	});

	// Setup graceful shutdown
	let isShuttingDown = false;
	const shutdown = async () => {
		if (isShuttingDown) return;
		isShuttingDown = true;
		await marketMaker.stop();
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	// Initialize and start
	try {
		await marketMaker.initialize();
		await marketMaker.start();

		// Keep the process running
		console.log('\nMarket maker running. Press Ctrl+C to stop.\n');
	} catch (error) {
		console.error('\nFatal error:', error);
		await marketMaker.stop();
		process.exit(1);
	}
}

main().catch((error) => {
	console.error('Unhandled error:', error);
	process.exit(1);
});
