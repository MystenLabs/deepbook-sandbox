import "dotenv/config";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import type { Keypair } from "@mysten/sui/cryptography";
import { z } from "zod";

export type Network = "localnet" | "testnet";

const NETWORK_DEFAULTS: Record<Network, { rpcUrl: string; suiFaucetUrl: string }> = {
    localnet: {
        rpcUrl: "http://sui-localnet:9000",
        suiFaucetUrl: "http://sui-localnet:9123",
    },
    testnet: {
        rpcUrl: "https://fullnode.testnet.sui.io",
        suiFaucetUrl: "https://faucet.testnet.sui.io/v2",
    },
};

const envSchema = z
    .object({
        NETWORK: z.enum(["localnet", "testnet"]),
        PRIVATE_KEY: z.string().min(1, "PRIVATE_KEY is required"),
        DEEP_TOKEN_PACKAGE_ID: z.string().min(1, "DEEP_TOKEN_PACKAGE_ID is required"),
        BALANCE_MANAGER_ID: z.string().optional(),
        RPC_URL: z.string().optional(),
        PORT: z.coerce.number().default(9009),
        MAX_DEEP_PER_REQUEST: z.coerce.number().positive().default(10000),
    })
    .transform((raw) => {
        const defaults = NETWORK_DEFAULTS[raw.NETWORK];
        return {
            network: raw.NETWORK,
            privateKey: raw.PRIVATE_KEY.trim(),
            balanceManagerId: raw.BALANCE_MANAGER_ID?.trim() || undefined,
            deepTokenPackageId: raw.DEEP_TOKEN_PACKAGE_ID.trim(),
            deepType: `${raw.DEEP_TOKEN_PACKAGE_ID.trim()}::deep::DEEP`,
            rpcUrl: raw.RPC_URL?.trim() || defaults.rpcUrl,
            suiFaucetUrl: defaults.suiFaucetUrl,
            port: raw.PORT,
            maxDeepPerRequest: raw.MAX_DEEP_PER_REQUEST,
        };
    });

export type FaucetConfig = z.infer<typeof envSchema>;

export function loadConfig(): FaucetConfig {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
        throw new Error(`Invalid env config: ${parsed.error.message}`);
    }
    return parsed.data;
}

export function getSigner(privateKey: string): Keypair {
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

export function getClient(rpcUrl: string): SuiGrpcClient {
    return new SuiGrpcClient({ network: "custom", baseUrl: rpcUrl });
}
