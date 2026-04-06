import { Wallet } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { CoinIcon } from "@/components/trading/coin-icon";
import { useWalletBalances } from "@/components/trading/hooks";

const COINS = ["SUI", "DEEP", "USDC"] as const;

export function WalletPopover() {
    const { data, isLoading } = useWalletBalances();

    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="text-zinc-400 hover:text-zinc-200">
                    <Wallet className="h-5 w-5" />
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 bg-zinc-950 border-zinc-800 p-3">
                <p className="text-[11px] uppercase tracking-wider text-zinc-600 mb-2">
                    Wallet Balance
                </p>
                {isLoading ? (
                    <p className="text-xs text-zinc-500">Loading...</p>
                ) : !data ? (
                    <p className="text-xs text-zinc-500">Not available</p>
                ) : (
                    <div className="space-y-1.5">
                        {COINS.map((coin) => {
                            const raw = data.balances[coin] ?? "0";
                            const amount = parseFloat(raw);
                            return (
                                <div
                                    key={coin}
                                    className="flex items-center justify-between text-sm"
                                >
                                    <div className="flex items-center gap-2">
                                        <CoinIcon coin={coin} />
                                        <span className="text-zinc-400">{coin}</span>
                                    </div>
                                    <span className="font-mono text-zinc-200">
                                        {amount.toLocaleString("en-US", {
                                            maximumFractionDigits: 4,
                                        })}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </PopoverContent>
        </Popover>
    );
}
