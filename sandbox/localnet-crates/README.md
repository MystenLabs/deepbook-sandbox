# Localnet Crates

Vendored copy of `external/deepbook/crates/` with modifications for localnet support. These crates allow the indexer to work with a local Sui node instead of only remote profiles (testnet/mainnet).

## Syncing with Upstream (./external/deepbook state)

```bash
# 1. Check what's changed upstream since last sync
cd external/deepbook && git fetch origin
git log $(grep UPSTREAM_COMMIT ../sandbox/localnet-crates/UPSTREAM_COMMIT | cut -d= -f2)..origin/main --oneline -- crates/

# 2. Review differences between your version and upstream
diff -r external/deepbook/crates/indexer sandbox/localnet-crates/indexer

# 3. Apply upstream changes manually (review each file)
# 4. Update UPSTREAM_COMMIT file with new commit hash
```
