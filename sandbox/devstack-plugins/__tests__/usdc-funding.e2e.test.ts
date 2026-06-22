// E2E test: boot the devstack fork fixture (devstack.config.ts) via devstack's
// vitest harness and confirm `account('alice', { funding: [{ coin: usdc }] })`
// ends up holding Coin<USDC> at the real mainnet USDC package — i.e. the USDC
// plugin's impersonate-master-minter -> treasury::mint path works on the fork.
//
// Shares the single fork stack the DEEP e2e boots (the fixture funds alice with
// both DEEP and USDC). Opt-in (boots Docker; the unit `pnpm test` excludes this).
// Run it:
//   nvm use 24 && pnpm test:e2e
//
// Requires Docker + Node >= 24. The fixture defaults to the PATCHED fork image —
// minting USDC trips the same get_coin_info abort as DEEP on a stock fork (see
// ../usdc-funding.ts); the first run builds it (~12 min).

import { execSync } from "node:child_process";

import { getStackContext } from "@mysten-incubation/devstack/vitest";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { describe, expect, it } from "vitest";

import { USDC_COIN_TYPE } from "../usdc-funding.ts";
import { ALICE_ADDRESS } from "./alice.ts";
import { STACK_NAME } from "./stack.ts";

/** The fork's gRPC base URL via its direct host-mapped 9000 port (the manifest's
 *  routed *.localhost URL isn't gRPC-reachable from the host). */
function forkRpcUrl(): string {
  const ids = execSync(`docker ps -q --filter name=${STACK_NAME}-sui-fork`)
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error(`no running ${STACK_NAME}-sui-fork container — did global-setup boot the fork?`);
  }
  const mapped = execSync(`docker port ${ids[0]} 9000/tcp`).toString().trim().split("\n")[0];
  const port = mapped.split(":").pop();
  if (!port || !/^\d+$/.test(port)) {
    throw new Error(`could not resolve fork host port from 'docker port' output: '${mapped}'`);
  }
  return `http://127.0.0.1:${port}`;
}

describe("usdc-funding e2e (patched fork)", () => {
  it("funds alice with USDC via the impersonated master-minter mint", async () => {
    const ctx = getStackContext();
    if (!ctx) {
      throw new Error(
        "no devstack StackContext — global-setup did not boot the fork (run via `pnpm test:e2e`)",
      );
    }

    const client = new SuiGrpcClient({ network: "mainnet", baseUrl: forkRpcUrl() });
    const page = await client.core.listCoins({ owner: ALICE_ADDRESS, coinType: USDC_COIN_TYPE });
    const total = page.objects.reduce((a, o) => a + BigInt(o.balance ?? 0), 0n);

    expect(total).toBeGreaterThanOrEqual(1_000_000_000n); // >= 1000 USDC (6 dp)
  });
});
