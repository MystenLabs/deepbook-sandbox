import type { SuiClient } from '@mysten/sui/client';
import type { Keypair } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import type {
	SuiObjectChangeCreated,
	SuiTransactionBlockResponse,
} from '@mysten/sui/client';
import type { DeploymentResult } from './deployer';

export interface PoolInfo {
	poolId: string;
	transactionDigest: string;
	result: SuiTransactionBlockResponse;
}

export class PoolCreator {
	constructor(
		private client: SuiClient,
		private signer: Keypair,
		private faucetUrl: string,
	) {}

	async requestSuiFromFaucet(address?: string): Promise<void> {
		const recipient = address || (this.signer.getPublicKey().toSuiAddress());

		console.log(`    Requesting SUI for ${recipient}...`);

		const response = await fetch(`${this.faucetUrl}/gas`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				FixedAmountRequest: {
					recipient,
				},
			}),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Faucet request failed: ${response.statusText} - ${text}`);
		}

		// Wait for transaction to be processed
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}

	async createPool(
		deployedPackages: Map<string, DeploymentResult>,
	): Promise<PoolInfo> {
		
		const tokenPkg = deployedPackages.get('token');
		const deepbookPkg = deployedPackages.get('deepbook');

		if (!deepbookPkg) {
			throw new Error('Missing required packages');
		}

		// Find Registry and AdminCap objects
		const registry = this.findObjectByType(deepbookPkg.createdObjects, 'Registry');
		const adminCap = this.findObjectByType(deepbookPkg.createdObjects, 'DeepbookAdminCap');

		if (!registry || !adminCap) {
			throw new Error(
				`Missing required objects: registry=${!!registry}, adminCap=${!!adminCap}`,
			);
		}

		console.log(`    Creating DEEP/SUI pool (DEEP base, SUI quote)...`);
		console.log(`    Registry: ${registry.objectId}`);
		console.log(`    AdminCap: ${adminCap.objectId}`);

		// Create pool via Move call — DEEP/SUI (DEEP base, SUI quote)
		const tx = new Transaction();

		// Parameters: base = DEEP (6 decimals), quote = SUI (9 decimals). All must be power of ten.
		const tickSize = 10_000_000; // 0.00001 SUI (price tick in quote, 9 decimals)
		const lotSize = 1_000_000; // 1 DEEP (base quantity step, 6 decimals)
		const minSize = 10_000_000; // 10 DEEP minimum order (base, 6 decimals)
		const whitelistedPool = false;
		const stablePool = false;

		// Call create_pool_admin
		tx.moveCall({
			target: `${deepbookPkg.packageId}::pool::create_pool_admin`,
			typeArguments: [
				`${tokenPkg.packageId}::deep::DEEP`, // BaseAsset
				'0x2::sui::SUI', // QuoteAsset
			],
			arguments: [
				tx.object(registry.objectId), // registry
				tx.pure.u64(tickSize), // tick_size
				tx.pure.u64(lotSize), // lot_size
				tx.pure.u64(minSize), // min_size
				tx.pure.bool(whitelistedPool), // whitelisted_pool
				tx.pure.bool(stablePool), // stable_pool
				tx.object(adminCap.objectId), // admin cap
			],
		});

		// Execute transaction
		const result = await this.client.signAndExecuteTransaction({
			transaction: tx,
			signer: this.signer,
			options: {
				showEffects: true,
				showObjectChanges: true,
				showEvents: true,
			},
		});

		// Check for errors
		if (result.effects?.status.status !== 'success') {
			throw new Error(
				`Failed to create pool: ${result.effects?.status.error || 'Unknown error'}`,
			);
		}

		// Extract pool ID from created objects
		const poolCreated = result.objectChanges?.find(
			(obj): obj is SuiObjectChangeCreated =>
				obj.type === 'created' && obj.objectType.includes('::pool::Pool<'),
		);

		if (!poolCreated) {
			throw new Error('No pool object found in transaction result');
		}

		const poolId = poolCreated.objectId;

		console.log(`    ✅ Pool created: ${poolId}`);

		return {
			poolId,
			transactionDigest: result.digest,
			result,
		};
	}

	private findObjectByType(
		objects: SuiObjectChangeCreated[],
		typeName: string,
	): SuiObjectChangeCreated | undefined {
		return objects.find((obj) => {
			const type = (obj.objectType ?? '').replace(/\s*│\s*$/g, '').trim();
			return type.endsWith(`::${typeName}`);
		});
	}
}
