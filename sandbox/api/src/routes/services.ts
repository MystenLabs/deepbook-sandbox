// Localnet-only. These routes drive `docker stop|restart` against the host
// daemon via the mounted socket at /var/run/docker.sock. That mount is
// root-equivalent on the host, so exposing this API on anything other than a
// loopback interface would be remote code execution. The hardcoded allowlist
// below is the only defence — keep it that way.

import { execFile } from "node:child_process";
import { Hono } from "hono";

// Map docker-compose service name → container_name (as defined in docker-compose.yml).
// Keys are what the dashboard posts; values are what we pass to `docker` inside
// the container (which talks to the host daemon via the mounted socket).
const CONTAINER_BY_SERVICE: Record<string, string> = {
    "oracle-service": "oracle-service",
    "market-maker": "deepbook-market-maker",
    "deepbook-sandbox-api": "deepbook-sandbox-api",
    "deepbook-server": "deepbook-server",
};

type Action = "start" | "stop" | "restart";

const COMMAND_TIMEOUT_MS = 30_000;

// Fire-and-forget so the HTTP response leaves before docker can kill the api
// container itself (restarting deepbook-sandbox-api is a self-targeting case).
function runDockerCommand(action: Action, container: string): void {
    execFile(
        "docker",
        [action, container],
        { timeout: COMMAND_TIMEOUT_MS },
        (err, stdout, stderr) => {
            const tag = `[services] docker ${action} ${container}`;
            if (err) {
                console.error(`${tag} failed: ${err.message}`);
                if (stderr) console.error(stderr.trim());
                return;
            }
            console.log(`${tag} ok`);
            if (stdout) console.log(stdout.trim());
        },
    );
}

export function servicesRoutes(): Hono {
    const app = new Hono();

    app.post("/services/:name/:action{start|stop|restart}", (c) => {
        const name = c.req.param("name");
        const action = c.req.param("action") as Action;

        const container = CONTAINER_BY_SERVICE[name];
        if (!container) {
            return c.json({ ok: false, error: `Invalid service: ${name}` }, 400);
        }

        runDockerCommand(action, container);
        return c.json({ ok: true, service: name, action }, 202);
    });

    return app;
}
