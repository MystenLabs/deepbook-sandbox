import { z } from 'zod';

const marketMakerConfigSchema = z.object({
	// Fallback mid price used when the Pyth oracle is temporarily unavailable
	// 100_000_000 = 0.1 DEEP/SUI (9 decimals for SUI)
	fallbackMidPrice: z.bigint().positive().default(100_000_000n),

	// Grid parameters
	spreadBps: z.number().int().positive().default(10), // 0.1% spread
	levelsPerSide: z.number().int().positive().max(50).default(5), // 5 orders each side
	levelSpacingBps: z.number().int().positive().default(5), // 0.05% between levels
	orderSizeBase: z.bigint().positive().default(10_000_000n), // 10 DEEP per order (6 decimals)

	// Timing
	rebalanceIntervalMs: z.number().int().positive().default(10_000), // 10 seconds

	// Pool parameters (from pool creation)
	tickSize: z.bigint().positive().default(10_000_000n), // 0.00001 SUI
	lotSize: z.bigint().positive().default(1_000_000n), // 1 DEEP
	minSize: z.bigint().positive().default(10_000_000n), // 10 DEEP

	// Servers
	healthCheckPort: z.number().int().positive().default(3000),
	metricsPort: z.number().int().positive().default(9090),
});

export type MarketMakerConfig = z.infer<typeof marketMakerConfigSchema>;

export function loadConfig(overrides?: Partial<MarketMakerConfig>): MarketMakerConfig {
	// Convert number defaults to bigint where needed
	const defaults = {
		fallbackMidPrice: 100_000_000n,
		spreadBps: 10,
		levelsPerSide: 5,
		levelSpacingBps: 5,
		orderSizeBase: 10_000_000n,
		rebalanceIntervalMs: 10_000,
		tickSize: 10_000_000n,
		lotSize: 1_000_000n,
		minSize: 10_000_000n,
		healthCheckPort: 3000,
		metricsPort: 9090,
	};

	const merged = { ...defaults, ...overrides };

	// Validate via schema
	return marketMakerConfigSchema.parse(merged);
}

export function parseEnvConfig(): Partial<MarketMakerConfig> {
	const config: Partial<MarketMakerConfig> = {};

	if (process.env.MM_FALLBACK_MID_PRICE) {
		config.fallbackMidPrice = BigInt(process.env.MM_FALLBACK_MID_PRICE);
	}
	if (process.env.MM_SPREAD_BPS) {
		config.spreadBps = parseInt(process.env.MM_SPREAD_BPS, 10);
	}
	if (process.env.MM_LEVELS_PER_SIDE) {
		config.levelsPerSide = parseInt(process.env.MM_LEVELS_PER_SIDE, 10);
	}
	if (process.env.MM_LEVEL_SPACING_BPS) {
		config.levelSpacingBps = parseInt(process.env.MM_LEVEL_SPACING_BPS, 10);
	}
	if (process.env.MM_ORDER_SIZE_BASE) {
		config.orderSizeBase = BigInt(process.env.MM_ORDER_SIZE_BASE);
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
