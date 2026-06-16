# Production Checklist — Pre-Promotion Gate

> **STOP. READ THIS BEFORE PROMOTING ANY STAGE TO PRODUCTION TRAFFIC.**
>
> This is the **unmissable** document. The deploy will succeed, the API
> will return 200, the LGTM dashboard will render, and the operator
> will go to bed thinking everything is fine — **even when the
> attestation surface is silently off.** When that happens, anyone with
> `curl` and a generated JWT can register a username, mint vouchers,
> or mint push subscriptions. The system looks healthy in every
> dashboard while being a fully open relay on the public internet.
>
> **This is not a checklist of nice-to-haves. Every item is a
> load-bearing pillar.** If the App Attest layer is off, iOS clients
> can spoof the device attestation. If the Android key-attestation
> trust roots are wrong, anyone can mint a fake "Google-signed"
> device. If Play Integrity is in `relaxed_all` mode, even sideloaded
> APKs pass. If `AUTH_ENABLED` is false, all attestation is a no-op.
> If the People-chain allowance is zero, registrations queue forever.
> If `ENFORCE_AUTH` is false, every `Auth-Attestation` header is
> accepted without verification.
>
> **You MUST use the script in
> [`Appendix B`](#appendix-b--check-script).** Run it before every
> promotion. A non-zero exit means the promotion is rejected. No
> human override.
>
> **Audience:** the operator who owns the deploy. **Not** a coding
> agent. For env-var/secret _formats_ see
> [`secrets-procurement.md`](./secrets-procurement.md) and
> [`first-time-setup.md` § 7.2](./first-time-setup.md#72--write-env-at-the-repo-root).
> This doc is "what to set" — those docs are "what format."

---

## 0. Scope

This checklist applies to **all** stages that serve real users or chain
transactions. Personal/dev/ephemeral stages (`ryan`, `scratch`, your
name) **may skip this** — they're for trying the deploy once. A stage
becomes "real" the first time it:

- Receives traffic from a mobile client build downloaded by anyone other than you, **OR**
- Submits a chain extrinsic whose finalization matters (i.e., is not a chopsticks fixture), **OR**
- Is named in a release announcement, **OR**
- Has `SST_STAGE=production` set in the deploy env.

If any of these is true, the checklist is mandatory.

---

## 1. Attestation surface — every layer must be on

The backend's anti-abuse stack is **eight independent layers.** Each
defends a specific attack. **Any one of them off = that attack
succeeds.** The layers, in order of the request lifecycle:

| # | Layer                       | Env var(s)                                                                                                                               | What it defends                                                                                                                                           | Failure mode when OFF                                                                                                                                                                                                                                                  |
| - | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | **`AUTH_ENABLED`**          | `AUTH_ENABLED=true`                                                                                                                      | Auth plugin is even mounted; without it the request short-circuits past attestation                                                                       | Every request bypasses attestation; the system is an open relay                                                                                                                                                                                                        |
| 2 | **`ENFORCE_AUTH`**          | `ENFORCE_AUTH=true`                                                                                                                      | Soft gate is closed; `Auth-Attestation` header is **required** and **verified** on every request                                                          | iOS sends App Attest, but the server accepts ANY base64-shaped blob as a valid assertion                                                                                                                                                                               |
| 3 | **App Attest allowlist**    | `APPLE_APP_ATTEST_APP_IDS=[…]`                                                                                                           | Only attested bundle IDs (e.g. `com.example.app`) are accepted; spoofed bundle IDs are rejected                                                           | Attacker registers a fake App ID and gets an attestation object accepted for it                                                                                                                                                                                        |
| 4 | **iOS DeviceCheck**         | `DEVICE_CHECK_IOS_ENABLED=true` (and `ENFORCE_AUTH=true`)                                                                                | The 2-bit per-device state on Apple's servers — a single physical device can register one username, then must pay to clear                                | An attacker with a fleet of jailbroken iPhones can register one username per device, jailbreak-clear the DC state, register again, repeat. Each device is cheap; the fleet is not.                                                                                     |
| 5 | **Android key attestation** | `ANDROID_PACKAGE_NAMES=[…]`, `ANDROID_SIGNING_DIGEST_PLAYSTORE=…`, `ANDROID_SIGNING_DIGEST_WEBSITE=…`, `ANDROID_ATTESTATION_ROOT_PEMS=…` | The Android device's hardware-backed key has a certificate chain rooted at Google's attestation CA, with a public-key pin matching the app's signing cert | Anyone can mint a JSON the server accepts as a "Google-signed" Android device. With `ANDROID_ATTESTATION_ROOT_PEMS` overridden to a test CA, **every** Android request passes regardless of hardware backing.                                                          |
| 6 | **Play Integrity**          | `GOOGLE_CREDENTIALS=…`, `PLAY_INTEGRITY_MODE=strict`                                                                                     | Google has signed a verdict that the app binary is the real Play Store build on a hardware-backed device                                                  | `relaxed_device` accepts real devices with weak verdicts (nightly/paseo). `relaxed_all` accepts sideloaded / debug APKs. **Production must be `strict`.**                                                                                                              |
| 7 | **Android CRL**             | `ANDROID_ATTESTATION_CRL_URL=https://android.googleapis.com/attestation/status` (default — DO NOT OVERRIDE)                              | Google publishes a list of revoked attestation certs; the app refreshes the CRL hourly and rejects devices whose cert is on the list                      | Overriding this URL to a non-Google endpoint (or a stale mock) means revoked devices still pass. The default is correct; the only acceptable override is "I'm behind a corporate proxy that allows `android.googleapis.com` and I'm just adding a different DNS name." |
| 8 | **Proof-of-compute (PoC)**  | `POC_ENABLED=true` (required when `RATE_LIMIT_PROFILE=shared-nat`)                                                                       | Public-read endpoints (`/usernames/search`, `/usernames/available`) are defended against CGNAT-borne floods by a client-computed work puzzle              | Without PoC under `shared-nat`, one IP behind CGNAT can hammer `/usernames/search` at full L7 rate. The origin per-JWT limiter doesn't help unauthenticated endpoints.                                                                                                 |

**If any layer is silently off, the attacker path is open.** Layer
3 (App Attest allowlist) is the most-missed: the env var is read at
request time, and an empty allowlist means **every** App ID is
accepted. Layer 5's `ANDROID_ATTESTATION_ROOT_PEMS` is the second
most-missed: an override to a test CA happens during local dev and
sometimes gets committed to `.env`.

The relationship between `AUTH_ENABLED` and `ENFORCE_AUTH`:

| `AUTH_ENABLED` | `ENFORCE_AUTH` |  App Attest  | DeviceCheck  | Soft-gate? | Attack                                                                                    |
| :------------: | :------------: | :----------: | :----------: | :--------: | ----------------------------------------------------------------------------------------- |
|    `false`     |    `false`     |     off      |     off      |    n/a     | everyone is unauthenticated                                                               |
|     `true`     |    `false`     |   advisory   |   advisory   |    yes     | attacker can pass the soft gate; some traffic still authenticated, some not               |
|     `true`     |     `true`     | **enforced** | **enforced** |     no     | attacker must present a valid App Attest assertion + a fresh DC state — the design intent |
|    `false`     |     `true`     |     off      |     off      |     no     | contradictory: gate is on but no plugin is mounted; `ENFORCE_AUTH` is meaningless         |

**Production must be `AUTH_ENABLED=true` AND `ENFORCE_AUTH=true`.**
The other three rows are debug states.

---

## 2. SST secrets — all 12 must be set per stage

The 12 secrets live in AWS Secrets Manager under the namespaced path
`identity-backend/<stage>/<NAME>`. They are injected into the container
env at task start via the task role + VPC endpoint. **No hot-reload:**
after a `sst secret set`, the next `pnpm sst deploy` (or a
`force-new-deployment`) is required for the running tasks to see the
new value.

| #  | Secret                       | Format                                                             | Procurement                                                                |                      Must be set?                      |
| -- | ---------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- | :----------------------------------------------------: |
| 1  | `JWT_AUTH_SECRET`            | 48+ random bytes, base64 (`openssl rand -base64 48`)               | `openssl rand -base64 48`                                                  |                        **YES**                         |
| 2  | `PROXY_PRIVATE_KEY`          | 128-char hex (64-byte expanded sr25519) — **not** the 32-byte seed | [`polkadot-attester-setup.md`](./polkadot-attester-setup.md)               |                        **YES**                         |
| 3  | `ATTESTER_PROXY_PRIVATE_KEY` | 128-char hex                                                       | same                                                                       |        only if `PROXY_DELEGATION_ENABLED=true`         |
| 4  | `WEB_PUSH_VAPID_PRIVATE_KEY` | 32-byte P-256 key, base64url                                       | `bun -e 'console.log(require("web-push").generateVAPIDKeys().privateKey)'` |            only if `WEB_PUSH_ENABLED=true`             |
| 5  | `DEVICE_CHECK_PRIVATE_KEY`   | **raw PKCS#8 PEM string** (NOT base64)                             | Apple Developer portal                                                     |        only if `DEVICE_CHECK_IOS_ENABLED=true`         |
| 6  | `APN_PRIVATE_KEY`            | base64 of the raw `.p8` file bytes                                 | Apple Developer portal                                                     |                 **YES** (push is core)                 |
| 7  | `TURN_SECRET`                | 32 random bytes, base64                                            | `openssl rand -base64 32`                                                  |                 **YES** (TURN is core)                 |
| 8  | `GOOGLE_CREDENTIALS`         | base64 of the Google service-account JSON                          | Google Cloud Console                                                       |             **YES** (Play Integrity + FCM)             |
| 9  | `ADMIN_PASSWORD`             | 24+ random bytes, base64                                           | `openssl rand -base64 24`                                                  |           only if `ADMIN_ROUTE_ENABLED=true`           |
| 10 | `DEBUG_PASSWORD`             | 24+ random bytes, base64                                           | same                                                                       | only if **any** debug route is enabled (do NOT enable) |
| 11 | `GrafanaWebhookUrl`          | the alert webhook URL                                              | your alerting system                                                       |   **YES** (or alerts are misrouted to a placeholder)   |
| 12 | `CLOUDFLARE_API_TOKEN`       | Cloudflare API token with Zone DNS/WAF/Settings/SSL Edit           | Cloudflare dashboard                                                       |          only if `CLOUDFLARE_ZONE_ID` is set           |

**Verify every secret is real, not the dev placeholder.** The placeholders in `infra/secrets.ts` are explicit (`dev-placeholder-...`); if any of them reaches a production stage the app is running with a publicly-known secret. Run from the operator's laptop:

```bash
STAGE=<stage>
for s in JWT_AUTH_SECRET PROXY_PRIVATE_KEY ATTESTER_PROXY_PRIVATE_KEY \
         WEB_PUSH_VAPID_PRIVATE_KEY DEVICE_CHECK_PRIVATE_KEY APN_PRIVATE_KEY \
         TURN_SECRET GOOGLE_CREDENTIALS ADMIN_PASSWORD DEBUG_PASSWORD \
         GrafanaWebhookUrl CLOUDFLARE_API_TOKEN; do
  val=$(aws secretsmanager get-secret-value --secret-id "identity-backend/$STAGE/$s" --query SecretString --output text 2>/dev/null)
  case "$val" in
    dev-placeholder*|0x0000000000000000000000000000000000000000000000000000000000000000|https://hooks.example.invalid/*)
      echo "FAIL $s: placeholder value";;
    "") echo "FAIL $s: not set";;
    *)  echo "OK   $s";;
  esac
done
```

**Hard fail if any line says `FAIL`.** Rotate that secret, then
`pnpm sst deploy --stage $STAGE` to roll the fleet.

---

## 3. Deployment config — the 12 env vars in `.env` at the repo root

These are non-secret per-stage values read at deploy time by
`pnpm sst deploy` (Pulumi auto-loads `.env` from the repo root). 11 of
the 12 are throw-if-missing; `PEOPLE_NETWORK` defaults to `'westend2'`.

| #  | Key                                | Default                                                    | Where it shows up                                           |
| -- | ---------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| 1  | `PEOPLE_NETWORK`                   | `westend2`                                                 | runtime + `appDeploymentConfig()` (also picks RPC defaults) |
| 2  | `PEOPLE_RPC_ENDPOINTS`             | derived from `PEOPLE_NETWORK`                              | runtime                                                     |
| 3  | `ASSET_HUB_RPC_ENDPOINTS`          | derived from `PEOPLE_NETWORK`                              | runtime                                                     |
| 4  | `ATTESTER_PUBLIC_KEY`              | **required, throws**                                       | runtime (used in `GET /api/v1/attester`)                    |
| 5  | `ANDROID_PACKAGE_NAMES`            | **required, throws**                                       | runtime (refuses to boot if empty)                          |
| 6  | `ANDROID_SIGNING_DIGEST_PLAYSTORE` | **required, throws**                                       | runtime                                                     |
| 7  | `ANDROID_SIGNING_DIGEST_WEBSITE`   | **required, throws**                                       | runtime                                                     |
| 8  | `APPLE_TEAM_ID`                    | **required, throws**                                       | runtime                                                     |
| 9  | `DEVICE_CHECK_KEY_ID`              | **required, throws**                                       | runtime                                                     |
| 10 | `APN_KEY_ID`                       | **required, throws**                                       | runtime                                                     |
| 11 | `APN_TEAM_ID`                      | falls back to `APPLE_TEAM_ID`                              | runtime                                                     |
| 12 | `TURN_REALM`                       | derived: `turn.<apex-of-API_HOSTNAME>` or `turn.localhost` | runtime                                                     |

**Auto-URL path (no custom domain):** `CLOUDFLARE_ZONE_ID` and
`API_HOSTNAME` are **not** set. `TURN_REALM` falls back to
`turn.localhost` (syntactically valid, not reachable from the public
internet — this is fine for personal stages but must be set explicitly
for production).

**Cloudflare path:** set `CLOUDFLARE_ZONE_ID` and `API_HOSTNAME` in
`.env`, set `CLOUDFLARE_API_TOKEN` via `sst secret set`. See
[`first-time-setup.md` § 7.0](./first-time-setup.md#70--choose-your-url-strategy-do-this-before-you-set-secrets)
for the URL-strategy decision matrix.

**Verify every required value is set:**

```bash
for k in ATTESTER_PUBLIC_KEY ANDROID_PACKAGE_NAMES \
         ANDROID_SIGNING_DIGEST_PLAYSTORE ANDROID_SIGNING_DIGEST_WEBSITE \
         APPLE_TEAM_ID DEVICE_CHECK_KEY_ID APN_KEY_ID; do
  v=$(grep "^$k=" .env | cut -d= -f2-)
  case "$v" in
    ""|*"<"*|0x0*) echo "FAIL $k: missing or placeholder";;
    *)            echo "OK   $k";;
  esac
done
```

---

## 4. Two-knob invariants — the deploy refuses the wrong pairing

`RATE_LIMIT_PROFILE` and `CLOUDFLARE_PLAN` are resolved once in
`sst.config.ts` and passed to both the origin (per-pod rate limiter)
and the edge (Cloudflare ruleset). They **MUST agree**:

|  `RATE_LIMIT_PROFILE`  | compatible `CLOUDFLARE_PLAN` | What you get                                                   |
| :--------------------: | :--------------------------: | -------------------------------------------------------------- |
| `shared-nat` (default) |       `pro` (default)        | coarse IP-bucket at the edge, per-JWT at the origin            |
|      `shared-nat`      |          `business`          | fine `cf.unique_visitor_id` per-class limiting at the edge     |
|        `global`        |            `pro`             | per-IP at both layers (don't pick this if you're behind CGNAT) |
|        `global`        |          `business`          | per-class per-visitor at the edge                              |

**MUST be set as shell env vars on the `pnpm sst deploy` invocation, not in `.env`.** The deploy reads them from the operator's environment at deploy time:

```bash
RATE_LIMIT_PROFILE=shared-nat CLOUDFLARE_PLAN=pro pnpm sst deploy --stage <stage>
```

**Verify on every deploy:**

```bash
aws ssm get-parameter --name "/sst/<stage>/config/RATE_LIMIT_PROFILE" --query Parameter.Value
aws ssm get-parameter --name "/sst/<stage>/config/CLOUDFLARE_PLAN" --query Parameter.Value
# Both must be the values you set on the deploy command line.
```

Misalignment does not throw at deploy — the `assertPlanQuotaFits` safety net in `infra/edge.ts` catches over-quota rule counts, but a `cf.unique_visitor_id` on a Pro plan is silently dropped by the Cloudflare API (a vague `10000` error). The single source of truth for this rule: `infra/AGENTS.md`'s "RATE_LIMIT_PROFILE and CLOUDFLARE_PLAN must agree across layers" invariant, restated in [`edge-cloudflare.md`](./edge-cloudflare.md) per plan.

---

## 5. Feature flags — the must-on / must-off matrix

The app reads ~30 boolean flags from env. Some default true (the
must-on daemons), some default false (the must-off debug routes, the
opt-in daemons). **Production promotion is the moment to verify every
flag against this table.**

### 5.1 Must be ON (true) for production

| Flag                               | Default | Why                                                                                                                                                                                                    | When off                                                                                                                                   |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTH_ENABLED`                     | `false` | **MUST be flipped to `true` for production.** The app accepts unauthenticated requests when off; with `ENFORCE_AUTH=true` (next row) it also requires App Attest.                                      | The auth plugin is unmounted; every request short-circuits past attestation. Open relay.                                                   |
| `ENFORCE_AUTH`                     | `false` | **MUST be flipped to `true` for production.** The App Attest soft gate is advisory when off; every iOS request gets App Attest verified when on.                                                       | Attacker can pass the soft gate with an invalid attestation; the system _looks_ authenticated but isn't.                                   |
| `DEVICE_CHECK_IOS_ENABLED`         | `false` | **MUST be flipped to `true` for production iOS clients.** When off, the DeviceCheck middleware is a no-op and `DEVICE_CHECK_*` env vars are unused — every iOS device is treated as clean.             | An attacker with a fleet of jailbroken iPhones can register one username per device, jailbreak-clear the DC state, register again, repeat. |
| `JWT_AUTH_ENFORCED`                | `false` | **MUST be flipped to `true` for production.** When off, `dim-ticket`, `invitation-ticket`, `notify`, `turn`, and `usernames` accept unauthenticated callers.                                           | The named routes accept any unauthenticated caller; the JWT is only attached when the client bothers.                                      |
| `POC_ENABLED`                      | `false` | **MUST be flipped to `true` when `RATE_LIMIT_PROFILE=shared-nat`.** Defends `/usernames/search` and `/usernames/available` against CGNAT-borne floods.                                                 | One IP behind CGNAT can hammer the public reads at full L7 rate. The origin per-JWT limiter doesn't help unauthenticated endpoints.        |
| `INVITATION_TICKET_DAEMON_ENABLED` | `true`  | Default on. Required for the invitation-ticket pool to fill.                                                                                                                                           | No tickets issued; the `/invitation-ticket` route returns 404 for every caller.                                                            |
| `FINALIZED_BLOCK_DAEMON_ENABLED`   | `true`  | Default on. Required for chain finalization tracking — `chain_stalled` alert goes red.                                                                                                                 | The `chain_stalled` alert never fires; chain halts are silent.                                                                             |
| `APN_PRODUCTION`                   | `false` | **MUST be flipped to `true` for production.** Sandbox (default) does not deliver to App Store builds.                                                                                                  | Production iOS clients get no push notifications.                                                                                          |
| `EXPOSE_BUILD_INFO`                | `false` | **Should be on in production.** Exposes `GET /api/v1/version` for on-call triage. Off by default because the original intent was "version not exposed in prod." Flip to `true` for incident debugging. | On-call cannot read the deployed git SHA without re-deploying with the flag flipped.                                                       |

### 5.2 Must be OFF (false) for production

| Flag                                 | Default               | Why                                                                                                                                              | When on                                                                                                                                                                                 |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_ROUTE_ENABLED`                | `false`               | Mounts `/admin` including `/admin/nuke` (wipes the DB). Keep off unless you're in a controlled incident.                                         | Anyone with the basic-auth credentials (default `admin`/`admin`!) can wipe the database. If on, `ADMIN_PASSWORD` MUST be set to a real value, not the default `Redacted.make('admin')`. |
| `DEBUG_HEAPDUMP_ENABLED`             | `false`               | Streams a V8 heap snapshot. The description in `config.ts` says it directly: "NEVER enable in production."                                       | The heap snapshot contains every in-memory secret (the `Redacted<string>` wrapper is a runtime optic, not a serialization control). `/debug/heapdump` exposes all of them.              |
| `DEBUG_SQL_ENABLED`                  | `false`               | `/debug/query` proxies read-only SQL queries. The "read-only" is a server-side promise, not a guard — leaks DB schema and a per-row enumeration. | DB schema + per-row data exfiltration over a single HTTP request.                                                                                                                       |
| `DEBUG_VOUCHER_ENABLED`              | `false`               | "NEVER enable in production" (per the description in `config.ts`).                                                                               | The debug voucher mints a single-use voucher secret that bypasses normal rate limiting and challenge flow — turning it on in prod means the invariant is broken.                        |
| `DEBUG_HEAPDUMP_COOLDOWN_SECONDS`    | `3600` (when enabled) | Default is one hour between heap snapshots. Lowering it is a DoS vector (each snapshot blocks the event loop for ~30s).                          | A `5`-second cooldown + 1000 req/min = the event loop is permanently blocked.                                                                                                           |
| `DOTNS_GATEWAY_ENABLED`              | `false`               | Off until the chain admin grants `dotnsGateway.attestationAllowance` to your attester public key. See § 9.                                       | If on without the on-chain allowance, every `reserve_name` extrinsic fails at the chain side.                                                                                           |
| `PROXY_DELEGATION_ENABLED`           | `false`               | Off until the proxy account is funded and the runtime has been smoke-tested with a single delegated `peopleLite.attest` call.                    | If on with no funded proxy, the chain rejects the extrinsic with `BadOrigin` (the proxy account is not a delegate of the attester).                                                     |
| `WEB_PUSH_ENABLED`                   | `false`               | Off until you've decided web push is part of the launch.                                                                                         | `VAPID` headers become required for the subscription routes; the public route stops working without a configured key.                                                                   |
| `REGISTRATION_QUEUE_ENABLED`         | `false`               | Off until the registration queue daemon has been observed completing a full cycle in staging.                                                    | Daemon spawns and starts accepting intakes, but no claim path exists yet.                                                                                                               |
| `PUSH_SUBSCRIPTIONS_INDEXER_ENABLED` | `false`               | Off until the push subscriptions indexer has been observed completing a full cycle in staging.                                                   | Daemon spawns; indexer reads stale data; web-push broadcasts fail.                                                                                                                      |
| `USERNAME_INDEXER_ENABLED`           | `false`               | Off until the username indexer has been observed completing a full cycle in staging.                                                             | Same as above for the username indexer.                                                                                                                                                 |

### 5.3 Tunables — must be at their secure default for production

These are not booleans. They have numeric or string values that the
app reads at request time. Each has a default that is correct for
production; changing the default widens a window or weakens a check.

| Var                                      | Default                                                               | Production value       | Why                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLAY_INTEGRITY_MODE`                    | `'strict'`                                                            | **`'strict'`**         | `relaxed_device` accepts real devices with weak verdicts; `relaxed_all` accepts sideloaded / debug APKs. **Never set relaxed in prod.**                                                                                                                                                         |
| `ANDROID_ATTESTATION_ROOT_PEMS`          | `GOOGLE_ROOT_CERTS` (the published Google hardware attestation roots) | **DO NOT override**    | Override to a test CA = every Android request passes regardless of hardware backing.                                                                                                                                                                                                            |
| `ANDROID_ATTESTATION_CRL_URL`            | `https://android.googleapis.com/attestation/status`                   | **DO NOT override**    | Override to a non-Google endpoint = revoked devices still pass.                                                                                                                                                                                                                                 |
| `ANDROID_ATTESTATION_TOKEN_TTL_SECONDS`  | `60`                                                                  | `60` (do not raise)    | The short-lived attestation token issued by `POST /api/v1/auth/android/attestation`. Raising the TTL widens the replay window.                                                                                                                                                                  |
| `CHALLENGE_TTL_SECONDS`                  | `300` (5 min)                                                         | `300`                  | Auth-challenge replay window. Raising = a stolen challenge is good for longer.                                                                                                                                                                                                                  |
| `JWT_TTL`                                | `15 minutes`                                                          | `15 minutes` (cap 24h) | Access-token TTL. ~15 min per RFC 9700 (sensitive tier; the backend is stateless with no revocation list, so the TTL is the revocation latency). Refresh is cheap and client-transparent (silent renewal, no re-attestation), so a short TTL costs little. Hard-capped at 24h by config decode. |
| `REFRESH_TOKEN_DURATION_DAYS`            | `30`                                                                  | `30` (do not raise)    | Refresh-token lifetime; sliding, bounded by single-use rotation + family reuse-detection. Dominates the credential blast radius (the access token is ~15 min).                                                                                                                                  |
| `REQUEST_SAMPLE_RATE`                    | `0.1`                                                                 | `0.1` (or higher)      | Sampling rate for request metrics. Lowering = blind spots in the dashboard.                                                                                                                                                                                                                     |
| `SENTRY_TRACE_SAMPLE_RATE`               | `0.1`                                                                 | `0.1` (or higher)      | Sentry trace sample rate. Lowering = errors miss traces.                                                                                                                                                                                                                                        |
| `PEOPLE_CHAIN_FINALIZATION_TIMEOUT`      | `70s`                                                                 | `70s`                  | A registration that doesn't finalize in 70s fails. Lowering = false-positive failures. Raising = registrations queue longer.                                                                                                                                                                    |
| `TX_INCLUSION_TIMEOUT`                   | `5s`                                                                  | `5s`                   | A registration that doesn't get included in 5s fails. Lowering = false-positive failures on slow chains.                                                                                                                                                                                        |
| `DOTNS_RESERVE_BATCH_SIZE`               | `50`                                                                  | `50`                   | The daemon-side batch size for `dotnsGateway.reserve_name`. Raising = the chain rejects oversized batches.                                                                                                                                                                                      |
| `DOTNS_INTAKE_FRESHNESS_MAX_AGE_SECONDS` | `120`                                                                 | `120`                  | Strict upper bound on candidate-signature age. Raising = stale signatures accepted at intake.                                                                                                                                                                                                   |
| `DOTNS_SIGNED_AT_SAFETY_MARGIN_SECONDS`  | `60`                                                                  | `60`                   | Daemon-side submit margin. **Must leave room for daemon pickup + chain inclusion + the freshness max-age**, or signatures are accepted at intake and silently dropped by the daemon. The startup invariant checks this against the on-chain `MaxValiditySeconds`.                               |

**Verify the running task's env against this matrix:**

```bash
STAGE=<stage>
TASK_ARN=$(aws ecs list-tasks --cluster identity-backend-$STAGE --desired-status RUNNING --query 'taskArns[0]' --output text)
aws ecs execute-command --cluster identity-backend-$STAGE --task $TASK_ARN --container app-identity --interactive --command "/bin/sh"
# Inside the task:
env | grep -E '^(AUTH_ENABLED|ENFORCE_AUTH|DEVICE_CHECK_IOS_ENABLED|JWT_AUTH_ENFORCED|POC_ENABLED|INVITATION_TICKET_DAEMON_ENABLED|INVITATION_TICKET_POOL_TARGET|INVITATION_TICKET_BATCH_SIZE|FINALIZED_BLOCK_DAEMON_ENABLED|APN_PRODUCTION|EXPOSE_BUILD_INFO|ADMIN_ROUTE_ENABLED|DEBUG_HEAPDUMP_ENABLED|DEBUG_SQL_ENABLED|DEBUG_VOUCHER_ENABLED|DOTNS_GATEWAY_ENABLED|PROXY_DELEGATION_ENABLED|WEB_PUSH_ENABLED|REGISTRATION_QUEUE_ENABLED|PUSH_SUBSCRIPTIONS_INDEXER_ENABLED|USERNAME_INDEXER_ENABLED|PLAY_INTEGRITY_MODE|ANDROID_ATTESTATION_ROOT_PEMS|ANDROID_ATTESTATION_CRL_URL|ANDROID_ATTESTATION_TOKEN_TTL_SECONDS|CHALLENGE_TTL_SECONDS|JWT_TTL|REFRESH_TOKEN_DURATION_DAYS|REQUEST_SAMPLE_RATE|SENTRY_TRACE_SAMPLE_RATE|PEOPLE_CHAIN_FINALIZATION_TIMEOUT|TX_INCLUSION_TIMEOUT|DOTNS_RESERVE_BATCH_SIZE|DOTNS_INTAKE_FRESHNESS_MAX_AGE_SECONDS|DOTNS_SIGNED_AT_SAFETY_MARGIN_SECONDS)='
```

Cross-check each value against the tables above. Any drift is a hard
promotion blocker. The appendix B check script automates this for
the booleans; tunables are the operator's responsibility.

---

## 6. Resource must-configures — what `sst diff` should show

`pnpm sst diff --stage <stage>` is the source of truth for "what
resources exist." The following items are the **non-negotiable
shape** of a production stage.

### 6.1 RDS Postgres (`sst.aws.Postgres`)

| Property                                                     | Production value                                                                                          | Where to verify                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `backupRetentionPeriod`                                      | `30` (prod) / `7` (non-prod)                                                                              | `sst.config.ts#transform.instance`                                               |
| `deletionProtection`                                         | `true` (prod) / `false` (non-prod)                                                                        | same                                                                             |
| `performanceInsightsEnabled`                                 | `true`                                                                                                    | same                                                                             |
| `monitoringInterval`                                         | `60` (seconds)                                                                                            | same                                                                             |
| `monitoringRoleArn`                                          | the IAM role with `monitoring.rds.amazonaws.com` trust + `AmazonRDSEnhancedMonitoringRole` managed policy | same; see `first-time-setup.md` stuck point #40 for the 3-cause diagnostic       |
| `dependsOn` includes the monitoring role                     | yes (IAM eventual-consistency guard)                                                                      | same                                                                             |
| RDS Proxy enabled                                            | yes (`proxy: true`)                                                                                       | `sst.config.ts`                                                                  |
| `deletionProtection` actually set on the underlying instance | yes                                                                                                       | `aws rds describe-db-instances --db-instance-identifier identity-backend-$STAGE` |
| `StorageEncrypted`                                           | true (SST default)                                                                                        | same                                                                             |

If `monitoringInterval=60` is set without the role, the create fails
with `InvalidParameterCombination: A MonitoringRoleARN value is
required...`. If the role is set with the wrong trust principal
(`rds.amazonaws.com` instead of `monitoring.rds.amazonaws.com`), the
create fails with `InvalidParameterValue: IAM role ARN value is
invalid`. See `first-time-setup.md` stuck point #40 for both.

### 6.2 ALB

| Property                  | Value                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listener                  | `443/https → 8080/http` (the service's `loadBalancer.rules` in `infra/service.ts`)                                                                            |
| Target group health check | `GET /readyz`, 200, 30s interval, 3 healthy / 3 unhealthy thresholds                                                                                          |
| Container health check    | `CMD-SHELL curl -f http://localhost:8080/readyz \|\| exit 1`, 30s interval, 60s startPeriod                                                                   |
| Access logs               | S3 bucket, prefix `alb-logs/`, AES256, ELB service principal granted `s3:PutObject` + `s3:GetBucketAcl`                                                       |
| Stickiness                | `lb_cookie`, 3600s duration (for WebSocket continuity)                                                                                                        |
| Circuit breaker           | `deploymentCircuitBreaker: { enable: true, rollback: true }` — **must be on** for the `forced rollback` to fire when a bad deploy flips all targets unhealthy |
| Architecture              | `arm64`                                                                                                                                                       |
| Scaling                   | `min: 1, max: 10`, `cpuUtilization: 70`, `memoryUtilization: 80`                                                                                              |

If the access logs bucket is missing, the ALB refuses to enable access
logs at the create step. If the circuit breaker is off, a bad deploy
flips all targets unhealthy and stays broken — the rollback only
fires when the breaker is on.

### 6.3 LGTM (Grafana)

| Property               | Value                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Architecture           | `arm64`                                                                                                                                                                                                                                                      |
| CPU / memory           | `1 vCPU` / `2 GB`                                                                                                                                                                                                                                            |
| Scaling                | `min: 1, max: 3`, `cpuUtilization: 80`                                                                                                                                                                                                                       |
| Load balancer          | **internal** (`public: false`) — the LGTM UI is VPC-only                                                                                                                                                                                                     |
| Listener ports         | `3000/http` (Grafana UI), `4318/http` (OTLP HTTP)                                                                                                                                                                                                            |
| Target health check    | `GET /api/health`, 200, 30s interval, 2 healthy / 3 unhealthy                                                                                                                                                                                                |
| Container health check | `CMD-SHELL curl -fsS http://localhost:3000/api/health \|\| exit 1`                                                                                                                                                                                           |
| EFS volume             | mounted at `/data`, persists across restarts                                                                                                                                                                                                                 |
| Image                  | `FROM grafana/otel-lgtm:<pinned>` with `COPY`-baked provisioning from `infra/observability/grafana/`                                                                                                                                                         |
| Contact points         | rendered from `infra/observability/grafana/alerting/contact-points.template.yaml` via `pnpm observability:render-contact-points`. The renderer fails loud if the `GrafanaWebhookUrl` secret survives substitution as a `__GRAFANA_WEBHOOK_URL__` placeholder |

**The contact-points render step is the most-skipped pre-deploy step
in this stack.** It runs in the operator's shell on the operator's
laptop, before `pnpm sst deploy`. The rendered file is `COPY`-d into
the LGTM image at build time. If you skip it, alerts fire to a
literal `__GRAFANA_WEBHOOK_URL__` and the on-call never sees them.

### 6.4 VPC

| Property                        | Value                                                           |
| ------------------------------- | --------------------------------------------------------------- |
| AZ count                        | `3` (prod) / `2` (non-prod)                                     |
| NAT                             | `ec2` (fck-nat), one per AZ for HA                              |
| PrivateLink interface endpoints | Secrets Manager, SSM, SSM Messages — **all three**              |
| S3 gateway endpoint             | yes (free, saves $0.045/GB on ECR pulls and S3 access)          |
| Default tags                    | `Project: identity-backend`, `Stage: <stage>`, `ManagedBy: sst` |
| Per-resource `Name` tag         | yes (via `transform` hooks)                                     |

The four endpoints (3 interface + 1 gateway) are non-negotiable.
Without the Secrets Manager endpoint, the Fargate task's secret
resolution costs $0.045/GB through NAT — at scale that's the bulk of
the egress bill. Without the SSM endpoint, ECS Exec (interactive
shell into a running task) doesn't work.

### 6.5 Cloudflare (production path only)

| Property                 | Value                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zone ID                  | set in `.env` as `CLOUDFLARE_ZONE_ID`                                                                                                                                     |
| Hostname                 | set in `.env` as `API_HOSTNAME`                                                                                                                                           |
| DNS record               | `cloudflare.DnsRecord` creates a `proxied: true` CNAME pointing `API_HOSTNAME` → ALB DNS                                                                                  |
| Rate-limit ruleset       | `http_ratelimit` phase, plan-quota-counted, `assertPlanQuotaFits` verifies at deploy time                                                                                 |
| Custom firewall ruleset  | `http_request_firewall_custom` phase: `block_internal_only_paths`, `block_internal_only_prefixes`, `block_scripted_user_agents`                                           |
| Managed WAF ruleset      | `http_request_firewall_managed` phase: OWASP ModSecurity CRS + Cloudflare Specials (the `cerberus_ai.ruleset_scanner_detection` rule is disabled — that one is too noisy) |
| AuthenticatedOriginPulls | `enabled: true` — the ALB only trusts the Cloudflare-issued client cert                                                                                                   |
| Per-plan rule count      | `free: 1 rate-limit / 5 firewall`, `pro: 2 / 20`, `business: 5 / 100` — your `CLOUDFLARE_PLAN` env must match what you pay Cloudflare for                                 |

If `CLOUDFLARE_ZONE_ID` and `API_HOSTNAME` are unset, the entire edge
block is skipped — the deploy runs without WAF, without rate limit,
without AOP, without the custom CNAME. The ALB is reachable on its
public DNS. The personal/Auto-URL path is the only legitimate reason
to skip Cloudflare.

---

## 7. JWT and challenge surface — window sizes that compound

The challenge flow, the JWT TTL, and the refresh-token TTL form a
single authentication-replay window. The defaults are correct for
production. **Do not raise any of them without a security review.**

| Var                                     | Default       | Window it opens                                | What you lose by raising                                           |
| --------------------------------------- | ------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| `CHALLENGE_TTL_SECONDS`                 | `300` (5 min) | A challenge is replayable for 5 min            | A stolen challenge is good for 5 × longer per stolen item          |
| `JWT_TTL`                               | `15 minutes`  | An access token is valid for 15 minutes        | A leaked access token expires in 15 minutes                        |
| `REFRESH_TOKEN_DURATION_DAYS`           | `30`          | A refresh token mints JWTs for 30 days         | A leaked refresh token is good for 30 × longer                     |
| `ANDROID_ATTESTATION_TOKEN_TTL_SECONDS` | `60`          | The Android attestation token is valid for 60s | A stolen attestation token is good for 60 × longer per stolen item |

**The refresh-token lifetime (`REFRESH_TOKEN_DURATION_DAYS`, default 30 d) dominates the
blast radius** — it is sliding (rotation resets the window) and bounded in practice by
single-use rotation + family reuse-detection, which convert a stolen token into a detectable,
revocable event. The access token (`JWT_TTL`, ~15 min) and the challenge (`CHALLENGE_TTL_SECONDS`,
5 min) are short by comparison. Raising `REFRESH_TOKEN_DURATION_DAYS` to 90 triples the idle window.

The non-replay guarantee on the challenge is **deliberately not
enforced** (the challenges table is retained but unused — see
`apps/identity-backend/AGENTS.md` "Challenge is stateless and
self-authenticating"). The trade was "no per-request DB INSERT"
(issue #2731) in exchange for "valid token is replayable until it
expires." This is by design and is the deliberate non-goal. The TTL
is the bound; do not loosen it.

---

## 8. On-chain state — the chain admin is not you

The deploy operator is **not** the `EnsureRoot<AccountId>` origin on
People chain or Asset Hub. The chain admin is sudo on dev, OpenGov on
mainnet, or a designated operational key in a staging network. The
backend publishes the attester public key at `GET /api/v1/attester`
so the chain admin knows what to grant. You MUST have the chain
admin confirm both allowances before promoting a stage.

### 8.1 People chain: `peopleLite.increase_attestation_allowance`

Extrinsic call index 0 in the `peopleLite` pallet. Origin:
`AttestationAllowanceManager` → `EnsureRoot<AccountId>`. The backend
needs a non-zero allowance to call `attest` (call index 2, `Signed`
origin). Without the allowance, every registration will fail at the
chain-side with a `BadOrigin`-flavored error and the daemon's failure
counter climbs.

```text
peopleLite.increase_attestation_allowance(
    attester: <ATTESTER_PUBLIC_KEY decoded to AccountId32>,
    additional: 1000,
)
```

Verify on the chain side via Polkadot.js Apps → Chain state →
`peopleLite` → `attestationAllowance(<ATTESTER_PUBLIC_KEY decoded>)`
should be a non-zero `u32`.

### 8.2 Asset Hub: `dotnsGateway.increase_attestation_allowance`

Extrinsic call index 2 in the `dotnsGateway` pallet. Origin:
`AttestationAllowanceManager` → `EnsureRoot<AccountId>`. Independent
allowance from the People chain one. Required only when
`DOTNS_GATEWAY_ENABLED=true` (see § 5.2).

```text
dotnsGateway.increase_attestation_allowance(
    attester: <ATTESTER_PUBLIC_KEY decoded to AccountId32>,
    additional: 1000,
)
```

Verify via Polkadot.js Apps → Chain state → `dotnsGateway` →
`attestationAllowance(...)` on Asset Hub.

### 8.3 On-chain accounts that must be funded

| Account                                                                                  | Network      | Required balance              | Why                                                                                                            |
| ---------------------------------------------------------------------------------------- | ------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| The proxy account (the public key behind `PROXY_PRIVATE_KEY`)                            | People chain | existential deposit + tx fees | submits every username registration                                                                            |
| The attester proxy account (the public key behind `ATTESTER_PROXY_PRIVATE_KEY`)          | People chain | existential deposit + tx fees | only when `PROXY_DELEGATION_ENABLED=true`                                                                      |
| The dedicated invitation-pool account (the public key behind `INVITER_POOL_PRIVATE_KEY`) | People chain | existential deposit + tx fees | fund the dedicated invitation-pool account to avoid contending with username registration on the shared signer |
| The attester public key's account                                                        | Asset Hub    | existential deposit + tx fees | the account that calls `dotnsGateway.reserve_name`                                                             |

See [`polkadot-attester-onchain.md`](./polkadot-attester-onchain.md)
for the per-network faucet URLs (paseo, westend2) and the funding
amounts the chain admin should set.

---

## 9. Observability — verify the dashboard is alive

The LGTM service is internal (no public IP). Reach it via SSH tunnel,
AWS VPN, or VPC peering. Once you have a URL:

| Check                                                                                              | Expected                                                                                                                                                                                                                                        | Why                                                                                                     |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET /api/health` on the LGTM URL                                                                  | `200 OK` with a JSON `{"database":"ok"}` body                                                                                                                                                                                                   | Grafana has its DB up. Without this, the dashboards don't load.                                         |
| Open a dashboard (e.g. `identity-backend.json` — RED)                                              | renders with data, not "no data"                                                                                                                                                                                                                | confirms the OTel pipeline from the app → LGTM is wired                                                 |
| The "RED" dashboard panels for the deployed service                                                | non-zero request count over the last 5 minutes                                                                                                                                                                                                  | confirms `OTEL_EXPORTER_OTLP_ENDPOINT` points at the LGTM service and the service is exporting          |
| Each alert rule in `infra/observability/grafana/alerting/rules.yaml` is present in the alerting UI | yes (8 rules: `registration_p95_sla_breach`, `registrations_fully_stopped`, `registration_failure_storm`, `http_5xx_ratio_high`, `registration_queue_saturated`, `registration_daemon_heartbeat_lost`, `chain_stalled`, `rate_limit_429_surge`) | confirms the rule YAML was rendered into the image                                                      |
| The contact point fires a test alert                                                               | you receive a webhook delivery to the URL you set in `GrafanaWebhookUrl`                                                                                                                                                                        | confirms the contact points rendered correctly and the webhook URL is reachable from the LGTM container |
| The `Project/Stage` tag from the Fargate task's resource                                           | visible in the dashboard's `service` filter                                                                                                                                                                                                     | confirms the tags are propagated to the OTel resource                                                   |

**Do not promote if any of the above fails.** A stage that
"deploys green but ships without observability" is a stage you cannot
on-call.

---

## 10. Identity and credentials — the production hardening layer

These are not in `config.ts` or `sst.config.ts`; they live in the
Apple / Google / Polkadot ecosystems. Production promotion is the
moment to verify you are not in the test / sandbox tier of any of
these.

| Item                              | Production value                                                                                                                                                                                                         | Where to verify                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Apple Developer Program           | Organization, not Individual                                                                                                                                                                                             | developer.apple.com → Membership                             |
| App Attest                        | Enabled on the App ID (not just the capability checkbox — the App ID must have it added)                                                                                                                                 | developer.apple.com → Identifiers → App ID                   |
| APNs key                          | Production key (not the sandbox/dev key)                                                                                                                                                                                 | developer.apple.com → Keys                                   |
| APN bundle IDs in `APN_TOPICS`    | exactly the bundle IDs shipped to the App Store                                                                                                                                                                          | your App Store Connect listing                               |
| Google service account            | has both `roles/firebasecloudmessaging.admin` (for FCM) and the project's Editor role (or a tighter `roles/playintegrity.admin` if you have it) — Play Integrity mints its own OAuth token from the same service account | Google Cloud Console → IAM                                   |
| Google service account JSON       | downloaded once at setup, re-base64'd into the SST secret                                                                                                                                                                | `infra/docs/secrets-procurement.md`                          |
| Polkadot attester sr25519 keypair | generated via the repo's `apps/identity-backend/scripts/private-key.ts`, **not** via `subkey generate` (which yields a 32-byte seed, not the 64-byte expanded key the app needs)                                         | [`polkadot-attester-setup.md`](./polkadot-attester-setup.md) |
| Polkadot attester public key      | matches the on-chain allowance (§ 8)                                                                                                                                                                                     | `GET /api/v1/attester` on the deployed stage                 |
| Cloudflare plan                   | matches `CLOUDFLARE_PLAN` env (a Business plan is required if you set `CLOUDFLARE_PLAN=business` — the deploy checks the rule count, not the plan tier)                                                                  | Cloudflare dashboard → Plan                                  |

---

## 11. Verifications — the post-deploy gate

After the deploy completes, every box below MUST be true. The script
in [Appendix B](#appendix-b--check-script) asks each question of the
live stage in turn.

- [ ] **All 8 attestation layers in § 1 are on or, for client-only ones, on and matching the deployed client build** (§ 1)
- [ ] **All 12 SST secrets set with real values, not placeholders** (§ 2)
- [ ] **All required `.env` config keys set with real values** (§ 3)
- [ ] **`RATE_LIMIT_PROFILE` and `CLOUDFLARE_PLAN` agree and match the operator's intent** (§ 4)
- [ ] **All must-on flags are on, all must-off flags are off, all tunables at their secure default** (§ 5)
- [ ] **`sst diff` shows the resource shape in § 6, no drift** (§ 6)
- [ ] **JWT/challenge windows are at their secure defaults** (§ 7)
- [ ] **Both on-chain allowances granted (People + Asset Hub if applicable) and verified on the chain** (§ 8)
- [ ] **LGTM dashboard renders, every alert rule is present, the contact-point webhook fires** (§ 9)
- [ ] **Apple / Google / Polkadot credentials are production-tier, not sandbox** (§ 10)
- [ ] **The `/healthcheck` (or `/readyz`) endpoint on the deployed API responds 200** — first smoke
- [ ] **An end-to-end registration completes in a non-truncated time** — pull a real device, run the testflight/Play internal build, complete a registration, watch it on-chain
- [ ] **All 8 alert rules in `infra/observability/grafana/alerting/rules.yaml` evaluate to `OK` for 5 minutes** — visit the Grafana UI, open the alert list, check state

If **any** box is unchecked or unchecked-but-known-OK, the promotion is
rejected. The next session picks up from the failing item.

---

## 12. Rollback plan

Production promotion is reversible. The three primary rollback
levers:

1. **Application rollback** — `aws ecs update-service --cluster identity-backend-<stage> --service identity-backend --task-definition identity-backend:<previous-revision>`. SST keeps the prior N task definitions; check `aws ecs list-task-definitions --family identity-backend --sort DESC` for the list.
2. **Database rollback** — `aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier identity-backend-<stage> --target-db-instance-identifier identity-backend-<stage>-rollback --restore-time <UTC>`. Backup retention is 30 days for prod. **The restore creates a new instance;** the app's `DATABASE_URL` is wired to the new instance via `sst deploy`.
3. **Edge rollback** — `cloudflare.Ruleset` resources are versioned. `pnpm sst diff` shows the diff against the live state; a `sst deploy` reverts to whatever the code declares.

Document the rollback plan in the release announcement **before** the
promotion. The on-call person reading the announcement at 3 AM should
not have to reverse-engineer the rollback from the source.

---

## Appendix A — Quick reference: every flag and its default

| Flag                                    |       Default       |       Production       | Reason                                                                             |
| --------------------------------------- | :-----------------: | :--------------------: | ---------------------------------------------------------------------------------- |
| `AUTH_ENABLED`                          |        false        |        **true**        | accept only authenticated requests                                                 |
| `ENFORCE_AUTH`                          |        false        |        **true**        | App Attest on every iOS request                                                    |
| `DEVICE_CHECK_IOS_ENABLED`              |        false        |        **true**        | DeviceCheck on iOS                                                                 |
| `JWT_AUTH_ENFORCED`                     |        false        |        **true**        | JWT required on dim/invitation/notify/turn/usernames                               |
| `POC_ENABLED`                           |        false        | **true on shared-nat** | defends public reads against CGNAT                                                 |
| `APN_PRODUCTION`                        |        false        |        **true**        | APNs production endpoint                                                           |
| `EXPOSE_BUILD_INFO`                     |        false        |          true          | on-call can read `/api/v1/version`                                                 |
| `INVITATION_TICKET_DAEMON_ENABLED`      |        true         |          true          | daemon                                                                             |
| `INVITATION_TICKET_POOL_TARGET`         |        10000        |        per-env         | pool refill target; requires a dedicated pool account (`INVITER_POOL_PRIVATE_KEY`) |
| `INVITATION_TICKET_BATCH_SIZE`          |         100         |        per-env         | tickets per batch; the dynamic policy shrinks it on resource exhaustion            |
| `FINALIZED_BLOCK_DAEMON_ENABLED`        |        true         |          true          | daemon                                                                             |
| `ADMIN_ROUTE_ENABLED`                   |        false        |       **false**        | never on in prod                                                                   |
| `DEBUG_HEAPDUMP_ENABLED`                |        false        |       **false**        | "NEVER enable in production" (config.ts)                                           |
| `DEBUG_SQL_ENABLED`                     |        false        |       **false**        | leaks DB                                                                           |
| `DEBUG_VOUCHER_ENABLED`                 |        false        |       **false**        | "NEVER enable in production" (config.ts)                                           |
| `DOTNS_GATEWAY_ENABLED`                 |        false        |        per-env         | requires on-chain allowance grant                                                  |
| `PROXY_DELEGATION_ENABLED`              |        false        |        per-env         | requires funded proxy + smoke test                                                 |
| `WEB_PUSH_ENABLED`                      |        false        |        per-env         | requires VAPID keypair + subject                                                   |
| `REGISTRATION_QUEUE_ENABLED`            |        false        |        per-env         | requires daemon to be observed in staging                                          |
| `PUSH_SUBSCRIPTIONS_INDEXER_ENABLED`    |        false        |        per-env         | requires daemon to be observed in staging                                          |
| `USERNAME_INDEXER_ENABLED`              |        false        |        per-env         | requires daemon to be observed in staging                                          |
| `PLAY_INTEGRITY_MODE`                   |     `'strict'`      |       `'strict'`       | relaxed modes accept sideloaded / debug APKs                                       |
| `ANDROID_ATTESTATION_ROOT_PEMS`         | `GOOGLE_ROOT_CERTS` |  **DO NOT override**   | test CA = every Android request passes                                             |
| `ANDROID_ATTESTATION_CRL_URL`           |     Google URL      |  **DO NOT override**   | non-Google = revoked devices still pass                                            |
| `ANDROID_ATTESTATION_TOKEN_TTL_SECONDS` |         60          |           60           | short-lived token; do not raise                                                    |
| `CHALLENGE_TTL_SECONDS`                 |         300         |          300           | challenge replay window; do not raise                                              |
| `JWT_TTL`                               |    `15 minutes`     |      `15 minutes`      | access-token TTL; hard-capped at 24h by config decode                              |
| `REFRESH_TOKEN_DURATION_DAYS`           |         30          |           30           | refresh-token TTL; do not raise                                                    |

---

## Appendix B — check script

Save as `scripts/check-production-readiness.sh` (or run inline). The
script assumes `aws`, `jq`, and the SST CLI are on `PATH`. Pass the
stage name as the first argument.

```bash
#!/usr/bin/env bash
set -euo pipefail

STAGE="${1:?usage: $0 <stage>}"
REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
fail=0
warn=0

ok()   { printf '  \033[1;32mOK  \033[0m %s\n' "$*"; }
no()   { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$((fail+1)); }
soft() { printf '  \033[1;33mWARN\033[0m %s\n' "$*"; warn=$((warn+1)); }

heading() { printf '\n\033[1;34m== %s ==\033[0m\n' "$*"; }

heading "1. SST secrets"
for s in JWT_AUTH_SECRET PROXY_PRIVATE_KEY ATTESTER_PROXY_PRIVATE_KEY \
         WEB_PUSH_VAPID_PRIVATE_KEY DEVICE_CHECK_PRIVATE_KEY APN_PRIVATE_KEY \
         TURN_SECRET GOOGLE_CREDENTIALS GrafanaWebhookUrl; do
  val=$(aws secretsmanager get-secret-value \
           --secret-id "identity-backend/$STAGE/$s" \
           --query SecretString --output text 2>/dev/null || echo "")
  case "$val" in
    "")                            no "$s not set";;
    dev-placeholder*|0x0000000000000000000000000000000000000000000000000000000000000000|https://hooks.example.invalid/*)
                                    no "$s is a placeholder";;
    *)                             ok "$s";;
  esac
done

heading "2. .env required keys"
for k in ATTESTER_PUBLIC_KEY ANDROID_PACKAGE_NAMES \
         ANDROID_SIGNING_DIGEST_PLAYSTORE ANDROID_SIGNING_DIGEST_WEBSITE \
         APPLE_TEAM_ID DEVICE_CHECK_KEY_ID APN_KEY_ID; do
  v=$(grep "^$k=" .env | cut -d= -f2- || echo "")
  case "$v" in
    ""|*"<"*|0x0*) no ".env $k missing or placeholder";;
    *)            ok ".env $k";;
  esac
done

heading "3. Two-knob invariants"
rlp=$(aws ssm get-parameter --name "/sst/$STAGE/config/RATE_LIMIT_PROFILE" --query Parameter.Value --output text 2>/dev/null || echo unset)
cfp=$(aws ssm get-parameter --name "/sst/$STAGE/config/CLOUDFLARE_PLAN" --query Parameter.Value --output text 2>/dev/null || echo unset)
echo "  RATE_LIMIT_PROFILE=$rlp  CLOUDFLARE_PLAN=$cfp"
case "$rlp:$cfp" in
  shared-nat:pro|shared-nat:business|global:pro|global:business) ok "knob pair is valid";;
  *)                                                            no "knob pair not in (shared-nat|global) × (pro|business)";;
