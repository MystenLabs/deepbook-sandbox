import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet';

/** Request from faucet with retries (helps with localnet ECONNRESET until faucet is stable). */
export async function requestFaucetWithRetry(
	host: string,
	recipient: string,
	maxRetries = 5,
): Promise<void> {
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			await requestSuiFromFaucetV2({ host, recipient });
			return;
		} catch (error) {
			if (attempt === maxRetries) throw error;
			const delay = 3000 * attempt;
			console.log(`  Faucet attempt ${attempt} failed, retrying in ${delay / 1000}s...`);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}
