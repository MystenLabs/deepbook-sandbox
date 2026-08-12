// Seed the deepbook-server's `pools` config table from the DBSF-016 manifest.
//
// The `pools` table is MANUAL CONFIG — the indexer does not populate it, and
// every per-pool server endpoint (/get_pools, /ticker, /trades/:pool_name,
// /ohclv/:pool_name, …) resolves pool names/decimals through it. Idempotent
// (ON CONFLICT DO UPDATE), so it runs on every `pnpm deploy-all`; a `down -v`
// wipes it with the rest of Postgres.
//
// Standalone run: pnpm exec tsx scripts/seed-pools.ts

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(HERE, "..", "deployments", "mainnet-fork.json");

type PoolPin = {
    objectId: string;
    baseType: string;
    quoteType: string;
    tickSize: number;
    lotSize: number;
    minSize: number;
};

/** Static mainnet coin metadata for the manifest's pool assets. The server
 *  only uses decimals (price/volume scaling) and symbol/name (display). */
const COIN_META: Record<string, { decimals: number; symbol: string; name: string }> = {
    "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP": {
        decimals: 6,
        symbol: "DEEP",
        name: "DeepBook Token",
    },
    "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI": {
        decimals: 9,
        symbol: "SUI",
        name: "Sui",
    },
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC": {
        decimals: 6,
        symbol: "USDC",
        name: "USDC",
    },
};

const meta = (coinType: string) => {
    const m = COIN_META[coinType];
    if (m === undefined) {
        throw new Error(
            `seed-pools: no coin metadata for ${coinType} — add it to COIN_META (new manifest pool?)`,
        );
    }
    return m;
};

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Validate a manifest numeric before bare SQL interpolation — a missing or
 *  malformed field should fail with a pointed message, not a psql error. */
const sqlInt = (value: unknown, label: string): string => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new Error(
            `seed-pools: ${label} is not a non-negative integer (got ${String(value)})`,
        );
    }
    return String(value);
};

const pools = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")).deepbook.pools as Record<
    string,
    PoolPin
>;

const rows = Object.entries(pools).map(([name, pin]) => {
    const base = meta(pin.baseType);
    const quote = meta(pin.quoteType);
    return `(${[
        sqlString(pin.objectId),
        sqlString(name),
        sqlString(pin.baseType),
        sqlInt(base.decimals, `${name}.base.decimals`),
        sqlString(base.symbol),
        sqlString(base.name),
        sqlString(pin.quoteType),
        sqlInt(quote.decimals, `${name}.quote.decimals`),
        sqlString(quote.symbol),
        sqlString(quote.name),
        sqlInt(pin.minSize, `${name}.minSize`),
        sqlInt(pin.lotSize, `${name}.lotSize`),
        sqlInt(pin.tickSize, `${name}.tickSize`),
    ].join(", ")})`;
});

const sql = `INSERT INTO pools (
    pool_id, pool_name,
    base_asset_id, base_asset_decimals, base_asset_symbol, base_asset_name,
    quote_asset_id, quote_asset_decimals, quote_asset_symbol, quote_asset_name,
    min_size, lot_size, tick_size
) VALUES
${rows.join(",\n")}
ON CONFLICT (pool_id) DO UPDATE SET
    pool_name = EXCLUDED.pool_name,
    base_asset_id = EXCLUDED.base_asset_id,
    base_asset_decimals = EXCLUDED.base_asset_decimals,
    base_asset_symbol = EXCLUDED.base_asset_symbol,
    base_asset_name = EXCLUDED.base_asset_name,
    quote_asset_id = EXCLUDED.quote_asset_id,
    quote_asset_decimals = EXCLUDED.quote_asset_decimals,
    quote_asset_symbol = EXCLUDED.quote_asset_symbol,
    quote_asset_name = EXCLUDED.quote_asset_name,
    min_size = EXCLUDED.min_size,
    lot_size = EXCLUDED.lot_size,
    tick_size = EXCLUDED.tick_size;`;

execFileSync(
    "docker",
    [
        "exec",
        "-i",
        "deepbook-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "deepbook",
        "-v",
        "ON_ERROR_STOP=1",
    ],
    { input: sql, stdio: ["pipe", "inherit", "inherit"] },
);
console.error(`[seed-pools] seeded ${rows.length} pools from ${MANIFEST_PATH}`);
