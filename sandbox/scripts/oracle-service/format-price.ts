/**
 * Formats a Pyth price integer + exponent into a human-readable decimal string.
 *
 * @example formatPrice("345000000", -8) → "3.45000000"
 * @example formatPrice("2150000", -8)   → "0.02150000"
 */
export function formatPrice(price: string, expo: number): string {
    const priceNum = Number.parseInt(price);
    const formatted = priceNum * Math.pow(10, expo);
    return formatted.toFixed(Math.abs(expo));
}
