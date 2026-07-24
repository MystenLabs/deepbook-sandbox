// Devstack funding-strategy spike — minimal devstack stack that funds an account
// with a non-SUI coin type (DEEP) via a custom funding-strategy plugin.
//
//   sui (fork mainnet)
//   + our custom coinType funding plugin (funding-plugin.ts). It depends on the
//     sui network and impersonates a mainnet whale to source the DEEP — the
//     whale/source-coin/gas-coin are the plugin's own concern, so the stack
//     declares no separate whale account.
//   + coin.known(<DEEP>) so the coin is a resolvable CoinMember ref
//   + account('alice', { funding: [{ coin, amount }] }) — boot-time funding
//
// `devstack up` boots the fork and runs the account-funding pass, which
// dispatches alice's `{ coin: deepCoin, amount }` entry to the `coinType:<DEEP>`
// strategy our plugin contributed (priority 1, beating coin.known's mint-backed
// default at priority 0).

import { account, coin, defineDevstack, sui } from "@mysten-incubation/devstack";

import { deepFunding, TARGET_COIN_TYPE } from "./funding-plugin.ts";

// The DEEP transfer works on a STOCK fork: the plugin primes DEEP's shared
// CoinRegistry `Currency<DEEP>` object with a getObject before executing, so the
// execute-time GetCoinInfo(DEEP) resolves from the registry instead of aborting
// on sui-fork's unimplemented index. (Object-seeding does NOT help — sui-fork's
// --object refuses shared objects: "object seed is not owned by an address".)
// See SUI-FORK-NOTES.md. Escape hatch for comparison:
// FORK_IMAGE_CONTEXT=<abs .fork-patched/images> builds a patched fork
// (get_coin_info -> Ok(None)) instead of relying on the prime.
const forkImageContext = process.env.FORK_IMAGE_CONTEXT?.trim();
// Build the fork binary from a sui rev whose MAX_PROTOCOL_VERSION covers current
// mainnet (protocol 128 as of 2026-07-08); passed to the patched Dockerfile as
// SUI_FORK_REV. This rev (16f1402387, sui main) is protocol max 130; devstack's
// default rev (62ee6ada, max v125) can't fork current mainnet. Override via SUI_FORK_REV.
const forkRev = process.env.SUI_FORK_REV ?? "16f1402387c7ce0f9310e57610428efec930dbf4";
const suiRef = sui({
    mode: "fork",
    upstream: "mainnet",
    version: forkRev,
    ...(forkImageContext
        ? { image: { build: { context: forkImageContext, dockerfile: "sui-fork/Dockerfile" } } }
        : {}),
});

// A resolvable ref for the target coin (accounts cite coins by ref, not string).
const deepCoin = coin.known(TARGET_COIN_TYPE);

export default defineDevstack({
    members: [
        suiRef,
        deepFunding(suiRef),
        deepCoin,
        account("alice", {
            kind: "ephemeral", // a fresh keypair that gets funded at boot
            funding: [{ coin: deepCoin, amount: 100_000_000n }], // 100 DEEP (6 dp)
        }),
    ],
    stackName: "devstack-funding",
});
