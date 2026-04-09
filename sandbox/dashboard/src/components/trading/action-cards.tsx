import { useState } from "react";
import { ShoppingCart, BookOpen, XCircle, ExternalLink, Loader2 } from "lucide-react";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SdkCodeBlock } from "./sdk-code-block";
import {
    placeMarketOrderSnippet,
    placeLimitOrderSnippet,
    cancelAllOrdersSnippet,
    SDK_DOCS,
} from "./sdk-snippets";
import type { PoolKey } from "./types";

const PAIR_LABELS: Record<PoolKey, { base: string; quote: string }> = {
    DEEP_SUI: { base: "DEEP", quote: "SUI" },
    SUI_USDC: { base: "SUI", quote: "USDC" },
};

const DEFAULT_TICK = 0.000001;

function roundToTick(price: number, tick: number): number {
    return Math.floor(price / tick) * tick;
}

/* ------------------------------------------------------------------ */
/*  Market Order Card                                                  */
/* ------------------------------------------------------------------ */

interface MarketOrderCardProps {
    poolKey: PoolKey;
    minSize?: number;
    onPlace: (params: { quantity: number; isBid: boolean }) => Promise<string>;
}

export function MarketOrderCard({ poolKey, minSize, onPlace }: MarketOrderCardProps) {
    const [quantity, setQuantity] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<{ message: string; digest: string } | null>(null);

    const pair = PAIR_LABELS[poolKey];
    const qty = parseFloat(quantity) || 0;

    const handleSubmit = async (isBid: boolean) => {
        setError(null);
        setSuccess(null);
        if (qty <= 0) {
            setError("Enter a valid quantity");
            return;
        }
        setSubmitting(true);
        try {
            const digest = await onPlace({ quantity: qty, isBid });
            setSuccess({ message: `${isBid ? "Buy" : "Sell"} order executed`, digest });
            setQuantity("");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Order failed");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="border w-full rounded-md overflow-hidden dark:border-zinc-900 bg-zinc-950">
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                    <ShoppingCart className="h-4 w-4 text-zinc-500" />
                    Place Market Order
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                <p className="text-xs text-zinc-500">
                    Execute a trade at the best available price. The order fills immediately against
                    resting orders on the book.
                </p>

                <div>
                    <div className="flex items-center justify-between mb-1">
                        <label className="text-xs text-zinc-500">Quantity ({pair.base})</label>
                        {minSize != null && (
                            <span className="text-[11px] text-zinc-500">
                                Min: <span className="font-mono text-zinc-400">{minSize}</span>
                            </span>
                        )}
                    </div>
                    <input
                        type="number"
                        value={quantity}
                        onChange={(e) => {
                            setQuantity(e.target.value);
                            setError(null);
                            setSuccess(null);
                        }}
                        placeholder={minSize != null ? String(minSize) : "0"}
                        min="0"
                        step="any"
                        className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                </div>

                <div className="flex gap-2">
                    <Button
                        onClick={() => handleSubmit(true)}
                        disabled={submitting}
                        className="flex-1 bg-emerald-700 hover:bg-emerald-600 text-white"
                    >
                        {submitting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            `Buy ${pair.base}`
                        )}
                    </Button>
                    <Button
                        onClick={() => handleSubmit(false)}
                        disabled={submitting}
                        className="flex-1 bg-red-700 hover:bg-red-600 text-white"
                    >
                        {submitting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            `Sell ${pair.base}`
                        )}
                    </Button>
                </div>

                <SdkCodeBlock
                    code={placeMarketOrderSnippet(poolKey, qty || 10, true)}
                    docsUrl={SDK_DOCS.orders}
                    alwaysOpen
                />

                {error && <p className="text-xs text-red-400">{error}</p>}
                {success && (
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
                )}
            </CardContent>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/*  Limit Order Card                                                   */
/* ------------------------------------------------------------------ */

interface LimitOrderCardProps {
    poolKey: PoolKey;
    midPrice?: number;
    tickSize?: number;
    minSize?: number;
    onPlace: (params: { price: number; quantity: number; isBid: boolean }) => Promise<string>;
}

export function LimitOrderCard({
    poolKey,
    midPrice,
    tickSize,
    minSize,
    onPlace,
}: LimitOrderCardProps) {
    const [price, setPrice] = useState("");
    const [quantity, setQuantity] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<{ message: string; digest: string } | null>(null);

    const pair = PAIR_LABELS[poolKey];
    const tick = tickSize ?? DEFAULT_TICK;
    const p = parseFloat(price) || 0;
    const qty = parseFloat(quantity) || 0;

    const handleSubmit = async (isBid: boolean) => {
        setError(null);
        setSuccess(null);
        if (p <= 0) {
            setError("Enter a valid price");
            return;
        }
        if (qty <= 0) {
            setError("Enter a valid quantity");
            return;
        }
        setSubmitting(true);
        try {
            const digest = await onPlace({ price: p, quantity: qty, isBid });
            setSuccess({ message: `${isBid ? "Buy" : "Sell"} limit order placed`, digest });
            setPrice("");
            setQuantity("");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Order failed");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="border w-full rounded-md overflow-hidden dark:border-zinc-900 bg-zinc-950">
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                    <BookOpen className="h-4 w-4 text-zinc-500" />
                    Place Limit Order
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                <p className="text-xs text-zinc-500">
                    Place a resting order at a specific price. If the price doesn't match
                    immediately, the order stays on the book until filled or canceled.
                </p>

                {/* Price input */}
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
                            onChange={(e) => {
                                setPrice(e.target.value);
                                setError(null);
                                setSuccess(null);
                            }}
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
                                        setPrice(String(roundToTick(midPrice * 0.9, tick)))
                                    }
                                    className="rounded-md border border-zinc-800 px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300 hover:border-zinc-700 transition-colors"
                                >
                                    -10%
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setPrice(String(roundToTick(midPrice, tick)))}
                                    className="rounded-md border border-zinc-800 px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300 hover:border-zinc-700 transition-colors"
                                >
                                    Mid
                                </button>
                                <button
                                    type="button"
                                    onClick={() =>
                                        setPrice(String(roundToTick(midPrice * 1.1, tick)))
                                    }
                                    className="rounded-md border border-zinc-800 px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300 hover:border-zinc-700 transition-colors"
                                >
                                    +10%
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Quantity input */}
                <div>
                    <div className="flex items-center justify-between mb-1">
                        <label className="text-xs text-zinc-500">Size ({pair.base})</label>
                        {minSize != null && (
                            <span className="text-[11px] text-zinc-500">
                                Min: <span className="font-mono text-zinc-400">{minSize}</span>
                            </span>
                        )}
                    </div>
                    <input
                        type="number"
                        value={quantity}
                        onChange={(e) => {
                            setQuantity(e.target.value);
                            setError(null);
                            setSuccess(null);
                        }}
                        placeholder={minSize != null ? String(minSize) : "0"}
                        min="0"
                        step="any"
                        className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                </div>

                <div className="flex gap-2">
                    <Button
                        onClick={() => handleSubmit(true)}
                        disabled={submitting}
                        className="flex-1 bg-emerald-700 hover:bg-emerald-600 text-white"
                    >
                        {submitting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            `Buy ${pair.base}`
                        )}
                    </Button>
                    <Button
                        onClick={() => handleSubmit(false)}
                        disabled={submitting}
                        className="flex-1 bg-red-700 hover:bg-red-600 text-white"
                    >
                        {submitting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            `Sell ${pair.base}`
                        )}
                    </Button>
                </div>

                <SdkCodeBlock
                    code={placeLimitOrderSnippet(poolKey, p || 0.00003, qty || 10, true)}
                    docsUrl={SDK_DOCS.orders}
                    alwaysOpen
                />

                {error && <p className="text-xs text-red-400">{error}</p>}
                {success && (
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
                )}
            </CardContent>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/*  Cancel Orders Card                                                 */
