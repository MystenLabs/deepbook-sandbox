// The retired `sandbox/api` contract as a devstack service member (SEDEFI-456)
// — the minimal surface the old trading dashboard still calls through its
// `/api` catch-all dev-server proxy:
//
//   GET  /          → service info (the health page's "API" check)
//   GET  /manifest  → deployments/mainnet-fork.json verbatim (the dashboard's
//                     fork-manifest adapter does the shaping client-side)
//   POST /faucet    → { address, token: 'SUI'|'DEEP'|'USDC' } → { success }
//
// Why in-process instead of proxying the devstack dashboard's GraphQL `fund`
// mutation: the mutation cannot route SUI on a fork ("no SUI faucet strategy
// registered for chain …" — observed live), while `deps.sui`'s
// fundingFaucetStrategy and the DEEP/USDC members' exported strategies work
// plugin-side. This is the `POST /faucet` thin-proxy decision from
// faucet-dashboard-integration.md, hosted where the strategies actually live.
//
// The listener binds 127.0.0.1:9009 — the port the old sandbox/api used, so
// the dashboard's existing proxy default keeps working unchanged.

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { definePlugin, type sui } from "@mysten-incubation/devstack";

import { memberError } from "./container-util.ts";
import type { deepFundingFromWhale } from "./deep-funding.ts";
import { suiGrantViaWhale, type FullCore } from "./fork-sui-grant.ts";
import type { usdcFundingFromCapOwner } from "./usdc-funding.ts";

const MEMBER = "sandbox-api";
const fail = memberError(MEMBER);

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST_PATH = resolve(HERE, "..", "deployments", "mainnet-fork.json");
const DEFAULT_PORT = 9009;

/** Fixed per-request faucet grants (base units) — sized for trading-page
 *  testing, well inside every strategy's per-request cap. */
const GRANTS: Record<string, bigint> = {
    SUI: 10_000_000_000n, // 10 SUI (faucet strategy — normally absent on forks)
    DEEP: 1_000_000_000n, // 1000 DEEP (6 dp)
    USDC: 1_000_000_000n, // 1000 USDC (6 dp)
};
/** SUI grant via the impersonated donor (fork-sui-grant.ts — the fork faucet
 *  strategy is structurally null, so this is the path that actually runs).
 *  Sized against that donor's ~5.5k SUI coin, so ~54 grants per fork. */
const SUI_WHALE_GRANT_MIST = 100_000_000_000n; // 100 SUI

const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolveBody, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });

const json = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
};

/** Human-readable message out of a devstack faucet/funding error (tagged
 *  shapes carry `message`; anything else stringifies). */
const strategyErrorMessage = (cause: unknown): string => {
    const message = (cause as { message?: unknown } | undefined)?.message;
    return typeof message === "string" ? message : String(cause).slice(0, 300);
};

export type SandboxApiOptions = {
    sui: ReturnType<typeof sui>;
    deepFunding: ReturnType<typeof deepFundingFromWhale>;
    usdcFunding: ReturnType<typeof usdcFundingFromCapOwner>;
    /** listener port (default 9009 — the retired sandbox/api port the
     *  dashboard proxy still targets; env SANDBOX_API_PORT). */
    port?: number;
    manifestPath?: string;
};

export function sandboxApiMember(opts: SandboxApiOptions) {
    const port = Number(process.env.SANDBOX_API_PORT ?? opts.port ?? DEFAULT_PORT);
    const manifestPath = opts.manifestPath ?? DEFAULT_MANIFEST_PATH;

    return definePlugin({
        id: MEMBER,
        role: "service",
        section: "service",
        dependsOn: { sui: opts.sui, deepFunding: opts.deepFunding, usdcFunding: opts.usdcFunding },
        start: (deps) =>
            Effect.gen(function* () {
                const chainId = deps.sui.chainId;
                const suiFaucet = deps.sui.fundingFaucetStrategy;
                const fullCore = deps.sui.sdk.client.core as unknown as FullCore;

                /** token → funding Effect. SUI rides devstack's fork faucet
                 *  strategy when present, else a small whale grant
                 *  (fork-sui-grant.ts); DEEP/USDC ride the members' exported
                 *  strategies. All are R-free Effects, so runPromise is safe. */
                const fund = (token: string, address: string) => {
                    const amount = GRANTS[token];
                    if (amount === undefined) return null;
                    if (token === "SUI") {
                        if (suiFaucet !== null) return suiFaucet.request({ address, amount });
                        return Effect.tryPromise({
                            try: () => suiGrantViaWhale(fullCore, address, SUI_WHALE_GRANT_MIST),
                            catch: (cause) => ({
                                message: String((cause as { message?: string }).message ?? cause),
                            }),
                        });
                    }
                    const strategy =
                        token === "DEEP" ? deps.deepFunding.strategy : deps.usdcFunding.strategy;
                    return strategy.request({ address, amount });
                };

                const handler = async (req: IncomingMessage, res: ServerResponse) => {
                    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
                    try {
                        if (req.method === "GET" && url.pathname === "/") {
                            return json(res, 200, {
                                service: "deepbook sandbox - api (devstack member)",
                                network: "fork",
                                chainId,
                            });
                        }
                        if (req.method === "GET" && url.pathname === "/manifest") {
                            const raw = await readFile(manifestPath, "utf8");
                            res.writeHead(200, { "content-type": "application/json" });
                            return res.end(raw);
                        }
                        if (req.method === "POST" && url.pathname === "/faucet") {
                            const body = JSON.parse((await readBody(req)) || "{}") as {
                                address?: string;
                                token?: string;
                            };
                            const address = body.address?.trim();
                            const token = body.token?.trim().toUpperCase();
                            if (!address || !token) {
                                return json(res, 400, {
                                    success: false,
                                    error: "address and token are required",
                                });
                            }
                            const effect = fund(token, address);
                            if (effect === null) {
                                return json(res, 400, {
                                    success: false,
                                    error: `unknown token ${token} (SUI|DEEP|USDC)`,
                                });
                            }
                            try {
                                await Effect.runPromise(
                                    effect as Effect.Effect<unknown, unknown, never>,
                                );
                                return json(res, 200, { success: true });
                            } catch (cause) {
                                return json(res, 502, {
                                    success: false,
                                    error: strategyErrorMessage(cause),
                                });
                            }
                        }
                        return json(res, 404, { error: "not found" });
                    } catch (cause) {
                        return json(res, 500, { error: String(cause).slice(0, 300) });
                    }
                };

                const server = yield* Effect.acquireRelease(
                    Effect.tryPromise({
                        try: () =>
                            new Promise<Server>((resolveServer, reject) => {
                                const s = createServer((req, res) => {
                                    void handler(req, res);
                                });
                                s.once("error", reject);
                                s.listen(port, "127.0.0.1", () => {
                                    s.off("error", reject);
                                    resolveServer(s);
                                });
                            }),
                        catch: (cause) => fail("listen", `could not bind 127.0.0.1:${port}`, cause),
                    }),
                    (s) => Effect.promise(() => new Promise<void>((r) => s.close(() => r()))),
                );
                // Keep the reference alive for the scope's lifetime.
                void server;

                return { url: `http://127.0.0.1:${port}`, port, manifestPath };
            }),
    });
}
