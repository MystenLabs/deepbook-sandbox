// Unit tests for the DEEP funding strategy — driven against a stubbed fork
// `sdk.core` (no real fork; devstack ships no in-process stub substrate). Covers:
// happy-path transfer, per-request cap, session cap (incl. concurrency),
// DEEP-coin-missing, gas-coin-missing, on-chain revert, and
// transport -> FaucetUnreachable.

import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { deepFundingStrategy, DEEP_COIN_TYPE, type ForkCore } from "../deep-funding.ts";

const DONOR = "0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d";
const ALICE = "0xf53dc99e086af5405d3afd113396a351144256175ba3e8a748135ba6ab2384da";
const BOB = "0xb0b0000000000000000000000000000000000000000000000000000000000b0b";
const deep = (whole: number) => BigInt(whole) * 10n ** 6n;

// effect 4.0-beta has no `Either`/`Effect.either`; use flip so a FAILURE becomes
// a resolved value (the error) and a SUCCESS rejects.
const tagged = { _tag: "", message: "" };
const failureOf = (eff: Effect.Effect<void, unknown>) =>
    Effect.runPromise(Effect.flip(eff)) as Promise<typeof tagged>;

// Real-format refs (valid objectId/version/digest) so the offline PTB build
// inside the strategy succeeds without a network. These ids are what the
// strategy resolves by id (the fork can't enumerate coins).
const DEEP_REF = {
    objectId: "0x3b5cbb0b1bd8afd4dbbf5919e29e83a86ee99a2509c798950d07b4da3be2ded4",
    version: "899787250",
    digest: "DyQgpWgw86XzBNX1bwv2YSAtx8hyJNjcMuTHLP3KGWLd",
};
const SUI_REF = {
    objectId: "0xc866352dd2574aa14752dd09afca89cd993f573c59218ff278c3dafbd24ca714",
    version: "899787250",
    digest: "HX8AqH1bz6mMYbis95DdiBT6S2Azdtu1saMoU1NjTy1C",
};

type ExecArgs = {
    transaction: Uint8Array;
    signatures: readonly string[];
    include?: { effects?: boolean; objectTypes?: boolean };
};
// The real @mysten/sui v2 TransactionResult envelope.
const okResult = {
    $kind: "Transaction",
    Transaction: {
        digest: "0xabc",
        status: { success: true, error: null },
        effects: { status: { success: true, error: null } },
    },
};
const revertResult = {
    $kind: "FailedTransaction",
    FailedTransaction: {
        digest: "0xabc",
        status: { success: false, error: { message: "InsufficientGas" } },
        effects: { status: { success: false, error: { message: "InsufficientGas" } } },
    },
};
const okExecute = async (_a: ExecArgs): Promise<unknown> => okResult;

// Stub the fork core: getObject resolves the donor's DEEP + gas coins BY ID (the
// strategy's coin-resolution path); executeTransaction runs the impersonation.
function stubCore(opts: {
    deepCoinPresent?: boolean; // default true
    gasCoinPresent?: boolean; // default true
    execute?: (a: ExecArgs) => Promise<unknown>;
}): ForkCore {
    return {
        getObject: async ({ objectId }) => {
            if (objectId === DEEP_REF.objectId && (opts.deepCoinPresent ?? true)) {
                return { object: { ...DEEP_REF, type: `0x2::coin::Coin<${DEEP_COIN_TYPE}>` } };
            }
            if (objectId === SUI_REF.objectId && (opts.gasCoinPresent ?? true)) {
                return { object: { ...SUI_REF, type: "0x2::coin::Coin<0x2::sui::SUI>" } };
            }
            return { object: undefined }; // not found ⇒ coinRefById throws
        },
        executeTransaction: (opts.execute ?? okExecute) as ForkCore["executeTransaction"],
    };
}

function makeStrategy(
    core: ForkCore,
    caps?: { perRequest?: bigint; session?: bigint },
    session = { drawn: 0n },
) {
    return {
        strategy: deepFundingStrategy({
            core,
            fork: {}, // non-null ⇒ fork mode
            donor: DONOR,
            coinType: DEEP_COIN_TYPE,
            deepCoinId: DEEP_REF.objectId,
            gasCoinId: SUI_REF.objectId,
            perRequestCap: caps?.perRequest ?? deep(100_000),
            sessionCap: caps?.session ?? deep(10_000_000),
            session,
        }),
        session,
    };
}

