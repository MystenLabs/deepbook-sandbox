import { ConnectButton, useCurrentAccount } from "@mysten/dapp-kit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function RequireWallet({ children }: { children: React.ReactNode }) {
    const account = useCurrentAccount();

    if (!account) {
        return (
            <div className="flex items-center justify-center py-24">
                <Card className="w-full max-w-sm text-center">
                    <CardHeader>
                        <CardTitle>Wallet Required</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col items-center gap-4">
                        <p className="text-sm text-muted-foreground">
                            Connect your wallet to continue.
                        </p>
                        <ConnectButton />
                    </CardContent>
                </Card>
            </div>
        );
    }

    return <>{children}</>;
}
