import { useState } from "react";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ListOrdered, ExternalLink } from "lucide-react";
import { SdkCodeBlock } from "./sdk-code-block";
import { placeLimitOrderSnippet, placeMarketOrderSnippet, SDK_DOCS } from "./sdk-snippets";
import type { PoolKey } from "./types";

type OrderTab = "limit" | "market";

interface OrderFormProps {
    poolKey: PoolKey;
    midPrice?: number;
    onPlaceLimitOrder: (params: {
        price: number;
        quantity: number;
        isBid: boolean;
    }) => Promise<string>;
    onPlaceMarketOrder: (params: { quantity: number; isBid: boolean }) => Promise<string>;
}

const PAIR_LABELS: Record<PoolKey, { base: string; quote: string }> = {
    DEEP_SUI: { base: "DEEP", quote: "SUI" },
    SUI_USDC: { base: "SUI", quote: "USDC" },
};

// Tick sizes in SDK human units per pool (must align to on-chain tick size)
const TICK_SIZES: Record<PoolKey, number> = {
    DEEP_SUI: 0.000001,
    SUI_USDC: 0.000001,
};

/** Round price down to nearest tick size multiple. */
function roundToTick(price: number, poolKey: PoolKey): number {
    const tick = TICK_SIZES[poolKey];
    return Math.floor(price / tick) * tick;
}

export function OrderForm({
    poolKey,
    midPrice,
    onPlaceLimitOrder,
    onPlaceMarketOrder,
}: OrderFormProps) {
    const [tab, setTab] = useState<OrderTab>("limit");
    const [isBid, setIsBid] = useState(true);
    const [price, setPrice] = useState("");
    const [quantity, setQuantity] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<{
        message: string;
        digest: string;
        snippet?: string;
    } | null>(null);

    const pair = PAIR_LABELS[poolKey];

    const handleSubmit = async () => {
        setError(null);
        setSuccess(null);

        const qty = parseFloat(quantity);
        if (isNaN(qty) || qty <= 0) {
            setError("Enter a valid quantity");
            return;
        }

        if (tab === "limit") {
            const p = parseFloat(price);
            if (isNaN(p) || p <= 0) {
                setError("Enter a valid price");
                return;
            }
            setSubmitting(true);
            try {
                const digest = await onPlaceLimitOrder({ price: p, quantity: qty, isBid });
                setSuccess({
                    message: "Order placed",
                    digest,
                    snippet: placeLimitOrderSnippet(poolKey, p, qty, isBid),
                });
                setPrice("");
                setQuantity("");
            } catch (err) {
                setError(err instanceof Error ? err.message : "Order failed");
            } finally {
                setSubmitting(false);
            }
        } else {
            setSubmitting(true);
            try {
                const digest = await onPlaceMarketOrder({ quantity: qty, isBid });
                setSuccess({
                    message: "Order executed",
                    digest,
                    snippet: placeMarketOrderSnippet(poolKey, qty, isBid),
                });
                setQuantity("");
            } catch (err) {
                setError(err instanceof Error ? err.message : "Order failed");
            } finally {
                setSubmitting(false);
            }
        }
    };

    return (
        <div className="border w-full rounded-md overflow-hidden dark:border-zinc-900 bg-zinc-950">
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                    <ListOrdered className="h-4 w-4 text-zinc-500" />
                    Place Order
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                {/* Limit / Market tabs */}
                <div className="flex rounded-md border border-zinc-800 overflow-hidden">
                    <button
                        onClick={() => setTab("limit")}
                        className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                            tab === "limit"
                                ? "bg-zinc-800 text-zinc-100"
                                : "text-zinc-500 hover:text-zinc-300"
                        }`}
                    >
                        Limit
                    </button>
                    <button
                        onClick={() => setTab("market")}
                        className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                            tab === "market"
                                ? "bg-zinc-800 text-zinc-100"
                                : "text-zinc-500 hover:text-zinc-300"
                        }`}
                    >
                        Market
                    </button>
                </div>

                {/* Buy / Sell toggle */}
                <div className="flex rounded-md border border-zinc-800 overflow-hidden">
                    <button
                        onClick={() => setIsBid(true)}
                        className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                            isBid
                                ? "bg-emerald-900/40 text-emerald-400"
                                : "text-zinc-500 hover:text-zinc-300"
                        }`}
                    >
                        Buy {pair.base}
                    </button>
                    <button
                        onClick={() => setIsBid(false)}
                        className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                            !isBid
                                ? "bg-red-900/40 text-red-400"
                                : "text-zinc-500 hover:text-zinc-300"
                        }`}
                    >
                        Sell {pair.base}
                    </button>
                </div>

                {/* Price input (limit only) */}
                {tab === "limit" && (
                    <div>
                        <div className="flex items-center justify-between mb-1">
                            <label className="text-xs text-zinc-500">Price ({pair.quote})</label>
                            {midPrice != null && (
                                <span className="text-[11px] text-zinc-500">
                                    Mid: <span className="font-mono text-zinc-400">{midPrice}</span>
                                </span>
                            )}
                        </div>
                        <div className="flex gap-1.5">
                            <input
                                type="number"
                                value={price}
                                onChange={(e) => setPrice(e.target.value)}
                                placeholder={midPrice != null ? String(midPrice) : "0.00"}
                                min="0"
                                step="any"
                                className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            />
                            {midPrice != null && (
                                <div className="flex gap-1">
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setPrice(String(roundToTick(midPrice * 0.9, poolKey)))
                                        }
                                        className="rounded-md border border-zinc-800 px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300 hover:border-zinc-700 transition-colors"
                                    >
                                        -10%
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setPrice(String(roundToTick(midPrice, poolKey)))
                                        }
                                        className="rounded-md border border-zinc-800 px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300 hover:border-zinc-700 transition-colors"
                                    >
                                        Mid
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setPrice(String(roundToTick(midPrice * 1.1, poolKey)))
                                        }
                                        className="rounded-md border border-zinc-800 px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300 hover:border-zinc-700 transition-colors"
                                    >
                                        +10%
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Quantity input */}
                <div>
                    <label className="block text-xs text-zinc-500 mb-1">Size ({pair.base})</label>
                    <input
                        type="number"
                        value={quantity}
                        onChange={(e) => setQuantity(e.target.value)}
                        placeholder="0.00"
                        min="0"
                        step="any"
                        className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                </div>

                {/* Submit */}
                <Button
                    onClick={handleSubmit}
                    disabled={submitting}
                    className={`w-full ${
                        isBid
                            ? "bg-emerald-700 hover:bg-emerald-600 text-white"
                            : "bg-red-700 hover:bg-red-600 text-white"
                    }`}
                >
                    {submitting
                        ? "Submitting..."
                        : `Place ${isBid ? "Buy" : "Sell"} ${tab === "limit" ? "Limit" : "Market"}`}
                </Button>

                {error && <p className="text-xs text-red-400">{error}</p>}
                {success && (
                    <div>
                        <p className="text-xs text-emerald-400 flex items-center gap-1.5">
                            {success.message}
                            <a
                                href={`https://explorer.polymedia.app/txblock/${success.digest}?network=local`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-0.5 text-emerald-500 hover:text-emerald-300 underline"
                            >
                                View tx
                                <ExternalLink className="h-3 w-3" />
                            </a>
                        </p>
                        {success.snippet && (
                            <SdkCodeBlock code={success.snippet} docsUrl={SDK_DOCS.orders} />
                        )}
                    </div>
                )}
            </CardContent>
        </div>
    );
}
