import type { SuiClient } from '@mysten/sui/client';
import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import type { DeploymentResult } from './deployer';
import { getRpcUrl } from './config';

export type DeploymentEnvOptions = { firstCheckpoint?: string };

const ONE_SUI_MIST = BigInt(1_000_000_000);

/** Request from faucet with retries (helps with localnet ECONNRESET until faucet is stable). */
export async function requestFaucetWithRetry(
	host: string,
	recipient: string,
	maxRetries = 3,
	client: SuiClient,
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
	await requestFaucetWithRetry(faucetHost, recipient, maxFaucetRetries, client);
	await new Promise((r) => setTimeout(r, 2000));
	const after = await client.getBalance({ owner: recipient });
	console.log(`  ✅ Has ${after.totalBalance} MIST balance\n`);
}

/**
 * Build env vars for indexer/server from deployment results. All IDs come from the
 * deployment map. Pass firstCheckpoint from the caller if needed (e.g.
 * fetch token tx once in deploy-all for testnet).
 */
export function getDeploymentEnv(
	deployedPackages: Map<string, DeploymentResult>,
	options?: DeploymentEnvOptions,
): Record<string, string> {
	const token = deployedPackages.get('token');
	const deepbook = deployedPackages.get('deepbook');
	const margin = deployedPackages.get('deepbook_margin');

	const treasuryObj = token.createdObjects.find((obj) =>
		obj.objectType.includes('ProtectedTreasury'),
	);
	const deepTreasuryId = treasuryObj?.objectId ?? '';

	const env: Record<string, string> = {
		DEEPBOOK_PACKAGE_ID: deepbook.packageId,
		DEEP_TOKEN_PACKAGE_ID: token.packageId,
		DEEP_TREASURY_ID: deepTreasuryId,
		MARGIN_PACKAGE_ID: margin.packageId,
		RPC_URL: getRpcUrl(),
	};
	if (options?.firstCheckpoint) {
		env.FIRST_CHECKPOINT = options.firstCheckpoint;
	}
	return env;
}
