// Verify the USDC minting identities on CURRENT Sui mainnet and re-derive the
// master-minter. Native USDC is a regulated coin: the TreasuryCap<USDC> is a
// dynamic field under a shared Treasury<USDC>, and minting goes through the
// stablecoin framework's treasury::mint gated by the master-minter role. This
// script confirms the documented ids still resolve and re-derives the current
// master-minter (so a Circle rotation is caught) — the verification behind
// deployments/fork-impersonation.md's USDC section.
//
//   node scripts/verify-usdc-minter.mjs   (or: pnpm verify:usdc-minter)
//
// Reads real mainnet JSON-RPC (no fork / Docker needed). Exits 0 if everything
// resolves, 1 otherwise.

import { deriveDynamicFieldID } from "@mysten/sui/utils";

const RPC = process.env.MAINNET_JSON_RPC ?? "https://fullnode.mainnet.sui.io:443";

const USDC_PACKAGE = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7";
const USDC_TYPE = `${USDC_PACKAGE}::usdc::USDC`;
const STABLECOIN_PACKAGE = "0xecf47609d7da919ea98e7fd04f6e0648a0a79b337aaad373fa37aac8febf19c8";
const TREASURY = "0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7";
const TREASURY_CAP = "0x677e41a5c35d90177d401b72952c228ffa65b770e265561ad607f34d6896dcc2";
const EXPECTED_MASTER_MINTER = "0x41c0c6d67577b39f31a5fe4052314fd3a8b7c7f890676f60e007bd390e397ac1";

async function rpc(method, params) {
    const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
    return json.result;
}

let ok = true;
const check = (label, cond, detail) => {
    console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!cond) ok = false;
};

console.log(`USDC minter verification (mainnet: ${RPC})\n`);

// 1. package + coin type
const pkg = await rpc("sui_getObject", [USDC_PACKAGE, { showType: true }]);
check("USDC package exists", pkg.data?.type === "package", pkg.data?.type ?? pkg.error?.code);

// 2. shared Treasury<USDC>
const treasury = await rpc("sui_getObject", [
    TREASURY,
    { showType: true, showOwner: true, showContent: true },
]);
check(
    "shared Treasury<USDC>",
    treasury.data?.type === `${STABLECOIN_PACKAGE}::treasury::Treasury<${USDC_TYPE}>` &&
        treasury.data?.owner?.Shared !== undefined,
    treasury.data?.type,
);

// 3. TreasuryCap<USDC>
const cap = await rpc("sui_getObject", [TREASURY_CAP, { showType: true }]);
check(
    "TreasuryCap<USDC>",
    cap.data?.type === `0x2::coin::TreasuryCap<${USDC_TYPE}>`,
    cap.data?.type,
);

// 4. re-derive the master-minter from the Treasury's roles Bag → MasterMinterKey
const bagId = treasury.data?.content?.fields?.roles?.fields?.data?.fields?.id?.id;
check("roles Bag id resolved", typeof bagId === "string", bagId);

let masterMinter;
if (typeof bagId === "string") {
    // key bytes [0x00]: MasterMinterKey { dummy_field: bool } in the deployed package.
    const fieldId = deriveDynamicFieldID(
        bagId,
        `${STABLECOIN_PACKAGE}::roles::MasterMinterKey`,
        new Uint8Array([0]),
    );
    const field = await rpc("sui_getObject", [fieldId, { showContent: true }]);
    masterMinter = field.data?.content?.fields?.value;
    check("master-minter re-derived", typeof masterMinter === "string", masterMinter);
    check(
        "master-minter unchanged (documented value)",
        masterMinter === EXPECTED_MASTER_MINTER,
        masterMinter === EXPECTED_MASTER_MINTER
            ? undefined
            : `got ${masterMinter}, expected ${EXPECTED_MASTER_MINTER}`,
    );
}

console.log(
    `\n${ok ? "OK — USDC minting identities verified." : "FAILED — see ✗ above (Circle may have rotated ids; update fork-impersonation.md)."}`,
);
if (masterMinter && masterMinter !== EXPECTED_MASTER_MINTER) {
    console.log(
        `\nCurrent master-minter: ${masterMinter}\n(update USDC_MINTER_ADDRESS + fork-impersonation.md)`,
    );
}
process.exit(ok ? 0 : 1);
