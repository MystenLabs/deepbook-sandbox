import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Dump container state and logs to /tmp/docker-logs BEFORE teardown removes
 * the containers. CI's "Capture Docker diagnostics" step runs after vitest
 * exits — by then afterAll has already run `docker compose down -v`, so
 * capturing there yields empty artifacts (this is exactly what made
 * SEDEFI-348 hard to diagnose). Call this at the top of afterAll instead.
 */
export function captureDockerDiagnostics(label: string, sandboxRoot: string): void {
    const outDir = "/tmp/docker-logs";
    const out: string[] = [];

    const run = (cmd: string, args: string[], cwd?: string): string => {
        const res = spawnSync(cmd, args, {
            cwd,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000, // don't let a wedged docker daemon block teardown
        });
        return (res.stdout || "") + (res.stderr || "");
    };

    out.push("=== docker ps -a ===", run("docker", ["ps", "-a"]));
    out.push("=== sui-localnet logs (last 500 lines) ===");
    out.push(run("docker", ["logs", "--tail", "500", "sui-localnet"]));

    const envFileArgs = process.env.SANDBOX_ENV_FILE
        ? ["--env-file", process.env.SANDBOX_ENV_FILE]
        : [];
    out.push("=== docker compose logs (last 500 lines) ===");
    out.push(
        run(
            "docker",
            [
                "compose",
                ...envFileArgs,
                "--profile",
                "localnet",
                "logs",
                "--no-color",
                "--tail",
                "500",
            ],
            sandboxRoot,
        ),
    );

    try {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, `${label}-pre-teardown.log`), out.join("\n"));
    } catch (err) {
        // Diagnostics must never fail the test run
        console.warn(`captureDockerDiagnostics: could not write logs: ${err}`);
    }
}
