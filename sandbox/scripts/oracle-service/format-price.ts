/**
 * Formats a Pyth price value for display.
 *
 * @param price - Integer price as string (e.g., "345000000")
 * @param expo - Exponent (e.g., -8)
 * @returns Formatted decimal string (e.g., "3.45000000")
 */
export function formatPrice(price: string, expo: number): string {
    const priceNum = Number.parseInt(price);
    const formatted = priceNum * Math.pow(10, expo);
    return formatted.toFixed(Math.abs(expo));
}
