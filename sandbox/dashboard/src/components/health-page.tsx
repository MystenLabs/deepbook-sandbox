import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCurrentClient } from "@mysten/dapp-kit-react";
import {
    Box,
    Activity,
    ArrowLeftRight,
    Droplets,
    Play,
    RefreshCw,
    RotateCcw,
    Server,
    Square,
} from "lucide-react";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/* ------------------------------------------------------------------ */
/*  Types (matching actual service responses)                         */
/* ------------------------------------------------------------------ */

interface FaucetResponse {
    service: string;
    network: string;
    deployer: string;
}

interface OracleResponse {
    status: string;
    updates: number;
    errors: number;
    lastUpdate: string | null;
    prices: { sui: string | null; deep: string | null };
}

interface MarketMakerResponse {
    status: "healthy" | "unhealthy";
    timestamp: string;
    uptime: number;
    details: {
        activeOrders: number;
        totalOrdersPlaced: number;
        totalRebalances: number;
        errors: number;
    };
}

interface ServerStatusResponse {
    status: "OK" | "UNHEALTHY";
    latest_onchain_checkpoint: number;
    current_time_ms: number;
    earliest_checkpoint: number;
    max_checkpoint_lag: number;
    max_time_lag_seconds: number;
    pipelines: {
        pipeline: string;
        indexed_checkpoint: number;
        checkpoint_lag: number;
        time_lag_seconds: number;
    }[];
}

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const REFETCH_INTERVAL = 10_000;

/* ------------------------------------------------------------------ */
/*  HealthPage                                                        */
/* ------------------------------------------------------------------ */

