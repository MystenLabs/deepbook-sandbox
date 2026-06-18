// E2E fixture: a minimal devstack stack composing the DEEP funding plugin and
// funding `alice` with DEEP on a mainnet fork. Booted by the vitest harness
// (global-setup.ts) for deep-funding.e2e.test.ts, and runnable directly:
// `devstack up`.
//
// Requires a fork that survives non-SUI coin execution. A STOCK sui-fork aborts
// (the get_coin_info blocker — see ../deep-funding.ts), so point at the patched
// fork via FORK_IMAGE_CONTEXT (the spike's scripts/spikes/devstack-funding/.fork-patched/images).

import { account, coin, defineDevstack, sui } from "@mysten-incubation/devstack";

import { deepFundingFromWhale, DEEP_COIN_TYPE } from "../deep-funding.ts";
import { ALICE_KEYPAIR } from "./alice.ts";
import { STACK_NAME } from "./stack.ts";

const DONOR =
    process.env.DEEP_DONOR_ADDRESS ??
    "0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d";

const forkImageContext = process.env.FORK_IMAGE_CONTEXT?.trim();

const suiRef = sui({
    mode: "fork",
    upstream: "mainnet",
    ...(forkImageContext
        ? { image: { build: { context: forkImageContext, dockerfile: "sui-fork/Dockerfile" } } }
        : {}),
});
const whale = account("deepWhale", { kind: "impersonate", address: DONOR });
const deepCoin = coin.known(DEEP_COIN_TYPE);
const deepFunding = deepFundingFromWhale({ sui: suiRef, whale });

export default defineDevstack({
    members: [
        suiRef,
        whale,
        deepFunding,
        deepCoin,
        account("alice", {
            // Fixed keypair ⇒ deterministic recipient address the e2e test queries
            // directly (see ./alice.ts). alice signs nothing here — she's a passive
            // DEEP recipient — so a constant key is purely for a stable address.
            kind: "signer",
            signer: ALICE_KEYPAIR,
            // `via` forces the provider→funding dep edge so our strategy is registered
            // before alice's funding pass runs (else non-SUI funding silently no-ops).
            funding: [{ coin: deepCoin, amount: 1000n, via: deepFunding }], // 1000 base units of DEEP
        }),
    ],
    stackName: STACK_NAME,
});
