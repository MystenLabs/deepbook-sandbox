import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig, getClient, getSigner } from "./config.js";
import { faucetRoutes } from "./routes/faucet.js";

const config = loadConfig();
const client = getClient(config.rpcUrl);
const signer = getSigner(config.privateKey);

const app = new Hono();

app.get("/", (c) =>
    c.json({
        service: "deepbook sandbox - faucet",
        network: "localnet",
        deployer: signer.getPublicKey().toSuiAddress(),
    }),
);

app.get("/manifest", async (c) => {
    const dir = "/app/deployments";
    try {
        const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
        if (files.length === 0) return c.json({ error: "No deployment manifest found" }, 404);
        const latest = await readFile(join(dir, files[files.length - 1]), "utf-8");
        return c.json(JSON.parse(latest));
    } catch {
        return c.json({ error: "No deployment manifest found" }, 404);
    }
});

app.route("/", faucetRoutes(config, client, signer));

console.log(`Faucet listening on port ${config.port} (network: localnet)`);
console.log(`Deployer address: ${signer.getPublicKey().toSuiAddress()}`);

serve({ fetch: app.fetch, port: config.port });
