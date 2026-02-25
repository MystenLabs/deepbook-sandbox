import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { ArrowLeftRight, RefreshCw } from "lucide-react";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Order {
    orderId: string;
    price: number;
    quantity: number;
    isBid: boolean;
}

interface OrdersResponse {
    midPrice: number | null;
    orders: Order[];
    config: {
        spreadBps: number;
        levelsPerSide: number;
        levelSpacingBps: number;
        orderSizeBase: number;
    };
}

interface OracleResponse {
    prices: { sui: string | null; deep: string | null };
}

interface ChartRow {
    label: string;
    bid: number | null;
    ask: number | null;
    mid: number | null;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const REFETCH_INTERVAL = 10_000;

/* ------------------------------------------------------------------ */
/*  MarketMakerPage                                                    */
/* ------------------------------------------------------------------ */

export function MarketMakerPage() {
    const orders = useQuery<OrdersResponse>({
        queryKey: ["mm-orders"],
        queryFn: async () => {
            const r = await fetch("/api/mm/orders");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        },
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
    });

    const oracle = useQuery<OracleResponse>({
        queryKey: ["oracle-prices"],
        queryFn: async () => {
            const r = await fetch("/api/oracle/");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        },
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
    });

    const chartData = buildChartData(orders.data);
    const midPrice = orders.data?.midPrice;

    return (
        <div className="space-y-4">
            <div className="space-y-1">
                <h1 className="text-lg font-semibold">Market Maker</h1>
                <p className="text-xs text-muted-foreground pb-2">
                    Order book grid — auto-refreshes every {REFETCH_INTERVAL / 1000}s
                </p>
                <div className="flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs font-medium text-zinc-300 w-fit">
                    <span>DEEP</span>
                    <img src="/deepbook.jpeg" alt="DEEP" className="h-4 w-4 rounded-full" />
                    <svg height="16" viewBox="0 0 24 24" width="16" className="text-zinc-600">
                        <path
                            d="M16 3.5L8 20.5"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                    <span>SUI</span>
                    <img src="/svg/sui.svg" alt="SUI" className="h-4 w-4" />
                </div>
            </div>

            {/* Chart Card */}
            <CardWithPlus>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                        <ArrowLeftRight className="h-4 w-4 text-zinc-500" />
                        Order Book Grid
                    </CardTitle>
                    <RefreshButton
                        isFetching={orders.isFetching}
                        onRefresh={() => orders.refetch()}
                    />
                </CardHeader>
                <CardContent>
                    {orders.isLoading ? (
                        <Skeleton className="h-[300px] w-full bg-zinc-800" />
                    ) : orders.isError ? (
                        <div className="flex h-[300px] items-center justify-center text-sm text-zinc-500">
                            Market maker offline
                        </div>
                    ) : chartData.length === 0 ? (
                        <div className="flex h-[300px] items-center justify-center text-sm text-zinc-500">
                            No active orders
                        </div>
                    ) : (
                        <ResponsiveContainer width="100%" height={300}>
                            <BarChart data={chartData} barCategoryGap="20%">
                                <CartesianGrid
                                    strokeDasharray="3 3"
                                    stroke="#27272a"
                                    vertical={false}
                                />
                                <XAxis
                                    dataKey="label"
                                    tick={{ fill: "#71717a", fontSize: 11 }}
                                    axisLine={{ stroke: "#27272a" }}
                                    tickLine={false}
                                />
                                <YAxis
                                    tick={{ fill: "#71717a", fontSize: 11 }}
                                    axisLine={false}
                                    tickLine={false}
                                    width={45}
                                />
                                <Tooltip
                                    contentStyle={{
                                        backgroundColor: "#09090b",
                                        border: "1px solid #27272a",
                                        borderRadius: 6,
                                        fontSize: 12,
                                    }}
                                    labelStyle={{ color: "#a1a1aa" }}
                                    formatter={(value: unknown, name?: string) => [
                                        `${value} DEEP`,
                                        name === "bid" ? "Bid" : name === "ask" ? "Ask" : "Mid",
                                    ]}
                                />
                                <Bar dataKey="bid" fill="#10b981" radius={[3, 3, 0, 0]} />
                                <Bar dataKey="mid" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                                <Bar dataKey="ask" fill="#ef4444" radius={[3, 3, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    )}
                </CardContent>
            </CardWithPlus>

            {/* Config & Stats */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <StatCard label="Mid Price" isLoading={orders.isLoading}>
                    {midPrice != null ? `${midPrice.toFixed(6)} SUI` : "—"}
                </StatCard>
                <StatCard label="Active Orders" isLoading={orders.isLoading}>
                    {orders.data?.orders.length ?? "—"}
                </StatCard>
                <StatCard label="Spread" isLoading={orders.isLoading}>
                    {orders.data ? `${orders.data.config.spreadBps} bps` : "—"}
                </StatCard>
                <StatCard label="Levels / Side" isLoading={orders.isLoading}>
                    {orders.data?.config.levelsPerSide ?? "—"}
                </StatCard>
                <StatCard label="Level Spacing" isLoading={orders.isLoading}>
                    {orders.data ? `${orders.data.config.levelSpacingBps} bps` : "—"}
                </StatCard>
                <StatCard label="Order Size" isLoading={orders.isLoading}>
                    {orders.data ? `${orders.data.config.orderSizeBase} DEEP` : "—"}
                </StatCard>
                <StatCard label="Oracle SUI" isLoading={oracle.isLoading}>
                    {oracle.data?.prices.sui ?? "—"}
                </StatCard>
                <StatCard label="Oracle DEEP" isLoading={oracle.isLoading}>
                    {oracle.data?.prices.deep ?? "—"}
                </StatCard>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/*  Chart data builder                                                 */
/* ------------------------------------------------------------------ */

function buildChartData(data: OrdersResponse | undefined): ChartRow[] {
    if (!data) return [];

    const bids = data.orders.filter((o) => o.isBid).sort((a, b) => a.price - b.price);
    const asks = data.orders.filter((o) => !o.isBid).sort((a, b) => a.price - b.price);

    const rows: ChartRow[] = [];

    for (const b of bids) {
        rows.push({
            label: b.price.toFixed(6),
            bid: b.quantity,
            ask: null,
            mid: null,
        });
    }

    if (data.midPrice != null) {
        const maxQty = Math.max(...data.orders.map((o) => o.quantity), 1);
        rows.push({
            label: data.midPrice.toFixed(6),
            bid: null,
            ask: null,
            mid: maxQty * 0.15, // proportional marker
        });
    }

    for (const a of asks) {
        rows.push({
            label: a.price.toFixed(6),
            bid: null,
            ask: a.quantity,
            mid: null,
        });
    }

    return rows;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function CardWithPlus({ children }: { children: ReactNode }) {
    return (
        <div className="border w-full rounded-md overflow-hidden dark:border-zinc-900 bg-zinc-950">
            <div className="size-full bg-[url(/svg/plus.svg)] bg-repeat bg-[length:65px_65px]">
                <div className="size-full bg-gradient-to-tr from-zinc-950 via-zinc-950/[0.93] to-zinc-950">
                    {children}
                </div>
            </div>
        </div>
    );
}

function StatCard({
    label,
    isLoading,
    children,
}: {
    label: string;
    isLoading: boolean;
    children: ReactNode;
}) {
    return (
        <CardWithPlus>
            <CardContent className="py-4">
                <div className="text-xs text-zinc-500">{label}</div>
                {isLoading ? (
                    <Skeleton className="mt-1 h-6 w-24 bg-zinc-800" />
                ) : (
                    <div className="mt-1 text-sm font-medium text-zinc-200">{children}</div>
                )}
            </CardContent>
        </CardWithPlus>
    );
}

function RefreshButton({ isFetching, onRefresh }: { isFetching: boolean; onRefresh: () => void }) {
    return (
        <button
            onClick={onRefresh}
            disabled={isFetching}
            className="rounded-md p-1 text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-50"
        >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
        </button>
    );
}
