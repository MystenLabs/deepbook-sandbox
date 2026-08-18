import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCurrentClient } from "@mysten/dapp-kit-react";
import { ArrowLeftRight, Box, Clock, Droplets, RefreshCw, Server } from "lucide-react";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useManifest, isForkManifest } from "@/hooks/use-deepbook-client";
import { coreOf, forkClockMs, forkRecentTrades, type ForkTrade } from "@/lib/fork";

/* ------------------------------------------------------------------ */
/*  What this page checks — the devstack members, from the browser     */
/* ------------------------------------------------------------------ */
//
// Every card maps to a member of the running fork stack, using only
// browser-reachable signals (the localnet-era oracle/market-maker cards and
// the /api/services start/stop controls pointed at services and routes that
// no longer exist; services are devstack members now — member-level control
// lives on the devstack dashboard):
//
//   fork chain    → gRPC via the /api/sui proxy (checkpoint / epoch / gas)
//   clock-driver  → |wall − on-chain Clock| (it exists to hold that at ~0;
//                   the fork clock never ticks by itself)
//   trade-sim     → age of the newest DEEP_SUI fill; this doubles as the
//                   indexer-freshness signal, since fills reach us through
//                   chain → indexer → Postgres → server
//   server (+ Postgres) → /ticker, a Postgres-backed endpoint (the /status
//                   health route is live-RPC — dead on the gRPC-only fork)
//   sandbox-api   → GET /api/ (manifest + faucet service)

interface SandboxApiResponse {
    service: string;
    network: string;
}

interface TickerEntry {
    last_price: number;
    base_volume: number;
    quote_volume: number;
    isFrozen: number;
}

const REFETCH_INTERVAL = 10_000;
/** clock-driver holds the Clock every 5s; more than this is a stall. */
const CLOCK_DRIFT_UNHEALTHY_MS = 30_000;
/** trade-sim fills roughly every second; quiet longer than this is a stall. */
const FILL_AGE_UNHEALTHY_MS = 60_000;

const DEVSTACK_DASHBOARD_URL = "http://api.deepbook-sandbox.devstack-plugins.localhost:9810";

/* ------------------------------------------------------------------ */
/*  HealthPage                                                        */
/* ------------------------------------------------------------------ */

