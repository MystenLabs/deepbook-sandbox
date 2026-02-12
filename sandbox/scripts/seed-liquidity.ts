import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { SuiClient } from '@mysten/sui/client';
import type { Keypair } from '@mysten/sui/cryptography';
import { getClient, getSigner } from './utils/config';
import { loadConfig, parseEnvConfig } from './market-maker/config';
import type { DeploymentManifest } from './market-maker/types';
import { explorerObjectUrl, formatPrice, formatDeep } from './market-maker/types';
import { BalanceManagerService } from './market-maker/balance-manager';
import { OrderManager } from './market-maker/order-manager';
import { calculateGridLevels } from './market-maker/grid-strategy';

async function findLatestDeployment(): Promise<string> {
	const deploymentsDir = path.join(process.cwd(), 'deployments');

	try {
		const files = await fs.readdir(deploymentsDir);
		const jsonFiles = files.filter((f) => f.endsWith('.json'));

		if (jsonFiles.length === 0) {
			throw new Error('No deployment files found. Run `pnpm deploy-all` first.');
		}

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

export interface SeedLiquidityOptions {
	client: SuiClient;
	signer: Keypair;
	manifest: DeploymentManifest;
}

/**
 * Seed initial liquidity into a pool. Places a grid of orders on both sides
 * of the order book and exits. Can be called programmatically (from deploy-all)
 * or run standalone via `pnpm seed-liquidity`.
 */
export async function seedLiquidity(options: SeedLiquidityOptions): Promise<void> {
	const { client, signer, manifest } = options;

	const packageId = manifest.packages.deepbook.packageId;
	const poolId = manifest.pool.poolId;
	const baseType = manifest.pool.baseCoin;
	const quoteType = manifest.pool.quoteCoin;
	const network = manifest.network.type;

	const envConfig = parseEnvConfig();
	const config = loadConfig(envConfig);

	console.log('\n=== Seeding Initial Liquidity ===\n');
	console.log(`  Pool: ${poolId}`);
	console.log(`  Mid price: ${Number(config.initialMidPrice) / 1e9} DEEP/SUI`);
	console.log(`  Spread: ${config.spreadBps} bps (${(config.spreadBps / 100).toFixed(2)}%)`);
	console.log(`  Levels per side: ${config.levelsPerSide}`);
	console.log(`  Order size: ${Number(config.orderSizeBase) / 1e6} DEEP`);

	// Create BalanceManager
	console.log('\n1. Creating BalanceManager...');
	const bmService = new BalanceManagerService(client, signer, packageId);
	const bmInfo = await bmService.createBalanceManager();
	const balanceManagerId = bmInfo.balanceManagerId;
	console.log(`   Created: ${balanceManagerId}`);
	console.log(`   ${explorerObjectUrl(balanceManagerId, network)}`);

	// Wait for object to be available
	await new Promise((resolve) => setTimeout(resolve, 2000));

	// Deposit SUI for quote asset (for buying DEEP)
	console.log('2. Depositing SUI...');
	const suiDepositAmount = 10_000_000_000n; // 10 SUI
	await bmService.deposit(balanceManagerId, '0x2::sui::SUI', suiDepositAmount);
	console.log(`   Deposited: ${Number(suiDepositAmount) / 1e9} SUI`);

	// Deposit DEEP for base asset (for selling DEEP)
	console.log('3. Depositing DEEP...');
	const deepDepositAmount = 1_000_000_000n; // 1000 DEEP (6 decimals)
	let hasDeepBalance = false;
	try {
		await bmService.deposit(balanceManagerId, baseType, deepDepositAmount);
		console.log(`   Deposited: ${Number(deepDepositAmount) / 1e6} DEEP`);
		hasDeepBalance = true;
	} catch {
		console.log('   DEEP deposit failed (no DEEP tokens). Placing bid-only orders.');
	}

	// Wait for deposits to propagate
	await new Promise((resolve) => setTimeout(resolve, 3000));

	// Calculate grid levels
	console.log('4. Calculating grid levels...');
	let levels = calculateGridLevels(config);
	if (!hasDeepBalance) {
		levels = levels.filter((l) => l.isBid);
	}

	const bids = levels.filter((l) => l.isBid);
	const asks = levels.filter((l) => !l.isBid);

	// Place orders
	console.log('5. Placing orders...');
	const orderManager = new OrderManager(
		client,
		signer,
		packageId,
		poolId,
		baseType,
		quoteType,
		balanceManagerId,
		network,
	);

	await orderManager.placeOrders(levels);

	// Print summary
	const totalBidSize = bids.reduce((sum, l) => sum + l.quantity, 0n);
	const totalAskSize = asks.reduce((sum, l) => sum + l.quantity, 0n);

	console.log('\n=== Seed Liquidity Summary ===\n');
	if (bids.length > 0) {
		const bestBid = bids.reduce((max, l) => (l.price > max ? l.price : max), 0n);
		const worstBid = bids.reduce((min, l) => (l.price < min ? l.price : min), bids[0].price);
		console.log(`  Bids: ${bids.length} orders from ${formatPrice(worstBid)} to ${formatPrice(bestBid)} DEEP/SUI (${formatDeep(totalBidSize)} DEEP total)`);
	}
	if (asks.length > 0) {
		const bestAsk = asks.reduce((min, l) => (l.price < min ? l.price : min), asks[0].price);
		const worstAsk = asks.reduce((max, l) => (l.price > max ? l.price : max), 0n);
		console.log(`  Asks: ${asks.length} orders from ${formatPrice(bestAsk)} to ${formatPrice(worstAsk)} DEEP/SUI (${formatDeep(totalAskSize)} DEEP total)`);
	}
	console.log(`  Balance Manager: ${balanceManagerId}`);
	console.log(`  Total orders: ${levels.length}`);
	console.log('');
}

// Standalone entry point
async function main() {
	console.log('='.repeat(50));
	console.log('  DeepBook V3 - Seed Initial Liquidity');
	console.log('='.repeat(50));

	const deploymentPath = process.env.DEPLOYMENT_PATH;
	const manifest = await loadDeployment(deploymentPath);
	const client = getClient();
	const signer = getSigner();

	await seedLiquidity({ client, signer, manifest });
}

// Only run main() when executed directly (not imported)
const isDirectExecution =
	process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectExecution) {
	main().catch((error) => {
		console.error('Seed liquidity failed:', error);
		process.exit(1);
	});
}