esac

heading "4. Attestation layers (live task env)"
TASK_ARN=$(aws ecs list-tasks --cluster "identity-backend-$STAGE" --desired-status RUNNING --query 'taskArns[0]' --output text 2>/dev/null || echo "")
if [[ -z "$TASK_ARN" || "$TASK_ARN" == "None" ]]; then
  no "no running task in cluster identity-backend-$STAGE"
else
  task_env=$(aws ecs describe-tasks --cluster "identity-backend-$STAGE" \
               --tasks "$TASK_ARN" \
               --query 'tasks[0].containers[0].overrides[0].environment[]' 2>/dev/null \
             | jq -r '.[] | "\(.name)=\(.value)"')

  for f in AUTH_ENABLED ENFORCE_AUTH DEVICE_CHECK_IOS_ENABLED JWT_AUTH_ENFORCED \
           INVITATION_TICKET_DAEMON_ENABLED FINALIZED_BLOCK_DAEMON_ENABLED \
           APN_PRODUCTION EXPOSE_BUILD_INFO; do
    val=$(echo "$task_env" | grep "^$f=" | cut -d= -f2-)
    case "$val" in
      true)  ok "$f=$val (must be on)";;
      false) no "$f=$val (must be true for production)";;
      *)     soft "$f not in task env (uses default $val)";;
    esac
  done

  # PoC: must be on when RATE_LIMIT_PROFILE=shared-nat
  poc_val=$(echo "$task_env" | grep "^POC_ENABLED=" | cut -d= -f2-)
  case "$rlp:$poc_val" in
    shared-nat:true) ok "POC_ENABLED=true (required under shared-nat)";;
    shared-nat:false) no "POC_ENABLED=false under shared-nat (public reads unprotected)";;
    global:*)        ok "POC_ENABLED under global profile (PoC optional)";;
    *)               soft "POC_ENABLED status ambiguous; verify manually";;
  esac

  for f in ADMIN_ROUTE_ENABLED DEBUG_HEAPDUMP_ENABLED DEBUG_SQL_ENABLED \
           DEBUG_VOUCHER_ENABLED; do
    val=$(echo "$task_env" | grep "^$f=" | cut -d= -f2-)
    case "$val" in
      false) ok "$f=$val (must be off)";;
      true)  no "$f=$val (must be false for production)";;
      *)     soft "$f not in task env";;
    esac
  done

  # Play Integrity mode
  pim=$(echo "$task_env" | grep "^PLAY_INTEGRITY_MODE=" | cut -d= -f2-)
  case "$pim" in
    strict)         ok "PLAY_INTEGRITY_MODE=strict";;
    relaxed_device) no "PLAY_INTEGRITY_MODE=relaxed_device (prod must be strict)";;
    relaxed_all)    no "PLAY_INTEGRITY_MODE=relaxed_all (prod must be strict)";;
    *)              soft "PLAY_INTEGRITY_MODE=$pim";;
  esac

  # Tunables: check at secure default
  for v in CHALLENGE_TTL_SECONDS:300 REFRESH_TOKEN_DURATION_DAYS:30 \
           ANDROID_ATTESTATION_TOKEN_TTL_SECONDS:60 \
           DOTNS_INTAKE_FRESHNESS_MAX_AGE_SECONDS:120 DOTNS_SIGNED_AT_SAFETY_MARGIN_SECONDS:60; do
    name="${v%%:*}"; expected="${v##*:}"
    actual=$(echo "$task_env" | grep "^$name=" | cut -d= -f2-)
    if [[ -z "$actual" ]]; then
      soft "$name not in task env (uses default $expected)"
    elif [[ "$actual" != "$expected" ]]; then
      no "$name=$actual (production default is $expected; raising widens a window)"
    else
      ok "$name=$actual"
    fi
  done

  # Android attestation root PEMs and CRL URL — must be the defaults
  aar=$(echo "$task_env" | grep "^ANDROID_ATTESTATION_ROOT_PEMS=" | cut -d= -f2- | head -c 80)
  if [[ -z "$aar" ]]; then
    ok "ANDROID_ATTESTATION_ROOT_PEMS not set (uses Google hardware roots)"
  else
    no "ANDROID_ATTESTATION_ROOT_PEMS is overridden: $aar... (production must use Google roots)"
  fi
  acrl=$(echo "$task_env" | grep "^ANDROID_ATTESTATION_CRL_URL=" | cut -d= -f2-)
  case "$acrl" in
    "")                    ok "ANDROID_ATTESTATION_CRL_URL not set (uses Google default)";;
    https://android.googleapis.com/*) ok "ANDROID_ATTESTATION_CRL_URL=$acrl";;
    *)                     no "ANDROID_ATTESTATION_CRL_URL=$acrl (must be https://android.googleapis.com/*)";;
  esac
