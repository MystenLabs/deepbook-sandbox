import type { ReactNode } from "react";
import { useState, useEffect } from "react";
import { useCurrentAccount, useCurrentNetwork } from "@mysten/dapp-kit-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Check, ExternalLink } from "lucide-react";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useWalletBalances } from "@/components/trading/hooks";

const FAUCET_URL = "/api/faucet";

type Token = "SUI" | "DEEP" | "USDC";

async function requestFaucet(address: string, token: Token) {
    const res = await fetch(FAUCET_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, token }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error ?? "Unknown error");
    return data as { digest?: string };
}

export function FaucetPage() {
    const network = useCurrentNetwork();
    const account = useCurrentAccount();
    const queryClient = useQueryClient();

    const address = account?.address ?? null;
    const { data: walletData, isLoading: balanceLoading } = useWalletBalances(address);

    const suiBalanceStr = walletData?.balances?.SUI ?? "0";
    const deepBalanceStr = walletData?.balances?.DEEP ?? "0";
    const usdcBalanceStr = walletData?.balances?.USDC ?? "0";

    const [copied, setCopied] = useState(false);

    const suiFaucet = useMutation({
        mutationFn: () => requestFaucet(address!, "SUI"),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["wallet-balances"] });
        },
    });

    const deepFaucet = useMutation({
        mutationFn: () => requestFaucet(address!, "DEEP"),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["wallet-balances"] });
        },
    });

    const usdcFaucet = useMutation({
        mutationFn: () => requestFaucet(address!, "USDC"),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["wallet-balances"] });
        },
    });

    // Auto-dismiss feedback after 5s
    useEffect(() => {
        if (suiFaucet.isIdle || suiFaucet.isPending) return;
        const id = setTimeout(() => suiFaucet.reset(), 5000);
        return () => clearTimeout(id);
    }, [suiFaucet.status]);

    useEffect(() => {
        if (deepFaucet.isIdle || deepFaucet.isPending) return;
        const id = setTimeout(() => deepFaucet.reset(), 5000);
        return () => clearTimeout(id);
    }, [deepFaucet.status]);

    useEffect(() => {
        if (usdcFaucet.isIdle || usdcFaucet.isPending) return;
        const id = setTimeout(() => usdcFaucet.reset(), 5000);
        return () => clearTimeout(id);
    }, [usdcFaucet.status]);

    const copyAddress = async () => {
        if (!address) return;
        await navigator.clipboard.writeText(address);
        setCopied(true);
    };

    useEffect(() => {
        if (!copied) return;
        const id = setTimeout(() => setCopied(false), 2000);
        return () => clearTimeout(id);
    }, [copied]);

    if (!address) {
        return (
            <div className="space-y-4">
                <h1 className="text-lg font-semibold">Faucet</h1>
                <p className="text-sm text-zinc-500">Connect your wallet to use the faucet.</p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <div className="space-y-1">
                <h1 className="text-lg font-semibold">Faucet</h1>
                <p className="text-xs text-muted-foreground">Request tokens for your wallet</p>
            </div>

            {/* Address row */}
            <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Wallet:</span>
                <button
                    onClick={copyAddress}
                    className="inline-flex items-center gap-1.5 font-mono text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                    {truncateAddress(address)}
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
                {/* SUI Card */}
                <LinesCard>
                    <CardHeader className="flex flex-row items-center gap-3 pb-2">
                        <img src="/svg/sui.svg" alt="SUI" className="h-8 w-8" />
                        <CardTitle className="text-sm font-medium text-zinc-200">SUI</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <Row label="Balance">
                            <BalanceValue
                                loading={balanceLoading}
                                value={`${parseFloat(suiBalanceStr).toFixed(4)} SUI`}
                            />
                        </Row>
                        <Button
                            onClick={() => suiFaucet.mutate()}
                            disabled={suiFaucet.isPending}
                            className="w-full"
                        >
                            {suiFaucet.isPending ? "Requesting..." : "Request SUI"}
                        </Button>
                        <FaucetFeedback faucet={suiFaucet} token="SUI" network={network} />
                    </CardContent>
                </LinesCard>

                {/* DEEP Card */}
                <LinesCard>
                    <CardHeader className="flex flex-row items-center gap-3 pb-2">
                        <img src="/deepbook.jpeg" alt="DEEP" className="h-8 w-8 rounded-full" />
                        <CardTitle className="text-sm font-medium text-zinc-200">DEEP</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <Row label="Balance">
                            <BalanceValue
                                loading={balanceLoading}
                                value={`${parseFloat(deepBalanceStr).toFixed(4)} DEEP`}
                            />
                        </Row>
                        <Button
                            onClick={() => deepFaucet.mutate()}
                            disabled={deepFaucet.isPending}
                            className="w-full"
                        >
                            {deepFaucet.isPending ? "Requesting..." : "Request DEEP"}
                        </Button>
                        <FaucetFeedback faucet={deepFaucet} token="DEEP" network={network} />
                    </CardContent>
                </LinesCard>

                {/* USDC Card */}
                <LinesCard>
                    <CardHeader className="flex flex-row items-center gap-3 pb-2">
                        <img src="/svg/usdc.svg" alt="USDC" className="h-8 w-8 rounded-full" />
                        <CardTitle className="text-sm font-medium text-zinc-200">USDC</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <Row label="Balance">
                            <BalanceValue
                                loading={balanceLoading}
                                value={`${parseFloat(usdcBalanceStr).toFixed(4)} USDC`}
                            />
                        </Row>
                        <Button
                            onClick={() => usdcFaucet.mutate()}
                            disabled={usdcFaucet.isPending}
                            className="w-full"
                        >
                            {usdcFaucet.isPending ? "Requesting..." : "Request USDC"}
                        </Button>
                        <FaucetFeedback faucet={usdcFaucet} token="USDC" network={network} />
                    </CardContent>
                </LinesCard>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function LinesCard({ children }: { children: ReactNode }) {
    return (
        <div className="dark border w-full rounded-md overflow-hidden border-zinc-900 bg-zinc-950 p-1 text-zinc-50">
            <div className="size-full bg-[url(/svg/lines.svg)] bg-repeat bg-[length:30px_30px]">
                <div className="size-full bg-gradient-to-tr from-zinc-950 via-zinc-950/80 to-zinc-900/10">
                    {children}
                </div>
            </div>
        </div>
    );
}

function FaucetFeedback({
    faucet,
    token,
    network,
}: {
    faucet: {
        isSuccess: boolean;
        isError: boolean;
        data?: { digest?: string };
        error?: Error | null;
    };
    token: Token;
    network: string;
}) {
    if (faucet.isSuccess) {
        return (
            <div className="flex items-center gap-2">
                <Badge variant="success">{token} requested</Badge>
                {faucet.data?.digest && (
                    <a
                        href={explorerTxUrl(network, faucet.data.digest)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-200"
                    >
                        View tx <ExternalLink className="h-3 w-3" />
                    </a>
                )}
            </div>
        );
    }
    if (faucet.isError) {
        return <Badge variant="destructive">{faucet.error?.message}</Badge>;
    }
    return null;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-500">{label}</span>
            {children}
        </div>
    );
}

function BalanceValue({ loading, value }: { loading: boolean; value: string }) {
    return loading ? (
        <Skeleton className="h-5 w-24 bg-zinc-800" />
    ) : (
        <span className="text-sm font-medium text-zinc-200">{value}</span>
    );
}

function truncateAddress(addr: string) {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function explorerTxUrl(network: string, digest: string) {
    const net = network === "localnet" ? "local" : network;
    return `https://explorer.polymedia.app/txblock/${digest}?network=${net}`;
}
