import { ArrowRightLeft } from "lucide-react";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ForkTrade } from "./hooks";
import { CardWithPlus, formatPrice, formatQuantity } from "./helpers";

/* ------------------------------------------------------------------ */
/*  Recent trades — the server's Postgres-backed fills tape            */
/* ------------------------------------------------------------------ */
//
// Indexer-fed, so it works on both networks and shows EVERY local fill —
// trade-sim's self-fills and orders executed from the trading page alike.

const MAX_VISIBLE_TRADES = 14;

interface RecentTradesProps {
    trades: ForkTrade[] | undefined;
    pair: string;
    isLoading: boolean;
    isError: boolean;
}

function formatTime(timestampMs: number): string {
    return new Date(timestampMs).toLocaleTimeString("en-US", { hour12: false });
}

export function RecentTrades({ trades, pair, isLoading, isError }: RecentTradesProps) {
    const rows = (trades ?? []).slice(0, MAX_VISIBLE_TRADES);
    const base = pair.split("/")[0] ?? "";

    return (
        <CardWithPlus>
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                    <ArrowRightLeft className="h-4 w-4 text-zinc-500" />
                    Recent Trades
                </CardTitle>
            </CardHeader>
            <CardContent>
                {isLoading ? (
                    <Skeleton className="h-[420px] w-full bg-zinc-800" />
                ) : isError ? (
                    <div className="flex h-[420px] items-center justify-center text-sm text-zinc-500">
                        Trades unavailable (indexer server offline)
                    </div>
                ) : rows.length === 0 ? (
                    <div className="flex h-[420px] items-center justify-center text-sm text-zinc-500">
                        No trades yet
                    </div>
                ) : (
                    <div className="space-y-0">
                        <div className="grid grid-cols-3 px-2 pb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                            <span>Time</span>
                            <span className="text-right">Price</span>
                            <span className="text-right">Size ({base})</span>
                        </div>
                        {rows.map((t, i) => (
                            <div
                                // trade_id repeats across a PTB's multiple
                                // fills — key by position (replace-on-poll
                                // list, never reordered incrementally).
                                key={`${t.trade_id}-${i}`}
                                title={`tx ${t.digest}`}
                                className="grid grid-cols-3 px-2 py-[3px] text-xs font-mono"
                            >
                                <span className="text-zinc-500">{formatTime(t.timestamp)}</span>
                                <span
                                    className={`text-right ${
                                        t.type === "buy" ? "text-emerald-400" : "text-red-400"
                                    }`}
                                >
                                    {formatPrice(t.price, pair)}
                                </span>
                                <span className="text-right text-zinc-300">
                                    {formatQuantity(t.base_volume)}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </CardContent>
        </CardWithPlus>
    );
}