fi

heading "5. Resource shape"
# RDS monitoring role trust
role_trust=$(aws iam get-role --role-name "identity-backend-$STAGE-databaseMonitoringRole" \
               --query 'Role.AssumeRolePolicyDocument.Statement[0].Principal.Service' \
               --output text 2>/dev/null || echo "")
[[ "$role_trust" == "monitoring.rds.amazonaws.com" ]] \
  && ok "RDS monitoring role trust = monitoring.rds.amazonaws.com" \
  || no "RDS monitoring role trust = $role_trust (must be monitoring.rds.amazonaws.com)"

# RDS deletion protection (prod only)
deletion=$(aws rds describe-db-instances --db-instance-identifier "identity-backend-$STAGE" \
             --query 'DBInstances[0].DeletionProtection' --output text 2>/dev/null || echo "")
case "$STAGE:$deletion" in
  production:true) ok "RDS deletionProtection=true (prod)";;
  production:false) no "RDS deletionProtection=false (prod must be true)";;
  *:*) ok "RDS deletionProtection=$deletion (non-prod, OK)";;
esac

# ALB access logs
alb_logs=$(aws elbv2 describe-load-balancers --query "LoadBalancers[?contains(LoadBalancerName, \`identity-backend-$STAGE\`)].LoadBalancerArn" --output text 2>/dev/null | head -1)
if [[ -n "$alb_logs" ]]; then
  attrs=$(aws elbv2 describe-load-balancer-attributes --load-balancer-arn "$alb_logs" 2>/dev/null)
  if echo "$attrs" | jq -e '.Attributes[] | select(.Key=="access_logs.s3.enabled" and .Value=="true")' >/dev/null; then
    ok "ALB access logs enabled"
  else
    no "ALB access logs NOT enabled"
  fi
