import { SUI_PRICE_FEED_ID, DEEP_PRICE_FEED_ID } from '../oracle-service/constants';
import type { ParsedPriceData } from '../oracle-service/types';

const PYTH_LATEST_URL = 'https://hermes.pyth.network/v2/updates/price/latest';

/**
 * Fetch the current DEEP/SUI mid price from Pyth.
 *
 * Fetches latest SUI/USD and DEEP/USD prices, then computes:
 *   midPrice = (DEEP_USD / SUI_USD) scaled to 9 decimals (SUI native units)
 *
 * @returns mid price as bigint in SUI's 9-decimal format, or null if fetch fails
 */
export async function fetchMidPrice(): Promise<bigint | null> {
	try {
		const params = new URLSearchParams();
		params.append('ids[]', SUI_PRICE_FEED_ID);
		params.append('ids[]', DEEP_PRICE_FEED_ID);
		params.append('parsed', 'true');

		const url = `${PYTH_LATEST_URL}?${params.toString()}`;
		const response = await fetch(url);

		if (!response.ok) {
			console.error(`  Pyth API error: ${response.status} ${response.statusText}`);
			return null;
		}

		const data = (await response.json()) as { parsed: ParsedPriceData[] };

		if (!data.parsed || data.parsed.length < 2) {
			console.error('  Pyth returned insufficient price data');
			return null;
		}

		// Pyth returns IDs without '0x' prefix, so strip it for comparison
		const stripPrefix = (id: string) => id.replace(/^0x/, '');
		const suiData = data.parsed.find((p) => p.id === stripPrefix(SUI_PRICE_FEED_ID));
		const deepData = data.parsed.find((p) => p.id === stripPrefix(DEEP_PRICE_FEED_ID));

		if (!suiData || !deepData) {
			console.error('  Missing SUI or DEEP price feed in Pyth response');
			return null;
		}

		const price = calculateDeepSuiPrice(deepData, suiData);
		if (price <= 0n) {
			console.error('  Pyth returned non-positive DEEP/SUI price');
			return null;
		}
		return price;
	} catch (error) {
		console.error('  Failed to fetch Pyth prices:', error);
		return null;
	}
}

/**
 * Calculate DEEP/SUI price from Pyth USD prices.
 *
 * Pyth prices are integers with an exponent: actual_price = price * 10^expo
 *
 * DEEP/SUI = (DEEP_USD_price * 10^DEEP_expo) / (SUI_USD_price * 10^SUI_expo)
 *
 * We need the result in SUI's 9-decimal format (1 SUI = 1_000_000_000):
 *   result = DEEP_price * 10^(9 + DEEP_expo - SUI_expo) / SUI_price
 */
function calculateDeepSuiPrice(
	deepData: ParsedPriceData,
	suiData: ParsedPriceData,
): bigint {
	const deepPrice = BigInt(deepData.price.price);
	const deepExpo = deepData.price.expo;
	const suiPrice = BigInt(suiData.price.price);
	const suiExpo = suiData.price.expo;

	// Scale exponent: we want 9 decimals in the output (SUI native)
	const scaledExpo = 9 + deepExpo - suiExpo;

	let result: bigint;
	if (scaledExpo >= 0) {
		result = (deepPrice * 10n ** BigInt(scaledExpo)) / suiPrice;
	} else {
		result = deepPrice / (suiPrice * 10n ** BigInt(-scaledExpo));
	}

	return result;
}
