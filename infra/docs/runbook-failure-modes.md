# Failure-Mode Runbook (SST / Fargate path)

> Operational failure modes for the SST-deployed identity-backend
> service. For each, the diagnostic signals, the immediate fix,
> and the prevention note. Aligned with the Grafana alert rules in
> `infra/observability/grafana/alerting/rules.yaml`. The legacy
> k8s/ArgoCD/GCP failure modes (FM-1 through FM-N) are documented
> in the k8s-era internal runbook (excluded from the public
> snapshot) and are not applicable to this deployment.

## FM-1: Service health check flapping (HTTP 5xx ratio high)

**Symptoms:** Grafana alert `http_5xx_ratio_high` fires; ALB target
health `unhealthy`; ECS deployment circuit breaker triggers a
rollback.

**Diagnostic flow:**

```bash
STAGE=<stage>
# 1. Confirm the 5xx ratio (5m window)
aws logs start-query --log-group-name /ecs/identity-backend-$STAGE \
  --start-time $(date -d '-5 minutes' +%s) --end-time $(date +%s) \
  --query-string 'fields @timestamp, @message | filter @message like /5.. / | stats count()'

# 2. Tail recent app logs
aws logs tail /ecs/identity-backend-$STAGE --follow --filter-pattern "ERROR"

# 3. ECS Exec into a healthy task
aws ecs execute-command --cluster identity-backend-$STAGE \
  --task <task-arn> --container app-identity --interactive --command "/bin/sh"
# Inside the task: ls /tmp, env | head, curl localhost:8080/readyz
```

**Immediate fix:**

- If the deployment circuit breaker is rolling back, do nothing —
  the bad task definition revision is being replaced.
- If the service is stable but flapping, force a new deployment
  to pick up any pending fixes:
  `aws ecs update-service --cluster identity-backend-$STAGE --service identity-backend --force-new-deployment`.
- If the issue is a bad config, fix `sst.config.ts#appDeploymentConfig`
  or the relevant SST secret, then `pnpm sst deploy --stage $STAGE`.

**Prevention:** property-tested workflows + the circuit breaker +
IaC. The DoD requires the integration test at the I/O sandwich to
have failed before this is a code bug, not a config bug.

## FM-2: Database connection pool exhaustion

**Symptoms:** Long-tail request latency, `DatabaseConnectionEndedError`
in logs, RDS Proxy connection count at the per-proxy limit.

**Diagnostic flow:**

```bash
# 1. RDS Proxy connection count
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS --metric-name DatabaseConnections \
  --dimensions Name=DBProxyName,Value=identity-backend-proxy-$STAGE \
  --start-time $(date -d '-15 minutes' +%s) --end-time $(date +%s) \
  --period 60 --statistics Average

# 2. Per-pod connection pool utilization
aws logs start-query --log-group-name /ecs/identity-backend-$STAGE \
  --start-time $(date -d '-15 minutes' +%s) --end-time $(date +%s) \
  --query-string 'fields @timestamp, @message | filter @message like /db_pool/ | stats avg(@message) by bin(5m)'
```

**Immediate fix:** force a new deployment to recycle the pod
connection pools:

```bash
aws ecs update-service --cluster identity-backend-$STAGE \
  --service identity-backend --force-new-deployment
```

**Prevention:** `DB_POOL_MAX=25` per pod × N pods = 25 × N
logical connections, multiplexed by RDS Proxy (default 100
physical). If you scale pods past the proxy limit, raise the
proxy's `MaxConnectionsPercent` and `MaxIdleConnectionsPercent`.

## FM-3: Chain finalization stalled

**Symptoms:** Grafana alert `chain_stalled`; registration queue
depth growing; TX inclusion timeouts in logs.

**Diagnostic flow:**

- Open Grafana → Explore → Prometheus → `blockchain_finalized_block`
  to see the last value.
- The WSS endpoints in `PEOPLE_RPC_ENDPOINTS` may have lost
  connectivity. Test from ECS Exec:
  ```bash
  curl -i wss://people-paseo.dotters.network
  # (wscat or a small bun script to do a subscription handshake)
  ```

**Immediate fix:**

- If the RPC provider is down, switch the WSS endpoint by updating
  the SST secret and re-deploying. The app supports a comma-
  separated list; failover is automatic.
- If a chain halt is the cause, monitor Polkadot.js / Element
  announcements and wait.

**Prevention:** the comma-separated `PEOPLE_RPC_ENDPOINTS` env
var (the app reconnects on disconnect); the finalization timeout
guards (`FINALIZED_BLOCK_TIMEOUT=90000`).

## FM-4: Container OOMKilled

**Symptoms:** Grafana shows task restart count increasing; ECS
`describe-tasks` shows `stoppedReason: OutOfMemory`; exit code 137.

**Diagnostic flow:**

```bash
aws ecs describe-tasks --cluster identity-backend-$STAGE \
  --tasks <task-arn> --query 'tasks[0].{stoppedReason:stoppedReason,exitCode:containers[0].exitCode}'
```

**Immediate fix:** bump `memory` in `infra/service.ts` (currently
1 vCPU / 2 GB at idle; SST scales CPU/memory on the
`sst.aws.Service` resource), then `pnpm sst deploy`. The
deployment circuit breaker rolls the fleet automatically if the
new memory is still insufficient.

