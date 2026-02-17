import http from "node:http";

export interface HealthStatus {
    status: "healthy" | "unhealthy";
    timestamp: string;
    uptime: number;
    details?: Record<string, unknown>;
}

export interface ReadinessStatus {
    ready: boolean;
    timestamp: string;
    checks: {
        balanceManager: boolean;
        pool: boolean;
    };
}

type HealthCheck = () => HealthStatus;
type ReadinessCheck = () => ReadinessStatus;

export class HealthServer {
    private server: http.Server | null = null;
    private startTime = Date.now();
    private healthCheck: HealthCheck;
    private readinessCheck: ReadinessCheck;

    constructor(healthCheck: HealthCheck, readinessCheck: ReadinessCheck) {
        this.healthCheck = healthCheck;
        this.readinessCheck = readinessCheck;
    }

    start(port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                const url = new URL(req.url || "/", `http://localhost:${port}`);

                if (url.pathname === "/health") {
                    const status = this.healthCheck();
                    res.writeHead(status.status === "healthy" ? 200 : 503, {
                        "Content-Type": "application/json",
                    });
                    res.end(JSON.stringify(status));
                } else if (url.pathname === "/ready") {
                    const status = this.readinessCheck();
                    res.writeHead(status.ready ? 200 : 503, {
                        "Content-Type": "application/json",
                    });
                    res.end(JSON.stringify(status));
                } else {
                    res.writeHead(404);
                    res.end("Not Found");
                }
            });

            this.server.on("error", reject);
            this.server.listen(port, () => {
                console.log(`  Health server listening on http://localhost:${port}`);
                resolve();
            });
        });
    }

    stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => resolve());
            } else {
                resolve();
            }
        });
    }

    getUptime(): number {
        return Date.now() - this.startTime;
    }
}
