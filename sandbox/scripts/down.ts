import { spawnSync } from "child_process";
import { unlinkSync } from "fs";
import path from "path";
import { getNetwork } from "./utils/config";
import { getSandboxRoot } from "./utils/docker-compose";
import { cleanEnvFile, USER_ENV_KEYS } from "./utils/env";
import log from "./utils/logger";

function main() {
    const network = getNetwork();
    const profile = network === "localnet" ? "localnet" : "remote";
    const cwd = getSandboxRoot();

    // 1. Stop containers and remove volumes
    log.phase(`Stopping containers and removing volumes (profile: ${profile})`);
    const result = spawnSync("docker", ["compose", "--profile", profile, "down", "-v"], {
        cwd,
        encoding: "utf-8",
        stdio: "inherit",
    });

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
    log.success("Containers stopped, volumes removed");

    // 2. Remove shared keystore (created by sui-localnet container)
    try {
        unlinkSync(path.join(cwd, "deployments", ".sui-keystore"));
    } catch {
        // may not exist
    }

    // 3. Remove leftover publish manifests
    try {
        unlinkSync(path.join(cwd, "Pub.localnet.toml"));
    } catch {
        // may not exist
    }
    log.success("Cleaned publish manifests");

    // 4. Restore deployment-patched Move.toml files to committed state
    const repoRoot = path.resolve(cwd, "..");
    const patchedManifests = ["sandbox/packages/pyth/Move.toml", "sandbox/packages/usdc/Move.toml"];
    log.phase("Restoring patched Move.toml files");
    const checkoutResult = spawnSync("git", ["checkout", "--", ...patchedManifests], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: "inherit",
    });
    if (checkoutResult.status === 0) {
        log.success("Move.toml files restored");
    } else {
        log.warn(
            "Could not restore Move.toml files (git checkout failed — files may already be clean)",
        );
    }

    // 5. Remove auto-generated .env keys (keep user-configured ones)
    log.phase("Cleaning generated .env keys");
    cleanEnvFile(cwd, USER_ENV_KEYS);
    log.success("Generated .env keys removed");
}

main();
