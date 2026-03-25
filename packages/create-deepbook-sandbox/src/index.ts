#!/usr/bin/env node

import { runPreflight } from "./preflight.js";
import { scaffold } from "./scaffold.js";

const arg = process.argv[2];

if (arg === "--help" || arg === "-h") {
    console.log(`
Usage: create-deepbook-sandbox [directory]

Scaffold a DeepBook V3 sandbox workspace.

Arguments:
  directory   Target directory (default: deepbook-sandbox)
`);
    process.exit(0);
}

if (arg === "--version" || arg === "-v") {
    console.log("0.1.0");
    process.exit(0);
}

const targetDir = arg ?? "deepbook-sandbox";

console.log("create-deepbook-sandbox — scaffold a DeepBook V3 sandbox\n");

try {
    runPreflight();
    scaffold(targetDir);

    console.log(`
Done! To get started:

  cd ${targetDir}/sandbox
  pnpm deploy-all

See README.md for full documentation.
`);
} catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nFailed: ${message}\n`);
    process.exit(1);
}
