import {
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ReferenceLine,
    ResponsiveContainer,
} from "recharts";
import { BarChart3 } from "lucide-react";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { PoolOrders, DepthPoint } from "./types";
import { CardWithPlus, formatPrice } from "./helpers";

/* ------------------------------------------------------------------ */
/*  Data transformation                                                */
/* ------------------------------------------------------------------ */

function buildDepthData(pool: PoolOrders): DepthPoint[] {
    const bids = pool.orders.filter((o) => o.isBid).sort((a, b) => b.price - a.price);
    const asks = pool.orders.filter((o) => !o.isBid).sort((a, b) => a.price - b.price);

    const points: DepthPoint[] = [];

    // Bids: cumulate from highest (nearest spread) to lowest
    let bidCum = 0;
    const bidPoints = bids.map((o) => {
        bidCum += o.quantity;
        return { price: o.price, bidDepth: bidCum, askDepth: null };
    });
    // Reverse so prices go low-to-high on x-axis
    bidPoints.reverse();
    points.push(...bidPoints);

    // Gap at mid price to separate the two areas
    if (pool.midPrice != null) {
        points.push({ price: pool.midPrice, bidDepth: null, askDepth: null });
    }

    // Asks: cumulate from lowest (nearest spread) to highest
    let askCum = 0;
    for (const o of asks) {
        askCum += o.quantity;
        points.push({ price: o.price, bidDepth: null, askDepth: askCum });
    }

    return points;
}

/* ------------------------------------------------------------------ */
/*  DepthChart component                                               */
/* ------------------------------------------------------------------ */

interface DepthChartProps {
    pool: PoolOrders | undefined;
    pair: string;
    isLoading: boolean;
    isError: boolean;
}

export function DepthChart({ pool, pair, isLoading, isError }: DepthChartProps) {
    const data = pool ? buildDepthData(pool) : [];

    return (
        <CardWithPlus>
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                    <BarChart3 className="h-4 w-4 text-zinc-500" />
                    Depth Chart
                </CardTitle>
            </CardHeader>
            <CardContent>
                {isLoading ? (
                    <Skeleton className="h-[420px] w-full bg-zinc-800" />
                ) : isError ? (
                    <div className="flex h-[420px] items-center justify-center text-sm text-zinc-500">
                        Market maker offline
                    </div>
                ) : data.length === 0 ? (
                    <div className="flex h-[420px] items-center justify-center text-sm text-zinc-500">
                        Waiting for orders...
                    </div>
                ) : (
                    <ResponsiveContainer width="100%" height={420}>
                        <AreaChart data={data} margin={{ top: 20, right: 8, bottom: 0, left: 0 }}>
                            <CartesianGrid
                                strokeDasharray="3 3"
                                stroke="#27272a"
                                vertical={false}
                            />
                            <XAxis
                                dataKey="price"
                                type="number"
                                domain={["dataMin", "dataMax"]}
                                tick={{ fill: "#71717a", fontSize: 11 }}
                                axisLine={{ stroke: "#27272a" }}
                                tickLine={false}
                                tickFormatter={(v: number) => formatPrice(v, pair)}
                            />
                            <YAxis
                                tick={{ fill: "#71717a", fontSize: 11 }}
                                axisLine={false}
                                tickLine={false}
                                width={50}
                            />
                            <Tooltip
                                contentStyle={{
                                    backgroundColor: "#09090b",
                                    border: "1px solid #27272a",
                                    borderRadius: 6,
                                    fontSize: 12,
                                }}
                                labelStyle={{ color: "#a1a1aa" }}
                                labelFormatter={(v: unknown) =>
                                    `Price: ${formatPrice(Number(v), pair)}`
                                }
                                formatter={(value: unknown, name?: string) => [
                                    String(value),
                                    name === "bidDepth" ? "Bid Depth" : "Ask Depth",
                                ]}
                            />
                            {pool?.midPrice != null && (
                                <ReferenceLine
                                    x={pool.midPrice}
                                    stroke="#f59e0b"
                                    strokeDasharray="4 4"
                                    strokeWidth={1.5}
                                    label={{
                                        value: "Mid",
                                        position: "top",
                                        fill: "#f59e0b",
                                        fontSize: 11,
                                    }}
                                />
                            )}
                            <Area
                                dataKey="bidDepth"
                                type="stepAfter"
                                stroke="#10b981"
                                fill="#10b981"
                                fillOpacity={0.15}
                                strokeWidth={1.5}
                                connectNulls={false}
                                dot={false}
                                activeDot={{ r: 3, fill: "#10b981" }}
                            />
                            <Area
                                dataKey="askDepth"
                                type="stepBefore"
                                stroke="#ef4444"
                                fill="#ef4444"
                                fillOpacity={0.15}
                                strokeWidth={1.5}
                                connectNulls={false}
                                dot={false}
                                activeDot={{ r: 3, fill: "#ef4444" }}
                            />
                        </AreaChart>
                    </ResponsiveContainer>
                )}
            </CardContent>
        </CardWithPlus>
    );
}
