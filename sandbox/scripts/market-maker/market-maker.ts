import type { SuiClient } from '@mysten/sui/client';
import type { Keypair } from '@mysten/sui/cryptography';
import type { MarketMakerConfig } from './config';
import type { DeploymentManifest } from './types';
import { BalanceManagerService } from './balance-manager';
import { OrderManager } from './order-manager';
import { calculateGridLevels } from './grid-strategy';
import { HealthServer, type HealthStatus, type ReadinessStatus } from './health';
import { MetricsServer, updateMetrics, getMetrics } from './metrics';

export interface MarketMakerContext {
	client: SuiClient;
	signer: Keypair;
	manifest: DeploymentManifest;
	config: MarketMakerConfig;
}

export class MarketMaker {
	private client: SuiClient;
	private signer: Keypair;
	private config: MarketMakerConfig;
	private manifest: DeploymentManifest;

	private balanceManagerId: string | null = null;
	private orderManager: OrderManager | null = null;
	private healthServer: HealthServer | null = null;
	private metricsServer: MetricsServer | null = null;

	private isRunning = false;
	private isReady = false;
	private isShuttingDown = false;
	private rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(ctx: MarketMakerContext) {
		this.client = ctx.client;
		this.signer = ctx.signer;
		this.manifest = ctx.manifest;
		this.config = ctx.config;
	}

	/**
	 * Initialize the market maker: create BalanceManager, deposit funds, start servers.
	 */
	async initialize(): Promise<void> {
		console.log('\n=== Initializing Market Maker ===\n');

		const packageId = this.manifest.packages.deepbook.packageId;
		const poolId = this.manifest.pool.poolId;
		const baseType = this.manifest.pool.baseCoin;
		const quoteType = this.manifest.pool.quoteCoin;

		// Create BalanceManager
		console.log('1. Creating BalanceManager...');
		const bmService = new BalanceManagerService(this.client, this.signer, packageId);
		const bmInfo = await bmService.createBalanceManager();
		this.balanceManagerId = bmInfo.balanceManagerId;
		console.log(`   Created: ${this.balanceManagerId}`);

		// Deposit SUI for quote asset (for buying DEEP)
		console.log('2. Depositing SUI...');
		const suiDepositAmount = 10_000_000_000n; // 10 SUI
		await bmService.deposit(this.balanceManagerId, '0x2::sui::SUI', suiDepositAmount);
		console.log(`   Deposited: ${Number(suiDepositAmount) / 1e9} SUI`);

		// Note: DEEP deposit is skipped - on localnet, DEEP may need to be minted
		// via TreasuryCap which requires additional setup. For now, we'll place
		// orders and let them fail if there's no DEEP. In production, you'd fund
		// the BalanceManager with DEEP before starting.
		console.log('3. DEEP deposit skipped (requires minting on localnet)');

		// Create OrderManager
		this.orderManager = new OrderManager(
			this.client,
			this.signer,
			packageId,
			poolId,
			baseType,
			quoteType,
			this.balanceManagerId,
		);

		// Start health check server
		console.log('4. Starting health check server...');
		this.healthServer = new HealthServer(
			() => this.getHealthStatus(),
			() => this.getReadinessStatus(),
		);
		await this.healthServer.start(this.config.healthCheckPort);

		// Start metrics server
		console.log('5. Starting metrics server...');
		this.metricsServer = new MetricsServer();
		await this.metricsServer.start(this.config.metricsPort);

		this.isReady = true;
		console.log('\n=== Market Maker Initialized ===\n');
	}

	/**
	 * Start the rebalance loop.
	 */
	async start(): Promise<void> {
		if (this.isRunning) {
			console.log('Market maker is already running');
			return;
		}

		if (!this.isReady) {
			throw new Error('Market maker not initialized. Call initialize() first.');
		}

		this.isRunning = true;
		console.log('Starting market maker rebalance loop...');
		console.log(`  Rebalance interval: ${this.config.rebalanceIntervalMs}ms`);
		console.log(`  Levels per side: ${this.config.levelsPerSide}`);
		console.log(`  Spread: ${this.config.spreadBps} bps`);
		console.log('');

		// Run initial rebalance
		await this.rebalance();

		// Schedule periodic rebalances
		this.scheduleRebalance();
	}

	/**
	 * Stop the market maker gracefully.
	 */
	async stop(): Promise<void> {
		if (this.isShuttingDown) return; // Prevent multiple shutdown attempts
		this.isShuttingDown = true;
		console.log('\nGraceful shutdown initiated...');
		this.isRunning = false;

		// Stop the rebalance timer
		if (this.rebalanceTimer) {
			clearTimeout(this.rebalanceTimer);
			this.rebalanceTimer = null;
		}

		// Cancel all outstanding orders
		if (this.orderManager && this.orderManager.getActiveOrderCount() > 0) {
			console.log('Canceling outstanding orders...');
			try {
				await this.orderManager.cancelAllOrders();
			} catch (error) {
				console.error('Error canceling orders:', error);
			}
		}

		// Stop servers
		if (this.healthServer) {
			await this.healthServer.stop();
		}
		if (this.metricsServer) {
			await this.metricsServer.stop();
		}

		console.log('Market maker stopped.');
	}

	/**
	 * Execute a single rebalance cycle.
	 */
	private async rebalance(): Promise<void> {
		if (!this.orderManager || this.isShuttingDown) return;

		console.log(`[${new Date().toISOString()}] Rebalancing...`);

		try {
			// Cancel all existing orders
			if (this.orderManager.getActiveOrderCount() > 0) {
				await this.orderManager.cancelAllOrders();
			}

			// Calculate new grid levels
			const levels = calculateGridLevels(this.config);
			console.log(`  Grid: ${levels.filter((l) => l.isBid).length} bids, ${levels.filter((l) => !l.isBid).length} asks`);

			// Place new orders
			await this.orderManager.placeOrders(levels);

			// Update metrics
			updateMetrics({ rebalance: true });
		} catch (error) {
			console.error('  Rebalance error:', error);
			updateMetrics({ error: true });
		}
	}

	/**
	 * Schedule the next rebalance.
	 */
	private scheduleRebalance(): void {
		if (!this.isRunning) return;

		this.rebalanceTimer = setTimeout(async () => {
			await this.rebalance();
			this.scheduleRebalance();
		}, this.config.rebalanceIntervalMs);
	}

	/**
	 * Get current health status.
	 */
	private getHealthStatus(): HealthStatus {
		const metrics = getMetrics();
		return {
			status: this.isRunning ? 'healthy' : 'unhealthy',
			timestamp: new Date().toISOString(),
			uptime: this.healthServer?.getUptime() || 0,
			details: {
				activeOrders: metrics.activeOrders,
				totalOrdersPlaced: metrics.ordersPlacedTotal,
				totalRebalances: metrics.rebalancesTotal,
				errors: metrics.errors,
			},
		};
	}

	/**
	 * Get current readiness status.
	 */
	private getReadinessStatus(): ReadinessStatus {
		return {
			ready: this.isReady,
			timestamp: new Date().toISOString(),
			checks: {
				balanceManager: this.balanceManagerId !== null,
				pool: this.orderManager !== null,
			},
		};
	}
}