else
  soft "could not find ALB for stage $STAGE"
fi

heading "6. On-chain allowances (manual step; cannot be scripted here)"
echo "  Verify on the chain (Polkadot.js Apps) that:"
echo "    People chain: peopleLite.attestationAllowance(<attester>) > 0"
echo "    Asset Hub (if DOTNS_GATEWAY_ENABLED): dotnsGateway.attestationAllowance(<attester>) > 0"
echo "  This step requires the chain admin's signature; the operator cannot"
echo "  run it. The block above is a reminder; flag if you skipped it."

heading "7. LGTM health"
LGTM_URL=$(pnpm sst output --stage "$STAGE" Grafan* 2>/dev/null | head -1 || echo "")
if [[ -n "$LGTM_URL" ]]; then
  code=$(curl -fsS -o /dev/null -w '%{http_code}' "$LGTM_URL/api/health" 2>/dev/null || echo "")
  [[ "$code" == "200" ]] && ok "LGTM /api/health = 200" || no "LGTM /api/health = $code"
else
  soft "could not resolve LGTM URL — verify manually via tunnel/VPN"
fi

heading "Result"
echo "  $fail hard failures, $warn warnings"
[[ "$fail" -eq 0 ]] || exit 1
```

Run the script with the stage name. A non-zero exit means promotion is
rejected.

```bash
chmod +x scripts/check-production-readiness.sh
./scripts/check-production-readiness.sh production
# 1 hard failures, 0 warnings
# exit 1 → fix and re-run
```

---

## See also

- [`first-time-setup.md`](./first-time-setup.md) — first-time operator walkthrough (Steps 1–11, 42 stuck points). **Read before this document** on a stage that has never been deployed.
- [`secrets-procurement.md`](./secrets-procurement.md) — the procurement / format / gotcha for every secret in § 2.
- [`sst-deploy.md`](./sst-deploy.md) — SST v3 reference for the deploy mechanics.
- [`aws-fargate-rds.md`](./aws-fargate-rds.md) — the Fargate / RDS / Secrets Manager troubleshooting.
- [`edge-cloudflare.md`](./edge-cloudflare.md) — the Cloudflare WAF / rate-limit / AOP troubleshooting, plus the per-plan rule quotas.
- [`observability-lgtm.md`](./observability-lgtm.md) — the LGTM / Grafana reference (the file-provisioning rules, the OTel→Prom rename table, the contact-points render flow).
- [`runbook-failure-modes.md`](./runbook-failure-modes.md) — FM-1 through FM-7 for the post-deploy failure modes.
- [`polkadot-attester-onchain.md`](./polkadot-attester-onchain.md) — the on-chain allowance grant walkthrough (§ 8 references this).
