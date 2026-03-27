import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
    AlertCircle,
    CheckCircle2,
    Circle,
    Play,
    Square,
    RotateCw,
    Trash2,
    Save,
    Eye,
    EyeOff,
    Download,
} from "lucide-react";
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

// API types
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

function ServiceCard({ service }: { service: ServiceInfo }) {
    const queryClient = useQueryClient();
    const [actionError, setActionError] = useState<string | null>(null);
    const [actionSuccess, setActionSuccess] = useState<string | null>(null);

    const startMutation = useMutation({
        mutationFn: () => controlApi.startService(service.name),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["services"] });
            setActionSuccess(`Started ${service.name}`);
            setActionError(null);
            setTimeout(() => setActionSuccess(null), 3000);
        },
        onError: (error: Error) => {
            setActionError(`Failed to start: ${error.message}`);
            setActionSuccess(null);
        },
    });

    const stopMutation = useMutation({
        mutationFn: () => controlApi.stopService(service.name),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["services"] });
            setActionSuccess(`Stopped ${service.name}`);
            setActionError(null);
            setTimeout(() => setActionSuccess(null), 3000);
        },
        onError: (error: Error) => {
            setActionError(`Failed to stop: ${error.message}`);
            setActionSuccess(null);
        },
    });

    const restartMutation = useMutation({
        mutationFn: () => controlApi.restartService(service.name),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["services"] });
            setActionSuccess(`Restarted ${service.name}`);
            setActionError(null);
            setTimeout(() => setActionSuccess(null), 3000);
        },
        onError: (error: Error) => {
            setActionError(`Failed to restart: ${error.message}`);
            setActionSuccess(null);
        },
    });

    const [showLogs, setShowLogs] = useState(false);
    const [logLines, setLogLines] = useState(100);

    const { data: logsData, isLoading: logsLoading } = useQuery({
        queryKey: ["logs", service.name, logLines],
        queryFn: () => controlApi.fetchLogs(service.name, logLines),
        enabled: showLogs,
        refetchInterval: showLogs ? 5000 : false,
    });

    const downloadLogs = () => {
        if (!logsData?.logs) return;

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `${service.name}-logs-${timestamp}.txt`;
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

    const statusIcon = {
        running: <CheckCircle2 className="h-4 w-4 text-green-500" />,
        stopped: <Square className="h-4 w-4 text-gray-400" />,
        error: <AlertCircle className="h-4 w-4 text-red-500" />,
        unknown: <Circle className="h-4 w-4 text-gray-400" />,
    }[service.status];

    const statusColor = {
        running: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
        stopped: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
        error: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
        unknown: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
    }[service.status];

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        {statusIcon}
                        <CardTitle className="text-lg">{service.name}</CardTitle>
                    </div>
                    <Badge className={statusColor}>{service.status}</Badge>
                </div>
                {service.uptime && (
                    <CardDescription className="text-sm">{service.uptime}</CardDescription>
                )}
            </CardHeader>
            <CardContent className="space-y-4">
                {service.ports && service.ports.length > 0 && (
                    <div className="text-sm text-muted-foreground">
                        Ports: {service.ports.join(", ")}
                    </div>
                )}

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
                    <Button
                        size="sm"
                        variant="default"
                        onClick={() => startMutation.mutate()}
                        disabled={service.status === "running" || startMutation.isPending}
                    >
                        <Play className="mr-1 h-3 w-3" /> Start
                    </Button>
                    <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => stopMutation.mutate()}
                        disabled={service.status === "stopped" || stopMutation.isPending}
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
                    <Button size="sm" variant="outline" onClick={() => setShowLogs(!showLogs)}>
                        {showLogs ? (
                            <>
                                <EyeOff className="mr-1 h-3 w-3" /> Hide Logs
                            </>
                        ) : (
                            <>
                                <Eye className="mr-1 h-3 w-3" /> View Logs
                            </>
                        )}
                    </Button>
                </div>

                {showLogs && (
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <Label htmlFor={`lines-${service.name}`}>Lines:</Label>
                            <Input
                                id={`lines-${service.name}`}
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
                        <div className="rounded-md bg-black p-3 font-mono text-xs text-green-400">
                            {logsLoading ? (
                                <div>Loading logs...</div>
                            ) : logsData ? (
                                <pre className="max-h-64 overflow-auto whitespace-pre-wrap">
                                    {logsData.logs || "No logs available"}
                                </pre>
                            ) : null}
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

export function ControlPage() {
    const [showResetDialog, setShowResetDialog] = useState(false);
    const [showConfigEditor, setShowConfigEditor] = useState(false);
    const [resetError, setResetError] = useState<string | null>(null);
    const [configError, setConfigError] = useState<string | null>(null);
    const [restartAllSuccess, setRestartAllSuccess] = useState<string | null>(null);
    const [restartAllError, setRestartAllError] = useState<string | null>(null);

    const queryClient = useQueryClient();

    const {
        data: servicesData,
        isLoading,
        error,
    } = useQuery({
        queryKey: ["services"],
        queryFn: controlApi.fetchServices,
        refetchInterval: 10000,
    });

    const { data: configData } = useQuery({
        queryKey: ["config"],
        queryFn: controlApi.fetchConfig,
        enabled: showConfigEditor,
    });

    const [configContent, setConfigContent] = useState("");

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

    if (error) {
        return (
            <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                    Failed to load services. Check your API token and network connection.
                </AlertDescription>
            </Alert>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold">Service Control Panel</h1>
                    <p className="text-muted-foreground">
                        Manage Docker services, view logs, and configure the sandbox
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button
                        variant="secondary"
                        onClick={() => restartAllMutation.mutate()}
                        disabled={restartAllMutation.isPending}
                    >
                        <RotateCw className="mr-2 h-4 w-4" />
                        {restartAllMutation.isPending ? "Restarting..." : "Restart All Services"}
                    </Button>
                    <Button variant="outline" onClick={() => setShowConfigEditor(true)}>
                        <Save className="mr-2 h-4 w-4" /> Edit Config
                    </Button>
                    <Button variant="destructive" onClick={() => setShowResetDialog(true)}>
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

            {isLoading ? (
                <div>Loading services...</div>
            ) : servicesData ? (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {servicesData.services
                        .filter((service) => service.name !== "sui-localnet")
                        .map((service) => (
                            <ServiceCard key={service.name} service={service} />
                        ))}
                </div>
            ) : null}

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
