import { useState } from "react";
import { Wallet, Copy, Check, ExternalLink } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { CoinIcon } from "@/components/trading/coin-icon";
import { useWalletBalances } from "@/components/trading/hooks";

const COINS = ["SUI", "DEEP", "USDC"] as const;

function truncateAddress(addr: string) {
    return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

function explorerUrl(addr: string) {
    return `https://explorer.polymedia.app/address/${addr}?network=local`;
}

export function WalletPopover() {
    const { data, isLoading } = useWalletBalances();
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        if (!data?.address) return;
        await navigator.clipboard.writeText(data.address);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="text-zinc-400 hover:text-zinc-200">
                    <Wallet className="h-5 w-5" />
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 bg-zinc-950 border-zinc-800 p-3">
                {/* Address */}
                {data?.address && (
                    <div className="mb-3 pb-2.5 border-b border-zinc-800">
                        <p className="text-[11px] uppercase tracking-wider text-zinc-600 mb-1">
                            Address
                        </p>
                        <div className="flex items-center gap-1.5">
                            <span className="font-mono text-xs text-zinc-400">
                                {truncateAddress(data.address)}
                            </span>
                            <button
                                onClick={handleCopy}
                                className="rounded p-0.5 text-zinc-500 hover:text-zinc-300 transition-colors"
                            >
                                {copied ? (
                                    <Check className="h-3 w-3 text-emerald-400" />
                                ) : (
                                    <Copy className="h-3 w-3" />
                                )}
                            </button>
                            <a
                                href={explorerUrl(data.address)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="rounded p-0.5 text-zinc-500 hover:text-zinc-300 transition-colors"
                            >
                                <ExternalLink className="h-3 w-3" />
                            </a>
                        </div>
                    </div>
                )}

                {/* Balances */}
                <p className="text-[11px] uppercase tracking-wider text-zinc-600 mb-2">Balance</p>
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
