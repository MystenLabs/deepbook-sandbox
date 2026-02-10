import { Hono } from 'hono';
import type { SuiClient } from '@mysten/sui/client';
import type { Keypair } from '@mysten/sui/cryptography';
import { z } from 'zod';
import type { FaucetConfig } from '../config.js';
import { requestSui } from '../services/sui-faucet.js';
import { requestDeep } from '../services/deep-faucet.js';

const bodySchema = z.object({
	address: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid Sui address (expected 0x + 64 hex chars)'),
	token: z.enum(['SUI', 'DEEP']),
});

export function faucetRoutes(config: FaucetConfig, client: SuiClient, signer: Keypair): Hono {
	const app = new Hono();

	app.post('/faucet', async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ success: false, error: 'Request body must be valid JSON' }, 400);
		}

		const parsed = bodySchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
		}

		const { address, token } = parsed.data;

		if (token === 'SUI') {
			const result = await requestSui(config.suiFaucetUrl, address);
			return c.json(result, result.success ? 200 : 502);
		}

		const result = await requestDeep(client, signer, config.deepType, address);
		return c.json(result, result.success ? 200 : 500);
	});

	return app;
}
