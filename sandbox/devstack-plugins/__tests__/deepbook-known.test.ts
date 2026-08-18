// Unit tests for the DBSF-017 deepbook-known module: the DBSF-016 manifest
// loads, its internal invariants hold (type tags stamped with ORIGINAL package
// ids, one admin wallet for both caps), and the member factories embed the
// pinned ids. Chain interaction is covered by `pnpm verify:deepbook-member`.

import { describe, expect, it } from "vitest";

import {
    deepbookAdminAccountFromManifest,
    deepbookFromManifest,
    deepbookMarginPackagesFromManifest,
    mainnetForkDeepbookIds,
} from "../deepbook-known.ts";

const HEX_ID = /^0x[0-9a-f]{64}$/;

describe("mainnetForkDeepbookIds", () => {
    it("loads the checked-in DBSF-016 pins", () => {
        const ids = mainnetForkDeepbookIds();
        for (const pin of Object.values(ids.packages)) {
            expect(pin.originalId).toMatch(HEX_ID);
            expect(pin.latestId).toMatch(HEX_ID);
            expect(pin.latestVersion).toBeGreaterThanOrEqual(1);
        }
        expect(ids.registry.objectId).toMatch(HEX_ID);
        expect(ids.marginRegistry.objectId).toMatch(HEX_ID);
        expect(Object.keys(ids.pools)).toEqual(
            expect.arrayContaining(["DEEP_SUI", "SUI_USDC", "DEEP_USDC"]),
        );
    });

    it("type tags are stamped with the ORIGINAL package ids", () => {
        const ids = mainnetForkDeepbookIds();
        expect(ids.registry.type.startsWith(ids.packages.deepbook.originalId)).toBe(true);
        expect(ids.deepbookAdminCap.type.startsWith(ids.packages.deepbook.originalId)).toBe(true);
        expect(ids.marginRegistry.type.startsWith(ids.packages.deepbookMargin.originalId)).toBe(
            true,
        );
        expect(ids.marginAdminCap.type.startsWith(ids.packages.deepbookMargin.originalId)).toBe(
            true,
        );
    });

    it("one admin wallet holds both admin caps", () => {
        const ids = mainnetForkDeepbookIds();
        expect(ids.deepbookAdminCap.owner).toBe(ids.adminWallet);
        expect(ids.marginAdminCap.owner).toBe(ids.adminWallet);
    });

    it("throws a pointed error for a bad manifest path", () => {
        expect(() => mainnetForkDeepbookIds("/nope/definitely-missing.json")).toThrow(
            /mainnet-fork manifest not found/,
        );
    });
});

describe("member factories", () => {
    it("builds the known-mode deepbook member", () => {
        expect(deepbookFromManifest().id).toBe("deepbook/deepbook");
    });

    it("builds verify-only knownPackage members for margin + liquidation", () => {
        const { margin, liquidation } = deepbookMarginPackagesFromManifest();
        expect(margin.id).toBe("package:deepbook-margin");
        expect(liquidation.id).toBe("package:margin-liquidation");
    });

    it("builds the impersonated admin account member", () => {
        expect(deepbookAdminAccountFromManifest().id).toBe("account/deepbookAdmin");
        expect(deepbookAdminAccountFromManifest({ name: "admin2" }).id).toBe("account/admin2");
    });
});
