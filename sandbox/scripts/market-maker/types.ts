/**
 * DeepBook V3 constants and shared types for market maker.
 */

export const ORDER_TYPE = {
    NO_RESTRICTION: 0,
    IMMEDIATE_OR_CANCEL: 1,
    FILL_OR_KILL: 2,
    POST_ONLY: 3,
} as const;

export const SELF_MATCHING = {
    ALLOWED: 0,
    CANCEL_TAKER: 1,
    CANCEL_MAKER: 2,
} as const;

export const DECIMALS = {
    DEEP: 6,
    SUI: 9,
    USDC: 6,
} as const;

export const SUI_CLOCK_OBJECT_ID = "0x6";

/**
 * Per-pool configuration for the market maker.
 * Each pool has its own tick/lot/min sizes, oracle references, deposit amounts, etc.
 */
export interface PoolConfig {
    poolId: string;
    baseCoinType: string;
    quoteCoinType: string;
    basePriceInfoObjectId?: string;
    quotePriceInfoObjectId?: string;
    tickSize: bigint;
    lotSize: bigint;
    minSize: bigint;
    orderSizeBase: bigint;
    fallbackMidPrice: bigint;
    baseDepositAmount: bigint;
    quoteDepositAmount: bigint;
    baseDecimals: number;
    quoteDecimals: number;
}

export interface DeploymentManifest {
    network: {
        type: "localnet" | "testnet";
        rpcUrl: string;
        faucetUrl: string;
    };
    packages: {
        [key: string]: {
            packageId: string;
            objects: Array<{
                objectId: string;
                objectType: string;
            }>;
            transactionDigest: string;
        };
    };
    pools: PoolConfig[];
    deploymentTime: string;
    deployerAddress: string;
}

export interface GridLevel {
    price: bigint;
    quantity: bigint;
    isBid: boolean;
}

export interface ActiveOrder {
    orderId: string;
    clientOrderId: bigint;
    price: bigint;
    quantity: bigint;
    isBid: boolean;
    placedAt: Date;
}

const EXPLORER_BASE = "https://explorer.polymedia.app";

function explorerNetwork(network: string): string {
    return network === "localnet" ? "local" : network;
}

export function explorerObjectUrl(objectId: string, network: string): string {
    return `${EXPLORER_BASE}/object/${objectId}?network=${explorerNetwork(network)}`;
}

export function explorerTxUrl(digest: string, network: string): string {
    return `${EXPLORER_BASE}/txblock/${digest}?network=${explorerNetwork(network)}`;
}

export function formatAmount(value: bigint, decimals: number): string {
    return (Number(value) / 10 ** decimals).toFixed(Math.min(decimals, 6));
}

/**
 * Derive a short pair label from coin type strings.
 * e.g. "0x...::deep::DEEP" / "0x2::sui::SUI" → "DEEP/SUI"
 */
export function pairLabel(baseCoinType: string, quoteCoinType: string): string {
    const base = baseCoinType.split("::").pop()?.toUpperCase() ?? "BASE";
    const quote = quoteCoinType.split("::").pop()?.toUpperCase() ?? "QUOTE";
    return `${base}/${quote}`;
}

/**
 * Parse a JSON-serialized PoolConfig array from the MM_POOLS env var.
 * BigInt fields are stored as strings in JSON and converted here.
 */
export function parsePoolConfigs(json: string): PoolConfig[] {
    const raw = JSON.parse(json) as Array<Record<string, unknown>>;
    return raw.map((p) => ({
        poolId: p.poolId as string,
        baseCoinType: p.baseCoinType as string,
        quoteCoinType: p.quoteCoinType as string,
        basePriceInfoObjectId: p.basePriceInfoObjectId as string | undefined,
        quotePriceInfoObjectId: p.quotePriceInfoObjectId as string | undefined,
        tickSize: BigInt(p.tickSize as string),
        lotSize: BigInt(p.lotSize as string),
        minSize: BigInt(p.minSize as string),
        orderSizeBase: BigInt(p.orderSizeBase as string),
        fallbackMidPrice: BigInt(p.fallbackMidPrice as string),
        baseDepositAmount: BigInt(p.baseDepositAmount as string),
        quoteDepositAmount: BigInt(p.quoteDepositAmount as string),
        baseDecimals: p.baseDecimals as number,
        quoteDecimals: p.quoteDecimals as number,
    }));
}

/**
 * Serialize PoolConfig array to JSON (converts bigints to strings).
 */
export function serializePoolConfigs(pools: PoolConfig[]): string {
    return JSON.stringify(
        pools.map((p) => ({
            ...p,
            tickSize: p.tickSize.toString(),
            lotSize: p.lotSize.toString(),
            minSize: p.minSize.toString(),
            orderSizeBase: p.orderSizeBase.toString(),
            fallbackMidPrice: p.fallbackMidPrice.toString(),
            baseDepositAmount: p.baseDepositAmount.toString(),
            quoteDepositAmount: p.quoteDepositAmount.toString(),
        })),
    );
}
