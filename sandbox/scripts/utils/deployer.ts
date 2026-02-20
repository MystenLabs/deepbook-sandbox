import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
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

const PACKAGES_BASE = "../external/deepbook/packages";

/** Packages that need Move.toml patching (environments / local deps) before publish. */
const PACKAGES_NEED_MOVE_PATCH = [
    "token",
    "deepbook",
    "pyth",
    "usdc",
    "deepbook_margin",
    "margin_liquidation",
] as const;
/** Packages that need Move.lock removed before publish and restored after. */
const PACKAGES_NEED_MOVE_LOCK = [
    "token",
    "deepbook",
    "pyth",
    "usdc",
    "deepbook_margin",
    "margin_liquidation",
] as const;
/** Packages that need Published.toml removed before publish and restored after. */
const PACKAGES_NEED_PUBLISHED_TOML = [
    "token",
    "deepbook",
    "deepbook_margin",
    "margin_liquidation",
] as const;

const PYTH_GIT_TESTNET =
    'pyth = { git = "https://github.com/pyth-network/pyth-crosschain.git", subdir = "target_chains/sui/contracts", rev = "sui-contract-testnet" }';

function getSandboxRoot(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function needsMovePatch(name: string): boolean {
    return (PACKAGES_NEED_MOVE_PATCH as readonly string[]).includes(name);
}
function needsMoveLock(name: string): boolean {
    return (PACKAGES_NEED_MOVE_LOCK as readonly string[]).includes(name);
}
function needsPublishedToml(name: string): boolean {
    return (PACKAGES_NEED_PUBLISHED_TOML as readonly string[]).includes(name);
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

        // Ensure Published.toml is removed right before publish (defensive)
        const pubToml = path.join(resolvedPath, "Published.toml");
        if (existsSync(pubToml)) {
            console.log(`    [warn] Removing leftover Published.toml: ${pubToml}`);
            unlinkSync(pubToml);
        }

        const args =
            this.network === "localnet"
                ? ["client", "publish", "--json", "--build-env", "localnet", resolvedPath]
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
        const pythPath = path.join(sandboxRoot, "packages", "pyth");
        const usdcPath = path.join(sandboxRoot, "packages", "usdc");

        const allPackages: PackageInfo[] = [
            { name: "token", path: `${PACKAGES_BASE}/token`, deps: [] },
            { name: "deepbook", path: `${PACKAGES_BASE}/deepbook`, deps: ["token"] },
            { name: "pyth", path: pythPath, deps: [] },
            { name: "usdc", path: usdcPath, deps: [] },
            {
                name: "deepbook_margin",
                path: `${PACKAGES_BASE}/deepbook_margin`,
                deps: ["token", "deepbook", "pyth"],
            },
            {
                name: "margin_liquidation",
                path: `${PACKAGES_BASE}/margin_liquidation`,
                deps: ["deepbook_margin"],
            },
        ];

        const packages =
            this.network === "testnet" ? allPackages.filter((p) => p.name !== "pyth") : allPackages;

        const deployed = new Map<string, DeploymentResult>();
        const publishedTomlBackups = new Map<string, string>();
        const moveLockBackups = new Map<string, string>();

        for (const pkg of packages) {
            this.preDeployment(pkg, deployed, chainId, moveLockBackups, publishedTomlBackups);
            const result = await this.deployPackage(pkg.path, pkg.name);
            deployed.set(pkg.name, result);
            await new Promise((r) => setTimeout(r, 2000));
        }

        this.afterDeployment(packages, moveLockBackups, publishedTomlBackups);

        return deployed;
    }

    /**
     * Before publishing a package: patch Move.toml, backup+remove Move.lock and Published.toml as needed.
     */
    private preDeployment(
        pkg: PackageInfo,
        deployed: Map<string, DeploymentResult>,
        chainId: string,
        moveLockBackups: Map<string, string>,
        publishedTomlBackups: Map<string, string>,
    ): void {
        if (needsMovePatch(pkg.name)) {
            this.patchMoveTOML(pkg, deployed, chainId, this.network);
        }
        if (needsMoveLock(pkg.name)) {
            this.backupMoveLock(pkg, moveLockBackups);
            this.removeMoveLock(pkg);
        }
        if (needsPublishedToml(pkg.name)) {
            this.backupPublishedToml(pkg, publishedTomlBackups);
            this.removePublishedToml(pkg);
        }
    }

    /**
     * After all deployments: restore Move.toml, Move.lock, and Published.toml; remove pyth/token Published.toml.
     */
    private afterDeployment(
        packages: PackageInfo[],
        moveLockBackups: Map<string, string>,
        publishedTomlBackups: Map<string, string>,
    ): void {
        for (const pkg of packages) {
            if (needsMovePatch(pkg.name)) {
                this.restoreMoveTOML(pkg);
            }
            if (needsMoveLock(pkg.name)) {
                this.restoreMoveLock(pkg, moveLockBackups);
            }
            if (needsPublishedToml(pkg.name)) {
                this.restorePublishedToml(pkg, publishedTomlBackups);
            }
            if (pkg.name === "pyth" || pkg.name === "token" || pkg.name === "usdc") {
                this.removePublishedToml(pkg);
            }
        }
    }

    private patchMoveTOML(
        pkg: PackageInfo,
        deployed: Map<string, DeploymentResult>,
        chainId: string,
        network: Network,
    ): void {
        const tomlPath = path.join(path.resolve(process.cwd(), pkg.path), "Move.toml");
        const original = readFileSync(tomlPath, "utf-8");
        writeFileSync(`${tomlPath}.backup`, original);

        let patched = original;
        const isLocalnet = network === "localnet";
        const envBlock = `[environments]\nlocalnet = "${chainId}"\n`;

        if (pkg.name === "token") {
            if (isLocalnet) {
                patched = patched.replace(/\[addresses\]\s*\n\s*token\s*=\s*"0x0"\s*/, envBlock);
            }
        }

        if (pkg.name === "deepbook") {
            patched = patched.replace(
                /token\s*=\s*\{[^}]*git[^}]*\}/g,
                'token = { local = "../token" }',
            );
            if (isLocalnet) {
                patched = patched.replace(/\[addresses\]\s*\n\s*deepbook\s*=\s*"0x0"\s*/, envBlock);
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
                    /Pyth\s*=\s*\{[^}]*git[^}]*\}/g,
                    'pyth = { local = "../../../../sandbox/packages/pyth" }',
                );
            } else {
                patched = patched.replace(/Pyth\s*=\s*\{[^}]*\}/g, PYTH_GIT_TESTNET);
            }
            if (isLocalnet) {
                patched = patched.replace(
                    /\[addresses\]\s*\n\s*deepbook_margin\s*=\s*"0x0"\s*/,
                    envBlock,
                );
            }
        }

        if (pkg.name === "margin_liquidation") {
            const pythDep = isLocalnet
                ? 'pyth = { local = "../../../../sandbox/packages/pyth" }'
                : PYTH_GIT_TESTNET;
            const extraDeps = [
                ...(patched.includes("token") ? [] : ['token = { local = "../token" }']),
                ...(patched.includes("pyth") ? [] : [pythDep]),
            ];
            if (extraDeps.length > 0) {
                patched = patched.replace(
                    /deepbook_margin\s*=\s*\{\s*local\s*=\s*"\.\.\/deepbook_margin"\s*\}/,
                    `deepbook_margin = { local = "../deepbook_margin" }\n${pythDep}\ntoken = { local = "../token" }\n${extraDeps.join("\n")}`,
                );
            }
            if (isLocalnet) {
                patched = patched.replace(
                    /\[addresses\]\s*\n\s*margin_liquidation\s*=\s*"0x0"\s*/,
                    envBlock,
                );
            }
        }

        // Update the chain ID in existing [environments] section (new Move.toml format)
        // or create it from [addresses] (old format, handled above).
        if (pkg.name === "pyth" || (pkg.name === "usdc" && isLocalnet && patched.includes("[environments]"))) {
            patched = patched.replace(/localnet\s*=\s*"[^"]*"/, `localnet = "${chainId}"`);
        }
        writeFileSync(tomlPath, patched);
    }

    private restoreMoveTOML(pkg: PackageInfo): void {
        const tomlPath = path.join(path.resolve(process.cwd(), pkg.path), "Move.toml");
        const backupPath = `${tomlPath}.backup`;
        try {
            const backup = readFileSync(backupPath, "utf-8");
            writeFileSync(tomlPath, backup);
            unlinkSync(backupPath);
        } catch (error) {
            log.warn(`Could not restore Move.toml for ${pkg.name}`);
        }
    }

    private getPackageDir(pkg: PackageInfo): string {
        return path.resolve(process.cwd(), pkg.path);
    }

    private backupPublishedToml(pkg: PackageInfo, backups: Map<string, string>): void {
        const publishedPath = path.join(this.getPackageDir(pkg), "Published.toml");
        if (existsSync(publishedPath)) {
            backups.set(pkg.name, readFileSync(publishedPath, "utf-8"));
        }
    }

    private removePublishedToml(pkg: PackageInfo): void {
        const publishedPath = path.join(this.getPackageDir(pkg), "Published.toml");
        if (existsSync(publishedPath)) {
            unlinkSync(publishedPath);
        }
    }

    private backupMoveLock(pkg: PackageInfo, backups: Map<string, string>): void {
        const lockPath = path.join(this.getPackageDir(pkg), "Move.lock");
        if (existsSync(lockPath)) {
            backups.set(pkg.name, readFileSync(lockPath, "utf-8"));
        }
    }

    private removeMoveLock(pkg: PackageInfo): void {
        const lockPath = path.join(this.getPackageDir(pkg), "Move.lock");
        if (existsSync(lockPath)) {
            unlinkSync(lockPath);
        }
    }

    private restoreMoveLock(pkg: PackageInfo, backups: Map<string, string>): void {
        const content = backups.get(pkg.name);
        if (!content) return;
        const lockPath = path.join(this.getPackageDir(pkg), "Move.lock");
        writeFileSync(lockPath, content);
        backups.delete(pkg.name);
    }

    private restorePublishedToml(pkg: PackageInfo, backups: Map<string, string>): void {
        const content = backups.get(pkg.name);
        if (!content) return;
        const publishedPath = path.join(this.getPackageDir(pkg), "Published.toml");
        writeFileSync(publishedPath, content);
        backups.delete(pkg.name);
    }
}
