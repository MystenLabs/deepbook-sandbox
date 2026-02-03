import 'dotenv/config';
import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { getFaucetHost } from '@mysten/sui/faucet';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import type { Keypair } from '@mysten/sui/cryptography';

export type Network = 'testnet' | 'devnet' | 'localnet';

const DEFAULT_NETWORK: Network = 'localnet';

/**
 * Get the network from env (NETWORK) or default.
 */
export function getNetwork(): Network {
	const env = process.env.NETWORK?.toLowerCase();
	if (env === 'testnet' || env === 'devnet' || env === 'localnet') {
		return env;
	}
	return DEFAULT_NETWORK;
}

/**
 * Get RPC URL from env (RPC_URL) or the default for the network.
 */
export function getRpcUrl(network?: Network): string {
	return process.env.RPC_URL ?? getFullnodeUrl(network ?? getNetwork());
}

/**
 * Get faucet host from env (FAUCET_URL) or the default for the network.
 */
export function getFaucetUrl(network?: Network): string {
	return process.env.FAUCET_URL ?? getFaucetHost(network ?? getNetwork());
}

/**
 * Create a SuiClient. Uses RPC_URL from env if set, otherwise the network default.
 */
export function getClient(network?: Network): SuiClient {
	return new SuiClient({ url: getRpcUrl(network) });
}

/**
 * Create a signer from PRIVATE_KEY in env.
 * Supports ED25519, Secp256k1, and Secp256r1 (suiprivkey1... or 0x... formats).
 * @throws if PRIVATE_KEY is not set or key format is unsupported
 */
export function getSigner(): Keypair {
	const privateKey = process.env.PRIVATE_KEY;
	if (!privateKey?.trim()) {
		throw new Error(
			'PRIVATE_KEY is not set. Set it in .env or pass it when running the script.',
		);
	}
	const { schema, secretKey } = decodeSuiPrivateKey(privateKey.trim());
	switch (schema) {
		case 'ED25519':
			return Ed25519Keypair.fromSecretKey(secretKey);
		case 'Secp256k1':
			return Secp256k1Keypair.fromSecretKey(secretKey);
		case 'Secp256r1':
			return Secp256r1Keypair.fromSecretKey(secretKey);
		default:
			throw new Error(`Unsupported key schema: ${schema}`);
	}
}

/**
 * Get the Sui binary path from env (SUI_BINARY) or default 'sui'.
 */
export function getSuiBinary(): string {
	return process.env.SUI_BINARY ?? 'sui';
}
