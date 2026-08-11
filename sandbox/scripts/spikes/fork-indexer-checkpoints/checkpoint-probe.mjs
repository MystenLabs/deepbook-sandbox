// Checkpoint-compat spike probe: prove the fork's checkpoint ingestion surface
// live — GetServiceInfo (chain-id + watermark), GetCheckpoint with the indexer
// framework's exact BCS read mask, then SubscribeCheckpoints + AdvanceCheckpoint
// round-trip. NOT read-only: advanceCheckpoint seals a checkpoint (+1 height).
//
// Needs @mysten/sui >= 2.18 (forkingService client; sandbox/node_modules has
// 2.16 without it) — run from sandbox/devstack-plugins so its install resolves:
//   node --input-type=module - < ../scripts/spikes/fork-indexer-checkpoints/checkpoint-probe.mjs
import { execSync } from "node:child_process";

import { SuiGrpcClient } from "@mysten/sui/grpc";

const id = execSync("docker ps -q --filter name=sui-fork").toString().trim();
if (!id)
    throw new Error(
        "no sui-fork container matched — is the stack up? (cd sandbox && pnpm stack:up)",
    );
if (id.includes("\n")) throw new Error(`multiple fork containers matched:\n${id}`);
const mapped = execSync(`docker port ${id} 9000/tcp`)
    .toString()
    .trim()
    .split("\n")
    .find((l) => l.startsWith("0.0.0.0") || l.startsWith("127.0.0.1"));
const url = `http://${mapped.replace("0.0.0.0", "127.0.0.1")}`;
console.log("fork gRPC:", url);

const c = new SuiGrpcClient({ network: "mainnet-fork", baseUrl: url });
const big = (k, v) => (typeof v === "bigint" ? String(v) : v);

// -- 0. Service info: the fields RPC ingestion uses for chain-id + watermark
const si = await c.ledgerService.getServiceInfo({});
console.log("serviceInfo:", JSON.stringify(si.response, big).slice(0, 300));

// -- 1. Current fork tip (checkpoint numbers continue mainnet's sequence)
const st0 = await c.forkingService.getStatus({});
const tip = st0.response.checkpointSequenceNumber;
console.log("fork status:", JSON.stringify(st0.response, big));

// -- 2. Full checkpoint read with sui-indexer-alt-framework's exact read mask
//    (ingestion/rpc_client.rs on branch `testnet`): every field must populate.
try {
    const { response } = await c.ledgerService.getCheckpoint({
        checkpointId: { oneofKind: "sequenceNumber", sequenceNumber: tip },
        readMask: {
            paths: [
                "summary.bcs",
                "signature",
                "contents.bcs",
                "transactions.transaction.bcs",
                "transactions.effects.bcs",
                "transactions.effects.unchanged_loaded_runtime_objects",
                "transactions.events.bcs",
                "objects.objects.bcs",
            ],
        },
    });
    const cp = response.checkpoint;
    console.log(`getCheckpoint(${tip}) with framework mask:`);
    console.log(
        "  summary.bcs bytes:",
        cp?.summary?.bcs?.value?.length ?? 0,
        "signature:",
        !!cp?.signature,
    );
    console.log("  contents.bcs bytes:", cp?.contents?.bcs?.value?.length ?? 0);
    console.log("  transactions:", (cp?.transactions ?? []).length);
    for (const t of cp?.transactions ?? [])
        console.log(
            "   tx bcs:",
            t.transaction?.bcs?.value?.length ?? 0,
            "effects bcs:",
            t.effects?.bcs?.value?.length ?? 0,
            "events bcs:",
            t.events?.bcs?.value?.length ?? 0,
        );
    console.log("  output objects:", (cp?.objects?.objects ?? []).length);
} catch (e) {
    console.log("getCheckpoint FAILED:", String(e).split("\n")[0].slice(0, 200));
}

// -- 3. Subscribe, seal a checkpoint via the forking admin RPC, expect delivery
const stream = c.subscriptionService.subscribeCheckpoints({
    readMask: { paths: ["sequence_number", "digest", "summary", "contents"] },
});
const received = [];
const reader = (async () => {
    for await (const msg of stream.responses) {
        const cp = msg.checkpoint;
        received.push(String(cp?.sequenceNumber ?? msg.cursor));
        console.log(
            "stream delivered: seq",
            String(cp?.sequenceNumber ?? msg.cursor),
            "summary:",
            !!cp?.summary,
            "contents:",
            !!cp?.contents,
        );
        break;
    }
})();

await new Promise((r) => setTimeout(r, 500));
const adv = await c.forkingService.advanceCheckpoint({});
console.log("advanceCheckpoint ->", JSON.stringify(adv.response, big).slice(0, 200));

const result = await Promise.race([
    reader.then(() => "STREAM_OK"),
    new Promise((r) => setTimeout(() => r("STREAM_TIMEOUT"), 10000)),
]);
console.log("RESULT:", result, "received:", received);
process.exit(result === "STREAM_OK" ? 0 : 1);
