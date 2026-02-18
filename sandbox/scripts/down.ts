import { spawnSync } from "child_process";
import { getNetwork } from "./utils/config";
import { getSandboxRoot } from "./utils/docker-compose";
import log from "./utils/logger";

function main() {
    const network = getNetwork();
    const profile = network === "localnet" ? "localnet" : "remote";
    const cwd = getSandboxRoot();

    log.phase(`Stopping containers (profile: ${profile})`);
    const result = spawnSync("docker", ["compose", "--profile", profile, "down"], {
        cwd,
        encoding: "utf-8",
        stdio: "inherit",
    });

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
    log.success("Containers stopped");
}

main();
