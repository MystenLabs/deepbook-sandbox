import { createDAppKit } from "@mysten/dapp-kit-react";
import { devWalletInitializer } from "@mysten-incubation/dev-wallet";
import { InMemorySignerAdapter } from "@mysten-incubation/dev-wallet/adapters";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

// TODO: Later this will be fetched from an API endpoint
const PRIVATE_KEY = "suiprivkey1qpe95na2djkmp92f68cpeghh4qw74pvqnmn05v7twgsua4fruey5xc3x0dz";

// Create adapter and import deployer key before passing to devWalletInitializer
const adapter = new InMemorySignerAdapter();
const adapterReady = adapter.initialize().then(async () => {
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
