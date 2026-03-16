import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "./config.js";
import * as docker from "./docker.js";
import { logAudit, getAuditLogs } from "./middleware.js";
import type {
    ServiceListResponse,
    ServiceActionResponse,
    LogsResponse,
    ConfigResponse,
    ConfigUpdateRequest,
    ResetResponse,
} from "./types.js";
import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";

export function createRoutes(config: Config) {
    const app = new Hono();

    // Health check
    app.get("/", (c) => {
        return c.json({ status: "ok", service: "control-api" });
    });

    // List all services
    app.get("/services", async (c) => {
        try {
            const services = await docker.listServices(config.COMPOSE_PROJECT_NAME);
            const response: ServiceListResponse = { services };
            return c.json(response);
        } catch (error) {
            logAudit({
                action: "LIST_SERVICES",
                success: false,
                message: error instanceof Error ? error.message : "Unknown error",
            });
            return c.json({ error: "Failed to list services" }, 500);
        }
    });

    // Start a service
    app.post("/services/:name/start", async (c) => {
        const serviceName = c.req.param("name");

        try {
            await docker.startService(config.COMPOSE_PROJECT_NAME, serviceName);
            logAudit({
                action: "START_SERVICE",
                service: serviceName,
                success: true,
            });

            const response: ServiceActionResponse = {
                success: true,
                message: `Service ${serviceName} started successfully`,
                service: serviceName,
            };
            return c.json(response);
        } catch (error) {
            logAudit({
                action: "START_SERVICE",
                service: serviceName,
                success: false,
                message: error instanceof Error ? error.message : "Unknown error",
            });
            return c.json(
                {
                    error: error instanceof Error ? error.message : "Failed to start service",
                },
                500,
            );
        }
    });

    // Stop a service
    app.post("/services/:name/stop", async (c) => {
        const serviceName = c.req.param("name");

        try {
            await docker.stopService(config.COMPOSE_PROJECT_NAME, serviceName);
            logAudit({
                action: "STOP_SERVICE",
                service: serviceName,
                success: true,
            });

            const response: ServiceActionResponse = {
                success: true,
                message: `Service ${serviceName} stopped successfully`,
                service: serviceName,
            };
            return c.json(response);
        } catch (error) {
            logAudit({
                action: "STOP_SERVICE",
                service: serviceName,
                success: false,
                message: error instanceof Error ? error.message : "Unknown error",
            });
            return c.json(
                {
                    error: error instanceof Error ? error.message : "Failed to stop service",
                },
                500,
            );
        }
    });

    // Restart a service
    app.post("/services/:name/restart", async (c) => {
        const serviceName = c.req.param("name");

        try {
            await docker.restartService(config.COMPOSE_PROJECT_NAME, serviceName);
            logAudit({
                action: "RESTART_SERVICE",
                service: serviceName,
                success: true,
            });

            const response: ServiceActionResponse = {
                success: true,
                message: `Service ${serviceName} restarted successfully`,
                service: serviceName,
            };
            return c.json(response);
        } catch (error) {
            logAudit({
                action: "RESTART_SERVICE",
                service: serviceName,
                success: false,
                message: error instanceof Error ? error.message : "Unknown error",
            });
            return c.json(
                {
                    error: error instanceof Error ? error.message : "Failed to restart service",
                },
                500,
            );
        }
    });

    // Get service logs
    app.get("/services/:name/logs", async (c) => {
        const serviceName = c.req.param("name");
        const linesParam = c.req.query("lines");
        const lines = linesParam ? parseInt(linesParam, 10) : 100;

        if (isNaN(lines) || lines < 1 || lines > 10000) {
            return c.json({ error: "Invalid lines parameter (must be 1-10000)" }, 400);
        }

        try {
            const logs = await docker.getServiceLogs(config.COMPOSE_PROJECT_NAME, serviceName, lines);

            const response: LogsResponse = {
                logs,
                service: serviceName,
                lines,
            };
            return c.json(response);
        } catch (error) {
            logAudit({
                action: "GET_LOGS",
                service: serviceName,
                success: false,
                message: error instanceof Error ? error.message : "Unknown error",
            });
            return c.json(
                {
                    error: error instanceof Error ? error.message : "Failed to get logs",
                },
                500,
            );
        }
    });

    // Restart all services
    app.post("/services/restart-all", async (c) => {
        try {
            await docker.restartAllServices(config.COMPOSE_PROJECT_NAME);
            logAudit({
                action: "RESTART_ALL_SERVICES",
                success: true,
            });

            const response: ServiceActionResponse = {
                success: true,
                message: "All services restarted successfully",
            };
            return c.json(response);
        } catch (error) {
            logAudit({
                action: "RESTART_ALL_SERVICES",
                success: false,
                message: error instanceof Error ? error.message : "Unknown error",
            });
            return c.json(
                {
                    error: error instanceof Error ? error.message : "Failed to restart all services",
                },
                500,
            );
        }
    });

    // Reset environment
    app.post("/reset", async (c) => {
        try {
            await docker.resetEnvironment(config.COMPOSE_PROJECT_NAME);
            logAudit({
                action: "RESET_ENVIRONMENT",
                success: true,
            });

            const response: ResetResponse = {
                success: true,
                message: "Environment reset successfully. All containers and volumes removed.",
            };
            return c.json(response);
        } catch (error) {
            logAudit({
                action: "RESET_ENVIRONMENT",
                success: false,
                message: error instanceof Error ? error.message : "Unknown error",
            });
            return c.json(
                {
                    error: error instanceof Error ? error.message : "Failed to reset environment",
                },
                500,
            );
        }
    });

    // Get .env config
    app.get("/config", async (c) => {
        try {
            const envPath = resolve(process.cwd(), ".env");
            const content = await readFile(envPath, "utf-8");

            const response: ConfigResponse = { content };
            return c.json(response);
        } catch (error) {
            logAudit({
                action: "GET_CONFIG",
                success: false,
                message: error instanceof Error ? error.message : "Unknown error",
            });
            return c.json(
                {
                    error: error instanceof Error ? error.message : "Failed to read config",
                },
                500,
            );
        }
    });

    // Update .env config
    const updateConfigSchema = z.object({
        content: z.string().min(1, "Config content cannot be empty"),
    });

    app.put("/config", async (c) => {
        try {
            const body = await c.req.json();
            const validated = updateConfigSchema.parse(body);

            const envPath = resolve(process.cwd(), ".env");

            // Create backup
            const backupPath = resolve(process.cwd(), `.env.backup.${Date.now()}`);
            const currentContent = await readFile(envPath, "utf-8");
            await writeFile(backupPath, currentContent, "utf-8");

            // Write new config
            await writeFile(envPath, validated.content, "utf-8");

            logAudit({
                action: "UPDATE_CONFIG",
                success: true,
                message: `Backup created at ${backupPath}`,
            });

            return c.json({
                success: true,
                message: "Config updated successfully",
                backup: backupPath,
            });
        } catch (error) {
            logAudit({
                action: "UPDATE_CONFIG",
                success: false,
                message: error instanceof Error ? error.message : "Unknown error",
            });

            if (error instanceof z.ZodError) {
                return c.json({ error: "Invalid request", details: error.errors }, 400);
            }

            return c.json(
                {
                    error: error instanceof Error ? error.message : "Failed to update config",
                },
                500,
            );
        }
    });

    // Get audit logs
    app.get("/audit", async (c) => {
        const limitParam = c.req.query("limit");
        const limit = limitParam ? parseInt(limitParam, 10) : 100;

        if (isNaN(limit) || limit < 1 || limit > 1000) {
            return c.json({ error: "Invalid limit parameter (must be 1-1000)" }, 400);
        }

        const logs = getAuditLogs(limit);
        return c.json({ logs });
    });

    return app;
}
