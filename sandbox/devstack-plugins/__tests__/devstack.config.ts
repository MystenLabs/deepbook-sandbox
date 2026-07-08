// E2E fixture: a minimal devstack stack composing the DEEP + USDC funding plugins
// and funding `alice` with both on a mainnet fork. Booted by the vitest harness
// (global-setup.ts) for the *.e2e.test.ts files, and runnable directly:
// `devstack up`.
//
// Requires a fork that survives non-SUI coin execution. A STOCK sui-fork aborts
// (the get_coin_info blocker — see ../deep-funding.ts), so this defaults to the
// PATCHED fork image (scripts/spikes/devstack-funding/.fork-patched/images);
// override the build context via FORK_IMAGE_CONTEXT if needed.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { account, coin, defineDevstack, sui } from "@mysten-incubation/devstack";

import { deepFundingFromWhale, DEEP_COIN_TYPE } from "../deep-funding.ts";
import { usdcFundingFromCapOwner, USDC_COIN_TYPE } from "../usdc-funding.ts";
import { ALICE_KEYPAIR } from "./alice.ts";
import { STACK_NAME } from "./stack.ts";

const DONOR =
    process.env.DEEP_DONOR_ADDRESS ??
    "0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d";
const USDC_MINTER =
    process.env.USDC_MINTER_ADDRESS ??
    "0x41c0c6d67577b39f31a5fe4052314fd3a8b7c7f890676f60e007bd390e397ac1";

// Default to the patched fork image (required — a stock fork aborts on non-SUI
// coin execution), resolved relative to this file so `pnpm test:e2e` works with
// no env setup. Override via FORK_IMAGE_CONTEXT.
const HERE = dirname(fileURLToPath(import.meta.url));
const forkImageContext =
    process.env.FORK_IMAGE_CONTEXT?.trim() ||
    resolve(HERE, "..", "..", "scripts", "spikes", "devstack-funding", ".fork-patched", "images");
// Build the fork binary from a sui rev whose MAX_PROTOCOL_VERSION covers current
// mainnet (protocol 128 as of 2026-07-08); passed to the patched Dockerfile as
// SUI_FORK_REV. This rev (16f1402387, sui main) is protocol max 130; devstack's
// own default (62ee6ada, max v125) can't fork current mainnet. Override via SUI_FORK_REV.
const forkRev = process.env.SUI_FORK_REV ?? "16f1402387c7ce0f9310e57610428efec930dbf4";

const suiRef = sui({
    mode: "fork",
    upstream: "mainnet",
    version: forkRev,
    image: { build: { context: forkImageContext, dockerfile: "sui-fork/Dockerfile" } },
});
const whale = account("deepWhale", { kind: "impersonate", address: DONOR });
const deepCoin = coin.known(DEEP_COIN_TYPE);
const deepFunding = deepFundingFromWhale({ sui: suiRef, whale });

const usdcMinter = account("usdcMinter", { kind: "impersonate", address: USDC_MINTER });
const usdcCoin = coin.known(USDC_COIN_TYPE);
const usdcFunding = usdcFundingFromCapOwner({ sui: suiRef, minter: usdcMinter });

export default defineDevstack({
    members: [
        suiRef,
        whale,
        deepFunding,
        deepCoin,
        usdcMinter,
        usdcFunding,
        usdcCoin,
        account("alice", {
            // Fixed keypair ⇒ deterministic recipient address the e2e tests query
            // directly (see ./alice.ts). alice signs nothing here — she's a passive
            // recipient — so a constant key is purely for a stable address.
            kind: "signer",
            signer: ALICE_KEYPAIR,
            // `via` forces the provider→funding dep edge so each strategy is registered
            // before alice's funding pass runs (else non-SUI funding silently no-ops).
            funding: [
                { coin: deepCoin, amount: 1000n, via: deepFunding }, // 1000 base units of DEEP
                { coin: usdcCoin, amount: 1_000_000_000n, via: usdcFunding }, // 1000 USDC (6 dp)
            ],
        }),
    ],
    stackName: STACK_NAME,
});