describe("deepFundingStrategy", () => {
    it("happy path: funds via empty-sig execute as the donor and tracks session draw", async () => {
        const executeSpy = vi.fn(okExecute);
        const core = stubCore({ execute: executeSpy });
        const { strategy, session } = makeStrategy(core);

        await Effect.runPromise(strategy.request({ address: ALICE, amount: deep(1_000) }));

        expect(executeSpy).toHaveBeenCalledTimes(1);
        const call = executeSpy.mock.calls[0][0];
        expect(call.signatures).toEqual([]); // impersonation ⇒ empty signatures
        expect(call.transaction).toBeInstanceOf(Uint8Array);
        // the built tx is sent as the impersonated donor
        expect(TransactionDataBuilder.fromBytes(call.transaction).snapshot().sender).toBe(DONOR);
        expect(session.drawn).toBe(deep(1_000));
    });

    it("per-request cap: rejects amount above the cap with FaucetBodyError", async () => {
        const core = stubCore({});
        const { strategy, session } = makeStrategy(core, { perRequest: deep(100) });

        const e = await failureOf(strategy.request({ address: ALICE, amount: deep(101) }));
        expect(e._tag).toBe("FaucetBodyError");
        expect(e.message).toMatch(/per-request cap/);
        expect(session.drawn).toBe(0n);
    });

    it("session cap: second request that breaches the ceiling is rejected", async () => {
        const core = stubCore({});
        const { strategy, session } = makeStrategy(core, {
            perRequest: deep(100),
            session: deep(150),
        });

        await Effect.runPromise(strategy.request({ address: ALICE, amount: deep(100) }));
        const e = await failureOf(strategy.request({ address: ALICE, amount: deep(100) }));

        expect(e._tag).toBe("FaucetBodyError");
        expect(e.message).toMatch(/session draw ceiling/);
        expect(session.drawn).toBe(deep(100)); // only the first draw counts
    });

    it("session cap holds under concurrent different-recipient requests (atomic reserve)", async () => {
        const core = stubCore({});
        const session = { drawn: 0n };
        // ceiling fits exactly one 100-DEEP draw.
        const { strategy } = makeStrategy(
            core,
            { perRequest: deep(100), session: deep(100) },
            session,
        );

        const results = await Promise.all([
            Effect.runPromise(strategy.request({ address: ALICE, amount: deep(100) }))
                .then(() => "ok")
                .catch(() => "fail"),
            Effect.runPromise(strategy.request({ address: BOB, amount: deep(100) }))
                .then(() => "ok")
                .catch(() => "fail"),
        ]);

        expect(results.filter((r) => r === "ok")).toHaveLength(1); // exactly one wins
        expect(session.drawn).toBe(deep(100)); // no overshoot, no leaked reservation
    });

    it("DEEP source coin missing: getObject returns nothing → FaucetBodyError", async () => {
        const core = stubCore({ deepCoinPresent: false });
        const { strategy, session } = makeStrategy(core);

        const e = await failureOf(strategy.request({ address: ALICE, amount: deep(1_000) }));
        expect(e._tag).toBe("FaucetBodyError");
        expect(e.message).toMatch(/resolve DEEP source coin/);
        expect(e.message).toMatch(/not found/);
        expect(session.drawn).toBe(0n); // reservation rolled back
    });

    it("gas coin missing: donor's SUI coin not found → FaucetBodyError", async () => {
        const core = stubCore({ gasCoinPresent: false });
        const { strategy, session } = makeStrategy(core);

        const e = await failureOf(strategy.request({ address: ALICE, amount: deep(1_000) }));
        expect(e._tag).toBe("FaucetBodyError");
        expect(e.message).toMatch(/resolve SUI gas coin/);
        expect(session.drawn).toBe(0n); // reservation rolled back
    });

    it("transport failure: executeTransaction throws → FaucetUnreachable", async () => {
        const core = stubCore({
            execute: async () => {
                throw new Error("RpcError: fetch failed");
            },
        });
        const { strategy, session } = makeStrategy(core);

        const e = await failureOf(strategy.request({ address: ALICE, amount: deep(1_000) }));
        expect(e._tag).toBe("FaucetUnreachable");
        expect(session.drawn).toBe(0n); // reservation rolled back
    });

    it("on-chain revert: FailedTransaction result → FaucetBodyError", async () => {
        const core = stubCore({ execute: async () => revertResult });
        const { strategy, session } = makeStrategy(core);

        const e = await failureOf(strategy.request({ address: ALICE, amount: deep(1_000) }));
        expect(e._tag).toBe("FaucetBodyError");
        expect(e.message).toMatch(/reverted/);
        expect(session.drawn).toBe(0n); // reservation rolled back
    });

    it("not fork mode: fork=null → FaucetBodyError", async () => {
        const core = stubCore({});
        const strategy = deepFundingStrategy({
            core,
            fork: null,
            donor: DONOR,
            coinType: DEEP_COIN_TYPE,
            deepCoinId: DEEP_REF.objectId,
            gasCoinId: SUI_REF.objectId,
            perRequestCap: deep(100_000),
            sessionCap: deep(10_000_000),
            session: { drawn: 0n },
        });

        const e = await failureOf(strategy.request({ address: ALICE, amount: deep(1_000) }));
        expect(e._tag).toBe("FaucetBodyError");
        expect(e.message).toMatch(/fork mode/);
    });
});
