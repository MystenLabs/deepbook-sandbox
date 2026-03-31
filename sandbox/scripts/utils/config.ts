import "dotenv/config";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { getFaucetHost } from "@mysten/sui/faucet";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import type { Keypair } from "@mysten/sui/cryptography";
import { z } from "zod";

export type Network = "testnet" | "localnet";

const networkSchema = z.enum(["testnet", "localnet"]);

const DEFAULT_RPC_URLS: Record<Network, string> = {
    localnet: "http://127.0.0.1:9000",
    testnet: "https://fullnode.testnet.sui.io:443",
};

const envSchema = z
    .object({
        PRIVATE_KEY: z.string().optional(),
        NETWORK: z.string().optional(),
        RPC_URL: z.string().optional(),
        SUI_TOOLS_IMAGE: z.string().optional(),
    })
    .transform((raw) => {
        const network = raw.NETWORK?.toLowerCase();
        const validNetwork =
            network && networkSchema.safeParse(network).success
                ? (networkSchema.parse(network) as Network)
                : undefined;
        return {
            privateKey: raw.PRIVATE_KEY?.trim(),
            network: validNetwork,
            rpcUrl: raw.RPC_URL?.trim() || undefined,
            suiToolsImage: raw.SUI_TOOLS_IMAGE?.trim(),
        };
    });

export type EnvConfig = z.infer<typeof envSchema>;

export class ConfigurationLoader {
    private config: EnvConfig | null = null;

    load(): EnvConfig {
        if (this.config) return this.config;
        const parsed = envSchema.safeParse(process.env);
        if (!parsed.success) {
            throw new Error(`Invalid env config: ${parsed.error.message}`);
        }
        this.config = parsed.data;
        return this.config;
    }

    getConfig(): EnvConfig {
        return this.load();
    }

    getNetwork(): Network {
        const cfg = this.getConfig();
        return cfg.network ?? "localnet";
    }

    getRpcUrl(network?: Network): string {
        const cfg = this.getConfig();
        const n = network ?? this.getNetwork();
        return cfg.rpcUrl ?? DEFAULT_RPC_URLS[n];
    }

    getFaucetUrl(network?: Network): string {
        return getFaucetHost(network ?? this.getNetwork());
    }
}

const loader = new ConfigurationLoader();

export function getNetwork(): Network {
    return loader.getNetwork();
}

export function getRpcUrl(network?: Network): string {
    return loader.getRpcUrl(network);
}

export function getFaucetUrl(network?: Network): string {
    return loader.getFaucetUrl(network);
}

export function getClient(network?: Network): SuiGrpcClient {
    const n = network ?? getNetwork();
    return new SuiGrpcClient({ network: n, baseUrl: getRpcUrl(n) });
}

export function hasPrivateKey(): boolean {
    return !!loader.getConfig().privateKey;
}

export function getSigner(): Keypair {
    const privateKey = loader.getConfig().privateKey;
    if (!privateKey) {
        throw new Error("PRIVATE_KEY is required but not set");
    }
    const { scheme, secretKey } = decodeSuiPrivateKey(privateKey);
    switch (scheme) {
        case "ED25519":
            return Ed25519Keypair.fromSecretKey(secretKey);
        case "Secp256k1":
            return Secp256k1Keypair.fromSecretKey(secretKey);
        case "Secp256r1":
            return Secp256r1Keypair.fromSecretKey(secretKey);
        default:
            throw new Error(`Unsupported key scheme: ${scheme}`);
    }
}
