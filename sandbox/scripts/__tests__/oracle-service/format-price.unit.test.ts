import { describe, test, expect } from "vitest";
import { formatPrice } from "../../oracle-service/format-price";

describe("formatPrice", () => {
    test("formats SUI price (~$3.45) with expo -8", () => {
        expect(formatPrice("345000000", -8)).toBe("3.45000000");
    });

    test("formats DEEP price (~$0.02) with expo -8", () => {
        expect(formatPrice("2000000", -8)).toBe("0.02000000");
    });

    test("formats USDC price (~$1.00) with expo -8", () => {
        expect(formatPrice("100000000", -8)).toBe("1.00000000");
    });

    test("formats with expo -6", () => {
        expect(formatPrice("345000", -6)).toBe("0.345000");
    });

    test("formats with expo -4", () => {
        expect(formatPrice("3450", -4)).toBe("0.3450");
    });

    test("handles zero price", () => {
        expect(formatPrice("0", -8)).toBe("0.00000000");
    });

    test("handles large numbers", () => {
        expect(formatPrice("10000000000000", -8)).toBe("100000.00000000");
    });
});
