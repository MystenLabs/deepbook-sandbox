import { useBalanceManager, useWalletBalances, useBmBalances } from "./hooks";
import { BalanceManagerSetup } from "./balance-manager-setup";
import { CoinIcon } from "./coin-icon";

const DISPLAY_COINS = ["SUI", "DEEP"];

export function TradingPage() {
    const bm = useBalanceManager();
    const walletBalances = useWalletBalances();
    const bmBalances = useBmBalances(bm.balanceManagerId);

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="space-y-1">
                <h1 className="text-lg font-semibold">Trading</h1>
                <p className="text-xs text-muted-foreground pb-2">DEEP / SUI pool</p>
            </div>

            {/* Wallet balance */}
            {walletBalances.data && (
                <div className="border w-full rounded-md overflow-hidden dark:border-zinc-900 bg-zinc-950 px-4 py-3">
                    <p className="text-[11px] uppercase tracking-wider text-zinc-600 mb-2">
                        Your Balance
                    </p>
                    <div className="flex gap-5">
                        {DISPLAY_COINS.map((coin) => {
                            const amount = walletBalances.data!.balances[coin] ?? "0";
                            return (
                                <div key={coin} className="flex items-center gap-1.5 text-sm">
                                    <CoinIcon coin={coin} />
                                    <span className="text-zinc-400">{coin}</span>
                                    <span className="font-mono text-zinc-200">
                                        {parseFloat(amount).toLocaleString("en-US", {
                                            maximumFractionDigits: 4,
                                        })}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Balance Manager setup, deposit & withdraw */}
            <BalanceManagerSetup
                isSetup={bm.isSetup}
                balanceManagerId={bm.balanceManagerId}
                balances={bmBalances.data}
                walletBalances={walletBalances.data?.balances}
                onCreate={bm.create}
                onDeposit={bm.deposit}
                onWithdraw={bm.withdraw}
            />

            {/* TODO: Order form and open orders
            {bm.isSetup && (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <OrderForm ... />
                    <OpenOrders ... />
                </div>
            )}
            */}
        </div>
    );
}
