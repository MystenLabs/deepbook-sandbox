import { useState } from "react";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ListOrdered } from "lucide-react";
import type { PoolKey } from "./types";

type OrderTab = "limit" | "market";

interface OrderFormProps {
    poolKey: PoolKey;
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

export function OrderForm({ poolKey, onPlaceLimitOrder, onPlaceMarketOrder }: OrderFormProps) {
    const [tab, setTab] = useState<OrderTab>("limit");
    const [isBid, setIsBid] = useState(true);
    const [price, setPrice] = useState("");
    const [quantity, setQuantity] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

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
                setSuccess(`Order placed: ${digest.slice(0, 12)}...`);
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
                setSuccess(`Order executed: ${digest.slice(0, 12)}...`);
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
                        <label className="block text-xs text-zinc-500 mb-1">
                            Price ({pair.quote})
                        </label>
                        <input
                            type="number"
                            value={price}
                            onChange={(e) => setPrice(e.target.value)}
                            placeholder="0.00"
                            min="0"
                            step="any"
                            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
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
                {success && <p className="text-xs text-emerald-400">{success}</p>}
            </CardContent>
        </div>
    );
}
