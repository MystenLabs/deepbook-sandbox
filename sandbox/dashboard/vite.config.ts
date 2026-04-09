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
                "/api/deepbook": {
                    target: "http://localhost:9008",
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
                    target: "http://localhost:9000",
                    changeOrigin: true,
                    rewrite: (p) => p.replace(/^\/api\/sui/, ""),
                },
                // Unified API (faucet + trading) — catch-all after specific proxies
                "/api": {
                    target: "http://localhost:9009",
                    changeOrigin: true,
                    rewrite: (p) => p.replace(/^\/api/, ""),
                },
            },
        },
    };
});
