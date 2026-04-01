import { useBalanceManager, useWalletBalances, useBmBalances } from "./hooks";
import { BalanceManagerSetup } from "./balance-manager-setup";

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

            {/* Wallet balances */}
            {walletBalances.data && (
                <div className="border w-full rounded-md overflow-hidden dark:border-zinc-900 bg-zinc-950 px-4 py-3">
                    <div>
                        <p className="text-xs text-zinc-500 mb-1">
                            Wallet: {walletBalances.data.address.slice(0, 10)}...
                            {walletBalances.data.address.slice(-6)}
                        </p>
                        <div className="flex gap-4">
                            {Object.entries(walletBalances.data.balances).map(([coin, amount]) => (
                                <div key={coin} className="text-sm">
                                    <span className="text-zinc-500">{coin}: </span>
                                    <span className="font-mono text-zinc-200">
                                        {parseFloat(amount).toLocaleString("en-US", {
                                            maximumFractionDigits: 4,
                                        })}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Balance Manager setup, deposit & withdraw */}
            <BalanceManagerSetup
                isSetup={bm.isSetup}
                balanceManagerId={bm.balanceManagerId}
                balances={bmBalances.data}
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
