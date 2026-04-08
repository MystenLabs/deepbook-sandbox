import { createDAppKit } from "@mysten/dapp-kit-react";
import { devWalletInitializer } from "@mysten-incubation/dev-wallet";
import { InMemorySignerAdapter } from "@mysten-incubation/dev-wallet/adapters";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

// Injected at build time by vite.config.ts from sandbox/.env (PRIVATE_KEY).
const PRIVATE_KEY = import.meta.env.VITE_DEV_WALLET_PRIVATE_KEY ?? "";

// Create adapter, import deployer key (if available) before initializing dAppKit.
const adapter = new InMemorySignerAdapter();
const adapterReady = adapter.initialize().then(async () => {
    if (!PRIVATE_KEY) {
        console.warn(
            "[DevWallet] PRIVATE_KEY missing — set it in sandbox/.env (deploy-all generates one on localnet). Dev wallet will start with no accounts.",
        );
        return;
    }
    const { secretKey } = decodeSuiPrivateKey(PRIVATE_KEY);
    const keypair = Ed25519Keypair.fromSecretKey(secretKey);
    await adapter.importAccount({ signer: keypair, label: "Deployer" });
    console.log("[DevWallet] Imported deployer key");
});

// Block dAppKit creation until adapter is ready
await adapterReady;

export const dAppKit = createDAppKit({
    networks: ["localnet"],
    createClient(network) {
        return new SuiGrpcClient({ network, baseUrl: "http://localhost:9000" });
    },
    slushWalletConfig: null,
    walletInitializers: [
        devWalletInitializer({
            adapters: [adapter],
            autoConnect: true,
            autoApprove: false,
            mountUI: true,
        }),
    ],
});

declare module "@mysten/dapp-kit-react" {
    interface Register {
        dAppKit: typeof dAppKit;
    }
}