export function HealthPage() {
    const client = useCurrentClient();
    const manifest = useManifest();
    const network = manifest.data && isForkManifest(manifest.data) ? "mainnet fork" : "localnet";

    const sui = useQuery<string>({
        queryKey: ["sui-checkpoint"],
        queryFn: async () => {
            const resp = await client.ledgerService.getCheckpoint({
                checkpointId: { oneofKind: undefined },
            }).response;
            return String(resp.checkpoint?.sequenceNumber ?? "0");
        },
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
    });

    const suiState = useQuery<string>({
        queryKey: ["sui-system-state"],
        queryFn: async () => {
            const resp = await client.ledgerService.getEpoch({}).response;
            return String(resp.epoch?.epoch ?? "0");
        },
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
    });

    const gasPrice = useQuery<string>({
        queryKey: ["sui-gas-price"],
        queryFn: async () => {
            const resp = await client.getReferenceGasPrice();
            return String(resp.referenceGasPrice);
        },
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
    });

    const clock = useQuery<{ clockMs: number; driftMs: number }>({
        queryKey: ["health-clock"],
        queryFn: async () => {
            const clockMs = await forkClockMs(coreOf(client));
            return { clockMs, driftMs: Math.abs(Date.now() - clockMs) };
        },
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
    });
    const clockStatus =
        clock.data && clock.data.driftMs > CLOCK_DRIFT_UNHEALTHY_MS ? "unhealthy" : undefined;

    const lastFill = useQuery<{ trade: ForkTrade | null; ageMs: number | null }>({
        queryKey: ["health-last-fill"],
        queryFn: async () => {
            // Age computed at fetch time (render must stay pure); it refreshes
            // with every poll, which is exactly its precision anyway.
            const trade = (await forkRecentTrades("DEEP_SUI", 1))[0] ?? null;
            return { trade, ageMs: trade ? Date.now() - trade.timestamp : null };
        },
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
    });
    const fillAgeMs = lastFill.data?.ageMs ?? null;
    const simStalled = fillAgeMs === null || fillAgeMs > FILL_AGE_UNHEALTHY_MS;
    let simStatus: string | undefined;
    if (!lastFill.isError && !lastFill.isLoading && simStalled) simStatus = "unhealthy";

    const ticker = useQuery<Record<string, TickerEntry>>({
        queryKey: ["health-ticker"],
        queryFn: async () => {
            const r = await fetch("/api/deepbook/ticker");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        },
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
    });
    const deepSui = ticker.data?.DEEP_SUI;

    const api = useQuery<SandboxApiResponse>({
        queryKey: ["sandbox-api-health"],
        queryFn: async () => {
            const r = await fetch("/api/");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        },
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
    });

    return (
        <div className="space-y-4">
            <div className="space-y-1">
                <h1 className="text-lg font-semibold">Service Health</h1>
                <p className="text-xs text-muted-foreground">
                    The stack&apos;s devstack members, checked from the browser — auto-refreshes
                    every {REFETCH_INTERVAL / 1000}s. Member-level detail and control:{" "}
                    <a
                        href={DEVSTACK_DASHBOARD_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="underline hover:text-zinc-300"
                    >
                        devstack dashboard
                    </a>
                </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
                {/* Fork chain */}
                <GridCard>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                            <Box className="h-4 w-4 text-zinc-500" />
                            Fork Chain
                        </CardTitle>
                        <div className="flex items-center gap-2">
                            <StatusIndicator isLoading={sui.isLoading} isError={sui.isError} />
                            <StatusBadge isLoading={sui.isLoading} isError={sui.isError} />
                            <RefreshButton
                                isFetching={sui.isFetching}
                                onRefresh={() => sui.refetch()}
                            />
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <MetricRow label="Latest Checkpoint">
                            <MetricValue isLoading={sui.isLoading} value={sui.data} />
                        </MetricRow>
                        <MetricRow label="Epoch">
                            <MetricValue isLoading={suiState.isLoading} value={suiState.data} />
                        </MetricRow>
                        <MetricRow label="Gas Price">
                            <MetricValue
                                isLoading={gasPrice.isLoading}
                                value={gasPrice.data ? `${gasPrice.data} MIST` : undefined}
                            />
                        </MetricRow>
                        <MetricRow label="Network">
                            <MetricValue isLoading={manifest.isLoading} value={network} />
                        </MetricRow>
                    </CardContent>
                </GridCard>

                {/* Clock driver */}
                <GridCard>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                            <Clock className="h-4 w-4 text-zinc-500" />
                            Clock Driver
                        </CardTitle>
                        <div className="flex items-center gap-2">
                            <StatusIndicator
                                isLoading={clock.isLoading}
                                isError={clock.isError}
                                status={clockStatus}
                            />
                            <StatusBadge
                                isLoading={clock.isLoading}
                                isError={clock.isError}
                                status={clockStatus}
                            />
                            <RefreshButton
                                isFetching={clock.isFetching}
                                onRefresh={() => clock.refetch()}
                            />
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <MetricRow label="On-chain Clock">
                            <MetricValue
                                isLoading={clock.isLoading}
                                value={
                                    clock.data
                                        ? new Date(clock.data.clockMs).toLocaleTimeString()
                                        : undefined
                                }
                            />
                        </MetricRow>
                        <MetricRow label="Drift vs Wall">
                            <MetricValue
                                isLoading={clock.isLoading}
                                value={clock.data ? formatAge(clock.data.driftMs) : undefined}
                            />
                        </MetricRow>
                        <p className="pt-1 text-xs text-zinc-600">
                            The fork clock never ticks by itself — this member holds it at wall time
                            so fills stay inside the server&apos;s time windows.
                        </p>
                    </CardContent>
                </GridCard>

                {/* Trade sim */}
                <GridCard>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                            <ArrowLeftRight className="h-4 w-4 text-zinc-500" />
                            Trade Sim
                        </CardTitle>
                        <div className="flex items-center gap-2">
                            <StatusIndicator
                                isLoading={lastFill.isLoading}
                                isError={lastFill.isError}
                                status={simStatus}
                            />
                            <StatusBadge
                                isLoading={lastFill.isLoading}
                                isError={lastFill.isError}
                                status={simStatus}
                            />
                            <RefreshButton
                                isFetching={lastFill.isFetching}
                                onRefresh={() => lastFill.refetch()}
                            />
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <MetricRow label="Last Fill">
                            <MetricValue
                                isLoading={lastFill.isLoading}
                                value={fillAgeMs !== null ? `${formatAge(fillAgeMs)} ago` : "none"}
                            />
                        </MetricRow>
                        <MetricRow label="Price">
                            <MetricValue
                                isLoading={lastFill.isLoading}
                                value={lastFill.data?.trade?.price}
                            />
                        </MetricRow>
                        <MetricRow label="Size (DEEP)">
                            <MetricValue
                                isLoading={lastFill.isLoading}
                                value={lastFill.data?.trade?.base_volume}
                            />
                        </MetricRow>
                        <p className="pt-1 text-xs text-zinc-600">
                            Fills reach this page through chain → indexer → Postgres → server, so a
                            fresh fill also proves the indexer is ingesting.
                        </p>
                    </CardContent>
                </GridCard>

                {/* DeepBook server (+ Postgres) */}
                <GridCard>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                            <Server className="h-4 w-4 text-zinc-500" />
                            DeepBook Server
                        </CardTitle>
                        <div className="flex items-center gap-2">
                            <StatusIndicator
                                isLoading={ticker.isLoading}
                                isError={ticker.isError}
                            />
                            <StatusBadge isLoading={ticker.isLoading} isError={ticker.isError} />
                            <RefreshButton
                                isFetching={ticker.isFetching}
                                onRefresh={() => ticker.refetch()}
                            />
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <MetricRow label="Pools Tracked">
                            <MetricValue
                                isLoading={ticker.isLoading}
                                value={ticker.data ? Object.keys(ticker.data).length : undefined}
                            />
                        </MetricRow>
                        <MetricRow label="DEEP/SUI Last Price">
                            <MetricValue isLoading={ticker.isLoading} value={deepSui?.last_price} />
                        </MetricRow>
                        <MetricRow label="DEEP/SUI 24h Volume">
                            <MetricValue
                                isLoading={ticker.isLoading}
                                value={
                                    deepSui
                                        ? `${deepSui.base_volume.toLocaleString()} DEEP`
                                        : undefined
                                }
                            />
                        </MetricRow>
                        <p className="pt-1 text-xs text-zinc-600">
                            Checked via /ticker (Postgres-backed) — a passing check covers the
                            Postgres member too.
                        </p>
                    </CardContent>
                </GridCard>

                {/* Sandbox API */}
                <GridCard>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                            <Droplets className="h-4 w-4 text-zinc-500" />
                            Sandbox API
                        </CardTitle>
                        <div className="flex items-center gap-2">
                            <StatusIndicator isLoading={api.isLoading} isError={api.isError} />
                            <StatusBadge isLoading={api.isLoading} isError={api.isError} />
                            <RefreshButton
                                isFetching={api.isFetching}
                                onRefresh={() => api.refetch()}
                            />
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <MetricRow label="Service">
                            <MetricValue isLoading={api.isLoading} value={api.data?.service} />
                        </MetricRow>
                        <MetricRow label="Network">
                            <MetricValue isLoading={api.isLoading} value={api.data?.network} />
                        </MetricRow>
                        <p className="pt-1 text-xs text-zinc-600">
                            Serves the deployment manifest and the SUI/DEEP/USDC faucet.
                        </p>
                    </CardContent>
                </GridCard>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function RefreshButton({ isFetching, onRefresh }: { isFetching: boolean; onRefresh: () => void }) {
    return (
        <TooltipProvider delayDuration={200}>
            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        onClick={onRefresh}
                        disabled={isFetching}
                        aria-label="Refresh"
                        className="rounded-md p-1 text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-50"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
                    </button>
                </TooltipTrigger>
                <TooltipContent>Refresh</TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}

function GridCard({ children }: { children: ReactNode }) {
    return (
        <div className="dark border w-full rounded-md overflow-hidden border-zinc-900 bg-zinc-950 p-1 text-zinc-50">
            <div className="size-full bg-[url(/svg/circle-ellipsis.svg)] bg-repeat bg-[length:30px_30px]">
                <div className="size-full bg-gradient-to-tr from-zinc-950 via-zinc-950/80 to-zinc-900/10">
                    {children}
                </div>
            </div>
        </div>
    );
}

function StatusIndicator({
    isLoading,
    isError,
    status,
}: {
    isLoading: boolean;
    isError: boolean;
    status?: string;
}) {
    if (isLoading) return <Skeleton className="h-3 w-3 rounded-full bg-zinc-800" />;

    const isOnline = !isError && status !== "unhealthy";

    let color = "bg-emerald-500";
    if (isError) color = "bg-destructive";
    else if (status === "unhealthy") color = "bg-yellow-500";

    return (
        <span className="relative flex h-3 w-3">
            {isOnline && (
                <span
                    className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${color}`}
                />
            )}
            <span className={`relative inline-flex h-3 w-3 rounded-full ${color}`} />
        </span>
    );
}

function StatusBadge({
    isLoading,
    isError,
    status,
}: {
    isLoading: boolean;
    isError: boolean;
    status?: string;
}) {
    if (isLoading) return <Skeleton className="h-5 w-14 bg-zinc-800" />;
    if (isError) return <Badge variant="destructive">Offline</Badge>;
    if (status === "unhealthy") return <Badge variant="warning">Stalled</Badge>;
    return <Badge variant="success">Online</Badge>;
}

function MetricRow({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-500">{label}</span>
            {children}
        </div>
    );
}

function MetricValue({
    isLoading,
    value,
}: {
    isLoading: boolean;
    value: string | number | null | undefined;
}) {
    if (isLoading) return <Skeleton className="h-5 w-20 bg-zinc-800" />;
    return <span className="text-sm font-medium text-zinc-200">{value ?? "—"}</span>;
}

function formatAge(ms: number): string {
    if (ms < 1_000) return `${ms}ms`;
    if (ms < 120_000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 120) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
