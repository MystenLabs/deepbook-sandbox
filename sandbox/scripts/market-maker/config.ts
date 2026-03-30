import { z } from "zod";

const marketMakerConfigSchema = z.object({
    // Grid parameters (shared across all pools)
    // Note: spacing must be large enough for price differences to survive tick-size
    // rounding. With tickSize=1_000_000 and mid ~28_000_000, each level offset must
    // be >= 1_000_000, requiring levelSpacingBps >= ~360. Using 500 for safety.
    spreadBps: z.number().int().positive().default(500), // 5% spread
    levelsPerSide: z.number().int().positive().max(50).default(30), // 30 orders each side
    levelSpacingBps: z.number().int().positive().default(100), // 1% between levels

    // Timing
    rebalanceIntervalMs: z.number().int().positive().default(10_000), // 10 seconds

    // Servers
    healthCheckPort: z.number().int().positive().default(3000),
    metricsPort: z.number().int().positive().default(9090),
});

export type MarketMakerConfig = z.infer<typeof marketMakerConfigSchema>;

export function loadConfig(overrides?: Partial<MarketMakerConfig>): MarketMakerConfig {
    const defaults = {
        spreadBps: 500,
        levelsPerSide: 30,
        levelSpacingBps: 100,
        rebalanceIntervalMs: 10_000,
        healthCheckPort: 3000,
        metricsPort: 9090,
    };

    const merged = { ...defaults, ...overrides };

    // Validate via schema
    return marketMakerConfigSchema.parse(merged);
}

export function parseEnvConfig(): Partial<MarketMakerConfig> {
    const config: Partial<MarketMakerConfig> = {};

    if (process.env.MM_SPREAD_BPS) {
        config.spreadBps = parseInt(process.env.MM_SPREAD_BPS, 10);
    }
    if (process.env.MM_LEVELS_PER_SIDE) {
        config.levelsPerSide = parseInt(process.env.MM_LEVELS_PER_SIDE, 10);
    }
    if (process.env.MM_LEVEL_SPACING_BPS) {
        config.levelSpacingBps = parseInt(process.env.MM_LEVEL_SPACING_BPS, 10);
    }
    if (process.env.MM_REBALANCE_INTERVAL_MS) {
        config.rebalanceIntervalMs = parseInt(process.env.MM_REBALANCE_INTERVAL_MS, 10);
    }
    if (process.env.MM_HEALTH_CHECK_PORT) {
        config.healthCheckPort = parseInt(process.env.MM_HEALTH_CHECK_PORT, 10);
    }
    if (process.env.MM_METRICS_PORT) {
        config.metricsPort = parseInt(process.env.MM_METRICS_PORT, 10);
    }

    return config;
}
