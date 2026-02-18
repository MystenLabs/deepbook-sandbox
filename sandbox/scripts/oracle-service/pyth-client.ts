import type { PythPriceUpdate, OracleConfig } from "./types";
import log from "../utils/logger";

/**
 * Client for fetching price data from Pyth Network API
 */
export class PythClient {
    constructor(private config: OracleConfig) {}

    /**
     * Fetches historical price data from Pyth Network
     * Uses timestamp from 24 hours ago to get historical data
     *
     * Example: /v1/updates/price/1770810100?ids=0x23d7...&ids=0x29bd...&encoding=hex&parsed=true
     */
    async fetchPriceUpdates(): Promise<PythPriceUpdate> {
        const timestamp = this.getHistoricalTimestamp();
        const priceIds = [this.config.priceFeeds.sui, this.config.priceFeeds.deep];

        // Build URL with proper query parameters
        const params = new URLSearchParams();
        priceIds.forEach((id) => params.append("ids", id));
        params.append("encoding", "hex");
        params.append("parsed", "true");

        const url = `${this.config.pythApiUrl}/v1/updates/price/${timestamp}?${params.toString()}`;

        log.loop(`Fetching price updates from Pyth (timestamp: ${timestamp})`);

        try {
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(
                    `Pyth API request failed: ${response.status} ${response.statusText}`,
                );
            }

            const data = (await response.json()) as PythPriceUpdate;

            if (!data.parsed || data.parsed.length === 0) {
                throw new Error("No price data returned from Pyth API");
            }

            log.loopSuccess(`Received ${data.parsed.length} price feeds`);
            return data;
        } catch (error) {
            log.loopError("Failed to fetch from Pyth", error);
            throw error;
        }
    }

    /**
     * Gets a timestamp from N hours ago
     */
    private getHistoricalTimestamp(): number {
        const now = Math.floor(Date.now() / 1000);
        const hoursAgo = this.config.historicalDataHours * 60 * 60;
        return now - hoursAgo;
    }
}
