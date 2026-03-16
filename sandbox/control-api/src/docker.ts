import { exec } from "child_process";
import { promisify } from "util";
import type { ServiceInfo } from "./types.js";

const execAsync = promisify(exec);

// Allowlist of services that can be controlled
const ALLOWED_SERVICES = [
    "sui-localnet",
    "postgres",
    "deepbook-postgres",
    "deepbook-market-maker",
    "market-maker",
    "deepbook-faucet",
    "oracle-service",
    "deepbook-indexer",
    "deepbook-server",
    "dashboard",
];

export function validateServiceName(serviceName: string): void {
    if (!ALLOWED_SERVICES.includes(serviceName)) {
        throw new Error(`Service '${serviceName}' is not in the allowlist`);
    }
}

export async function listServices(projectName: string): Promise<ServiceInfo[]> {
    try {
        const { stdout } = await execAsync(
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
                    ports: data.Publishers?.map((p: { PublishedPort: number }) =>
                        p.PublishedPort?.toString()
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
    try {
        await execAsync(`docker-compose -p ${projectName} start ${serviceName}`);
    } catch (error) {
        console.error(`Failed to start service ${serviceName}:`, error);
        throw new Error(`Failed to start service ${serviceName}`);
    }
}

export async function stopService(projectName: string, serviceName: string): Promise<void> {
    validateServiceName(serviceName);
    try {
        await execAsync(`docker-compose -p ${projectName} stop ${serviceName}`);
    } catch (error) {
        console.error(`Failed to stop service ${serviceName}:`, error);
        throw new Error(`Failed to stop service ${serviceName}`);
    }
}

export async function restartService(projectName: string, serviceName: string): Promise<void> {
    validateServiceName(serviceName);
    try {
        await execAsync(`docker-compose -p ${projectName} restart ${serviceName}`);
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
    try {
        const { stdout } = await execAsync(
            `docker-compose -p ${projectName} logs --tail ${lines} ${serviceName}`,
        );
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
            .filter(s => s.name !== "control-api" && s.name !== "dashboard")
            .map(s => s.name);

        if (serviceNames.length === 0) {
            return;
        }

        // Restart all services at once
        await execAsync(`docker-compose -p ${projectName} restart ${serviceNames.join(" ")}`);
    } catch (error) {
        console.error("Failed to restart all services:", error);
        throw new Error("Failed to restart all services");
    }
}

export async function resetEnvironment(projectName: string): Promise<void> {
    try {
        // Stop all services
        await execAsync(`docker-compose -p ${projectName} down -v`);
    } catch (error) {
        console.error("Failed to reset environment:", error);
        throw new Error("Failed to reset environment");
    }
}
