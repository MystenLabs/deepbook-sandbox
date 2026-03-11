import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { readFileSync, writeFileSync, cpSync, rmSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type {
    SuiClient,
    SuiObjectChangeCreated,
    SuiObjectChangePublished,
    SuiTransactionBlockResponse,
} from "@mysten/sui/client";
import type { Keypair } from "@mysten/sui/cryptography";
import type { Network } from "./config";
import log from "./logger";

const EXTERNAL_SOURCE = "../external/deepbook/packages";

/** Packages copied from the external submodule into the sandbox staging directory. */
const EXTERNAL_PACKAGES = ["token", "deepbook", "deepbook_margin", "margin_liquidation"] as const;

/** Packages that need Move.toml patching (environments / local deps) before publish. */
const PACKAGES_NEED_MOVE_PATCH = [
    "token",
    "deepbook",
    "pyth",
    "usdc",
    "deepbook_margin",
    "margin_liquidation",
] as const;

const PYTH_GIT_TESTNET =
    'pyth = { git = "https://github.com/pyth-network/pyth-crosschain.git", subdir = "target_chains/sui/contracts", rev = "sui-contract-testnet" }';

function getSandboxRoot(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

/**
 * Copy external deepbook packages into sandbox/.external-packages/ so we
 * never mutate the git submodule. Returns the staging directory path.
 */
function stageExternalPackages(): string {
    const sandboxRoot = getSandboxRoot();
    const stagingDir = path.join(sandboxRoot, ".external-packages");
    const sourceDir = path.resolve(sandboxRoot, EXTERNAL_SOURCE);

    // Wipe previous staging to ensure a clean copy
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });

    for (const pkg of EXTERNAL_PACKAGES) {
        cpSync(path.join(sourceDir, pkg), path.join(stagingDir, pkg), { recursive: true });
    }

    return stagingDir;
}

function needsMovePatch(name: string): boolean {
    return (PACKAGES_NEED_MOVE_PATCH as readonly string[]).includes(name);
}

export interface DeploymentResult {
    packageId: string;
    createdObjects: SuiObjectChangeCreated[];
    transactionDigest: string;
    result: SuiTransactionBlockResponse;
}

export interface PackageInfo {
    name: string;
    path: string;
    deps: string[];
}

/** Extract the transaction digest from `sui client publish` JSON output. */
function parseDigestFromOutput(output: string): string {
    const json = JSON.parse(output);

    // effects are wrapped in a version envelope (V1, V2, …)
    const effects = json.effects;
    if (effects) {
        const inner = effects.V2 ?? effects.V1 ?? effects;
        if (inner.transaction_digest) return inner.transaction_digest;
        if (inner.transactionDigest) return inner.transactionDigest;
    }

    if (json.digest) return json.digest;

    throw new Error("Could not find transaction digest in publish output");
}

export class MoveDeployer {
    private suiBinary: string;

    constructor(
        private client: SuiClient,
        private signer: Keypair,
        private network: Network,
    ) {
        this.suiBinary = process.env.SUI_BINARY || "sui";
    }

    async deployPackage(packagePath: string, packageName: string): Promise<DeploymentResult> {
        log.spin(`Publishing ${packageName} (sui client publish)`);

        const resolvedPath = path.resolve(process.cwd(), packagePath);

        const args =
            this.network === "localnet"
                ? ["client", "test-publish", "--json", "-e", "testnet", resolvedPath]
                : ["client", "publish", "--json", resolvedPath];
        let output: string;
        try {
            const { stdout } = await execFileAsync(this.suiBinary, args, {
                encoding: "utf-8",
                maxBuffer: 50 * 1024 * 1024, // 50 MB — publish output includes compiled bytecode
            });
            output = stdout;
        } catch (err: unknown) {
            const stderr =
                err && typeof err === "object" && "stderr" in err
                    ? String((err as { stderr: unknown }).stderr)
                    : "";
            const stdout =
                err && typeof err === "object" && "stdout" in err
                    ? String((err as { stdout: unknown }).stdout)
                    : "";
            const detail = stderr || stdout || String(err);
            throw new Error(`Failed to publish ${packageName}.\n${detail.slice(-800)}`);
        }

        const transactionDigest = parseDigestFromOutput(output);

        // Fetch the full transaction via SDK for reliable structured data
        await this.client.waitForTransaction({ digest: transactionDigest });
        const result = await this.client.getTransactionBlock({
            digest: transactionDigest,
            options: { showObjectChanges: true },
        });

        const published = result.objectChanges?.find(
            (c): c is SuiObjectChangePublished => c.type === "published",
        );
        if (!published) {
            throw new Error(`Published package not found in transaction ${transactionDigest}`);
        }
        const packageId = published.packageId;

        const createdObjects = (result.objectChanges ?? []).filter(
            (c): c is SuiObjectChangeCreated => c.type === "created",
        );

        log.success(`${packageName} deployed: ${packageId}`);

        return { packageId, createdObjects, transactionDigest, result };
    }

