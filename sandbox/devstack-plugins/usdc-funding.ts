// USDC funding-strategy plugin for the DeepBook sandbox's devstack fork.
//
// Contributes a `coinType:<USDC>` funding strategy so that
// `account('alice', { funding: [{ coin: usdc, amount }] })` is funded by MINTING
// native USDC on the fork. Unlike DEEP (fixed-supply, transferred from a whale),
// USDC is mintable, so there is no donor or session-drain ceiling — only a
// per-request cap for realism. The minter identities + rationale live in
// `sandbox/deployments/fork-impersonation.md`.
//
// Mechanism (validated by scripts/spikes/usdc/ + an end-to-end fork probe):
//   - Native USDC is a regulated coin: the `TreasuryCap<USDC>` is NOT
//     address-owned; it lives under a shared `Treasury<USDC>`, gated by a
//     controller -> minter allowlist (each minter holds a `MintCap`). So
//     `coin::mint` does not work — minting goes through the stablecoin framework's
//     `treasury::mint` as a configured minter.
//   - We impersonate Circle's master-minter (empty-sig execution — the fork runs
//     a tx as the declared sender without its key). One-time per fork:
//     `configure_new_controller(treasury, MM, MM)` + `configure_minter(treasury,
//     denylist, allowance)` mints a `MintCap` owned by MM. Per request:
//     `treasury::mint(treasury, mintCap, denylist, amount, recipient)`.
//   - The master-minter holds no SUI on the fork, so every tx is SPONSORED: the
//     sender is MM but the gas owner is a SUI donor (the DEEP whale) — empty-sig
//     impersonation accepts sender != gas-owner (probe-confirmed), which avoids a
//     separate gas-funding step. The donor's SUI coin is resolved by KNOWN id
//     (the fork can't enumerate un-fetched mainnet coins).
//   - The created MintCap + minted coins are fork-LOCAL objects, which DO
//     enumerate, so the MintCap is discovered via listOwnedObjects(MM).
//
// KNOWN BLOCKER (sui-fork): minting USDC trips the same GetCoinInfo abort as DEEP
// (USDC is a migrated CoinRegistry coin) — the patched fork (`get_coin_info ->
// Ok(None)`) is required. configure_* touch no coins and work on a stock fork;
// only the mint does. See scripts/spikes/devstack-funding/SUI-FORK-NOTES.md.

import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { Effect } from "effect";
import {
  account,
  definePlugin,
  PluginContext,
  sui,
  type AccountFundingStrategy,
  type FaucetBodyError,
  type FaucetUnreachable,
} from "@mysten-incubation/devstack";

/** Mainnet native USDC coin type — the fork inherits mainnet state. */
export const USDC_COIN_TYPE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const USDC_DECIMALS = 6n;

// Circle stablecoin framework + the shared objects the mint flow touches. Verified
// on mainnet 2026-06-19 (pnpm verify:usdc-minter); see fork-impersonation.md.
const DEFAULT_STABLECOIN_PACKAGE =
  "0xecf47609d7da919ea98e7fd04f6e0648a0a79b337aaad373fa37aac8febf19c8";
const DEFAULT_TREASURY_ID =
  "0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7";
const TREASURY_INITIAL_SHARED_VERSION = "313333795";
// System DenyList (0x...403), shared; mint/configure take it by immutable ref.
const DENY_LIST_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000403";
const DENY_LIST_INITIAL_SHARED_VERSION = "65624845";

// Circle's master-minter (the impersonated sender) and the SUI donor that
// sponsors gas (the DEEP whale + a known SUI coin of its). Override via
// USDC_MINTER_ADDRESS / USDC_GAS_SPONSOR / SUI_GAS_COIN_ID; refresh the minter
// after a Circle rotation with `node scripts/verify-usdc-minter.mjs`.
const DEFAULT_MASTER_MINTER =
  "0x41c0c6d67577b39f31a5fe4052314fd3a8b7c7f890676f60e007bd390e397ac1";
const DEFAULT_GAS_SPONSOR =
  "0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d";
const DEFAULT_GAS_COIN_ID =
  "0xc866352dd2574aa14752dd09afca89cd993f573c59218ff278c3dafbd24ca714";