export function HealthPage() {
    const client = useCurrentClient();

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

    const suiState = useQuery<{ epoch: string; epochDurationMs: string }>({
        queryKey: ["sui-system-state"],
        queryFn: async () => {
            const resp = await client.ledgerService.getEpoch({}).response;
            return {
                epoch: String(resp.epoch?.epoch ?? "0"),
                epochDurationMs: "0",
            };
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

    const oracle = useQuery<OracleResponse>({
        queryKey: ["oracle-health"],
        queryFn: async () => {
            const r = await fetch("/api/oracle/");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        },
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
    });

    const mm = useQuery<MarketMakerResponse>({
        queryKey: ["mm-health"],
        queryFn: async () => {
            const r = await fetch("/api/mm/health");
            // MM returns 503 when unhealthy — still parse the body for status details
            if (!r.ok && r.status !== 503) throw new Error(`HTTP ${r.status}`);
            return r.json();
        },
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
    });

    const faucet = useQuery<FaucetResponse>({
        queryKey: ["faucet-health"],
        queryFn: async () => {
            const r = await fetch("/api/");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        },
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
    });

    const server = useQuery<ServerStatusResponse>({
        queryKey: ["server-health"],
        queryFn: async () => {
            const r = await fetch("/api/deepbook/status");
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
                    Auto-refreshes every {REFETCH_INTERVAL / 1000}s
                </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
                {/* Sui Node */}
                <GridCard>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                            <Box className="h-4 w-4 text-zinc-500" />
                            Sui Node
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
                            <MetricValue
                                isLoading={suiState.isLoading}
                                value={suiState.data?.epoch}
                            />
                        </MetricRow>
                        <MetricRow label="Gas Price">
                            <MetricValue
                                isLoading={gasPrice.isLoading}
                                value={gasPrice.data ? `${gasPrice.data} MIST` : undefined}
                            />
                        </MetricRow>
                        <MetricRow label="Network">
                            <MetricValue isLoading={false} value="localnet" />
                        </MetricRow>
                    </CardContent>
                </GridCard>

                {/* Oracle */}
                <GridCard>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                            <Activity className="h-4 w-4 text-zinc-500" />
                            Oracle
                        </CardTitle>
                        <div className="flex items-center gap-2">
                            <StatusIndicator
                                isLoading={oracle.isLoading}
                                isError={oracle.isError}
                            />
                            <StatusBadge isLoading={oracle.isLoading} isError={oracle.isError} />
                            <RefreshButton
                                isFetching={oracle.isFetching}
                                onRefresh={() => oracle.refetch()}
                            />
                            <ServiceActions
                                service="oracle-service"
                                queryKey="oracle-health"
                                isDown={oracle.isError}
                            />
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <MetricRow label="SUI Price">
                            <MetricValue
                                isLoading={oracle.isLoading}
                                value={oracle.data?.prices.sui}
                            />
                        </MetricRow>
                        <MetricRow label="DEEP Price">
                            <MetricValue
                                isLoading={oracle.isLoading}
                                value={oracle.data?.prices.deep}
                            />
                        </MetricRow>
                        <MetricRow label="Updates">
                            <MetricValue
                                isLoading={oracle.isLoading}
                                value={oracle.data?.updates}
                            />
                        </MetricRow>
                        <MetricRow label="Errors">
                            <MetricValue isLoading={oracle.isLoading} value={oracle.data?.errors} />
                        </MetricRow>
                        <MetricRow label="Last Update">
                            <MetricValue
                                isLoading={oracle.isLoading}
                                value={
                                    oracle.data?.lastUpdate
                                        ? formatTimestamp(oracle.data.lastUpdate)
                                        : undefined
                                }
                            />
                        </MetricRow>
                    </CardContent>
                </GridCard>

                {/* Market Maker */}
                <GridCard>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                            <ArrowLeftRight className="h-4 w-4 text-zinc-500" />
                            Market Maker
                        </CardTitle>
                        <div className="flex items-center gap-2">
                            <StatusIndicator
                                isLoading={mm.isLoading}
                                isError={mm.isError}
                                status={mm.data?.status}
                            />
                            <StatusBadge
                                isLoading={mm.isLoading}
                                isError={mm.isError}
                                status={mm.data?.status}
                            />
                            <RefreshButton
                                isFetching={mm.isFetching}
                                onRefresh={() => mm.refetch()}
                            />
                            <ServiceActions
                                service="market-maker"
                                queryKey="mm-health"
                                isDown={mm.isError}
                            />
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <MetricRow label="Active Orders">
                            <MetricValue
                                isLoading={mm.isLoading}
                                value={mm.data?.details.activeOrders}
                            />
                        </MetricRow>
                        <MetricRow label="Total Orders">
                            <MetricValue
                                isLoading={mm.isLoading}
                                value={mm.data?.details.totalOrdersPlaced}
                            />
                        </MetricRow>
                        <MetricRow label="Rebalances">
                            <MetricValue
                                isLoading={mm.isLoading}
                                value={mm.data?.details.totalRebalances}
                            />
                        </MetricRow>
                        <MetricRow label="Uptime">
                            <MetricValue
                                isLoading={mm.isLoading}
                                value={mm.data ? formatUptime(mm.data.uptime) : undefined}
                            />
                        </MetricRow>
                    </CardContent>
                </GridCard>

                {/* Faucet — status only; the api drives /services routes so we
                    can't offer actions for itself (stop/start are non-recoverable
                    from the UI, and the refresh/restart buttons are hidden to
                    keep the card minimal). */}
                <GridCard>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                            <Droplets className="h-4 w-4 text-zinc-500" />
                            Faucet
                        </CardTitle>
                        <div className="flex items-center gap-2">
                            <StatusIndicator
                                isLoading={faucet.isLoading}
                                isError={faucet.isError}
                            />
                            <StatusBadge isLoading={faucet.isLoading} isError={faucet.isError} />
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <MetricRow label="Network">
                            <MetricValue
                                isLoading={faucet.isLoading}
                                value={faucet.data?.network}
                            />
                        </MetricRow>
                        <MetricRow label="Deployer">
                            <MetricValue
                                isLoading={faucet.isLoading}
                                value={
                                    faucet.data ? truncateAddress(faucet.data.deployer) : undefined
                                }
                            />
                        </MetricRow>
                    </CardContent>
                </GridCard>

                {/* DeepBook Server */}
                <GridCard>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                            <Server className="h-4 w-4 text-zinc-500" />
                            DeepBook Server
                        </CardTitle>
                        <div className="flex items-center gap-2">
                            <StatusIndicator
                                isLoading={server.isLoading}
                                isError={server.isError}
                                status={
                                    server.data?.status === "UNHEALTHY" ? "unhealthy" : undefined
                                }
                            />
                            <StatusBadge
                                isLoading={server.isLoading}
                                isError={server.isError}
                                status={
                                    server.data?.status === "UNHEALTHY" ? "unhealthy" : undefined
                                }
                            />
                            <RefreshButton
                                isFetching={server.isFetching}
                                onRefresh={() => server.refetch()}
                            />
                            <ServiceActions
                                service="deepbook-server"
                                queryKey="server-health"
                                isDown={server.isError}
                            />
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <MetricRow label="Status">
                            <MetricValue isLoading={server.isLoading} value={server.data?.status} />
                        </MetricRow>
                        <MetricRow label="Onchain Checkpoint">
                            <MetricValue
                                isLoading={server.isLoading}
                                value={server.data?.latest_onchain_checkpoint}
                            />
                        </MetricRow>
                        <MetricRow label="Max Checkpoint Lag">
                            <MetricValue
                                isLoading={server.isLoading}
                                value={server.data?.max_checkpoint_lag}
                            />
                        </MetricRow>
                        <MetricRow label="Max Time Lag">
                            <MetricValue
                                isLoading={server.isLoading}
                                value={
                                    server.data ? `${server.data.max_time_lag_seconds}s` : undefined
                                }
                            />
                        </MetricRow>
                        <MetricRow label="Pipelines">
                            <MetricValue
                                isLoading={server.isLoading}
                                value={server.data?.pipelines.length}
                            />
                        </MetricRow>
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

type ControllableService =
    | "oracle-service"
    | "market-maker"
    | "deepbook-sandbox-api"
    | "deepbook-server";

type ServiceAction = "start" | "stop" | "restart";

// The api service runs the /services routes themselves, so it can't receive a
// /start once it's been stopped — there's nothing alive to handle the request.
// `docker restart` still works because the daemon completes it after the
// container dies mid-request, so Restart remains available.
const SELF_CONTROLLED = new Set<ControllableService>(["deepbook-sandbox-api"]);

function ServiceActions({
    service,
    queryKey,
    isDown,
}: {
    service: ControllableService;
    queryKey: string;
    isDown: boolean;
}) {
    const qc = useQueryClient();

    // Self-restart of deepbook-sandbox-api kills the container mid-request, so
    // the fetch can legitimately reject — treat it as a successful kick anyway
    // and let the health query reflect the real state on its next poll.
    const post = async (action: ServiceAction) => {
        try {
            await fetch(`/api/services/${service}/${action}`, { method: "POST" });
        } catch {
            /* self-targeting restart drops the connection — expected */
        }
    };

    // Docker takes 1–3s to actually flip container state after our 202. A single
    // refetch on settle lands too early and sees stale "healthy". Burst a few
    // delayed invalidations so the UI reflects reality within ~2s of the click.
    const kickHealthQuery = () => {
        qc.invalidateQueries({ queryKey: [queryKey] });
        setTimeout(() => qc.invalidateQueries({ queryKey: [queryKey] }), 1500);
        setTimeout(() => qc.invalidateQueries({ queryKey: [queryKey] }), 4000);
    };

    const primary = useMutation({
        mutationFn: (action: "start" | "stop") => post(action),
        onSettled: kickHealthQuery,
    });
    const restart = useMutation({
        mutationFn: () => post("restart"),
        onSettled: kickHealthQuery,
    });

    const busy = primary.isPending || restart.isPending;
    const primaryAction: "start" | "stop" = isDown ? "start" : "stop";
    const PrimaryIcon = isDown ? Play : Square;
    const primaryLabel = isDown ? "Start service" : "Stop service";

    const showPrimary = !SELF_CONTROLLED.has(service);

    return (
        <TooltipProvider delayDuration={200}>
            {showPrimary && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            onClick={() => primary.mutate(primaryAction)}
                            disabled={busy}
                            aria-label={primaryLabel}
                            className="rounded-md p-1 text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-50"
                        >
                            <PrimaryIcon
                                className={`h-3.5 w-3.5 ${primary.isPending ? "animate-pulse" : ""}`}
                            />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent>{primaryLabel}</TooltipContent>
                </Tooltip>
            )}
            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        onClick={() => restart.mutate()}
                        disabled={busy}
                        aria-label="Restart service"
                        className="rounded-md p-1 text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-50"
                    >
                        <RotateCcw
                            className={`h-3.5 w-3.5 ${restart.isPending ? "animate-spin" : ""}`}
                        />
                    </button>
                </TooltipTrigger>
                <TooltipContent>Restart service</TooltipContent>
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
    if (status === "unhealthy") return <Badge variant="warning">Unhealthy</Badge>;
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

function formatUptime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m ${seconds}s`;
}

function formatTimestamp(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleTimeString();
}

function truncateAddress(addr: string): string {
    if (addr.length <= 12) return addr;
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
