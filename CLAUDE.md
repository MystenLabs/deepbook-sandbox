# DeepBookV3 Sandbox

## Agent Guidelines

Everytime there are new changes that you are asked to do in this repository you should:

- Keep this file (`./CLAUDE.md`) up to date.
- Spawn a review agent to review the ongoing changes.
- If you are asked to do git commits, keep their titles short (sacrifice grammar for conciseness)
  but their descriptions should be more detailed. One sentence for what the commit introduces/fixes,
  including an example if it is needed.

## Project Overview

This project provides a toolset for reducing builder friction with one-liner deployments, Dockerized stack, and a web dashboard for DeepBook V3 instances.

DeepbookV3 is an external repository (provided as a git submodule in the curren repository). 
It's a decentralized central limit order book (CLOB) built on Sui. You can find more details about
it at `./external/deepbook/README.md`.

## Docker

We define a docker compose file that includes a docker network including the following services:
1. A DeepBook API Server instance. 
2. A DeepBook Indexer instance.
3. A PostgreSQL instance for the Deepbook Indexer.
4. A Sui Localnet instance.


