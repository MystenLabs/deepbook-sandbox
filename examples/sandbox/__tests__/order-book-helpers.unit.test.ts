/**
 * Unit tests for the order-book helpers in setup.ts.
 *
 * These exist because three properties are invisible to any end-to-end run, no
 * matter how many times it executes the examples:
 *
 *   1. Which side of the book `waitForLiquidity` checks. The sandbox market maker
 *      posts bids and asks in the SAME transaction, so depth on one side always
 *      implies depth on the other. An inverted ternary still returns, the order
 *      still fills, and a live run cannot tell correct code from broken code.
 *
 *   2. How long the retry budget actually is. A budget collapsed to near-zero
 *      still passes every example run on a healthy sandbox — it only shows up as
 *      the SEDEFI-440 flake returning, roughly one run in twelve, which reads as
 *      flaky CI and gets ignored. The elapsed-time assertions below pin it.
 *
 *   3. That the classifier stays NARROW. Broadening it silently converts a stale
 *      manifest or a wrong pool id into "the market maker is not quoting", after
 *      a pointless 15s wait.
 *
 * What these tests canNOT do: notice that the SDK changed its error. The strings
 * below are written here, not imported from the SDK, so a real upstream change
 * breaks production while these stay green. They pin the classifier's contract,
 * nothing more. The e2e job is where an SDK change would actually surface.
 *
 * Everything here runs against a stubbed client. No chain, no container, no network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeepBookClient, Level2TicksFromMid } from "@mysten/deepbook-v3";

import {
    getBookTicks,
    getMidPrice,
    isEmptyCommandResultError,
    waitForLiquidity,
} from "../setup.js";
import type { SandboxClient } from "../setup.js";

// Mirrors BOOK_RETRY_ATTEMPTS / BOOK_RETRY_DELAY_MS in setup.ts. Both the attempt
// count and the delay are asserted below, so neither can drift without a failure.
const ATTEMPTS = 30;
const DELAY_MS = 500;
// N attempts sleep N-1 times — the classic off-by-one, and the reason the helpers
// report measured elapsed time rather than ATTEMPTS * DELAY_MS.
const EXPECTED_ELAPSED = (((ATTEMPTS - 1) * DELAY_MS) / 1000).toFixed(1);

/** The error the SDK raises today when a simulation returns no command result. */
const SDK_EMPTY = () =>
    new TypeError("Cannot read properties of undefined (reading 'returnValues')");

// Using the SDK's own type means a field rename upstream fails `pnpm typecheck`,
// which is the closest this suite gets to genuine drift detection.
type Ticks = Level2TicksFromMid;

const EMPTY: Ticks = { bid_prices: [], bid_quantities: [], ask_prices: [], ask_quantities: [] };
const ASKS_ONLY: Ticks = {
    bid_prices: [],
    bid_quantities: [],
    ask_prices: [1.5],
    ask_quantities: [10],
};
const BIDS_ONLY: Ticks = {
    bid_prices: [1.4],
    bid_quantities: [10],
    ask_prices: [],
    ask_quantities: [],
};
const TWO_SIDED: Ticks = {
    bid_prices: [1.4],
    bid_quantities: [10],
    ask_prices: [1.5],
    ask_quantities: [10],
};

/** Minimal stub of the two SDK queries the helpers touch. */
function stubClient(opts: {
    ticks?: Ticks;
    getLevel2TicksFromMid?: DeepBookClient["getLevel2TicksFromMid"];
    midPrice?: DeepBookClient["midPrice"];
}) {
    const ticksFn = vi.fn(opts.getLevel2TicksFromMid ?? (async () => opts.ticks ?? EMPTY));
    const midPriceFn = vi.fn(opts.midPrice ?? (async () => 1.45));

    const client = {
        deepbook: { getLevel2TicksFromMid: ticksFn, midPrice: midPriceFn },
    } as unknown as SandboxClient;

    return { client, ticksFn, midPriceFn };
}

