import type { ReactNode } from "react";
import { Info, RefreshCw } from "lucide-react";
import { CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/* ------------------------------------------------------------------ */
/*  Card wrappers                                                      */
/* ------------------------------------------------------------------ */

export function CardWithPlus({ children }: { children: ReactNode }) {
    return (
        <div className="border w-full rounded-md overflow-hidden dark:border-zinc-900 bg-zinc-950">
            <div className="size-full bg-[url(/svg/plus.svg)] bg-repeat bg-[length:65px_65px]">
                <div className="size-full bg-gradient-to-tr from-zinc-950 via-zinc-950/[0.93] to-zinc-950">
                    {children}
                </div>
            </div>
        </div>
    );
}

export function StatCard({
    label,
    isLoading,
    tooltip,
    children,
}: {
    label: string;
    isLoading: boolean;
    tooltip?: string;
    children: ReactNode;
}) {
    return (
        <CardWithPlus>
            <CardContent className="py-4">
                <div className="flex items-center gap-1 text-xs text-zinc-500">
                    {label}
                    {tooltip && (
                        <TooltipProvider delayDuration={200}>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Info className="h-3 w-3 cursor-help text-zinc-600" />
                                </TooltipTrigger>
                                <TooltipContent>
                                    <p>{tooltip}</p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    )}
                </div>
                {isLoading ? (
                    <Skeleton className="mt-1 h-6 w-24 bg-zinc-800" />
                ) : (
                    <div className="mt-1 text-sm font-medium text-zinc-200">{children}</div>
                )}
            </CardContent>
        </CardWithPlus>
    );
}

/* ------------------------------------------------------------------ */
/*  Refresh button                                                     */
/* ------------------------------------------------------------------ */

export function RefreshButton({
    isFetching,
    onRefresh,
}: {
    isFetching: boolean;
    onRefresh: () => void;
}) {
    return (
        <button
            onClick={onRefresh}
            disabled={isFetching}
            aria-label="Refresh"
            className="rounded-md p-1 text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-50"
        >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
        </button>
    );
}

/* ------------------------------------------------------------------ */
/*  Formatters                                                         */
/* ------------------------------------------------------------------ */

export function formatPrice(price: number, pair: string): string {
    const decimals = pair.endsWith("/SUI") ? 6 : 4;
    return price.toFixed(decimals);
}

export function formatQuantity(qty: number): string {
    if (qty >= 1_000) return qty.toLocaleString("en-US", { maximumFractionDigits: 0 });
    return qty.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
