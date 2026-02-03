import { spawnSync } from 'child_process';
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
 * Runs from sandbox root: `docker compose --profile localnet up -d`, then polls RPC.
 */
export async function startLocalnet(sandboxRoot?: string): Promise<{
	rpcPort: number;
	faucetPort: number;
}> {
	const cwd = sandboxRoot ?? getSandboxRoot();
	const result = spawnSync('docker', ['compose', '--profile', 'localnet', 'up', '-d'], {
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
