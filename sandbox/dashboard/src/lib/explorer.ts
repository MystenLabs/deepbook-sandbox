// Explorer links, and why a custom RPC URL cannot fix them on the fork.
//
// Polymedia Explorer — like Suiscan and SuiVision — is a JSON-RPC client. The
// sui-fork serves gRPC ONLY: POSTing `rpc.discover` or `sui_getChainIdentifier`
// at its RPC port returns an empty body (verified 2026-08-14). So no
// `?network=custom&rpc=…` variant can resolve fork state; these links were dead
// for a structural reason, not a misconfigured one. The old code emitted
// `?network=fork` (from the manifest's `network.type`) or a hardcoded
// `?network=local` left over from the localnet era — both unknown to the
// explorer, both a dead tab.
//
// What CAN resolve depends on where the id came from:
//
//   - Transactions are ALWAYS fork-local. Every tx the sandbox produces —
//     faucet grants, orders, BalanceManager creation — exists on no public
//     chain, so nothing will ever render it. Offer the digest to copy instead
//     of a link that 404s.
//   - Objects and addresses split by origin. Mainnet-INHERITED ids (packages,
//     pools, the registry — everything pinned in deployments/mainnet-fork.json)
//     exist on real mainnet and link there perfectly well, which is genuinely
//     useful for inspecting what the fork is built on. Fork-CREATED ids (a
//     BalanceManager you just made, the generated dev wallet) do not exist
//     anywhere public.

const EXPLORER = "https://explorer.polymedia.app";

/** Where an id came from, which decides whether anything public can show it. */
export type IdOrigin =
    /** pinned in the fork manifest — a real mainnet object */
    | "mainnet-inherited"
    /** created on the fork at runtime — exists nowhere else */
    | "fork-local";

/** Networks that are a mainnet fork: gRPC-only reads, and fork-local writes
 *  that no public explorer can see. */
export function isForkNetwork(network: string | undefined): boolean {
    return network === "fork" || network === "mainnet-fork";
}

/** The explorer's slug for a network, or null when it has no public explorer.
 *  A fork maps to `mainnet` — correct for the ids it inherited, and callers
 *  must not reach here for fork-local ones. */
function explorerSlug(network: string | undefined): string | null {
    if (!network) return null;
    if (isForkNetwork(network)) return "mainnet";
    if (network === "localnet" || network === "local") return "local";
    if (network === "mainnet" || network === "testnet" || network === "devnet") return network;
    return null;
}

/**
 * Explorer URL for a transaction, or `null` when nothing can resolve it.
 *
 * On a fork this is ALWAYS null — see the header. Callers should fall back to
 * showing the digest (see `TxResultLink`) rather than rendering a dead link.
 */
export function explorerTxUrl(network: string | undefined, digest: string): string | null {
    if (isForkNetwork(network)) return null;
    const slug = explorerSlug(network);
    return slug === null ? null : `${EXPLORER}/txblock/${digest}?network=${slug}`;
}

/**
 * Explorer URL for an object or address, or `null` when nothing can resolve it.
 *
 * `origin` is required rather than inferred: on a fork the difference between
 * a pool id and a freshly created BalanceManager is invisible in the id itself,
 * and guessing wrong sends the user to a 404.
 */
export function explorerObjectUrl(
    network: string | undefined,
    kind: "object" | "address",
    value: string,
    origin: IdOrigin,
): string | null {
    if (isForkNetwork(network) && origin === "fork-local") return null;
    const slug = explorerSlug(network);
    return slug === null ? null : `${EXPLORER}/${kind}/${value}?network=${slug}`;
}
