// Shared FORK_CHECKPOINT resolution for every fork entry point (both devstack
// configs and the scripts/*.mjs runners), so the pin policy and its escape
// hatch live in one place.
//
// Why a pin at all: mainnet moved to the protocol-130 framework
// (0x2::scratch, epoch 1205, 2026-07-31), which the pinned fork rev
// (16f1402387) can't verify — executing any transaction against newer state
// aborts the fork (MISSING_DEPENDENCY on 0x2::scratch). Every later sui rev
// (current main AND the sui#27520 fix branch) instead crashes fork GENESIS on
// mainnet forks, so bumping the rev is not an option yet. Until an upstream
// fix lands, default to the last protocol-129-era checkpoint (tail of epoch
// 1204; validated by the funding e2e 2026-08-04). Details:
// ../scripts/spikes/devstack-funding/SUI-FORK-NOTES.md.
//
//   unset / ""  -> DEFAULT_FORK_CHECKPOINT (the pin)
//   "latest"    -> undefined (fork the live tip; currently aborts on the
//                  first transfer — see the notes above)
//   "<n>"       -> n (explicit pin)
export const DEFAULT_FORK_CHECKPOINT = 304941000;

export const resolveForkCheckpoint = (raw: string | undefined): number | undefined => {
    const value = raw?.trim();
    if (value === undefined || value === "") return DEFAULT_FORK_CHECKPOINT;
    if (value === "latest") return undefined;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0) {
        throw new Error(`FORK_CHECKPOINT must be a positive integer or "latest" (got "${raw}")`);
    }
    return n;
};
