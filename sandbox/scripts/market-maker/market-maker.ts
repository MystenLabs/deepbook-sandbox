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

/**
 * Per-pool runtime state. Each pool owns a dedicated BalanceManager so that
 * collateral for one pool's grid cannot starve another pool's placement.
 */
interface PoolState {
    pool: PoolConfig;
    label: string;
    bmId: string;
    orderManager: OrderManager;
    hasBaseBalance: boolean;
    hasQuoteBalance: boolean;
    lastMidPrice: bigint | null;
}

export class MarketMaker {
    private client: SuiGrpcClient;
    private signer: Keypair;
    private config: MarketMakerConfig;
    private manifest: DeploymentManifest;

    private bmService: BalanceManagerService | null = null;
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
     * Initialize the market maker: create one BalanceManager per pool, deposit
     * funds, start servers. Per-pool BMs isolate each pool's collateral so a
     * drained SUI/USDC cannot starve a DEEP/SUI rebalance (the failure mode
     * the previous shared-BM design had).
     */
    async initialize(): Promise<void> {
        log.phase("Initializing Market Maker");
        log.resetSteps();

        const packageId = this.manifest.packages.deepbook.packageId;
        this.bmService = new BalanceManagerService(this.client, this.signer, packageId);

        for (const pool of this.manifest.pools) {
            const label = pairLabel(pool.baseCoinType, pool.quoteCoinType);
            const baseLabel = pool.baseCoinType.split("::").pop()?.toUpperCase() ?? "BASE";
            const quoteLabel = pool.quoteCoinType.split("::").pop()?.toUpperCase() ?? "QUOTE";

            log.phase(`Setting up ${label}`);

            // Dedicated BalanceManager for this pool
            log.step(`Creating BalanceManager...`);
            const bmInfo = await this.bmService.createBalanceManager();
            const bmId = bmInfo.balanceManagerId;
            log.success(`Created: ${bmId}`);
            log.detail(explorerObjectUrl(bmId, this.manifest.network.type));

            await new Promise((resolve) => setTimeout(resolve, 2000));

            // Fund base and quote independently — a missing coin degrades this
            // pool to one-sided quoting without affecting any other pool.
            const hasBaseBalance = await this.depositInitial(
                bmId,
                pool.baseCoinType,
                pool.baseDepositAmount,
                pool.baseDecimals,
                baseLabel,
            );
            const hasQuoteBalance = await this.depositInitial(
                bmId,
                pool.quoteCoinType,
                pool.quoteDepositAmount,
                pool.quoteDecimals,
                quoteLabel,
            );

            const orderManager = new OrderManager(
                this.client,
                this.signer,
                packageId,
                pool.poolId,
                pool.baseCoinType,
                pool.quoteCoinType,
                bmId,
                this.manifest.network.type,
            );

            this.poolStates.push({
                pool,
                label,
                bmId,
                orderManager,
                hasBaseBalance,
                hasQuoteBalance,
                lastMidPrice: null,
            });

            if (!hasBaseBalance) log.warn(`${label}: no base — asks disabled`);
            if (!hasQuoteBalance) log.warn(`${label}: no quote — bids disabled`);
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
     * Per-pool BM isolation means failure on one pool cannot starve another.
     */
    private async rebalance(): Promise<void> {
        if (this.isShuttingDown) return;

        for (const state of this.poolStates) {
            if (this.isShuttingDown) return;
            await this.rebalancePool(state);
        }
    }

    /**
     * Deposit a coin into a BalanceManager during initialization. Returns
     * true on success, false if the wallet can't supply the coin (the pool
     * will then run in reduced-side mode).
     */
    private async depositInitial(
        bmId: string,
        coinType: string,
        amount: bigint,
        decimals: number,
        label: string,
    ): Promise<boolean> {
        if (!this.bmService) return false;
        log.step(`Depositing ${label}...`);
        try {
            await this.bmService.deposit(bmId, coinType, amount);
            log.success(`Deposited: ${formatAmount(amount, decimals)} ${label}`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
            return true;
        } catch (e) {
            log.warn(`${label} deposit failed`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
            return false;
        }
    }

    /**
     * Top up a pool's BM from the signer wallet so drift from organic fills
     * doesn't starve the next rebalance. Best-effort: failures are logged
     * but never abort the cycle.
     */
    private async topUpPool(state: PoolState): Promise<void> {
        if (!this.bmService) return;
        const { pool, bmId, label } = state;

        const baseLabel = pool.baseCoinType.split("::").pop()?.toUpperCase() ?? "BASE";
        const quoteLabel = pool.quoteCoinType.split("::").pop()?.toUpperCase() ?? "QUOTE";

        if (state.hasBaseBalance) {
            await this.topUpCoin(
                bmId,
                label,
                pool.baseCoinType,
                pool.baseDepositAmount,
                pool.baseDecimals,
                baseLabel,
            );
        }
        if (state.hasQuoteBalance) {
            await this.topUpCoin(
                bmId,
                label,
                pool.quoteCoinType,
                pool.quoteDepositAmount,
                pool.quoteDecimals,
                quoteLabel,
            );
        }
    }

    private async topUpCoin(
        bmId: string,
        poolLabel: string,
        coinType: string,
        target: bigint,
        decimals: number,
        coinLabel: string,
    ): Promise<void> {
        if (!this.bmService) return;

        let have: bigint;
        try {
            have = await this.bmService.getBalance(bmId, coinType);
        } catch (error) {
            log.loopError(`${poolLabel} ${coinLabel} balance query failed`, error);
            return;
        }
        if (have >= target) return;

        const deficit = target - have;
        log.loopDetail(
            `${poolLabel} ${coinLabel} top-up: BM has ${formatAmount(have, decimals)}, ` +
                `target ${formatAmount(target, decimals)} — depositing ${formatAmount(deficit, decimals)}`,
        );

        try {
            await this.bmService.deposit(bmId, coinType, deficit);
        } catch (error) {
            log.warn(
                `${poolLabel} ${coinLabel} top-up failed — rebalance may abort on insufficient balance`,
            );
            log.loopError(`${poolLabel} ${coinLabel} top-up error`, error);
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

            // Cancel all existing orders first — this releases locked
            // collateral back into the BM's free balance, which the next
            // step (topUpPool) will then see when computing deficits.
            // `balance_manager::balance` reports only unlocked funds, so
            // topping up before cancel would over-deposit every cycle.
            if (orderManager.getActiveOrderCount() > 0) {
                await orderManager.cancelAllOrders();
            }

            // Replenish drift from organic fills (must come AFTER cancel).
            await this.topUpPool(state);

            // Calculate new grid levels
            const gridParams = buildGridParams(this.config, pool);
            let levels = calculateGridLevels(gridParams, midPrice);

            // Drop asks if no base balance, bids if no quote balance.
            if (!state.hasBaseBalance) levels = levels.filter((l) => l.isBid);
            if (!state.hasQuoteBalance) levels = levels.filter((l) => !l.isBid);

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
     * Get current readiness status. With per-pool BMs, "balanceManager" is
     * true when every pool has its own BM initialized.
     */
    private getReadinessStatus(): ReadinessStatus {
        const allBmsReady =
            this.poolStates.length > 0 && this.poolStates.every((s) => s.bmId !== "");
        return {
            ready: this.isReady,
            timestamp: new Date().toISOString(),
            checks: {
                balanceManager: allBmsReady,
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
