// The old trading dashboard (sandbox/dashboard, retired with compose in
// DBSF-022) as a devstack service member (SEDEFI-456): spawns the Vite dev
// server as a supervised host process with wiring resolved from devstack
// state — the brokered fork RPC port, the server/sandbox-api URLs, and a
// pre-funded dev-wallet key — instead of the hardcoded localnet ports the
// compose stack relied on.
//
// Why definePlugin and not devstack's hostService: hostService env is static
// (no dep injection), but the RPC proxy target must be
// `deps.sui.hostGateway.rpcUrl` (the ACTUAL brokered host port — never
// hardcode 51002) and the wallet key funding needs the DEEP/USDC strategies.
//
// The dev-wallet key is generated once and persisted (gitignored) so browser
// state (BalanceManager discovery, order history) survives supervisor
// restarts; a fork wipe invalidates nothing here — balances are re-checked
// and topped up on every boot.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Effect } from "effect";
import { definePlugin, Probes, ProcessSupervisor, type sui } from "@mysten-incubation/devstack";

import { memberError } from "./container-util.ts";
import type { deepFundingFromWhale } from "./deep-funding.ts";
import { suiGrantViaWhale, type FullCore } from "./fork-sui-grant.ts";
import type { registryInitMember } from "./registry-init.ts";
import type { sandboxApiMember } from "./sandbox-api.ts";
import type { serverMember } from "./server-member.ts";
import type { usdcFundingFromCapOwner } from "./usdc-funding.ts";

const MEMBER = "trading-dashboard";
const fail = memberError(MEMBER);

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = resolve(HERE, "..", "dashboard");
/** Persisted dev-wallet key (gitignored). */
const KEY_STATE_PATH = resolve(HERE, ".trading-dashboard-key.json");

const DEFAULT_PORT = 5173;
const READY_TIMEOUT_MS = 120_000;
/** `pnpm install` on a cold checkout downloads the dashboard's full tree. */
const INSTALL_TIMEOUT_MS = 600_000;

/** Boot-time funding targets (base units) — enough for exercising the whole
 *  trading loop; the faucet page covers anything beyond. Top-ups fire when a
 *  balance is below its target. */
const FUND_TARGETS: ReadonlyArray<{ symbol: string; typeSuffix: string; amount: bigint }> = [
    { symbol: "SUI", typeSuffix: "::sui::SUI>", amount: 10_000_000_000n }, // 10 SUI (faucet)
    { symbol: "DEEP", typeSuffix: "::deep::DEEP>", amount: 10_000_000_000n }, // 10k DEEP
    { symbol: "USDC", typeSuffix: "::usdc::USDC>", amount: 10_000_000_000n }, // 10k USDC
];

/** The fork faucet strategy is structurally null (fork-sui-grant.ts), so on a
 *  fork SUI comes from the impersonated donor — this, not the FUND_TARGETS
 *  entry above, is the number that actually runs here. It used to be a token
 *  0.15 SUI because the old donor held ~0.7 SUI in total; the donor now holds
 *  ~5.5k SUI, so the wallet can start with enough to trade (a 10-DEEP market
 *  buy costs ~0.23 SUI) instead of needing a faucet trip first. Matches the
 *  faucet's per-request grant; ~54 boots per fork, and a wipe restores it. */
const SUI_WHALE_TARGET_MIST = 100_000_000_000n; // 100 SUI

type DashboardCore = {
    getObject: (args: {
        objectId: string;
        include?: { content?: boolean };
    }) => Promise<{ object?: { content?: Uint8Array } }>;
    listOwnedObjects: (args: {
        owner: string;
    }) => Promise<{ objects?: { objectId: string; type?: string }[] }>;
};

/** Coin<T> balance from BCS content: u64 LE right after the 32-byte UID. */
const coinBalanceFromContent = (content: Uint8Array | undefined): bigint => {
    if (!content || content.length < 40) return 0n;
    return new DataView(content.buffer, content.byteOffset + 32, 8).getBigUint64(0, true);
};

/** Sum the owner's fork-local Coin<T> balances for a type suffix. Only
 *  fork-local coins are enumerable — which is exactly what a faucet-funded
 *  wallet holds. */
const ownedCoinTotal = async (
    core: DashboardCore,
    owner: string,
    typeSuffix: string,
): Promise<bigint> => {
    const owned = await core.listOwnedObjects({ owner }).catch(() => ({ objects: [] }));
    let total = 0n;
    for (const o of owned.objects ?? []) {
        const type = String(o.type ?? "");
        if (!type.includes("::coin::Coin<") || !type.endsWith(typeSuffix)) continue;
        const res = await core
            .getObject({ objectId: o.objectId, include: { content: true } })
            .catch(() => null);
        total += coinBalanceFromContent(res?.object?.content);
    }
    return total;
};