**Prevention:** the LGTM OTel metrics include
`process.memoryUsage()` — alert on `heap_used > 80%` of the task
memory limit for 5 minutes.

## FM-5: Secrets Manager read failure

**Symptoms:** Container fails to start with `ConfigError: MissingData`
or `ConfigError: InvalidData` for a secret; the app's config layer
cannot decode a base64 / base64url / hex value.

**Diagnostic flow:**

- The error message names the key and the failure class. Read it
  literally — the Config error format is `InvalidData: <key>: <reason>`.
- Confirm the secret exists:
  ```bash
  aws secretsmanager get-secret-value --secret-id identity-backend/$STAGE/JWT_AUTH_SECRET
  ```

**Immediate fix:** `sst secret set <NAME> <correct-value>
--stage <stage>`, then `pnpm sst deploy`. If the format is wrong
(base64 of the wrong file, hex without stripping `0x`, etc.),
re-encode the source material — see `infra/docs/secrets-procurement.md`.

## FM-6: Webhook URL not rendered (alert misrouting)

**Symptoms:** Grafana alert fires but the contact point URL is
literally `__GRAFANA_WEBHOOK_URL__` — provisioning logs in
`/var/log/grafana` show a token-substitution error.

**Immediate fix:**

```bash
# Set the secret and re-render
pnpm sst secret set GrafanaWebhookUrl "https://hooks.slack.com/..." --stage <stage>
pnpm observability:render-contact-points
pnpm sst deploy --stage <stage>
```

The renderer fails loud if the secret is missing or the token
survives substitution.

## FM-7: Authenticated Origin Pulls broken (origin rejecting all traffic)

**Symptoms:** All ALB targets unhealthy; HTTPS handshake failures
in Cloudflare logs; no requests reach the Fargate service.

**Diagnostic flow:**

- Cloudflare → Security → Events: confirm the requests are
  reaching the edge and being forwarded.
- Origin-side: tail CloudWatch for the ALB's TLS errors.
- The most common cause: a stale CA at the ALB that no longer
  matches the Cloudflare-issued client cert. Re-deploy to refresh
  the ALB's trust store.

**Immediate fix:** re-deploy the service to refresh the ALB
listener's mTLS trust.

```bash
pnpm sst deploy --stage $STAGE
```

## FM-8: Invitation-ticket pool contending with username registration

**Symptoms:** username-registration best-block inclusion latency
rises while the invitation-ticket pool is filling; the startup log
carries `INVITER_POOL_PRIVATE_KEY is unset: invitation ticket pool
is sharing the attester proxy signer and will contend with username
registration on the shared submission permit`; `INVITATION_TICKET_POOL_TARGET`
is raised above the default (10000) but no dedicated pool key is set.

**Diagnostic flow:**

```bash
STAGE=<stage>
# 1. Confirm the fallback warning fired at startup (resolved signer address is attached)
aws logs start-query --log-group-name /ecs/identity-backend-$STAGE \
  --start-time $(date -d '-30 minutes' +%s) --end-time $(date +%s) \
  --query-string 'fields @timestamp, @message | filter @message like /INVITER_POOL_PRIVATE_KEY is unset/'
# 2. Confirm the elevated pool target is in effect
aws ecs execute-command --cluster identity-backend-$STAGE --task <task-arn> \
  --container app-identity --interactive --command "/bin/sh -c 'echo $INVITATION_TICKET_POOL_TARGET $INVITATION_TICKET_BATCH_SIZE'"
```

**Root cause:** when `INVITER_POOL_PRIVATE_KEY` is unset the
invitation-ticket pool daemon and username registration share the
single attester proxy signer's submission permit; a large pool
target then starves registration.

**Immediate fix:** register a dedicated invitation-pool account as
a proxy of the attester on-chain (community bootstrap
`12c-setup-attestation-proxy.sh`), set `INVITER_POOL_PRIVATE_KEY`
and re-deploy. Until the
dedicated account is ready, lower `INVITATION_TICKET_POOL_TARGET`
back to the default (10000) so refill traffic is bounded.

**Prevention:** pair `INVITER_POOL_PRIVATE_KEY` with any
`INVITATION_TICKET_POOL_TARGET` / `INVITATION_TICKET_BATCH_SIZE`
above their defaults — the runtime warns at startup when the pool
lacks a dedicated signer.

## Where to look first

| Symptom                                       | Start here                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| 5xx from the API                              | CloudWatch Logs `/ecs/identity-backend-$STAGE`                              |
| Slow requests                                 | LGTM Grafana → Explore → Tempo for the affected request ID                  |
| Alerts firing but not actionable              | `infra/observability/grafana/alerting/rules.yaml` — what does the rule say? |
| Deploy failed                                 | SST console (`pnpm sst console --stage $STAGE`) — most recent deploy event  |
| Secret rotation not taking effect             | Force a new ECS deployment (see FM-5)                                       |
| Cloudflare block in effect for legitimate UA  | `infra/edge.ts#BLOCKED_USER_AGENTS` — add or remove entries as needed       |
| Registration latency rising / pool contention | startup warning `INVITER_POOL_PRIVATE_KEY is unset` → see FM-8              |
