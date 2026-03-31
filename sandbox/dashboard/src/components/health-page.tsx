import { useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSuiClientQuery } from "@mysten/dapp-kit";
import {
    Box,
    Activity,
    ArrowLeftRight,
    Droplets,
    RefreshCw,
    Server,
    Play,
    Square,
    RotateCw,
    Eye,
    Download,
    Trash2,
    Save,
    AlertCircle,
    CheckCircle2,
} from "lucide-react";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

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

// Control API types
interface ServiceInfo {
    name: string;
    status: "running" | "stopped" | "error" | "unknown";
    uptime?: string;
    ports?: string[];
    image?: string;
}

interface ServiceListResponse {
    services: ServiceInfo[];
}

interface LogsResponse {
    logs: string;
    service: string;
    lines: number;
}

interface ConfigResponse {
    content: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const REFETCH_INTERVAL = 10_000;

// Get API token from environment variable (injected at build time)
const getApiToken = () => {
    return import.meta.env.VITE_CONTROL_API_TOKEN || "";
};

// API client
const controlApi = {
    async fetchServices(): Promise<ServiceListResponse> {
        const response = await fetch("/api/control/services", {
            headers: { Authorization: `Bearer ${getApiToken()}` },
        });
        if (!response.ok) throw new Error("Failed to fetch services");
        return response.json();
    },

    async startService(serviceName: string): Promise<void> {
        const response = await fetch(`/api/control/services/${serviceName}/start`, {
            method: "POST",
            headers: { Authorization: `Bearer ${getApiToken()}` },
        });
        if (!response.ok) throw new Error("Failed to start service");
    },

    async stopService(serviceName: string): Promise<void> {
        const response = await fetch(`/api/control/services/${serviceName}/stop`, {
            method: "POST",
            headers: { Authorization: `Bearer ${getApiToken()}` },
        });
        if (!response.ok) throw new Error("Failed to stop service");
    },

    async restartService(serviceName: string): Promise<void> {
        const response = await fetch(`/api/control/services/${serviceName}/restart`, {
            method: "POST",
            headers: { Authorization: `Bearer ${getApiToken()}` },
        });
        if (!response.ok) throw new Error("Failed to restart service");
    },

    async fetchLogs(serviceName: string, lines: number): Promise<LogsResponse> {
        const response = await fetch(`/api/control/services/${serviceName}/logs?lines=${lines}`, {
            headers: { Authorization: `Bearer ${getApiToken()}` },
        });
        if (!response.ok) throw new Error("Failed to fetch logs");
        return response.json();
    },

    async resetEnvironment(): Promise<void> {
        const response = await fetch("/api/control/reset", {
            method: "POST",
            headers: { Authorization: `Bearer ${getApiToken()}` },
        });
        if (!response.ok) throw new Error("Failed to reset environment");
    },

    async restartAllServices(): Promise<void> {
        const response = await fetch("/api/control/services/restart-all", {
            method: "POST",
            headers: { Authorization: `Bearer ${getApiToken()}` },
        });
        if (!response.ok) throw new Error("Failed to restart all services");
    },

    async fetchConfig(): Promise<ConfigResponse> {
        const response = await fetch("/api/control/config", {
            headers: { Authorization: `Bearer ${getApiToken()}` },
        });
        if (!response.ok) throw new Error("Failed to fetch config");
        return response.json();
    },

    async updateConfig(content: string): Promise<void> {
        const response = await fetch("/api/control/config", {
            method: "PUT",
            headers: {
                Authorization: `Bearer ${getApiToken()}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ content }),
        });
        if (!response.ok) throw new Error("Failed to update config");
    },
};

/* ------------------------------------------------------------------ */
/*  ServiceControlButtons Component                                   */
/* ------------------------------------------------------------------ */

function ServiceControlButtons({
    serviceName,
    showOnlyLogs = false,
}: {
    serviceName: string;
    showOnlyLogs?: boolean;
}) {
    const queryClient = useQueryClient();
    const [actionError, setActionError] = useState<string | null>(null);
    const [actionSuccess, setActionSuccess] = useState<string | null>(null);
    const [showLogsDialog, setShowLogsDialog] = useState(false);
    const [logLines, setLogLines] = useState(100);

    // Fetch service status
    const { data: servicesData } = useQuery({
        queryKey: ["services"],
        queryFn: controlApi.fetchServices,
        refetchInterval: 10000,
    });

    const service = servicesData?.services.find((s) => s.name === serviceName);

    const startMutation = useMutation({
        mutationFn: () => controlApi.startService(serviceName),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["services"] });
            setActionSuccess(`Started ${serviceName}`);
            setActionError(null);
            setTimeout(() => setActionSuccess(null), 3000);
        },
        onError: (error: Error) => {
            setActionError(`Failed to start: ${error.message}`);
            setActionSuccess(null);
        },
    });

    const stopMutation = useMutation({
        mutationFn: () => controlApi.stopService(serviceName),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["services"] });
            setActionSuccess(`Stopped ${serviceName}`);
            setActionError(null);
            setTimeout(() => setActionSuccess(null), 3000);
        },
        onError: (error: Error) => {
            setActionError(`Failed to stop: ${error.message}`);
            setActionSuccess(null);
        },
    });

    const restartMutation = useMutation({
        mutationFn: () => controlApi.restartService(serviceName),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["services"] });
            setActionSuccess(`Restarted ${serviceName}`);
            setActionError(null);
            setTimeout(() => setActionSuccess(null), 3000);
        },
        onError: (error: Error) => {
            setActionError(`Failed to restart: ${error.message}`);
            setActionSuccess(null);
        },
    });

    const { data: logsData, isLoading: logsLoading } = useQuery({
        queryKey: ["logs", serviceName, logLines],
        queryFn: () => controlApi.fetchLogs(serviceName, logLines),
        enabled: showLogsDialog,
        refetchInterval: showLogsDialog ? 5000 : false,
    });

    const downloadLogs = () => {
        if (!logsData?.logs) return;

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `${serviceName}-logs-${timestamp}.txt`;
        const blob = new Blob([logsData.logs], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    return (
        <>
            <div className="space-y-2 pt-2">
                {actionSuccess && (
                    <Alert className="bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800">
                        <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                        <AlertDescription className="text-green-800 dark:text-green-200">
                            {actionSuccess}
                        </AlertDescription>
                    </Alert>
                )}

                {actionError && (
                    <Alert variant="destructive">
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription>{actionError}</AlertDescription>
                    </Alert>
                )}

                <div className="flex flex-wrap gap-2">
                    {!showOnlyLogs && (
                        <>
                            <Button
                                size="sm"
                                variant="default"
                                onClick={() => startMutation.mutate()}
                                disabled={service?.status === "running" || startMutation.isPending}
                            >
                                <Play className="mr-1 h-3 w-3" /> Start
                            </Button>
                            <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => stopMutation.mutate()}
                                disabled={service?.status === "stopped" || stopMutation.isPending}
                            >
                                <Square className="mr-1 h-3 w-3" /> Stop
                            </Button>
                            <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => restartMutation.mutate()}
                                disabled={restartMutation.isPending}
                            >
                                <RotateCw className="mr-1 h-3 w-3" /> Restart
                            </Button>
                        </>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setShowLogsDialog(true)}>
                        <Eye className="mr-1 h-3 w-3" /> View Logs
                    </Button>
                </div>
            </div>

            {/* Logs Dialog */}
            <Dialog open={showLogsDialog} onOpenChange={setShowLogsDialog}>
                <DialogContent className="max-w-4xl max-h-[80vh]">
                    <DialogHeader>
                        <DialogTitle>{serviceName} Logs</DialogTitle>
                        <DialogDescription>
                            Real-time logs (auto-refreshes every 5s)
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div className="flex items-center gap-2">
                            <Label htmlFor={`lines-${serviceName}`}>Lines:</Label>
                            <Input
                                id={`lines-${serviceName}`}
                                type="number"
                                value={logLines}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                    setLogLines(parseInt(e.target.value) || 100)
                                }
                                className="w-24"
                                min={10}
                                max={1000}
                            />
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={downloadLogs}
                                disabled={!logsData?.logs || logsLoading}
                            >
                                <Download className="mr-1 h-3 w-3" />
                                Download
                            </Button>
                        </div>
                        <div className="rounded-md bg-black p-3 font-mono text-xs text-green-400 overflow-auto max-h-96">
                            {logsLoading ? (
                                <div>Loading logs...</div>
                            ) : logsData ? (
                                <pre className="whitespace-pre-wrap">
                                    {logsData.logs || "No logs available"}
                                </pre>
                            ) : null}
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowLogsDialog(false)}>
                            Close
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

/* ------------------------------------------------------------------ */
/*  HealthPage                                                        */
/* ------------------------------------------------------------------ */

export function HealthPage() {
    const queryClient = useQueryClient();
    const [showResetDialog, setShowResetDialog] = useState(false);
    const [showConfigEditor, setShowConfigEditor] = useState(false);
    const [resetError, setResetError] = useState<string | null>(null);
    const [configError, setConfigError] = useState<string | null>(null);
    const [restartAllSuccess, setRestartAllSuccess] = useState<string | null>(null);
    const [restartAllError, setRestartAllError] = useState<string | null>(null);
    const [configContent, setConfigContent] = useState("");

    const sui = useSuiClientQuery("getLatestCheckpointSequenceNumber", undefined, {
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
    });

    const suiState = useSuiClientQuery("getLatestSuiSystemState", undefined, {
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
    });

    const gasPrice = useSuiClientQuery("getReferenceGasPrice", undefined, {
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
            const r = await fetch("/api/faucet/");
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

    const { data: configData } = useQuery({
        queryKey: ["config"],
        queryFn: controlApi.fetchConfig,
        enabled: showConfigEditor,
    });

    const updateConfigMutation = useMutation({
        mutationFn: (content: string) => controlApi.updateConfig(content),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["config"] });
            setShowConfigEditor(false);
            setConfigError(null);
        },
        onError: (error: Error) => {
            setConfigError(`Failed to update config: ${error.message}`);
        },
    });

    const resetMutation = useMutation({
        mutationFn: controlApi.resetEnvironment,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["services"] });
            setShowResetDialog(false);
            setResetError(null);
        },
        onError: (error: Error) => {
            setResetError(`Failed to reset environment: ${error.message}`);
        },
    });

    const restartAllMutation = useMutation({
        mutationFn: controlApi.restartAllServices,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["services"] });
            setRestartAllSuccess("All services restarted successfully");
            setRestartAllError(null);
            setTimeout(() => setRestartAllSuccess(null), 3000);
        },
        onError: (error: Error) => {
            setRestartAllError(`Failed to restart all services: ${error.message}`);
            setRestartAllSuccess(null);
        },
    });

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <div className="space-y-1">
                    <h1 className="text-lg font-semibold">Service Health</h1>
                    <p className="text-xs text-muted-foreground">
                        Auto-refreshes every {REFETCH_INTERVAL / 1000}s
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => restartAllMutation.mutate()}
                        disabled={restartAllMutation.isPending}
                    >
                        <RotateCw className="mr-2 h-4 w-4" />
                        {restartAllMutation.isPending ? "Restarting..." : "Restart All Services"}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setShowConfigEditor(true)}>
                        <Save className="mr-2 h-4 w-4" /> Edit Config
                    </Button>
                    <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setShowResetDialog(true)}
                    >
                        <Trash2 className="mr-2 h-4 w-4" /> Reset Environment
                    </Button>
                </div>
            </div>

            {restartAllSuccess && (
                <Alert className="bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800">
                    <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                    <AlertDescription className="text-green-800 dark:text-green-200">
                        {restartAllSuccess}
                    </AlertDescription>
                </Alert>
            )}

            {restartAllError && (
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{restartAllError}</AlertDescription>
                </Alert>
            )}

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
                    <CardContent className="flex flex-col flex-1">
                        <div className="space-y-2 flex-1">
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
                        </div>
                        <ServiceControlButtons serviceName="sui-localnet" showOnlyLogs={true} />
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
                        </div>
                    </CardHeader>
                    <CardContent className="flex flex-col flex-1">
                        <div className="space-y-2 flex-1">
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
                        </div>
                        <ServiceControlButtons serviceName="oracle-service" />
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
                        </div>
                    </CardHeader>
                    <CardContent className="flex flex-col flex-1">
                        <div className="space-y-2 flex-1">
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
                        </div>
                        <ServiceControlButtons serviceName="deepbook-market-maker" />
                    </CardContent>
                </GridCard>

                {/* Faucet */}
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
                            <RefreshButton
                                isFetching={faucet.isFetching}
                                onRefresh={() => faucet.refetch()}
                            />
                        </div>
                    </CardHeader>
                    <CardContent className="flex flex-col flex-1">
                        <div className="space-y-2 flex-1">
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
                        </div>
                        <ServiceControlButtons serviceName="deepbook-faucet" />
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
                        </div>
                    </CardHeader>
                    <CardContent className="flex flex-col flex-1">
                        <div className="space-y-2 flex-1">
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
                        </div>
                        <ServiceControlButtons serviceName="deepbook-server" />
                    </CardContent>
                </GridCard>
            </div>

            {/* Reset Environment Dialog */}
            <Dialog open={showResetDialog} onOpenChange={setShowResetDialog}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Reset Environment</DialogTitle>
                        <DialogDescription>
                            This will stop all services and remove all volumes. All data will be
                            lost.
                        </DialogDescription>
                    </DialogHeader>
                    <Alert variant="destructive">
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription>
                            This action cannot be undone. All deployment data and volumes will be
                            permanently deleted.
                        </AlertDescription>
                    </Alert>
                    {resetError && (
                        <Alert variant="destructive">
                            <AlertCircle className="h-4 w-4" />
                            <AlertDescription>{resetError}</AlertDescription>
                        </Alert>
                    )}
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => {
                                setShowResetDialog(false);
                                setResetError(null);
                            }}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={() => resetMutation.mutate()}
                            disabled={resetMutation.isPending}
                        >
                            {resetMutation.isPending ? "Resetting..." : "Reset Environment"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Config Editor Dialog */}
            <Dialog open={showConfigEditor} onOpenChange={setShowConfigEditor}>
                <DialogContent className="max-w-3xl">
                    <DialogHeader>
                        <DialogTitle>Configuration Editor</DialogTitle>
                        <DialogDescription>
                            Edit the .env configuration file. Changes require service restart to
                            take effect.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        {configError && (
                            <Alert variant="destructive">
                                <AlertCircle className="h-4 w-4" />
                                <AlertDescription>{configError}</AlertDescription>
                            </Alert>
                        )}
                        <Textarea
                            value={configContent || configData?.content || ""}
                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                                setConfigContent(e.target.value)
                            }
                            className="font-mono text-sm"
                            rows={20}
                        />
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => {
                                setShowConfigEditor(false);
                                setConfigError(null);
                            }}
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={() =>
                                updateConfigMutation.mutate(
                                    configContent || configData?.content || "",
                                )
                            }
                            disabled={updateConfigMutation.isPending}
                        >
                            {updateConfigMutation.isPending ? "Saving..." : "Save Changes"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

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

function GridCard({ children }: { children: ReactNode }) {
    return (
        <div className="dark border w-full rounded-md overflow-hidden border-zinc-900 bg-zinc-950 p-1 text-zinc-50 flex flex-col">
            <div className="size-full bg-[url(/svg/circle-ellipsis.svg)] bg-repeat bg-[length:30px_30px] flex flex-col flex-1">
                <div className="size-full bg-gradient-to-tr from-zinc-950 via-zinc-950/80 to-zinc-900/10 flex flex-col flex-1">
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