/** Minter allowance set at configure time (base units). USDC is mintable, so this
 *  is generous headroom (1e9 USDC) — the per-request cap is the real guardrail. */
const MINT_ALLOWANCE = 1_000_000_000n * 10n ** USDC_DECIMALS;
/** Default per-request cap (whole USDC; env MAX_USDC_PER_FAUCET_REQUEST). */
const DEFAULT_PER_REQUEST_USDC = 1_000_000; // 1M USDC

// Must match devstack's internal fork-impersonation constants so the empty-sig
// tx validates against the fork.
const FORK_GAS_BUDGET = 100_000_000n;
const FORK_GAS_PRICE = 1_000n;

// --- Subsets of devstack's public `sui` plugin value that we consume ---

type ObjRef = { objectId: string; version: string; digest: string };
type SharedRef = { objectId: string; initialSharedVersion: string; mutable: boolean };
/** The fork gRPC client surface we use. `getObject` resolves an object by KNOWN
 *  id (the donor's gas coin, and the MintCap's type after configure);
 *  `executeTransaction` with empty signatures is the impersonation path — its
 *  result carries `effects.changedObjects` from which we discover the created
 *  MintCap (a fork-local object). */
export type ForkCore = {
  getObject: (args: { objectId: string }) => Promise<{
    object?: { objectId: string; version: string; digest: string; type?: string };
  }>;
  executeTransaction: (args: {
    transaction: Uint8Array;
    signatures: readonly string[];
    include?: { effects?: boolean; objectTypes?: boolean };
  }) => Promise<unknown>;
};

// --- Tagged errors devstack's funding/faucet model expects (constructed
// directly — the factory helpers are internal to devstack). Transport failure ->
// FaucetUnreachable; cap hit / configure or mint revert -> FaucetBodyError. ---

const sentinelUrl = (minter: string) => `fork-impersonation://${minter}`;

function bodyError(minter: string, address: string, amount: bigint, message: string): FaucetBodyError {
  return { _tag: "FaucetBodyError", url: sentinelUrl(minter), address, amount, status: 0, reason: "failure-status", message };
}
function unreachable(minter: string, address: string, amount: bigint, message: string, cause: unknown): FaucetUnreachable {
  return { _tag: "FaucetUnreachable", url: sentinelUrl(minter), address, amount, message, cause };
}
const isTagged = (e: unknown): e is FaucetBodyError | FaucetUnreachable =>
  typeof e === "object" && e !== null && ((e as { _tag?: string })._tag === "FaucetBodyError" || (e as { _tag?: string })._tag === "FaucetUnreachable");

// Detect a revert in the real @mysten/sui v2 `TransactionResult` envelope (same
// shape DEEP uses): { $kind: 'Transaction'|'FailedTransaction', <kind>: { status,
// effects?: { status } } }. Returns null when no failure is detected.
function executionFailureReason(raw: unknown): string | null {
  type Status = { success?: boolean; error?: unknown };
  type Tx = { status?: Status; effects?: { status?: Status } };
  const r = raw as { $kind?: string; Transaction?: Tx; FailedTransaction?: Tx };
  if (r?.$kind === "FailedTransaction") {
    const f = r.FailedTransaction;
    const status = f?.status ?? f?.effects?.status;
    return JSON.stringify(status?.error ?? status ?? "FailedTransaction");
  }
  const status = r?.Transaction?.status ?? r?.Transaction?.effects?.status;
  if (status?.success === false) return JSON.stringify(status.error ?? status);
  return null;
}

/** Object ids newly created by a successful tx (from `effects.changedObjects`,
 *  `inputState: 'DoesNotExist'`). The MintCap that `configure_minter` mints is
 *  fork-local, so we discover it here rather than enumerating owned objects
 *  (which devstack's typed `sdk.core` doesn't expose). */
function createdObjectIds(raw: unknown): string[] {
  const r = raw as {
    Transaction?: { effects?: { changedObjects?: ReadonlyArray<{ objectId?: string; inputState?: string; idOperation?: string }> } };
  };
  const changed = r?.Transaction?.effects?.changedObjects ?? [];
  return changed
    .filter((o) => o.inputState === "DoesNotExist" || o.idOperation === "Created")
    .map((o) => o.objectId)
    .filter((id): id is string => typeof id === "string");
}

