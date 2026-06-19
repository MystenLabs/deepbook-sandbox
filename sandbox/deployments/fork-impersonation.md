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
