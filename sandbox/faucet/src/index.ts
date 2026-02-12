import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { loadConfig, getClient, getSigner } from './config.js';
import { faucetRoutes } from './routes/faucet.js';

const config = loadConfig();
const client = getClient(config.rpcUrl);
const signer = getSigner(config.privateKey);

const app = new Hono();

app.get('/', (c) =>
	c.json({
        service: 'deepbook sandbox - faucet',
		network: config.network,
		deployer: signer.getPublicKey().toSuiAddress(),
	}),
);

app.route('/', faucetRoutes(config, client, signer));

console.log(`Faucet listening on port ${config.port} (network: ${config.network})`);
console.log(`Deployer address: ${signer.getPublicKey().toSuiAddress()}`);

serve({ fetch: app.fetch, port: config.port });
