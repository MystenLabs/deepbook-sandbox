import type { ReactNode } from "react";
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
    Box,
    Layers,
    Droplets,
    TrendingUp,
    Activity,
    Copy,
    Check,
    ExternalLink,
    RefreshCw,
} from "lucide-react";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { explorerObjectUrl } from "@/lib/explorer";

/* ------------------------------------------------------------------ */
/*  Types (matching deployment manifest shape)                         */
/* ------------------------------------------------------------------ */

interface ManifestPackage {
    packageId: string;
    objects: { objectId: string; objectType: string }[];
    transactionDigest: string;
}

interface ManifestPool {
    poolId: string;
    baseCoinType: string;
    quoteCoinType: string;
}

interface DeploymentManifest {
    network: { type: string; rpcUrl: string; faucetUrl: string };
    packages: Record<string, ManifestPackage>;
    pythOracles?: { deepPriceInfoObjectId: string; suiPriceInfoObjectId: string };
    pools: Record<string, ManifestPool>;
    marginPools: Record<string, string>;
    deploymentTime: string;
    deployerAddress: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const REFETCH_INTERVAL = 30_000;

const PACKAGE_LABELS: Record<string, string> = {
    token: "DEEP Token",
    deepbook: "DeepBook",
    pyth: "Pyth Oracle",
    usdc: "USDC",
    deepbook_margin: "DeepBook Margin",
    margin_liquidation: "Margin Liquidation",
};

/* ------------------------------------------------------------------ */
/*  DeploymentPage                                                     */
/* ------------------------------------------------------------------ */

/** The fork manifest (deployments/mainnet-fork.json) nests everything under
 *  `deepbook` — normalize it into this page's display shape. */
function normalizeManifest(raw: unknown): DeploymentManifest {
    const m = raw as {
        network?: { type?: string };
        verifiedAt?: string;
        deepbook?: {
            packages: Record<string, { latestId: string }>;
            pools: Record<string, { objectId: string; baseType: string; quoteType: string }>;
            adminWallet: string;
        };
    };
    if (m.network?.type === "fork" && m.deepbook) {
        return {
            network: {
                type: "fork",
                rpcUrl: "/api/sui (brokered fork RPC)",
                faucetUrl: "/api/faucet",
            },
            packages: Object.fromEntries(
                Object.entries(m.deepbook.packages).map(([key, pkg]) => [
                    key,
                    { packageId: pkg.latestId, transactionDigest: "", objects: [] },
                ]),
            ),
            pools: Object.fromEntries(
                Object.entries(m.deepbook.pools).map(([key, pool]) => [
                    key,
                    {
                        poolId: pool.objectId,
                        baseCoinType: pool.baseType,
                        quoteCoinType: pool.quoteType,
                    },
                ]),
            ),
            marginPools: {},
            deploymentTime: m.verifiedAt ?? new Date(0).toISOString(),
            deployerAddress: m.deepbook.adminWallet,
        };
    }
    return raw as DeploymentManifest;
}

export function DeploymentPage() {
    const manifest = useQuery<DeploymentManifest>({
        // NOT ["deployment-manifest"] — that key caches the RAW manifest for
        // useDeepBookClient; this page caches a normalized display shape.
        queryKey: ["deployment-manifest-display"],
        queryFn: async () => {
            const r = await fetch("/api/manifest");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return normalizeManifest(await r.json());
        },
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
    });

    if (manifest.isLoading) {
        return (
            <div className="space-y-4">
                <PageHeader />
                <div className="grid gap-4 sm:grid-cols-2">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-48 w-full rounded-md bg-zinc-900" />
                    ))}
                </div>
            </div>
        );
    }

    if (manifest.isError || !manifest.data) {
        return (
            <div className="space-y-4">
                <PageHeader />
                <CardWithGridEllipsis>
                    <CardContent className="py-12 text-center">
                        <p className="text-sm text-zinc-500">
                            No deployment manifest found. Run{" "}
                            <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
                                pnpm deploy-all
                            </code>{" "}
                            to deploy contracts.
                        </p>
                    </CardContent>
                </CardWithGridEllipsis>
            </div>
        );
    }

    const m = manifest.data;

    return (
        <div className="space-y-4">
            <PageHeader isFetching={manifest.isFetching} onRefresh={() => manifest.refetch()} />

            {/* Network & Deployer */}
            <CardWithGridEllipsis>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                        <Box className="h-4 w-4 text-zinc-500" />
                        Network & Deployer
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                    <Row label="Network">
                        <span className="text-sm font-medium text-zinc-200">{m.network.type}</span>
                    </Row>
                    <Row label="RPC URL">
                        <span className="text-sm font-medium text-zinc-200">
                            {m.network.rpcUrl}
                        </span>
                    </Row>
                    <Row label="Deployer">
                        <AddressCell
                            value={m.deployerAddress}
                            network={m.network.type}
                            kind="address"
                        />
                    </Row>
                    <Row label="Deployed">
                        <span className="text-sm font-medium text-zinc-200">
                            {new Date(m.deploymentTime).toLocaleString()}
                        </span>
                    </Row>
                </CardContent>
            </CardWithGridEllipsis>

            {/* Packages */}
            <CardWithGridEllipsis>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                        <Layers className="h-4 w-4 text-zinc-500" />
                        Packages
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                    {Object.entries(m.packages).map(([key, pkg]) => (
                        <Row key={key} label={PACKAGE_LABELS[key] ?? key}>
                            <AddressCell value={pkg.packageId} network={m.network.type} />
                        </Row>
                    ))}
                </CardContent>
            </CardWithGridEllipsis>

            {/* Pools */}
            <div className="grid gap-4 sm:grid-cols-2">
                {Object.entries(m.pools).map(([name, pool]) => (
                    <CardWithGridEllipsis key={name}>
                        <CardHeader className="flex flex-row items-center justify-between pb-2">
                            <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                                <Droplets className="h-4 w-4 text-zinc-500" />
                                {name.replace("_", "/")} Pool
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            <Row label="Pool ID">
                                <AddressCell value={pool.poolId} network={m.network.type} />
                            </Row>
                            <Row label="Base">
                                <span className="text-sm font-medium text-zinc-200 break-all">
                                    {shortCoinType(pool.baseCoinType)}
                                </span>
                            </Row>
                            <Row label="Quote">
                                <span className="text-sm font-medium text-zinc-200 break-all">
                                    {shortCoinType(pool.quoteCoinType)}
                                </span>
                            </Row>
                        </CardContent>
                    </CardWithGridEllipsis>
                ))}
            </div>

            {/* Margin Pools */}
            <CardWithGridEllipsis>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                        <TrendingUp className="h-4 w-4 text-zinc-500" />
                        Margin Pools
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                    {Object.entries(m.marginPools).map(([name, id]) => (
                        <Row key={name} label={name}>
                            <AddressCell value={id} network={m.network.type} />
                        </Row>
                    ))}
                </CardContent>
            </CardWithGridEllipsis>

            {/* Oracles */}
            {m.pythOracles && (
                <CardWithGridEllipsis>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                            <Activity className="h-4 w-4 text-zinc-500" />
                            Oracles
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <Row label="DEEP PriceInfoObject">
                            <AddressCell
                                value={m.pythOracles.deepPriceInfoObjectId}
                                network={m.network.type}
                            />
                        </Row>
                        <Row label="SUI PriceInfoObject">
                            <AddressCell
                                value={m.pythOracles.suiPriceInfoObjectId}
                                network={m.network.type}
                            />
                        </Row>
                    </CardContent>
                </CardWithGridEllipsis>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function PageHeader({
    isFetching,
    onRefresh,
}: {
    isFetching?: boolean;
    onRefresh?: () => void;
} = {}) {
    return (
        <div className="flex items-center justify-between">
            <div className="space-y-1">
                <h1 className="text-lg font-semibold">Deployment</h1>
                <p className="text-xs text-muted-foreground">
                    Contract addresses and configuration from the latest deployment
                </p>
            </div>
            {onRefresh && (
                <button
                    onClick={onRefresh}
                    disabled={isFetching}
                    className="rounded-md p-1 text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-50"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
                </button>
            )}
        </div>
    );
}

function CardWithGridEllipsis({ children }: { children: ReactNode }) {
    return (
        <div className="border w-full rounded-md overflow-hidden dark:border-zinc-900 dark:bg-zinc-950 p-1">
            <div className="size-full bg-repeat bg-[url(/svg/grid-ellipsis.svg)] bg-[length:25px_25px]">
                <div className="size-full bg-gradient-to-tr from-zinc-950 via-zinc-950/70 to-zinc-950">
                    {children}
                </div>
            </div>
        </div>
    );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-4">
            <span className="shrink-0 text-sm text-zinc-500">{label}</span>
            {children}
        </div>
    );
}

function AddressCell({
    value,
    network,
    kind = "object",
}: {
    value: string;
    network: string;
    kind?: "object" | "address";
}) {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return;
        const id = setTimeout(() => setCopied(false), 2000);
        return () => clearTimeout(id);
    }, [copied]);

    const copy = async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
    };

    // These ids come from the manifest, i.e. they are mainnet-inherited — so on
    // a fork they resolve on the MAINNET explorer, which is the useful target.
    // (The old code emitted `?network=fork` here and simply 404'd.)
    const explorerUrl = explorerObjectUrl(network, kind, value, "mainnet-inherited");

    return (
        <span className="inline-flex items-center gap-1.5">
            <span className="font-mono text-sm text-zinc-200">{truncate(value)}</span>
            <button
                onClick={copy}
                className="rounded p-0.5 text-zinc-500 transition-colors hover:text-zinc-200"
            >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            {explorerUrl !== null && (
                <a
                    href={explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View on the mainnet explorer — the fork inherits this object from mainnet"
                    className="rounded p-0.5 text-zinc-500 transition-colors hover:text-zinc-200"
                >
                    <ExternalLink className="h-3.5 w-3.5" />
                </a>
            )}
        </span>
    );
}

function truncate(addr: string): string {
    if (addr.length <= 16) return addr;
    return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

function shortCoinType(coinType: string): string {
    // "0xabc123::deep::DEEP" -> "deep::DEEP"
    const parts = coinType.split("::");
    if (parts.length >= 2) return parts.slice(-2).join("::");
    return coinType;
}
