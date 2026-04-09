import { useState } from "react";
import { List, X } from "lucide-react";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SdkCodeBlock } from "./sdk-code-block";
import { cancelOrderSnippet, SDK_DOCS } from "./sdk-snippets";
import type { OrderDetail, PoolKey } from "./types";

interface OpenOrdersProps {
    poolKey: PoolKey;
    orders: OrderDetail[];
    isLoading: boolean;
    onCancelOrder: (orderId: string) => Promise<string>;
}

export function OpenOrders({ poolKey, orders, isLoading, onCancelOrder }: OpenOrdersProps) {
    const [cancelingId, setCancelingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [lastSnippet, setLastSnippet] = useState<string | null>(null);

    const handleCancel = async (orderId: string) => {
        setCancelingId(orderId);
        setError(null);
        setLastSnippet(null);
        try {
            await onCancelOrder(orderId);
            setLastSnippet(cancelOrderSnippet(poolKey, orderId));
        } catch (err) {
            setError(err instanceof Error ? err.message : "Cancel failed");
        } finally {
            setCancelingId(null);
        }
    };

    return (
        <div className="border w-full rounded-md overflow-hidden dark:border-zinc-900 bg-zinc-950">
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                    <List className="h-4 w-4 text-zinc-500" />
                    Open Orders
                </CardTitle>
            </CardHeader>
            <CardContent>
                {isLoading ? (
                    <Skeleton className="h-[200px] w-full bg-zinc-800" />
                ) : orders.length === 0 ? (
                    <div className="flex h-[200px] items-center justify-center text-sm text-zinc-500">
                        No open orders
                    </div>
                ) : (
                    <div className="space-y-0">
                        <div className="grid grid-cols-5 px-2 pb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                            <span>Side</span>
                            <span className="text-right">Price</span>
                            <span className="text-right">Size</span>
                            <span className="text-right">Filled</span>
                            <span className="text-right">Action</span>
                        </div>
                        {orders.map((order) => (
                            <div
                                key={order.order_id}
                                className="grid grid-cols-5 items-center px-2 py-1.5 text-xs font-mono border-t border-zinc-900"
                            >
                                <span
                                    className={order.is_bid ? "text-emerald-400" : "text-red-400"}
                                >
                                    {order.is_bid ? "BUY" : "SELL"}
                                </span>
                                <span className="text-right text-zinc-300">
                                    {order.price ?? "—"}
                                </span>
                                <span className="text-right text-zinc-300">{order.quantity}</span>
                                <span className="text-right text-zinc-500">
                                    {order.filled_quantity}
                                </span>
                                <div className="text-right">
                                    <button
                                        onClick={() => handleCancel(order.order_id)}
                                        disabled={cancelingId === order.order_id}
                                        className="rounded p-1 text-zinc-500 transition-colors hover:text-red-400 disabled:opacity-50"
                                        aria-label="Cancel order"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
                {lastSnippet && <SdkCodeBlock code={lastSnippet} docsUrl={SDK_DOCS.orders} />}
            </CardContent>
        </div>
    );
}
