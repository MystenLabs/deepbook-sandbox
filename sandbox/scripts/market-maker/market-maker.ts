import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Keypair } from "@mysten/sui/cryptography";
import type { MarketMakerConfig } from "./config";
import type { DeploymentManifest, PoolConfig } from "./types";
import { BalanceManagerService } from "./balance-manager";
import { OrderManager } from "./order-manager";
import { calculateGridLevels, buildGridParams } from "./grid-strategy";
import { fetchOracleMidPrice } from "./price-feed";
import { explorerObjectUrl, formatAmount, pairLabel } from "./types";
import {
    HealthServer,
    type HealthStatus,
    type ReadinessStatus,
    type OrdersResponse,
    type PoolOrdersResponse,
} from "./health";
import { MetricsServer, updateMetrics, getMetrics } from "./metrics";
import log from "../utils/logger";

export interface MarketMakerContext {
    client: SuiGrpcClient;
    signer: Keypair;
    manifest: DeploymentManifest;
    config: MarketMakerConfig;
}

/** Per-pool runtime state. */
interface PoolState {
    pool: PoolConfig;
    label: string;
    orderManager: OrderManager;
    hasBaseBalance: boolean;
    lastMidPrice: bigint | null;
}

/** Per-coin funding plan aggregated across all pools. */
interface CoinPlan {
    amount: bigint;
    decimals: number;
    label: string;
}

export class MarketMaker {
    private client: SuiGrpcClient;
    private signer: Keypair;
    private config: MarketMakerConfig;
    private manifest: DeploymentManifest;

    private balanceManagerId: string | null = null;
    private bmService: BalanceManagerService | null = null;
    /**
     * Per-coin target balance in the BM, summed across every pool that uses it.
     * Populated during initialize() and consulted each cycle by topUpBeforeCycle()
     * to replenish drift caused by organic fills.
     */
    private depositPlan: Map<string, CoinPlan> = new Map();
    /** Coins that succeeded their initial deposit — the only ones eligible for top-up. */
    private depositedCoins: Set<string> = new Set();
    private poolStates: PoolState[] = [];
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
        log.phase("Initializing Market Maker");
        log.resetSteps();

        const packageId = this.manifest.packages.deepbook.packageId;

        // Create BalanceManager (shared across all pools)
        log.step("Creating BalanceManager...");
        this.bmService = new BalanceManagerService(this.client, this.signer, packageId);
        const bmInfo = await this.bmService.createBalanceManager();
        this.balanceManagerId = bmInfo.balanceManagerId;
        log.success(`Created: ${this.balanceManagerId}`);
        log.detail(explorerObjectUrl(this.balanceManagerId, this.manifest.network.type));

        // Wait for object to be available on localnet
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Build the per-coin funding plan: sum (not max) each coin's deposit across
        // every pool that uses it. Taking the max leaves the BM short whenever a
        // coin is used by more than one pool (e.g. SUI as quote in DEEP/SUI and
        // base in SUI/USDC) — the two pools' locks compete for the same balance.
        this.depositPlan = new Map();
        for (const pool of this.manifest.pools) {
            const baseLabel = pool.baseCoinType.split("::").pop()?.toUpperCase() ?? "BASE";
            const quoteLabel = pool.quoteCoinType.split("::").pop()?.toUpperCase() ?? "QUOTE";

            const existingBase = this.depositPlan.get(pool.baseCoinType);
            this.depositPlan.set(pool.baseCoinType, {
                amount: (existingBase?.amount ?? 0n) + pool.baseDepositAmount,
                decimals: pool.baseDecimals,
                label: baseLabel,
            });

            const existingQuote = this.depositPlan.get(pool.quoteCoinType);
            this.depositPlan.set(pool.quoteCoinType, {
                amount: (existingQuote?.amount ?? 0n) + pool.quoteDepositAmount,
                decimals: pool.quoteDecimals,
                label: quoteLabel,
            });
        }

