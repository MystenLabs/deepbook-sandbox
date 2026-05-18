#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";

const DEFAULT_SUI_BIN = "/Users/stefanstanciulescu/src/sui/target/debug/sui";

const CONFIG = {
  suiBin: process.env.SUI_BIN || resolveBinary("sui", DEFAULT_SUI_BIN),
  pythStateId:
    process.env.PYTH_STATE_ID ||
    "0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8",
  pythPackageId:
    process.env.PYTH_PACKAGE_ID ||
    "0x04e20ddf36af412a4096f9014f4a565af9e812db9a05cc40254846cf6ed0ad91",
  pythTypePrefix:
    process.env.PYTH_TYPE_PREFIX ||
    "0x8d97f1cd6ac663735be08d1d2b6d02a159e711586461306ce60a2b7a6a565a9e",
  wormholeStateId:
    process.env.WORMHOLE_STATE_ID ||
    "0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c",
  wormholePackageId:
    process.env.WORMHOLE_PACKAGE_ID ||
    "0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a",
  priceInfoObjectId:
    process.env.PRICE_INFO_OBJECT_ID ||
    "0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37",
  feedId:
    process.env.PYTH_FEED_ID ||
    "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744",
  sender:
    process.env.SENDER ||
    "0xb4f42571101827758f55a9b998a1251892402fbd4dce90da3373625298091627",
  clockObjectId: process.env.CLOCK_OBJECT_ID || "0x6",
  baseUpdateFee: BigInt(process.env.BASE_UPDATE_FEE || "1"),
  gasBudget: BigInt(process.env.GAS_BUDGET || "200000000"),
};

const mode = process.argv[2] || "build";

if (!["build", "submit", "ptb-args"].includes(mode)) {
  console.error("Usage: node build-pyth-suiusd-fork-tx.mjs [build|submit|ptb-args]");
  process.exit(2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  const accumulatorHex = await fetchLatestAccumulatorHex(CONFIG.feedId);
  const accumulatorBytes = hexToBuffer(accumulatorHex);
  const vaaBytes = extractVaaBytesFromAccumulatorMessage(accumulatorBytes);
  const ptbArgs = buildPtbArgs(accumulatorBytes, vaaBytes);

  if (mode === "ptb-args") {
    process.stdout.write(JSON.stringify(ptbArgs, null, 2));
    return;
  }

  const txBytes = run(CONFIG.suiBin, ptbArgs).stdout.trim();
  if (!txBytes) {
    throw new Error("sui client ptb returned no transaction bytes");
  }

  if (mode === "build") {
    process.stdout.write(txBytes);
    return;
  }

  const submitArgs = [
    "client",
    "execute-signed-tx",
    "--tx-bytes",
    txBytes,
    "--json",
  ];
  const submit = run(CONFIG.suiBin, submitArgs);
  process.stdout.write(submit.stdout);
}

function resolveBinary(binaryName, fallback) {
  const probe = spawnSync(binaryName, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return probe.status === 0 ? binaryName : fallback;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    const detail = [stderr, stdout].filter(Boolean).join("\n");
    throw new Error(
      `Command failed (${result.status}): ${command} ${args.join(" ")}${detail ? `\n${detail}` : ""}`,
    );
  }

  return result;
}

async function fetchLatestAccumulatorHex(feedId) {
  const url = new URL("https://hermes.pyth.network/v2/updates/price/latest");
  url.searchParams.append("ids[]", strip0x(feedId));
  url.searchParams.set("encoding", "hex");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Hermes request failed: ${response.status} ${response.statusText}`);
  }

  const body = await response.json();
  const hex = body?.binary?.data?.[0];
  if (typeof hex !== "string" || hex.length === 0) {
    throw new Error("Hermes response did not contain binary.data[0]");
  }

  return hex;
}

function buildPtbArgs(accumulatorBytes, vaaBytes) {
  return [
    "client",
    "ptb",
    "--sender",
    objectOrAddressLiteral(CONFIG.sender),
    "--gas-budget",
    CONFIG.gasBudget.toString(),
    "--move-call",
    `${CONFIG.wormholePackageId}::vaa::parse_and_verify`,
    `@${CONFIG.wormholeStateId}`,
    vectorLiteral(vaaBytes),
    `@${CONFIG.clockObjectId}`,
    "--assign",
    "verified_vaa",
    "--move-call",
    `${CONFIG.pythPackageId}::pyth::create_authenticated_price_infos_using_accumulator`,
    `@${CONFIG.pythStateId}`,
    vectorLiteral(accumulatorBytes),
    "verified_vaa",
    `@${CONFIG.clockObjectId}`,
    "--assign",
    "price_updates",
    "--split-coins",
    "gas",
    `[${CONFIG.baseUpdateFee.toString()}]`,
    "--assign",
    "fee_coin",
    "--move-call",
    `${CONFIG.pythPackageId}::pyth::update_single_price_feed`,
    `@${CONFIG.pythStateId}`,
    "price_updates",
    `@${CONFIG.priceInfoObjectId}`,
    "fee_coin.0",
    `@${CONFIG.clockObjectId}`,
    "--assign",
    "remaining_updates",
    "--move-call",
    `${CONFIG.pythPackageId}::hot_potato_vector::destroy`,
    `<${CONFIG.pythTypePrefix}::price_info::PriceInfo>`,
    "remaining_updates",
    "--serialize-unsigned-transaction",
  ];
}

function extractVaaBytesFromAccumulatorMessage(accumulatorMessage) {
  if (accumulatorMessage.length < 10) {
    throw new Error("Accumulator message is too short");
  }

  const trailingPayloadSize = accumulatorMessage.readUInt8(6);
  const vaaSizeOffset = 7 + trailingPayloadSize + 1;
  if (vaaSizeOffset + 2 > accumulatorMessage.length) {
    throw new Error("Accumulator message is truncated before VAA size");
  }

  const vaaSize = accumulatorMessage.readUInt16BE(vaaSizeOffset);
  const vaaOffset = vaaSizeOffset + 2;
  const vaaEnd = vaaOffset + vaaSize;
  if (vaaEnd > accumulatorMessage.length) {
    throw new Error("Accumulator message is truncated before VAA payload");
  }

  return accumulatorMessage.subarray(vaaOffset, vaaEnd);
}

function vectorLiteral(bytes) {
  return `vector[${Array.from(bytes, (value) => `0x${value.toString(16).padStart(2, "0")}`).join(", ")}]`;
}

function objectOrAddressLiteral(value) {
  return value.startsWith("@") ? value : `@${value}`;
}

function hexToBuffer(hex) {
  const normalized = strip0x(hex);
  if (normalized.length === 0 || normalized.length % 2 !== 0) {
    throw new Error("Expected an even-length hex string");
  }

  return Buffer.from(normalized, "hex");
}

function strip0x(value) {
  return value.startsWith("0x") ? value.slice(2) : value;
}
