# Residual Review Findings

**Branch:** `2821-endpoints`
**Plan:** `docs/plans/2026-06-14-001-fix-request-body-size-caps-plan.md`
**Issue:** #2821 — Apple attestation + v1 endpoints accept unbounded request bodies

## Resolved in the constitutional rewrite (2026-06-14)

- **[P2 — test gap] CLOSED.** The body-size gate is now covered by a composition test at
  `apps/identity-backend/src/middleware/__tests__/body-size-limit.middleware.test.ts`. It drives the real
  `registerBodySizeLimits` through Hono requests and asserts: a body at the cap reaches the handler; one byte over
  is rejected with a `413` `application/problem+json` ProblemDetail carrying the `payload-too-large` slug _before_
  the handler runs (proven by a handler spy that stays at 0); the per-family caps (attestation, notify, catch-all)
  apply correctly; the `Content-Length` fast-path rejects; and `app.body_size_rejections_total` increments by 1 per
  rejection. 7 tests, all green.

- **[P3 — metric degrades 413→500] CLOSED.** The `Metric.update` in the gate's `onError` is now wrapped in
  `Effect.catchAllCause(() => Effect.void)`, so a counter failure can never throw out of the Hono callback — the
  413 is always returned. (No `Effect.logError` inside the catch: forbidden by `no-logging-in-catch`.)

- **[P3 — `refreshToken` unbounded] CLOSED.** `RefreshTokenRequest.refreshToken` now has `.max(128)`
  (`routes/v1/token/types.ts`).

- **[P3 — `bundlerId` unbounded] CLOSED.** `bundlerId` now has `.max(256)` (Zod) and `S.maxLength(256)` (Effect
  Schema) in `routes/v1/notify/types.ts`.

- **[P3 — stale `/api/v1/token` in handshake class] CLOSED.** The dead path was removed from the `handshake`
  `EndpointClass` in `infra/edge.ts`; the real token route is `/api/v1/auth/token`, already covered by the
  `/api/v1/auth/` prefix. The new WAF body-size rule keys on `byRef('handshake')`, so it is now precise.

- **[security — notify had no edge body rule] CLOSED.** A ce-compound security review found the Cloudflare WAF
  body-size rule keyed on `byRef('handshake')` (= `/api/v1/auth/` only), leaving `/api/v1/notify/*` — which shares
  the same 16 KB origin cap — with no edge body rule. Fixed in `infra/edge.ts`: the rule now keys on
  `OVERSIZED_BODY_CAP_PATHS = [...byRef('handshake'), '/api/v1/notify']` (ref renamed to
  `block_oversized_tight_cap_bodies`), so both tight-cap families are blocked at the edge above 64 KB.

- **[improvement — hardcoded caps] FIXED.** The original PR hard-coded the byte caps as module constants
  (`MAX_BODY_BYTES_*`). They are now env-tunable `Config` values in `apps/identity-backend/src/config.ts`
  (`MAX_BODY_BYTES_HANDSHAKE`, `MAX_BODY_BYTES_DEFAULT`, `MAX_BODY_BYTES_SERVER`, each validated `>= 1` via
  `positiveIntBudget`, with the prior values as defaults), mirroring `RATE_LIMIT_*`. An operator can now raise a cap
  (e.g. if a vendor attestation format grows) without a code deploy. Structural values (route path patterns, family
  names) stay in code; only the tunable byte caps moved to config. The policy was also extracted from the 312-line
  `app.ts` composition root into a named, testable `body-size-limit.middleware.ts`.

## New finding discovered during the rewrite (NOT fixed — out of scope)

- **[P3] `infra/edge.ts` — `token_refresh` `EndpointClass` path is stale.** Its path is `/api/v1/token/refresh`,
  but the real route mounts at `/api/v1/auth/token/refresh` (`routes/v1/mod.ts:78`, nested under `/auth`). The
  stale path matches nothing, so token-refresh requests currently fall through to the `handshake` bucket (10 req/min)
  instead of the intended `token_refresh` bucket (30 req/min). **Deliberately not fixed here:** this is a rate-limit
  semantics change orthogonal to body-size caps, and per Constitution §V.2 (scope discipline) it warrants its own
  issue and a §V.5 challenge before changing a production rate limit. Flagged openly per §V.6 (no silent bypass).

## Advisory findings (library/transport behaviour, not actionable)

- Hono `bodyLimit` trusts `Content-Length` without stream verification (library behaviour; the Bun transport layer
  and the `MAX_BODY_BYTES_SERVER` ceiling bound the real risk).
- `bodyLimit` has no streaming timeout for chunked requests (library behaviour; mitigated by the Cloudflare edge and
  Bun connection limits).
- The WAF rule blocks with a Cloudflare 403, not a ProblemDetail 413 (edge-layer behaviour by design).
- `Bun.serve` returns a plain-text 413, not a ProblemDetail (transport-layer behaviour; the Hono gate is the
  application-layer ProblemDetail gate that fires first under the server ceiling).
- Overlapping `use` middleware on `/api/v1/auth/*` and `*` means a handshake request runs two `bodyLimit` checks
  (minor overhead, bounded by the tighter cap firing first).
