import type { SuiClient } from '@mysten/sui/client';
import type { Keypair } from '@mysten/sui/cryptography';
import type { SuiObjectChangeCreated } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import type { DeploymentResult } from './deployer';

/**
 * Pyth Network Price Feed IDs
 * These are the official Pyth price feed identifiers for SUI and DEEP
 */
const SUI_PRICE_FEED_ID = '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744';
const DEEP_PRICE_FEED_ID = '0x29bdd5248234e33bd93d3b81100b5fa32eaa5997843847e2c2cb16d7c6d9f7ff';

/** Convert hex string (with or without 0x prefix) to 32-byte Uint8Array */
function hexToBytes(hex: string): Uint8Array {
	const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;

	if (cleanHex.length !== 64) {
		throw new Error(`Expected 64 hex characters (32 bytes), got ${cleanHex.length}`);
	}

	const bytes = new Uint8Array(32);
	for (let i = 0; i < 64; i += 2) {
		bytes[i / 2] = Number.parseInt(cleanHex.slice(i, i + 2), 16);
	}
	return bytes;
}

const SUI_PRICE_FEED_ID_BYTES = hexToBytes(SUI_PRICE_FEED_ID);
const DEEP_PRICE_FEED_ID_BYTES = hexToBytes(DEEP_PRICE_FEED_ID);

export interface PythOracleIds {
	deepPriceInfoObjectId: string;
	suiPriceInfoObjectId: string;
}

/** Add Move calls for one price feed (identifier → price → price_feed → price_info); returns the price_info result. */
function addPriceInfoToTx(
	tx: Transaction,
	packageId: string,
	params: { idBytes: Uint8Array; priceMag: number; expoMag: number },
	timestamp: number,
) {
	const { idBytes, priceMag, expoMag } = params;
	const priceI64 = tx.moveCall({
		target: `${packageId}::i64::new`,
		arguments: [tx.pure.u64(priceMag), tx.pure.bool(false)],
	});
	const expoI64 = tx.moveCall({
		target: `${packageId}::i64::new`,
		arguments: [tx.pure.u64(expoMag), tx.pure.bool(true)],
	});
	const price = tx.moveCall({
		target: `${packageId}::price::new`,
		arguments: [priceI64, tx.pure.u64(0), expoI64, tx.pure.u64(timestamp)],
	});
	const priceIdentifier = tx.moveCall({
		target: `${packageId}::price_identifier::from_byte_vec`,
		arguments: [tx.pure.vector('u8', Array.from(idBytes))],
	});
	const priceFeed = tx.moveCall({
		target: `${packageId}::price_feed::new`,
		arguments: [priceIdentifier, price, price],
	});
	return tx.moveCall({
		target: `${packageId}::price_info::new_price_info`,
		arguments: [tx.pure.u64(timestamp), tx.pure.u64(timestamp), priceFeed],
	});
}

/**
 * Create DEEP and SUI PriceInfoObjects via pyth::pyth::create_price_feeds.
 * Uses hardcoded identifier bytes and a shared helper to build both feeds.
 */
export async function setupPythOracles(
	client: SuiClient,
	signer: Keypair,
	deployedPackages: Map<string, DeploymentResult>,
	sandboxRoot: string,
): Promise<PythOracleIds> {
	const pythPkg = deployedPackages.get('pyth');
	if (!pythPkg) {
		throw new Error('pyth package not found in deployed packages');
	}

	const timestamp = 0;
	const tx = new Transaction();
	tx.setGasBudget(200_000_000);

	const deepPriceInfo = addPriceInfoToTx(
		tx,
		pythPkg.packageId,
		{ idBytes: DEEP_PRICE_FEED_ID_BYTES, priceMag: 2_000_000, expoMag: 8 },
		timestamp,
	);
	const suiPriceInfo = addPriceInfoToTx(
		tx,
		pythPkg.packageId,
		{ idBytes: SUI_PRICE_FEED_ID_BYTES, priceMag: 100_000_000, expoMag: 8 },
		timestamp,
	);

	tx.moveCall({
		target: `${pythPkg.packageId}::pyth::create_price_feeds`,
		arguments: [tx.makeMoveVec({type: `${pythPkg.packageId}::price_info::PriceInfo`, elements: [deepPriceInfo, suiPriceInfo] })],
	});

	const result = await client.signAndExecuteTransaction({
		transaction: tx,
		signer,
		options: {
			showEffects: true,
			showObjectChanges: true,
		},
	});

	if (result.effects?.status.status !== 'success') {
		throw new Error(
			`Failed to create pyth oracles: ${result.effects?.status.error ?? 'Unknown error'}`,
		);
	}

	const created = (result.objectChanges ?? []).filter(
		(obj): obj is SuiObjectChangeCreated =>
			obj.type === 'created' &&
			typeof obj.objectType === 'string' &&
			obj.objectType.includes('::price_info::PriceInfoObject'),
	);

	if (created.length !== 2) {
		throw new Error(
			`Expected 2 PriceInfoObject created, got ${created.length}`,
		);
	}

    await client.waitForTransaction({ digest: result.digest });

	const priceObj = await client.getObject({
		id: created[0].objectId,
		options: {
			showContent: true,
		},
	});
	const magnitude = (priceObj.data?.content as any).fields.price_info.fields.price_feed.fields.price.fields.price.fields.magnitude; 

	let ids: PythOracleIds;
	if (magnitude === 2000000) {
		ids = {
			deepPriceInfoObjectId: created[0].objectId,
			suiPriceInfoObjectId: created[1].objectId,
		};
	} else {
		ids = {
			deepPriceInfoObjectId: created[1].objectId,
			suiPriceInfoObjectId: created[0].objectId,
		}
	}

	console.log(`    ✅ DEEP PriceInfoObject: ${ids.deepPriceInfoObjectId}`);
	console.log(`    ✅ SUI PriceInfoObject: ${ids.suiPriceInfoObjectId}`);

	return ids;
}
