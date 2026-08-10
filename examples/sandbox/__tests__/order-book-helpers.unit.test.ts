/**
 * Unit tests for the order-book helpers in setup.ts.
 *
 * These exist because two properties below are invisible to any end-to-end run,
 * no matter how many times it executes the examples:
 *
 *   1. Which side of the book `waitForLiquidity` checks. The sandbox market maker
 *      posts bids and asks in the SAME transaction, so depth on one side always
 *      implies depth on the other. An inverted ternary still returns, the order
 *      still fills, and a live run cannot tell correct code from broken code.
 *
 *   2. Whether `isEmptyCommandResultError` still recognises the SDK's failure. It
 *      matches the text of a V8 TypeError, not an SDK contract. If a future
 *      @mysten/deepbook-v3 throws something else, the retry silently stops working
 *      and SEDEFI-440 regresses. The empty-book window is ~1s in 13, so CI would
 *      go intermittent rather than red — which reads as flakiness and gets ignored.
 *
 * Everything here runs against a stubbed client. No chain, no container, no network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    getBookTicks,
    getMidPrice,
    isEmptyCommandResultError,
    waitForLiquidity,
} from "../setup.js";
import type { SandboxClient } from "../setup.js";

// Mirrors BOOK_RETRY_ATTEMPTS / BOOK_RETRY_DELAY_MS in setup.ts. If those change,
// these must change too — that coupling is deliberate, so the budget cannot drift
// without a test failing and forcing a look.
const ATTEMPTS = 30;
const DELAY_MS = 500;
const FULL_BUDGET_MS = ATTEMPTS * DELAY_MS;

/** The exact error the SDK raises when a simulation returns no command result. */
const SDK_EMPTY = () =>
    new TypeError("Cannot read properties of undefined (reading 'returnValues')");

