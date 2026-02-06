import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { getClient, getSigner } from '../utils/config';
import { loadConfig, parseEnvConfig } from './config';
import type { DeploymentManifest } from './types';
import { MarketMaker } from './market-maker';

async function findLatestDeployment(): Promise<string> {
	const deploymentsDir = path.join(process.cwd(), 'deployments');

	try {
		const files = await fs.readdir(deploymentsDir);
		const jsonFiles = files.filter((f) => f.endsWith('.json'));

		if (jsonFiles.length === 0) {
			throw new Error('No deployment files found. Run `pnpm deploy-all` first.');
		}

		// Sort by name (which includes timestamp) to get latest
		jsonFiles.sort().reverse();
		return path.join(deploymentsDir, jsonFiles[0]);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error('Deployments directory not found. Run `pnpm deploy-all` first.');
		}
		throw error;
	}
}

async function loadDeployment(deploymentPath?: string): Promise<DeploymentManifest> {
	const filePath = deploymentPath || (await findLatestDeployment());
	console.log(`Loading deployment from: ${filePath}`);

	const content = await fs.readFile(filePath, 'utf-8');
	return JSON.parse(content) as DeploymentManifest;
}

async function main() {
	console.log('='.repeat(50));
	console.log('  DeepBook V3 Market Maker');
	console.log('='.repeat(50));

	// Load deployment manifest
	const deploymentPath = process.env.DEPLOYMENT_PATH;
	const manifest = await loadDeployment(deploymentPath);

	console.log(`Network: ${manifest.network.type}`);
	console.log(`Pool: ${manifest.pool.poolId}`);
	console.log(`Package: ${manifest.packages.deepbook.packageId}`);

	// Load configuration
	const envConfig = parseEnvConfig();
	const config = loadConfig(envConfig);

	console.log('\nConfiguration:');
	console.log(`  Initial mid price: ${config.initialMidPrice}`);
	console.log(`  Spread: ${config.spreadBps} bps`);
	console.log(`  Levels per side: ${config.levelsPerSide}`);
	console.log(`  Order size: ${Number(config.orderSizeBase) / 1e6} DEEP`);
	console.log(`  Rebalance interval: ${config.rebalanceIntervalMs}ms`);

	// Create Sui client and signer
	const client = getClient();
	const signer = getSigner();
	const signerAddress = signer.getPublicKey().toSuiAddress();
	console.log(`\nSigner: ${signerAddress}`);

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
