import { exec } from "child_process";
import { promisify } from "util";
import type { ServiceInfo } from "./types.js";

const execAsync = promisify(exec);

// Default timeout for docker commands (30 seconds)
const DEFAULT_TIMEOUT_MS = 30000;

// Wrapper to add timeout to execAsync calls
async function execWithTimeout(
    command: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    return Promise.race([execAsync(command), timeoutPromise]);
}

// Allowlist of services that can be controlled
const ALLOWED_SERVICES = [
    "postgres",
    "deepbook-postgres",
    "deepbook-market-maker",
    "market-maker",
    "deepbook-faucet",
    "oracle-service",
    "deepbook-indexer",
    "deepbook-server",
    "dashboard",
    "sui-localnet",
];

// Map container names to service names (docker-compose needs service names)
const CONTAINER_TO_SERVICE_MAP: Record<string, string> = {
    "deepbook-market-maker": "market-maker",
    "deepbook-postgres": "postgres",
    "deepbook-faucet": "deepbook-faucet",
    "oracle-service": "oracle-service",
    "deepbook-indexer": "deepbook-indexer",
    "deepbook-server": "deepbook-server",
    "deepbook-dashboard": "dashboard",
    "sui-localnet": "sui-localnet",
};

export function validateServiceName(serviceName: string): void {
    if (!ALLOWED_SERVICES.includes(serviceName)) {
        throw new Error(`Service '${serviceName}' is not in the allowlist`);
    }
}

function getServiceName(nameOrContainer: string): string {
    return CONTAINER_TO_SERVICE_MAP[nameOrContainer] || nameOrContainer;
}

export async function listServices(projectName: string): Promise<ServiceInfo[]> {
    try {
        const { stdout } = await execWithTimeout(
            `docker-compose -p ${projectName} ps --all --format json`,
        );

        const lines = stdout.trim().split("\n").filter(Boolean);
        const services: ServiceInfo[] = [];

        for (const line of lines) {
            try {
                const data = JSON.parse(line);
                // Filter out control-api and dashboard from the service list
                if (data.Service === "control-api" || data.Service === "dashboard") {
                    continue;
                }
                services.push({
                    name: data.Service,
                    status: data.State === "running" ? "running" : "stopped",
                    uptime: data.Status || undefined,
                    ports:
                        data.Publishers?.map((p: { PublishedPort: number }) =>
                            p.PublishedPort?.toString(),
                        ).filter(Boolean) || [],
                    image: data.Image || undefined,
                });
            } catch (parseErr) {
                console.error("Failed to parse service line:", line, parseErr);
            }
        }

        return services;
    } catch (error) {
        console.error("Failed to list services:", error);
        throw new Error("Failed to list Docker services");
    }
}

export async function startService(projectName: string, serviceName: string): Promise<void> {
    validateServiceName(serviceName);
    const actualServiceName = getServiceName(serviceName);
    try {
        await execWithTimeout(`docker-compose -p ${projectName} start ${actualServiceName}`);
    } catch (error) {
        console.error(`Failed to start service ${serviceName}:`, error);
        throw new Error(`Failed to start service ${serviceName}`);
    }
}

export async function stopService(projectName: string, serviceName: string): Promise<void> {
    validateServiceName(serviceName);
    const actualServiceName = getServiceName(serviceName);
    try {
        await execWithTimeout(`docker-compose -p ${projectName} stop ${actualServiceName}`);
    } catch (error) {
        console.error(`Failed to stop service ${serviceName}:`, error);
        throw new Error(`Failed to stop service ${serviceName}`);
    }
}

export async function restartService(projectName: string, serviceName: string): Promise<void> {
    validateServiceName(serviceName);
    const actualServiceName = getServiceName(serviceName);
    try {
        await execWithTimeout(`docker-compose -p ${projectName} restart ${actualServiceName}`);
    } catch (error) {
        console.error(`Failed to restart service ${serviceName}:`, error);
        throw new Error(`Failed to restart service ${serviceName}`);
    }
}

export async function getServiceLogs(
    projectName: string,
    serviceName: string,
    lines: number = 100,
): Promise<string> {
    validateServiceName(serviceName);
    const actualServiceName = getServiceName(serviceName);
    const command = `docker-compose -p ${projectName} logs --tail ${lines} ${actualServiceName}`;
    console.log(
        `[getServiceLogs] serviceName=${serviceName}, actualServiceName=${actualServiceName}`,
    );
    console.log(`[getServiceLogs] executing: ${command}`);
    try {
        const { stdout, stderr } = await execWithTimeout(command);
        console.log(
            `[getServiceLogs] stdout length: ${stdout.length}, stderr length: ${stderr.length}`,
        );
        if (stderr) {
            console.log(`[getServiceLogs] stderr: ${stderr}`);
        }
        return stdout;
    } catch (error) {
        console.error(`Failed to get logs for ${serviceName}:`, error);
        throw new Error(`Failed to get logs for service ${serviceName}`);
    }
}

export async function restartAllServices(projectName: string): Promise<void> {
    try {
        // Get list of running services first
        const services = await listServices(projectName);
        const serviceNames = services
            .filter(
                (s) =>
                    s.name !== "control-api" && s.name !== "dashboard" && s.name !== "sui-localnet",
            )
            .map((s) => s.name);

        if (serviceNames.length === 0) {
            return;
        }

        // Restart all services at once (use longer timeout for multiple services)
        await execWithTimeout(
            `docker-compose -p ${projectName} restart ${serviceNames.join(" ")}`,
            60000, // 60 seconds for restarting multiple services
        );
    } catch (error) {
        console.error("Failed to restart all services:", error);
        throw new Error("Failed to restart all services");
    }
}

export async function resetEnvironment(projectName: string): Promise<void> {
    try {
        // Get list of services first
        const services = await listServices(projectName);
        const serviceNames = services
            .filter(
                (s) =>
                    s.name !== "control-api" && s.name !== "dashboard" && s.name !== "sui-localnet",
            )
            .map((s) => s.name);

        if (serviceNames.length === 0) {
            return;
        }

        // Stop services (exclude control-api, dashboard, and sui-localnet)
        await execWithTimeout(
            `docker-compose -p ${projectName} stop ${serviceNames.join(" ")}`,
            60000, // 60 seconds for stopping services
        );
    } catch (error) {
        console.error("Failed to reset environment:", error);
        throw new Error("Failed to reset environment");
    }
}
