import "dotenv/config";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { getFaucetHost } from "@mysten/sui/faucet";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import type { Keypair } from "@mysten/sui/cryptography";
import { z } from "zod";

const DEFAULT_RPC_URL = "http://127.0.0.1:9000";

const envSchema = z
    .object({
        PRIVATE_KEY: z.string().optional(),
        RPC_URL: z.string().optional(),
        SUI_TOOLS_IMAGE: z.string().optional(),
    })
    .transform((raw) => ({
        privateKey: raw.PRIVATE_KEY?.trim(),
        network: "localnet" as const,
        rpcUrl: raw.RPC_URL?.trim() || undefined,
        suiToolsImage: raw.SUI_TOOLS_IMAGE?.trim(),
    }));

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

    getRpcUrl(): string {
        const cfg = this.getConfig();
        return cfg.rpcUrl ?? DEFAULT_RPC_URL;
    }

    getFaucetUrl(): string {
        return getFaucetHost("localnet");
    }
}

const loader = new ConfigurationLoader();

export function getRpcUrl(): string {
    return loader.getRpcUrl();
}

export function getFaucetUrl(): string {
    return loader.getFaucetUrl();
}

export function getClient(): SuiGrpcClient {
    return new SuiGrpcClient({ network: "localnet", baseUrl: getRpcUrl() });
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