/* ------------------------------------------------------------------ */

interface CancelOrdersCardProps {
    poolKey: PoolKey;
    orderCount: number;
    onCancelAll: () => Promise<string>;
}

export function CancelOrdersCard({ poolKey, orderCount, onCancelAll }: CancelOrdersCardProps) {
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<{ message: string; digest: string } | null>(null);

    const handleCancelAll = async () => {
        setError(null);
        setSuccess(null);
        setSubmitting(true);
        try {
            const digest = await onCancelAll();
            setSuccess({ message: `Canceled ${orderCount} order(s)`, digest });
        } catch (err) {
            setError(err instanceof Error ? err.message : "Cancel failed");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="border w-full rounded-md overflow-hidden dark:border-zinc-900 bg-zinc-950">
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                    <XCircle className="h-4 w-4 text-zinc-500" />
                    Cancel Orders
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                <p className="text-xs text-zinc-500">
                    Cancel all open orders for this pool. Individual orders can also be canceled by
                    their order ID.
                </p>

                <div className="flex items-center justify-between rounded-md bg-zinc-900/60 px-3 py-2">
                    <span className="text-xs text-zinc-400">
                        Open orders: <span className="font-mono text-zinc-200">{orderCount}</span>
                    </span>
                    <Button
                        onClick={handleCancelAll}
                        disabled={submitting || orderCount === 0}
                        size="sm"
                        variant="destructive"
                        className="gap-1"
                    >
                        {submitting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            "Cancel All Orders"
                        )}
                    </Button>
                </div>

                <SdkCodeBlock
                    code={cancelAllOrdersSnippet(poolKey)}
                    docsUrl={SDK_DOCS.orders}
                    alwaysOpen
                />

                {error && <p className="text-xs text-red-400">{error}</p>}
                {success && (
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
                )}
            </CardContent>
        </div>
    );
}
