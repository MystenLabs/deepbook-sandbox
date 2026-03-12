import http from "http";
import { describe, test, expect, afterEach, vi } from "vitest";
import {
    createInitialStatus,
    createStatusServer,
    updateStatus,
} from "../../oracle-service/status-server";
import { makeSuiPriceData, makeDeepPriceData, makeUsdcPriceData } from "./fixtures";

vi.mock("../../utils/logger", () => ({
    default: {
        success: vi.fn(),
    },
}));

let server: http.Server | null = null;

afterEach(async () => {
    if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
    }
});

function getPort(srv: http.Server): number {
    const addr = srv.address();
    if (typeof addr === "object" && addr) return addr.port;
    throw new Error("Server not listening");
}

function waitForListen(srv: http.Server): Promise<void> {
    return new Promise((resolve) => {
        if (srv.listening) {
            resolve();
        } else {
            srv.on("listening", resolve);
        }
    });
}

async function httpGet(
    url: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                resolve({
                    status: res.statusCode!,
                    headers: res.headers,
                    body: JSON.parse(data),
                });
            });
        }).on("error", reject);
    });
}

async function httpRequest(
    url: string,
    method: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const req = http.request(
            {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port,
                path: parsedUrl.pathname,
                method,
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    resolve({
                        status: res.statusCode!,
                        headers: res.headers,
                        body: JSON.parse(data),
                    });
                });
            },
        );
        req.on("error", reject);
        req.end();
    });
}

describe("status server", () => {
    describe("routing", () => {
        test("GET / returns 200 with correct JSON structure", async () => {
            const status = createInitialStatus();
            server = createStatusServer(0, status);
            await waitForListen(server);

            const res = await httpGet(`http://localhost:${getPort(server)}/`);

            expect(res.status).toBe(200);
            expect(res.body.status).toBe("ok");
            expect(res.body.updates).toBe(0);
            expect(res.body.errors).toBe(0);
            expect(res.body.lastUpdate).toBeNull();
            expect(res.body.prices.sui).toBeNull();
            expect(res.body.prices.deep).toBeNull();
            expect(res.body.prices.usdc).toBeNull();
        });

        test("GET /status returns same response", async () => {
            const status = createInitialStatus();
            server = createStatusServer(0, status);
            await waitForListen(server);

            const res = await httpGet(`http://localhost:${getPort(server)}/status`);

            expect(res.status).toBe(200);
            expect(res.body.status).toBe("ok");
        });

        test("GET /other returns 404", async () => {
            const status = createInitialStatus();
            server = createStatusServer(0, status);
            await waitForListen(server);

            const res = await httpGet(`http://localhost:${getPort(server)}/other`);

            expect(res.status).toBe(404);
            expect(res.body.error).toBe("Not Found");
        });

        test("POST / returns 405 with Allow header", async () => {
            const status = createInitialStatus();
            server = createStatusServer(0, status);
            await waitForListen(server);

            const res = await httpRequest(`http://localhost:${getPort(server)}/`, "POST");

            expect(res.status).toBe(405);
            expect(res.body.error).toBe("Method Not Allowed");
            expect(res.headers.allow).toBe("GET");
        });
    });

    describe("status updates", () => {
        test("reflects updated prices in response", async () => {
            const status = createInitialStatus();
            server = createStatusServer(0, status);
            await waitForListen(server);

            // Update status with price data
            updateStatus(status, makeSuiPriceData(), makeDeepPriceData(), makeUsdcPriceData());
            status.updateCount = 1;

            const res = await httpGet(`http://localhost:${getPort(server)}/`);

            expect(res.body.updates).toBe(1);
            expect(res.body.prices.sui).toBe("$3.45000000");
            expect(res.body.prices.deep).toBe("$0.02000000");
            expect(res.body.prices.usdc).toBe("$1.00000000");
            expect(res.body.lastUpdate).not.toBeNull();
        });
    });

    describe("high-frequency queries", () => {
        test("handles 100 parallel requests without errors", async () => {
            const status = createInitialStatus();
            server = createStatusServer(0, status);
            await waitForListen(server);

            const port = getPort(server);
            const requests = Array.from({ length: 100 }, () =>
                httpGet(`http://localhost:${port}/`),
            );

            const responses = await Promise.all(requests);

            for (const res of responses) {
                expect(res.status).toBe(200);
            }
        });
    });
});
