import fs from 'fs/promises';
import path from 'path';
import { getClient, getNetwork, getSigner } from '../utils/config';
import { getSandboxRoot } from '../utils/docker-compose';
import { PythClient } from './pyth-client';
import { OracleUpdater } from './oracle-updater';
import type { OracleConfig } from './types';
import { DEEP_PRICE_FEED_ID, SUI_PRICE_FEED_ID } from './constants';

/**
 * Oracle Service - Updates Pyth price feeds on localnet
 *
 * This service:
 * 1. Fetches historical price data from Pyth Network API every 10 seconds
 * 2. Updates the SUI and DEEP PriceInfoObjects on-chain
 * 3. Uses the latest deployment configuration
 */

const DEFAULT_CONFIG: OracleConfig = {
	pythApiUrl: 'https://benchmarks.pyth.network',
	priceFeeds: {
		sui: SUI_PRICE_FEED_ID,
		deep: DEEP_PRICE_FEED_ID,
	},
	updateIntervalMs: 10000, // 10 seconds
	historicalDataHours: 24, // Fetch data from 24 hours ago
};

async function loadLatestDeployment() {
	const deploymentsDir = path.join(getSandboxRoot(), 'deployments');

	try {
		const files = await fs.readdir(deploymentsDir);
		const jsonFiles = files
			.filter((f) => f.endsWith('.json'))
			.sort()
			.reverse(); // Latest first

		if (jsonFiles.length === 0) {
			throw new Error('No deployment files found');
		}

		const latestFile = jsonFiles[0];
		const deploymentPath = path.join(deploymentsDir, latestFile);
		const content = await fs.readFile(deploymentPath, 'utf-8');
		const deployment = JSON.parse(content);

		console.log(`📄 Loaded deployment: ${latestFile}`);
		return deployment;
	} catch (error) {
		throw new Error(`Failed to load deployment: ${error}`);
	}
}

async function main() {
	console.log('🔮 Starting Oracle Service...\n');

	const network = getNetwork();
	if (network !== 'localnet') {
		throw new Error(
			'Oracle service is only supported on localnet. Current network: ' +
				network,
		);
	}

	// Load deployment configuration
	const deployment = await loadLatestDeployment();

	if (!deployment.pythOracles) {
		throw new Error(
			'No pythOracles found in deployment. Make sure you ran deploy-all first.',
		);
	}

	const { deepPriceInfoObjectId, suiPriceInfoObjectId } =
		deployment.pythOracles;
	const pythPackageId = deployment.packages.pyth.packageId;

	console.log('📋 Configuration:');
	console.log(`  Network: ${network}`);
	console.log(`  Pyth Package: ${pythPackageId}`);
	console.log(`  SUI Oracle: ${suiPriceInfoObjectId}`);
	console.log(`  DEEP Oracle: ${deepPriceInfoObjectId}`);
	console.log(
		`  Update Interval: ${DEFAULT_CONFIG.updateIntervalMs / 1000}s\n`,
	);

	// Initialize clients
	const client = getClient(network);
	const signer = getSigner();
	const pythClient = new PythClient(DEFAULT_CONFIG);
	const oracleUpdater = new OracleUpdater(client, signer, pythPackageId);

	// Test connection
	try {
		const chainId = await client.getChainIdentifier();
		console.log(`✅ Connected to chain: ${chainId}\n`);
	} catch (error) {
		throw new Error(`Failed to connect to Sui RPC: ${error}`);
	}

	let updateCount = 0;
	let errorCount = 0;

	console.log('🚀 Starting price feed updates...\n');

	// Update loop
	const updatePrices = async () => {
		try {
			const startTime = Date.now();

			// Fetch price data from Pyth
			const priceUpdate = await pythClient.fetchPriceUpdates();

			// Update on-chain oracles
			await oracleUpdater.updatePriceFeeds(priceUpdate.parsed, {
				sui: suiPriceInfoObjectId,
				deep: deepPriceInfoObjectId,
			});

			updateCount++;
			const elapsed = Date.now() - startTime;
			console.log(
				`  ⏱️  Update #${updateCount} completed in ${elapsed}ms (errors: ${errorCount})\n`,
			);
		} catch (error) {
			errorCount++;
			console.error(`❌ Update failed (error #${errorCount}):`, error);
			console.log('  Continuing...\n');
		}
	};

	// Initial update
	await updatePrices();

	// Schedule periodic updates
	setInterval(updatePrices, DEFAULT_CONFIG.updateIntervalMs);

	// Keep process alive
	console.log('👀 Oracle service is running. Press Ctrl+C to stop.\n');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
	console.log('\n\n🛑 Shutting down oracle service...');
	process.exit(0);
});

process.on('SIGTERM', () => {
	console.log('\n\n🛑 Shutting down oracle service...');
	process.exit(0);
});

// Start service
main().catch((error) => {
	console.error('\n❌ Oracle service failed:', error);
	process.exit(1);
});
