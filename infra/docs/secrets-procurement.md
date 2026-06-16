# Operator Manual: Secret & Configuration Procurement

This document guides operators through obtaining every secret and configuration value required to run the identity-backend in production. Values are consumed by `sst secret set` or as plain environment variables; the format column describes exactly what lands in each.

---

## 1. Apple — App Attest & DeviceCheck

### `APPLE_TEAM_ID`

**What it is:** 10-character Apple Developer Team identifier.

**Where to get it:**

1. Sign in to [developer.apple.com](https://developer.apple.com) → **Account** → **Membership** page.
2. The Team ID appears under "Team Information" → **Team ID**.

**Format:** Plain 10-character alphanumeric string (e.g., `A1B2C3D4E5`).

**Source:** [Apple Developer Membership](https://developer.apple.com/account)

---

### `APPLE_APP_ATTEST_APP_IDS`

**What it is:** List of App IDs (bundle identifiers) authorized to use App Attest.

**Where to get it / How to enable:**

1. Apple Developer → **Certificates, Identifiers & Profiles** → **Identifiers**.
2. Select the App ID (or create one if it doesn't exist).
3. Under **Capabilities**, enable **App Attest**.
   - Requires Account Holder or Admin role in the Apple Developer Program.
4. Record the bundle identifier (e.g., `com.example.myapp`) — this is the value.

**Format:** JSON array of strings: `["com.example.myapp", "com.example.myapp-dev"]`.

**Caveats:**

- App Attest must be enabled **per App ID**. If your app has separate dev/staging bundle IDs, each must have the capability enabled.
- The App ID must be a **explicit** App ID (not a wildcard).

**Source:** [Establishing Your App's Integrity](https://developer.apple.com/documentation/devicecheck/establishing_your_app_s_integrity)

---

### `DEVICE_CHECK_KEY_ID` and `DEVICE_CHECK_PRIVATE_KEY`

**What it is:** Key ID (e.g., `A1B2C3D4E5`) and the corresponding ECDSA P-256 private key used to call the DeviceCheck API.

**Where to get it:**

1. Apple Developer → **Certificates, Identifiers & Profiles** → **Keys**.
2. Click **+** (Register a New Key).
3. Enter a key name, check **DeviceCheck**, and configure the key with your team's associated App ID(s).
4. Click **Continue** → **Register**.
5. **Download the .p8 file immediately** — it is shown only once and cannot be re-downloaded.
6. The **Key ID** appears on the key detail page (also visible in the Keys list).

**Format:**

- `DEVICE_CHECK_KEY_ID`: Plain string from the key detail page (10 characters).
- `DEVICE_CHECK_PRIVATE_KEY`: **The raw PEM text of the `.p8` file, verbatim, including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines.** Pass to `jose`'s `importPKCS8(pem, 'ES256', { extractable: false })`. This is the OPPOSITE of APN — DO NOT base64-encode this; the value is a PKCS#8 PEM string.

Set via `pnpm sst secret set DEVICE_CHECK_PRIVATE_KEY "$(cat AuthKey_ABCDE12345.p8)" --stage <stage>`. Newlines are preserved in the secret store.

**Caveats:**

- Downloaded once, never retrievable again. Store securely.
- The .p8 is **PEM, not base64**. The runtime calls `importPKCS8(redactedValue, 'ES256', { extractable: false })` directly. (Source: `apps/identity-backend/src/runtime.ts:360-365`.)
- The same .p8 can be registered for both DeviceCheck and App Attest on the same key.

**Source:** [DeviceCheck Documentation](https://developer.apple.com/documentation/devicecheck/)

---

### `DEVICE_CHECK_URL`

**What it is:** Base URL for Apple's DeviceCheck v1 API.

**Format:** String. Default: `https://api.devicecheck.apple.com/v1`.

**Caveats:**

- **Sandbox vs Production:** The same URL handles both. The distinction is the APNs environment (sandbox vs production) used by the client app, not the DeviceCheck endpoint itself. Do not change this value.
- Only override if Apple publishes a new API version or you are using a proxy/gateway.

**Source:** [DeviceCheck API Reference](https://developer.apple.com/documentation/devicecheck/)

---

## 2. Apple — APN (Push Notifications)

### `APN_KEY_ID`, `APN_TEAM_ID`, `APN_PRIVATE_KEY`

**What it is:** APNs authentication key credentials for sending push notifications to production builds.

**Where to get it:**

1. Apple Developer → **Certificates, Identifiers & Profiles** → **Keys**.
2. Click **+** (Register a New Key).
3. Enter a key name, check **Apple Push Notifications service (APNs)**.
4. Click **Continue** → **Register**.
5. **Download the .p8 immediately** — shown once only.
6. The **Key ID** is on the key detail page. The **Team ID** is the same `APPLE_TEAM_ID` used for DeviceCheck.

**Format:**

- `APN_KEY_ID`: Plain 10-character string.
- `APN_TEAM_ID`: Same as `APPLE_TEAM_ID`.
- `APN_PRIVATE_KEY`: **Base64-encode the raw bytes of the `.p8` file** (standard base64, not base64url). The runtime decodes base64 → bytes → `Buffer.from(bytes, 'utf-8')` to feed `@parse/node-apn`'s `Provider({ token: { key, keyId, teamId } })`. This is the OPPOSITE of DeviceCheck — the APN key is base64-encoded, the DeviceCheck key is PEM. Set via `pnpm sst secret set APN_PRIVATE_KEY "$(base64 -w0 -i AuthKey_ABCDE12345.p8)" --stage <stage>`.

**Caveats:**

- One-time download. Store securely.
- The `.p8` is for **token-based authentication** (preferred over certificates). The same key can be used for all your apps under the same team.

**Source:** [Establishing a Token-Based Connection to APNs](https://developer.apple.com/documentation/usernotifications/establishing_a_token-based_connection_to_apns)

---

### `APN_PRIVATE_KEY_DEV` / `APN_KEY_ID_DEV`

**What it is:** Optional separate APN key for the development (sandbox) environment.

**Where to get it:** Same procurement flow as the production APN key above. Register a second key or reuse the same key (Apple supports a single key for both environments; `APN_KEY_ID_DEV` is only needed if you want separate key tracking).

**Format:** Same as `APN_PRIVATE_KEY` / `APN_KEY_ID`.

**Caveats:**

- Required only when `DUAL_FLOW_NOTIFICATIONS_ENABLED=true` — which routes notifications to both dev and production environments simultaneously for a bundle ID matching `APN_DEVELOPMENT_SUFFIXES` (default: `.develop`).
- If `DUAL_FLOW_NOTIFICATIONS_ENABLED=false`, only `APN_PRIVATE_KEY` / `APN_KEY_ID` are required.

---

### `APN_TOPICS`

**What it is:** List of bundle identifiers for apps that receive APN notifications.

**Where to get it:**

1. [App Store Connect](https://appstoreconnect.apple.com) → Select your app → **General** → **App Information**.
2. The **Bundle ID** is listed under "General Information". Repeat for each app.
3. Alternatively: Apple Developer → **Certificates, Identifiers & Profiles** → **Identifiers** — the bundle IDs are listed there.

**Format:** JSON array of strings: `["com.example.myapp", "com.example.myapp-staging"]`.

**Caveats:**

- Each topic corresponds to one app's bundle ID. For apps with both a production and development build target, include the production bundle ID; the system routes to the correct APNs environment based on the build variant.

---

### `APN_PRODUCTION`

**What it is:** Boolean that sets the default APN environment for bundle IDs not matching `APN_DEVELOPMENT_SUFFIXES`.

**Format:** `true` or `false`.

**When to set:**

- `true` — App Store / TestFlight builds (production environment).
- `false` — debug / development / simulator builds (sandbox environment).

**Caveats:**

- The runtime uses `APN_DEVELOPMENT_SUFFIXES` to detect dev-suffixed bundle IDs and always routes those to both environments when `DUAL_FLOW_NOTIFICATIONS_ENABLED=true`, regardless of this flag.

---

## 3. Google — Play Integrity

### `GOOGLE_CREDENTIALS`

**What it is:** Base64-encoded JSON service-account credentials for Google Cloud.

**Where to get it:**

1. [Google Cloud Console](https://console.cloud.google.com) → **IAM & Admin** → **Service Accounts**.
2. Click **Create Service Account**. Name it (e.g., `play-integrity-api`).
3. Grant role: **Play Integrity API Editor** (or more narrowly, **Play Integrity API Developer** — verify the exact role name in your GCP console, as Google renames roles periodically).
4. After creation, select the service account → **Keys** tab → **Add Key** → **JSON** → download the `.json` key file.
5. Base64-encode the file: `cat service-account-key.json | base64 -w 0`. Set the result as `GOOGLE_CREDENTIALS` via `pnpm sst secret set GOOGLE_CREDENTIALS "<base64-string>" --stage <stage>`. The same `GOOGLE_CREDENTIALS` value is consumed by **both Play Integrity AND FCM** — they share one service account. The FCM service uses `firebase-admin/app#initializeApp({ credential: cert(decoded-service-account) })`. (Source: `apps/identity-backend/src/infrastructure/adapters/notifications/fcm/service.ts:63-68`.)

**Format:** A single-line base64 string of the downloaded JSON key file. The app decodes base64 → JSON → parses as service-account credentials.

**Caveats:**

- The service account must have the Play Integrity API role. Without it, every Play Integrity API call returns `UNAUTHORIZED`.
- The JSON key file is shown once on download. Store it securely; if lost, create a new key from the GCP console.

**Source:** [Google Cloud Service Accounts](https://cloud.google.com/iam/docs/service-accounts), [Play Integrity API](https://developer.android.com/google/play/integrity)

---

### `ANDROID_PACKAGE_NAMES`

**What it is:** List of Android application IDs authorized for Play Integrity attestation.

**Where to get it:**

1. [Google Play Console](https://play.google.com/console) → Select your app.
2. The application ID is on the **Setup → App integrity** page, or in **Release → Devices and countries → Device catalog**.
3. Alternatively: the app's `build.gradle` / `AndroidManifest.xml` contains the `applicationId`.

**Format:** JSON array of strings: `["io.pcf.polkadotapp", "io.pcf.polkadotapp.dev"]`.

---

### `ANDROID_SIGNING_DIGEST_PLAYSTORE`

**What it is:** SHA-256 fingerprint of the certificate Google uses to sign APKs delivered to users via the Play Store (Play App Signing).

**Where to get it:**

1. Google Play Console → **Setup → App integrity** → **App signing** tab.
2. Under "App signing key certificate", copy the **SHA-256 fingerprint**.
3. Strip colons and convert to lowercase.
4. Set as the env var (hex string, 64 characters).

**Format:** 64-character hex string (lowercase, no `0x` prefix, no colons). The app validates this matches the signing certificate in the Play Integrity token.

**Caveats:**

- This is Google's signing key, **not your upload key**. If you are not enrolled in Play App Signing, this is your own upload key certificate.
- If you enroll in Play App Signing after launch, Google re-signs your app — update this value to the new Google-managed certificate.

**Source:** [Use Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)

---

### `ANDROID_SIGNING_DIGEST_WEBSITE`

**What it is:** SHA-256 fingerprint of the certificate used to sign APKs distributed via your own website (sideloaded builds).

**How to obtain (from APK):**

```bash
# Option 1: apksigner (preferred)
apksigner verify --print-certs my-app.apk
# Look for "SHA-256 Digest" in the output

# Option 2: keytool (from keystore)
keytool -list -v -keystore my-release.jks -alias upload
# Take the "SHA256:" fingerprint, strip colons, lowercase
```

**Format:** 64-character hex string (lowercase, no `0x`, no colons).

**Caveats:**

- For a Play Store build, this value may still be present but represents the upload certificate used to sign the AAB uploaded to Play. The Play Integrity response contains both the Play-signing digest and the upload-cert digest depending on `PLAY_INTEGRITY_MODE`.
- Generate this from your release keystore or from an APK built with your website-distribution signing key.

---

### `ANDROID_ATTESTATION_ROOT_PEMS`

**What it is:** PEM-encoded X.509 certificates used as trust anchors for Android key-attestation certificate chains.

**Format:** Array of PEM strings. Default: Google's hardware attestation root certificates (baked into the `android-attest` package as `GOOGLE_ROOT_CERTS`).

**Caveats:**

- **Override only when testing with a custom test CA.** In normal production, the Google roots are correct and sufficient.
- If you run a test device with a custom CA-signed attestation chain, provide your test root CA PEM here.

---

## 4. Cloudflare

### `CloudflareZoneId`

**Where it lives:** `.env` at the repo root as `CLOUDFLARE_ZONE_ID`. Not an SST secret.

**What it is:** Cloudflare zone identifier for the DNS zone hosting your API.

**Where to get it:**

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → Select your domain (zone).
2. The **Zone ID** appears on the **Overview** page, in the right-hand panel under "API".

**Format:** 32-character hex string (lowercase).

---

### `ApiHostname`

**Where it lives:** `.env` at the repo root as `API_HOSTNAME`. Not an SST secret. Optional — if unset, the service is exposed at the ALB URL and no Cloudflare DNS record or edge policy is deployed.

**What it is:** The DNS hostname through which the API is exposed (e.g., `api.example.com`). This must be a Cloudflare-managed zone.

**How to set up:**

1. Add the domain to Cloudflare: **Add a domain** in the Cloudflare dashboard.
2. Cloudflare provides nameserver addresses. Update your domain registrar to point to Cloudflare's nameservers.
3. Create a DNS `A` or `CNAME` record in Cloudflare pointing to your backend's IP/hostname.
4. Ensure **Proxy status** is set to "Proxied" (orange cloud) to enable Cloudflare's WAF and rate-limiting features.

---

### Cloudflare API Token

**What it is:** API token with scoped permissions for the Cloudflare Pulumi provider (used by SST to manage DNS, WAF rules, and SSL settings during deployment).

**Where to get it:**

1. Cloudflare Dashboard → **My Profile** → **API Tokens** → **Create Token** → **Create Custom Token**.
2. Set the following permissions:
   - **Zone → DNS → Edit** — to manage DNS records.
   - **Zone → WAF → Edit** — to manage WAF rules.
   - **Zone → Settings → Edit** — to manage zone settings.
   - **Zone → SSL and Certificates → Edit** — to manage SSL certificates.
3. **Account Resource** scope: select your account.
4. **Zone Resource** scope: include the specific zone(s) to limit the token to one domain.
5. Create the token. Copy it immediately — it is shown only once.

**Format:** A long alphanumeric string. Set via `sst secret set CLOUDFLARE_API_TOKEN`.

**Caveats:**

- The token is shown once on creation. Store it securely.
- Scope the token to the **minimum required zone(s)** to limit blast radius if the token is compromised.

**Source:** [Create API Token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), [API Token Permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)

---

### `CLOUDFLARE_PLAN`

**What it is:** Cloudflare plan tier for the zone.

**Plan requirements:**

| Feature                                       | Free   | Pro      | Business | Enterprise |
| --------------------------------------------- | ------ | -------- | -------- | ---------- |
| Rate-limit rules (new)                        | 1 rule | 2 rules  | 5 rules  | 5+         |
| Rate limiting (legacy)                        | 1 rule | 10 rules | 15 rules | 100        |
| `cf.unique_visitor_id` + `countingExpression` | No     | No       | **Yes**  | Yes        |
| Per-phase quota (request/body)                | 1/1    | 2/2      | **5/5**  | 5+         |

**Caveats:**

- The `http_ratelimit` rule using `cf.unique_visitor_id` as a counter key **requires Business or Enterprise plan**.
- If your plan is Free/Pro, Cloudflare's standard rate-limiting uses different keys and expressions; review the [rate limiting documentation](https://developers.cloudflare.com/waf/rate-limiting-rules/) for your plan tier.
- Set `CLOUDFLARE_PLAN` to the lowercase plan name: `free`, `pro`, `business`, `enterprise`.

**Source:** [Cloudflare Plans](https://developers.cloudflare.com/plans/)

---

## 5. People Chain (Polkadot) — Attester Account

### `PROXY_PRIVATE_KEY` and `ATTESTER_PROXY_PRIVATE_KEY`

**What it is:** sr25519 private key for the proxy account (and optionally a separate attester proxy account) that submits transactions to the People chain.

**Format:**

- 64-byte expanded sr25519 private key as a hex string (128 hex characters), with or without `0x` prefix.
- The Config layer strips any `0x` prefix and decodes via `S.Uint8ArrayFromHex`, then validates against `sr25519.PrivateKey`.

**How to generate:**

```bash
# Using Polkadot.js Keyring (Node.js)
node -e "
const { Keyring } = require('@polkadot/keyring');
const keyring = new Keyring({ type: 'sr25519' });
const pair = keyring.addFromMnemonic(require('crypto').randomBytes(12).toString('hex').match(/.{1,3}/g).join(' '));
console.log(pair.address());
console.log Buffer.from(pair.secretKey()).toString('hex'));
"

# Using subkey (CLI)
subkey generate --scheme sr25519
# Outputs: Secret phrase, Public key (SS58 address), Private key (hex)
```

**How to fund:**

- **paseo**: Get PAS tokens from the [paseo faucet](https://faucet.paseo.org/).
- **westend2**: Get WND tokens from the [westend2 faucet](https://faucet.polkadot.io/).
- **polkadot**: Get DOT from the [polkadot faucet](https://faucet.polymesh.live/) (or purchase on an exchange).

**Format on disk / in env:**

- The env var takes **raw hex** (no `0x` prefix). The Config layer handles `0x` stripping.
- The key is stored redacted in memory; never commit hex keys to source control.

**Caveats:**

- The account must have existential deposit + transaction fees.
- `ATTESTER_PROXY_PRIVATE_KEY` is required only when `PROXY_DELEGATION_ENABLED=true`.

---

### `INVITER_POOL_PRIVATE_KEY`

**What it is:** sr25519 private key for a **dedicated invitation-ticket pool signing account**. The pool daemon submits invitation-ticket extrinsics on its own account so high pool-refill traffic does not contend with username registration on the shared submission permit.

**Format:** identical to `ATTESTER_PROXY_PRIVATE_KEY` — 128-hex-character (64-byte) expanded sr25519 private key, with or without `0x` prefix. The Config layer strips any `0x` prefix.

**How to generate:**

```bash
# Use the repo's key generation script (same as PROXY_PRIVATE_KEY / ATTESTER_PROXY_PRIVATE_KEY):
# 1. Edit apps/identity-backend/scripts/private-key.ts — replace "put the mnemonic here"
#    with the 12/24-word mnemonic for the dedicated pool account
# 2. Run with Bun from the repo root:
bun apps/identity-backend/scripts/private-key.ts
# 3. Use the "Expanded Private Key (hex)" output as INVITER_POOL_PRIVATE_KEY.
#    This is the 128-char (64-byte) expanded sr25519 key.
```

**On-chain prerequisite:** like `ATTESTER_PROXY_PRIVATE_KEY`, this account is a **proxy submitter for the attester authority**. Its proxy delegation must be registered on-chain before it can submit; the community bootstrap script (`12c-setup-attestation-proxy.sh`) is the source of truth for that step, and it must be funded with existential deposit + transaction fees.

**Caveats:**

- Optional. Unset = fall back to the attester proxy signer (the prior behaviour).
- Only raise `INVITATION_TICKET_POOL_TARGET` / `INVITATION_TICKET_BATCH_SIZE` above their defaults in environments where this key is set; otherwise the larger pool contends with username registration.

---

### `ATTESTER_PUBLIC_KEY`

**What it is:** 32-byte public key (64 hex characters) corresponding to `ATTESTER_PROXY_PRIVATE_KEY`, used as the attester identity on-chain.

**How to derive:**

```bash
# From the private key hex (same as above, take the last 64 hex chars after decoding)
# Or via Polkadot.js:
node -e "
const { Keyring } = require('@polkadot/keyring');
const keyring = new Keyring({ type: 'sr25519' });
// Assuming PROXY_PRIVATE_KEY hex (without 0x) is set in the env:
const hex = process.env.ATTESTER_PROXY_PRIVATE_KEY.replace('0x','');
const pair = keyring.addFromUri('0x' + hex);
console.log(pair.address()); // SS58 address
console.log(Buffer.from(pair.publicKey).toString('hex')); // 32-byte hex
"
```

**Format:** 64-character hex string (32 bytes), no `0x` prefix.

---

### `PEOPLE_RPC_ENDPOINTS`

**What it is:** Array of WSS (WebSocket Secure) RPC endpoint URLs for the People chain.

**Recommended public endpoints:**

| Network  | Endpoint                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| paseo    | `wss://people-paseo.dotters.network`                                                                         |
| westend2 | `wss://people-westend2.dotters.network` (or confirm at [polkadot.js.org/apps](https://polkadot.js.org/apps)) |
| polkadot | `wss://people-polkadot.dotters.network` (or public RPC list)                                                 |

**Format:** JSON array of WSS URLs. Set via `sst secret set` as a JSON array string, e.g.:

```
["wss://people-paseo.dotters.network", "wss://backup-rpc.example.com"]
```

**Caveats:**

- Always provide at least one endpoint. For production, a self-hosted or commercial RPC (e.g., Dotters, OnFinality) is preferred over public community RPCs for reliability.
- The app connects to all listed endpoints; failures are handled with automatic failover.

---

### `PEOPLE_NETWORK`

**What it is:** Literal identifying the People chain network.

**Valid values:** `westend2`, `polkadot`, `paseo`.

**Which to use:**

| Environment           | Network    |
| --------------------- | ---------- |
| Development / Preview | `paseo`    |
| Staging / Test        | `westend2` |
| Production            | `polkadot` |

---

### `PEOPLE_CHAIN_DESCRIPTOR`

**What it is:** Runtime descriptor for encoding People chain calls. Baked into the chain configuration or supplied by the chain's deployment config.

**Valid values:** `previewnet_people`, `paseo_people`, `paseo_people_next`.

**Caveats:**

- The descriptor corresponds to a specific runtime version. When the People chain runtime is upgraded, this value may need to change to match the new descriptor.
- Default: `previewnet_people`. Verify the correct value for your network by checking the chain's runtime metadata or your internal chain deployment documentation.

---

## 6. Asset Hub (Polkadot) — dotNS Gateway

### `ASSET_HUB_RPC_ENDPOINTS`

**What it is:** Array of WSS RPC endpoint URLs for Asset Hub, which hosts the `pallet_dotns_gateway` pallet.

**Recommended public endpoints:**

| Network  | Endpoint                                |
| -------- | --------------------------------------- |
| paseo    | `wss://asset-hub-paseo.dotters.network` |
| westend2 | `wss://asset-hub-westend-rpc.parity.io` |
| polkadot | `wss://asset-hub-rpc.polkadot.io`       |

**Format:** JSON array of WSS URLs. Set as JSON array string via `sst secret set`.

---

## 7. JWT, TURN, VAPID, Web Push

### `JWT_AUTH_SECRET`

**What it is:** Secret key used to derive HMAC-SHA256 keys for challenge tokens and to sign JWT authentication tokens.

**How to generate:**

```bash
# 32 random bytes, base64-encoded
openssl rand -base64 32
# Trim to desired length — the app uses the raw bytes directly
```

**Format:** Base64-encoded string. Set via `sst secret set JWT_AUTH_SECRET`.

**Caveats:**

- Minimum 32 bytes of entropy recommended. `openssl rand -base64 32` produces 32 bytes after decoding.
- The secret is used as-is as the HMAC key. Do not base64-decode before storing — the app decodes at startup.

---

### `TURN_SECRET`

**What it is:** Base64-encoded shared secret used as the HMAC key for generating short-lived TURN credentials.

**How to generate:**

```bash
openssl rand -base64 32
```

**Format:** Single-line base64 string. The app decodes base64 → raw bytes and uses them as the HMAC key.

**Source:** RFC 5389 / RFC 8489 for TURN credential generation.

---

### `TURN_REALM`

**What it is:** The TURN server's realm string — typically the FQDN of the TURN server (e.g., `turn.example.com`).

**Format:** Plain string. The realm is announced by the TURN server in its Allocate response and is used by clients to identify which TURN server to authenticate against.

**Caveats:**

- Set to the FQDN of your coturn / Cloudflare TURN server. Must match what the TURN server is configured with.
- If using Cloudflare's TURN (Cloudflare Calls / WebRTC proxy), consult the Cloudflare documentation for the correct realm format.

---

### `WEB_PUSH_VAPID_PRIVATE_KEY`

**What it is:** Base64url-encoded P-256 ECDH private key for VAPID web push.

**How to generate:**

```bash
# Using Node.js web-push package
npx web-push generate-vapid-keys
# Outputs:
# ====================================================
# Public Key:
# <base64url-encoded public key>
# Private Key:
# <base64url-encoded private key>
# ====================================================
```

Or programmatically:

```bash
node -e "
const { generateVAPIDKeys } = require('web-push');
const keys = generateVAPIDKeys();
console.log('Private:', keys.privateKey);
console.log('Public:', keys.publicKey);
"
```

**Format:** Base64url-encoded string (32 bytes P-256 private key). Set via `sst secret set WEB_PUSH_VAPID_PRIVATE_KEY`. The app decodes base64url and derives the public key internally via `createECDH('prime256v1')`.

**Caveats:**

- The **public key** is exposed via `GET /api/v1/subscriptions/vapid-public-key` and is sent to browsers when they subscribe.
- The private key must be kept confidential; anyone with it can send push notifications on behalf of your server.

---

### `WEB_PUSH_VAPID_SUBJECT`

**What it is:** VAPID subject — a `mailto:` or `https:` URI that identifies your server to push providers.

**Format:** RFC 8292 requires this field. Use `mailto:ops@example.com` or `https://example.com/contact`. Set as a plain string env var.

---

## 8. Generic Credentials

### `ADMIN_USERNAME` / `ADMIN_PASSWORD`

**What it is:** Basic-auth credentials for the `/admin/*` routes.

**Default:** `admin` / `admin` (both are default, must be overridden in production).

**Caveats:**

- **NEVER deploy with defaults.** Set strong, unique passwords in production.
- Set via plain env vars (not redacted by the config system for these — treat them as secrets nonetheless).
- The password is stored as a `Redacted<string>` in memory but is not hashed; basic-auth transmits it in plaintext over HTTPS.

---

### `DEBUG_USERNAME` / `DEBUG_PASSWORD`

**What it is:** Basic-auth credentials for the `/debug/*` routes.

**Default:** `debug` / `debug`.

**Caveats:**

- The debug routes expose sensitive diagnostic functionality (`heapdump`, `sql`, `voucher`). **Never enable in production.**
- Even if enabled accidentally, strong credentials provide a defense layer.

---

### `GrafanaWebhookUrl`

**What it is:** HTTP endpoint that accepts Grafana alert webhook payloads. May include an auth token in the query string.

**Where to get it:**

1. Grafana → **Alerting** → **Contact points** (or **Notification policies**).
2. Create or select a contact point of type **Webhook**.
3. The URL includes any auth query parameters. Copy the full URL.

**Format:** Full HTTP(S) URL. Set via `sst secret set GrafanaWebhookUrl` (includes any query-string token).

**Caveats:**

- Treat the URL as a secret if it contains a bearer token or API key in the query string — it is transmitted in plaintext in alert payloads.

---

## 9. AWS

### `AWS_ACCOUNT_ID` and `AWS_REGION`

**What it is:** AWS account ID and region for the deployment. The region is `eu-central-1` (Frankfurt) per the SST configuration.

**Where to find:**

- **Account ID**: AWS Console → **My Account** → **Account Id**. Or: IAM → **Account settings**.
- **Region**: Set to `eu-central-1`.

**IAM User / Role for Deployment:**
The Pulumi Cloudflare / AWS providers in SST require an IAM user or role with these permissions:

- **ECS**: `ecs:*` (create, update, delete services, tasks, clusters)
- **RDS**: `rds:*` (create, manage instances, clusters, parameter groups)
- **VPC**: `ec2:*` (subnets, security groups, internet gateways, route tables)
- **IAM**: `iam:*` (roles, instance profiles, policies)
- **S3**: `s3:*` (buckets, objects, lifecycle configurations)
- **CloudWatch Logs**: `logs:*` (log groups, streams)
- **Secrets Manager**: `secretsmanager:*` (create, read secrets)
- **CloudFormation**: `cloudformation:*` (stacks, stack sets)
- **SST-managed resources**: `sst:*` (SST's own resources)

**Caveats:**

- The SST CLI bootstraps these resources on first run via the configured AWS credentials (from `AWS_PROFILE` or environment variables `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`).
- Do **not** use the root account. Create a dedicated deployment IAM user with scoped permissions.

---

### ECR Repository

**What it is:** Amazon Elastic Container Registry repository for the backend Docker image.

**Setup:** **Auto-created by `sst.aws.Service`** on first deploy. No manual setup required.

---

### S3 ALB Access Log Bucket

**What it is:** S3 bucket that receives ALB (Application Load Balancer) access logs.

**Setup:** **Auto-created by `sst.aws.Service`** (the `AlbAccessLogs` resource in `infra/service.ts`). No manual setup.

---

### RDS PostgreSQL

**What it is:** Managed PostgreSQL instance for the application database.

**Setup:** **Auto-created by `sst.aws.Service`**. The master password is generated by SST and stored in AWS Secrets Manager — **do not set it manually**.

**Connection string:** Set as `DATABASE_URL` with format:

```
postgresql://<user>:<password>@<host>:<port>/<dbname>
```

The connection details are managed by SST and surfaced via `sst.secret` outputs after the first deploy.

---

## 10. SST & Pulumi

### Pulumi Backend

**Default:** SST uses the Pulumi Cloud free tier (`https://app.pulumi.com`). State and locks are stored in Pulumi's managed service.

**For a private backend (S3 + DynamoDB):**

1. Create an S3 bucket for state:
   ```bash
   aws s3api create-bucket --bucket my-pulumi-state --region eu-central-1
   aws s3api put-bucket-versioning --bucket my-pulumi-state --versioning-configuration Status=Enabled
   aws s3api put-bucket-encryption --bucket my-pulumi-state --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
   ```

2. Create a DynamoDB table for state locking:
   ```bash
   aws dynamodb create-table \
     --table-name pulumi-state-locks \
     --attribute-attrs Name=LockID,Type=S \
     --key-schema AttributeName=LockID,KeyType=HASH \
     --billing-mode PAY_PER_REQUEST
   ```

3. Set the backend URL:
   ```bash
   export PULUMI_BACKEND_URL=s3://my-pulumi-state
   export PULUMI_S3_ACCESS_KEY_ID=<key>
   export PULUMI_S3_SECRET_ACCESS_KEY=<secret>
   export PULUMI_S3_SESSION_TOKEN=<session-token>  # if using STS temp credentials
   ```
   Or set in `sst.config.ts` via the `backend` option.

**Source:** [SST State Documentation](https://sst.dev/docs/reference/state/)

---

### What Gets Committed vs. Not

| Artifact            | Committed?             | Notes                                       |
| ------------------- | ---------------------- | ------------------------------------------- |
| `sst.config.ts`     | Yes                    | Infrastructure-as-code, committed           |
| `.sst/` directory   | **No**                 | Local build artifacts, gitignored           |
| Pulumi state        | **No**                 | Stored in Pulumi backend (cloud or S3)      |
| `secret set` values | **No**                 | Stored in AWS Secrets Manager (SST-managed) |
| `.env` / `.env.*`   | **No** (if gitignored) | Never commit secrets                        |

**SST Lock:** Located in the Pulumi backend (cloud or DynamoDB). The lock prevents concurrent `sst deploy` operations. If a deploy is interrupted, the lock may need to be manually released via `pulumi cancel`.

---

## Summary: Format Reference

Two mechanisms — keep them separate:

- **Secrets** are stored in AWS Secrets Manager (encrypted at rest) and injected by SST as `Redacted` env vars. Set with `pnpm sst secret set NAME <value> --stage <stage>`.
- **Deployment config** is read straight from the host environment (Pulumi auto-loads `.env` from the repo root) and injected as plain env vars. Set in `.env` or `export NAME=value` before `pnpm sst deploy`.

A value belongs in **secrets** only if leaking it would harm you (private keys, API tokens, signing secrets, webhook URLs with embedded tokens, passwords). Everything else — public keys, team IDs, RPC endpoints, package names, plan tiers, hostnames, zone IDs — is **deployment config**.

### Secrets (AWS Secrets Manager)

| Secret                       | Format                                  | Encoding                   |
| ---------------------------- | --------------------------------------- | -------------------------- |
| `JWT_AUTH_SECRET`            | Base64 bytes                            | Base64                     |
| `PROXY_PRIVATE_KEY`          | 128-char hex                            | `0x` prefix stripped       |
| `ATTESTER_PROXY_PRIVATE_KEY` | 128-char hex                            | `0x` prefix stripped       |
| `INVITER_POOL_PRIVATE_KEY`   | 128-char hex                            | `0x` prefix stripped       |
| `DEVICE_CHECK_PRIVATE_KEY`   | PKCS#8 PEM text (verbatim)              | Plain (newlines preserved) |
| `APN_PRIVATE_KEY`            | Raw `.p8` bytes                         | Base64 (of file bytes)     |
| `TURN_SECRET`                | Base64 bytes                            | Base64                     |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | Base64url P-256 key                     | Base64url                  |
| `GOOGLE_CREDENTIALS`         | JSON service-account key file           | Base64                     |
| `ADMIN_PASSWORD`             | String                                  | Plain                      |
| `DEBUG_PASSWORD`             | String                                  | Plain                      |
| `CLOUDFLARE_API_TOKEN`       | Long alphanumeric                       | Plain                      |
| `GrafanaWebhookUrl`          | Full HTTP URL with optional query token | Plain                      |

### Deployment config (`.env`)

| Key                                | Format                                                     | Encoding                         |
| ---------------------------------- | ---------------------------------------------------------- | -------------------------------- |
| `PEOPLE_NETWORK`                   | `westend2` / `polkadot` / `paseo`                          | Plain (default: `westend2`)      |
| `PEOPLE_RPC_ENDPOINTS`             | JSON array of WSS URLs                                     | Plain (default: per network)     |
| `ASSET_HUB_RPC_ENDPOINTS`          | JSON array of WSS URLs                                     | Plain (default: per network)     |
| `PEOPLE_CHAIN_DESCRIPTOR`          | `previewnet_people` / `paseo_people` / `paseo_people_next` | Plain                            |
| `ATTESTER_PUBLIC_KEY`              | 64-char hex                                                | No prefix                        |
| `APPLE_TEAM_ID`                    | 10-char alphanumeric                                       | Plain                            |
| `APPLE_APP_ATTEST_APP_IDS`         | JSON array                                                 | Plain                            |
| `DEVICE_CHECK_KEY_ID`              | 10-char string                                             | Plain                            |
| `DEVICE_CHECK_URL`                 | URL string                                                 | Plain (default provided)         |
| `APN_KEY_ID`                       | 10-char string                                             | Plain                            |
| `APN_TEAM_ID`                      | 10-char string                                             | Plain (default: `APPLE_TEAM_ID`) |
| `APN_TOPICS`                       | JSON array of bundle IDs                                   | Plain                            |
| `APN_PRODUCTION`                   | `true` / `false`                                           | Plain                            |
| `ANDROID_PACKAGE_NAMES`            | JSON array                                                 | Plain                            |
| `ANDROID_SIGNING_DIGEST_PLAYSTORE` | 64-char hex                                                | Lowercase, no colons             |
| `ANDROID_SIGNING_DIGEST_WEBSITE`   | 64-char hex                                                | Lowercase, no colons             |
| `ANDROID_ATTESTATION_ROOT_PEMS`    | JSON array of PEM strings                                  | Default: baked-in Google roots   |
| `CLOUDFLARE_PLAN`                  | `free` / `pro` / `business` / `enterprise`                 | Lowercase (default: `pro`)       |
| `CLOUDFLARE_ZONE_ID`               | 32-char hex                                                | Lowercase                        |
| `API_HOSTNAME`                     | FQDN string                                                | Plain (optional)                 |
| `TURN_REALM`                       | FQDN string                                                | Plain (default: derived)         |
| `WEB_PUSH_VAPID_SUBJECT`           | `mailto:` or `https:` URI                                  | Plain (default: localhost)       |
| `ADMIN_USERNAME`                   | String                                                     | Plain                            |
| `DEBUG_USERNAME`                   | String                                                     | Plain                            |
