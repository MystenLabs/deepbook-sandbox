import { readFileSync, writeFileSync } from "fs";
import path from "path";

/**
 * Update or set key=value pairs in a .env file.
 * Preserves existing keys not in updates, preserves order and comments.
 * Writes to sandboxRoot/.env (creates file if missing).
 */
export function updateEnvFile(sandboxRoot: string, updates: Record<string, string>): void {
    const envPath = path.join(sandboxRoot, ".env");
    let content = "";
    try {
        content = readFileSync(envPath, "utf-8");
    } catch {
        // .env may not exist yet
    }

    const keys = new Set(Object.keys(updates));
    const lines = content.split(/\r?\n/);
    const updated = new Set<string>();
    let result: string[] = [];

    for (const line of lines) {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (match && keys.has(match[1])) {
            result.push(`${match[1]}=${updates[match[1]]}`);
            updated.add(match[1]);
        } else {
            result.push(line);
        }
    }

    for (const key of keys) {
        if (!updated.has(key)) {
            result.push(`${key}=${updates[key]}`);
        }
    }

    writeFileSync(envPath, result.join("\n") + (result.length ? "\n" : ""), "utf-8");
}