/** Load-or-create the persisted dev-wallet keypair. */
const loadOrCreateKey = (): { privateKey: string; address: string } => {
    if (existsSync(KEY_STATE_PATH)) {
        const saved = JSON.parse(readFileSync(KEY_STATE_PATH, "utf8")) as {
            privateKey?: string;
        };
        if (saved.privateKey) {
            const { secretKey } = decodeSuiPrivateKey(saved.privateKey);
            const kp = Ed25519Keypair.fromSecretKey(secretKey);
            return { privateKey: saved.privateKey, address: kp.getPublicKey().toSuiAddress() };
        }
    }
    const kp = new Ed25519Keypair();
    const state = {
        privateKey: kp.getSecretKey(),
        address: kp.getPublicKey().toSuiAddress(),
    };
    writeFileSync(KEY_STATE_PATH, JSON.stringify(state, null, 4) + "\n");
    return state;
};

const pipeChildLogs = (child: ProcessSupervisor.ManagedProcessChild): void => {
    for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        createInterface({ input: stream }).on("line", (line) => {
            if (line.trim().length > 0) console.error(`[${MEMBER}] ${line}`);
        });
    }
};

export type TradingDashboardOptions = {
    sui: ReturnType<typeof sui>;
    deepFunding: ReturnType<typeof deepFundingFromWhale>;
    usdcFunding: ReturnType<typeof usdcFundingFromCapOwner>;
    sandboxApi: ReturnType<typeof sandboxApiMember>;
    /** REST server — proxied at /api/deepbook; also an ordering edge. */
    server: ReturnType<typeof serverMember>;
    /** ordering only: the BM map must exist before a user can create a BM. */
    registryInit: ReturnType<typeof registryInitMember>;
    /** dev-server port (default 5173; env TRADING_DASHBOARD_PORT). */
    port?: number;
};

