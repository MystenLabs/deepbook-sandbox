import { spawnSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

/** Default RPC and faucet ports for localnet (from docker-compose). */
export const LOCALNET_RPC_PORT = 9000;
export const LOCALNET_FAUCET_PORT = 9123;

/**
 * Resolve the sandbox root directory (where docker-compose.yml lives).
 * Works when running from sandbox/ or from project root.
 */
export function getSandboxRoot(): string {
	const scriptDir = path.dirname(fileURLToPath(import.meta.url));
	// scripts/utils -> sandbox
	return path.resolve(scriptDir, '../..');
}

/**
 * Start localnet with docker compose (profile localnet) and wait until RPC is ready.
 * Runs from sandbox root: `docker compose --profile localnet up -d sui-localnet postgres`, then polls RPC.
 * Note: Explicit service names prevent the indexer from starting prematurely.
 */
export async function startLocalnet(sandboxRoot?: string): Promise<{
	rpcPort: number;
	faucetPort: number;
}> {
	const cwd = sandboxRoot ?? getSandboxRoot();
	const result = spawnSync('docker', ['compose', '--profile', 'localnet', 'up', '-d', 'sui-localnet', 'postgres'], {
		cwd,
		encoding: 'utf-8',
		stdio: 'inherit',
	});
	if (result.status !== 0) {
		throw new Error(
			`docker compose failed (exit ${result.status}). Ensure Docker is running and SUI_TOOLS_IMAGE is set in .env.`,
		);
	}
	await waitForRpc(`http://127.0.0.1:${LOCALNET_RPC_PORT}`);
	await waitForFaucet(`http://127.0.0.1:${LOCALNET_FAUCET_PORT}`);
	return { rpcPort: LOCALNET_RPC_PORT, faucetPort: LOCALNET_FAUCET_PORT };
}

async function waitForRpc(url: string, maxAttempts = 60): Promise<void> {
	for (let i = 0; i < maxAttempts; i++) {
		try {
			const res = await fetch(url);
			if (res.status > 0) return; // any HTTP response means server is up
		} catch {
			// connection refused or similar
		}
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error(`RPC at ${url} did not become ready after ${maxAttempts} attempts`);
}

async function waitForFaucet(baseUrl: string, maxAttempts = 30): Promise<void> {
	const url = `${baseUrl.replace(/\/$/, '')}/v2/gas`;
	for (let i = 0; i < maxAttempts; i++) {
		try {
			const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
			if (res.status > 0) return; // any response (e.g. 400 for bad body) means faucet is up
		} catch {
			// connection refused or ECONNRESET
		}
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error(`Faucet at ${baseUrl} did not become ready after ${maxAttempts} attempts`);
}

/**
 * Start the localnet indexer with dynamically deployed package addresses.
 * Writes package IDs to .env and starts the indexer container.
 */
export async function startLocalnetIndexer(
	packages: { corePackageId: string; marginPackageId?: string },
	sandboxRoot?: string,
): Promise<void> {
	const cwd = sandboxRoot ?? getSandboxRoot();
	const envPath = path.join(cwd, '.env');

	// Read existing .env content (preserve other variables like SUI_TOOLS_IMAGE)
	let envContent = '';
	try {
		envContent = await fs.readFile(envPath, 'utf-8');
	} catch {
		// .env doesn't exist yet, that's fine
	}

	// Update or add CORE_PACKAGES and MARGIN_PACKAGES
	const envLines = envContent.split('\n').filter((line) => {
		const trimmed = line.trim();
		return !trimmed.startsWith('CORE_PACKAGES=') && !trimmed.startsWith('MARGIN_PACKAGES=');
	});

	envLines.push(`CORE_PACKAGES=${packages.corePackageId}`);
	if (packages.marginPackageId) {
		envLines.push(`MARGIN_PACKAGES=${packages.marginPackageId}`);
	}

	await fs.writeFile(envPath, envLines.filter(Boolean).join('\n') + '\n');

	// Start the indexer (explicit service name to avoid starting other localnet services)
	const result = spawnSync('docker', ['compose', '--profile', 'localnet', 'up', '-d', 'deepbook-local-indexer'], {
		cwd,
		encoding: 'utf-8',
		stdio: 'inherit',
	});

	if (result.status !== 0) {
		throw new Error(`Failed to start localnet indexer (exit ${result.status})`);
	}

	// Wait for indexer to be healthy (check metrics endpoint)
	await waitForIndexer('http://127.0.0.1:9184/metrics');
}

async function waitForIndexer(url: string, maxAttempts = 60): Promise<void> {
	for (let i = 0; i < maxAttempts; i++) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {
			// connection refused
		}
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error(`Indexer at ${url} did not become ready after ${maxAttempts} attempts`);
}
