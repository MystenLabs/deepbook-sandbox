/**
 * Pyth Network API response types
 * Based on https://benchmarks.pyth.network/docs
 */

export interface PythPriceUpdate {
	binary: {
		encoding: string;
		data: string[];
	};
	parsed: ParsedPriceData[];
}

export interface ParsedPriceData {
	id: string;
	price: {
		price: string;
		conf: string;
		expo: number;
		publish_time: number;
	};
	ema_price: {
		price: string;
		conf: string;
		expo: number;
		publish_time: number;
	};
	metadata?: {
		slot?: number;
		proof_available_time?: number;
		prev_publish_time?: number;
	};
}

export interface OracleConfig {
	pythApiUrl: string;
	priceFeeds: {
		sui: string;
		deep: string;
	};
	updateIntervalMs: number;
	historicalDataHours: number;
}
