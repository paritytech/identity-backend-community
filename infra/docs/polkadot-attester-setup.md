# Operator Setup Walkthrough — Mobile-App Backend on Polkadot People Chain

This document tells an operator who has never used Polkadot tooling exactly what to do, in what order, with what tool, for four independent setup flows.

---

## Chain-state pre-requisite (read this first)

The on-chain state this repo's deploy assumes — funded attester accounts, sudo proxy delegation, **`AttestationAllowance` grants on BOTH People and AssetHub**, DotNS gateway dispatcher address, attestation invite pool — is provisioned by the public bootstrap scripts in **`paritytech/individuality-community/tree/main/scripts/initial-setup/`**. This repo does **not** own those scripts and the SST deploy does not run them.

Before you start Flow 2 below (fund the on-chain account), confirm the community bootstrap is complete for your target network. The two scripts that gate this repo's runtime behavior are:

- **`12b-setup-attestation-allowances.sh`** — grants `peopleLite.AttestationAllowance` on the People chain and `dotnsGateway.AttestationAllowance` on Asset Hub. **Both grants are required and independent** — see [`polkadot-attester-onchain.md`](./polkadot-attester-onchain.md) § "The attester must have BOTH allowances".
- **`12c-setup-attestation-proxy.sh`** — sets the proxy delegation the backend uses to dispatch attestation calls.

For the full sequence (00 → 13, including XTRNL, USDT/USDC, PGAS, people collection), see the community README: `paritytech/individuality-community/tree/main/scripts/initial-setup/README.md`.

If the community bootstrap is not yet run for your network, stop and run it. This document assumes it has been.

---

## Flow 1: Generate the proxy + attester sr25519 key pair

### Prerequisites

- A local terminal with `node` ≥ 20 or `bun` runtime (the repo uses `pnpm` / `bun`)
- Optional (for subkey CLI path): Rust toolchain (`cargo`) or a downloaded binary
- **Never commit mnemonics to git.** Store the 12/24-word mnemonic in 1Password, Vault, or KMS immediately after generation. The expanded private key goes into the SST secret; the mnemonic goes nowhere near `.env` or the repo.

### Step-by-step walkthrough

#### Option A — Polkadot.js Extension (browser, no CLI)

