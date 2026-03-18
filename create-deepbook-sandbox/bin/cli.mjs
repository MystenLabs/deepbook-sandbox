#!/usr/bin/env node

import { scaffold } from "../lib/scaffold.mjs";

const HELP = `
Usage: create-deepbook-sandbox [project-name] [options]

Scaffold a DeepBook V3 sandbox environment.

Options:
  --version <tag>    GitHub release tag to download (default: latest)
  --deploy           Run pnpm deploy-all after scaffolding
  --network <name>   Network for deploy: localnet or testnet (default: localnet)
  --help             Show this help message

Examples:
  npx create-deepbook-sandbox my-sandbox
  npx create-deepbook-sandbox my-sandbox --deploy
  npx create-deepbook-sandbox my-sandbox --version v0.1.0
`.trim();

function parseArgs(argv) {
    const args = argv.slice(2);
    const opts = {
        projectName: "deepbook-sandbox",
        version: "latest",
        deploy: false,
        network: "localnet",
        help: false,
    };

    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "--help" || arg === "-h") {
            opts.help = true;
        } else if (arg === "--version" || arg === "-v") {
            i++;
            opts.version = args[i];
            if (!opts.version) {
                console.error("Error: --version requires a value");
                process.exit(1);
            }
        } else if (arg === "--deploy") {
            opts.deploy = true;
        } else if (arg === "--network") {
            i++;
            opts.network = args[i];
            if (!opts.network || !["localnet", "testnet"].includes(opts.network)) {
                console.error("Error: --network must be 'localnet' or 'testnet'");
                process.exit(1);
            }
        } else if (arg.startsWith("-")) {
            console.error(`Unknown option: ${arg}\n`);
            console.log(HELP);
            process.exit(1);
        } else {
            opts.projectName = arg;
        }
        i++;
    }

    return opts;
}

async function main() {
    const opts = parseArgs(process.argv);

    if (opts.help) {
        console.log(HELP);
        process.exit(0);
    }

    try {
        await scaffold(opts);
    } catch (err) {
        console.error(`\nError: ${err.message}`);
        process.exit(1);
    }
}

main();
