// PRODUCTION stack (DBSF-021): compose every shipped fork-runtime member into
// the stack `devstack up` boots. Thin assembly only — all logic lives in the
// plugin modules. Deliberately NOT composed yet (their tickets are open):
// the oracle-service hostService (SEDEFI-317) and the create-sandbox-pool
// action (SEDEFI-324) — both are additive when they land.
//
// Image precedence (same policy as scripts/dashboard-up.mjs): prebuilt pull
// (DEVSTACK_SUI_FORK_IMAGE) > patched build context (FORK_IMAGE_CONTEXT, or the
// default spike path when present) > devstack's default source build. A STOCK
// fork survives boot-and-teardown checks but crashes seconds after boot once
// dashboard faucet requests or the `remainingDeep` balance-read Effect hit
// donor-coin access — use the patched image for real faucet usage (see README
// "Known blocker").

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { account, coin, dashboard, defineDevstack, sui, wallet } from "@mysten-incubation/devstack";

import { clockDriverMember } from "./clock-driver.ts";
import { deepFundingFromWhale, DEEP_COIN_TYPE } from "./deep-funding.ts";
import { resolveForkCheckpoint } from "./fork-checkpoint.ts";
import {
    deepbookAdminAccountFromManifest,
    deepbookFromManifest,
    deepbookMarginPackagesFromManifest,
    mainnetForkDeepbookIds,
} from "./deepbook-known.ts";
import { indexerMember } from "./indexer-member.ts";
import { poolsSeedMember } from "./pools-seed.ts";
import { postgresMember } from "./postgres-member.ts";
import { registryInitMember } from "./registry-init.ts";
import { sandboxApiMember } from "./sandbox-api.ts";
import { serverMember } from "./server-member.ts";
import { tradeSimMember } from "./trade-sim.ts";
import { tradingDashboardMember } from "./trading-dashboard.ts";
import { usdcFundingFromCapOwner, USDC_COIN_TYPE } from "./usdc-funding.ts";

export const STACK = process.env.SANDBOX_STACK ?? "deepbook-sandbox";

const DONOR =
    process.env.DEEP_DONOR_ADDRESS ??
    "0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d";
const USDC_MINTER =
    process.env.USDC_MINTER_ADDRESS ??
    "0x41c0c6d67577b39f31a5fe4052314fd3a8b7c7f890676f60e007bd390e397ac1";

// Build the fork binary from a sui rev whose MAX_PROTOCOL_VERSION covers
// current mainnet (see dashboard-up.mjs for the full rationale).
const FORK_REV = process.env.SUI_FORK_REV ?? "16f1402387c7ce0f9310e57610428efec930dbf4";
// Checkpoint pin — defaults to a pre-protocol-130 mainnet checkpoint because
// newer state aborts this fork rev and newer revs crash fork genesis; see
// fork-checkpoint.ts for the full story. FORK_CHECKPOINT=<n> overrides;
// FORK_CHECKPOINT=latest forks the live tip.
const checkpoint = resolveForkCheckpoint(process.env.FORK_CHECKPOINT);

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATCHED_CONTEXT = resolve(
    HERE,
    "..",
    "scripts",
    "spikes",
    "devstack-funding",
    ".fork-patched",
    "images",
);
const pulled = process.env.DEVSTACK_SUI_FORK_IMAGE?.trim();
const ctx =
    process.env.FORK_IMAGE_CONTEXT?.trim() ||
    (existsSync(join(DEFAULT_PATCHED_CONTEXT, "sui-fork", "Dockerfile"))
        ? DEFAULT_PATCHED_CONTEXT
        : undefined);
let imageOpt: { image?: { pull: string } | { build: { context: string; dockerfile: string } } } =
    {};
if (pulled) imageOpt = { image: { pull: pulled } };
else if (ctx) imageOpt = { image: { build: { context: ctx, dockerfile: "sui-fork/Dockerfile" } } };
else
    console.error(
        "devstack.config: no patched fork image found — falling back to devstack's default " +
            "(STOCK) fork build. A stock fork survives boot-and-teardown checks (pnpm smoke) " +
            "but crashes seconds after boot once the funding members touch donor coins, and " +
            "any DEEP/USDC execution aborts it. Build the patched image " +
            "(scripts/spikes/devstack-funding/build-patched-fork.sh) or set " +
            "DEVSTACK_SUI_FORK_IMAGE / FORK_IMAGE_CONTEXT for a usable stack.",
    );

const suiRef = sui({
    mode: "fork",
    upstream: "mainnet",
    version: FORK_REV,
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...imageOpt,
});

