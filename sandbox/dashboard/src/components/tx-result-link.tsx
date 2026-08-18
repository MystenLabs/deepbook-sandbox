// The "View tx" affordance for a successful transaction.
//
// Renders a real explorer link where one can resolve, and a copy-the-digest
// button where none can — which on the fork is every transaction the sandbox
// produces (see lib/explorer.ts). Resolving the network here rather than at
// each call site keeps the six former hardcoded `?network=local` links from
// drifting apart again.

import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";

import { explorerTxUrl } from "@/lib/explorer";
import { isForkManifest, useManifest } from "@/hooks/use-deepbook-client";

export function TxResultLink({ digest, className }: { digest: string; className?: string }) {
    const manifest = useManifest();
    // Only the fork manifest carries `network`; the localnet shape has none.
    const network = manifest.data
        ? isForkManifest(manifest.data)
            ? manifest.data.network.type
            : "localnet"
        : undefined;
    const url = explorerTxUrl(network, digest);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return;
        const t = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(t);
    }, [copied]);

    const base = "inline-flex items-center gap-0.5 underline";

    if (url !== null) {
        return (
            <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className={className ?? `${base} text-emerald-500 hover:text-emerald-300`}
            >
                View tx
                <ExternalLink className="h-3 w-3" />
            </a>
        );
    }

    return (
        <button
            type="button"
            onClick={() => {
                void navigator.clipboard.writeText(digest);
                setCopied(true);
            }}
            title={`No public explorer can read fork transactions (the fork is gRPC-only), so here is the digest: ${digest}`}
            className={className ?? `${base} text-emerald-500 hover:text-emerald-300`}
        >
            {copied ? "Digest copied" : "Copy tx digest"}
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
    );
}
