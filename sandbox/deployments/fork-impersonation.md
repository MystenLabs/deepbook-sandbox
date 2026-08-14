# Fork-impersonation donors & funding caps

How the sandbox funds non-SUI coins on a `sui-fork` of mainnet: it **impersonates**
a real mainnet holder (empty-signature execution — the fork runs a transaction as
the declared sender without its key) and transfers (DEEP) or mints (USDC) to the
recipient. This file records the donor address(es), why they were chosen, their
risk profile, and the sandbox-wide funding caps.

Consumed by the DEEP / USDC funding-strategy plugins. The mechanism is validated
by the spikes under `sandbox/scripts/spikes/` — DEEP transfer (`deep/`), USDC mint
(`usdc/`), and devstack plugin authoring (`devstack-funding/`).

## DEEP donor

|                  |                                                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Address**      | `0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d`                                                                                                 |
| **Coin type**    | `0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP` (mainnet — the fork inherits mainnet state; not the localnet-deployed DEEP package) |
| **Holds**        | ~4.58B DEEP (`4,575,763,417` DEEP, 6 dp) = **~45.9% of total supply** (~9.97B)                                                                                       |
| **Coin objects** | one plain `Coin<DEEP>` (transferable — validated by `splitCoins` on a fork in the spikes)                                                                            |
| **Env var**      | `DEEP_DONOR_ADDRESS`                                                                                                                                                 |

### Survey & selection

Goal: a stable, large DEEP holder we can impersonate on every fork without any
expectation of it being drained on mainnet between forks. DEEP total supply is
~9.97B (6 dp), so the ≥10M-DEEP screen is "≥ ~0.1% of supply".

`0x9548…70d` holds **~45.9% of all DEEP in a single coin object** — it dwarfs every
other holder, which makes it the unambiguous choice and makes a full holder
ranking moot. (No public JSON-RPC ranks holders; to enumerate/triage the long tail
use an indexer — the "Holders" tab on suivision.xyz / suiscan.xyz for the DEEP
coin type. The dominant holder is verifiable directly, which is what we did below.)
It is also the donor already validated end-to-end by the DEEP-transfer and
devstack-funding spikes.

A holder of ~46% of supply is treasury/foundation/distribution-scale (no exchange
hot wallet or LP holds that much); it is unlabeled via RPC but its size and
behavior are consistent with a distribution wallet.

### Stability / risk profile (verified on mainnet 2026-06-16)

- **Position size:** ~4.58B DEEP. The session cap (10M, below) is **~0.2%** of it —
  it cannot be meaningfully drained even by heavy sandbox use. And we only ever
  impersonate it **on forks**; mainnet is never touched.
- **Balance stability:** net DEEP outflow over the last 30 days ≈ **24M DEEP**
  (4 txns: ~7.5M, ~7.3M, ~1.9M, ~7.1M) = **~0.5% of its position per month**.
  "Has not moved significantly" — confirmed.
- **Active, not dormant:** it sends DEEP roughly every 1–2 weeks. This matters for
  the DEEP funding plugin ↓.

### ⚠️ Implementation note — resolve the donor's coin dynamically