afterEach(() => {
    // Order matters: drop any timer still pending from a failed run before
    // switching back to real ones, so it cannot fire into the next test.
    vi.clearAllTimers();
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("isEmptyCommandResultError", () => {
    it("matches the SDK's empty-simulation TypeError", () => {
        expect(isEmptyCommandResultError(SDK_EMPTY())).toBe(true);
    });

    it("matches the narrower `reading '0'` variant", () => {
        // Raised instead when commandResults itself is undefined rather than [].
        expect(
            isEmptyCommandResultError(
                new TypeError("Cannot read properties of undefined (reading '0')"),
            ),
        ).toBe(true);
    });

    it("does not match an unrelated missing-property TypeError", () => {
        // The near miss, and the one that matters most. Only commandResults[0] and
        // .returnValues mean "empty simulation". Broadening the regex to something
        // like /Cannot read properties/ would make every missing-property fault
        // look like an empty book: retried for 15s, then blamed on the maker.
        expect(
            isEmptyCommandResultError(
                new TypeError("Cannot read properties of undefined (reading 'digest')"),
            ),
        ).toBe(false);
    });

    it("does not match a transport error", () => {
        expect(
            isEmptyCommandResultError(new Error("14 UNAVAILABLE: No connection established")),
        ).toBe(false);
    });

    it("does not match non-Error values", () => {
        // The bare string proves the `instanceof Error` guard does real work: the
        // text matches the regex, but it is not an Error.
        expect(isEmptyCommandResultError("returnValues")).toBe(false);
        expect(isEmptyCommandResultError({ message: "returnValues" })).toBe(false);
        expect(isEmptyCommandResultError(undefined)).toBe(false);
        expect(isEmptyCommandResultError(null)).toBe(false);
    });
});

// ---------------------------------------------------------------------------

describe("waitForLiquidity", () => {
    it("returns for 'ask' when only the ask side has depth", async () => {
        // Blind spot 1. A live sandbox cannot distinguish this from the inverted
        // ternary, because it never serves a one-sided book on demand.
        const { client, ticksFn } = stubClient({ ticks: ASKS_ONLY });
        await expect(waitForLiquidity(client, "DEEP_SUI", "ask")).resolves.toBeUndefined();
        expect(ticksFn).toHaveBeenCalledTimes(1);
        expect(ticksFn).toHaveBeenCalledWith("DEEP_SUI", 30);
    });

    it("returns for 'bid' when only the bid side has depth", async () => {
        const { client, ticksFn } = stubClient({ ticks: BIDS_ONLY });
        await expect(waitForLiquidity(client, "DEEP_SUI", "bid")).resolves.toBeUndefined();
        expect(ticksFn).toHaveBeenCalledTimes(1);
    });

    it("keeps waiting for 'ask' while only the bid side has depth", async () => {
        // The inverse of the pair above: the wrong side being full must NOT satisfy it.
        vi.useFakeTimers();
        const { client } = stubClient({ ticks: BIDS_ONLY });

        const settled = waitForLiquidity(client, "DEEP_SUI", "ask").catch((e: unknown) => e);
        await vi.runAllTimersAsync();

        expect((await settled) as Error).toMatchObject({
            message: expect.stringMatching(/No ask liquidity on DEEP_SUI/),
        });
    });

    it("recovers when the side fills partway through the budget", async () => {
        // The real SEDEFI-440 scenario: empty during a rebalance, then quoting again.
        vi.useFakeTimers();
        let calls = 0;
        const { client, ticksFn } = stubClient({
            getLevel2TicksFromMid: async () => (++calls < 3 ? EMPTY : ASKS_ONLY),
        });

        const settled = waitForLiquidity(client, "DEEP_SUI", "ask").catch((e: unknown) => e);
        await vi.runAllTimersAsync();

        expect(await settled).toBeUndefined();
        expect(ticksFn).toHaveBeenCalledTimes(3);
    });

    it("rethrows a real fault instead of swallowing it", async () => {
        // getLevel2TicksFromMid has no empty-book assert on-chain — it returns empty
        // vectors. So any throw here is a genuine fault (stale manifest, wrong pool
        // id) and must reach the caller at once, not be retried for the full budget.
        //
        // Fake timers matter here: if this regresses into retrying, the drain below
        // ends the loop and the call-count assertion reports it, instead of the test
        // hanging to a 10s timeout that says nothing about the cause.
        vi.useFakeTimers();
        const boom = SDK_EMPTY();
        const { client, ticksFn } = stubClient({
            getLevel2TicksFromMid: async () => {
                throw boom;
            },
        });

        const settled = waitForLiquidity(client, "DEEP_SUI", "ask").catch((e: unknown) => e);
        await vi.runAllTimersAsync();

        expect(await settled).toBe(boom);
        expect(ticksFn).toHaveBeenCalledTimes(1);
    });

    it("gives up after the full budget, and the budget is the documented length", async () => {
        vi.useFakeTimers();
        const { client, ticksFn } = stubClient({ ticks: EMPTY });

        const settled = waitForLiquidity(client, "DEEP_SUI", "ask").catch((e: unknown) => e);
        await vi.runAllTimersAsync();

        const err = (await settled) as Error;
        expect(err.message).toContain("No ask liquidity on DEEP_SUI");
        // Pins the DELAY, not just the attempt count. Without this, shrinking
        // BOOK_RETRY_DELAY_MS — or making sleep a no-op — passes every test while
        // collapsing the budget below the ~13s empty-book window.
        expect(err.message).toContain(`${EXPECTED_ELAPSED}s`);
        expect(ticksFn).toHaveBeenCalledTimes(ATTEMPTS);
    });
});

// ---------------------------------------------------------------------------

describe("getMidPrice", () => {
    it("returns the first reading without sleeping", async () => {
        const { client, midPriceFn } = stubClient({ midPrice: async () => 1.25 });
        await expect(getMidPrice(client, "DEEP_SUI")).resolves.toBe(1.25);
        expect(midPriceFn).toHaveBeenCalledTimes(1);
    });

    it("rethrows a non-empty-result error unchanged", async () => {
        // Asserted by identity, not by message: proves the error is not re-wrapped,
        // so the caller still sees the original stack.
        vi.useFakeTimers();
        const boom = new Error("14 UNAVAILABLE: No connection established");
        const { client, midPriceFn } = stubClient({
            midPrice: async () => {
                throw boom;
            },
            ticks: EMPTY,
        });

        const settled = getMidPrice(client, "DEEP_SUI").catch((e: unknown) => e);
        await vi.runAllTimersAsync();

        expect(await settled).toBe(boom);
        expect(midPriceFn).toHaveBeenCalledTimes(1);
    });

    it("fast-fails when the book has both sides — the fault is real, not an empty book", async () => {
        // The most valuable behaviour in the file. A stale manifest raises the SAME
        // TypeError as an empty book, so without the confirmation step it would be
        // retried for the whole budget and then misreported as a maker problem.
        vi.useFakeTimers();
        const boom = SDK_EMPTY();
        const { client, midPriceFn, ticksFn } = stubClient({
            midPrice: async () => {
                throw boom;
            },
            ticks: TWO_SIDED,
        });

        const settled = getMidPrice(client, "DEEP_SUI").catch((e: unknown) => e);
        await vi.runAllTimersAsync();

        expect(await settled).toBe(boom);
        expect(midPriceFn).toHaveBeenCalledTimes(1);
        expect(ticksFn).toHaveBeenCalledTimes(1);
    });

    it("retries while the book is one-sided, then returns the later reading", async () => {
        vi.useFakeTimers();
        let calls = 0;
        const { client, midPriceFn } = stubClient({
            midPrice: async () => {
                if (++calls === 1) throw SDK_EMPTY();
                return 1.75;
            },
            ticks: ASKS_ONLY,
        });

        const settled = getMidPrice(client, "DEEP_SUI").catch((e: unknown) => e);
        await vi.runAllTimersAsync();

        expect(await settled).toBe(1.75);
        expect(midPriceFn).toHaveBeenCalledTimes(2);
    });

    it("gives up after the full budget, naming the pool, the length and the cause", async () => {
        vi.useFakeTimers();
        const boom = SDK_EMPTY();
        const { client, midPriceFn } = stubClient({
            midPrice: async () => {
                throw boom;
            },
            ticks: ASKS_ONLY,
        });

        const settled = getMidPrice(client, "DEEP_SUI").catch((e: unknown) => e);
        await vi.runAllTimersAsync();

        const err = (await settled) as Error;
        expect(err.message).toContain("DEEP_SUI");
        expect(err.message).toContain(`${ATTEMPTS} attempts`);
        expect(err.message).toContain(`${EXPECTED_ELAPSED}s`);
        // The cause chain is what the examples print; losing it strands the real error.
        expect(err.cause).toBe(boom);
        expect(midPriceFn).toHaveBeenCalledTimes(ATTEMPTS);
    });
});

// ---------------------------------------------------------------------------

describe("getBookTicks", () => {
    it("returns immediately when either side has depth", async () => {
        const { client, ticksFn } = stubClient({ ticks: BIDS_ONLY });
        await expect(getBookTicks(client, "DEEP_SUI", 5)).resolves.toEqual(BIDS_ONLY);
        expect(ticksFn).toHaveBeenCalledTimes(1);
        // The caller's tick count must reach the SDK, not a hard-coded one.
        expect(ticksFn).toHaveBeenCalledWith("DEEP_SUI", 5);
    });

    it("returns null after the full budget, having actually waited it out", async () => {
        // A rebalance empties BOTH sides, so a single read can catch a healthy
        // sandbox mid-cycle. Null means it never recovered — a real failure.
        vi.useFakeTimers();
        const startedAt = Date.now();
        const { client, ticksFn } = stubClient({ ticks: EMPTY });

        const settled = getBookTicks(client, "DEEP_SUI", 5).catch((e: unknown) => e);
        await vi.runAllTimersAsync();

        expect(await settled).toBeNull();
        expect(ticksFn).toHaveBeenCalledTimes(ATTEMPTS);
        // getBookTicks returns null with no message, so the clock is the only place
        // the budget is observable. Without this the delay is unprotected here too.
        expect(Date.now() - startedAt).toBe((ATTEMPTS - 1) * DELAY_MS);
    });

    it("recovers when the book fills partway through the budget", async () => {
        vi.useFakeTimers();
        let calls = 0;
        const { client, ticksFn } = stubClient({
            getLevel2TicksFromMid: async () => (++calls < 3 ? EMPTY : TWO_SIDED),
        });

        const settled = getBookTicks(client, "DEEP_SUI", 5).catch((e: unknown) => e);
        await vi.runAllTimersAsync();

        expect(await settled).toEqual(TWO_SIDED);
        expect(ticksFn).toHaveBeenCalledTimes(3);
    });
});
