# Infrastructure

> SST v3 deployment for `identity-backend`: AWS Fargate, RDS Postgres, Cloudflare edge, OTel-LGTM observability. The single source of truth for production deploy.
>
> **New operator? Read [`infra/docs/first-time-setup.md`](./docs/first-time-setup.md) first.** It walks you from "I have an AWS account" to "the API responds 200" with 39 stuck points called out before you hit them.

## What gets deployed

```
Client → Cloudflare (DNS, rate-limit, firewall) → ALB → ECS/Fargate → RDS Postgres
                                                                  ↓
                                                          OTLP → LGTM (Grafana)
```

| Module                | File                     | What it provisions                                                                                                                           |
| :-------------------- | :----------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| **Backend**           | `infra/service.ts`       | ECS/Fargate service (arm64), ALB with health checks, IAM task policy, ALB access logs, circuit breaker                                       |
| **Database**          | `sst.config.ts`          | RDS Postgres 17 with RDS Proxy, 30-day backup retention (prod), deletion protection (prod), enhanced monitoring                              |
| **VPC**               | `sst.config.ts`          | Stage-aware VPC (3 AZ prod / 2 non-prod), fck-nat instances, PrivateLink endpoints (Secrets Manager, SSM, SSM Messages), S3 gateway endpoint |
| **Observability**     | `infra/observability.ts` | `grafana/otel-lgtm` on Fargate with EFS, internal LB, auto-scaling 1–3                                                                       |
| **Edge**              | `infra/edge.ts`          | Cloudflare rate-limiting (plan-aware), user-agent firewall, OWASP managed WAF, Authenticated Origin Pulls                                    |
| **Secrets**           | `infra/secrets.ts`       | Lists of `sst.Secret` names injected into the container environment                                                                          |
| **Deployment config** | `sst.config.ts`          | Non-secret per-stage values resolved from `process.env` / `.env` and spread into the container environment                                   |
| **VPC endpoints**     | `infra/vpc-endpoints.ts` | Three PrivateLink interface endpoints (Secrets Manager, SSM, SSM Messages) + free S3 gateway endpoint                                        |

## Prerequisites

- **AWS account** with an IAM principal that can run `pnpm sst deploy`. **PowerUserAccess** + 3 inline actions (see `first-time-setup.md` step 1) is the practical baseline; pure least-privilege is ~80 lines of JSON and brittle across SST releases.
- **Cloudflare account** with a domain added and a custom API token (Zone → DNS / WAF / Settings / SSL Edit). Plan: **Pro** for the default `RATE_LIMIT_PROFILE=shared-nat`; **Business** if you need per-class rate limiting with `cf.unique_visitor_id`. — **OPTIONAL.** Skip this entire account if you pick the **Auto-URL** path (raw ALB DNS, no edge). See `first-time-setup.md` step 7.0 for the decision matrix.
- **Apple Developer Program** account (Organization enrollment takes 1–2 business days — start it the day before).
- **Google Cloud** account (just to mint a service-account JSON; **no Google Cloud project is part of the deploy**).
- **Polkadot** People chain account with a funded attester sr25519 keypair.
- Local toolchain: `pnpm`, Node.js 24+, **Bun** (for the SST `install` postinstall hook), **Docker daemon running** (SST builds the image locally and pushes to ECR).

## Chain-state prerequisites (Polkadot People / AssetHub)

The on-chain state this repo depends on — funded attester accounts, `AttestationAllowance` grants on **both** People and AssetHub, sudo proxy delegation, DotNS gateway dispatcher address, attestation invite pool, etc. — is **not provisioned by this repo's deploy.** It is owned by the **public** `paritytech/individuality-community` repo's bootstrap scripts, which live at `paritytech/individuality-community/tree/main/scripts/initial-setup/`.

Read that README first if you are bringing up a fresh People / AssetHub pair. The two scripts this repo's deploy assumes are already executed:

- **`12b-setup-attestation-allowances.sh`** — grants `peopleLite.AttestationAllowance` on the People chain AND `dotnsGateway.AttestationAllowance` on AssetHub to the attester account. **Both grants are required**; each chain's allowance table is independent. See [`polkadot-attester-onchain.md`](./docs/polkadot-attester-onchain.md) § "The attester must have BOTH allowances" and stuck point #31 in [`first-time-setup.md`](./docs/first-time-setup.md) for the per-chain WSS list.
- **`12c-setup-attestation-proxy.sh`** — adds the proxy delegation the backend uses to dispatch attestation calls through the attester account.

