import { useState } from "react";
import { Wallet, ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { CoinKey } from "./types";

interface BalanceManagerSetupProps {
    isSetup: boolean;
    balanceManagerId: string | null;
    balances?: Record<string, string>;
    onCreate: () => Promise<string>;
    onDeposit: (coin: CoinKey, amount: number) => Promise<string>;
    onWithdraw: (coin: CoinKey, amount: number) => Promise<string>;
}

const COINS: CoinKey[] = ["SUI", "DEEP"];

export function BalanceManagerSetup({
    isSetup,
    balanceManagerId,
    balances,
    onCreate,
    onDeposit,
    onWithdraw,
}: BalanceManagerSetupProps) {
    const [creating, setCreating] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [coin, setCoin] = useState<CoinKey>("SUI");
    const [amount, setAmount] = useState("1");

    const handleCreate = async () => {
        setCreating(true);
        setError(null);
        try {
            const bmId = await onCreate();
            setSuccess(`Balance Manager created: ${bmId.slice(0, 12)}...`);
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
        setLoading(true);
        setError(null);
        setSuccess(null);
        try {
            if (action === "deposit") {
                await onDeposit(coin, amt);
                setSuccess(`Deposited ${amt} ${coin}`);
            } else {
                await onWithdraw(coin, amt);
                setSuccess(`Withdrew ${amt} ${coin}`);
            }
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
                <p className="text-xs text-zinc-500">
                    {balanceManagerId?.slice(0, 16)}...{balanceManagerId?.slice(-8)}
                </p>

                {/* BM Balances */}
                {balances && (
                    <div className="rounded-md bg-zinc-900/60 px-3 py-2.5">
                        <p className="text-[11px] uppercase tracking-wider text-zinc-600 mb-1.5">
                            Balance Manager Funds
                        </p>
                        <div className="flex gap-5">
                            {Object.entries(balances).map(([c, amt]) => (
                                <div key={c} className="text-sm">
                                    <span className="text-zinc-500">{c}: </span>
                                    <span className="font-mono text-zinc-200">
                                        {parseFloat(amt).toLocaleString("en-US", {
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
                    <select
                        value={coin}
                        onChange={(e) => setCoin(e.target.value as CoinKey)}
                        className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
                    >
                        {COINS.map((c) => (
                            <option key={c} value={c}>
                                {c}
                            </option>
                        ))}
                    </select>
                    <input
                        type="number"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="Amount"
                        min="0"
                        step="0.1"
                        className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <Button
                        onClick={() => handleAction("deposit")}
                        disabled={loading}
                        size="sm"
                        className="gap-1"
                    >
                        <ArrowDownToLine className="h-3.5 w-3.5" />
                        {loading ? "..." : "Deposit"}
                    </Button>
                    <Button
                        onClick={() => handleAction("withdraw")}
                        disabled={loading}
                        size="sm"
                        variant="outline"
                        className="gap-1 border-zinc-800 text-zinc-300 hover:text-zinc-100"
                    >
                        <ArrowUpFromLine className="h-3.5 w-3.5" />
                        {loading ? "..." : "Withdraw"}
                    </Button>
                </div>

                {error && <p className="text-xs text-red-400">{error}</p>}
                {success && <p className="text-xs text-emerald-400">{success}</p>}
            </CardContent>
        </div>
    );
}
