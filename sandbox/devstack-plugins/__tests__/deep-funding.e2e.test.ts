// E2E test: boot the devstack fork fixture (devstack.config.ts) via devstack's
// vitest harness and confirm `account('alice', { funding: [{ coin: deep }] })`
// ends up holding Coin<DEEP> at the real mainnet DEEP package.
//
// Opt-in (boots Docker; the unit `pnpm test` excludes this file). Run it:
//   nvm use 24 && pnpm test:e2e
//
// Requires Docker + Node >= 24. The fixture defaults to the PATCHED fork image
// (a STOCK sui-fork aborts on the DEEP transfer — the get_coin_info blocker; see
// ../deep-funding.ts), so no env is needed; the first run compiles sui-fork (~15-20 min; cached after).
// The harness's global-setup.ts boots + tears down the stack; getStackContext()
// confirms the boot. We query the fork via its DIRECT host-mapped port — the
// manifest's routed `*.localhost` URL isn't gRPC-reachable from the host.
// alice's address is the fixed ./alice.ts key.

import { execSync } from "node:child_process";

import { getStackContext } from "@mysten-incubation/devstack/vitest";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { describe, expect, it } from "vitest";

import { DEEP_COIN_TYPE } from "../deep-funding.ts";
import { ALICE_ADDRESS } from "./alice.ts";
import { STACK_NAME } from "./stack.ts";

/** The fork's gRPC base URL via its direct host-mapped 9000 port. */
function forkRpcUrl(): string {
    const ids = execSync(`docker ps -q --filter name=${STACK_NAME}-sui-fork`)
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean);
    if (ids.length === 0) {
        throw new Error(
            `no running ${STACK_NAME}-sui-fork container — did global-setup boot the fork?`,
        );
    }
    const mapped = execSync(`docker port ${ids[0]} 9000/tcp`).toString().trim().split("\n")[0];
    const port = mapped.split(":").pop();
    if (!port || !/^\d+$/.test(port)) {
        throw new Error(`could not resolve fork host port from 'docker port' output: '${mapped}'`);
    }
    return `http://127.0.0.1:${port}`;
}

describe("deep-funding e2e (patched fork)", () => {
    it("funds alice with DEEP via the impersonation strategy", async () => {
        const ctx = getStackContext();
        if (!ctx) {
            throw new Error(
                "no devstack StackContext — global-setup did not boot the fork (run via `pnpm test:e2e`)",
            );
        }

        // Query alice's DEEP directly at the fork's gRPC endpoint.
        const client = new SuiGrpcClient({ network: "mainnet", baseUrl: forkRpcUrl() });
        const page = await client.core.listCoins({
            owner: ALICE_ADDRESS,
            coinType: DEEP_COIN_TYPE,
        });
        const total = page.objects.reduce((a, o) => a + BigInt(o.balance ?? 0), 0n);

        expect(total).toBeGreaterThanOrEqual(1000n);
    });
});