/** Build empty-sig (impersonation) tx bytes OFFLINE for a SPONSORED tx: `sender`
 *  authorizes the calls; `gasOwner` pays gas from `gas` (a concrete ref). */
async function buildSponsoredBytes(tx: Transaction, sender: string, gasOwner: string, gas: ObjRef): Promise<Uint8Array> {
  tx.setSender(sender);
  tx.setGasOwner(gasOwner);
  tx.setGasPayment([gas]);
  tx.setGasBudget(FORK_GAS_BUDGET);
  tx.setGasPrice(FORK_GAS_PRICE);
  if (tx.getData().expiration == null) tx.setExpiration({ None: true });
  await tx.prepareForSerialization({});
  const data = tx.getData();
  for (const input of data.inputs) {
    if ((input as { UnresolvedObject?: unknown }).UnresolvedObject !== undefined) {
      throw new Error("usdc-funding: an object input is unresolved; build the PTB with concrete refs.");
    }
  }
  return TransactionDataBuilder.restore(data).build();
}

async function objRefById(core: ForkCore, objectId: string): Promise<ObjRef> {
  const res = await core.getObject({ objectId });
  const o = res.object;
  if (o === undefined) throw new Error(`object ${objectId} not found on the fork`);
  return { objectId: o.objectId, version: o.version, digest: o.digest };
}

// --- The funding strategy (exported so it can be unit-tested against a stub) ---

export type UsdcFundingStrategyArgs = {
  core: ForkCore;
  /** non-null ⇒ fork mode (the only mode impersonation works in). */
  fork: object | null;
  /** Circle master-minter address (impersonated sender). */
  minter: string;
  /** SUI donor that sponsors gas (gas owner) + a known SUI coin id of theirs. */
  gasSponsor: string;
  gasCoinId: string;
  stablecoinPackage: string;
  treasury: SharedRef;
  denyList: SharedRef;
  coinType: string;
  /** minter allowance set at configure time (base units). */
  allowance: bigint;
  /** per-request cap in BASE units (USDC, 6 dp). */
  perRequestCap: bigint;
  /** optional pre-known MintCap id to reuse (skips configure on a warm fork). */
  knownMintCapId?: string;
};

