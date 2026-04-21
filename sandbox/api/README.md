# DeepBook Faucet

Lightweight token faucet for the DeepBook sandbox. Distributes **SUI** (proxied from Sui's built-in faucet), **DEEP**, and **USDC** (both transferred directly from the deployer wallet).

## Endpoints

| Method | Path      | Description                                              |
| ------ | --------- | -------------------------------------------------------- |
| `GET`  | `/`       | Health check — returns service info and deployer address |
| `POST` | `/faucet` | Request SUI, DEEP, or USDC tokens                        |

## Request Format

```
POST /faucet
Content-Type: application/json
```

### Body

| Field     | Type     | Required | Description                                                           |
| --------- | -------- | -------- | --------------------------------------------------------------------- |
| `address` | `string` | Yes      | Recipient Sui address (`0x` + 64 hex chars)                           |
| `token`   | `string` | Yes      | `"SUI"`, `"DEEP"`, or `"USDC"`                                        |
| `amount`  | `number` | No       | DEEP/USDC only — whole tokens to send (default: `1000`, max: `10000`) |

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

### Request USDC (default 1000 USDC)

```bash
curl -X POST http://localhost:9009/faucet \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "token": "USDC"
  }'
```

**Response:**

```json
{ "success": true, "digest": "8BYqr..." }
```

## Environment Variables

| Variable                | Required | Default                    | Description                                      |
| ----------------------- | -------- | -------------------------- | ------------------------------------------------ |
| `PRIVATE_KEY`           | Yes      | —                          | Bech32-encoded Sui private key (deployer wallet) |
| `DEEP_TOKEN_PACKAGE_ID` | Yes      | —                          | Package ID of the deployed DEEP token            |
| `USDC_TOKEN_PACKAGE_ID` | Yes      | —                          | Package ID of the deployed USDC token            |
| `RPC_URL`               | No       | `http://sui-localnet:9000` | Sui RPC endpoint                                 |
| `PORT`                  | No       | `9009`                     | Server listen port                               |
| `MAX_DEEP_PER_REQUEST`  | No       | `10000`                    | Maximum DEEP tokens per request                  |
| `MAX_USDC_PER_REQUEST`  | No       | `10000`                    | Maximum USDC tokens per request                  |

## Running

### Via Docker (recommended)

The faucet is included in the sandbox Docker Compose stack:

```bash
cd sandbox
docker compose --profile localnet up -d
```

### Local development

```bash
cd sandbox/api
cp .env.example .env  # configure env vars
pnpm install
pnpm dev
```
