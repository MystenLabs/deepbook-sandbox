import { useState, useEffect } from "react";
import { useCurrentAccount, useSuiClientContext, useSuiClientQuery } from "@mysten/dapp-kit";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Check, ExternalLink } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Select,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectItem,
} from "@/components/ui/select";

const FAUCET_URL = "/api/faucet/faucet";
const MIST_PER_SUI = 1_000_000_000;

type Token = "SUI" | "DEEP";

function truncateAddress(addr: string) {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function explorerTxUrl(network: string, digest: string) {
    const net = network === "localnet" ? "local" : network;
    return `https://explorer.polymedia.app/txblock/${digest}?network=${net}`;
}

function formatBalance(balance: string | undefined, symbol: string) {
    if (!balance) return `0.0000 ${symbol}`;
    return `${(Number(balance) / MIST_PER_SUI).toFixed(4)} ${symbol}`;
}

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
    const account = useCurrentAccount();
    const address = account!.address;
    const { network } = useSuiClientContext();
    const queryClient = useQueryClient();

    const [copied, setCopied] = useState(false);
    const [token, setToken] = useState<Token>("SUI");

    const { data: allBalances, isLoading: balanceLoading } = useSuiClientQuery("getAllBalances", {
        owner: address,
    });

    const suiBalance = allBalances?.find((b) => b.coinType === "0x2::sui::SUI");
    const deepBalance = allBalances?.find((b) => b.coinType.endsWith("::deep::DEEP"));

    const faucet = useMutation({
        mutationFn: () => requestFaucet(address, token),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: [network, "getAllBalances"] });
        },
    });

    // Auto-dismiss feedback after 5s
    useEffect(() => {
        if (faucet.isIdle || faucet.isPending) return;
        const id = setTimeout(() => faucet.reset(), 5000);
        return () => clearTimeout(id);
    }, [faucet.status]);

    const copyAddress = async () => {
        await navigator.clipboard.writeText(address);
        setCopied(true);
    };

    useEffect(() => {
        if (!copied) return;
        const id = setTimeout(() => setCopied(false), 2000);
        return () => clearTimeout(id);
    }, [copied]);

    return (
        <Card className="max-w-md">
            <CardHeader>
                <CardTitle>Faucet</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                {/* Address */}
                <Row label="Address">
                    <button
                        onClick={copyAddress}
                        className="inline-flex items-center gap-1.5 font-mono text-sm hover:text-foreground text-muted-foreground transition-colors"
                    >
                        {truncateAddress(address)}
                        {copied ? (
                            <Check className="h-3.5 w-3.5" />
                        ) : (
                            <Copy className="h-3.5 w-3.5" />
                        )}
                    </button>
                </Row>

                {/* Balances */}
                <Row label="SUI Balance">
                    <BalanceValue
                        loading={balanceLoading}
                        value={formatBalance(suiBalance?.totalBalance, "SUI")}
                    />
                </Row>
                <Row label="DEEP Balance">
                    <BalanceValue
                        loading={balanceLoading}
                        value={formatBalance(deepBalance?.totalBalance, "DEEP")}
                    />
                </Row>

                {/* Token select */}
                <Row label="Token">
                    <Select value={token} onValueChange={(v) => setToken(v as Token)}>
                        <SelectTrigger className="w-[100px]">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="SUI">SUI</SelectItem>
                            <SelectItem value="DEEP">DEEP</SelectItem>
                        </SelectContent>
                    </Select>
                </Row>

                {/* Request button */}
                <Button
                    onClick={() => faucet.mutate()}
                    disabled={faucet.isPending}
                    className="w-full"
                >
                    {faucet.isPending ? "Requesting..." : `Request ${token}`}
                </Button>

                {/* Feedback */}
                {faucet.isSuccess && (
                    <div className="flex items-center gap-2">
                        <Badge variant="success">{token} requested successfully</Badge>
                        {faucet.data.digest && (
                            <a
                                href={explorerTxUrl(network, faucet.data.digest)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                            >
                                View tx <ExternalLink className="h-3 w-3" />
                            </a>
                        )}
                    </div>
                )}
                {faucet.isError && <Badge variant="destructive">{faucet.error.message}</Badge>}
            </CardContent>
        </Card>
    );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">{label}</span>
            {children}
        </div>
    );
}

function BalanceValue({ loading, value }: { loading: boolean; value: string }) {
    return loading ? (
        <Skeleton className="h-5 w-24" />
    ) : (
        <span className="text-sm font-medium">{value}</span>
    );
}
