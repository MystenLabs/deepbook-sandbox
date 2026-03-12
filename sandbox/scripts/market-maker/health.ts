import http from "node:http";
import log from "../utils/logger";

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
        pools: number;
    };
}

export interface PoolOrdersResponse {
    pair: string;
    poolId: string;
    midPrice: number | null;
    orders: {
        orderId: string;
        price: number;
        quantity: number;
        isBid: boolean;
    }[];
}

export interface OrdersResponse {
    pools: PoolOrdersResponse[];
    config: {
        spreadBps: number;
        levelsPerSide: number;
        levelSpacingBps: number;
    };
}

type HealthCheck = () => HealthStatus;
type ReadinessCheck = () => ReadinessStatus;
type OrdersProvider = () => OrdersResponse;

export class HealthServer {
    private server: http.Server | null = null;
    private startTime = Date.now();
    private healthCheck: HealthCheck;
    private readinessCheck: ReadinessCheck;
    private ordersProvider: OrdersProvider;

    constructor(
        healthCheck: HealthCheck,
        readinessCheck: ReadinessCheck,
        ordersProvider: OrdersProvider,
    ) {
        this.healthCheck = healthCheck;
        this.readinessCheck = readinessCheck;
        this.ordersProvider = ordersProvider;
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
                } else if (url.pathname === "/orders") {
                    const data = this.ordersProvider();
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(data));
                } else {
                    res.writeHead(404);
                    res.end("Not Found");
                }
            });

            this.server.on("error", reject);
            this.server.listen(port, () => {
                log.success(`Health server: http://localhost:${port}`);
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
