// Unit test for the DBSF-021 production config: it composes exactly the shipped
// members (no oracle hostService / create-pool action — those are later tickets)
// and exposes the stack name the wrappers and smoke test rely on.

import { describe, expect, it } from "vitest";

import stackDef, { members, STACK } from "../devstack.config.ts";

describe("production devstack.config.ts", () => {
    it("default-exports a stack def and the production stack name", () => {
        expect(stackDef).toBeDefined();
        expect(STACK).toBe("deepbook-sandbox");
    });

    it("composes the shipped members", () => {
        const ids = members.map((m) => String(m.id));
        expect(ids).toEqual(
            expect.arrayContaining([
                "deepbook/deepbook",
                "package:deepbook-margin",
                "package:margin-liquidation",
                "account/deepWhale",
                "account/usdcMinter",
                "account/deepbookAdmin",
            ]),
        );
        // sui, whale, deepFunding, deepCoin, usdcMinter, usdcFunding, usdcCoin,
        // deepbook, margin, liquidation, admin, dashboard, wallet
        expect(members).toHaveLength(13);
    });
});