        // Deposit each unique coin type up to its planned target
        for (const [coinType, { amount, decimals, label }] of this.depositPlan) {
            log.step(`Depositing ${label}...`);
            try {
                await this.bmService.deposit(this.balanceManagerId, coinType, amount);
                log.success(`Deposited: ${formatAmount(amount, decimals)} ${label}`);
                this.depositedCoins.add(coinType);
            } catch (e) {
                log.warn(
                    `${label} deposit failed. Pools needing ${label} as base will run bid-only.`,
                );
            }
            // Wait for deposit to propagate before next coin
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        // Initialize per-pool state
        for (const pool of this.manifest.pools) {
            const label = pairLabel(pool.baseCoinType, pool.quoteCoinType);
            log.step(`Setting up pool: ${label}`);

            const orderManager = new OrderManager(
                this.client,
                this.signer,
                packageId,
                pool.poolId,
                pool.baseCoinType,
                pool.quoteCoinType,
                this.balanceManagerId,
                this.manifest.network.type,
            );

            const hasBaseBalance = this.depositedCoins.has(pool.baseCoinType);

            this.poolStates.push({
                pool,
                label,
                orderManager,
                hasBaseBalance,
                lastMidPrice: null,
            });

            if (!hasBaseBalance) {
                log.warn(`${label}: no base balance — running bid-only mode`);
            }
            log.success(`${label} ready`);
        }

        // Start health check server
        log.step("Starting health check server...");
        this.healthServer = new HealthServer(
            () => this.getHealthStatus(),
            () => this.getReadinessStatus(),
            () => this.getOrdersData(),
        );
        await this.healthServer.start(this.config.healthCheckPort);

        // Start metrics server
        log.step("Starting metrics server...");
        this.metricsServer = new MetricsServer();
        await this.metricsServer.start(this.config.metricsPort);

        // Wait for deposit transactions to propagate on localnet
        await new Promise((resolve) => setTimeout(resolve, 3000));

        this.isReady = true;
        log.success(`Market Maker Initialized — ${this.poolStates.length} pool(s)`);
    }

    /**
     * Start the rebalance loop.
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            log.warn("Market maker is already running");
            return;
        }

        if (!this.isReady) {
            throw new Error("Market maker not initialized. Call initialize() first.");
        }

        this.isRunning = true;
        log.phase("Starting rebalance loop");
        log.detail(`Rebalance interval: ${this.config.rebalanceIntervalMs}ms`);
        log.detail(`Levels per side: ${this.config.levelsPerSide}`);
        log.detail(`Spread: ${this.config.spreadBps} bps`);
        log.detail(`Pools: ${this.poolStates.map((s) => s.label).join(", ")}`);

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
        log.warn("Graceful shutdown initiated...");
        this.isRunning = false;

        // Stop the rebalance timer
        if (this.rebalanceTimer) {
            clearTimeout(this.rebalanceTimer);
            this.rebalanceTimer = null;
        }

        // Cancel all outstanding orders on each pool
        for (const state of this.poolStates) {
            if (state.orderManager.getActiveOrderCount() > 0) {
                log.info(`Canceling orders on ${state.label}...`);
                try {
                    await state.orderManager.cancelAllOrders();
                } catch (error) {
                    log.loopError(`Error canceling orders on ${state.label}`, error);
                }
            }
        }

        // Stop servers
        if (this.healthServer) {
            await this.healthServer.stop();
        }
        if (this.metricsServer) {
            await this.metricsServer.stop();
        }

        log.success("Market maker stopped.");
    }

    /**
     * Execute a single rebalance cycle across all pools (sequentially).
     */
    private async rebalance(): Promise<void> {
        if (this.isShuttingDown) return;

        // Organic fills shift the BM's coin composition over time (a filled bid
        // burns quote and gains base; a filled ask does the reverse). Cancel/
        // replace preserves totals only for the side that didn't fill, so after
        // enough trading the BM can no longer back its full grid. Top up from
        // the signer wallet back to the planned target before placing orders.
        await this.topUpBeforeCycle();

        for (const state of this.poolStates) {
            if (this.isShuttingDown) return;
            await this.rebalancePool(state);
        }
    }

    /**
     * Check the BM's balance for every planned coin and deposit the deficit
     * from the signer wallet. Best-effort: failures are logged but do not
     * abort the cycle — the subsequent rebalance will surface the issue
     * through its own error path.
     */
    private async topUpBeforeCycle(): Promise<void> {
        if (!this.bmService || !this.balanceManagerId) return;

        for (const [coinType, { amount: target, decimals, label }] of this.depositPlan) {
            // Skip coins whose initial deposit failed — the signer wallet almost
            // certainly still can't supply them, and retrying every cycle just
            // spams the logs.
            if (!this.depositedCoins.has(coinType)) continue;

            let have: bigint;
            try {
                have = await this.bmService.getBalance(this.balanceManagerId, coinType);
            } catch (error) {
                log.loopError(`${label} balance query failed`, error);
                continue;
            }
            if (have >= target) continue;

            const deficit = target - have;
            log.loopDetail(
                `${label} top-up: BM has ${formatAmount(have, decimals)}, ` +
                    `target ${formatAmount(target, decimals)} — depositing ${formatAmount(deficit, decimals)}`,
            );

            try {
                await this.bmService.deposit(this.balanceManagerId, coinType, deficit);
            } catch (error) {
                log.warn(`${label} top-up failed — rebalance may abort on insufficient balance`);
                log.loopError(`${label} top-up error`, error);
            }
        }
    }