const whale = account("deepWhale", { kind: "impersonate", address: DONOR });
const deepFunding = deepFundingFromWhale({ sui: suiRef, whale });
const deepCoin = coin.known(DEEP_COIN_TYPE);

const usdcMinter = account("usdcMinter", { kind: "impersonate", address: USDC_MINTER });
const usdcFunding = usdcFundingFromCapOwner({ sui: suiRef, minter: usdcMinter });
const usdcCoin = coin.known(USDC_COIN_TYPE);

// Vendored dashboard SPA build (SEDEFI-444): the packaged dashboard-ui ships
// placeholder Price/Depth panels; ours (built from ts-sdks-incubation @0.7.0 +
// dashboard-ui-app.patch — see README) fetches the DeepBook server. Falls back
// to the bundled UI when the vendored build is absent.
const DASHBOARD_UI_DIR = resolve(HERE, "dashboard-ui");
const dashboardOpts = existsSync(join(DASHBOARD_UI_DIR, "index.html"))
    ? { assetsDir: DASHBOARD_UI_DIR }
    : {};

const deepbookMember = deepbookFromManifest();
const { margin: marginPackage, liquidation: liquidationPackage } =
    deepbookMarginPackagesFromManifest();
const deepbookAdmin = deepbookAdminAccountFromManifest();

// Container-backed fork-stack members (SEDEFI-445 / DBSF-032) — the former
// docker-compose remnant (postgres, indexer, server) plus boot-time pools
// seeding, folded into the one orchestrator. Wiring (fork RPC URL, Postgres
// DSN, checkpoint pin) resolves from devstack state via dependsOn edges; the
// package ids ride in from the DBSF-016 manifest (ORIGINAL ids — event type
// tags carry them, unlike the known member's latestId).
const manifestIds = mainnetForkDeepbookIds();
// chainKey: re-pinning the fork (rev or checkpoint) recreates postgres, so
// stale indexer watermarks can't survive a chain identity change.
const postgres = postgresMember({ chainKey: `${FORK_REV}:${checkpoint ?? "latest"}` });
const indexer = indexerMember({
    sui: suiRef,
    postgres,
    ...(checkpoint !== undefined ? { firstCheckpoint: checkpoint } : {}),
    deepbookPackageId: manifestIds.packages.deepbook.originalId,
});
const server = serverMember({
    sui: suiRef,
    postgres,
    deepbookPackageId: manifestIds.packages.deepbook.originalId,
    deepTokenPackageId: DEEP_COIN_TYPE.split("::")[0]!,
    marginPackageId: manifestIds.packages.deepbookMargin.originalId,
});
const poolsSeed = poolsSeedMember({ postgres, indexer });
// The old trading dashboard, revived (SEDEFI-456): registry-init makes
// user-driven BM registration possible on the fork (and pre-warms the
// framework so a fresh chain's first commit can't panic — SUI-FORK-ISSUES
// #9), sandbox-api restores the retired /manifest + /faucet contract on
// port 9009, and trading-dashboard runs the Vite dev server with
// fork-resolved wiring on port 5173.
const registryInit = registryInitMember({ sui: suiRef });
// Holds the fork's on-chain Clock at wall time (SEDEFI-317 / DBSF-013, first
// slice). Without it the Clock sits at the checkpoint pin and every fill is
// stamped weeks in the past — below the DeepBook server's 24h /ticker window,
// which is what the dashboard prices orders off (CLOCK_DRIVER_DISABLED=1 opts
// out; CLOCK_INTERVAL_MS tunes it).
const clockDriver = clockDriverMember({ sui: suiRef, registryInit });
// Continuous self-fill loop so the dashboard's Price panel / ticker stay
// live (SIM_DISABLED=1 opts out; SIM_POOLS / SIM_INTERVAL_MS tune it).
const tradeSim = tradeSimMember({ sui: suiRef, postgres, poolsSeed, indexer, registryInit });

const sandboxApi = sandboxApiMember({ sui: suiRef, deepFunding, usdcFunding });
const tradingDashboard = tradingDashboardMember({
    sui: suiRef,
    deepFunding,
    usdcFunding,
    sandboxApi,
    server,
    registryInit,
});

export const members = [
    suiRef,
    whale,
    deepFunding,
    deepCoin,
    usdcMinter,
    usdcFunding,
    usdcCoin,
    deepbookMember,
    marginPackage,
    liquidationPackage,
    deepbookAdmin,
    dashboard(dashboardOpts),
    wallet({ accounts: "all" }),
    postgres,
    indexer,
    server,
    poolsSeed,
    tradeSim,
    registryInit,
    clockDriver,
    sandboxApi,
    tradingDashboard,
];

export default defineDevstack({ members, stackName: STACK });
