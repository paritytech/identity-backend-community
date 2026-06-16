# First-Time Setup — Operator Walkthrough

> **This is the document a new operator reads first.** It traces
> the path from "I have AWS and a credit card" to "the API responds
> 200" with every stuck point called out **before** the operator
> hits it. Read [`README.md`](../README.md) after this for the
> per-topic deep dives.

The stack deploys to **two** things — **AWS** (SST provisions
everything) and a **Pulumi state backend** (default SaaS; the
self-hosted S3 option is documented below).

The operator must additionally sign up for **four** external
accounts (Cloudflare, Apple, Google, Polkadot) to collect
credentials that go into SST secrets. None of those four
accounts has any compute we deploy — they are credential
issuers. The backend makes two outbound API calls to Google
(`playintegrity.googleapis.com` and `fcm.googleapis.com`) and
authenticates with a service-account JSON; that JSON is the
only thing the operator obtains from the Google account.

## 0. What this walkthrough assumes

- You have an AWS account with an IAM principal you can use
  (or you can create one).
- You can run `bash`, `pnpm`, `aws`, `gcloud` (no — not gcloud,
  ignore that), and a modern terminal.
- You have ~1 hour of focused time the first run.
- The domain you want to use is one you control at the registrar
  (so you can point it at Cloudflare nameservers).
- Your time zone is whatever — Cloudflare and Apple have async
  steps that span hours; budget for them.

## 0.5 Pre-flight — Polkadot chain-state bootstrap (do this BEFORE step 6)

The on-chain state this repo's deploy depends on — funded attester accounts, **`AttestationAllowance` grants on BOTH People and AssetHub**, sudo proxy delegation, DotNS gateway dispatcher address — is **not provisioned by this repo's SST deploy.** It is owned by the public bootstrap scripts in **`paritytech/individuality-community/tree/main/scripts/initial-setup/`**.

If you are bringing up a fresh People / Asset Hub pair (or a new network target), run that README's `start.sh` (or the `ENV=<target> ./12b-setup-attestation-allowances.sh` and `ENV=<target> ./12c-setup-attestation-proxy.sh` minimum) **before** you do Step 6 below. Skipping this is the single most common cause of "the deploy succeeded, the API responds 200, but every registration returns `NoAttestationAllowance`" — see stuck point #31 for the per-chain WSS list and the dual-grant requirement.

The community bootstrap is the source of truth for operator workflow. Step 6 and [`polkadot-attester-onchain.md`](./polkadot-attester-onchain.md) explain what the extrinsics do, not how to submit them.

**⏱ Time budget:**

| Step                                               | Synchronous  | Async wait              |
| -------------------------------------------------- | ------------ | ----------------------- |
| 1. AWS IAM + STS                                   | 10 min       | —                       |
| 2. Pulumi Cloud account / backend                  | 5 min        | —                       |
| 3. Cloudflare account + zone                       | 5 min        | Nameserver prop: 1–48 h |
| 4. Apple Developer Program                         | 5 min signup | Org enrollment: 1–2 BD  |
| 5. Google account (to mint a service-account JSON) | 5 min        | —                       |
| 6. Polkadot / People chain                         | 5 min        | Faucet: 30 s – 5 min    |
| 7. **First `pnpm sst deploy`**                     | 20–60 min    | LGTM warmup: 5–10 min   |
| 8. Verify                                          | 5 min        | —                       |

**Total sync: ~1 hour. Total wall-clock including Cloudflare
nameserver propagation: 4–12 hours.** The first deploy is the
single longest sync step.

---

## Step 1 — Bootstrap AWS access

### What you need

- An AWS account (or a sandbox account you own).
- An IAM principal — **a user or role** you can use to run
  `pnpm sst deploy`. You do NOT use the root account. You do NOT
  use the access keys of the account owner.

### Stuck point #1 — "How wide should the IAM policy be?"

**You will get stuck here if you try to write a least-privilege
policy from scratch.** The SST deploy creates ~40 AWS resources
(ECS, RDS, VPC, IAM, S3, EFS, CloudWatch, Secrets Manager, KMS)
across multiple services. A bare-minimum policy is ~80 lines of
JSON and is brittle — every SST release potentially adds a new
permission.

**The pragmatic answer:** attach the **`PowerUserAccess`**
AWS-managed policy plus a few extras SST needs that
`PowerUserAccess` doesn't cover:

- `PowerUserAccess` (arn:aws:iam::aws:policy/PowerUserAccess)
- Custom inline policy:
  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      { "Effect": "Allow", "Action": ["iam:CreateServiceLinkedRole", "iam:DeleteServiceLinkedRole"], "Resource": "*" },
      { "Effect": "Allow", "Action": ["ecr:GetAuthorizationToken"], "Resource": "*" },
      { "Effect": "Allow", "Action": ["s3:GetAccountPublicAccessBlock"], "Resource": "*" },
      { "Effect": "Allow", "Action": ["iam:PassRole"], "Resource": "arn:aws:iam::*:role/*-DatabaseMonitoringRole-*" }
    ]
  }
  ```

**The `iam:PassRole` line is critical for RDS Enhanced Monitoring.**
RDS rejects the create call with `InvalidParameterValue: IAM
role ARN value is invalid or does not include the required
permissions for: ENHANCED_MONITORING` if the deployer does not
have `iam:PassRole` on the `*-DatabaseMonitoringRole-*` role that
`sst.config.ts` creates (see step 7 / "Stuck point #40" below).
The `*` in the resource pattern scopes the permission to roles
created by THIS app's SST stack; broader patterns work but
violate least-privilege.

**Why not `AdministratorAccess`:** it works, but it bypasses
break-glass protection if your credentials leak. PowerUserAccess
is enough for SST and excludes IAM user management.

### Set the region and confirm identity

```bash
export AWS_DEFAULT_REGION=eu-central-1
aws sts get-caller-identity
# { "Account": "123456789012", "Arn": "arn:aws:iam::123456789012:user/yourname", "UserId": "..." }
```

Note the **Account** number — you'll need it for resource naming
and the cross-account trust policy later.

### Stuck point #2 — "Where's `eu-central-1` and what if I want a different region?"

`eu-central-1` (Frankfurt) is hard-coded in `sst.config.ts#app().providers`. To change
it, you must change `sst.config.ts`, the `vpc-endpoints.ts`
service names (which embed `com.amazonaws.eu-central-1.*` literals),
the `AlbAccessLogs` region tag, and the LGTM `RATE_LIMIT_POD_DIVISOR`
compute — and the ALB access log bucket policy. **Easier to just
use eu-central-1.**

### Stuck point #3 — "I have access keys, now what?"

If you set up an IAM user, you have an Access Key ID and Secret
Access Key. Configure them:

```bash
aws configure
# AWS Access Key ID: AKIA...
# AWS Secret Access Key: ...
# Default region name: eu-central-1
# Default output format: json
```

The credentials go to `~/.aws/credentials`. SST picks them up
automatically. **Do not commit `~/.aws/credentials` to git.**

If you are using AWS SSO (recommended for organizations):

```bash
aws configure sso
# Follow the prompts to register your SSO start URL
aws sso login --profile my-sso-profile
export AWS_PROFILE=my-sso-profile
export AWS_DEFAULT_REGION=eu-central-1
```

SST respects `AWS_PROFILE`.

---

## Step 2 — SST state backend (Pulumi)

SST v3 stores its infrastructure state in a Pulumi backend.
The default is the Pulumi Cloud free tier (SaaS, login via
`pnpm sst login`). This deploy does not require it — the
operator picks the backend.

**What the runtime stack itself uses for state:** RDS Postgres
(operational data + the leader-election advisory lock) and
EFS (LGTM data volume). **S3** is used for one bucket — the
ALB access log bucket, which SST auto-creates. **DynamoDB is
not used by the runtime stack at all.** "S3 + DynamoDB" only
appears if the operator chooses a self-hosted Pulumi backend
(see Option B below), and the DynamoDB table is for
Pulumi's state-locking mechanism, not for the application.

### Option A — Pulumi Cloud (simplest)

```bash
pnpm sst login
```

This opens a browser to `app.pulumi.com` and asks you to
authenticate. After you sign in, the CLI is logged in and
SST can write state to your Pulumi Cloud account. The
free tier is adequate for a single-operator setup.

**Caveat:** Pulumi Cloud is a third-party SaaS. If your
deployment has a "no SaaS state backend" compliance
requirement, use Option B or C.

### Option B — Self-hosted S3 backend (your AWS account)

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="my-pulumi-state-${ACCOUNT_ID}"
REGION=eu-central-1

aws s3api create-bucket --bucket $BUCKET --region $REGION --create-bucket-configuration LocationConstraint=$REGION
aws s3api put-bucket-versioning --bucket $BUCKET --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket $BUCKET --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration '{"BlockPublicAcls":true,"IgnorePublicAcls":true,"BlockPublicPolicy":true,"RestrictPublicBuckets":true}'

