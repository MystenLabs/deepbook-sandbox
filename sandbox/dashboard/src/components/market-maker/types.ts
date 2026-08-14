export interface Order {
    orderId: string;
    price: number;
    quantity: number;
    isBid: boolean;
}

export interface PoolOrders {
    pair: string;
    poolId: string;
    midPrice: number | null;
    orders: Order[];
}

export interface OrdersResponse {
    pools: PoolOrders[];
    config: {
        spreadBps: number;
        levelsPerSide: number;
        levelSpacingBps: number;
    };
}

export interface OracleResponse {
    prices: { sui: string | null; deep: string | null; usdc: string | null };
}

/** The slice of pool details the stat cards render — assembled from
 *  devInspect helpers on localnet, from manifest pins + the measured book
 *  mid on the fork (where devInspect is dead). */
export interface PoolDetailsView {
    midPrice: number;
    tickSize: number;
    lotSize: number;
    minSize: number;
}

export interface OrderBookRow {
    price: number;
    size: number;
    cumulative: number;
    isBid: boolean;
}

export interface DepthPoint {
    price: number;
    bidDepth: number | null;
    askDepth: number | null;
}
