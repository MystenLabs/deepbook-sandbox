// DeepBook-on-fork members (DBSF-017): compose devstack's FIRST-PARTY
// `deepbook()` member in mode 'known' against the mainnet ids pinned by
// DBSF-016 (`deployments/mainnet-fork.json`), instead of porting the legacy
// MoveDeployer/pool.ts publish flow — the fork already carries mainnet's
// deployment.
//
// What devstack's known mode does NOT carry (0.7.0, verified in dist):
//   - `margin: null` is hardcoded — the margin + liquidation packages are
//     exposed here as verify-only `knownPackage` members instead (their boot
//     chain-probe also proves the fork serves the pinned ids).
//   - `adminCapId: null` — admin flows impersonate the manifest's adminWallet
//     (it holds BOTH DeepbookAdminCap and MarginAdminCap; see
//     fork-impersonation.md). DBSF-020 builds the create-pool action on top.
//   - `pools: []` — mainnet pool ids ride in via `mainnetForkDeepbookIds()`.
//
// We pass explicit ids from the manifest rather than trusting devstack's
// `.mainnet()` defaults. Those come from @mysten/deepbook-v3's constants — which
// match our pins today for the two ids known mode consumes, but SDK constants
// have lagged mainnet before (1.5.0 pins margin v5; mainnet is v6), and pinning
// explicitly means a future SDK lag can't silently move them. The manifest is
// drift-checked by `pnpm verify:deepbook-ids`.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { account, deepbook, knownPackage } from "@mysten-incubation/devstack";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST_PATH = resolve(HERE, "..", "deployments", "mainnet-fork.json");

export type MainnetForkPackagePin = {
    originalId: string;
    latestId: string;
    latestVersion: number;
};

export type MainnetForkPoolPin = {
    objectId: string;
    initialSharedVersion: string;
    baseType: string;
    quoteType: string;
    tickSize: number;
    lotSize: number;
    minSize: number;
};

export type MainnetForkDeepbookIds = {
    packages: {
        deepbook: MainnetForkPackagePin;
        deepbookMargin: MainnetForkPackagePin;
        marginLiquidation: MainnetForkPackagePin;
    };
    registry: { objectId: string; initialSharedVersion: string; type: string };
    marginRegistry: { objectId: string; initialSharedVersion: string; type: string };
    adminWallet: string;
    deepbookAdminCap: { objectId: string; owner: string; type: string };
    marginAdminCap: { objectId: string; owner: string; type: string };
    pools: Record<string, MainnetForkPoolPin>;
};

/** Load the DBSF-016 id pins. Throws with a pointed message if the manifest is
 *  missing — it is checked in, so this only fires on a bad `manifestPath`. */
export function mainnetForkDeepbookIds(manifestPath?: string): MainnetForkDeepbookIds {
    const path = manifestPath ?? DEFAULT_MANIFEST_PATH;
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (cause) {
        throw new Error(
            `mainnet-fork manifest not found at ${path} — the DBSF-016 id pins are checked in at ` +
                `sandbox/deployments/mainnet-fork.json; pass manifestPath if yours lives elsewhere`,
            { cause },
        );
    }
    const ids = JSON.parse(raw).deepbook as MainnetForkDeepbookIds | undefined;
    if (ids == null) {
        throw new Error(`mainnet-fork manifest at ${path} has no \`deepbook\` key — wrong file?`);
    }
    return ids;
}

/** The DeepBook server REST API (the deepbook-server devstack member, which
 *  publishes host port 9008 fixed) — the query surface for indexed data. The
 *  dashboard only reads these URLs for display/reachability; both point at
 *  the server because the indexer itself has no query API. */
const DEEPBOOK_SERVER_URL = process.env.DEEPBOOK_SERVER_URL ?? "http://127.0.0.1:9008";

/** devstack's first-party deepbook() member, mode 'known', pinned to the
 *  manifest's verified ids. `network: 'mainnet'` keeps devstack's known-table
 *  extras (deepTreasuryId, Pyth state ids); the explicit package/registry ids
 *  override its SDK-derived defaults. Pools + server/indexer URLs ride in via
 *  the patched known-mode options (see patches/ — upstream hardcodes them
 *  empty), so the dashboard's DeepBook page lists the pinned mainnet pools. */
export function deepbookFromManifest(opts?: { name?: string; manifestPath?: string }) {
    const ids = mainnetForkDeepbookIds(opts?.manifestPath);
    return deepbook({
        mode: "known",
        network: "mainnet",
        packageId: ids.packages.deepbook.latestId,
        registryId: ids.registry.objectId,
        pools: Object.entries(ids.pools).map(([name, pin]) => ({
            name,
            poolId: pin.objectId,
            // Coin keys (`…::deep::DEEP` → `DEEP`) — local mode fills these
            // from SDK coin refs; mirror it so the generated tree's pool type
            // stays truthful.
            base: pin.baseType.split("::").pop() ?? pin.baseType,
            quote: pin.quoteType.split("::").pop() ?? pin.quoteType,
            baseCoinType: pin.baseType,
            quoteCoinType: pin.quoteType,
        })),
        serverUrl: DEEPBOOK_SERVER_URL,
        indexerUrl: DEEPBOOK_SERVER_URL,
        ...(opts?.name !== undefined ? { name: opts.name } : {}),
    });
}

/** Verify-only members for the packages known mode doesn't model. Their boot
 *  probe reads each package BY ID on the fork (fork-safe — no enumeration). */
export function deepbookMarginPackagesFromManifest(opts?: { manifestPath?: string }) {
    const ids = mainnetForkDeepbookIds(opts?.manifestPath);
    return {
        margin: knownPackage("deepbook-margin", {
            packageId: ids.packages.deepbookMargin.latestId,
        }),
        liquidation: knownPackage("margin-liquidation", {
            packageId: ids.packages.marginLiquidation.latestId,
        }),
    };
}

/** The impersonated mainnet admin wallet — holds BOTH DeepbookAdminCap and
 *  MarginAdminCap, so this single account member covers every admin flow
 *  (create_pool_admin for DBSF-020, margin config, …). */
export function deepbookAdminAccountFromManifest(opts?: { name?: string; manifestPath?: string }) {
    const ids = mainnetForkDeepbookIds(opts?.manifestPath);
    return account(opts?.name ?? "deepbookAdmin", {
        kind: "impersonate",
        address: ids.adminWallet,
    });
}
