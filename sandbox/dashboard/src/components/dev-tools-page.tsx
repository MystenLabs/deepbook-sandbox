import { useState } from "react";
import { useDAppKit, useCurrentAccount } from "@mysten/dapp-kit-react";
import { useQuery } from "@tanstack/react-query";
import { Transaction } from "@mysten/sui/transactions";
import { Button } from "@/components/ui/button";

export function DevToolsPage() {
    const account = useCurrentAccount();
    const dAppKit = useDAppKit();
    const [bmId, setBmId] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const manifest = useQuery<{ packages: Record<string, { packageId: string }> }>({
        queryKey: ["deployment-manifest"],
        queryFn: async () => {
            const r = await fetch("/api/manifest");
            if (!r.ok) throw new Error("Manifest not found");
            return r.json();
        },
        staleTime: Infinity,
    });

    const handleCreateBM = async () => {
        if (!manifest.data) return;
        setLoading(true);
        setError(null);
        try {
            const pkgId = manifest.data.packages.deepbook.packageId;
            const tx = new Transaction();
            const bm = tx.moveCall({
                target: `${pkgId}::balance_manager::new`,
                arguments: [],
            });
            tx.moveCall({
                target: "0x2::transfer::public_share_object",
                arguments: [bm],
                typeArguments: [`${pkgId}::balance_manager::BalanceManager`],
            });

            const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });

            if (result.$kind === "FailedTransaction") {
                throw new Error(
                    result.FailedTransaction.status.error?.message ?? "Transaction failed",
                );
            }

            const txData = result.Transaction!;
            const created = txData.effects?.changedObjects?.find(
                (obj: { idOperation: string; outputState: string; objectId: string }) =>
                    obj.idOperation === "Created" && obj.outputState !== "PackageWrite",
            );

            setBmId(created?.objectId ?? `Created (digest: ${txData.digest})`);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-4">
            <h1 className="text-lg font-semibold">Dev Tools</h1>

            <div className="border rounded-md p-4 dark:border-zinc-900 bg-zinc-950 space-y-3">
                <p className="text-xs text-zinc-500">
                    Connected:{" "}
                    <span className="font-mono text-zinc-300">{account?.address ?? "none"}</span>
                </p>

                <Button onClick={handleCreateBM} disabled={loading || !account || !manifest.data}>
                    {loading ? "Creating..." : "Create Balance Manager (with wallet)"}
                </Button>

                {bmId && (
                    <p className="text-xs text-emerald-400 font-mono break-all">
                        BM created: {bmId}
                    </p>
                )}
                {error && <p className="text-xs text-red-400">{error}</p>}
            </div>
        </div>
    );
}
