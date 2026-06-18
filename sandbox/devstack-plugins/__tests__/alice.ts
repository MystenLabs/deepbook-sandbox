// Shared fixed recipient for the e2e fixture + test. alice is a `signer`
// account built from a constant 32-byte seed, so her address is deterministic
// and known at test-authoring time — the e2e test queries this exact address
// instead of discovering it (no log-parsing, no manifest ids-file lookup).
//
// NOT a secret: a throwaway key used only against a local mainnet fork. It signs
// nothing in the test (alice is a passive DEEP recipient); the fixed key exists
// purely so the recipient address is stable.

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const ALICE_SEED = new Uint8Array(32).fill(1);

export const ALICE_KEYPAIR = Ed25519Keypair.fromSecretKey(ALICE_SEED);

// Derived from ALICE_SEED (asserted in the e2e test):
// 0x29dfbf688abce7ab43bb8e70cae158ae961196e721440f515482f8ba1684390f
export const ALICE_ADDRESS = ALICE_KEYPAIR.toSuiAddress();
