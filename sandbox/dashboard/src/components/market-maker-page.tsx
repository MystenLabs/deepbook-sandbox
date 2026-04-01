import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { ArrowLeftRight, Info, RefreshCw } from "lucide-react";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Tooltip as InfoTooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Order {
    orderId: string;
    price: number;
    quantity: number;
    isBid: boolean;
}

interface PoolOrders {
    pair: string;
    poolId: string;
    midPrice: number | null;
    orders: Order[];
}

interface OrdersResponse {
    pools: PoolOrders[];
    config: {
        spreadBps: number;
        levelsPerSide: number;
        levelSpacingBps: number;
    };
}

interface OracleResponse {
    prices: { sui: string | null; deep: string | null; usdc: string | null };
}

interface ChartRow {
    label: string;
    bid: number | null;
    ask: number | null;
    mid: number | null;
}

interface PoolDetails {
    midPrice: string;
    tickSize: string;
    lotSize: string;
    minSize: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const REFETCH_INTERVAL = 10_000;

const COIN_ICONS: Record<string, { src: string; className: string }> = {
    DEEP: { src: "/deepbook.jpeg", className: "h-4 w-4 rounded-full" },
    SUI: { src: "/svg/sui.svg", className: "h-4 w-4" },
    USDC: { src: "/svg/usdc.svg", className: "h-4 w-4 rounded-full" },
};

function PairIcons({ pair }: { pair: string }) {
    const [base, quote] = pair.split("/");
    const baseIcon = COIN_ICONS[base];
    const quoteIcon = COIN_ICONS[quote];
    return (
        <>
            <span>{base}</span>
            {baseIcon && <img src={baseIcon.src} alt={base} className={baseIcon.className} />}
            <svg height="16" viewBox="0 0 24 24" width="16" className="text-zinc-600">
                <path
                    d="M16 3.5L8 20.5"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
            <span>{quote}</span>
            {quoteIcon && <img src={quoteIcon.src} alt={quote} className={quoteIcon.className} />}
        </>
    );
}

/* ------------------------------------------------------------------ */
/*  MarketMakerPage                                                    */
/* ------------------------------------------------------------------ */

function usePoolDetails(poolKey: string) {
    return useQuery<PoolDetails>({
        queryKey: ["pool-details", poolKey],
        queryFn: async () => {
            const r = await fetch(`/api/faucet/trading/pool-details/${poolKey}`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            if (!data.success) throw new Error(data.error);
            return data as PoolDetails;
        },
        refetchInterval: 5_000,
        retry: false,
    });
}

export function MarketMakerPage() {
    const [selectedPool, setSelectedPool] = useState(0);

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

    const pools = orders.data?.pools ?? [];
    const pool = pools[selectedPool] ?? pools[0];
    const chartData = buildChartData(pool);
    const midPrice = pool?.midPrice;

    const poolKey = pool?.pair?.replace("/", "_") ?? "DEEP_SUI";
    const poolDetails = usePoolDetails(poolKey);

    return (
        <div className="space-y-4">
            <div className="space-y-1">
                <h1 className="text-lg font-semibold">Market Maker</h1>
                <p className="text-xs text-muted-foreground pb-2">
                    Order book grid — auto-refreshes every {REFETCH_INTERVAL / 1000}s
                </p>
                {pools.length > 1 && (
                    <div className="flex gap-2 pb-1">
                        {pools.map((p, i) => (
                            <button
                                key={p.poolId}
                                onClick={() => setSelectedPool(i)}
                                className={`flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs font-medium transition-colors ${
                                    i === selectedPool
                                        ? "border-zinc-600 bg-zinc-800 text-zinc-100"
                                        : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200"
                                }`}
                            >
                                <PairIcons pair={p.pair} />
                            </button>
                        ))}
                    </div>
                )}
                {pools.length <= 1 && pool && (
                    <div className="flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs font-medium text-zinc-300 w-fit">
                        <PairIcons pair={pool.pair} />
                    </div>
                )}
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
                                        String(value),
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

            {/* Pool Details */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                    label="On-chain Mid Price"
                    isLoading={poolDetails.isLoading}
                    tooltip="Midpoint between best bid and best ask on the pool's order book"
                >
                    {poolDetails.data ? parseFloat(poolDetails.data.midPrice).toFixed(6) : "—"}
                </StatCard>
                <StatCard
                    label="Tick Size"
                    isLoading={poolDetails.isLoading}
                    tooltip="Smallest allowed price increment for orders"
                >
                    {poolDetails.data?.tickSize ?? "—"}
                </StatCard>
                <StatCard
                    label="Lot Size"
                    isLoading={poolDetails.isLoading}
                    tooltip="Smallest allowed quantity increment for orders"
                >
                    {poolDetails.data?.lotSize ?? "—"}
                </StatCard>
                <StatCard
                    label="Min Size"
                    isLoading={poolDetails.isLoading}
                    tooltip="Minimum order quantity allowed on this pool"
                >
                    {poolDetails.data?.minSize ?? "—"}
                </StatCard>
            </div>

            {/* Config & Stats */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <StatCard
                    label="Mid Price"
                    isLoading={orders.isLoading}
                    tooltip="Market maker's calculated mid price from oracle feeds"
                >
                    {midPrice != null ? midPrice.toFixed(6) : "—"}
                </StatCard>
                <StatCard
                    label="Active Orders"
                    isLoading={orders.isLoading}
                    tooltip="Number of resting orders placed by the market maker"
                >
                    {pool?.orders.length ?? "—"}
                </StatCard>
                <StatCard
                    label="Spread"
                    isLoading={orders.isLoading}
                    tooltip="Price gap between best bid and ask, in basis points"
                >
                    {orders.data ? `${orders.data.config.spreadBps} bps` : "—"}
                </StatCard>
                <StatCard
                    label="Levels / Side"
                    isLoading={orders.isLoading}
                    tooltip="Number of price levels maintained on each side of the book"
                >
                    {orders.data?.config.levelsPerSide ?? "—"}
                </StatCard>
                <StatCard
                    label="Level Spacing"
                    isLoading={orders.isLoading}
                    tooltip="Price gap between consecutive levels, in basis points"
                >
                    {orders.data ? `${orders.data.config.levelSpacingBps} bps` : "—"}
                </StatCard>
                <StatCard
                    label="Pools"
                    isLoading={orders.isLoading}
                    tooltip="Number of trading pools the market maker is active on"
                >
                    {pools.length || "—"}
                </StatCard>
                <StatCard
                    label="Oracle SUI"
                    isLoading={oracle.isLoading}
                    tooltip="SUI/USD price from Pyth Network oracle"
                >
                    {oracle.data?.prices.sui ?? "—"}
                </StatCard>
                <StatCard
                    label="Oracle DEEP"
                    isLoading={oracle.isLoading}
                    tooltip="DEEP/USD price from Pyth Network oracle"
                >
                    {oracle.data?.prices.deep ?? "—"}
                </StatCard>
                <StatCard
                    label="Oracle USDC"
                    isLoading={oracle.isLoading}
                    tooltip="USDC/USD price from Pyth Network oracle"
                >
                    {oracle.data?.prices.usdc ?? "—"}
                </StatCard>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/*  Chart data builder                                                 */
/* ------------------------------------------------------------------ */

function buildChartData(pool: PoolOrders | undefined): ChartRow[] {
    if (!pool) return [];

    const bids = pool.orders.filter((o) => o.isBid).sort((a, b) => a.price - b.price);
    const asks = pool.orders.filter((o) => !o.isBid).sort((a, b) => a.price - b.price);

    const rows: ChartRow[] = [];

    for (const b of bids) {
        rows.push({
            label: b.price.toFixed(6),
            bid: b.quantity,
            ask: null,
            mid: null,
        });
    }

    if (pool.midPrice != null) {
        const maxQty = Math.max(...pool.orders.map((o) => o.quantity), 1);
        rows.push({
            label: pool.midPrice.toFixed(6),
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
    tooltip,
    children,
}: {
    label: string;
    isLoading: boolean;
    tooltip?: string;
    children: ReactNode;
}) {
    return (
        <CardWithPlus>
            <CardContent className="py-4">
                <div className="flex items-center gap-1 text-xs text-zinc-500">
                    {label}
                    {tooltip && (
                        <TooltipProvider delayDuration={200}>
                            <InfoTooltip>
                                <TooltipTrigger asChild>
                                    <Info className="h-3 w-3 cursor-help text-zinc-600" />
                                </TooltipTrigger>
                                <TooltipContent>
                                    <p>{tooltip}</p>
                                </TooltipContent>
                            </InfoTooltip>
                        </TooltipProvider>
                    )}
                </div>
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
