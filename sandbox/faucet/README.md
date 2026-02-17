# DeepBook Faucet

Lightweight token faucet for the DeepBook sandbox. Distributes **SUI** (proxied from Sui's built-in faucet) and **DEEP** (transferred directly from the deployer wallet).

## Endpoints

| Method | Path      | Description                                              |
| ------ | --------- | -------------------------------------------------------- |
| `GET`  | `/`       | Health check — returns service info and deployer address |
| `POST` | `/faucet` | Request SUI or DEEP tokens                               |

## Request Format

```
POST /faucet
Content-Type: application/json
```

### Body

| Field     | Type     | Required | Description                                                      |
| --------- | -------- | -------- | ---------------------------------------------------------------- |
| `address` | `string` | Yes      | Recipient Sui address (`0x` + 64 hex chars)                      |
| `token`   | `string` | Yes      | `"SUI"` or `"DEEP"`                                              |
| `amount`  | `number` | No       | DEEP only — whole tokens to send (default: `1000`, max: `10000`) |

> `amount` is ignored for SUI requests. The upstream Sui faucet determines the SUI amount.

## Examples

### Request SUI

```bash
curl -X POST http://localhost:9009/faucet \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "token": "SUI"
  }'
```

**Response:**

```json
{ "success": true }
```

### Request DEEP (default 1000 DEEP)

```bash
curl -X POST http://localhost:9009/faucet \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "token": "DEEP"
  }'
```

**Response:**

```json
{ "success": true, "digest": "8BYqr..." }
```

### Request a specific amount of DEEP

```bash
curl -X POST http://localhost:9009/faucet \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "token": "DEEP",
    "amount": 5000
  }'
```

## Environment Variables

| Variable                | Required | Default             | Description                                      |
| ----------------------- | -------- | ------------------- | ------------------------------------------------ |
| `NETWORK`               | Yes      | —                   | `localnet` or `testnet`                          |
| `PRIVATE_KEY`           | Yes      | —                   | Bech32-encoded Sui private key (deployer wallet) |
| `DEEP_TOKEN_PACKAGE_ID` | Yes      | —                   | Package ID of the deployed DEEP token            |
| `RPC_URL`               | No       | Per-network default | Sui RPC endpoint                                 |
| `PORT`                  | No       | `9009`              | Server listen port                               |
| `MAX_DEEP_PER_REQUEST`  | No       | `10000`             | Maximum DEEP tokens per request                  |

## Running

### Via Docker (recommended)

The faucet is included in the sandbox Docker Compose stack:

```bash
cd sandbox

# Localnet
docker compose --profile localnet up -d

# Testnet
docker compose --profile remote up -d
```

### Local development

```bash
cd sandbox/faucet
cp .env.example .env  # configure env vars
pnpm install
pnpm dev
```