export function tradingDashboardMember(opts: TradingDashboardOptions) {
    const port = Number(process.env.TRADING_DASHBOARD_PORT ?? opts.port ?? DEFAULT_PORT);

    return definePlugin({
        id: MEMBER,
        role: "service",
        section: "service",
        dependsOn: {
            sui: opts.sui,
            deepFunding: opts.deepFunding,
            usdcFunding: opts.usdcFunding,
            sandboxApi: opts.sandboxApi,
            server: opts.server,
            registryInit: opts.registryInit,
        },
        start: (deps) =>
            Effect.gen(function* () {
                if (!existsSync(join(DASHBOARD_DIR, "package.json"))) {
                    return yield* Effect.fail(
                        fail("layout", `no dashboard package at ${DASHBOARD_DIR}`),
                    );
                }
                // The FULL client's core — NOT the narrow sdk.core shim,
                // which lacks listOwnedObjects (calling a missing method
                // there kills the whole supervisor, observed live).
                const core = deps.sui.sdk.client.core as unknown as DashboardCore;

                // --- dev-wallet key: load/create, then top up via the funding
                // strategies (SUI: faucet when present, else a small whale
                // grant). Failures warn instead of failing the member — the
                // dashboard is still useful with a partially funded wallet.
                const key = loadOrCreateKey();
                const suiFaucet = deps.sui.fundingFaucetStrategy;
                for (const target of FUND_TARGETS) {
                    const have = yield* Effect.promise(() =>
                        ownedCoinTotal(core, key.address, target.typeSuffix),
                    );
                    const wanted =
                        target.symbol === "SUI" && suiFaucet === null
                            ? SUI_WHALE_TARGET_MIST
                            : target.amount;
                    if (have >= wanted) continue;
                    const shortfall = wanted - have;
                    let request: Effect.Effect<unknown, unknown>;
                    if (target.symbol === "SUI") {
                        request =
                            suiFaucet?.request({ address: key.address, amount: shortfall }) ??
                            Effect.tryPromise({
                                try: () =>
                                    suiGrantViaWhale(
                                        core as unknown as FullCore,
                                        key.address,
                                        shortfall,
                                    ),
                                catch: (cause) => cause,
                            });
                    } else if (target.symbol === "DEEP") {
                        request = deps.deepFunding.strategy.request({
                            address: key.address,
                            amount: shortfall,
                        });
                    } else {
                        request = deps.usdcFunding.strategy.request({
                            address: key.address,
                            amount: shortfall,
                        });
                    }
                    yield* request.pipe(
                        Effect.catch((cause) =>
                            Effect.sync(() =>
                                console.error(
                                    `[${MEMBER}] ${target.symbol} funding failed (continuing): ` +
                                        String(
                                            (cause as { message?: string }).message ?? cause,
                                        ).slice(0, 200),
                                ),
                            ),
                        ),
                    );
                }

                // --- one-time install on a cold checkout ---------------------
                if (!existsSync(join(DASHBOARD_DIR, "node_modules"))) {
                    console.error(`[${MEMBER}] node_modules missing — running pnpm install`);
                    const install = ProcessSupervisor.nodeProcessSpawner("pnpm", ["install"], {
                        cwd: DASHBOARD_DIR,
                        env: process.env,
                        stdio: "pipe",
                    });
                    pipeChildLogs(install);
                    const status = yield* Effect.tryPromise({
                        try: () =>
                            ProcessSupervisor.waitForProcessExitOrTimeout(
                                install,
                                INSTALL_TIMEOUT_MS,
                            ),
                        catch: (cause) => fail("install", "pnpm install crashed", cause),
                    });
                    if (status === null || status.code !== 0) {
                        return yield* Effect.fail(
                            fail(
                                "install",
                                status === null
                                    ? `pnpm install did not finish within ${INSTALL_TIMEOUT_MS}ms`
                                    : `pnpm install exited ${ProcessSupervisor.describeProcessExitStatus(status)}`,
                            ),
                        );
                    }
                }

                // --- spawn vite with dep-resolved wiring ---------------------
                // hostGateway.rpcUrl is container-facing (host.docker.internal
                // — resolvable inside containers, ENOTFOUND on the host); the
                // vite proxy runs ON the host, so rewrite to loopback.
                const rpcUrl = new URL(deps.sui.hostGateway.rpcUrl);
                if (rpcUrl.hostname === "host.docker.internal") rpcUrl.hostname = "127.0.0.1";
                const env: NodeJS.ProcessEnv = {
                    ...process.env,
                    PRIVATE_KEY: key.privateKey,
                    SUI_RPC_PROXY_TARGET: rpcUrl.origin,
                    DEEPBOOK_SERVER_PROXY_TARGET: deps.server.url,
                    SANDBOX_API_PROXY_TARGET: deps.sandboxApi.url,
                };
                const child = yield* Effect.acquireRelease(
                    Effect.sync(() => {
                        const c = ProcessSupervisor.nodeProcessSpawner(
                            "pnpm",
                            ["exec", "vite", "--port", String(port), "--strictPort"],
                            { cwd: DASHBOARD_DIR, env, stdio: "pipe", detached: true },
                        );
                        pipeChildLogs(c);
                        return c;
                    }),
                    (c) =>
                        ProcessSupervisor.terminateManagedProcess(c, {
                            graceMs: 3_000,
                            processGroup: true,
                        }),
                );

                const url = `http://localhost:${port}`;
                yield* ProcessSupervisor.awaitManagedProcessReady({
                    ready: Probes.waitForProbe({
                        label: `${MEMBER}:http`,
                        timeoutMs: READY_TIMEOUT_MS,
                        intervalMs: 500,
                        probe: () =>
                            Effect.promise(() =>
                                fetch(url, { signal: AbortSignal.timeout(2_000) })
                                    .then((r) => r.ok || r.status < 500)
                                    .catch(() => false),
                            ),
                    }).pipe(
                        Effect.catch((cause) =>
                            Effect.fail(
                                fail(
                                    "ready",
                                    `vite did not serve within ${READY_TIMEOUT_MS}ms`,
                                    cause,
                                ),
                            ),
                        ),
                    ),
                    exit: ProcessSupervisor.awaitProcessExit(child),
                    processError: ProcessSupervisor.onceProcessError(child),
                    onExitBeforeReady: (status) =>
                        fail(
                            "spawn",
                            `vite exited before ready (${ProcessSupervisor.describeProcessExitStatus(status)})`,
                        ),
                    onProcessErrorBeforeReady: (cause) =>
                        fail("spawn", `vite failed to spawn: ${String(cause)}`, cause),
                });

                console.error(`[${MEMBER}] trading dashboard ready at ${url}`);
                return {
                    url,
                    port,
                    walletAddress: key.address,
                    rpcProxyTarget: deps.sui.hostGateway.rpcUrl,
                };
            }),
    });
}
