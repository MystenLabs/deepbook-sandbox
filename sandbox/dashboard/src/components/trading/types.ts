export interface OrderDetail {
    order_id: string;
    client_order_id: string;
    quantity: string;
    filled_quantity: string;
    status: string;
    fee_is_deep: boolean;
    price?: string;
    is_bid?: boolean;
}

export type PoolKey = "DEEP_SUI" | "SUI_USDC";
export type CoinKey = "DEEP" | "SUI" | "USDC";