If the community bootstrap is not yet run for your network, stop here and run it. The SST deploy will succeed regardless and the API will respond 200, but every `peopleLite.attest` call will return `NoAttestationAllowance` (People) or `NoAttestationAllowance` (AssetHub) and the username registration queue will be permanently silent.

The other scripts in `00-requirements.sh` → `13-setup-dotns-dispatcher-address.sh` configure the rest of the People / AssetHub / Bulletin / Relay state (XTRNL, USDT/USDC, PGAS, people collection, etc.). This repo's backend does not call any of those pallets at runtime, but the chain admin's standard bring-up sequence runs the full set; do not skip the earlier scripts and then run 12b/12c.

## Quick Start

The deploy supports two URL strategies. **Pick one before you set any secrets** — the choice changes which secrets and env vars you populate. Full decision matrix in [`docs/first-time-setup.md` § 7.0](./docs/first-time-setup.md#70--choose-your-url-strategy-do-this-before-you-set-secrets).

| Strategy                         | URL                                                                  | Best for                      | What you skip                                                             |
| :------------------------------- | :------------------------------------------------------------------- | :---------------------------- | :------------------------------------------------------------------------ |
| **Cloudflare** (production path) | `https://api.example.com` (your domain)                              | user-facing / production-ish  | nothing — full edge                                                       |
| **Auto-URL** (dev / personal)    | `https://identity-backend-<stage>-<hash>.<region>.elb.amazonaws.com` | personal/dev/ephemeral stages | the entire Cloudflare account + zone + API token + nameserver propagation |

### Path A — Cloudflare (production path)

```sh
# 0. One-time: install deps (downloads the Pulumi Go binary via sst install)
corepack enable
pnpm install

# 1. One-time: render the contact points file from the webhook secret
pnpm sst secret set GrafanaWebhookUrl https://hooks.your-internal/alerts
pnpm observability:render-contact-points   # bakes the URL into the LGTM image

# 2. Set the 11 SST secrets (per stage)
pnpm sst secret set JWT_AUTH_SECRET            "$(openssl rand -base64 48)" --stage dev
pnpm sst secret set PROXY_PRIVATE_KEY          "<128-hex expanded sr25519 key>" --stage dev
pnpm sst secret set ATTESTER_PROXY_PRIVATE_KEY "<128-hex expanded sr25519 key>" --stage dev
# Invitation-pool dedicated signer. Add to infra/secrets.ts and uncomment for dedicated-account deployments.
# pnpm sst secret set INVITER_POOL_PRIVATE_KEY  "<128-hex expanded sr25519 key>" --stage dev
pnpm sst secret set WEB_PUSH_VAPID_PRIVATE_KEY "$(bun -e 'console.log(require(\"web-push\").generateVAPIDKeys().privateKey)')" --stage dev
pnpm sst secret set DEVICE_CHECK_PRIVATE_KEY   "$(cat AuthKey_XXXXX.p8)"             --stage dev   # raw PKCS#8 PEM
pnpm sst secret set ADMIN_PASSWORD             "$(openssl rand -base64 24)"        --stage dev
pnpm sst secret set DEBUG_PASSWORD             "$(openssl rand -base64 24)"        --stage dev
pnpm sst secret set APN_PRIVATE_KEY            "$(base64 -w0 -i AuthKey_YYYYY.p8)" --stage dev
pnpm sst secret set TURN_SECRET                "$(openssl rand -base64 32)"        --stage dev
pnpm sst secret set GOOGLE_CREDENTIALS         "$(base64 -w0 -i service-account.json)" --stage dev
echo 'CLOUDFLARE_ZONE_ID="<32-hex zone id>"' >> .env
echo 'API_HOSTNAME="api.example.com"'       >> .env

# 3. Set the 12 deployment config keys in .env at the repo root
#    (PEOPLE_NETWORK defaults to 'westend2'; the other 11 throw if missing)
cat > .env <<'EOF'
PEOPLE_NETWORK=paseo
PEOPLE_RPC_ENDPOINTS=["wss://people-paseo.dotters.network"]
ASSET_HUB_RPC_ENDPOINTS=["wss://asset-hub-paseo.dotters.network"]
ATTESTER_PUBLIC_KEY=0x<64-hex>
ANDROID_PACKAGE_NAMES=["io.example.app"]
ANDROID_SIGNING_DIGEST_PLAYSTORE=<64-hex-lowercase>
ANDROID_SIGNING_DIGEST_WEBSITE=<64-hex-lowercase>
APPLE_TEAM_ID=<10-char>
DEVICE_CHECK_KEY_ID=<10-char>
APN_KEY_ID=<10-char>
APN_TEAM_ID=<10-char>
TURN_REALM=turn.example.com
WEB_PUSH_VAPID_SUBJECT=mailto:ops@example.com
EOF

# 4. Deploy
RATE_LIMIT_PROFILE=shared-nat CLOUDFLARE_PLAN=pro pnpm sst deploy --stage dev
```

The deploy prints two URLs:

```
api:     https://api.example.com
grafana: http://identity-backend-dev-lgtm.<internal>.<region>.elb.amazonaws.com:3000
```

`grafana` is VPC-internal. Reach it via SSH tunnel, AWS VPN, or VPC peering. The `api` URL works **only after** Cloudflare nameserver propagation (1–48 hours after the registrar NS change).

### Path B — Auto-URL (no Cloudflare, no custom domain)

Skip **Step 3** of the first-time-setup walkthrough entirely (no Cloudflare account, no zone, no nameserver change). Run the same `pnpm install` and the same `pnpm sst secret set` commands above **except** the `CLOUDFLARE_API_TOKEN` line. Then:

```sh
# 1. Write the .env at the repo root — DO NOT set CLOUDFLARE_ZONE_ID or API_HOSTNAME
cat > .env <<'EOF'
PEOPLE_NETWORK=paseo
PEOPLE_RPC_ENDPOINTS=["wss://people-paseo.dotters.network"]
ASSET_HUB_RPC_ENDPOINTS=["wss://asset-hub-paseo.dotters.network"]
ATTESTER_PUBLIC_KEY=0x<64-hex>
ANDROID_PACKAGE_NAMES=["io.example.app"]
ANDROID_SIGNING_DIGEST_PLAYSTORE=<64-hex-lowercase>
ANDROID_SIGNING_DIGEST_WEBSITE=<64-hex-lowercase>
APPLE_TEAM_ID=<10-char>
DEVICE_CHECK_KEY_ID=<10-char>
APN_KEY_ID=<10-char>
# TURN_REALM defaults to "turn.localhost" when API_HOSTNAME is unset.
# WEB_PUSH_VAPID_SUBJECT defaults to "mailto:ops@localhost".
EOF

# 2. Deploy (CLOUDFLARE_PLAN and RATE_LIMIT_PROFILE still required — they configure
#    the origin-side rate limiter; the edge is just skipped when there's no zone).
RATE_LIMIT_PROFILE=shared-nat CLOUDFLARE_PLAN=pro pnpm sst deploy --stage dev
```

The deploy prints:

```
api:     https://identity-backend-dev-<hash>.<region>.elb.amazonaws.com
grafana: http://identity-backend-dev-lgtm.<internal>.<region>.elb.amazonaws.com:3000
```

The `api` URL is the raw ALB DNS. `curl -k` works (browsers warn about the
hostname mismatch — the ALB's default cert is for the region wildcard, not
your domain). To get a stable hostname for local dev: `dig +short <alb-dns>`
returns the IPs; put them in `/etc/hosts`. Do not commit those IPs — they
change on every Fargate redeploy.

**What you lose (Auto-URL):** edge WAF, edge rate limiting, mTLS origin lock
(Authenticated Origin Pulls), custom domain. The backend's per-JWT origin
rate limiter still runs. **What you get:** the same backend, in the same
AWS account, on the same LGTM dashboard, without needing a Cloudflare
account or owning a domain.

**Promoting Auto-URL → Cloudflare later:** set `CLOUDFLARE_ZONE_ID` and
`API_HOSTNAME` in `.env`, set `CLOUDFLARE_API_TOKEN` via `sst secret set`,
re-deploy. The `cloudflare.DnsRecord` and edge policy resources are created
on the next apply; the ALB URL keeps working until the DNS record propagates.

For a complete walkthrough including the Cloudflare account setup, the Apple enrollment, the Google service account mint, the Polkadot attester keygen, and the 42 stuck points, see [`infra/docs/first-time-setup.md`](./docs/first-time-setup.md).

## Two knobs

Everything keys off two environment variables, resolved once in `sst.config.ts` and passed to both the origin and the edge so they never disagree:

| Variable                | Values                                | When to use                                                                                                                                                                                                               |
| :---------------------- | :------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RATE_LIMIT_PROFILE`    | `shared-nat` (default)                | Many clients behind one IP (NAT/CGNAT). Origin rate-limits per JWT only; edge splits on Business plan.                                                                                                                    |
|                         | `global`                              | Each client has its own IP. Per-IP limiting at both layers.                                                                                                                                                               |
| `CLOUDFLARE_PLAN`       | `free` / `pro` (default) / `business` | Controls how many edge rate-limit rules are available and which counting characteristics work.                                                                                                                            |
| `SHARED_NAT_CIDRS`      | space/comma CIDR list (default empty) | Known, static shared-NAT egress IP(s) (venue/office/CGNAT). When set on Pro/Free, the edge carves that IP out: it gets a generous bounded ceiling while every other IP keeps a tight per-IP bucket. Empty = no carve-out. |
| `SHARED_NAT_POPULATION` | positive int (default `1000`)         | Expected concurrent principals behind the shared-NAT IP. Feeds `@identity-backend/rate-limit-sizing` to derive the shared-NAT ceiling.                                                                                    |

**MUST agree** across layers. The deploy-time safety net (`assertPlanQuotaFits` in `infra/edge.ts`) throws if the rule count exceeds the plan's quota; but the **Cloudflare API** is the final word on plan compatibility — a misconfigured `cf.unique_visitor_id` on a Pro plan fails silently. See `first-time-setup.md` stuck point #6.

## Module map

| File                     | What it does                                                                             |
| :----------------------- | :--------------------------------------------------------------------------------------- |
| `sst.config.ts`          | Single SST app; resolves plan/profile, declares 12 DEPLOYMENT_CONFIG keys, calls modules |
| `infra/service.ts`       | IdentityBackend ECS service + ALB access logs + circuit breaker + scoped IAM task policy |
| `infra/observability.ts` | LGTM service (internal LB, EFS-backed `/data`, scales 1–3)                               |
| `infra/edge.ts`          | Cloudflare rate-limit + WAF + OWASP + AuthenticatedOriginPulls (plan-aware)              |
| `infra/secrets.ts`       | Names of the 11 `sst.Secret`-backed deployment secrets                                   |
| `infra/vpc-endpoints.ts` | 3 PrivateLink interface endpoints (Secrets Manager, SSM, SSM Messages) + S3 gateway      |
| `infra/observability/`   | LGTM `Dockerfile` + Grafana provisioning (dashboards, alert rules, contact points)       |

## Database

RDS Postgres 17 (`sst.aws.Postgres`) with RDS Proxy enabled. The app's only shared state.

- **Migrations** run on container start (`bun run db:migrate` in the Dockerfile `app-identity` stage). The `Dockerfile`'s `CMD` is `sh -c "bun run db:migrate && exec bun run start"`. Migrations are tracked in `drizzle.__drizzle_migrations`; the runner is idempotent.
- **RDS Proxy** prevents connection exhaustion — each pod keeps its own pool (`DB_POOL_MAX=25` by default), and many pods would overwhelm a direct RDS connection.
- **Production hardening**: 30-day backup retention, deletion protection, 60s enhanced monitoring, performance insights.
- **Non-prod**: 7-day backups, no deletion protection.
- The leader-election advisory lock uses the same database.
- Verify the proxy is in use: `sst diff` should show `database.host` resolving to the proxy endpoint.
- **DB pool sizing math** (the operator needs to know this): N tasks × `DB_POOL_MAX` logical connections, multiplexed by RDS Proxy into a smaller physical pool. The default `min: 1, max: 10` × `DB_POOL_MAX=25` = up to 250 logical, well within RDS Proxy's default capacity. **Verify with the `app_db_pool_sessions_*` and `app_db_server_max_connections` / `app_db_server_connections` Prometheus gauges** emitted by the `pg-monitor` daemon (see `first-time-setup.md` stuck point #27).

`DATABASE_URL` is built from the component outputs and injected into the container — you don't set it manually.

## Observability

The backend exports traces, metrics, and logs over OTLP/HTTP (`http/protobuf`) to the LGTM service. Grafana is pre-wired to its bundled Loki/Tempo/Prometheus. Data persists on an EFS volume at `/data`.

🛑 **LGTM is the only observability stack.** Do **not** point services at Grafana Cloud, Datadog, New Relic, or any external SaaS. The `grafana/otel-lgtm` image is the production telemetry sink; `OTEL_EXPORTER_OTLP_ENDPOINT` on every service points at it.

### Before the dashboards/alerts work

Three things need finalizing (one-time per stage):

1. **Webhook URL** — set `pnpm sst secret set GrafanaWebhookUrl <url>`, then re-run `pnpm observability:render-contact-points` (bakes the URL into the contact-points YAML, which the LGTM `Dockerfile` COPY-s).
2. **Service re-deploy** — `pnpm sst deploy` rebuilds the LGTM image with the resolved URL. Grafana file-provisions on container start.
3. **Grafana URL access** — the LGTM service is internal; reach it via SSH tunnel, AWS VPN, or VPC peering.

### Metric names: OTel → Prometheus

The Prometheus exporter sanitizes OTel metric names by replacing every character outside `[a-zA-Z0-9_]` with `_`, then appends `_total` to monotonic SUMs (counters) and emits `<name>_bucket`/`_sum`/`_count` for histograms. **The unit (`s`, `ms`, `1`) is recorded in a `# UNIT` comment, NOT in the metric name.** So `http.server.request.duration` becomes `http_server_request_duration_bucket` — there is no `_seconds` suffix. Counters like `app.queue.cycle.total` (already ending in `.total`) sanitize to `app_queue_cycle_total` — OTel does NOT add another `_total`. The dashboard `infra/observability/grafana/dashboards/identity-backend.json` is the canonical reference.

### Ports

- `3000` — Grafana UI
- `4318` — OTLP HTTP (what the app sends to)
- `4317` — OTLP gRPC (not exposed via ALB; add an NLB if needed)

## Edge security

Cloudflare sits in front (DNS is `proxied: true`). The edge provides:

1. **Rate limiting** — per plan, keyed on the `RATE_LIMIT_PROFILE` / `CLOUDFLARE_PLAN` knobs (see `infra/docs/edge-cloudflare.md` for the per-plan rule quotas).
2. **User-agent firewall** — blocks scripted user-agents (IP-independent, contains-match works on all plans).
3. **OWASP / Specials managed WAF** — Cloudflare's ModSecurity Core Rule Set + Cloudflare Specials.
4. **Origin lock** — `AuthenticatedOriginPulls` is on, and the ALB accepts only Cloudflare-issued client certs. Traffic can only reach the backend through the edge.

Defense in depth: the custom WAF **also** blocks `/admin`, `/debug/*`, `/healthcheck`, `/livez`, `/readyz`, `/metrics` from the public internet. The ALB health check hits these inside the VPC, not through the edge. The admin and debug trees are gated at the origin by basic-auth / feature flags.

## Secrets

The 11 secrets are stored in AWS Secrets Manager (per-stage, namespaced `identity-backend/<stage>/<NAME>`) and read at task start. **No hot-reload** — the next task replacement rolls a fresh container with the new env var. To force an immediate rollout: `aws ecs update-service --cluster identity-backend-<stage> --service identity-backend --force-new-deployment`.

The 12 deployment config keys are read at **deploy** time from `process.env` / `.env` at the repo root (Pulumi auto-loads). The 11 are throw-if-missing; `PEOPLE_NETWORK` defaults to `'westend2'`.

Full procurement walkthrough: [`infra/docs/secrets-procurement.md`](./docs/secrets-procurement.md). **Key gotcha:** `DEVICE_CHECK_PRIVATE_KEY` is a raw PKCS#8 PEM string (verbatim), `APN_PRIVATE_KEY` is base64 of the raw .p8 file bytes. **Opposite formats** — confusing them is the #1 "the app won't start" error.

## Pinned versions

Before upgrading, verify these against upstream:

| Component           | Pinned version | Source                                                                     |
| :------------------ | :------------- | :------------------------------------------------------------------------- |
| AWS provider        | `7.32.0`       | `sst.config.ts#app().providers.aws.version` (`sst@4` requires `>= 7.20.0`) |
| Cloudflare provider | `6.17.0`       | `sst.config.ts#app().providers.cloudflare` (v6 track tops out at 6.17.0)   |
| SST CLI             | latest 3.x     | sst.dev                                                                    |
| `grafana/otel-lgtm` | `0.11.16`      | `infra/observability/Dockerfile`                                           |
| `oven/bun`          | `1.3.13`       | `Dockerfile` (pinned by SHA256)                                            |

Bump the two Pulumi provider pins in `sst.config.ts` and `infra/docs/sst-deploy.md` together. A version that does not exist on the registry causes the install to fail with `provider <name> not found` after every candidate package name 404s.

## Cost notes

| Resource                | Approx. cost           | Notes                                      |
| :---------------------- | :--------------------- | :----------------------------------------- |
| fck-nat instances       | ~$8–10/AZ/month        | vs ~$32/AZ/month for managed NAT           |
| VPC interface endpoints | $0.01/hr/AZ + $0.01/GB | ~80% cheaper than NAT for secret reads     |
| S3 gateway endpoint     | Free                   | No hourly or per-GB charge for same-region |
| Graviton (arm64)        | ~20% cheaper than x86  | Equivalent compute                         |
| LGTM Fargate            | ~$15–25/month          | 1 vCPU / 2 GB, scales 1–3                  |
| RDS db.t4g.small        | ~$30/month             | 2 vCPU / 2 GB; min for dev                 |
| RDS db.m6g.large        | ~$170/month            | 2 vCPU / 8 GB; recommended for prod        |
| ALB                     | ~$20/month + LCU       | Internal ALB is cheaper                    |
| ECR storage             | ~$0.10/GB/month        | 1.5 GB image × N tasks                     |

## What's in `infra/docs/`

| Document                                                                        | Audience         | When to read                                        |
| :------------------------------------------------------------------------------ | :--------------- | :-------------------------------------------------- |
| [`first-time-setup.md`](./docs/first-time-setup.md)                             | Operator (human) | **Start here.** 39 stuck points for a first deploy. |
| [`sst-deploy.md`](./docs/sst-deploy.md)                                         | Operator (human) | SST v3 deploy/live-debug reference.                 |
| [`aws-fargate-rds.md`](./docs/aws-fargate-rds.md)                               | Operator (human) | Fargate / RDS / Secrets Manager troubleshooting.    |
| [`edge-cloudflare.md`](./docs/edge-cloudflare.md)                               | Operator (human) | Cloudflare WAF / rate-limit / AOP.                  |
| [`observability-lgtm.md`](./docs/observability-lgtm.md)                         | Operator (human) | LGTM / Grafana / alert rules.                       |
| [`secrets-procurement.md`](./docs/secrets-procurement.md)                       | Operator (human) | Every secret + format + procurement walkthrough.    |
| [`apple-services-setup.md`](./docs/apple-services-setup.md)                     | Operator (human) | App Attest + DeviceCheck + APNs click-by-click.     |
| [`google-playintegrity-fcm-setup.md`](./docs/google-playintegrity-fcm-setup.md) | Operator (human) | Play Integrity + FCM service account.               |
| [`polkadot-attester-setup.md`](./docs/polkadot-attester-setup.md)               | Operator (human) | sr25519 keygen, funding, faucet links.              |
| [`polkadot-attester-onchain.md`](./docs/polkadot-attester-onchain.md)           | Operator (human) | On-chain allowance grant (extrinsics, origins).     |
| [`runbook-failure-modes.md`](./docs/runbook-failure-modes.md)                   | Operator (human) | FM-1 through FM-7 failure-mode runbook.             |

## Notes

- `infra/**` and `sst.config.ts` are excluded from oxlint — they use SST's injected globals (`$config`, `sst`, `cloudflare`, `$util`, `$interpolate`) resolved by `sst install` into `.sst/platform/config.d.ts` (gitignored).
- For the "do this first" diagnostic when a deploy or runtime fails (the 7-step flow + the FM-1 through FM-7 runbook), see [`infra/docs/runbook-failure-modes.md`](./docs/runbook-failure-modes.md).
