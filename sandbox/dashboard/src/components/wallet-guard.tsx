import { useCurrentWallet, useDAppKit } from "@mysten/dapp-kit-react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DEV_WALLET_NAME } from "@/dapp-kit";

/**
 * Warns when a wallet other than the bundled dev wallet is connected — the
 * connect modal filters those out, but a connection saved by an earlier
 * session is restored on load by dApp-kit's autoConnect, and every write then
 * fails at signing time (see DEV_WALLET_NAME's note for the two errors).
 */
export function WalletGuard() {
    const wallet = useCurrentWallet();
    const dAppKit = useDAppKit();

    if (!wallet || wallet.name === DEV_WALLET_NAME) return null;

    return (
        <div className="mb-6 flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-4">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div className="flex-1 space-y-1">
                <p className="text-sm font-semibold text-amber-200">
                    “{wallet.name}” can’t sign on this sandbox
                </p>
                <p className="text-xs text-muted-foreground">
                    The fork chain is only reachable through this page’s proxy, so external wallets
                    reject the <code>sui:localnet</code> chain or execute against the wrong node.
                    Disconnect and reconnect with the pre-funded{" "}
                    <span className="font-medium text-foreground">{DEV_WALLET_NAME}</span>.
                </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => dAppKit.disconnectWallet()}>
                Disconnect
            </Button>
        </div>
    );
}
