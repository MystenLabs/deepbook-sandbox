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
} as const;

export const SUI_CLOCK_OBJECT_ID = "0x6";

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
    pythOracles?: {
        deepPriceInfoObjectId: string;
        suiPriceInfoObjectId: string;
    };
    pool: {
        poolId: string;
        baseCoin: string;
        quoteCoin: string;
        transactionDigest: string;
    };
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

export function formatPrice(price: bigint): string {
    return (Number(price) / 1e9).toFixed(6);
}

export function formatDeep(quantity: bigint): string {
    return (Number(quantity) / 1e6).toString();
}
