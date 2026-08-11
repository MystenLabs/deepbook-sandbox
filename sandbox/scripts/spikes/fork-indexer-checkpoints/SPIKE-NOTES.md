# Spike: can the DeepBook indexer ingest sui-fork checkpoints? (DBSF-022 precondition)

**Date:** 2026-08-11 · **Verdict: YES — via gRPC RPC ingestion, with a ~5-line indexer patch.**
The classic shared-volume file path is dead; the RPC path is proven live against the
patched fork image (rev `16f1402387`, the production `devstack.config.ts` stack).

## Findings

### Fork side (verified in the pinned rev's source + live probes)

- `sui-fork` never writes `.chk` ingestion files. It has no `--data-ingestion-dir`;
  its on-disk `checkpoints/` tree is an internal summary+contents store, not the
  `CheckpointData` blob format. The compose `checkpoint_data` volume can never be fed.
- The fork serves the canonical `sui-rpc-api` gRPC surface, including
  `sui.rpc.v2 LedgerService.GetCheckpoint` and
  `SubscriptionService.SubscribeCheckpoints` (wired in `startup.rs`, e2e-tested
  upstream in `tests/subscription_e2e.rs`).
- **Live proof** (`checkpoint-probe.mjs` against the running stack — every claim
  below is re-runnable via the Repro section):
  - `GetCheckpoint` at the fork tip with the framework's exact mask (`summary.bcs`,
    `signature`, `contents.bcs`, `transactions.{transaction,effects,events}.bcs`,
    `objects.objects.bcs`) returns every field populated — including all output
    objects (14 on the first run) and per-tx events.
  - `SubscribeCheckpoints` + `ForkingService.AdvanceCheckpoint` delivers the freshly
    sealed checkpoint on the stream in real time, with contents.
  - `GetServiceInfo` returns `chainId`, `checkpointHeight`, and the
    `sui-fork/1.76.0-16f1402387…` server version — the fields the ingestion client
    uses for chain-id pinning and its latest-checkpoint watermark.
- The known `todo!()` abort class does NOT sit on this path:
  `ReadStore::get_full_checkpoint_contents` is `todo!()` (`store.rs:1281`), but the
  v2 `GetCheckpoint` handler assembles from `get_checkpoint_contents_by_sequence_number`
  (implemented) — verified in source and empirically (the fork survived full reads).

### Indexer side (`external/deepbook/crates/indexer` @ `46d846e5`)

- Framework pin: `sui-indexer-alt-framework = { branch = "testnet" }`, locked to
  `3c0f387e` (v1.68.1). The framework's `IngestionClientArgs` supports
  `--rpc-api-url` (exactly the `GetCheckpoint` call replayed above) and
  `--streaming-url` (the `SubscribeCheckpoints` accelerator).
- BUT the deepbook indexer's `main.rs` does not flatten `IngestionClientArgs` — it
  hardcodes source selection: remote store (mainnet/testnet URLs) or
  `sandbox --env localnet` → `--local-ingestion-path`. `--rpc-api-url` is unreachable
  from its CLI today. `STREAMING_URL` IS reachable (flattened `StreamingClientArgs`,
  env-bound), but streaming is an accelerator only — the ingestion client must exist
  and handles all backfill, so streaming alone cannot carry it.

## Consequence for DBSF-022 (indexer/server/Postgres remnant)

1. Patch `external/deepbook/crates/indexer/src/main.rs` to flatten
   `IngestionClientArgs` (~5 lines) so `--rpc-api-url http://<fork>:9000` is
   reachable; pass it (plus optional `STREAMING_URL`) through the compose remnant's
   entrypoint. Drop the `checkpoint_data` volume.
2. `FIRST_CHECKPOINT` must be the fork point (e.g. `304941000`) — fork checkpoints
   continue mainnet sequence numbers. Postgres must be fresh when switching stacks:
   pipelines resume from committer watermarks and ignore `--first-checkpoint`.
3. `--deepbook-package-id` gets the pinned mainnet ids. (`sandbox --env` has no
   mainnet variant; the explicit package override is what matters.)
4. Only post-fork activity gets indexed — historical mainnet fills are not in the
   fork's local checkpoints. Fine for sandbox semantics (pools are seeded manually).
5. `deepbook-server` is a separate gap: it speaks JSON-RPC (`sui-sdk`) for its live
   orderbook/lag reads and the fork is gRPC-only. Needs its own adaptation.

## Residual risk

- BCS-decode skew: framework v1.68.1 (`testnet` branch) deserializing payloads from
  fork rev `16f1402387` (1.76.0) is unproven until a patched indexer actually runs —
  first implementation step, not part of this spike. The moving `branch = "testnet"`
  pin means unlocked rebuilds silently shift the framework (accepted cost in the AC:
  the indexer pin now tracks the fork rev).

## Repro

```bash
# stack up first: cd sandbox && pnpm stack:up
cd sandbox/devstack-plugins   # for @mysten/sui module resolution
node --input-type=module - < ../scripts/spikes/fork-indexer-checkpoints/checkpoint-probe.mjs
```
