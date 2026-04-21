/**
 * Shared signing lock for faucet services that sign transactions from the
 * deployer wallet. Concurrent signs race on the deployer's gas coin /
 * object versions, so all faucet coin transfers must serialize through
 * this single lock.
 */

let signing = false;

export function tryAcquire(): boolean {
    if (signing) return false;
    signing = true;
    return true;
}

export function release(): void {
    signing = false;
}