export function usdcFundingStrategy(args: UsdcFundingStrategyArgs): AccountFundingStrategy {
  const { core, fork, minter, gasSponsor, gasCoinId, stablecoinPackage, treasury, denyList, coinType, allowance, perRequestCap, knownMintCapId } = args;

  // The master-minter's MintCap is configured once per fork; cache the promise.
  let mintCapSetup: Promise<string> | null = null;
  // All minter txs share the donor's single gas coin, so serialize them (a tx
  // bumps the gas coin's version, invalidating a concurrent tx's gas ref).
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  /** Is `objectId` a MintCap<coinType> the minter can use? (defends a reused id.) */
  const isMintCap = async (objectId: string): Promise<boolean> => {
    try {
      const o = (await core.getObject({ objectId })).object;
      return o !== undefined && (o.type ?? "").includes("::treasury::MintCap<");
    } catch {
      return false;
    }
  };

  const ensureMintCap = (): Promise<string> => {
      mintCapSetup ??= (async () => {
          // Reuse a pre-known MintCap (e.g. a warm fork) if it's still valid.
          if (knownMintCapId !== undefined && (await isMintCap(knownMintCapId))) return knownMintCapId;

          const gas = await objRefById(core, gasCoinId);
          const tx = new Transaction();
          tx.moveCall({
              target: `${stablecoinPackage}::treasury::configure_new_controller`,
              typeArguments: [coinType],
              arguments: [tx.sharedObjectRef(treasury), tx.pure.address(minter), tx.pure.address(minter)],
          });
          tx.moveCall({
              target: `${stablecoinPackage}::treasury::configure_minter`,
              typeArguments: [coinType],
              arguments: [tx.sharedObjectRef(treasury), tx.sharedObjectRef(denyList), tx.pure.u64(allowance)],
          });
          const bytes = await buildSponsoredBytes(tx, minter, gasSponsor, gas);
          let raw: unknown;
          try {
              raw = await core.executeTransaction({transaction: bytes, signatures: [], include: {effects: true}});
          } catch (c) {
              throw unreachable(minter, minter, 0n, "fork executeTransaction failed (configure; transport).", c);
          }
          const failure = executionFailureReason(raw);
          if (failure !== null) {
              throw bodyError(minter, minter, 0n, `configure_minter reverted on the fork: ${failure} (master-minter already a controller on a reused fork? pass USDC_MINT_CAP_ID, or restart it)`);
          }
          // The configured MintCap is among the tx's newly-created objects.
          const created = createdObjectIds(raw);
          for (const id of created) {
              if (await isMintCap(id)) return id;
          }
          // Surface the raw created ids — if this ever fires on a real fork it's a
          // changedObjects-shape regression, and the ids make it debuggable (+ the
          // operator can pass one back via USDC_MINT_CAP_ID).
          throw bodyError(
              minter,
              minter,
              0n,
              `configured the minter but no MintCap was found among the tx's created objects [${created.join(", ") || "none"}]`,
          );
      })().catch((e) => {
          mintCapSetup = null; // allow a later request to retry the one-time setup
          throw e;
      });
    return mintCapSetup;
  };

  const mintTo = async (address: string, amount: bigint): Promise<void> => {
    const mintCapId = await ensureMintCap();
    const gas = await objRefById(core, gasCoinId);
    const cap = await objRefById(core, mintCapId);
    const tx = new Transaction();
    tx.moveCall({
      target: `${stablecoinPackage}::treasury::mint`,
      typeArguments: [coinType],
      arguments: [
        tx.sharedObjectRef(treasury),
        tx.objectRef(cap),
        tx.sharedObjectRef(denyList),
        tx.pure.u64(amount),
        tx.pure.address(address),
      ],
    });
    const bytes = await buildSponsoredBytes(tx, minter, gasSponsor, gas);
    let raw: unknown;
    try {
      raw = await core.executeTransaction({ transaction: bytes, signatures: [], include: { effects: true } });
    } catch (c) {
      throw unreachable(minter, address, amount, "fork executeTransaction failed (mint; transport).", c);
    }
    const failure = executionFailureReason(raw);
    if (failure !== null) throw bodyError(minter, address, amount, `mint reverted on the fork: ${failure}`);
  };

  return {
    // We neither sign as the recipient nor spend its funds: the master-minter is
    // impersonated via empty-sig execute (usesAccountSigner: false).
    usesAccountSigner: false,
    requiresRecipientAccount: false,
    request: ({ address, amount }) =>
      Effect.gen(function* () {
        if (amount <= 0n) return;
        if (fork === null) {
          return yield* Effect.fail(bodyError(minter, address, amount, "sui plugin is not in fork mode; impersonation funding requires mode:'fork'."));
        }
        if (amount > perRequestCap) {
          return yield* Effect.fail(bodyError(minter, address, amount, `requested ${amount} exceeds per-request cap ${perRequestCap} (base units).`));
        }
        // Serialize all minter txs (shared donor gas coin + one-time configure).
        yield* Effect.tryPromise({
          try: () => serialize(() => mintTo(address, amount)),
          catch: (c) => (isTagged(c) ? c : unreachable(minter, address, amount, "USDC mint failed.", c)),
        });
      }),
  };
}

// --- The plugin factory ---

function resolveCap(envName: string, optWhole: number | undefined, defaultWhole: number): bigint {
  const fromEnv = process.env[envName]?.trim();
  const whole = optWhole ?? (fromEnv ? Number(fromEnv) : defaultWhole);
  if (!Number.isFinite(whole) || whole < 0) throw new Error(`usdc-funding: invalid cap for ${envName}: ${whole}`);
  return BigInt(Math.floor(whole)) * 10n ** USDC_DECIMALS;
}

