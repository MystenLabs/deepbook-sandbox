import { execSync } from "node:child_process";

interface Check {
    name: string;
    command: string;
    hint: string;
}

const checks: Check[] = [
    {
        name: "Docker",
        command: "docker info",
        hint: "Install Docker Desktop: https://docs.docker.com/get-docker/",
    },
    {
        name: "sui",
        command: "sui --version",
        hint: "Install the Sui CLI: https://docs.sui.io/guides/developer/getting-started/sui-install",
    },
    {
        name: "pnpm",
        command: "pnpm --version",
        hint: "Install pnpm: corepack enable && corepack prepare pnpm@latest --activate",
    },
    {
        name: "git",
        command: "git --version",
        hint: "Install git: https://git-scm.com/downloads",
    },
];

export function runPreflight(): void {
    const failures: Check[] = [];

    for (const check of checks) {
        try {
            execSync(check.command, { stdio: "ignore" });
        } catch {
            failures.push(check);
        }
    }

    if (failures.length > 0) {
        console.error("\nMissing dependencies:\n");
        for (const f of failures) {
            console.error(`  ✗ ${f.name} — ${f.hint}`);
        }
        console.error("");
        process.exit(1);
    }
}
