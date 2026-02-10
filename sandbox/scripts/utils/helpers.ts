import type { SuiClient } from "@mysten/sui/client";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import type { DeploymentResult } from "./deployer";

const ONE_SUI_MIST = BigInt(1_000_000_000);

/** Request from faucet with retries (helps with localnet ECONNRESET until faucet is stable). */
export async function requestFaucetWithRetry(
	host: string,
	recipient: string,
	maxRetries = 3,
): Promise<void> {
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			await requestSuiFromFaucetV2({ host, recipient });
			return;
		} catch (error) {
			if (attempt === maxRetries) break;
			const delay = 3000 * attempt;
			console.log(`  Faucet attempt ${attempt} failed, retrying in ${delay / 1000}s...`);
			await new Promise((r) => setTimeout(r, delay));
		}
	}

	throw new Error(
		`Faucet failed after ${maxRetries} retries and recipient balance is below 1 SUI. Cannot continue.`,
	);
}

/** Check balance first; only request faucet if below min. If we request and faucet fails, throw. */
export async function ensureMinimumBalance(
	client: SuiClient,
	recipient: string,
	faucetHost: string,
	minSuiMist: bigint = ONE_SUI_MIST,
	maxFaucetRetries = 3,
): Promise<void> {
	const { totalBalance } = await client.getBalance({ owner: recipient });
	const balanceMist = BigInt(totalBalance);
	if (balanceMist >= minSuiMist) {
		console.log(`  ✅ Has sufficient balance (≥1 SUI)\n`);
		return;
	}
	await requestFaucetWithRetry(faucetHost, recipient, maxFaucetRetries);
	await new Promise((r) => setTimeout(r, 2000));
	const after = await client.getBalance({ owner: recipient });
	console.log(`  ✅ Has ${after.totalBalance} MIST balance\n`);
}

/**
 * Wait for the deepbook publish tx, get its checkpoint, find ProtectedTreasury ID,
 * and return env vars for testnet (indexer + server). Used before Phase 4.
 */
export async function getDeploymentEnv(
	client: SuiClient,
	deepbookResult: DeploymentResult,
): Promise<Record<string, string>> {
	await client.waitForTransaction({ digest: deepbookResult.transactionDigest });
	const tx = await client.getTransactionBlock({
		digest: deepbookResult.transactionDigest,
		options: {},
	});
	const firstCheckpoint = tx.checkpoint ?? '';

	const treasuryObj = deepbookResult.createdObjects.find((obj) =>
		obj.objectType.includes('ProtectedTreasury'),
	);
	const deepTreasuryId = treasuryObj?.objectId ?? '';

  const env: Record<string, string> = {
    DEEPBOOK_PACKAGE_ID: deepbookResult.packageId,
    DEEP_TOKEN_PACKAGE_ID: deepbookResult.packageId,
    DEEP_TREASURY_ID: deepTreasuryId,
  };
  if (firstCheckpoint) env.FIRST_CHECKPOINT = firstCheckpoint;
  return env;
}
