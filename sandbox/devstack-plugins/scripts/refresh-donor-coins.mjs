// Discover the donor whale's current DEEP source coin + a SUI gas coin on REAL
// mainnet, and print object ids to use as the funding strategy's coin refs.
//
// Why this exists: a mainnet fork lazily materializes objects on direct access
// (`getObject` by id) but does NOT build an owner->coins index, so `listCoins`
// returns empty on the fork — the strategy can't *discover* the donor's coins
// there. It instead resolves coins by KNOWN object id via `getObject` (which the
// fork supports). This script fetches those ids from mainnet (where `getCoins`
// works) so the defaults / env overrides can be refreshed when they go stale.
//
// Usage:
//   node scripts/refresh-donor-coins.mjs
//   DEEP_DONOR_ADDRESS=0x... node scripts/refresh-donor-coins.mjs
//
// Paste the printed ids into deep-funding.ts's defaults, or export them:
//   DEEP_DONOR_COIN_ID=... SUI_GAS_COIN_ID=... pnpm test:e2e

import { SuiGrpcClient } from "@mysten/sui/grpc";

const DONOR =
    process.env.DEEP_DONOR_ADDRESS ??
    "0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d";
const DEEP_COIN_TYPE =
    "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP";
const SUI_COIN_TYPE = "0x2::sui::SUI";
// Must cover the fork impersonation gas budget (deep-funding.ts FORK_GAS_BUDGET).
const MIN_GAS = 100_000_000n;
const MAINNET_GRPC = process.env.MAINNET_GRPC_URL ?? "https://fullnode.mainnet.sui.io:443";

// v2 dropped the JSON-RPC SuiClient; use the gRPC core client (same surface the
// funding strategy uses against the fork).
const client = new SuiGrpcClient({ network: "mainnet", baseUrl: MAINNET_GRPC });

/** Page all of `owner`'s coins of `coinType`, largest balance first. */
async function allCoins(owner, coinType) {
    const out = [];
    let cursor = null;
    do {
        const page = await client.core.listCoins({ owner, coinType, cursor });
        for (const o of page.objects) {
            out.push({
                coinObjectId: o.objectId,
                version: o.version,
                digest: o.digest,
                balance: o.balance,
            });
        }
        cursor = page.hasNextPage === true ? (page.cursor ?? null) : null;
    } while (cursor !== null);
    return out.sort((a, b) => {
        const ba = BigInt(b.balance);
        const aa = BigInt(a.balance);
        return ba > aa ? 1 : ba < aa ? -1 : 0; // balance descending
    });
}

const fmt = (raw, dp) => (Number(BigInt(raw)) / 10 ** dp).toLocaleString();

const deep = await allCoins(DONOR, DEEP_COIN_TYPE);
const sui = await allCoins(DONOR, SUI_COIN_TYPE);

console.log(`\ndonor: ${DONOR}\n`);

if (deep.length === 0) {
    console.error("✗ donor holds NO DEEP coins — pick another donor.");
} else {
    const c = deep[0];
    console.log(`DEEP coins: ${deep.length} (using largest)`);
    console.log(`  id:      ${c.coinObjectId}`);
    console.log(`  balance: ${c.balance} (${fmt(c.balance, 6)} DEEP)\n`);
}

const gas = sui.find((c) => BigInt(c.balance) >= MIN_GAS);
if (gas === undefined) {
    console.error(`✗ donor has no SUI coin >= ${MIN_GAS} for gas.`);
} else {
    console.log(`SUI coins: ${sui.length} (using first >= ${MIN_GAS} MIST)`);
    console.log(`  id:      ${gas.coinObjectId}`);
    console.log(`  balance: ${gas.balance} (${fmt(gas.balance, 9)} SUI)\n`);
}

if (deep.length > 0 && gas !== undefined) {
    console.log("Suggested env (or update deep-funding.ts defaults):");
    console.log(`  export DEEP_DONOR_COIN_ID=${deep[0].coinObjectId}`);
    console.log(`  export SUI_GAS_COIN_ID=${gas.coinObjectId}\n`);
}
