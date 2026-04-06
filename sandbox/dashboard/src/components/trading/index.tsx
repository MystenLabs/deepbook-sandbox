import { useDeepBookClient } from "@/hooks/use-deepbook-client";
import {
    useWalletBalances,
    useBmBalances,
    useMidPrice,
    usePoolParams,
    useTrading,
    useOpenOrders,
} from "./hooks";
import { BalanceManagerSetup } from "./balance-manager-setup";
import { MarketOrderCard, LimitOrderCard, CancelOrdersCard } from "./action-cards";
import { OpenOrders } from "./open-orders";
import { CoinIcon } from "./coin-icon";

const DISPLAY_COINS = ["SUI", "DEEP"];
const POOL_KEY = "DEEP_SUI" as const;

export function TradingPage() {
    const { client, isReady, address, isSetup, balanceManagerId } = useDeepBookClient();

    const walletBalances = useWalletBalances(address);
    const bmBalances = useBmBalances(client);
    const midPrice = useMidPrice(client, POOL_KEY);
    const poolParams = usePoolParams(client, POOL_KEY);
    const trading = useTrading(client, POOL_KEY, address);
    const openOrders = useOpenOrders(client, POOL_KEY, isSetup);

    if (!isReady) {
        return (
            <div className="space-y-4">
                <h1 className="text-lg font-semibold">Trading</h1>
                <p className="text-sm text-zinc-500">Connect your wallet to start trading.</p>
            </div>
        );
    }

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
                isSetup={isSetup}
                balanceManagerId={balanceManagerId}
                balances={bmBalances.data}
                walletBalances={walletBalances.data?.balances}
                onDeposit={trading.deposit}
                onWithdraw={trading.withdraw}
            />

            {/* Trading action cards */}
            {isSetup && (
                <div className="space-y-4">
                    <MarketOrderCard
                        poolKey={POOL_KEY}
                        minSize={poolParams.data?.minSize}
                        onPlace={trading.placeMarketOrder}
                    />
                    <LimitOrderCard
                        poolKey={POOL_KEY}
                        midPrice={midPrice.data}
                        tickSize={poolParams.data?.tickSize}
                        minSize={poolParams.data?.minSize}
                        onPlace={trading.placeLimitOrder}
                    />
                    <OpenOrders
                        poolKey={POOL_KEY}
                        orders={openOrders.data ?? []}
                        isLoading={openOrders.isLoading}
                        onCancelOrder={trading.cancelOrder}
                    />
                    <CancelOrdersCard
                        poolKey={POOL_KEY}
                        orderCount={(openOrders.data ?? []).length}
                        onCancelAll={trading.cancelAllOrders}
                    />
                </div>
            )}
        </div>
    );
}
