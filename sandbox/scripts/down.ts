import { spawnSync } from "child_process";
import { getNetwork } from "./utils/config";
import { getSandboxRoot } from "./utils/docker-compose";
import { removeEnvKeys } from "./utils/env";
import log from "./utils/logger";

/** Keys written by deploy-all that should be cleaned up on teardown. */
const GENERATED_ENV_KEYS = [
    "DEEPBOOK_PACKAGE_ID",
    "DEEP_TOKEN_PACKAGE_ID",
    "DEEP_TREASURY_ID",
    "DEEPBOOK_MARGIN_PACKAGE_ID",
    "FIRST_CHECKPOINT",
    "PYTH_PACKAGE_ID",
    "DEEP_PRICE_INFO_OBJECT_ID",
    "SUI_PRICE_INFO_OBJECT_ID",
    "ORACLE_PRIVATE_KEY",
    "POOL_ID",
    "BASE_COIN_TYPE",
    "DEPLOYER_ADDRESS",
    "CORE_PACKAGES",
    "MARGIN_PACKAGES",
];

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

    // 2. Remove auto-generated .env keys
    log.phase("Cleaning generated .env keys");
    removeEnvKeys(cwd, GENERATED_ENV_KEYS);
    log.success("Generated .env keys removed");
}

main();
