import { execFile, execFileSync } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { readFileSync, writeFileSync, cpSync, rmSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Keypair } from "@mysten/sui/cryptography";
import log from "./logger";

const CONTAINER_NAME = "sui-localnet";
const CONTAINER_WORKSPACE = "/workspace";
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

export interface CreatedObject {
    objectId: string;
    objectType: string;
}

export interface DeploymentResult {
    packageId: string;
    createdObjects: CreatedObject[];
    transactionDigest: string;
}

export interface PackageInfo {
    name: string;
    path: string;
    deps: string[];
}

/** Extract the transaction digest from `sui client test-publish` JSON output. */
function parseDigestFromOutput(output: string): string {
    // The CLI may emit build logs / warnings before the JSON object.
    // Strip everything before the first '{'.
    const jsonStart = output.indexOf("{");
    if (jsonStart === -1) throw new Error("No JSON object found in publish output");
    const json = JSON.parse(output.slice(jsonStart));

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
    private sandboxRoot: string;

    constructor(
        private client: SuiGrpcClient,
        private signer: Keypair,
    ) {
        this.sandboxRoot = getSandboxRoot();
    }

    /** Map a host-side absolute path to the equivalent path inside the container. */
    private toContainerPath(hostPath: string): string {
        const relative = path.relative(this.sandboxRoot, path.resolve(hostPath));
        return `${CONTAINER_WORKSPACE}/${relative}`;
    }

    /**
     * Import the deployer key into the container's sui CLI and switch
     * to a localnet environment pointing at the in-container RPC.
     */
    private setupContainerCli(): void {
        const privateKey = this.signer.getSecretKey();
        const address = this.signer.getPublicKey().toSuiAddress();

        // Import the funded deployer key (idempotent — warns if already present)
        try {
            execFileSync(
                "docker",
                ["exec", CONTAINER_NAME, "sui", "keytool", "import", privateKey, "ed25519"],
                { stdio: "pipe" },
            );
        } catch {
            // key may already exist in the container keystore
        }

        // Create localnet env pointing at localhost inside the container
        try {
            execFileSync(
                "docker",
                [
                    "exec",
                    CONTAINER_NAME,
                    "sui",
                    "client",
                    "new-env",
                    "--alias",
                    "localnet",
                    "--rpc",
                    "http://127.0.0.1:9000",
                ],
                { stdio: "pipe" },
            );
        } catch {
            // alias may already exist
        }

        // Switch to localnet env and the deployer address
        execFileSync(
            "docker",
            ["exec", CONTAINER_NAME, "sui", "client", "switch", "--env", "localnet"],
            { stdio: "pipe" },
        );
        execFileSync(
            "docker",
            ["exec", CONTAINER_NAME, "sui", "client", "switch", "--address", address],
            { stdio: "pipe" },
        );
        log.success(`Container CLI configured for ${address}`);
    }

    /** Copy a host directory into the running sui-localnet container. */
    private copyToContainer(hostPath: string): void {
        const resolved = path.resolve(hostPath);
        const dest = this.toContainerPath(resolved);
        const parent = dest.substring(0, dest.lastIndexOf("/"));
        execFileSync("docker", ["exec", CONTAINER_NAME, "mkdir", "-p", parent], { stdio: "pipe" });
        execFileSync("docker", ["exec", CONTAINER_NAME, "rm", "-rf", dest], { stdio: "pipe" });
        execFileSync("docker", ["cp", resolved, `${CONTAINER_NAME}:${dest}`], { stdio: "pipe" });
    }

    async deployPackage(packagePath: string, packageName: string): Promise<DeploymentResult> {
        log.spin(`Publishing ${packageName} (sui client test-publish)`);

        const resolvedPath = path.resolve(process.cwd(), packagePath);

        const containerPkgPath = this.toContainerPath(resolvedPath);
        const suiArgs = [
            "client",
            "test-publish",
            "--json",
            "--build-env",
            "localnet",
            "--pubfile-path",
            `${CONTAINER_WORKSPACE}/Pub.localnet.toml`,
            containerPkgPath,
        ];
        const command = "docker";
        const execArgs = ["exec", CONTAINER_NAME, "sui", ...suiArgs];

        let output: string;
        try {
            const { stdout } = await execFileAsync(command, execArgs, {
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
            throw new Error(`Failed to publish ${packageName}.\n${detail.slice(-4000)}`);
        }

        const transactionDigest = parseDigestFromOutput(output);

        // Fetch the full transaction via SDK for reliable structured data
        await this.client.waitForTransaction({ digest: transactionDigest });
        const txResult = await this.client.getTransaction({
            digest: transactionDigest,
            include: { effects: true, objectTypes: true },
        });

        const tx = txResult.Transaction ?? txResult.FailedTransaction;
        if (!tx || txResult.$kind === "FailedTransaction") {
            throw new Error(`Transaction ${transactionDigest} failed`);
        }

        const objectTypes = tx.objectTypes ?? {};
        const changedObjects = tx.effects?.changedObjects ?? [];

        // Published packages produce a PackageWrite output with an UpgradeCap created
        const publishedObj = changedObjects.find((obj) => obj.outputState === "PackageWrite");
        if (!publishedObj) {
            throw new Error(`Published package not found in transaction ${transactionDigest}`);
        }
        const packageId = publishedObj.objectId;

        const createdObjects: CreatedObject[] = changedObjects
            .filter((obj) => obj.idOperation === "Created" && obj.outputState !== "PackageWrite")
            .map((obj) => ({
                objectId: obj.objectId,
                objectType: objectTypes[obj.objectId] ?? "",
            }));

        log.success(`${packageName} deployed: ${packageId}`);

        return { packageId, createdObjects, transactionDigest };
    }

    async deployAll(): Promise<Map<string, DeploymentResult>> {
        const { chainIdentifier: chainId } = await this.client.core.getChainIdentifier();
        const sandboxRoot = getSandboxRoot();
        const stagingDir = stageExternalPackages();
        log.success(`Staged external packages in ${path.relative(sandboxRoot, stagingDir)}/`);

        const pythPath = path.join(sandboxRoot, "packages", "pyth");
        const usdcPath = path.join(sandboxRoot, "packages", "usdc");

        const packages: PackageInfo[] = [
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

        this.setupContainerCli();

        const deployed = new Map<string, DeploymentResult>();

        for (const pkg of packages) {
            this.preDeployment(pkg, deployed, chainId);
            this.copyToContainer(pkg.path);
            const result = await this.deployPackage(pkg.path, pkg.name);
            deployed.set(pkg.name, result);
            await new Promise((r) => setTimeout(r, 2000));
        }

        // Copy the Pub.localnet.toml from the container to the sandbox root
        try {
            const pubTomlPath = path.join(sandboxRoot, "Pub.localnet.toml");
            execFileSync(
                "docker",
                [
                    "cp",
                    `${CONTAINER_NAME}:${CONTAINER_WORKSPACE}/Pub.localnet.toml`,
                    sandboxRoot,
                ],
                { stdio: "pipe" },
            );
            // Rewrite container paths to local machine paths
            let pubToml = readFileSync(pubTomlPath, "utf-8");
            pubToml = pubToml.replaceAll(CONTAINER_WORKSPACE, sandboxRoot);
            writeFileSync(pubTomlPath, pubToml);
            log.success("Copied Pub.localnet.toml from container (paths rewritten to local)");
        } catch {
            log.warn("Could not copy Pub.localnet.toml from container");
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
            this.patchMoveTOML(pkg, deployed, chainId);
        }
    }

    private patchMoveTOML(
        pkg: PackageInfo,
        _deployed: Map<string, DeploymentResult>,
        chainId: string,
    ): void {
        const tomlPath = path.join(path.resolve(process.cwd(), pkg.path), "Move.toml");
        let patched = readFileSync(tomlPath, "utf-8");
        const envBlock = `[environments]\nlocalnet = "${chainId}"\n`;

        if (pkg.name === "token") {
            patched = patched.replace(/\[addresses\]\s*\n\s*token\s*=\s*"0x0"\s*/, envBlock);
        }

        if (pkg.name === "deepbook") {
            patched = patched.replace(
                /token\s*=\s*\{[^}]*git[^}]*\}/g,
                'token = { local = "../token" }',
            );
            patched = patched.replace(/\[addresses\]\s*\n\s*deepbook\s*=\s*"0x0"\s*/, envBlock);
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
            patched = patched.replace(
                /Pyth\s*=\s*\{[^}]*git[^}]*\}/g,
                'pyth = { local = "../../packages/pyth" }',
            );
            patched = patched.replace(
                /\[addresses\]\s*\n\s*deepbook_margin\s*=\s*"0x0"\s*/,
                envBlock,
            );
        }

        if (pkg.name === "margin_liquidation") {
            const pythDep = 'pyth = { local = "../../packages/pyth" }';
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
            patched = patched.replace(
                /\[addresses\]\s*\n\s*margin_liquidation\s*=\s*"0x0"\s*/,
                envBlock,
            );
        }

        // Update the chain ID in existing [environments] section (pyth/usdc already use this format).
        if (
            pkg.name === "pyth" ||
            (pkg.name === "usdc" && patched.includes("[environments]"))
        ) {
            patched = patched.replace(/localnet\s*=\s*"[^"]*"/, `localnet = "${chainId}"`);
        }
        writeFileSync(tomlPath, patched);
    }
}