    async deployAll(): Promise<Map<string, DeploymentResult>> {
        const chainId = await this.client.getChainIdentifier();
        const sandboxRoot = getSandboxRoot();
        const stagingDir = stageExternalPackages();
        log.success(`Staged external packages in ${path.relative(sandboxRoot, stagingDir)}/`);

        const pythPath = path.join(sandboxRoot, "packages", "pyth");
        const usdcPath = path.join(sandboxRoot, "packages", "usdc");

        const allPackages: PackageInfo[] = [
            { name: "token", path: path.join(stagingDir, "token"), deps: [] },
            { name: "deepbook", path: path.join(stagingDir, "deepbook"), deps: ["token"] },
            { name: "pyth", path: pythPath, deps: [] },
            { name: "usdc", path: usdcPath, deps: [] },
            {
                name: "deepbook_margin",
                path: path.join(stagingDir, "deepbook_margin"),
                deps: ["token", "deepbook", "pyth"],
            },
            {
                name: "margin_liquidation",
                path: path.join(stagingDir, "margin_liquidation"),
                deps: ["deepbook_margin"],
            },
        ];

        const packages =
            this.network === "testnet" ? allPackages.filter((p) => p.name !== "pyth") : allPackages;

        const deployed = new Map<string, DeploymentResult>();

        for (const pkg of packages) {
            this.preDeployment(pkg, deployed, chainId);
            const result = await this.deployPackage(pkg.path, pkg.name);
            deployed.set(pkg.name, result);
            await new Promise((r) => setTimeout(r, 2000));
        }

        return deployed;
    }

    /**
     * Before publishing a package: patch Move.toml as needed.
     */
    private preDeployment(
        pkg: PackageInfo,
        deployed: Map<string, DeploymentResult>,
        chainId: string,
    ): void {
        if (needsMovePatch(pkg.name)) {
            this.patchMoveTOML(pkg, deployed, chainId, this.network);
        }
    }

    private patchMoveTOML(
        pkg: PackageInfo,
        deployed: Map<string, DeploymentResult>,
        chainId: string,
        network: Network,
    ): void {
        const tomlPath = path.join(path.resolve(process.cwd(), pkg.path), "Move.toml");
        let patched = readFileSync(tomlPath, "utf-8");
        const isLocalnet = network === "localnet";

        if (pkg.name === "token") {
            if (isLocalnet) {
                patched = patched.replace(/\[addresses\]\s*\n\s*token\s*=\s*"0x0"\s*/, "");
            }
        }

        if (pkg.name === "deepbook") {
            patched = patched.replace(
                /token\s*=\s*\{[^}]*git[^}]*\}/g,
                'token = { local = "../token" }',
            );
            if (isLocalnet) {
                patched = patched.replace(/\[addresses\]\s*\n\s*deepbook\s*=\s*"0x0"\s*/, "");
            }
        }

        if (pkg.name === "deepbook_margin") {
            patched = patched.replace(
                /token\s*=\s*\{[^}]*git[^}]*\}/g,
                'token = { local = "../token" }',
            );
            patched = patched.replace(
                /deepbook\s*=\s*\{[^}]*local[^}]*\}/g,
                'deepbook = { local = "../deepbook" }',
            );
            if (isLocalnet) {
                patched = patched.replace(
                    /pyth\s*=\s*\{[^}]*git[^}]*\}/g,
                    'pyth = { local = "../../packages/pyth" }',
                );
                patched = patched.replace(
                    /Pyth\s*=\s*\{[^}]*git[^}]*\}/g,
                    'pyth = { local = "../../packages/pyth" }',
                );
            } else {
                patched = patched.replace(/Pyth\s*=\s*\{[^}]*\}/g, PYTH_GIT_TESTNET);
            }
            if (isLocalnet) {
                patched = patched.replace(
                    /\[addresses\]\s*\n\s*deepbook_margin\s*=\s*"0x0"\s*/,
                    "",
                );
            }
        }

        if (pkg.name === "margin_liquidation") {
            const pythDep = isLocalnet
                ? 'pyth = { local = "../../packages/pyth" }'
                : PYTH_GIT_TESTNET;
            const extraDeps = [
                ...(patched.includes("token") ? [] : ['token = { local = "../token" }']),
                ...(patched.includes("pyth") ? [] : [pythDep]),
            ];
            if (extraDeps.length > 0) {
                patched = patched.replace(
                    /deepbook_margin\s*=\s*\{\s*local\s*=\s*"\.\.\/deepbook_margin"\s*\}/,
                    `deepbook_margin = { local = "../deepbook_margin" }\n${extraDeps.join("\n")}`,
                );
            }
            if (isLocalnet) {
                patched = patched.replace(
                    /\[addresses\]\s*\n\s*margin_liquidation\s*=\s*"0x0"\s*/,
                    "",
                );
            }
        }

        // Update the chain ID in existing [environments] section (pyth/usdc already use this format).
        if (
            pkg.name === "pyth" ||
            (pkg.name === "usdc" && isLocalnet && patched.includes("[environments]"))
        ) {
            patched = patched.replace(/localnet\s*=\s*"[^"]*"/, `localnet = "${chainId}"`);
        }
        writeFileSync(tomlPath, patched);
    }
}
