/**
 * Proxies SUI token requests to the upstream Sui faucet.
 * Localnet: sui-localnet:9123, Testnet: faucet.testnet.sui.io
 */
export async function requestSui(
	faucetUrl: string,
	recipient: string,
): Promise<{ success: boolean; error?: string }> {
	const response = await fetch(`${faucetUrl}/gas`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			FixedAmountRequest: { recipient },
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		return { success: false, error: `Sui faucet error: ${response.status} - ${text}` };
	}

	return { success: true };
}