    /**
     * Rebalance a single pool.
     */
    private async rebalancePool(state: PoolState): Promise<void> {
        const { pool, label, orderManager } = state;

        log.loop(`Rebalancing ${label}...`);

        try {
            // Fetch mid price from Pyth oracle
            let midPrice: bigint | undefined;
            const pythPackageId = this.manifest.packages.pyth?.packageId;
            if (pythPackageId) {
                const oraclePrice = await fetchOracleMidPrice(
                    this.client,
                    pool,
                    pythPackageId,
                    this.manifest.deployerAddress,
                );
                if (oraclePrice) {
                    state.lastMidPrice = oraclePrice;
                    midPrice = oraclePrice;
                    log.loopDetail(
                        `${label} mid: ${formatAmount(oraclePrice, pool.quoteDecimals)} (oracle)`,
                    );
                }
            }

            if (!midPrice && state.lastMidPrice) {
                midPrice = state.lastMidPrice;
                log.loopDetail(
                    `${label} mid: ${formatAmount(midPrice, pool.quoteDecimals)} (last known)`,
                );
            } else if (!midPrice) {
                log.loopDetail(
                    `${label} mid: ${formatAmount(pool.fallbackMidPrice, pool.quoteDecimals)} (fallback)`,
                );
            }

            // Cancel all existing orders
            if (orderManager.getActiveOrderCount() > 0) {
                await orderManager.cancelAllOrders();
            }

            // Calculate new grid levels
            const gridParams = buildGridParams(this.config, pool);
            let levels = calculateGridLevels(gridParams, midPrice);

            // Filter out asks if no base balance
            if (!state.hasBaseBalance) {
                levels = levels.filter((l) => l.isBid);
            }

            const bids = levels.filter((l) => l.isBid);
            const asks = levels.filter((l) => !l.isBid);
            log.loopDetail(`${label} grid: ${bids.length} bids, ${asks.length} asks`);
            for (const level of asks) {
                log.loopDetail(
                    `  ASK  ${formatAmount(level.price, pool.quoteDecimals)}  ${formatAmount(level.quantity, pool.baseDecimals)}`,
                );
            }
            for (const level of bids) {
                log.loopDetail(
                    `  BID  ${formatAmount(level.price, pool.quoteDecimals)}  ${formatAmount(level.quantity, pool.baseDecimals)}`,
                );
            }

            // Place new orders
            await orderManager.placeOrders(levels);
            log.loopSuccess(`${label}: ${bids.length} bids + ${asks.length} asks`);

            // Update metrics with total active orders across all pools
            const totalActiveOrders = this.poolStates.reduce(
                (sum, s) => sum + s.orderManager.getActiveOrderCount(),
                0,
            );
            updateMetrics({ rebalance: true, activeOrders: totalActiveOrders });
        } catch (error) {
            log.loopError(`${label} rebalance error`, error);
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
            status: this.isRunning ? "healthy" : "unhealthy",
            timestamp: new Date().toISOString(),
            uptime: this.healthServer?.getUptime() || 0,
            details: {
                pools: this.poolStates.map((s) => s.label),
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
                pools: this.poolStates.length,
            },
        };
    }

    /**
     * Get current orders and config for the dashboard.
     */
    private getOrdersData(): OrdersResponse {
        const pools: PoolOrdersResponse[] = this.poolStates.map((state) => {
            const activeOrders = state.orderManager.getActiveOrders();
            return {
                pair: state.label,
                poolId: state.pool.poolId,
                midPrice: state.lastMidPrice
                    ? Number(state.lastMidPrice) / 10 ** state.pool.quoteDecimals
                    : null,
                orders: activeOrders.map((o) => ({
                    orderId: o.orderId,
                    price: Number(o.price) / 10 ** state.pool.quoteDecimals,
                    quantity: Number(o.quantity) / 10 ** state.pool.baseDecimals,
                    isBid: o.isBid,
                })),
            };
        });

        return {
            pools,
            config: {
                spreadBps: this.config.spreadBps,
                levelsPerSide: this.config.levelsPerSide,
                levelSpacingBps: this.config.levelSpacingBps,
            },
        };
    }
}
