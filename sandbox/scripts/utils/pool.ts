import type { SuiClient } from "@mysten/sui/client";
import type { Keypair } from "@mysten/sui/cryptography";
import { Transaction, type TransactionResult } from "@mysten/sui/transactions";
import type { SuiObjectChangeCreated } from "@mysten/sui/client";
import type { DeploymentResult } from "./deployer";
import log from "./logger";
import { fromHex, SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { SUI_PRICE_FEED_ID, USDC_PRICE_FEED_ID } from "../oracle-service/constants";

// --- Scalars ---

const FLOAT_SCALAR = 1_000_000_000;

// --- Margin pool asset configuration ---

interface MarginAssetConfig {
    label: string;
    coinType: string;
    scalar: number;
    priceFeedId: string;
    maxConfBps: number;
    maxEwmaDifferenceBps: number;
    supplyCap: number;
    maxUtilizationRate: number;
    referralSpread: number;
    minBorrow: number;
    rateLimitCapacity: number;
    rateLimitRefillRatePerMs: number;
    rateLimitEnabled: boolean;
    baseRate: number;
    baseSlope: number;
    optimalUtilization: number;
    excessSlope: number;
}

const USDC_ASSET_DEFAULTS: Omit<MarginAssetConfig, "coinType"> = {
    label: "USDC",
    scalar: 1_000_000,
    priceFeedId: USDC_PRICE_FEED_ID,
    maxConfBps: 100,
    maxEwmaDifferenceBps: 500,
    supplyCap: 1_000_000,
    maxUtilizationRate: 0.8,
    referralSpread: 0.2,
    minBorrow: 0.1,
    rateLimitCapacity: 200_000,
    rateLimitRefillRatePerMs: 0.009259,
    rateLimitEnabled: true,
    baseRate: 0.1,
    baseSlope: 0.15,
    optimalUtilization: 0.8,
    excessSlope: 5,
};

const SUI_ASSET_DEFAULTS: Omit<MarginAssetConfig, "coinType"> = {
    label: "SUI",
    scalar: 1_000_000_000,
    priceFeedId: SUI_PRICE_FEED_ID,
    maxConfBps: 300,
    maxEwmaDifferenceBps: 1500,
    supplyCap: 500_000,
    maxUtilizationRate: 0.8,
    referralSpread: 0.2,
    minBorrow: 0.1,
    rateLimitCapacity: 100_000,
    rateLimitRefillRatePerMs: 0.00462963,
    rateLimitEnabled: true,
    baseRate: 0.1,
    baseSlope: 0.2,
    optimalUtilization: 0.8,
    excessSlope: 5,
};

// Pool registration risk parameters (shared across all pools)
const POOL_RISK_CONFIG = {
    minWithdrawRiskRatio: 2,
    minBorrowRiskRatio: 1.2499,
    liquidationRiskRatio: 1.1,
    targetLiquidationRiskRatio: 1.25,
    userLiquidationReward: 0.02,
    poolLiquidationReward: 0.03,
};

// --- Public types ---

export interface PoolEntry {
    poolId: string;
    baseCoinType: string;
    quoteCoinType: string;
}

export interface PoolsResult {
    pools: Record<string, PoolEntry>;
}

export interface MarginPoolsResult {
    marginPools: Record<string, string>;
    registryId: string;
}

// --- PoolCreator ---

export class PoolCreator {
    constructor(
        private client: SuiClient,
        private signer: Keypair,
        private faucetUrl: string,
    ) {}

    async requestSuiFromFaucet(address?: string): Promise<void> {
        const recipient = address || this.signer.getPublicKey().toSuiAddress();

        log.spin(`Requesting SUI for ${recipient}`);

        const response = await fetch(`${this.faucetUrl}/gas`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                FixedAmountRequest: {
                    recipient,
                },
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Faucet request failed: ${response.statusText} - ${text}`);
        }

        // Wait for transaction to be processed
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    async createDeepbookPools(
        deployedPackages: Map<string, DeploymentResult>,
    ): Promise<PoolsResult> {
        const tokenPkg = deployedPackages.get("token");
        const usdcPkg = deployedPackages.get("usdc");
        const deepbookPkg = deployedPackages.get("deepbook");

        // Find Registry and AdminCap objects
        const registry = this.findObjectByType(deepbookPkg!.createdObjects, "Registry");
        const adminCap = this.findObjectByType(deepbookPkg!.createdObjects, "DeepbookAdminCap");

        if (!registry || !adminCap) {
            throw new Error(
                `Missing required objects: registry=${!!registry}, adminCap=${!!adminCap}`,
            );
        }

        log.spin("Creating DEEP/SUI pool (DEEP base, SUI quote)");
        log.detail(`Registry: ${registry.objectId}`);
        log.detail(`AdminCap: ${adminCap.objectId}`);

        // Create pool via Move call — DEEP/SUI (DEEP base, SUI quote)
        const tx = new Transaction();

        // Parameters: base = DEEP (6 decimals), quote = SUI (9 decimals). All must be power of ten.
        const tickSize = 1_000_000; // 0.001 SUI (price tick in quote, 9 decimals)
        const lotSize = 1_000_000; // 1 DEEP (base quantity step, 6 decimals)
        const minSize = 10_000_000; // 10 DEEP minimum order (base, 6 decimals)
        const whitelistedPool = true;
        const stablePool = false;

        tx.setGasBudget(200_000_000);

        // Call create_pool_admin
        tx.moveCall({
            target: `${deepbookPkg!.packageId}::pool::create_pool_admin`,
            typeArguments: [
                `${tokenPkg!.packageId}::deep::DEEP`, // BaseAsset
                "0x2::sui::SUI", // QuoteAsset
            ],
            arguments: [
                tx.object(registry.objectId), // registry
                tx.pure.u64(tickSize), // tick_size
                tx.pure.u64(lotSize), // lot_size
                tx.pure.u64(minSize), // min_size
                tx.pure.bool(whitelistedPool), // whitelisted_pool
                tx.pure.bool(stablePool), // stable_pool
                tx.object(adminCap.objectId), // admin cap
            ],
        });

        log.spin("Creating SUI/USDC pool (SUI base, USDC quote)");
        // Parameters: base = SUI (9 decimals), quote = USDC (6 decimals). All must be power of ten.
        const tickSize2 = 1_000; // 0.001 USDC (price tick in quote, 6 decimals)
        const lotSize2 = 100_000_000; // 0.1 SUI (base quantity step, 9 decimals)
        const minSize2 = 1_000_000_000; // 1 SUI minimum order (base, 9 decimals)

        // Call create_pool_admin
        tx.moveCall({
            target: `${deepbookPkg!.packageId}::pool::create_pool_admin`,
            typeArguments: [
                "0x2::sui::SUI", // BaseAsset
                `${usdcPkg!.packageId}::usdc::USDC`, // QuoteAsset
            ],
            arguments: [
                tx.object(registry.objectId), // registry
                tx.pure.u64(tickSize2), // tick_size
                tx.pure.u64(lotSize2), // lot_size
                tx.pure.u64(minSize2), // min_size
                tx.pure.bool(whitelistedPool), // whitelisted_pool
                tx.pure.bool(stablePool), // stable_pool
                tx.object(adminCap.objectId), // admin cap
            ],
        });

        // Execute transaction
        const result = await this.client.signAndExecuteTransaction({
            transaction: tx,
            signer: this.signer,
            options: {
                showEffects: true,
                showObjectChanges: true,
                showEvents: true,
            },
        });

        // Check for errors
        if (result.effects?.status.status !== "success") {
            throw new Error(
                `Failed to create pool: ${result.effects?.status.error || "Unknown error"}`,
            );
        }

        // Extract all created Pool objects
        const poolObjects = (result.objectChanges ?? []).filter(
            (obj): obj is SuiObjectChangeCreated =>
                obj.type === "created" && obj.objectType.includes("::pool::Pool<"),
        );

        if (poolObjects.length === 0) {
            throw new Error("No pool objects found in transaction result");
        }

        // Build a pair-keyed map by matching type arguments to known coin types
        const deepType = `${tokenPkg!.packageId}::deep::DEEP`;
        const usdcType = `${usdcPkg!.packageId}::usdc::USDC`;
        const suiType = "0x2::sui::SUI";

        const pairDefs: Array<{ key: string; base: string; quote: string }> = [
            { key: "DEEP_SUI", base: deepType, quote: suiType },
            { key: "SUI_USDC", base: suiType, quote: usdcType },
        ];

        const pools: Record<string, PoolEntry> = {};
        for (const pool of poolObjects) {
            const match = pairDefs.find(
                (p) => pool.objectType.includes(p.base) && pool.objectType.includes(p.quote),
            );
            if (match) {
                pools[match.key] = {
                    poolId: pool.objectId,
                    baseCoinType: match.base,
                    quoteCoinType: match.quote,
                };
                log.success(`${match.key} pool created: ${pool.objectId}`);
            }
        }

        await this.client.waitForTransaction({ digest: result.digest });

        return {
            pools,
        };
    }

    async createMarginPools(
        deployedPackages: Map<string, DeploymentResult>,
        pools: Record<string, PoolEntry>,
    ): Promise<MarginPoolsResult> {
        const marginPkg = deployedPackages.get("deepbook_margin");
        const usdcPkg = deployedPackages.get("usdc");

        if (!marginPkg || !usdcPkg) {
            throw new Error(
                `Missing required packages: deepbook_margin=${!!marginPkg}, usdc=${!!usdcPkg}`,
            );
        }

        const registry = this.findObjectByType(marginPkg.createdObjects, "MarginRegistry");
        const adminCap = this.findObjectByType(marginPkg.createdObjects, "MarginAdminCap");
        const usdcReceivedCurrency = usdcPkg.createdObjects.find((obj) =>
            obj.objectType.includes("Currency"),
        );

        if (!registry || !adminCap || !usdcReceivedCurrency) {
            throw new Error(
                `Missing required objects: registry=${!!registry}, adminCap=${!!adminCap}, usdcCurrency=${!!usdcReceivedCurrency}`,
            );
        }

        log.spin("Setting up margin pools (USDC + SUI)");
        log.detail(`MarginRegistry: ${registry.objectId}`);
        log.detail(`MarginAdminCap: ${adminCap.objectId}`);

        const usdcType = `${usdcPkg.packageId}::usdc::USDC`;
        const suiType = "0x2::sui::SUI";

        log.detail("Finalizing USDC currency registration...");
        const usdcCurrencyId = await this.finalizeCurrencyRegistration(
            usdcType,
            usdcReceivedCurrency.objectId,
        );

        log.detail("Migrating Legacy Metadata for SUI...");
        const suiCurrencyId = await this.migrateLegacyMetadata(suiType);

        const assetConfigs: MarginAssetConfig[] = [
            { ...USDC_ASSET_DEFAULTS, coinType: usdcType },
            { ...SUI_ASSET_DEFAULTS, coinType: suiType },
        ];

        const currencyIds: Record<string, string> = {
            USDC: usdcCurrencyId,
            SUI: suiCurrencyId,
        };

        const tx = new Transaction();
        tx.setGasBudget(500_000_000);

        // Mint maintainer cap
        const maintainerCap = tx.moveCall({
            target: `${marginPkg.packageId}::margin_registry::mint_maintainer_cap`,
            arguments: [
                tx.object(registry.objectId),
                tx.object(adminCap.objectId),
                tx.object(SUI_CLOCK_OBJECT_ID),
            ],
        });

        // Create CoinTypeData for each asset and build pyth config
        const coinTypeDataEntries = assetConfigs.map((config) =>
            this.addCoinTypeDataCall(tx, marginPkg.packageId, currencyIds[config.label], config),
        );

        const pythConfig = tx.moveCall({
            target: `${marginPkg.packageId}::oracle::new_pyth_config`,
            arguments: [
                tx.makeMoveVec({
                    type: `${marginPkg.packageId}::oracle::CoinTypeData`,
                    elements: coinTypeDataEntries,
                }),
                tx.pure.u64(70), // maxAgeSeconds
            ],
        });

        tx.moveCall({
            target: `${marginPkg.packageId}::margin_registry::add_config`,
            typeArguments: [`${marginPkg.packageId}::oracle::PythConfig`],
            arguments: [tx.object(registry.objectId), tx.object(adminCap.objectId), pythConfig],
        });

        // Create margin pool for each asset
        for (const config of assetConfigs) {
            this.addCreateMarginPoolCalls(
                tx,
                marginPkg.packageId,
                registry.objectId,
                maintainerCap,
                config,
            );
        }

        // Register SUI_USDC deepbook pool for margin trading
        this.addRegisterDeepbookPoolCalls(
            tx,
            marginPkg.packageId,
            registry.objectId,
            adminCap.objectId,
            pools.SUI_USDC.poolId,
            suiType,
            usdcType,
        );

        // Transfer maintainer cap to signer
        tx.transferObjects([maintainerCap], this.signer.getPublicKey().toSuiAddress());

        log.spin("Executing margin pool setup transaction...");
        const result = await this.client.signAndExecuteTransaction({
            transaction: tx,
            signer: this.signer,
            options: {
                showEffects: true,
                showObjectChanges: true,
                showEvents: true,
            },
        });

        if (result.effects?.status.status !== "success") {
            throw new Error(
                `Failed to create margin pools: ${result.effects?.status.error || "Unknown error"}`,
            );
        }

        // Extract all MarginPool objects and key them by coin type
        const marginPoolObjects = (result.objectChanges ?? []).filter(
            (obj): obj is SuiObjectChangeCreated =>
                obj.type === "created" && obj.objectType.includes("::margin_pool::MarginPool<"),
        );

        const marginPools: Record<string, string> = {};
        for (const obj of marginPoolObjects) {
            for (const config of assetConfigs) {
                if (obj.objectType.includes(config.coinType)) {
                    marginPools[config.label] = obj.objectId;
                    log.success(`MarginPool<${config.label}> created: ${obj.objectId}`);
                }
            }
        }

        if (Object.keys(marginPools).length !== assetConfigs.length) {
            const missing = assetConfigs.filter((c) => !marginPools[c.label]).map((c) => c.label);
            throw new Error(`Missing margin pool(s): ${missing.join(", ")}`);
        }

        log.success("SUI/USDC pool registered and enabled for margin trading");

        await this.client.waitForTransaction({ digest: result.digest });

        return {
            marginPools,
            registryId: registry.objectId,
        };
    }

    // --- Private helpers ---

    /** Finalize a coin's registration in the CoinRegistry and return the new Currency object ID. */
    private async finalizeCurrencyRegistration(
        coinType: string,
        receivedCurrencyId: string,
    ): Promise<string> {
        const tx = new Transaction();
        tx.setGasBudget(200_000_000);
        tx.moveCall({
            target: "0x2::coin_registry::finalize_registration",
            typeArguments: [coinType],
            arguments: [tx.object("0xc"), tx.object(receivedCurrencyId)],
        });

        const result = await this.client.signAndExecuteTransaction({
            transaction: tx,
            signer: this.signer,
            options: { showEffects: true, showObjectChanges: true },
        });

        if (result.effects?.status.status !== "success") {
            throw new Error(
                `Failed to finalize registration for ${coinType}: ${result.effects?.status.error || "Unknown error"}`,
            );
        }

        await this.client.waitForTransaction({ digest: result.digest });

        const currency = result.objectChanges?.find(
            (obj): obj is SuiObjectChangeCreated =>
                obj.type === "created" && obj.objectType.includes("Currency"),
        );

        if (!currency) {
            throw new Error(`No Currency object found after finalize_registration for ${coinType}`);
        }

        return currency.objectId;
    }

    private async migrateLegacyMetadata(coinType: string): Promise<string> {
        const coinMetadata = await this.client.getCoinMetadata({ coinType });
        if (!coinMetadata) {
            throw new Error(`Coin metadata not found for ${coinType}`);
        }

        const tx = new Transaction();
        tx.setGasBudget(200_000_000);
        tx.moveCall({
            target: "0x2::coin_registry::migrate_legacy_metadata",
            typeArguments: [coinType],
            arguments: [tx.object("0xc"), tx.object(coinMetadata.id)],
        });

        const result = await this.client.signAndExecuteTransaction({
            transaction: tx,
            signer: this.signer,
            options: { showEffects: true, showObjectChanges: true },
        });

        if (result.effects?.status.status !== "success") {
            throw new Error(
                `Failed to migrate legacy metadata for ${coinType}: ${result.effects?.status.error || "Unknown error"}`,
            );
        }

        await this.client.waitForTransaction({ digest: result.digest });

        const currency = result.objectChanges?.find(
            (obj): obj is SuiObjectChangeCreated =>
                obj.type === "created" && obj.objectType.includes("Currency"),
        );

        if (!currency) {
            throw new Error(
                `No Currency object found after migrate_legacy_metadata for ${coinType}`,
            );
        }

        return currency.objectId;
    }

    /** Add a new_coin_type_data_from_currency Move call to the transaction. */
    private addCoinTypeDataCall(
        tx: Transaction,
        marginPkgId: string,
        currencyObjectId: string,
        config: MarginAssetConfig,
    ): TransactionResult {
        return tx.moveCall({
            target: `${marginPkgId}::oracle::new_coin_type_data_from_currency`,
            typeArguments: [config.coinType],
            arguments: [
                tx.object(currencyObjectId),
                tx.pure.vector("u8", fromHex(config.priceFeedId)),
                tx.pure.u64(config.maxConfBps),
                tx.pure.u64(config.maxEwmaDifferenceBps),
            ],
        });
    }

    /** Add protocol config + create_margin_pool Move calls for one asset. */
    private addCreateMarginPoolCalls(
        tx: Transaction,
        marginPkgId: string,
        registryId: string,
        maintainerCap: TransactionResult,
        config: MarginAssetConfig,
    ): void {
        const marginPoolConfig = tx.moveCall({
            target: `${marginPkgId}::protocol_config::new_margin_pool_config_with_rate_limit`,
            arguments: [
                tx.pure.u64(config.supplyCap * config.scalar),
                tx.pure.u64(config.maxUtilizationRate * FLOAT_SCALAR),
                tx.pure.u64(config.referralSpread * FLOAT_SCALAR),
                tx.pure.u64(config.minBorrow * config.scalar),
                tx.pure.u64(config.rateLimitCapacity * config.scalar),
                tx.pure.u64(config.rateLimitRefillRatePerMs * config.scalar),
                tx.pure.bool(config.rateLimitEnabled),
            ],
        });
        const interestConfig = tx.moveCall({
            target: `${marginPkgId}::protocol_config::new_interest_config`,
            arguments: [
                tx.pure.u64(config.baseRate * FLOAT_SCALAR),
                tx.pure.u64(config.baseSlope * FLOAT_SCALAR),
                tx.pure.u64(config.optimalUtilization * FLOAT_SCALAR),
                tx.pure.u64(config.excessSlope * FLOAT_SCALAR),
            ],
        });
        const protocolConfig = tx.moveCall({
            target: `${marginPkgId}::protocol_config::new_protocol_config`,
            arguments: [marginPoolConfig, interestConfig],
        });
        tx.moveCall({
            target: `${marginPkgId}::margin_pool::create_margin_pool`,
            typeArguments: [config.coinType],
            arguments: [
                tx.object(registryId),
                protocolConfig,
                tx.object(maintainerCap),
                tx.object(SUI_CLOCK_OBJECT_ID),
            ],
        });
    }

    /** Add new_pool_config + register + enable Move calls for one deepbook pool. */
    private addRegisterDeepbookPoolCalls(
        tx: Transaction,
        marginPkgId: string,
        registryId: string,
        adminCapId: string,
        poolId: string,
        baseType: string,
        quoteType: string,
    ): void {
        const poolConfig = tx.moveCall({
            target: `${marginPkgId}::margin_registry::new_pool_config`,
            typeArguments: [baseType, quoteType],
            arguments: [
                tx.object(registryId),
                tx.pure.u64(Math.round(POOL_RISK_CONFIG.minWithdrawRiskRatio * FLOAT_SCALAR)),
                tx.pure.u64(Math.round(POOL_RISK_CONFIG.minBorrowRiskRatio * FLOAT_SCALAR)),
                tx.pure.u64(Math.round(POOL_RISK_CONFIG.liquidationRiskRatio * FLOAT_SCALAR)),
                tx.pure.u64(Math.round(POOL_RISK_CONFIG.targetLiquidationRiskRatio * FLOAT_SCALAR)),
                tx.pure.u64(Math.round(POOL_RISK_CONFIG.userLiquidationReward * FLOAT_SCALAR)),
                tx.pure.u64(Math.round(POOL_RISK_CONFIG.poolLiquidationReward * FLOAT_SCALAR)),
            ],
        });
        tx.moveCall({
            target: `${marginPkgId}::margin_registry::register_deepbook_pool`,
            typeArguments: [baseType, quoteType],
            arguments: [
                tx.object(registryId),
                tx.object(adminCapId),
                tx.object(poolId),
                poolConfig,
                tx.object(SUI_CLOCK_OBJECT_ID),
            ],
        });
        tx.moveCall({
            target: `${marginPkgId}::margin_registry::enable_deepbook_pool`,
            typeArguments: [baseType, quoteType],
            arguments: [
                tx.object(registryId),
                tx.object(adminCapId),
                tx.object(poolId),
                tx.object(SUI_CLOCK_OBJECT_ID),
            ],
        });
    }

    private findObjectByType(
        objects: SuiObjectChangeCreated[],
        typeName: string,
    ): SuiObjectChangeCreated | undefined {
        return objects.find((obj) => {
            const type = (obj.objectType ?? "").replace(/\s*│\s*$/g, "").trim();
            return type.endsWith(`::${typeName}`);
        });
    }
}
