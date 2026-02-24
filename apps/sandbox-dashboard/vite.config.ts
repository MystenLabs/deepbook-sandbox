import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
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
            "/api/faucet": {
                target: "http://localhost:9009",
                changeOrigin: true,
                rewrite: (p) => p.replace(/^\/api\/faucet/, ""),
            },
            "/api/sui": {
                target: "http://localhost:9000",
                changeOrigin: true,
                rewrite: (p) => p.replace(/^\/api\/sui/, ""),
            },
        },
    },
});