export PULUMI_BACKEND_URL=s3://$BUCKET
```

No DynamoDB is required for S3-only backends (Pulumi manages
locking via the S3 object's `VersionId` if no lock table is
configured; concurrent deploys may briefly race in that
mode). For concurrent-deploy safety, add a lock table:

```bash
aws dynamodb create-table \
  --table-name pulumi-state-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

The IAM user needs `s3:*` on the bucket (and `dynamodb:*` on
the lock table if you create one). If you used the
`PowerUserAccess` policy, this is already covered.

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="my-pulumi-state-${ACCOUNT_ID}"
REGION=eu-central-1

aws s3api create-bucket --bucket $BUCKET --region $REGION --create-bucket-configuration LocationConstraint=$REGION
aws s3api put-bucket-versioning --bucket $BUCKET --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket $BUCKET --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration '{"BlockPublicAcls":true,"IgnorePublicAcls":true,"BlockPublicPolicy":true,"RestrictPublicBuckets":true}'

aws dynamodb create-table \
  --table-name pulumi-state-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

export PULUMI_BACKEND_URL=s3://$BUCKET
```

The IAM user needs `s3:*` on this bucket and `dynamodb:*` on the
locks table. The deploy will fail with `no Pulumi backend
configured` if you forget to set `PULUMI_BACKEND_URL`.

### Stuck point #4 — "Do I need IAM permissions on the bucket?"

Yes. The deploy will fail with `AccessDenied: s3:PutObject` on
the first `sst deploy` if your IAM principal can't write to the
bucket. If you used the `PowerUserAccess` policy, this is
already covered. If you wrote a custom policy, add it.

---

## Step 3 — Onboard with Cloudflare

This is the **largest single source of first-time-setup stuck
points.** Read carefully.

### What you need

- An account on `dash.cloudflare.com`.
- A domain (e.g. `example.com`) you control at the registrar
  (GoDaddy, Namecheap, Cloudflare Registrar, Route53, etc.).

### 3.1 — Sign up

1. `dash.cloudflare.com/sign-up` — email + password.
2. Verify email.
3. The plan selector appears. Pick **Pro** ($25/mo) for the
   default `RATE_LIMIT_PROFILE=shared-nat` + `CLOUDFLARE_PLAN=pro`
   config. Pick **Business** ($250/mo) if you'll use the
   per-class rate-limit rules (`RATE_LIMIT_PROFILE=global` +
   `CLOUDFLARE_PLAN=business`).
4. Pro requires a credit card on file even for the trial.

### 3.2 — Add the domain

1. Click **Add a Site**.
2. Enter the **apex domain** (e.g. `example.com` — the operator's
   API is `api.example.com`, a sub-record).
3. Cloudflare scans existing DNS records. **This takes 30 s to 3
   min.** You'll see "Scanning DNS records..." on the status
   page. Don't refresh impatiently.
4. Once the scan completes, Cloudflare shows you two
   **nameservers** (e.g. `aria.ns.cloudflare.com` and
   `hank.ns.cloudflare.com`). **Save these.**

### ⚠️ STUCK POINT #5 — "The biggest one: change the nameservers at your registrar"

**This is THE most common first-time-setup stuck point.** It
is asynchronous, takes 1–48 hours, and if you skip it, your
first `pnpm sst deploy` will succeed but **every DNS lookup
for `api.example.com` will fail**.

1. Go to your domain registrar's control panel.
   - **GoDaddy:** `account.godaddy.com` → Domains → `example.com`
     → Nameservers → "Change nameservers" → "Custom" → paste
     the two Cloudflare nameservers → Save.
   - **Namecheap:** `namecheap.com` → Domain List → `example.com`
     → Manage → Nameservers → "Custom DNS" → paste the two
     Cloudflare nameservers → Save.
   - **Google Domains / Squarespace Domains:**
     `domains.google.com` → `example.com` → DNS → "Use custom
     name servers" → paste the two → Save.
   - **Cloudflare Registrar:** already on Cloudflare nameservers
     by definition; nothing to do.
2. **Wait.** DNS propagation: 1–48 hours, typical 4–12 hours.
3. Verify with: `dig NS example.com @8.8.8.8` — must return
   the Cloudflare nameservers.

**During propagation, Cloudflare's zone overview shows
"Pending Nameserver Update" and the status pill is yellow.** The
`sst deploy` will complete (the Cloudflare API calls work — the
DNS record is created in Cloudflare's database), but
`dig api.example.com @1.1.1.1` will return NXDOMAIN or the old
record. **This is the most likely "deploy succeeded but curl
fails" stuck point.**

### 3.3 — Create the API token

1. Cloudflare dashboard → **My Profile** → **API Tokens** → **Create
   Token** → **Create Custom Token**.
2. Permissions:
   - **Zone → DNS → Edit**
   - **Zone → WAF → Edit**
   - **Zone → Settings → Edit**
   - **Zone → SSL and Certificates → Edit**
3. **Account Resources** scope: your account.
4. **Zone Resources** scope: include the specific zone
   (`api.example.com`'s apex).
5. Create. **The token is shown ONCE.** Store it in a password
   manager.
6. The token is what you set as the **`CLOUDFLARE_API_TOKEN`**
   environment variable for SST (locally). **In CI**, set it
   as a CI secret.

### ⚠️ STUCK POINT #6 — "What about `CLOUDFLARE_PLAN`?"

`CLOUDFLARE_PLAN` is a **shell environment variable** on the
machine running `pnpm sst deploy`. It does NOT have to match
your Cloudflare billing plan exactly, but they should be
consistent. **The mismatch trap:**

- `CLOUDFLARE_PLAN=business` + a Pro Cloudflare account →
  `assertPlanQuotaFits` in `infra/edge.ts` passes (5 rules fit
  the 5-rule Business quota) but **Cloudflare's API rejects**
  the rule with `cf.unique_visitor_id` because that field
  requires Business. The deploy fails with a vague
  `ruleset apply failed` error and the operator has to look at
  the Cloudflare API response to find the cause.
- `CLOUDFLARE_PLAN=pro` + a Business Cloudflare account → works
  (you pay Business prices, but the deploy only uses 2 rules).

**Rule of thumb:** set `CLOUDFLARE_PLAN` to match your actual
Cloudflare plan.

### 3.4 — Get the Zone ID

Cloudflare dashboard → select the zone → **Overview** → right-hand
panel → **API** → **Zone ID**. A 32-char hex string. **Save
this.**

---

## Step 4 — Apple Developer Program

You need this for the App Attest, DeviceCheck, and APNs keys.
If you are doing a dev/staging deploy that doesn't need push
notifications, you can skip steps in this section, but you'll
still need an App ID for App Attest.

### ⚠️ STUCK POINT #7 — "Organization enrollment takes 1–2 business days"

- **Individual** account: instant, but caps at 1 person's name
  on certificates and $99/year.
- **Organization** account: requires a **D-U-N-S number** (free,
  Dun & Bradstreet, 1–14 business days turnaround for new
  businesses). Enrollment completes 1–2 business days after the
  D-U-N-S is associated.
- The **Account Holder** role is required to register App IDs
  and Keys. Admins can too. App Managers can register Certificates
  but not Keys. **Developer** is read-only.

If this is a real production deploy, start the enrollment **the
day before** you need to deploy.

### ⚠️ STUCK POINT #8 — "I can't find App Attest on my App ID"

The App Attest row in the App ID's capability list is
**informational only**. App Attest is **automatically enabled
for any Explicit (not Wildcard) App ID** in the current Apple
docs. You don't toggle it. The capability row in the dashboard
exists to _advertise_ that the App ID supports it. Verify
you're using an **Explicit Bundle ID** (e.g. `com.example.myapp`,
NOT `com.example.*`).

### ⚠️ STUCK POINT #9 — "The .p8 is shown once — I didn't download it"

The DeviceCheck and APNs .p8 files are **downloadable exactly
once**. If you missed the download, you have to revoke the key
and register a new one. **Right-click → Save As** (not
"Open in browser" — some browsers display the .p8 as text and
the operator tries to paste the PEM into the SST secret). Make
sure the file is saved with the `.p8` extension and is the
raw binary, not a `.pem` text rendering.

### Format: PEM for DeviceCheck, base64 for APN

This is the **opposite-format trap** — the two Apple keys are
encoded differently and confusing them is the #1 source of
"the app won't start" errors:

| Key                        | Format expected in `sst secret set`                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `DEVICE_CHECK_PRIVATE_KEY` | **Raw PKCS#8 PEM text** (the .p8 verbatim, with the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines) |
| `APN_PRIVATE_KEY`          | **Base64 of the .p8 file bytes** (NOT the PEM text)                                                                      |

For the DeviceCheck key, the operator uses `cat AuthKey_XXX.p8`
directly into `sst secret set`. Newlines are preserved in
Secrets Manager.

For the APN key, the operator uses `base64 -w0 -i
AuthKey_XXX.p8` and pastes the base64 string. The runtime
decodes with `Buffer.from(b64decoded, 'utf-8')` to feed
`@parse/node-apn`.

### ⚠️ STUCK POINT #10 — "Where do I get `APPLE_TEAM_ID`?"

Apple Developer → top-right account dropdown → **Membership** →
**Team Information** → **Team ID**. A 10-character alphanumeric
string. Not the same as the **Team Name** (which is human-
readable). Not the same as the **Agent ID**.

Full walkthrough: [`apple-services-setup.md`](./apple-services-setup.md).

---

## Step 5 — Google account (for Play Integrity + FCM credentials)

**Google Cloud is not part of the deploy.** The backend makes
outbound calls to `playintegrity.googleapis.com` and
`fcm.googleapis.com` and authenticates with a service-account
JSON. The operator must obtain that JSON from their own
Google account. **No Google Cloud project is created or
managed by SST.** What follows is purely about issuing the
credential.

### 5.1 — Create the project (or use an existing one)

1. `console.cloud.google.com` → top-left project selector →
   **New Project**.
2. Name: e.g. `identity-backend-prod`.
3. **Link a billing account** even though Play Integrity + FCM
   are free — Google requires a billing account to enable any
   paid-tier API, even when the API itself is free.

### ⚠️ STUCK POINT #11 — "The service account can't call the API"

After creating the service account and downloading the JSON
key, you must grant it the right roles. **The two roles this
deploy needs:**

- `roles/firebasecloudmessaging.admin` — for FCM HTTP v1 API
  (sends the push to Android devices).
- For Play Integrity: no specific role is required. The
  service account authenticates and the API itself authorizes.
  `roles/editor` is the minimum.

`GOOGLE_CREDENTIALS` (the single env var that drives both Play
Integrity and FCM) is **base64 of the JSON key file bytes**.
The runtime decodes it via `firebase-admin/app#initializeApp`.
One service account covers both flows.

