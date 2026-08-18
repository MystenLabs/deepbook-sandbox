import { createDAppKit } from "@mysten/dapp-kit-react";
import { devWalletInitializer } from "@mysten-incubation/dev-wallet";
import { InMemorySignerAdapter } from "@mysten-incubation/dev-wallet/adapters";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

// Injected at build time by vite.config.ts from sandbox/.env (PRIVATE_KEY).
const PRIVATE_KEY = import.meta.env.VITE_DEV_WALLET_PRIVATE_KEY ?? "";

/**
 * The bundled dev wallet is the ONLY wallet this sandbox can transact with
 * (matches @mysten-incubation/dev-wallet's DEFAULT_WALLET_NAME).
 *
 * External wallets — the Slush extension in particular — register themselves
 * through the wallet standard and will happily connect, then fail at signing:
 * they reject the `sui:localnet` chain ("Value \"localnet\" does not exist in
 * \"Network\" enum") and, if you approve anyway, execute against their own
 * localnet default of 127.0.0.1:9000 ("Failed to fetch"). The fork chain is
 * neither on 9000 nor directly reachable — it listens on a devstack-brokered
 * port and the browser only reaches it through this page's same-origin
 * `/api/sui` proxy. So the connect modal is filtered to this wallet and a
 * banner calls out any other one that is still connected from a prior session.
 */
export const DEV_WALLET_NAME = "Dev Wallet";

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

// Chain RPC rides the dev server's /api/sui proxy (same origin — no CORS
// exposure, and the proxy target follows the fork's brokered port via
// SUI_RPC_PROXY_TARGET). VITE_SUI_RPC_URL overrides for direct targets.
const RPC_URL =
    (import.meta.env.VITE_SUI_RPC_URL as string | undefined) || `${window.location.origin}/api/sui`;

export const dAppKit = createDAppKit({
    networks: ["localnet"],
    createClient(network) {
        return new SuiGrpcClient({ network, baseUrl: RPC_URL });
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
