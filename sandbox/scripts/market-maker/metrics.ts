import http from "node:http";

interface Metrics {
    ordersPlacedTotal: number;
    ordersCanceledTotal: number;
    rebalancesTotal: number;
    activeOrders: number;
    lastRebalanceTimestamp: number;
    errors: number;
}

const metrics: Metrics = {
    ordersPlacedTotal: 0,
    ordersCanceledTotal: 0,
    rebalancesTotal: 0,
    activeOrders: 0,
    lastRebalanceTimestamp: 0,
    errors: 0,
};

export interface MetricsUpdate {
    ordersPlaced?: number;
    ordersCanceled?: number;
    rebalance?: boolean;
    activeOrders?: number;
    error?: boolean;
}

export function updateMetrics(update: MetricsUpdate): void {
    if (update.ordersPlaced) {
        metrics.ordersPlacedTotal += update.ordersPlaced;
    }
    if (update.ordersCanceled) {
        metrics.ordersCanceledTotal += update.ordersCanceled;
    }
    if (update.rebalance) {
        metrics.rebalancesTotal += 1;
        metrics.lastRebalanceTimestamp = Date.now();
    }
    if (update.activeOrders !== undefined) {
        metrics.activeOrders = update.activeOrders;
    }
    if (update.error) {
        metrics.errors += 1;
    }
}

export function getMetrics(): Metrics {
    return { ...metrics };
}

function formatPrometheusMetrics(): string {
    const lines: string[] = [];

    lines.push("# HELP mm_orders_placed_total Total number of orders placed");
    lines.push("# TYPE mm_orders_placed_total counter");
    lines.push(`mm_orders_placed_total ${metrics.ordersPlacedTotal}`);

    lines.push("# HELP mm_orders_canceled_total Total number of orders canceled");
    lines.push("# TYPE mm_orders_canceled_total counter");
    lines.push(`mm_orders_canceled_total ${metrics.ordersCanceledTotal}`);

    lines.push("# HELP mm_rebalances_total Total number of rebalance cycles");
    lines.push("# TYPE mm_rebalances_total counter");
    lines.push(`mm_rebalances_total ${metrics.rebalancesTotal}`);

    lines.push("# HELP mm_active_orders Current number of active orders");
    lines.push("# TYPE mm_active_orders gauge");
    lines.push(`mm_active_orders ${metrics.activeOrders}`);

    lines.push("# HELP mm_last_rebalance_timestamp_seconds Timestamp of last rebalance");
    lines.push("# TYPE mm_last_rebalance_timestamp_seconds gauge");
    lines.push(
        `mm_last_rebalance_timestamp_seconds ${Math.floor(metrics.lastRebalanceTimestamp / 1000)}`,
    );

    lines.push("# HELP mm_errors_total Total number of errors");
    lines.push("# TYPE mm_errors_total counter");
    lines.push(`mm_errors_total ${metrics.errors}`);

    return lines.join("\n") + "\n";
}

export class MetricsServer {
    private server: http.Server | null = null;

    start(port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                const url = new URL(req.url || "/", `http://localhost:${port}`);

                if (url.pathname === "/metrics") {
                    res.writeHead(200, {
                        "Content-Type": "text/plain; version=0.0.4",
                    });
                    res.end(formatPrometheusMetrics());
                } else {
                    res.writeHead(404);
                    res.end("Not Found");
                }
            });

            this.server.on("error", reject);
            this.server.listen(port, () => {
                console.log(`  Metrics server listening on http://localhost:${port}`);
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
}
