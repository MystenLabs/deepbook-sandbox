import path from "path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
    // Read sandbox/.env (parent of dashboard) so PRIVATE_KEY managed by
    // deploy-all is exposed to the dev wallet without duplication.
    // process.env wins so docker build args / CI overrides take effect.
    const sandboxEnv = loadEnv(mode, path.resolve(__dirname, ".."), "");
    const privateKey = process.env.PRIVATE_KEY ?? sandboxEnv.PRIVATE_KEY ?? "";

    return {
        plugins: [react()],
        resolve: {
            alias: {
                "@": path.resolve(__dirname, "./src"),
            },
        },
        define: {
            "import.meta.env.VITE_DEV_WALLET_PRIVATE_KEY": JSON.stringify(privateKey),
        },
        server: {
            proxy: {
                // Targets are overridable by the devstack trading-dashboard
                // member, which resolves them from live stack state (the fork
                // RPC port is BROKERED — never assume 9000 there).
                "/api/deepbook": {
                    target: process.env.DEEPBOOK_SERVER_PROXY_TARGET ?? "http://localhost:9008",
                    changeOrigin: true,
                    rewrite: (p) => p.replace(/^\/api\/deepbook/, ""),
                },
                "/api/oracle": {
                    target: "http://localhost:9010",
                    changeOrigin: true,
                    rewrite: (p) => p.replace(/^\/api\/oracle/, ""),
                },
                "/api/mm": {
                    target: "http://localhost:3001",
                    changeOrigin: true,
                    rewrite: (p) => p.replace(/^\/api\/mm/, ""),
                },
                "/api/sui": {
                    // host.docker.internal guard: that alias only resolves
                    // inside containers; this proxy runs on the host.
                    target: (process.env.SUI_RPC_PROXY_TARGET ?? "http://localhost:9000").replace(
                        "host.docker.internal",
                        "127.0.0.1",
                    ),
                    changeOrigin: true,
                    rewrite: (p) => p.replace(/^\/api\/sui/, ""),
                },
                // Unified API (manifest + faucet) — catch-all after specific
                // proxies; served by the sandbox-api devstack member.
                "/api": {
                    target: process.env.SANDBOX_API_PROXY_TARGET ?? "http://localhost:9009",
                    changeOrigin: true,
                    rewrite: (p) => p.replace(/^\/api/, ""),
                },
            },
        },
    };
});