1. Install the **Polkadot.js extension** from the [Chrome Web Store](https://chrome.google.com/webstore/detail/polkadot%7Bjs%7D-extension/mopnmbcafieddcagajdcgmlnkjmioobf) or Firefox Add-ons.
2. Open the extension → **+ Create new account** → choose **sr25519** (the dropdown in the "create account" screen shows "sr25519" as the selection; it may default to sr25519 on Polkadot chains).
3. Save the **mnemonic** shown. Copy it somewhere safe immediately — the extension does not show it again.
4. Click **Advanced** and note the **SS58 address** (the human-readable chain address, e.g. `4sejX...` on Paseo).
5. To export the raw **hex private key** for the SST secret: the extension does not natively export the expanded 64-byte private key. Use Option C (keyring snippet) or Option B (subkey `inspect`) to convert the mnemonic to hex.

#### Option B — subkey CLI

Install from source or release artifact:

```bash
# From crates.io (recommended for most operators)
cargo install subkey --locked

# Or from the Polkadot SDK repo
# https://github.com/paritytech/polkadot-sdk/tree/master/subkey
```

**Generate a new keypair:**

```bash
subkey generate --scheme sr25519 --network paseo
```

Expected output:

```
Secret phrase:       put your twelve-word mnemonic here
Network ID:          paseo
Public key (hex):    0xd4a9...        ← 32-byte public key, 64 hex chars
Public key (SS58):   4sejX...         ← chain address (fund this)
Account ID:          0xd4a9...
Secret seed:         0xd4a9...        ← the 32-byte chain-specific seed (not the expanded key)
```

**Convert mnemonic → expanded 64-byte private key** (the value for `PROXY_PRIVATE_KEY`):

```bash
subkey inspect --scheme sr25519 --network paseo "put your twelve-word mnemonic here"
```

The `Secret seed` in the `inspect` output is the 32-byte seed — **not** the 64-byte expanded key. For the expanded key, use the keyring snippet (Option C) or note that `subkey generate` prints the hex public key (`0xd4a9...`, 64 chars) which is `ATTESTER_PUBLIC_KEY`.

#### Option C — polkadot-js keyring in Node.js (canonical, used by the repo)

The repo ships a helper at **`apps/identity-backend/scripts/private-key.ts`**. It uses `@identity-backend/crypto` (which wraps `@polkadot-labs/schnorrkel-wasm`) and `@polkadot-labs/hdkd-helpers`.

**Run the existing script (edit the mnemonic in-place):**

```bash
cd apps/identity-backend
# Edit the mnemonic in the script first:
nano scripts/private-key.ts
# Change: const entropy = mnemonicToEntropy('put the mnemonic here')
# to:     const entropy = mnemonicToEntropy('your actual twelve-word mnemonic')

bun run scripts/private-key.ts
```

The script outputs:

```
Expanded Private Key (hex):
<128-character-hex-string>          ← PROXY_PRIVATE_KEY / ATTESTER_PROXY_PRIVATE_KEY

SS58 Address:
<ss58-address>                      ← fund this address
```

**If no helper script exists**, use this standalone Node.js snippet (requires `pnpm add @polkadot-labs/hdkd-helpers @polkadot-labs/schnorrkel-wasm polkadot-api` in a temp dir):

```javascript
// generate-key.js
import { entropyToMiniSecret, mnemonicToEntropy, ss58Address } from '@polkadot-labs/hdkd-helpers'
import { sr25519_pubkey, sr25519_secret_from_seed } from '@polkadot-labs/schnorrkel-wasm'
import { Binary } from 'polkadot-api'

const mnemonic = process.argv[2] ?? 'your twelve-word mnemonic here'

// Step 1: mnemonic → 32-byte entropy
const entropy = mnemonicToEntropy(mnemonic)

// Step 2: entropy → 64-byte "mini secret" (expanded seed)
const miniSecret = entropyToMiniSecret(entropy)

// Step 3: mini secret → sr25519 keypair
const seed = miniSecret.slice(0, 32) // use the first 32 bytes as the seed
const publicKey = sr25519_pubkey(seed)

// Step 4: derive expanded private key (64 bytes) for the SST secret
// The expanded key = sr25519_keypair_from_seed(seed).privateKey (64 bytes)
// Use the schnorrkel wasm directly:
const expandedPrivateKeyBytes = sr25519_secret_from_seed(seed) // returns 64 bytes

console.log('Expanded Private Key (hex, 128 chars):')
console.log(Binary.toHex(expandedPrivateKeyBytes)) // 128 hex chars — for PROXY_PRIVATE_KEY

console.log('Public Key (hex, 64 chars):')
console.log(Binary.toHex(publicKey)) // 64 hex chars — for ATTESTER_PUBLIC_KEY

console.log('SS58 Address (paseo):')
console.log(ss58Address(publicKey)) // fund this
```

```bash
node generate-key.js "put your twelve-word mnemonic here"
```

### Resulting credential shape

| Credential                   | Hex length                                        | Example                           |
| ---------------------------- | ------------------------------------------------- | --------------------------------- |
| `PROXY_PRIVATE_KEY`          | 128 chars (64 bytes), with or without `0x` prefix | `0xd4a9e8...f3c1` (128 hex chars) |
| `ATTESTER_PROXY_PRIVATE_KEY` | same shape as above                               | same                              |
| `INVITER_POOL_PRIVATE_KEY`   | same shape as above                               | same                              |
| `ATTESTER_PUBLIC_KEY`        | 64 chars (32 bytes)                               | `d4a9e8...f3c1` (no `0x` prefix)  |
| SS58 address (paseo)         | human-readable                                    | `4sejXmR6aHJu7dR4wGqK9jZ2vN3...`  |

The mnemonic itself is **never** an env var. It is the root secret — store it in a vault.

### Format required for the env var / SST secret

- **`PROXY_PRIVATE_KEY`**: 128-character hex string. May have `0x` prefix or not — the backend's `Redacted` decoder handles both. Paste the full 128 chars exactly.
- **`ATTESTER_PUBLIC_KEY`**: 64-character hex string, **no** `0x` prefix. This is the 32-byte public key used as the on-chain attester identifier.
- **`ATTESTER_PROXY_PRIVATE_KEY`**: Same as `PROXY_PRIVATE_KEY` — the expanded 64-byte private key. Only required when `PROXY_DELEGATION_ENABLED=true`; otherwise the backend uses `PROXY_PRIVATE_KEY` for the attester account.
- **`INVITER_POOL_PRIVATE_KEY`**: Same expanded 64-byte private key shape. A dedicated signing account for the invitation-ticket pool so its refill traffic does not contend with username registration. The account must be registered as a proxy of the attester on-chain (see [`polkadot-attester-onchain.md`](./polkadot-attester-onchain.md)).

### Verification

```bash
# Verify the expanded key decodes to the expected public key and SS58 address
# using subkey (paseo network):
subkey inspect --scheme sr25519 --network paseo "your twelve-word mnemonic here"
# Check that the hex public key matches ATTESTER_PUBLIC_KEY
# Check that the SS58 address matches the one you funded
```

```bash
# Or verify with polkadot-js API in Node:
node -e "
const { mnemonicToEntropy, entropyToMiniSecret, ss58Address } = require('@polkadot-labs/hdkd-helpers');
const { sr25519_pubkey, sr25519_secret_from_seed } = require('@polkadot-labs/schnorrkel-wasm');
const { Binary } = require('polkadot-api');
const mnemonic = 'your twelve-word mnemonic';
const entropy = mnemonicToEntropy(mnemonic);
const miniSecret = entropyToMiniSecret(entropy);
const seed = miniSecret.slice(0, 32);
const pk = sr25519_pubkey(seed);
console.log('Public key (hex):', Binary.toHex(pk));
console.log('SS58 (paseo):', ss58Address(pk));
"
```

### Common errors

| Error                        | Cause                                                                  | Fix                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Invalid mnemonic`           | Wrong word count or typos                                              | Ensure exactly 12 (or 24) words, space-separated                                                                            |
| `ss58Address is not defined` | Wrong import path for the SS58 codec                                   | Use `@polkadot-labs/hdkd-helpers` as shown; the older `@polkadot/util-crypto` package uses a different API                  |
| Wrong network address        | `subkey inspect` without `--network` flag defaults to Polkadot mainnet | Always pass `--network paseo` (or `westend2`, `polkadot`)                                                                   |
| Hex key too short/long       | Confusing the 32-byte secret seed with the 64-byte expanded key        | The env var needs 128 hex chars (64 bytes); the `subkey inspect` `Secret seed` is 32 bytes and is **not** the env var value |

### Source

- subkey: <https://github.com/paritytech/polkadot-sdk/tree/master/subkey>
- polkadot-js keyring: <https://polkadot.js.org/docs/keyring/>
- sr25519 spec: <https://wiki.polkadot.network/docs/learn-cryptography>
- `apps/identity-backend/scripts/private-key.ts` (repo helper script)

---

## Flow 2: Fund the on-chain account

### Prerequisites

- The SS58 address generated in Flow 1 (e.g. `4sejXmR6aHJu...` on Paseo)
- Network selected: **paseo** (testnet), **westend2** (testnet), or **polkadot** (mainnet)
- For mainnet Polkadot: no faucet — purchase DOT from an exchange

### Step-by-step walkthrough

#### Fund on Paseo (testnet)

1. Open <https://faucet.paseo.org/> in a browser.
2. Paste the SS58 address from Flow 1 into the input field.
3. Click **Claim**. Funds (≈ 1–10 PAS) arrive in ~30 seconds.
4. Verify at <https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Fpeople-paseo.dotters.network#/accounts> — the balance should be non-zero.

#### Fund on Westend 2 (testnet)

1. Open <https://faucet.polkadot.io/> → select **Westend** from the network dropdown.
2. Paste the SS58 address and click **Claim**.
3. Alternative: send a message to the Matrix faucet at <https://matrix.to/#/#westend_faucet:matrix.org> with the address: `!faucet <ss58-address>`
4. Verify at <https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Frpc.polkadot.io#/accounts> (change RPC to `wss://westend2.api.onfinality.io/public-ws` if needed).

#### Fund on Polkadot (mainnet)

1. Purchase DOT on an exchange (Binance, Kraken, or any DOT-supporting exchange).
2. Withdraw to the SS58 address from Flow 1.
3. Minimum withdrawal ≈ 1 DOT (existential deposit). Recommend funding with 5–10 DOT for transaction fees.

### Verify the balance

**Via Polkadot.js Apps UI:**

1. Navigate to <https://polkadot.js.org/apps/>
2. Click the network selector (top-left) → **Polkadot** → **People Chain** → select the appropriate RPC (e.g. `wss://people-paseo.dotters.network` for Paseo).
3. Go to **Accounts** → your address should show a balance ≥ existential deposit.

**Via cURL:**

```bash
# Check balance via the JSON-RPC (replace <wss-endpoint> and <ss58-address>)
curl -s -H "Content-Type: application/json" \
  -d '{"id":1,"jsonrpc":"2.0","method":"account_nextIndex","params":["<ss58-address>"]}' \
  <wss-endpoint>
```

Or use the **Chain state** extrinsic in Polkadot.js Apps: **Developer → Chain state → storage → system → account(<address>)** → read. The `data` field contains `free: <balance>`.

### Verify the attester registration

On the People chain, the `peopleLite` pallet identifies attesters by their **public key** (the `ATTESTER_PUBLIC_KEY` value). The chain does not have a `setAttester` self-call — instead, attestation allowance is granted by the chain's `AttestationAllowanceManager` origin (typically the Sudo pallet or governance).

**To register as an attester:**

The `peopleLite.increase_attestation_allowance(<attester-account>, <count>)` extrinsic (call index 0) grants attestation slots to an account. The origin must be `AttestationAllowanceManager`. On testnets this is typically the Sudo key; on mainnet it is governance.

**Via Polkadot.js Apps:**

1. Go to **Developer → Extrinsics**.
2. Submit the extrinsic: `peopleLite → increase_attestation_allowance(attester: <ss58-address>, count: 100)`.
3. Set the origin to the Sudo key (or the configured `AttestationAllowanceManager` origin).

**Verify the allowance:**

**Developer → Chain state → dotnsGateway / peopleLite → attestationAllowance(<attester-public-key>) → read.**

The `peopleLite.attestationAllowance` storage map returns `u32` — the number of remaining attestations. A value ≥ 1 means the account is an active attester.

```text
# Chain state query (Polkadot.js Apps)
peopleLite.attestationAllowance(<ss58-address>) → u32
```

### Resulting credential shape

After funding and attester registration, the operator has:

| Item                  | Value                                                        |
| --------------------- | ------------------------------------------------------------ |
| Funded SS58 address   | `4sejXmR6...` (the chain account)                            |
| Attestation allowance | ≥ 1 (visible in `peopleLite.attestationAllowance` storage)   |
| `ATTESTER_PUBLIC_KEY` | 64-hex-char public key corresponding to the attester account |

### Common errors

| Error                                           | Cause                                                        | Fix                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| "Inability to pay some fees"                    | Account balance below existential deposit (ED)               | Fund the account with ≥ 1 ED above the minimum                                    |
| `NoAttestationAllowance` on submit              | The attester account has no remaining allowance              | Call `peopleLite.increase_attestation_allowance` with the attester's SS58 address |
| `BadOrigin` on `increase_attestation_allowance` | The calling account is not the `AttestationAllowanceManager` | Use the Sudo key (or governance) to submit this extrinsic                         |
| Balance shows 0 after faucet claim              | Wrong network selected in Polkadot.js Apps                   | Confirm the RPC matches the network (e.g. Paseo RPC for Paseo faucet)             |

### Source

- Paseo faucet: <https://faucet.paseo.org/>
- Westend2 faucet: <https://faucet.polkadot.io/>
- Polkadot account generation: <https://wiki.polkadot.network/docs/learn-account-generation>
- People chain runtime (vendored): `paritytech/individuality-community/tree/main/pallets/people-lite/src/lib.rs`

---

## Flow 3: dotNS gateway (Asset Hub) setup

> **Required only when `DOTNS_GATEWAY_ENABLED=true`.** If disabled, skip this flow entirely.

### Prerequisites

- Asset Hub chain ID: **1000** (the system parachain for Polkadot/Kusama)
- The attester account must have an **AttestationAllowance** on Asset Hub (separate from the People chain allowance — these are two independent pallets on two independent chains)
- `ASSET_HUB_RPC_ENDPOINTS` to be set (see Flow 4)

### Step-by-step walkthrough

#### Confirm Asset Hub WSS endpoints

| Network               | WSS Endpoint                            |
| --------------------- | --------------------------------------- |
| Paseo (Asset Hub)     | `wss://asset-hub-paseo.dotters.network` |
| Westend 2 (Asset Hub) | `wss://asset-hub-westend-rpc.parity.io` |
| Polkadot (Asset Hub)  | `wss://asset-hub-rpc.polkadot.io`       |

Set as the SST secret `ASSET_HUB_RPC_ENDPOINTS` as a JSON array:

```json
["wss://asset-hub-paseo.dotters.network"]
```

For multiple endpoints (failover): `["wss://primary.example.com","wss://backup.example.com"]`.

#### Grant attestation allowance on Asset Hub

The `dotnsGateway` pallet on Asset Hub has an `increase_attestation_allowance` extrinsic (call index 2). The origin must be the `AttestationAllowanceManager` on Asset Hub.

**Via Polkadot.js Apps:**

1. Navigate to Polkadot.js Apps connected to **Asset Hub** (change network → Asset Hub → the relevant network).
2. **Developer → Extrinsics**.
3. Submit: `dotnsGateway → increase_attestation_allowance(attester: <attester-ss58-address>, count: 1000)`.
4. Set the origin to the `AttestationAllowanceManager` key (Sudo on testnets).

#### Verify the allowance

**Developer → Chain state → dotnsGateway → attestationAllowance(<attester-ss58-address>) → read.**

The storage returns `u32` — the number of remaining username reservations the attester can perform. A value ≥ 1 means the backend can submit `dotnsGateway.reserve_name` calls.

### Resulting credential shape

| Item                         | Shape                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `ASSET_HUB_RPC_ENDPOINTS`    | JSON array of WSS strings, e.g. `["wss://asset-hub-paseo.dotters.network"]`            |
| `ATTESTER_PUBLIC_KEY`        | 64-char hex public key (same as Flow 1) — used to identify the attester on both chains |
| `ATTESTER_PROXY_PRIVATE_KEY` | 128-char hex expanded private key (same as Flow 1) — signs transactions on Asset Hub   |

### Common errors

| Error                                      | Cause                                                                 | Fix                                                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NoAttestationAllowance` on `reserve_name` | Attester has 0 allowance on Asset Hub                                 | Call `dotnsGateway.increase_attestation_allowance` on Asset Hub                                                                                                                |
| `DispatcherAddressNotSet`                  | The `RootGatewayDispatcher` contract address has not been initialised | The dispatcher address is set via `dotnsGateway.set_dispatcher_address` (AttestationAllowanceManager origin) — this is a chain bootstrapping step done by the network operator |
| Wrong network                              | Submitting to Polkadot Asset Hub instead of Paseo Asset Hub           | Confirm the RPC URL matches the target network                                                                                                                                 |

### Source

- Asset Hub docs: <https://wiki.polkadot.network/docs/learn-assets>
- dotns-gateway pallet (vendored): `paritytech/individuality-community/tree/main/pallets/dotns-gateway/src/lib.rs` — `increase_attestation_allowance` (call index 2), `attestationAllowance` storage item (line 171–173)

---

## Flow 4: RPC endpoint setup

### Prerequisites

- At least one WSS endpoint per chain (People chain + Asset Hub if `DOTNS_GATEWAY_ENABLED=true`)
- Endpoints must use the `wss://` (WebSocket Secure) protocol — plain `ws://` is not accepted

### Step-by-step walkthrough

#### Set env vars in SST secret

| Env Var                   | Example Value                               |
| ------------------------- | ------------------------------------------- |
| `PEOPLE_RPC_ENDPOINTS`    | `["wss://people-paseo.dotters.network"]`    |
| `ASSET_HUB_RPC_ENDPOINTS` | `["wss://asset-hub-paseo.dotters.network"]` |

Both are JSON arrays. In the SST secret string, escape the brackets appropriately for your deployment method.

#### Public WSS endpoints per network

**Paseo (People chain):**

- `wss://people-paseo.dotters.network` (Dotters — primary)
- `wss://paseo.api.onfinality.io/public-ws` (OnFinality)

**Westend 2 (People chain):**

- `wss://westend2.api.onfinality.io/public-ws` (OnFinality)
- `wss://rpc.polkadot.io` (Polkadot.js Apps default — may be overloaded)

**Polkadot (People chain):**

- `wss://people-rpc.polkadot.io` (Polkadot RPC)
- `wss://rpc.polkadot.io` (fallback)

**Paseo (Asset Hub):**

- `wss://asset-hub-paseo.dotters.network` (Dotters — primary)

**Westend 2 (Asset Hub):**

- `wss://asset-hub-westend-rpc.parity.io` (Parity)
- `wss://asset-hub-westend-rpc.parity.io` (OnFinality)

**Polkadot (Asset Hub):**

- `wss://asset-hub-rpc.polkadot.io` (Polkadot RPC)

#### Self-hosted RPC node

If the operator runs their own node:

**Binary:** `polkadot` (for relay chain / Polkadot mainnet) or `polkadot-parachain` (for the People chain which is a parachain).

**Required flags for a WSS RPC endpoint:**

```bash
polkadot \
  --ws-external \
  --rpc-external \
  --rpc-cors all \
  --rpc-methods=unsafe \
  --prometheus-port 9615 \
  # For parachains (People chain):
  --chain /path/to/people-chain-genesis \
  --pruning=1000
```

> **Security note:** `--rpc-methods=unsafe` exposes all RPC methods including dangerous ones. Use it only on a node that is not exposed to the public internet, or use a TLS termination proxy in front of port 9944.

**TLS termination:** The node must be behind a TLS-terminating reverse proxy (nginx, Caddy, cloud LB) that presents a valid certificate. The WSS client in the backend requires TLS — it will reject `ws://` with a protocol error.

**P2P port:** Ensure port 30333 (or the configured `--port`) is reachable from the internet for block syncing.

**Verification:**

```bash
# Check the node is syncing and responding to RPC
curl -s -H "Content-Type: application/json" \
  -d '{"id":1,"jsonrpc":"2.0","method":"system_syncState","params":[]}' \
  https://your-node.example.com:9944

# Expected: {"jsonrpc":"2.0","result":{"currentBlock":1234567,...},"id":1}
```

### Multiple endpoints for failover

The backend reconnects automatically on disconnect. List endpoints in priority order — the first one that resolves and connects is used:

```json
["wss://primary.example.com", "wss://backup-a.example.com", "wss://backup-b.example.com"]
```

### Common errors

| Error                                           | Cause                                            | Fix                                                                                    |
| ----------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `WebSocket connection failed`                   | Wrong protocol (http vs https, or missing TLS)   | Use `wss://`, not `ws://` or `http://`                                                 |
| `Account did not receive runtime updates`       | Node is not fully synced                         | Wait for the node to catch up to chain tip, or use a public RPC that is already synced |
| `disconnected, reconnecting...` in backend logs | Endpoint unreachable or overloaded               | Add more endpoints for failover, or switch to a more reliable provider                 |
| `Error: Missing the following rpc endpoints`    | `PEOPLE_RPC_ENDPOINTS` not set in the SST secret | Set it as a JSON array string, e.g. `["wss://people-paseo.dotters.network"]`           |

### Source

- Dotters Network: <https://dotters.network/> (endpoint list)
- Polkadot.js Apps (chain selector): <https://polkadot.js.org/apps/>
- Parity public RPC endpoints: <https://github.com/paritytech/polkadot-clients-services>

---

## Quick reference: env var summary

| Env Var                      | Format                              | Where it comes from                                                 |
| ---------------------------- | ----------------------------------- | ------------------------------------------------------------------- |
| `PROXY_PRIVATE_KEY`          | 128-char hex (with or without `0x`) | Flow 1 — expanded sr25519 private key                               |
| `ATTESTER_PROXY_PRIVATE_KEY` | Same as above                       | Flow 1 — same key, only needed when `PROXY_DELEGATION_ENABLED=true` |
| `INVITER_POOL_PRIVATE_KEY`   | Same as above                       | Dedicated invitation-pool signer (People chain)                     |
| `ATTESTER_PUBLIC_KEY`        | 64-char hex (no `0x`)               | Flow 1 — 32-byte sr25519 public key                                 |
| `PEOPLE_RPC_ENDPOINTS`       | JSON array of WSS strings           | Flow 4                                                              |
| `ASSET_HUB_RPC_ENDPOINTS`    | JSON array of WSS strings           | Flow 3 + Flow 4                                                     |
| `DOTNS_GATEWAY_ENABLED`      | `true` / `false`                    | Enable only if using Asset Hub dotNS gateway                        |
| `PROXY_DELEGATION_ENABLED`   | `true` / `false`                    | Enable only if the attester account differs from the proxy account  |
