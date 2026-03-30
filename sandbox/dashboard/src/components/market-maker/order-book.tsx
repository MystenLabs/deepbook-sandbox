import { BookOpen } from "lucide-react";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { PoolOrders, OrderBookRow } from "./types";
import { CardWithPlus, RefreshButton, formatPrice, formatQuantity } from "./helpers";

/* ------------------------------------------------------------------ */
/*  Data transformation                                                */
/* ------------------------------------------------------------------ */

interface OrderBookData {
    asks: OrderBookRow[];
    bids: OrderBookRow[];
    spread: number | null;
    spreadPct: number | null;
    midPrice: number | null;
}

const MAX_VISIBLE_LEVELS = 10;

function buildOrderBook(pool: PoolOrders): OrderBookData {
    const bids = pool.orders.filter((o) => o.isBid).sort((a, b) => b.price - a.price);
    const asks = pool.orders.filter((o) => !o.isBid).sort((a, b) => a.price - b.price);

    // Cumulate from inside-out (nearest spread first), then trim to
    // the N levels closest to the spread — standard professional orderbook UX.
    let bidCum = 0;
    const bidRows: OrderBookRow[] = bids.slice(0, MAX_VISIBLE_LEVELS).map((o) => {
        bidCum += o.quantity;
        return { price: o.price, size: o.quantity, cumulative: bidCum, isBid: true };
    });

    let askCum = 0;
    const askRows: OrderBookRow[] = asks.slice(0, MAX_VISIBLE_LEVELS).map((o) => {
        askCum += o.quantity;
        return { price: o.price, size: o.quantity, cumulative: askCum, isBid: false };
    });

    // Display asks high-to-low (highest at top, lowest near spread)
    askRows.reverse();

    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
    const mid = bestBid != null && bestAsk != null ? (bestAsk + bestBid) / 2 : null;
    const spreadPct = spread != null && mid != null && mid !== 0 ? (spread / mid) * 100 : null;

    return { asks: askRows, bids: bidRows, spread, spreadPct, midPrice: mid ?? pool.midPrice };
}

/* ------------------------------------------------------------------ */
/*  OrderBook component                                                */
/* ------------------------------------------------------------------ */

interface OrderBookProps {
    pool: PoolOrders | undefined;
    pair: string;
    isLoading: boolean;
    isError: boolean;
    isFetching: boolean;
    onRefresh: () => void;
}

export function OrderBook({
    pool,
    pair,
    isLoading,
    isError,
    isFetching,
    onRefresh,
}: OrderBookProps) {
    const data = pool ? buildOrderBook(pool) : null;
    const maxCumulative = data
        ? Math.max(...data.asks.map((r) => r.cumulative), ...data.bids.map((r) => r.cumulative), 1)
        : 1;

    return (
        <CardWithPlus>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                    <BookOpen className="h-4 w-4 text-zinc-500" />
                    Order Book
                </CardTitle>
                <RefreshButton isFetching={isFetching} onRefresh={onRefresh} />
            </CardHeader>
            <CardContent>
                {isLoading ? (
                    <Skeleton className="h-[420px] w-full bg-zinc-800" />
                ) : isError ? (
                    <div className="flex h-[420px] items-center justify-center text-sm text-zinc-500">
                        Market maker offline
                    </div>
                ) : !data || (data.asks.length === 0 && data.bids.length === 0) ? (
                    <div className="flex h-[420px] items-center justify-center text-sm text-zinc-500">
                        Waiting for orders...
                    </div>
                ) : (
                    <div className="space-y-0">
                        {/* Header */}
                        <div className="grid grid-cols-3 px-2 pb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                            <span>Price</span>
                            <span className="text-right">Size</span>
                            <span className="text-right">Total</span>
                        </div>

                        {/* Asks (high to low) */}
                        <div className="space-y-0">
                            {data.asks.map((row) => (
                                <OrderRow
                                    key={row.price}
                                    row={row}
                                    maxCumulative={maxCumulative}
                                    pair={pair}
                                />
                            ))}
                        </div>

                        {/* Spread indicator */}
                        <div className="my-1 flex items-center justify-between rounded bg-zinc-900/80 px-2 py-1.5 text-xs">
                            <span className="text-zinc-400">
                                Spread:{" "}
                                <span className="font-medium text-zinc-300">
                                    {data.spread != null ? formatPrice(data.spread, pair) : "—"}
                                </span>
                                {data.spreadPct != null && (
                                    <span className="ml-1 text-zinc-500">
                                        ({data.spreadPct.toFixed(2)}%)
                                    </span>
                                )}
                            </span>
                            <span className="text-zinc-500">
                                Mid:{" "}
                                <span className="font-medium text-zinc-300">
                                    {data.midPrice != null ? formatPrice(data.midPrice, pair) : "—"}
                                </span>
                            </span>
                        </div>

                        {/* Bids (high to low) */}
                        <div className="space-y-0">
                            {data.bids.map((row) => (
                                <OrderRow
                                    key={row.price}
                                    row={row}
                                    maxCumulative={maxCumulative}
                                    pair={pair}
                                />
                            ))}
                        </div>
                    </div>
                )}
            </CardContent>
        </CardWithPlus>
    );
}

/* ------------------------------------------------------------------ */
/*  Order row                                                          */
/* ------------------------------------------------------------------ */

function OrderRow({
    row,
    maxCumulative,
    pair,
}: {
    row: OrderBookRow;
    maxCumulative: number;
    pair: string;
}) {
    const pct = (row.cumulative / maxCumulative) * 100;
    const barColor = row.isBid ? "bg-emerald-500/10" : "bg-red-500/10";
    const textColor = row.isBid ? "text-emerald-400" : "text-red-400";

    return (
        <div className="relative grid grid-cols-3 px-2 py-[3px] text-xs font-mono">
            {/* Depth bar */}
            <div
                className={`absolute inset-y-0 ${row.isBid ? "left-0" : "right-0"} ${barColor}`}
                style={{ width: `${pct}%` }}
            />
            {/* Content */}
            <span className={`relative ${textColor}`}>{formatPrice(row.price, pair)}</span>
            <span className="relative text-right text-zinc-300">{formatQuantity(row.size)}</span>
            <span className="relative text-right text-zinc-500">
                {formatQuantity(row.cumulative)}
            </span>
        </div>
    );
}
