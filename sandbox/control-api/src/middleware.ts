import type { Context, Next } from "hono";
import type { Config } from "./config.js";
import type { AuditLogEntry } from "./types.js";

// Authentication middleware
export function authMiddleware(config: Config) {
    return async (c: Context, next: Next) => {
        const authHeader = c.req.header("Authorization");

        console.log(`[AUTH] Request to ${c.req.path}, Auth header present: ${!!authHeader}`);

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            console.log(`[AUTH] REJECTED: Missing or invalid authorization header`);
            return c.json({ error: "Missing or invalid authorization header" }, 401);
        }

        const token = authHeader.slice(7); // Remove "Bearer " prefix

        if (token !== config.CONTROL_API_TOKEN) {
            console.log(`[AUTH] REJECTED: Token mismatch`);
            console.log(`[AUTH] Received token (first 20 chars): "${token.substring(0, 20)}..."`);
            console.log(`[AUTH] Expected token (first 20 chars): "${config.CONTROL_API_TOKEN.substring(0, 20)}..."`);
            console.log(`[AUTH] Received token length: ${token.length}, Expected: ${config.CONTROL_API_TOKEN.length}`);
            return c.json({ error: "Invalid token" }, 401);
        }

        console.log(`[AUTH] ACCEPTED: Valid token`);
        await next();
    };
}

// Rate limiting middleware (simple in-memory implementation)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

export function rateLimitMiddleware(maxRequests: number = 10, windowMs: number = 60000) {
    return async (c: Context, next: Next) => {
        const key = c.req.header("X-Forwarded-For") || c.req.header("X-Real-IP") || "unknown";
        const now = Date.now();

        let entry = rateLimitMap.get(key);

        if (!entry || now > entry.resetAt) {
            entry = { count: 0, resetAt: now + windowMs };
            rateLimitMap.set(key, entry);
        }

        entry.count++;

        if (entry.count > maxRequests) {
            return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
        }

        await next();
    };
}

// Audit logging
const auditLogs: AuditLogEntry[] = [];

export function logAudit(entry: Omit<AuditLogEntry, "timestamp">) {
    const fullEntry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        ...entry,
    };
    auditLogs.push(fullEntry);

    // Keep only last 1000 entries in memory
    if (auditLogs.length > 1000) {
        auditLogs.shift();
    }

    // Also log to console
    console.log(
        `[AUDIT] ${fullEntry.timestamp} | ${fullEntry.action} | ${fullEntry.service || "N/A"} | ${fullEntry.success ? "SUCCESS" : "FAILURE"} | ${fullEntry.message || ""}`,
    );
}

export function getAuditLogs(limit: number = 100): AuditLogEntry[] {
    return auditLogs.slice(-limit);
}
