import { z } from "zod";

const configSchema = z.object({
    CONTROL_API_TOKEN: z.string().min(1, "CONTROL_API_TOKEN is required for authentication"),
    PORT: z.string().default("9011"),
    COMPOSE_PROJECT_NAME: z.string().default("sandbox"),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
    const result = configSchema.safeParse(process.env);

    if (!result.success) {
        console.error("Configuration validation failed:");
        result.error.errors.forEach((err) => {
            console.error(`  - ${err.path.join(".")}: ${err.message}`);
        });
        process.exit(1);
    }

    return result.data;
}
