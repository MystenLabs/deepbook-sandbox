import { describe, it, expect } from "vitest";
import { formatPrice } from "../../oracle-service/format-price";

describe("formatPrice", () => {
    it("formats a typical SUI price ($3.45)", () => {
        expect(formatPrice("345000000", -8)).toBe("3.45000000");
    });

    it("formats a typical DEEP price ($0.0215)", () => {
        expect(formatPrice("2150000", -8)).toBe("0.02150000");
    });

    it("formats a $1.00 price (USDC)", () => {
        expect(formatPrice("100000000", -8)).toBe("1.00000000");
    });

    it("formats zero price", () => {
        expect(formatPrice("0", -8)).toBe("0.00000000");
    });

    it("formats smallest representable price (1 unit)", () => {
        expect(formatPrice("1", -8)).toBe("0.00000001");
    });

    it("formats large price ($100)", () => {
        expect(formatPrice("10000000000", -8)).toBe("100.00000000");
    });

    it("handles expo = 0 (integer price)", () => {
        expect(formatPrice("42", 0)).toBe("42");
    });

    it("handles positive exponent (expo = 2)", () => {
        // 5 * 10^2 = 500
        expect(formatPrice("5", 2)).toBe("500.00");
    });

    it("handles negative price string", () => {
        // parseInt("-345000000") = -345000000
        // -345000000 * 10^-8 = -3.45
        expect(formatPrice("-345000000", -8)).toBe("-3.45000000");
    });

    it("handles very small exponent (high precision)", () => {
        expect(formatPrice("123456789012345", -14)).toBe("1.23456789012345");
    });
});
