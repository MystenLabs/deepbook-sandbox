import { useState } from "react";
import { Wallet, ArrowDownToLine, ArrowUpFromLine, ExternalLink, Loader2 } from "lucide-react";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CoinIcon } from "./coin-icon";
import type { CoinKey } from "./types";

interface BalanceManagerSetupProps {
    isSetup: boolean;
    balanceManagerId: string | null;
    balances?: Record<string, string>;
    walletBalances?: Record<string, string>;
    onCreate: () => Promise<{ balanceManagerId: string; digest: string }>;
    onDeposit: (coin: CoinKey, amount: number) => Promise<string>;
    onWithdraw: (coin: CoinKey, amount: number) => Promise<string>;
}

const COINS: CoinKey[] = ["SUI", "DEEP"];

function truncate(addr: string): string {
    if (addr.length <= 16) return addr;
    return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
}

function explorerUrl(objectId: string): string {
    return `https://explorer.polymedia.app/object/${objectId}?network=local`;
}

export function BalanceManagerSetup({
    isSetup,
    balanceManagerId,
    balances,
    walletBalances,
    onCreate,
    onDeposit,
    onWithdraw,
}: BalanceManagerSetupProps) {
    const [creating, setCreating] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<{ message: string; digest: string } | null>(null);
    const [coin, setCoin] = useState<CoinKey>("SUI");
    const [amount, setAmount] = useState("");

    const walletBalance = parseFloat(walletBalances?.[coin] ?? "0");
    const bmBalance = parseFloat(balances?.[coin] ?? "0");

    const handleCreate = async () => {
        setCreating(true);
        setError(null);
        try {
            const result = await onCreate();
            setSuccess({
                message: `Balance Manager created: ${result.balanceManagerId.slice(0, 12)}...`,
                digest: result.digest,
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create Balance Manager");
        } finally {
            setCreating(false);
        }
    };

    const handleAction = async (action: "deposit" | "withdraw") => {
        const amt = parseFloat(amount);
        if (isNaN(amt) || amt <= 0) {
            setError("Enter a valid amount");
            return;
        }

        // Client-side balance validation
        if (action === "deposit" && amt > walletBalance) {
            setError(`Insufficient wallet balance. You have ${walletBalance} ${coin}`);
            return;
        }
        if (action === "withdraw" && amt > bmBalance) {
            setError(`Insufficient Balance Manager funds. You have ${bmBalance} ${coin}`);
            return;
        }

        setLoading(true);
        setError(null);
        setSuccess(null);
        try {
            let digest: string;
            if (action === "deposit") {
                digest = await onDeposit(coin, amt);
                setSuccess({ message: `Deposited ${amt} ${coin}`, digest });
            } else {
                digest = await onWithdraw(coin, amt);
                setSuccess({ message: `Withdrew ${amt} ${coin}`, digest });
            }
            setAmount("");
        } catch (err) {
            setError(err instanceof Error ? err.message : `${action} failed`);
        } finally {
            setLoading(false);
        }
    };

    if (!isSetup) {
        return (
            <div className="border w-full rounded-md overflow-hidden dark:border-zinc-900 bg-zinc-950 p-6">
                <div className="flex flex-col items-center gap-4 py-8">
                    <Wallet className="h-10 w-10 text-zinc-500" />
                    <h2 className="text-lg font-semibold text-zinc-200">
                        Create a Balance Manager
                    </h2>
                    <p className="text-sm text-zinc-500 text-center max-w-md">
                        A Balance Manager is an on-chain escrow account required for trading. Funds
                        are deposited into it before placing orders.
                    </p>
                    <Button onClick={handleCreate} disabled={creating} className="mt-2">
                        {creating ? "Creating..." : "Create Balance Manager"}
                    </Button>
                    {error && <p className="text-xs text-red-400">{error}</p>}
                </div>
            </div>
        );
    }

    return (
        <div className="border w-full rounded-md overflow-hidden dark:border-zinc-900 bg-zinc-950">
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                    <Wallet className="h-4 w-4 text-zinc-500" />
                    Balance Manager
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                {/* BM ID with explorer link */}
                <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs text-zinc-500">
                        {balanceManagerId ? truncate(balanceManagerId) : ""}
                    </span>
                    {balanceManagerId && (
                        <a
                            href={explorerUrl(balanceManagerId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded p-0.5 text-zinc-500 transition-colors hover:text-zinc-200"
                        >
                            <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                    )}
                </div>

                {/* BM Balances with coin icons */}
                {balances && (
                    <div className="rounded-md bg-zinc-900/60 px-3 py-2.5">
                        <p className="text-[11px] uppercase tracking-wider text-zinc-600 mb-1.5">
                            Balance Manager Funds
                        </p>
                        <div className="flex gap-5">
                            {COINS.map((c) => (
                                <div key={c} className="flex items-center gap-1.5 text-sm">
                                    <CoinIcon coin={c} />
                                    <span className="text-zinc-400">{c}</span>
                                    <span className="font-mono text-zinc-200">
                                        {parseFloat(balances[c] ?? "0").toLocaleString("en-US", {
                                            maximumFractionDigits: 4,
                                        })}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Deposit / Withdraw controls */}
                <div className="flex gap-2">
                    <div className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2">
                        <CoinIcon coin={coin} />
                        <select
                            value={coin}
                            onChange={(e) => {
                                setCoin(e.target.value as CoinKey);
                                setAmount("");
                                setError(null);
                            }}
                            className="bg-transparent py-2 text-sm text-zinc-200 outline-none"
                        >
                            {COINS.map((c) => (
                                <option key={c} value={c}>
                                    {c}
                                </option>
                            ))}
                        </select>
                    </div>
                    <input
                        type="number"
                        value={amount}
                        onChange={(e) => {
                            setAmount(e.target.value);
                            setError(null);
                        }}
                        placeholder="Amount"
                        min="0"
                        step="any"
                        className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <Button
                        onClick={() => handleAction("deposit")}
                        disabled={loading}
                        size="sm"
                        className="gap-1 min-w-[90px]"
                    >
                        {loading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <ArrowDownToLine className="h-3.5 w-3.5" />
                        )}
                        Deposit
                    </Button>
                    <Button
                        onClick={() => handleAction("withdraw")}
                        disabled={loading}
                        size="sm"
                        variant="outline"
                        className="gap-1 min-w-[100px] border-zinc-800 text-zinc-300 hover:text-zinc-100"
                    >
                        {loading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <ArrowUpFromLine className="h-3.5 w-3.5" />
                        )}
                        Withdraw
                    </Button>
                </div>

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