export type UsdcFundingOptions = {
  /** the fork sui network member. */
  sui: ReturnType<typeof sui>;
  /** the impersonated Circle master-minter: account(name, { kind: 'impersonate', address }). */
  minter: ReturnType<typeof account>;
  /** per-request cap in whole USDC (default 1M; env MAX_USDC_PER_FAUCET_REQUEST). */
  perRequestUsdc?: number;
  /** override the funded coin type (default mainnet USDC). */
  coinType?: string;
  /** override the stablecoin framework package (default mainnet). */
  stablecoinPackage?: string;
  /** override the shared Treasury<USDC> object id (default mainnet). */
  treasuryId?: string;
  /** SUI donor that sponsors gas (default the DEEP whale; env USDC_GAS_SPONSOR). */
  gasSponsor?: string;
  /** a known SUI coin id owned by the gas sponsor (default known; env SUI_GAS_COIN_ID). */
  gasCoinId?: string;
  /** reuse a pre-known MintCap id (skips configure on a warm fork; env USDC_MINT_CAP_ID). */
  mintCapId?: string;
};

/**
 * Build the USDC funding-strategy plugin. Composed into `devstack.config.ts`:
 *
 *   const suiRef = sui({ mode: 'fork', upstream: 'mainnet', version: <rev> });
 *   const minter = account('usdcMinter', { kind: 'impersonate', address: USDC_MINTER_ADDRESS });
 *   const usdc   = coin.known(USDC_COIN_TYPE);
 *   defineDevstack({ members: [suiRef, minter, usdcFundingFromCapOwner({ sui: suiRef, minter }), usdc,
 *     account('alice', { funding: [{ coin: usdc, amount }] }) ] });
 *
 * Its resolved value publishes { minter, coinType, perRequestCap } for the dashboard.
 */
export function usdcFundingFromCapOwner(opts: UsdcFundingOptions) {
  const coinType = opts.coinType ?? USDC_COIN_TYPE;
  const stablecoinPackage = opts.stablecoinPackage ?? (process.env.USDC_STABLECOIN_PACKAGE_ID?.trim() || DEFAULT_STABLECOIN_PACKAGE);
  const treasuryId = opts.treasuryId ?? (process.env.USDC_TREASURY_ID?.trim() || DEFAULT_TREASURY_ID);
  const gasSponsor = opts.gasSponsor ?? (process.env.USDC_GAS_SPONSOR?.trim() || DEFAULT_GAS_SPONSOR);
  const gasCoinId = opts.gasCoinId ?? (process.env.SUI_GAS_COIN_ID?.trim() || DEFAULT_GAS_COIN_ID);
  const knownMintCapId = opts.mintCapId ?? (process.env.USDC_MINT_CAP_ID?.trim() || undefined);
  const perRequestCap = resolveCap("MAX_USDC_PER_FAUCET_REQUEST", opts.perRequestUsdc, DEFAULT_PER_REQUEST_USDC);
  const treasury: SharedRef = { objectId: treasuryId, initialSharedVersion: TREASURY_INITIAL_SHARED_VERSION, mutable: true };
  const denyList: SharedRef = { objectId: DENY_LIST_ID, initialSharedVersion: DENY_LIST_INITIAL_SHARED_VERSION, mutable: false };

  return definePlugin({
    id: "usdc-funding",
    role: "service",
    section: "service",
    dependsOn: { sui: opts.sui, minter: opts.minter },
    start: (deps) =>
      Effect.gen(function* () {
        const ctx = yield* PluginContext;
        const minter = deps.minter.address;
        const core = deps.sui.sdk.core as ForkCore;
        const fork = deps.sui.fork;
        const strategy = usdcFundingStrategy({
          core, fork, minter, gasSponsor, gasCoinId, stablecoinPackage, treasury, denyList, coinType, allowance: MINT_ALLOWANCE, perRequestCap, knownMintCapId,
        });

        // Contribute the coinType funding strategy at priority 1 (beats
        // coin.known's priority-0 mint default). Same imperative ctx.provides
        // mechanism as the DEEP plugin (devstack 0.3.0).
        ctx.provides({ kind: "strategy-contributor", capabilityKey: `coinType:${coinType}`, strategy, autoMounted: false, priority: 1 });

        return { minter, coinType, perRequestCap, strategy };
      }),
  });
}