type Ticks = {
    bid_prices: number[];
    bid_quantities: number[];
    ask_prices: number[];
    ask_quantities: number[];
};

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
    ticks?: Ticks | (() => Ticks);
    getLevel2TicksFromMid?: ReturnType<typeof vi.fn>;
    midPrice?: ReturnType<typeof vi.fn>;
}) {
    const ticksFn =
        opts.getLevel2TicksFromMid ??
        vi.fn(async () =>
            typeof opts.ticks === "function" ? opts.ticks() : (opts.ticks ?? EMPTY),
        );
    const midPriceFn = opts.midPrice ?? vi.fn(async () => 1.45);

    const client = {
        deepbook: { getLevel2TicksFromMid: ticksFn, midPrice: midPriceFn },
    } as unknown as SandboxClient;

    return { client, ticksFn, midPriceFn };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("isEmptyCommandResultError", () => {
    it("recognises the SDK's empty-simulation TypeError", () => {
        // The drift detector. If this ever fails, the SDK changed its error and
        // the whole retry mechanism has stopped working.
        expect(isEmptyCommandResultError(SDK_EMPTY())).toBe(true);
    });

    it("recognises the narrower `reading '0'` variant", () => {
        // Raised instead when commandResults itself is undefined rather than [].
        expect(
            isEmptyCommandResultError(
                new TypeError("Cannot read properties of undefined (reading '0')"),
            ),
        ).toBe(true);
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
    });

    it("returns for 'bid' when only the bid side has depth", async () => {
        const { client, ticksFn } = stubClient({ ticks: BIDS_ONLY });
        await expect(waitForLiquidity(client, "DEEP_SUI", "bid")).resolves.toBeUndefined();
        expect(ticksFn).toHaveBeenCalledTimes(1);
    });

    it("keeps waiting for 'ask' while only the bid side has depth", async () => {
        // The inverse of the test above: the wrong side being full must NOT satisfy it.
        vi.useFakeTimers();
        const { client } = stubClient({ ticks: BIDS_ONLY });

        const promise = waitForLiquidity(client, "DEEP_SUI", "ask");
        const assertion = expect(promise).rejects.toThrow(/No ask liquidity on DEEP_SUI/);
        await vi.advanceTimersByTimeAsync(FULL_BUDGET_MS);
        await assertion;
    });

    it("rethrows a real fault instead of swallowing it", async () => {
        // getLevel2TicksFromMid has no empty-book assert on-chain — it returns empty
        // vectors. So any throw here is a genuine fault (stale manifest, wrong pool
        // id) and must reach the caller immediately, not be retried for 15s.
        const boom = SDK_EMPTY();
        const ticksFn = vi.fn(async () => {
            throw boom;
        });
        const { client } = stubClient({ getLevel2TicksFromMid: ticksFn });

        await expect(waitForLiquidity(client, "DEEP_SUI", "ask")).rejects.toBe(boom);
        expect(ticksFn).toHaveBeenCalledTimes(1);
    });

    it("gives up after the full budget and names the side and pool", async () => {
        vi.useFakeTimers();
        const { client, ticksFn } = stubClient({ ticks: EMPTY });

        const promise = waitForLiquidity(client, "DEEP_SUI", "ask");
        const assertion = expect(promise).rejects.toThrow(/No ask liquidity on DEEP_SUI/);
        await vi.advanceTimersByTimeAsync(FULL_BUDGET_MS);
        await assertion;

        // 30 attempts, 29 sleeps between them — the classic off-by-one location.
        expect(ticksFn).toHaveBeenCalledTimes(ATTEMPTS);
    });
});

// ---------------------------------------------------------------------------

describe("getMidPrice", () => {
    it("returns the first reading without sleeping", async () => {
        const { client, midPriceFn } = stubClient({ midPrice: vi.fn(async () => 1.25) });
        await expect(getMidPrice(client, "DEEP_SUI")).resolves.toBe(1.25);
        expect(midPriceFn).toHaveBeenCalledTimes(1);
    });

    it("rethrows a non-empty-result error unchanged", async () => {
        // Asserted by identity, not by message: proves the error is not re-wrapped,
        // so the caller still sees the original stack.
        const boom = new Error("14 UNAVAILABLE: No connection established");
        const midPrice = vi.fn(async () => {
            throw boom;
        });
        const { client } = stubClient({ midPrice, ticks: EMPTY });

        await expect(getMidPrice(client, "DEEP_SUI")).rejects.toBe(boom);
        expect(midPrice).toHaveBeenCalledTimes(1);
    });

    it("fast-fails when the book has both sides — the fault is real, not an empty book", async () => {
        // Blind spot 2's companion. A stale manifest raises the SAME TypeError as an
        // empty book, so without this confirmation step it would be retried for the
        // whole budget and then misreported as a market-maker problem.
        const boom = SDK_EMPTY();
        const midPrice = vi.fn(async () => {
            throw boom;
        });
        const { client, ticksFn } = stubClient({ midPrice, ticks: TWO_SIDED });

        await expect(getMidPrice(client, "DEEP_SUI")).rejects.toBe(boom);
        expect(midPrice).toHaveBeenCalledTimes(1);
        expect(ticksFn).toHaveBeenCalledTimes(1);
    });

    it("retries while the book is one-sided, then returns the later reading", async () => {
        vi.useFakeTimers();
        const midPrice = vi
            .fn<() => Promise<number>>()
            .mockRejectedValueOnce(SDK_EMPTY())
            .mockResolvedValueOnce(1.75);
        const { client } = stubClient({ midPrice, ticks: ASKS_ONLY });

        const promise = getMidPrice(client, "DEEP_SUI");
        await vi.advanceTimersByTimeAsync(DELAY_MS);

        await expect(promise).resolves.toBe(1.75);
        expect(midPrice).toHaveBeenCalledTimes(2);
    });

    it("gives up after the full budget, naming the pool and preserving the cause", async () => {
        vi.useFakeTimers();
        const boom = SDK_EMPTY();
        const midPrice = vi.fn(async () => {
            throw boom;
        });
        const { client } = stubClient({ midPrice, ticks: ASKS_ONLY });

        const promise = getMidPrice(client, "DEEP_SUI");
        const captured = promise.catch((err: unknown) => err);
        await vi.advanceTimersByTimeAsync(FULL_BUDGET_MS);

        const err = (await captured) as Error;
        expect(err.message).toContain("DEEP_SUI");
        expect(err.message).toContain(`${ATTEMPTS} attempts`);
        // The cause chain is what the examples print; losing it strands the real error.
        expect(err.cause).toBe(boom);
        expect(midPrice).toHaveBeenCalledTimes(ATTEMPTS);
    });
});

// ---------------------------------------------------------------------------

describe("getBookTicks", () => {
    it("returns immediately when either side has depth", async () => {
        const { client, ticksFn } = stubClient({ ticks: BIDS_ONLY });
        await expect(getBookTicks(client, "DEEP_SUI", 5)).resolves.toEqual(BIDS_ONLY);
        expect(ticksFn).toHaveBeenCalledTimes(1);
    });

    it("returns null when the book stays empty for the whole budget", async () => {
        // A rebalance empties BOTH sides, so a single read can catch a healthy
        // sandbox mid-cycle. Null means it never recovered — a real failure.
        vi.useFakeTimers();
        const { client, ticksFn } = stubClient({ ticks: EMPTY });

        const promise = getBookTicks(client, "DEEP_SUI", 5);
        await vi.advanceTimersByTimeAsync(FULL_BUDGET_MS);

        await expect(promise).resolves.toBeNull();
        expect(ticksFn).toHaveBeenCalledTimes(ATTEMPTS);
    });

    it("recovers when the book fills partway through the budget", async () => {
        vi.useFakeTimers();
        let calls = 0;
        const ticksFn = vi.fn(async () => {
            calls++;
            return calls < 3 ? EMPTY : TWO_SIDED;
        });
        const { client } = stubClient({ getLevel2TicksFromMid: ticksFn });

        const promise = getBookTicks(client, "DEEP_SUI", 5);
        await vi.advanceTimersByTimeAsync(DELAY_MS * 2);

        await expect(promise).resolves.toEqual(TWO_SIDED);
        expect(ticksFn).toHaveBeenCalledTimes(3);
    });
});