Because the donor is active, its `Coin<DEEP>` **object id and version churn**
(observed: `0x9cf7988b…` was consumed and replaced by `0x3b5cbb0b…`, same ~4.58B
balance). The DEEP funding plugin must **not** hardcode the donor's coin
id/version — resolve it at fork time with `listCoins(donor, DEEP)` (works on the
fork; it lazy-fetches the owner's coins). The devstack-funding spike hardcoded a
coin ref for expedience and noted it would go stale; the production plugin must
resolve dynamically.

## USDC minter

USDC is **mintable**, so there's no donor or drain ceiling: the sandbox
impersonates Circle's **master-minter** and mints via the stablecoin framework's
`treasury::mint`. Native USDC on Sui is a regulated coin — the `TreasuryCap<USDC>`
is **not** address-owned; it lives as a dynamic object field under a **shared**
`Treasury<USDC>`, gated by a controller → minter allowlist (each minter holds a
`MintCap`). Validated end-to-end in the USDC mint spike (`scripts/spikes/usdc/`):
impersonate the master-minter → `configure_new_controller` + `configure_minter`
(grants a `MintCap`) → `treasury::mint`.

|                                         |                                                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **USDC package**                        | `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7`                                                         |
| **Coin type**                           | `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC` (mainnet — the fork inherits mainnet state) |
| **Stablecoin framework package**        | `0xecf47609d7da919ea98e7fd04f6e0648a0a79b337aaad373fa37aac8febf19c8` (`treasury` / `roles` / `mint_allowance`)               |
| **Shared `Treasury<USDC>`**             | `0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7` (Shared, initial version `313333795`)                   |
| **`TreasuryCap<USDC>`**                 | `0x677e41a5c35d90177d401b72952c228ffa65b770e265561ad607f34d6896dcc2` (dynamic-object-field under the Treasury)               |
| **Master minter** (impersonated sender) | `0x41c0c6d67577b39f31a5fe4052314fd3a8b7c7f890676f60e007bd390e397ac1`                                                         |
| **Env vars**                            | `USDC_TOKEN_PACKAGE_ID`, `USDC_TREASURY_ID`, `USDC_MINTER_ADDRESS` (+ `USDC_STABLECOIN_PACKAGE_ID`, `USDC_TREASURY_CAP_ID`)  |

### ⚠️ Implementation note — the cap is gated, and the master-minter can rotate

`coin::mint` does **not** work (the cap isn't address-owned); minting must go
through `treasury::mint` as a configured minter. The USDC funding plugin
impersonates the master-minter to self-configure a `MintCap`, then mints. If
Circle rotates the master-minter, re-derive it (no hardcoding needed):

```
bag      = Treasury.roles.data (a 0x2::bag::Bag) → its UID
fieldId  = deriveDynamicFieldID(bag, `<stablecoin-pkg>::roles::MasterMinterKey`, [0x00])
minter   = Field<MasterMinterKey, address>.value
```

`[0x00]` is the BCS of the key (`MasterMinterKey { dummy_field: bool }` in the
deployed package). `pnpm verify:usdc-minter` (from `sandbox/devstack-plugins/`) runs this
derivation against mainnet and prints the current values.

## DeepBook admin wallet (DBSF-016)

The fork inherits mainnet's DeepBook deployment wholesale — packages, registries,
and pools need no re-publish. Admin-gated flows (e.g. `create_pool_admin` for a
fresh sandbox pool, margin config) impersonate the **mainnet admin wallet**, which
holds **both** admin caps, so one impersonation target covers every admin flow:

|                        |                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| **Admin wallet**       | `0xd0ec0b201de6b4e7f425918bbd7151c37fc1b06c59b3961a2a00db74f6ea865e` (impersonated sender)             |
| **`DeepbookAdminCap`** | `0xada554b8b712556b8509be47ac1bc04db9505c3532049a543721aca0c010a840` (validated by the DBSF-003 spike) |
| **`MarginAdminCap`**   | `0x3ec65d06f0be30905cc1742b903aa497791c702820331db263176b74e74c95c8`                                   |

The id inventory — the three package ids (original + latest: deepbook v8,
margin v6, liquidation v4), `Registry` / `MarginRegistry` (with initial shared
versions), and the default pools (DEEP_SUI, SUI_USDC, DEEP_USDC) — is pinned in
[`deployments/mainnet-fork.json`](./mainnet-fork.json) under the `deepbook` key.
Everything was verified live on mainnet 2026-07-29; re-verify (drift check:
transferred caps, packages upgraded past their pin, missing objects, pool
base/quote types) with `pnpm verify:deepbook-ids` from `sandbox/devstack-plugins/`.

Notes:

- **Type tags vs call targets:** object types are stamped with the _original_
  package ids (`0x2c8d603b…` for deepbook, `0x97d94737…` for margin); `moveCall`
  targets should use the _latest_ ids. The manifest carries both.
- **Upgrades move `latestId`:** mainnet was on deepbook **v6** (`0x337f4f4f…`)
  when the DBSF-003 spike ran (2026-05-18) and is **v8** (`0x0e735f8c…`) as of
  2026-07-29 — and DeepBook enforces `allowed_versions` on-chain, so calls
  through a stale package id abort with `EPackageVersionNotEnabled`. The verify
  script detects a newer upgrade via `listPackageVersions`. (Don't trust
  `@mysten/deepbook-v3`'s `mainnetPackageIds` as the source of truth — 1.5.0
  lags mainnet for margin, pinning v5.)
- The admin wallet holds no _enumerable_ SUI on a fresh fork (the fork builds no
  owner→coins index, so `listCoins` is empty) — but it does hold mainnet SUI,
  reachable by known object id. That is what the SUI donor below draws on; for
  the admin's own gas, a grant lands a fork-local coin, which IS enumerable
  (same pattern as the spikes; see `create-pool-as-admin.mjs`, but note that
  spike still defaults to the stale v6 package id — override via
  `DEEPBOOK_PACKAGE_ID` or use the manifest's `latestId`).

## SUI donor

SUI cannot be minted on a fork, so grants transfer from an impersonated holder's
real coin. This is a **different donor from DEEP**, for capacity reasons:

|                 |                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| **Address**     | `0xd0ec0b201de6b4e7f425918bbd7151c37fc1b06c59b3961a2a00db74f6ea865e` (the DeepBook admin wallet, above)  |
| **Coin object** | `0xd99d6529c67e2330a856e98c141ff57bc8069e36646523ad2f3981cdec8b6f67` — **5493.977504296 SUI**            |
| **Holds**       | ~9,504 SUI across 8 coins (mainnet); the coin above is present at the fork pin with an identical balance |
| **Env vars**    | `SUI_DONOR_ADDRESS`, `SUI_DONOR_COIN_ID`                                                                 |
| **Verified**    | 2026-08-14, mainnet vs fork (SEDEFI-459/460)                                                             |

The DEEP whale (`0x9548…70d`) was the original SUI source and is **not** viable
for grants: it holds a single SUI coin worth ~0.7 SUI at the pin. That capped
faucet grants at 0.1 SUI and, once boot funding drained it below the funding
plugins' gas budget, broke DEEP/USDC grants too (they pay gas from it). It stays
the DEEP donor and its own gas payer; only the SUI hand-outs moved.

At 100 SUI per faucet request the donor coin covers ~54 grants per fork, and a
wipe restores it. If it ever runs dry, point `SUI_DONOR_COIN_ID` at another of
the admin's coins (`node scripts/refresh-donor-coins.mjs` lists them) — the
next-largest holds ~3500 SUI.

## Funding caps (sandbox-wide policy)

| Cap              | Value         | Enforced by                                                                                                                                  |
| ---------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| DEEP per request | **100k DEEP** | the DEEP funding plugin (`MAX_DEEP_PER_REQUEST`). The legacy faucet API currently defaults to 10k; fork-mode DEEP funding raises it to 100k. |
| DEEP per session | **10M DEEP**  | the DEEP funding plugin (`MAX_DEEP_PER_SESSION`); ~0.2% of the donor — generous but bounded.                                                 |
| USDC per request | 10k USDC      | mintable; cap is for realism, not drain protection.                                                                                          |

Caps are guardrails for realism + runaway protection on the fork; they have **no
mainnet effect** (impersonation is fork-only).

## Wiring

- `DEEP_DONOR_ADDRESS` is read from `.env` (see `.env.example`) and surfaced in the
  deployment manifest (`deployments/localnet.json`, served by the API's
  `/manifest`) as `deepDonorAddress`.
- `MAX_DEEP_PER_REQUEST` / `MAX_DEEP_PER_SESSION` carry the caps above.
- Default donor when `DEEP_DONOR_ADDRESS` is unset: `0x9548…70d` (this document's
  choice).
- USDC: `USDC_TOKEN_PACKAGE_ID`, `USDC_TREASURY_ID`, `USDC_MINTER_ADDRESS` (+
  `USDC_STABLECOIN_PACKAGE_ID`, `USDC_TREASURY_CAP_ID`) hold the mainnet identities
  above (see `.env.example`); the forthcoming USDC funding plugin consumes them.
  Re-verify / re-derive after a Circle rotation with `pnpm verify:usdc-minter`.
