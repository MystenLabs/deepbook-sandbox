// Starter unit test for the Exercise 3 skeleton.
//
// It passes as shipped, on purpose: the point is that a plugin's WIRING is
// testable with no Docker, no fork and no database. `definePlugin` hands back
// a plain inspectable object, so the decisions you make in
// analytics-member.ts — role, section, which edges you declared — are
// assertable facts, and the factory's config validation runs before any
// dependency is dereferenced (which is why `{} as never` stubs are enough).
//
// Real precedent in this package: __tests__/clock-driver.test.ts stubs its
// deps the same way, and __tests__/production-config.test.ts asserts the whole
// stack's member ids without booting anything.
//
// The two it.todo()s below are your job. Vitest reports them as pending, so
// they will keep nagging you until you write them.

import { describe, expect, it } from "vitest";

import { analyticsMember } from "./analytics-member.ts";

/** No dependency is dereferenced at config time, so opaque stubs are enough. */
const suiRef = {} as never;
const makeMember = () => analyticsMember({ sui: suiRef });

describe("analyticsMember wiring", () => {
    it("declares a stable id", () => {
        expect(String(makeMember().id)).toBe("analytics");
    });

    it("declares a role and section from the allowed unions", () => {
        const plugin = makeMember();
        // These are the COMPLETE unions devstack accepts. If your answer to
        // TODO(2)/TODO(3) is not in here, it is not a valid answer.
        expect(["service", "task"]).toContain(plugin.role);
        expect(["service", "package", "account", "action", "app", "other"]).toContain(
            plugin.section,
        );
    });

    it("registers the dependency edges it declared", () => {
        // `dependsOn` is normalised to a flat array of refs on the returned
        // plugin, whatever form you declared it in. Adding an option to
        // AnalyticsOptions does NOT create an edge — this is what proves it.
        expect(makeMember().dependsOn).toContain(suiRef);
    });

    // TODO: prove your schema setup is idempotent — run it twice against the
    // same store and assert the row count did not double. This is the check
    // the exercise brief calls out, and the one you cannot eyeball.
    it.todo("does not duplicate rows when applied twice");

    // TODO: prove you actually record something — feed your recording function
    // a fixture of what you read (a fill, a price) and assert what lands in
    // the store. Keep that function pure and exported, the way clock-driver.ts
    // exports `makeClockSync`, so this test never needs a live chain.
    it.todo("records a fill it is given");
});
