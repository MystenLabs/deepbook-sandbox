import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { loadConfig } from "./config.js";
import { authMiddleware, rateLimitMiddleware } from "./middleware.js";
import { createRoutes } from "./routes.js";

const config = loadConfig();
const app = new Hono();

// CORS middleware - allow dashboard to call this API
app.use("/*", cors({
    origin: "*", // In production, restrict this to dashboard origin
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
}));

// Apply rate limiting to all routes
app.use("/*", rateLimitMiddleware(100, 60000)); // 100 requests per minute

// Apply authentication to all routes except health check
app.use("/services", authMiddleware(config));
app.use("/services/*", authMiddleware(config));
app.use("/reset", authMiddleware(config));
app.use("/config", authMiddleware(config));
app.use("/audit", authMiddleware(config));

// Mount routes
const routes = createRoutes(config);
app.route("/", routes);

const port = parseInt(config.PORT, 10);

console.log(`Starting Control API on port ${port}...`);

serve({
    fetch: app.fetch,
    port,
});

console.log(`Control API is running on http://localhost:${port}`);