### 5.2 — Get the Android signing digests

- **`ANDROID_SIGNING_DIGEST_PLAYSTORE`** (the digest Google uses
  to re-sign the app uploaded to Play Console):
  Google Play Console → your app → **Setup** → **App integrity**
  → **App signing** → "App signing key certificate" → copy the
  SHA-256 fingerprint → strip colons → lowercase.
- **`ANDROID_SIGNING_DIGEST_WEBSITE`** (the digest of the
  sideloaded website APK's signing cert):
  `apksigner verify --print-certs my-app.apk` → "SHA-256 Digest" → strip colons → lowercase.

### ⚠️ STUCK POINT #12 — "The signing digest is the wrong length"

The Config layer (`apps/identity-backend/src/config.ts#ANDROID_SIGNING_DIGEST_*`)
applies `.trim().toLowerCase().replace(/:/g, '')`. So a value
like `AB:CD:EF:...` (with colons) is accepted. But the value
must be **exactly 64 lowercase hex characters (32 bytes)** after
normalization. A 63-char or 65-char value is rejected at
startup with `InvalidData: ANDROID_SIGNING_DIGEST_PLAYSTORE: Not
a valid hex string`.

If the value is from the Play Console, the SHA-256 fingerprint
**is** 64 chars. If it's from a `keytool` dump, you may have
included the algorithm prefix (`SHA256:`) or fingerprint
metadata — strip them.

Full walkthrough: [`google-playintegrity-fcm-setup.md`](./google-playintegrity-fcm-setup.md).

---

## Step 6 — Polkadot / People chain attester account

You need:

- A funded sr25519 account that submits transactions to the
  People chain and (optionally) Asset Hub.
- The **attester public key** to be registered on-chain with
  a non-zero `AttestationAllowance`.

### 6.1 — Generate the keys

Use the repo's script:

```bash
# Edit the mnemonic in the script first (replace 'put the mnemonic here')
# or set it via the environment
# Or generate a fresh mnemonic and pass it in
cd apps/identity-backend
bun scripts/private-key.ts
# Outputs:
#   Expanded Private Key (hex):   <128-char hex>
#   SS58 Address:                  <SS58 address>
```

The expanded private key is what `PROXY_PRIVATE_KEY` expects.
The SS58 address is what you fund.

### ⚠️ STUCK POINT #13 — "The 64-byte vs 32-byte confusion"

`subkey generate` outputs a **32-byte secret seed**, not the
64-byte expanded key. The app's `Config` layer expects the
**expanded** key. The repo's `scripts/private-key.ts` is the
canonical generator that produces the expanded form. **If you
use `subkey inspect` and copy the 32-byte seed, the app
will fail to start** with `InvalidData: PROXY_PRIVATE_KEY:
expected 64 bytes, got 32`.

### 6.2 — Fund the account

| Network  | Faucet / funding source                                                       | Time               |
| -------- | ----------------------------------------------------------------------------- | ------------------ |
| paseo    | <https://faucet.paseo.org/>                                                   | 30 s – 5 min       |
| westend2 | <https://faucet.polkadot.io/> or Matrix-based                                 | 1–2 min            |
| polkadot | Buy DOT on Binance / Kraken; minimum 1 DOT existential + 5-10 DOT for tx fees | Exchange-dependent |

### ⚠️ STUCK POINT #14 — "I'm the deploy operator, I don't have the Root origin"

**The biggest on-chain stuck point.** The `peopleLite` pallet
has two relevant extrinsics:

| Extrinsic                                                    | Call index | Origin required                                                                                       |
| ------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------- |
| `peopleLite.increase_attestation_allowance(attester, count)` | 0          | **`AttestationAllowanceManager` (wired to `EnsureRoot<AccountId>` in the next-people-paseo runtime)** |
| `peopleLite.attest(...)`                                     | 2          | `Signed` (needs non-zero allowance)                                                                   |

The attester account calling `increase_attestation_allowance` for
itself **always fails with `BadOrigin`**. The dispatch origin
is Root (sudo on a dev chain, governance on mainnet). **You,
the deploy operator, do not have Root.**

**Resolution:** the chain admin (governance council, sudo key
holder, or whoever holds the Root origin on the target network)
must submit `peopleLite.increase_attestation_allowance(<your-
attester-SS58-address>, <count>)`. The backend publishes its
attester public key at `GET /api/v1/attester` — give that
public key (or its derived SS58 address) to the chain admin.

The same is true for Asset Hub's `dotnsGateway` pallet
(independent allowance, same `EnsureRoot` origin). Without
on-chain allowance grants, the deploy will succeed but the
first username registration will fail with
`NoAttestationAllowance`.

Full on-chain setup:
[`polkadot-attester-onchain.md`](./polkadot-attester-onchain.md).

---

## Step 7 — The first `pnpm sst deploy`

You have now:

- AWS IAM principal ready
- Pulumi Cloud login (or self-hosted backend)
- Cloudflare zone, nameservers propagating
- Apple Developer Program + App ID + 3 .p8 keys
- Google Cloud project + service account JSON
- Polkadot / People chain funded attester account

### 7.0 — Choose your URL strategy (do this BEFORE you set secrets)

The deploy supports two URL strategies. The Cloudflare path
proxies traffic through a custom domain with WAF, rate limiting,
and Authenticated Origin Pulls. The auto-URL path uses the raw
ALB DNS name and ships without edge protection. Pick one before
you set any secrets — the choice changes which secrets and env
vars you need to populate.

| Strategy                         | URL                                                                  | What you need                                                                                                         | What you get                                                                                        | What you lose                                                                                                                                            |
| :------------------------------- | :------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare** (production path) | `https://api.example.com` (your domain)                              | `CLOUDFLARE_ZONE_ID` in `.env`, `API_HOSTNAME=api.example.com` in `.env`, `CLOUDFLARE_API_TOKEN` via `sst secret set` | Edge WAF (OWASP, SQLi), per-endpoint rate limits, mTLS origin lock, custom domain with managed cert | Cloudflare account, $5–250/mo plan, ~1–48 h nameserver propagation                                                                                       |
| **Auto-URL** (dev / personal)    | `https://identity-backend-<stage>-<hash>.<region>.elb.amazonaws.com` | Nothing extra — neither `CLOUDFLARE_ZONE_ID` nor `API_HOSTNAME` set                                                   | Deploys and runs the same backend; the ALB URL is what `pnpm sst deploy` prints at the end          | Edge WAF, rate limits at the edge, mTLS origin lock, custom domain, custom TLS cert (you get the ALB's default cert with a hostname warning in browsers) |

**Decision rule:** if this is a personal/dev stage or you are
just trying the deploy once, pick **Auto-URL**. The deploy
prints the ALB URL at the end and you can hit it with `curl`
(accept the cert warning). The backend's origin-side rate
limiter still runs — per-JWT, not per-IP. If this is for a
production-ish user-facing stage, pick **Cloudflare** and
budget the nameserver propagation time.

The rest of this document assumes the **Cloudflare** path. For
the **Auto-URL** path, skip:

- **Step 3 entirely** (no Cloudflare account needed)
- The two `CLOUDFLARE_ZONE_ID` / `API_HOSTNAME` lines in the
  `.env` block in **Step 7.2**
- The `CLOUDFLARE_API_TOKEN` `sst secret set` line in **Step 7.3**
- All stuck points numbered under 5 (Cloudflare onboarding
  stuck points)

You still set all the secrets (Apple, Google, Polkadot, JWT,
TURN, VAPID, DEVICE_CHECK, APN, ADMIN, DEBUG, etc.). Only
the Cloudflare-specific ones are skipped.

### 7.1 — Clone the repo, install, prepare

```bash
git clone <repo-url>
cd identity-backend
corepack enable
pnpm install
```

`pnpm install` will run `sst install` automatically (postinstall
hook), which downloads the Pulumi binary to `.sst/`. **If
`sst install` fails**, the error is usually a Go-binary
download issue (corporate proxy, firewall, missing `ca-
certificates` in the slim Docker base). The `Dockerfile`
handles this for the image, but for local CLI you may need
`apt-get install -y ca-certificates` on the host.

### 7.2 — Write `.env` at the **repo root**

```sh
# /path/to/identity-backend/.env  (NOT apps/identity-backend/.env)
PEOPLE_NETWORK=paseo
PEOPLE_RPC_ENDPOINTS=["wss://people-paseo.dotters.network"]
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
```

### ⚠️ STUCK POINT #15 — ".env in the wrong directory"

Pulumi / SST auto-loads `.env` from the **workspace root**
(the directory where `pnpm-lock.yaml` lives), NOT from
`apps/identity-backend/`. The `apps/identity-backend/.env.example`
file is for **local dev** (read by the Bun server in the
Dockerfile) — **not** by the SST deploy. If you copy it to
the wrong place, the deploy will throw at `PEOPLE_RPC_ENDPOINTS`
missing even though the value is in the file.

### ⚠️ STUCK POINT #23 — "I don't have a Docker daemon on my laptop"

`infra/service.ts:98` and `infra/observability.ts:23` set
`image: { context: '.', dockerfile: 'Dockerfile' }` —
**SST BUILDS THE IMAGE LOCALLY on the operator's machine**
then pushes it to ECR. This is the opposite of the typical
"pre-built image in ECR" pattern; if your laptop does not
have a running Docker daemon, the deploy dies at:

```
Error: Cannot connect to the Docker daemon at unix:///var/run/docker.sock.
Is the docker daemon running?
```

The `Dockerfile` is multi-stage: it pulls from `paritytech/identity-backend`
base images, runs `pnpm turbo build`, and produces an `app-identity`
target SST consumes. Building it requires ~6 GB of disk, ~3 GB
of RAM, and 5–15 minutes on a warm pnpm cache.

**Workarounds:**

- **Docker Desktop / OrbStack** (the easy one). Make sure
  the daemon is running and your user can access it
  (`docker ps` should not hang).
- **Remote Docker** — set `DOCKER_HOST=tcp://<host>:2375`
  on a beefier build box.
- **Buildx with a remote builder** — `docker buildx create
  --name sst --driver remote tcp://...`. The deploy then
  pushes to your builder.

**The doc doesn't say "install Docker" anywhere.** It assumes
you have it. If you are running this from a CI/CD runner,
configure the runner with Docker (or with kaniko/buildah for
rootless builds; SST requires a working Docker socket for
the local-builder path).

### ⚠️ STUCK POINT #24 — "I have Docker, but no `aws ecr:*` permission on my IAM user"

Even with Docker running, `sst deploy` must `docker push
<repo>:tag` to an ECR repo. The IAM principal needs:

```
ecr:GetAuthorizationToken       (Resource: *)
ecr:BatchCheckLayerAvailability (Resource: <repo-arn>)
ecr:CompleteLayerUpload         (Resource: <repo-arn>)
ecr:InitiateLayerUpload         (Resource: <repo-arn>)
ecr:PutImage                    (Resource: <repo-arn>)
ecr:UploadLayerPart             (Resource: <repo-arn>)
```

If the `PowerUserAccess` managed policy is attached (stuck
point #1), you have all of these. If you wrote a tighter
custom policy and missed `ecr:PutImage` / `ecr:UploadLayerPart`,
the push fails with `denied: User: arn:aws:iam::... is not
authorized to perform: ecr:PutImage`. The image is built
locally and then cannot leave your machine.

**SST auto-creates the ECR repository on first deploy** —
it does not need to pre-exist. The repo name is derived
from the SST app name and stage (e.g.
`identity-backend-dev`). It lives in the same account
and region as the rest of the stack.

### ⚠️ STUCK POINT #25 — "My `pnpm sst install` failed with `ca-certificates`"

The `Dockerfile` line 27-28 shows why this matters — even
`node:24-slim` has TLS that works for HTTPS, but `sst install`
**downloads the Pulumi binary** (a Go binary that uses the
system CA bundle). The download is HTTPS, but the
verification uses the system CAs. On hosts where
`/etc/ssl/certs/ca-certificates.crt` is missing or empty
(common in `debian:slim` and minimal CI images), the
download fails with:

```
x509: certificate signed by unknown authority
```

The fix:

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates
# or
sudo update-ca-certificates
```

**On Mac** this is almost never an issue (the system has the
Apple-provided CA bundle). **On Linux CI** it is the #1
cause of `sst install` failing.

### ⚠️ STUCK POINT #26 — "I set `PEOPLE_RPC_ENDPOINTS` to a `wss://...` URL and the deploy complains about JSON"

The Config layer parses it as a JSON array:

```ts
export const PEOPLE_RPC_ENDPOINTS = pipe(
  Config.array(Config.nonEmptyString(), 'PEOPLE_RPC_ENDPOINTS'),
  ...
)
```

So `.env` must have:

```
PEOPLE_RPC_ENDPOINTS=["wss://people-paseo.dotters.network"]
```

**Common mistake:** `PEOPLE_RPC_ENDPOINTS=wss://people-paseo.dotters.network`
(without the JSON array). Pulumi / SST reads the value
literally; the array decoder fails at deploy time. The
error is exact: `InvalidData: PEOPLE_RPC_ENDPOINTS: Expected
an array, received a string`.

### 7.3 — Set the SST secrets (per stage)

The 11 genuine secrets are encrypted in AWS Secrets Manager
under `identity-backend/<stage>/<NAME>`. The deployment
config (12 keys) is read from the host environment.

```bash
# These are the 11 secrets + 1 dev/prod shared secret:
pnpm sst secret set JWT_AUTH_SECRET             "$(openssl rand -base64 48)" --stage dev
pnpm sst secret set PROXY_PRIVATE_KEY           "<128-hex>"                  --stage dev
pnpm sst secret set ATTESTER_PROXY_PRIVATE_KEY  "<128-hex>"                  --stage dev
# Invitation-pool dedicated signer. Add to infra/secrets.ts and uncomment for dedicated-account deployments.
# pnpm sst secret set INVITER_POOL_PRIVATE_KEY   "<128-hex>"                  --stage dev
pnpm sst secret set WEB_PUSH_VAPID_PRIVATE_KEY  "$(bun -e 'console.log(require(\"web-push\").generateVAPIDKeys().privateKey)')" --stage dev
pnpm sst secret set DEVICE_CHECK_PRIVATE_KEY    "$(cat AuthKey_XXXXX.p8)"    --stage dev
pnpm sst secret set ADMIN_PASSWORD              "$(openssl rand -base64 24)" --stage dev
pnpm sst secret set DEBUG_PASSWORD              "$(openssl rand -base64 24)" --stage dev
pnpm sst secret set APN_PRIVATE_KEY             "$(base64 -w0 -i AuthKey_YYYYY.p8)" --stage dev
pnpm sst secret set TURN_SECRET                 "$(openssl rand -base64 32)" --stage dev
pnpm sst secret set GOOGLE_CREDENTIALS          "$(base64 -w0 -i service-account.json)" --stage dev
pnpm sst secret set GrafanaWebhookUrl           "https://hooks.slack.com/..." --stage dev

# The two non-secret Cloudflare config values go in .env (SST auto-loads it):
echo 'CLOUDFLARE_ZONE_ID="<32-hex>"'       >> .env
echo 'API_HOSTNAME="api.example.com"'      >> .env
```

### ⚠️ STUCK POINT #16 — "Deploy throws 'Missing required deployment config: X'"

The error is exact — the `sst.config.ts#requireEnv` function
names the missing key. **The fix is to add it to `.env` at the
repo root and re-run `pnpm sst deploy`.** Pulumi/SST reads
`.env` once at the start of the deploy, so changing `.env`
mid-deploy has no effect.

If you have 5 missing keys, the error lists them all. **Fix
all 5 in `.env`, re-run, and expect the error to show the next
5.** A typical first run shows 2-3 rounds of these errors
before all 11 required config keys are set.

### 7.4 — Render the alert webhook, then deploy

```bash
pnpm observability:render-contact-points
# Wrote infra/observability/grafana/alerting/contact-points.yaml

RATE_LIMIT_PROFILE=shared-nat CLOUDFLARE_PLAN=pro pnpm sst deploy --stage dev
```

`pnpm observability:render-contact-points` reads the
`GrafanaWebhookUrl` SST secret (or `process.env.GRAFANA_WEBHOOK_URL`
if set) and substitutes the `__GRAFANA_WEBHOOK_URL__` token in
`infra/observability/grafana/alerting/contact-points.yaml`. The
file is COPY-ed into the LGTM image at build time.

### ⚠️ STUCK POINT #17 — "The renderer fails with 'GRAFANA_WEBHOOK_URL is unset'"

You forgot to `pnpm sst secret set GrafanaWebhookUrl ...` (or to
export the env var). The renderer exits 1 with the message. Set
the secret and re-run the renderer.

### ⚠️ STUCK POINT #18 — "The deploy hangs for 10 minutes on LGTM"

The LGTM service pulls a 1.5 GB image (`grafana/otel-lgtm:0.11.16`)
from Docker Hub on first deploy, then creates an EFS mount
target. The first task takes 5–10 minutes to become healthy.
**The deploy may "complete" before LGTM is fully ready** —
the LGTM service health check will fail until the image is
pulled and the mount target is created. The deployment
circuit breaker will NOT roll back the LGTM service (it only
fires on the main identity-backend service). Wait 5–10 minutes
and re-check.

### ⚠️ STUCK POINT #19 — "Migration fails and the service is unhealthy"

The Dockerfile's `CMD` is `sh -c "bun run db:migrate && exec
bun run start"`. The Drizzle migration runs in the new task
**before** the health check passes. If the migration fails
(bad schema, missing table, etc.), the task is "unhealthy" and
the circuit breaker rolls back.

**Recovery:**

1. The failed task is gone (rolled back). Get the previous
   task's logs (still in CloudWatch for the retention period):
   ```bash
   aws logs tail /ecs/identity-backend-dev --since 30m \
     --filter-pattern "bun run db:migrate"
   ```
2. The migration error is the first non-trace line. Fix the
   schema or migration script.
3. Re-deploy: `pnpm sst deploy --stage dev`.

---

## Step 8 — Verify

The deploy's stdout shows two URLs:

```
api:     https://api-dev.example.com
grafana: http://identity-backend-dev-lgtm.<internal>.<region>.elb.amazonaws.com:3000
```

The `api` URL works **only after** Cloudflare nameserver
propagation (stuck point #5). The `grafana` URL is VPC-internal —
you reach it via SSH tunnel, AWS VPN, or VPC peering.

### ⚠️ STUCK POINT #20 — "curl https://api.example.com/readyz returns NXDOMAIN"

Nameserver propagation is still in progress. Verify:

```bash
dig NS example.com @8.8.8.8
# Must return aria.ns.cloudflare.com, hank.ns.cloudflare.com

dig api.example.com @1.1.1.1
# Must return the Cloudflare proxy IPs (any A or AAAA record)
```

If the NS query returns your registrar's old nameservers, the
registrar change hasn't propagated yet. If the NS query
returns Cloudflare but the A query returns NXDOMAIN, the
record creation by `sst deploy` failed (check the SST console
output). The Grafana "DNS record" panel of the
`identity-backend.json` dashboard shows the propagated record.

### ⚠️ STUCK POINT #21 — "curl returns 502/503 immediately"

The ALB target is unhealthy. The most common cause is the
CircuitBreaker rolled back the Fargate service to the previous
task definition revision (the deploy rolled out a bad revision).
Verify with:

```bash
aws ecs describe-services --cluster identity-backend-dev --services identity-backend
# Look at "deployments[0].rolloutState" — should be "COMPLETED" not "FAILED"
```

If `rolloutState=FAILED`, force a new deployment with the last
known-good task definition:

```bash
PREV=$(aws ecs list-task-definitions --family-prefix identity-backend \
  --sort DESC --query 'taskDefinitionArns[1]' --output text | awk -F: '{print $NF}')
aws ecs update-service --cluster identity-backend-dev \
  --service identity-backend --task-definition $PREV
```

### ⚠️ STUCK POINT #22 — "curl returns 200 but my mobile app can't reach it"

The mobile app must be **rebuilt** with the new API URL. The
mobile app's configuration is the API URL — `api.example.com`
(or `api-dev.example.com` for the dev stage). A TestFlight
build pointing at `api-staging.example.com` will not reach
`api-dev.example.com`. Coordinate the mobile release with the
backend deploy.

### ⚠️ STUCK POINT #40 — "RDS rejects with `IAM role ARN value is invalid or does not include the required permissions for: ENHANCED_MONITORING`"

You will hit this on the **first** `pnpm sst deploy --stage <stage>`
when `monitoringInterval: 60` is set in `sst.config.ts#database`.
Two distinct causes, both produce the same error message:

**Cause 1 — wrong trust principal (was a code bug, now fixed).**
The trust policy for the RDS Enhanced Monitoring role MUST
use `Service: monitoring.rds.amazonaws.com` — NOT
`Service: rds.amazonaws.com` (which is the wrong service
for the monitoring feature). The Pulumi issue tracker has
multiple reports of the same error when the trust principal
was wrong; the fix is the literal string `monitoring.rds.amazonaws.com`.
Current `sst.config.ts` uses the correct value at line 153.

**Cause 2 — IAM eventual consistency / no `dependsOn`.**
IAM is eventually consistent. The `rdsMonitoringRole` is created
in the same Pulumi call as the `rds.aws.Postgres` instance; if
the managed-policy attachment hasn't propagated by the time
RDS validates the role, the create fails with the same error.
The `sst.config.ts` now sets `args.dependsOn = [rdsMonitoringRole]`
on the instance transform — Pulumi serializes the role's
creation before issuing `CreateDBInstance`. If you see this
error on a fresh deploy, the `dependsOn` may be missing —
check line ~177 of `sst.config.ts` and re-deploy.

**Cause 3 — operator IAM missing `iam:PassRole`.** RDS
rejects `CreateDBInstance` with the same error if the
**deployer** (your IAM user, not the role being assumed) does
not have `iam:PassRole` on the `*-DatabaseMonitoringRole-*`
role ARN. `PowerUserAccess` does NOT include `PassRole`. The
fix is an inline policy on your IAM user:

```json
{
  "Effect": "Allow",
  "Action": "iam:PassRole",
  "Resource": "arn:aws:iam::*:role/*-DatabaseMonitoringRole-*"
}
```

The resource pattern scopes the permission to roles SST
creates with that suffix; broader patterns work but violate
least-privilege. After attaching the inline policy, re-run
`pnpm sst deploy` — the deploy will resume from the failed
state and only the RDS instance needs to be created.

**How to tell which cause it is:**

- **Cause 1:** `git grep "rds.amazonaws.com" sst.config.ts` shows
  the wrong string. (Should be `monitoring.rds.amazonaws.com`.)
- **Cause 2:** the role exists in the IAM console
  (`aws iam get-role --role-name identity-backend-...-DatabaseMonitoringRole-...`)
  with the right trust policy, AND your IAM user has
  `iam:PassRole`, AND the error is reproducible on every
  fresh deploy (not a one-time race). The fix is
  `dependsOn`; if it's already in `sst.config.ts`, the
  provider bug has resurfaced.
- **Cause 3:** the error fires _every_ deploy, even after
  Cause 2 is fixed. The deployer IAM is missing `PassRole`.

**Sources:** [AWS docs on Enhanced Monitoring IAM](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_Monitoring.OS.Enabling.html),
[Terraform issue #5559](https://github.com/hashicorp/terraform-provider-aws/issues/5559),
[Pulumi issue #5628](https://github.com/pulumi/pulumi/issues/5628),
[Pulumi issue #393](https://github.com/terraform-aws-modules/terraform-aws-rds/issues/393).

### ⚠️ STUCK POINT #41 — "I don't have a Cloudflare zone. Can I just use the auto-generated ALB URL?"

Yes. The deploy supports an **Auto-URL** path that skips the
Cloudflare integration entirely. See **Step 7.0 — Choose your
URL strategy** above. Short version:

- Do **not** set `CLOUDFLARE_ZONE_ID` or `API_HOSTNAME` in `.env`.
- Do **not** `sst secret set CLOUDFLARE_API_TOKEN`.
- `pnpm sst deploy` runs the same `sst.aws.Service` + RDS + LGTM
  pipeline, but skips the `cloudflare.DnsRecord` and
  `applyEdgePolicy` calls.
- The deploy prints the raw ALB URL at the end:
  `https://identity-backend-<stage>-<hash>.<region>.elb.amazonaws.com`.
  That URL is what `service.url` resolves to.
- The ALB is reachable on its public DNS name with whatever TLS
  the ALB's default cert provides. Browsers will warn about the
  hostname mismatch; `curl -k` works. The certificate is for
  the ALB's region-wildcard, not your domain.
- You lose: edge WAF (OWASP / SQLi), edge rate limiting
  (`cf.unique_visitor_id` per-class limiting on Business plan),
  Authenticated Origin Pulls (mTLS from Cloudflare to ALB),
  custom domain. The backend's per-JWT origin rate limiter still
  runs — keyed on `RATE_LIMIT_POD_DIVISOR`.
- `TURN_REALM` defaults to `turn.localhost` (no `API_HOSTNAME`
  to derive from), so TURN credentials are syntactically valid
  but the realm won't be reachable from the public internet.

**When to use Auto-URL:** personal/dev stages, first-time-deploy
smoke testing, evaluating the stack before committing to a
Cloudflare account, ephemeral `ryan`-style scratch stages.

**When NOT to use Auto-URL:** any user-facing or production-ish
stage. The ALB is naked — no WAF, no rate limit, no AOP. A
bad actor who discovers the ALB DNS can hammer `/api/v1/auth/*`
at full L7 rate from any IP. The origin per-JWT rate limiter
catches authenticated abuse but does nothing for the
unauthenticated `/api/v1/usernames/search` flood.

**Promoting Auto-URL → Cloudflare later:** set
`CLOUDFLARE_ZONE_ID` and `API_HOSTNAME` in `.env`, set
`CLOUDFLARE_API_TOKEN` via `sst secret set`, and re-run
`pnpm sst deploy`. The `cloudflare.DnsRecord` and
`applyEdgePolicy` resources are created on the next apply; the
ALB URL keeps working until the DNS record propagates. The
2-knob invariant (`RATE_LIMIT_PROFILE` and `CLOUDFLARE_PLAN`)
does not change — you can keep using the same `.env` values.

### ⚠️ STUCK POINT #42 — "The deploy prints an ALB URL, but `curl` to it hangs"

Five causes in order of likelihood:

1. **First-deploy cold start** — LGTM takes 5–10 minutes to
   warm up, the service depends on it for OTel, and the Fargate
   task may be in `PENDING` for that whole window. `aws ecs
   describe-services --cluster identity-backend-<stage>
   --services identity-backend` shows `deployments[0].rolloutState`.
2. **Health check path mismatch** — the ALB target group hits
   `/readyz` (defined in `infra/service.ts#loadBalancer.health`).
   If your app version doesn't serve 200 on `/readyz`, the target
   group marks every instance unhealthy and the ALB has no backends
   to route to (returns 503). Tail the container logs:
   `aws logs tail /ecs/identity-backend-<stage> --follow`.
3. **Security group blocks the ALB → task connection** — the
   Fargate task's security group must allow inbound from the
   ALB's security group on port 8080. SST sets this up
   automatically; if you customized the VPC, verify with
   `aws ec2 describe-security-groups`.
4. **ALB in private subnets with no route to the public
   internet for clients** — this should not happen in a
   default SST `sst.aws.Service` setup (the ALB is in public
   subnets, the Fargate task in private subnets with a route
   to the ALB). Verify in the AWS console → EC2 → Load
   Balancers → pick the ALB → Subnets.
5. **The ALB's listener is on a port your curl is not using** —
   the service is configured `443/https → 8080/http`. `curl
   http://...` (port 80) returns 403; `curl https://...:443`
   is the right path. If you typed the bare hostname without
   `https://`, the request lands on port 80 and the listener
   rule rejects it.

If the URL is on the ALB but you want a stable hostname for
local dev, `dig +short <alb-dns>` returns the ALB's IPs and
you can put them in `/etc/hosts` for testing. Do not commit
those IPs to a repo — they change on every Fargate redeploy.

---

## Step 9 — Pre-promotion checklist

Before declaring the first deploy "done":

- [ ] `pnpm sst diff --stage <stage>` shows no pending changes.
- [ ] `curl https://<api>/readyz` returns 200.
- [ ] The LGTM dashboard shows the "Identity Backend API"
      service reporting metrics (Open the Grafana URL, go to
      Explore → Prometheus, query `up{job="identity-backend"}`).
- [ ] A test push from the server reaches a real device
      (Android: FCM; iOS: APNs).
- [ ] The on-chain attester has non-zero
      `AttestationAllowance` (verify via Polkadot.js Apps
      → Developer → Chain state → peopleLite → attestationAllowance
      → <your-SS58-address>).
- [ ] The Cloudflare zone shows "Active" in the dashboard
      Overview (nameserver propagation complete).
- [ ] The alert webhook fires on a test alert (in Grafana
      → Alerting → contact points → Test).

---

## Step 10 — Post-deploy: where the system tells you what it just did

The deploy is "done" when `pnpm sst deploy --stage <stage>`
returns 0. But the deploy did not just "stand up a server" —
it stood up a database pool, a chain RPC subscription, an OTel
exporter, six background daemons, and a rate limiter. **The
first 30 minutes of CloudWatch logs are where the system
reports its own configuration.** The current walkthrough ends
at `curl /readyz` and never tells the operator to read the
startup logs. This step is the missing half.

### ⚠️ STUCK POINT #27 — "I never see the pool size in the logs"

The `db:migrate && bun run start` flow is fully silent about
its database pool configuration. There is no `Effect.logInfo`
emitted at pool creation. The pool is created inside
`drizzle.ts:73-92` and the only way to know `max=25` was used
is to read the env var yourself, **or** to look at the
Prometheus metric `app_db_pool_sessions_total` once the
`pg-monitor` daemon ticks. The first `pg-monitor` poll fires
30 s after the worker starts (`pollInterval: 30s`); you should
see `app_db_pool_sessions_total` in Grafana within the first
minute.

**Pool sizing math (the operator needs to do this):**

```
active_pools = (replicas currently serving) × DB_POOL_MAX
              = (current task count) × 25    [default]
              = 1 × 25 = 25 at min scale
              = 10 × 25 = 250 at max scale
```

Each pool wants `DB_POOL_MAX` logical connections. The
RDS Proxy in front of RDS multiplexes those into a smaller
number of physical connections. The default RDS Proxy
`MaxConnectionsPercent` is **90** of the proxy's
"max capacity" (which depends on the underlying instance
class — for `db.t4g.small` it is ~135, for `db.m5.large`
it is ~1000). So the proxy is _probably_ the bottleneck
long before the RDS instance is.

**Verification you can do right now (Grafana, ≥1 minute
after first deploy):**

1. Open the **Identity Backend API** dashboard.
2. In the "Database" panel (or add a new one with the
   Prometheus datasource UID `prometheus`), query:
   - `app_db_pool_sessions_total` — current sessions
   - `app_db_pool_sessions_active` — actively running
   - `app_db_pool_sessions_idle` — idle
   - `app_db_pool_sessions_waiting_lock` — blocked
   - `app_db_server_max_connections` — the RDS instance's
     `max_connections` setting
   - `app_db_server_connections` — total server-side
     connections
3. Run the same query for the leader-election pool:
   - `app_db_leader_pool_*` if exposed. (The leader-election
     pool is a separate `postgres(...)` call with
     `LEADER_DB_POOL_MAX=50` default; both pools share the
     same RDS instance.)

**Decision rule:** if `app_db_server_connections` ever sits
above 80% of `app_db_server_max_connections` for more than
5 minutes under load, raise the RDS instance class (more
`max_connections`) or lower `DB_POOL_MAX`. The proxy
multiplexes, so it usually does not show up here; the
_server_ value is the raw Postgres count.

### ⚠️ STUCK POINT #28 — "I changed `DB_POOL_MAX` but the running pods ignore it"

Secrets and config are NOT hot-reloaded. The
`apps/identity-backend/src/config.ts` reads `DB_POOL_MAX`
from `process.env` ONCE at task start. The next `sst deploy`
after a `.env` edit will build a new image with the new
default, push to ECR, and roll the fleet — but **running
tasks** still hold the old value. To apply immediately,
force a new deployment:

```bash
aws ecs update-service --cluster identity-backend-<stage> \
  --service identity-backend --force-new-deployment
```

This rolls the fleet to the new image. There is no
`/admin/reload-config` route; there is no SIGHUP; there is
no S3-stored config. SST secrets are the same — they are
read at task start and held for the task's lifetime.

### ⚠️ STUCK POINT #29 — "My OTel exporter says 'connection refused' for the first 2 minutes"

`OTEL_EXPORTER_OTLP_ENDPOINT` points at the LGTM
**service** (not the ALB). Service-discovery via
ECS service-connect takes 30–60 s to resolve on first
task boot. During that window the OTel exporter
emits:

```
getaddrinfo ENOTFOUND identity-backend-lgtm-dev.<svc>.local
```

This is **logged, not fatal**. The app continues to start
and serve traffic; spans/ metrics that fire in the first
minute are simply dropped. The exporter retries
indefinitely, so once the service DNS is resolvable,
metrics resume. **No action needed** — verify by tailing
the log group and looking for the message to stop
appearing after ~2 minutes.

If the message persists past 5 minutes, the LGTM service
itself is unhealthy. Open the LGTM Grafana URL (the
deploy printed it as `grafana: <url>`) and check
`/api/health` returns 200. If it does not, the LGTM
container is stuck — most often because the EFS mount
target is in a single AZ that is currently unavailable.

### ⚠️ STUCK POINT #30 — "My migration succeeded once but every subsequent deploy re-runs all migrations"

Drizzle tracks applied migrations in the `__drizzle_migrations`
table inside the database. The migration runner
(`bun drizzle-kit -- migrate`) is idempotent — it inspects
the table and only applies migrations not yet recorded.

**If you see all migrations re-apply on every deploy, the
table is missing or in a different schema.** Two common
causes:

1. **You connected `DATABASE_URL` to the wrong database.**
   The SST-injected `DATABASE_URL` is the default
   `identity_backend` database. If you overrode
   `DATABASE_URL` in `.env` and pointed at a fresh
   Postgres instance, the `__drizzle_migrations` table
   is empty there.
2. **You are running migrations against a read-replica.**
   Drizzle does not detect this; the INSERTs into
   `__drizzle_migrations` either fail silently or are
   silently dropped. The deploy succeeds, the app boots
   without schema, and the first request 500s.

**Verify:** from ECS Exec:

```bash
psql $DATABASE_URL -c "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 5;"
# If this returns 0 rows, the table is in a different schema or database
```

### ⚠️ STUCK POINT #31 — "The first `peopleLite.increase_attestation_allowance` is on the WRONG chain"

The backend's `ATTESTER_PUBLIC_KEY` is a 32-byte sr25519
public key. The on-chain identifier for the allowance is
an **SS58 address** derived from that key. The mapping
is one-to-one but the _chain_ you submit to matters:

| Network  | People chain WSS                       | Asset Hub WSS                             |
| -------- | -------------------------------------- | ----------------------------------------- |
| paseo    | `wss://people-paseo.dotters.network`   | `wss://asset-hub-paseo.dotters.network`   |
| westend2 | `wss://people-westend-rpc.polkadot.io` | `wss://asset-hub-westend-rpc.polkadot.io` |
| polkadot | `wss://people-rpc.polkadot.io`         | `wss://asset-hub-rpc.polkadot.io`         |

(`wss://` may be `ws://` for chopsticks / local; the operator
on production MUST use `wss://`.)

The chain admin needs to submit the allowance on the
**People chain** for the username attestation
(`peopleLite.increase_attestation_allowance`, call 0) AND
on **Asset Hub** for the dotNS gateway
(`dotnsGateway.increase_attestation_allowance`, call 2)
**independently**. Each chain has its own allowance
table; granting on one does not grant on the other.

**Verify each allowance is non-zero** (Polkadot.js Apps →
Chain state → peopleLite → attestationAllowance →
`<SS58-from-ATTESTER_PUBLIC_KEY>`).

### ⚠️ STUCK POINT #32 — "The EFS mount target is in the wrong AZ and the LGTM task won't start"

`infra/observability.ts:12-19` creates one EFS per stage.
EFS **mount targets** are per-AZ. The `sst.aws.Service`
places the LGTM task in a private subnet; if that subnet's
AZ does not have a mount target, the task fails to mount
on the very first boot and the EFS attach times out.

**Symptom:** the LGTM service events show
`ResourceInitializationError: failed to invoke EFS mount
utility`. The EFS is in the VPC; the issue is the
specific subnet the task landed in.

**Fix:** `sst.aws.Efs` with no `mountTargets` override
should create one per AZ automatically. If you see this
error, run:

```bash
aws efs describe-mount-targets --file-system-id <fs-id>
# Confirm 1 mount target per AZ the cluster uses
```

If a subnet's AZ is missing a target, the easiest fix
is to redeploy — SST's `Efs` resource will create the
missing target. (This is a Pulumi-level diff; the operator
sees "1 added" in the diff output.)

### ⚠️ STUCK POINT #33 — "I see `FetchError: failed to fetch` against the OIDC issuer URL"

The app's `Runtime` does **not** call OIDC. There is no
SSO/OIDC integration in the deploy. If you see this in
the log, the most likely source is the OTel exporter
trying to authenticate to a custom collector that uses
OIDC bearer tokens — but the deploy uses `http/protobuf`
without auth, so the error is from somewhere else
(probably a misconfigured Cloudflare Workers AI proxy
or a browser-side fetch in a debug route).

The two debug routes that DO make outbound HTTP are
`/debug/heapdump` (no outbound) and the swagger
fetcher (in `api-docs` mount, no runtime fetch). So
"FetchError" with no source URL in the log is almost
always from a client request that timed out and was
retried — the server-side log line captures the
client-supplied URL. **The fix:** find the request
in the access log (or Grafana Tempo for the trace) and
diagnose client-side.

### ⚠️ STUCK POINT #34 — "My Cloudflare rule is silently disabled (quota overage)"

`infra/edge.ts#assertPlanQuotaFits` is a **deploy-time
safety net** — it throws at synth time if the rule count
exceeds the plan's quota. BUT the Cloudflare API is the
final word: if you set `CLOUDFLARE_PLAN=pro` in the
operator's shell but the _Cloudflare account_ is on the
Free plan, the ruleset apply fails at the Cloudflare
API with a vague `10000 errors: rateLimit: rateLimit
exceeded plan limit`. The deploys succeeds (Pulumi sees
a 200), but **Cloudflare silently disables the
over-quota rules** and emails the account owner.

**Symptom:** the deploy's stdout says "Ruleset
identity-backend-rate-limit applied" but `dig` shows
the edge is passing requests through without rate
limiting. The fix is to align `CLOUDFLARE_PLAN` with
the actual Cloudflare billing plan (stuck point #6) AND
to verify in the Cloudflare dashboard (Security → WAF →
Rate limiting rules) that all rules show "Active".

### ⚠️ STUCK POINT #35 — "The custom WAF rule blocks my own operator browser session"

The custom firewall includes:

```
BLOCKED_USER_AGENTS = ['curl', 'python-requests', 'Go-http-client',
                       'Wget', 'okhttp', 'Scrapy', 'libwww-perl']
```

If your smoke test uses `curl -I` (User-Agent `curl/8.x`),
the edge returns `403` and you assume the origin is down.
**Use `curl -A "Mozilla/5.0"` (or any non-flagged UA) for
operator smoke tests.** Or open the URL in a real browser.

The list is intentionally aggressive: the official apps
(iOS, Android, web) use UA strings that do not match any
of the entries. A blocked UA here is a strong signal of
scripted abuse.

### ⚠️ STUCK POINT #36 — "My `/admin/nuke` button is exposed at the edge"

It is **not** — `infra/edge.ts:281-294` lists
`/admin` and `/admin/` as exact-match blocks AND
`/admin/` as a prefix block (line 301-304). The
ALB health check hits these inside the VPC, not through
the edge, so the block does not affect the
operator's `app.route('/admin', adminRoute)`. The
admin tree is gated **twice**: by Cloudflare at the
edge, by basic-auth at the origin. This is a
defense-in-depth pattern, not a redundancy.

**If you see admin traffic in the ALB access logs**, it
came from inside the VPC — an ECS Exec, a VPN session,
or a jumpbox. The edge never sees it. Confirm with
the ALB access log column `client_ip` — VPC-internal
IPs (`10.0.0.0/16` range) are the only source.

### ⚠️ STUCK POINT #37 — "Pulumi backend says 'lease is already held'"

The Pulumi state backend uses optimistic concurrency.
If two operators run `pnpm sst deploy --stage dev`
simultaneously, the second one fails with:

```
error: the current deployment already has the lock; ...
```

The lease TTL is 5 minutes. **The fix is to wait
5 minutes and re-run** — do not cancel the lease from
the Pulumi console (the in-flight deploy holds a real
lock and cancelling it leaves the stack in an
indeterminate state).

If you self-host the Pulumi backend (S3 + DynamoDB),
the DynamoDB table holds the lock row. Check it with:

```bash
aws dynamodb get-item --table-name pulumi-state-locks \
  --key '{"LockID":{"S":"<bucket-prefix>-<stack>-<resource>"}}'
```

The row expires after the lease TTL; the lock is
released automatically.

### ⚠️ STUCK POINT #38 — "I have `RATE_LIMIT_PROFILE=shared-nat` but per-IP rate limits are firing"

This is the expected behavior. `shared-nat` profile
**disables per-IP rate limiting at the origin** (the
key is the JWT subject instead, via the
`@identity-backend/rate-limit` middleware). The edge
emits per-IP rules for unauthenticated paths via the
**coarse `ip.src` key** — one rule for the public
path family, one for the authenticated path family.
With `shared-nat`, multiple principals share one IP;
one principal hammering the API will **not** be the
target of the per-IP rule because every other
principal shares its bucket.

The origin's per-JWT limiter is the per-principal
control. If JWT rate limits are not firing, the
client is not authenticated — i.e. they are hitting
public-read endpoints (`/api/v1/usernames/search`,
`/api/v1/schemas`, etc.), which by design have
**no origin rate limit** in the `shared-nat` profile.
The edge absorbs them. If the edge rate limit fires,
it returns `429` with the JSON ProblemDetail body
(the `jsonResponse` constant in `infra/edge.ts:37-42`).

### ⚠️ STUCK POINT #39 — "I see the testflight build hitting a 403, not 401"

`ENFORCE_AUTH=true` is required for the App Attest
hard-gate to be active (and App Attest is required
to mint a JWT). The default is `false` (soft gate).
The 403 / 401 distinction comes from the route's
`Match.tag` mapping; the testflight build is
hitting a route with `authPlugin` mounted but
`ENFORCE_AUTH=false`, so the absence of a valid
JWT is treated as **401** (the iOS client's token
is expired or was never minted — likely the App
Attest exchange failed). A 403 means the JWT is
present but the platform attestation claim
(`appFromOfficialStore` or `plt=ios|android`) is
failing. Check the OTel span for the auth route to
see which tag fired.

## Step 11 — Pre-promotion checklist (expanded)

The original Step 9 checklist verifies "is it up."
This expanded list verifies "is it **right**":

- [ ] `pnpm sst diff --stage <stage>` shows no pending
      changes.
- [ ] `curl https://<api>/readyz` returns 200.
- [ ] `curl https://<api>/livez` returns 200.
- [ ] `curl https://<api>/healthcheck` returns 200 with
      a JSON body containing `uptime`, `responseTime`,
      `message: 'OK'`, `timestamp` (this exercises the
      full DB ping path, not just process liveness).
- [ ] The LGTM dashboard shows the "Identity Backend API"
      service reporting metrics.
- [ ] `app_db_pool_sessions_total` is **non-zero** in
      Grafana (the web pool is alive and connected).
- [ ] `app_db_server_max_connections` is **> 0** and
      matches the RDS instance class expectation
      (`db.t4g.small` = 225, `db.m5.large` = 1609,
      `db.m6g.xlarge` = 2834 — full table at
      <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.html>).
- [ ] `app_db_server_connections` is **< 80% of
      `app_db_server_max_connections`** at peak load.
- [ ] A test push from the server reaches a real device
      (Android: FCM; iOS: APNs).
- [ ] The on-chain attester has non-zero
      `AttestationAllowance` on the People chain
      (verify via Polkadot.js Apps → Developer →
      Chain state → peopleLite → attestationAllowance
      → `<SS58-from-ATTESTER_PUBLIC_KEY>`).
- [ ] If `DOTNS_GATEWAY_ENABLED=true`: the attester has
      non-zero `AttestationAllowance` on **Asset Hub**
      (chain state → dotnsGateway → attestationAllowance
      → `<SS58>`). Independent of the People chain.
- [ ] The Cloudflare zone shows "Active" in the
      dashboard Overview (nameserver propagation
      complete).
- [ ] The Cloudflare dashboard Security → WAF shows all
      ruleset entries "Active" (no silent disable).
- [ ] The alert webhook fires on a test alert (in
      Grafana → Alerting → contact points → Test).
- [ ] `aws ecr describe-images --repository-name
      identity-backend-<stage>` shows the latest
      pushed image with tag matching
      `sst-<commit-sha>` (proves the local Docker
      build + push path works end-to-end).
- [ ] The LGTM Grafana URL loads (the `grafana: <url>`
      output of `pnpm sst deploy`) and the Identity
      Backend API dashboard renders without errors.
- [ ] `pnpm observability:render-contact-points`
      exits 0 (re-running the renderer is a
      smoke test that the secret is still set).

---

## Appendix A — Common first-deploy command reference

```bash
# SST
pnpm sst deploy --stage <stage>
pnpm sst diff   --stage <stage>
pnpm sst remove --stage <stage>
pnpm sst console --stage <stage>
pnpm sst secret set <NAME> <value> --stage <stage>
pnpm sst secret list --stage <stage>

# AWS
aws ecs list-tasks --cluster identity-backend-<stage> --desired-status RUNNING
aws ecs describe-services --cluster identity-backend-<stage> --services identity-backend
aws ecs update-service --cluster identity-backend-<stage> --service identity-backend --force-new-deployment
aws logs tail /ecs/identity-backend-<stage> --follow

# Cloudflare
dig NS example.com @8.8.8.8
dig api.example.com @1.1.1.1
curl -H "Authorization: Bearer <CF_TOKEN>" "https://api.cloudflare.com/client/v4/zones"

# Polkadot
# Polkadot.js Apps: https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Fpeople-paseo.dotters.network
# Or via the chain's RPC directly with curl + JSON-RPC

# DB pool observability
# (after ≥30s for the first pg-monitor tick)
curl -s "http://<grafana-url>/api/datasources/proxy/uid/prometheus/api/v1/query?query=app_db_pool_sessions_total" | jq

# Local Docker / ECR
aws ecr describe-images --repository-name identity-backend-<stage>
docker ps  # confirm daemon running
docker buildx ls

# Pulumi state
aws dynamodb get-item --table-name pulumi-state-locks \
  --key '{"LockID":{"S":"<key>"}}'
```

## Appendix B — If all else fails

[`docs/runbook-failure-modes.md`](./runbook-failure-modes.md)
covers FM-1 through FM-7 with diagnostic flows and immediate
fixes. If you are stuck past step 8, FM-1 (5xx), FM-3 (chain
stalled), FM-5 (secrets), and FM-7 (AuthenticatedOriginPulls)
are the most likely matches for "I just deployed and
something is wrong."

## Appendix C — Quick-reference for the new stuck points

| #  | Stuck point                                               | Step               | Resolution time  |
| -- | --------------------------------------------------------- | ------------------ | ---------------- |
| 23 | No Docker daemon                                          | 7.1                | 10 min           |
| 24 | No `ecr:PutImage` / `ecr:UploadLayerPart`                 | 7.1                | 5 min            |
| 25 | `x509: certificate signed by unknown authority`           | 7.1                | 2 min            |
| 26 | `PEOPLE_RPC_ENDPOINTS` set as bare string                 | 7.2                | 30 s             |
| 27 | No pool size in startup logs                              | 10 (NEW)           | 5 min (Grafana)  |
| 28 | Config change ignored by running pods                     | 10                 | 2 min (force)    |
| 29 | OTel `getaddrinfo ENOTFOUND` for first 2 min              | 10                 | Wait             |
| 30 | Migrations re-run every deploy                            | 10                 | 10 min           |
| 31 | Allowance on wrong chain / missing on AH                  | 6.2                | Coordinator      |
| 32 | EFS mount target in wrong AZ                              | 7.3 (deploy)       | 10 min (retry)   |
| 33 | `FetchError` misattribution                               | 8 (verify)         | 5 min            |
| 34 | Cloudflare rule silently disabled                         | 3.3 (CF setup)     | 5 min (verify)   |
| 35 | `curl` smoke test 403'd by edge UA block                  | 8 (verify)         | 30 s             |
| 36 | `/admin` exposed at edge? (No — defense in depth)         | (reassurance)      | —                |
| 37 | Pulumi lock race                                          | 7.4 (deploy)       | 5 min (wait)     |
| 38 | `shared-nat` per-IP limits not firing as expected         | 8 (verify)         | (by design)      |
| 39 | 403 vs 401 in testflight build                            | 8 (verify)         | 5 min (OTel)     |
| 40 | RDS `IAM role ARN value is invalid` (Enhanced Monitoring) | 7.3 (deploy)       | 5 min (diagnose) |
| 41 | No Cloudflare zone — can I use the ALB URL?               | 7.0 (URL strategy) | 0 min (decision) |
| 42 | ALB URL prints but `curl` hangs                           | 8 (verify)         | 5 min (diagnose) |
