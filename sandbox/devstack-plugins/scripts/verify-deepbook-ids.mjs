// Verify the mainnet DeepBook identities pinned in deployments/mainnet-fork.json
// against CURRENT Sui mainnet — the verification behind the DBSF-016 pins the
// fork sandbox references (packages, Registry/MarginRegistry, admin caps, default
// pools). Catches drift the fork would otherwise inherit silently: a transferred
// admin cap (owner mismatch), a package upgraded past the pin (listPackageVersions
// reports a newer on-chain version), or a deleted/renamed object. Pools are
// checked for existence, shared-ness, and Base/Quote type — their econ params
// (tick/lot/min) live in the PoolInner dynamic field and are informational pins,
// not verified here.
//
//   node scripts/verify-deepbook-ids.mjs   (or: pnpm verify:deepbook-ids)
//
// Reads mainnet over gRPC (SuiGrpcClient → Ledger/MovePackage services; public
// fullnodes no longer serve JSON-RPC). No fork / Docker needed. Exits 0 if every
// pin verifies, 1 otherwise.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SuiGrpcClient } from "@mysten/sui/grpc";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(HERE, "..", "..", "deployments", "mainnet-fork.json");
const RPC = process.env.MAINNET_GRPC_URL ?? "https://fullnode.mainnet.sui.io:443";

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const db = manifest.deepbook;

const client = new SuiGrpcClient({ network: "custom", baseUrl: RPC });

// sui.rpc.v2.Owner.OwnerKind (protobuf-ts surfaces the numeric enum values).
const KIND = { ADDRESS: 1, SHARED: 3, IMMUTABLE: 4 };

/** Batch-read objects; returns Map<objectId, object|undefined>. */
async function getObjects(ids) {
    const { response } = await client.ledgerService.batchGetObjects({
        requests: ids.map((id) => ({ objectId: id })),
        readMask: { paths: ["object_id", "version", "object_type", "owner"] },
    });
    const results = response.objects ?? [];
    if (results.length !== ids.length)
        throw new Error(`batchGetObjects returned ${results.length} results for ${ids.length} ids`);
    const map = new Map();
    for (const [i, res] of results.entries()) {
        map.set(ids[i], res.result?.oneofKind === "object" ? res.result.object : undefined);
    }
    return map;
}

/** Newest {packageId, version} in a package's upgrade lineage (versions come back
 *  ordered by version; follow pagination and keep the last). */
async function latestPackageVersion(originalId) {
    let pageToken;
    let last;
    do {
        const { response } = await client.movePackageService.listPackageVersions({
            packageId: originalId,
            ...(pageToken ? { pageToken } : {}),
        });
        const versions = response.versions ?? [];
        if (versions.length > 0) last = versions[versions.length - 1];
        pageToken = response.nextPageToken?.length ? response.nextPageToken : undefined;
    } while (pageToken);
    return last;
}

let ok = true;
const check = (label, cond, detail) => {
    console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!cond) ok = false;
};

console.log(`DeepBook mainnet id verification (${RPC})`);
console.log(`manifest: ${MANIFEST_PATH} (verifiedAt ${manifest.verifiedAt})\n`);

const packageEntries = Object.entries(db.packages);
const sharedEntries = [
    ["registry", db.registry],
    ["marginRegistry", db.marginRegistry],
    // Pool<Base, Quote> is stamped with deepbook's ORIGINAL package id, so the
    // expected type also proves the pinned base/quote coin types.
    ...Object.entries(db.pools).map(([name, p]) => [
        `pool ${name}`,
        {
            ...p,
            type: `${db.packages.deepbook.originalId}::pool::Pool<${p.baseType},${p.quoteType}>`,
        },
    ]),
];
const capEntries = [
    ["deepbookAdminCap", db.deepbookAdminCap],
    ["marginAdminCap", db.marginAdminCap],
];

const allIds = [
    ...packageEntries.flatMap(([, p]) => [p.originalId, p.latestId]),
    ...sharedEntries.map(([, o]) => o.objectId),
    ...capEntries.map(([, o]) => o.objectId),
];
const objects = await getObjects(allIds);

console.log("packages:");
for (const [name, p] of packageEntries) {
    const orig = objects.get(p.originalId);
    const latest = objects.get(p.latestId);
    check(`${name} originalId exists (immutable)`, orig?.owner?.kind === KIND.IMMUTABLE);
    check(
        `${name} latestId exists at package version ${p.latestVersion}`,
        latest?.owner?.kind === KIND.IMMUTABLE && Number(latest?.version) === p.latestVersion,
        latest ? `v${latest.version}` : "missing",
    );
    const onchain = await latestPackageVersion(p.originalId);
    check(
        `${name} pin is the newest on-chain version`,
        onchain?.packageId === p.latestId && Number(onchain?.version) === p.latestVersion,
        onchain
            ? `on-chain latest v${onchain.version} ${onchain.packageId?.slice(0, 10)}…`
            : "unavailable",
    );
}

console.log("\nshared objects:");
for (const [name, o] of sharedEntries) {
    const obj = objects.get(o.objectId);
    const sharedOk = obj?.owner?.kind === KIND.SHARED;
    const versionOk = String(obj?.owner?.version ?? "") === o.initialSharedVersion;
    const typeOk = o.type === undefined || obj?.objectType === o.type;
    check(
        `${name} shared, initial version ${o.initialSharedVersion}${o.type ? ", expected type" : ""}`,
        sharedOk && versionOk && typeOk,
        obj ? `${obj.objectType ?? "?"} @ initial v${obj.owner?.version}` : "missing",
    );
}

console.log("\nadmin caps (impersonation targets):");
for (const [name, o] of capEntries) {
    const obj = objects.get(o.objectId);
    const ownerOk = obj?.owner?.kind === KIND.ADDRESS && obj?.owner?.address === o.owner;
    const typeOk = obj?.objectType === o.type;
    check(
        `${name} owned by ${o.owner.slice(0, 10)}…, expected type`,
        ownerOk && typeOk,
        obj ? `owner ${obj.owner?.address?.slice(0, 10)}… ${obj.objectType}` : "missing",
    );
    check(`${name} owner is the shared adminWallet pin`, o.owner === db.adminWallet);
}

console.log(
    ok ? "\nall pins verified ✓" : "\nDRIFT DETECTED — update deployments/mainnet-fork.json ✗",
);
process.exit(ok ? 0 : 1);
