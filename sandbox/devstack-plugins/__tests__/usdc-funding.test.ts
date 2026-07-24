// Unit tests for the USDC funding strategy — driven against a stubbed fork
// `sdk.core`. Covers: happy path (configure -> MintCap discovery -> mint),
// MintCap reuse across requests (configure once), per-request cap, configure
// revert, mint revert, transport -> FaucetUnreachable, and not-fork.

import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { usdcFundingStrategy, USDC_COIN_TYPE, type ForkCore } from "../usdc-funding.ts";

const MM = "0x41c0c6d67577b39f31a5fe4052314fd3a8b7c7f890676f60e007bd390e397ac1";
const SPONSOR = "0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d";
const ALICE = "0xf53dc99e086af5405d3afd113396a351144256175ba3e8a748135ba6ab2384da";
const BOB = "0xb0b0000000000000000000000000000000000000000000000000000000000b0b";
const usdc = (whole: number) => BigInt(whole) * 10n ** 6n;

const STABLECOIN_PKG = "0xecf47609d7da919ea98e7fd04f6e0648a0a79b337aaad373fa37aac8febf19c8";
const TREASURY = {
    objectId: "0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7",
    initialSharedVersion: "313333795",
    mutable: true,
} as const;
const DENY_LIST = {
    objectId: "0x0000000000000000000000000000000000000000000000000000000000000403",
    initialSharedVersion: "65624845",
    mutable: false,
} as const;

// effect 4.0-beta has no `Either`/`Effect.either`; flip so a FAILURE resolves.
const tagged = { _tag: "", message: "" };
const failureOf = (eff: Effect.Effect<void, unknown>) =>
    Effect.runPromise(Effect.flip(eff)) as Promise<typeof tagged>;

// Valid-format refs so the offline PTB build succeeds without a network.
const GAS_REF = {
    objectId: "0xc866352dd2574aa14752dd09afca89cd993f573c59218ff278c3dafbd24ca714",
    version: "899787250",
    digest: "HX8AqH1bz6mMYbis95DdiBT6S2Azdtu1saMoU1NjTy1C",
};
const MINT_CAP_REF = {
    objectId: "0xa14149c2bb3c9a8cfd90166a11cf36c2d213f3a5801af464512425befa59dacb",
    version: "922646728",
    digest: "DyQgpWgw86XzBNX1bwv2YSAtx8hyJNjcMuTHLP3KGWLd",
};
const MINT_CAP_TYPE = `${STABLECOIN_PKG}::treasury::MintCap<${USDC_COIN_TYPE}>`;

type ExecArgs = { transaction: Uint8Array; signatures: readonly string[] };
const ok = {
    $kind: "Transaction",
    Transaction: {
        digest: "0xabc",
        status: { success: true, error: null },
        effects: { status: { success: true, error: null } },
    },
};
// configure result: a successful tx that created the MintCap (changedObjects).
const configureOk = {
    $kind: "Transaction",
    Transaction: {
        digest: "0xcfg",
        status: { success: true, error: null },
        effects: {
            status: { success: true, error: null },
            changedObjects: [
                { objectId: GAS_REF.objectId, inputState: "Exists", idOperation: "None" },
                {
                    objectId: MINT_CAP_REF.objectId,
                    inputState: "DoesNotExist",
                    idOperation: "Created",
                },
            ],
        },
    },
};
const revert = (msg: string) => ({
    $kind: "FailedTransaction",
    FailedTransaction: { digest: "0xbad", status: { success: false, error: { message: msg } } },
});

/** Stub the fork core. `execute` lets a test override the per-call behavior; by
 *  default the first call (configure) returns configureOk, the rest return ok. */
function stubCore(
    opts: {
        gasPresent?: boolean;
        mintCapPresent?: boolean; // does getObject(mintCap) resolve as a MintCap?
        execute?: (a: ExecArgs, callIndex: number) => Promise<unknown>;
    } = {},
): { core: ForkCore; execSpy: ReturnType<typeof vi.fn> } {
    let n = 0;
    const execSpy = vi.fn(async (a: ExecArgs) => {
        const i = n++;
        if (opts.execute) return opts.execute(a, i);
        return i === 0 ? configureOk : ok;
    });
    const core: ForkCore = {
        getObject: async ({ objectId }) => {
            if (objectId === GAS_REF.objectId && (opts.gasPresent ?? true)) {
                return { object: { ...GAS_REF, type: "0x2::coin::Coin<0x2::sui::SUI>" } };
            }
            if (objectId === MINT_CAP_REF.objectId && (opts.mintCapPresent ?? true)) {
                return { object: { ...MINT_CAP_REF, type: MINT_CAP_TYPE } };
            }
            return { object: undefined };
        },
        executeTransaction: execSpy as unknown as ForkCore["executeTransaction"],
    };
    return { core, execSpy };
}

