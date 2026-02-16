const MAX_RETRIES = 3;

/**
 * Proxies SUI token requests to the upstream Sui faucet.
 * Localnet: sui-localnet:9123, Testnet: faucet.testnet.sui.io/v2
 * Retries on 429 using the wait time from the response body.
 */
export async function requestSui(
    faucetUrl: string,
    recipient: string,
): Promise<{ success: boolean; error?: string }> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const response = await fetch(`${faucetUrl}/gas`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                FixedAmountRequest: { recipient },
            }),
        });

        if (response.ok) {
            return { success: true };
        }

        const text = await response.text();

        if (response.status === 429 && attempt < MAX_RETRIES) {
            const waitSecs = Math.max(parseWaitSeconds(text) ?? 3, 1);
            await sleep(waitSecs * 1000);
            continue;
        }

        return { success: false, error: `Sui faucet error: ${response.status} - ${text}` };
    }

    return { success: false, error: "Sui faucet error: max retries exceeded" };
}

/** Extracts the wait duration (in seconds) from a body like "Too Many Requests! Wait for 3s" */
function parseWaitSeconds(body: string): number | undefined {
    const match = body.match(/(\d+)s/);
    return match ? Number(match[1]) : undefined;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
