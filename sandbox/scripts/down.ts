import { spawnSync } from "child_process";
import { getNetwork } from "./utils/config";
import { getSandboxRoot } from "./utils/docker-compose";

function main() {
    const network = getNetwork();
    const profile = network === "localnet" ? "localnet" : "remote";
    const cwd = getSandboxRoot();

    console.log(`Stopping containers (profile: ${profile})...`);
    const result = spawnSync("docker", ["compose", "--profile", profile, "down"], {
        cwd,
        encoding: "utf-8",
        stdio: "inherit",
    });

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
    console.log("Done.");
}

main();