function makeStrategy(
    core: ForkCore,
    opts?: { perRequest?: bigint; knownMintCapId?: string; fork?: object | null },
) {
    return usdcFundingStrategy({
        core,
        fork: opts?.fork === undefined ? {} : opts.fork,
        minter: MM,
        gasSponsor: SPONSOR,
        gasCoinId: GAS_REF.objectId,
        stablecoinPackage: STABLECOIN_PKG,
        treasury: TREASURY,
        denyList: DENY_LIST,
        coinType: USDC_COIN_TYPE,
        allowance: usdc(1_000_000_000),
        perRequestCap: opts?.perRequest ?? usdc(1_000_000),
        knownMintCapId: opts?.knownMintCapId,
    });
}

describe("usdcFundingStrategy", () => {
    it("happy path: configures a MintCap then mints to the recipient (sponsored, empty-sig)", async () => {
        const { core, execSpy } = stubCore();
        const strategy = makeStrategy(core);

        await Effect.runPromise(strategy.request({ address: ALICE, amount: usdc(1_000) }));

        // configure + mint = 2 empty-sig executes.
        expect(execSpy).toHaveBeenCalledTimes(2);
        expect(execSpy.mock.calls[0][0].signatures).toEqual([]);
        expect(execSpy.mock.calls[1][0].signatures).toEqual([]);
        expect(execSpy.mock.calls[1][0].transaction).toBeInstanceOf(Uint8Array);
    });

    it("reuses the MintCap: a second request mints without re-configuring", async () => {
        const { core, execSpy } = stubCore();
        const strategy = makeStrategy(core);

        await Effect.runPromise(strategy.request({ address: ALICE, amount: usdc(1_000) }));
        await Effect.runPromise(strategy.request({ address: BOB, amount: usdc(500) }));

        // configure once (call 0) + one mint per request = 3 total, not 4.
        expect(execSpy).toHaveBeenCalledTimes(3);
    });

    it("pre-known MintCap id: skips configure entirely", async () => {
        const { core, execSpy } = stubCore();
        const strategy = makeStrategy(core, { knownMintCapId: MINT_CAP_REF.objectId });

        await Effect.runPromise(strategy.request({ address: ALICE, amount: usdc(1_000) }));

        expect(execSpy).toHaveBeenCalledTimes(1); // mint only
    });

    it("per-request cap: rejects amount above the cap with FaucetBodyError (no execute)", async () => {
        const { core, execSpy } = stubCore();
        const strategy = makeStrategy(core, { perRequest: usdc(100) });

        const e = await failureOf(strategy.request({ address: ALICE, amount: usdc(101) }));
        expect(e._tag).toBe("FaucetBodyError");
        expect(e.message).toMatch(/per-request cap/);
        expect(execSpy).not.toHaveBeenCalled();
    });

    it("configure revert: FailedTransaction on configure → FaucetBodyError", async () => {
        const { core } = stubCore({
            execute: async (_a, i) => (i === 0 ? revert("already a controller") : ok),
        });
        const strategy = makeStrategy(core);

        const e = await failureOf(strategy.request({ address: ALICE, amount: usdc(1_000) }));
        expect(e._tag).toBe("FaucetBodyError");
        expect(e.message).toMatch(/configure_minter reverted/);
    });

    it("mint revert: FailedTransaction on mint → FaucetBodyError", async () => {
        const { core } = stubCore({
            execute: async (_a, i) => (i === 0 ? configureOk : revert("MintNotAllowed")),
        });
        const strategy = makeStrategy(core);

        const e = await failureOf(strategy.request({ address: ALICE, amount: usdc(1_000) }));
        expect(e._tag).toBe("FaucetBodyError");
        expect(e.message).toMatch(/mint reverted/);
    });

    it("transport failure: executeTransaction throws → FaucetUnreachable", async () => {
        const { core } = stubCore({
            execute: async () => {
                throw new Error("RpcError: fetch failed");
            },
        });
        const strategy = makeStrategy(core);

        const e = await failureOf(strategy.request({ address: ALICE, amount: usdc(1_000) }));
        expect(e._tag).toBe("FaucetUnreachable");
    });

    it("missing MintCap in configure effects → FaucetBodyError", async () => {
        // configure succeeds but creates nothing the getObject stub recognizes as a MintCap.
        const { core } = stubCore({ mintCapPresent: false });
        const strategy = makeStrategy(core);

        const e = await failureOf(strategy.request({ address: ALICE, amount: usdc(1_000) }));
        expect(e._tag).toBe("FaucetBodyError");
        expect(e.message).toMatch(/no MintCap was found/);
    });

    it("not fork mode: fork=null → FaucetBodyError", async () => {
        const { core, execSpy } = stubCore();
        const strategy = makeStrategy(core, { fork: null });

        const e = await failureOf(strategy.request({ address: ALICE, amount: usdc(1_000) }));
        expect(e._tag).toBe("FaucetBodyError");
        expect(e.message).toMatch(/fork mode/);
        expect(execSpy).not.toHaveBeenCalled();
    });
});
