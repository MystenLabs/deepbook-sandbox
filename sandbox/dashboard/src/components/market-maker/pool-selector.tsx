import type { PoolOrders } from "./types";

/* ------------------------------------------------------------------ */
/*  Coin icons                                                         */
/* ------------------------------------------------------------------ */

const COIN_ICONS: Record<string, { src: string; className: string }> = {
    DEEP: { src: "/deepbook.jpeg", className: "h-4 w-4 rounded-full" },
    SUI: { src: "/svg/sui.svg", className: "h-4 w-4" },
    USDC: { src: "/svg/usdc.svg", className: "h-4 w-4 rounded-full" },
};

function PairIcons({ pair }: { pair: string }) {
    const [base, quote] = pair.split("/");
    const baseIcon = COIN_ICONS[base];
    const quoteIcon = COIN_ICONS[quote];
    return (
        <>
            <span>{base}</span>
            {baseIcon && <img src={baseIcon.src} alt={base} className={baseIcon.className} />}
            <svg
                height="16"
                viewBox="0 0 24 24"
                width="16"
                className="text-zinc-600"
                aria-hidden="true"
            >
                <path
                    d="M16 3.5L8 20.5"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
            <span>{quote}</span>
            {quoteIcon && <img src={quoteIcon.src} alt={quote} className={quoteIcon.className} />}
        </>
    );
}

/* ------------------------------------------------------------------ */
/*  Pool selector                                                      */
/* ------------------------------------------------------------------ */

interface PoolSelectorProps {
    pools: PoolOrders[];
    selectedIndex: number;
    onSelect: (index: number) => void;
}

export function PoolSelector({ pools, selectedIndex, onSelect }: PoolSelectorProps) {
    if (pools.length === 0) return null;

    return (
        <div className="flex flex-wrap gap-2">
            {pools.map((p, i) => {
                const active = i === selectedIndex;

                return (
                    <button
                        key={p.poolId}
                        onClick={() => onSelect(i)}
                        aria-pressed={active}
                        className={`flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs font-medium transition-colors ${
                            active
                                ? "border-zinc-600 bg-zinc-800 text-zinc-100 ring-1 ring-zinc-700"
                                : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700"
                        }`}
                    >
                        <PairIcons pair={p.pair} />
                    </button>
                );
            })}
        </div>
    );
}
