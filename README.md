> [!CAUTION]
> **This repository is being archived.** Development has moved to **[`paritytech/device-uniqueness-backend-community`](https://github.com/paritytech/device-uniqueness-backend-community)**, which is now the active backend. Use that repository for issues, pull requests, deploys, and the latest releases. Everything here is kept for historical reference only and will no longer receive updates.

> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.

> [!IMPORTANT]
> **Are you a deploy operator?** You are in the right place, but this README is for contributors and developers. For production deploys read **[`infra/README.md`](./infra/README.md)** first — it has the Quick Start, the per-topic walkthroughs, the two-knob reference, the cost notes, and the pinned-version table. The single best next page for a new operator is **[`infra/docs/first-time-setup.md`](./infra/docs/first-time-setup.md)** — 42 stuck points called out before you hit them, from "I have AWS and a credit card" to "the API responds 200".

# Polkadot App Backend

Backend-for-Frontend monorepo for the Polkadot mobile app.

## Apps

| App                                                                            | Purpose                            |
| ------------------------------------------------------------------------------ | ---------------------------------- |
| [`apps/identity-backend/`](./apps/identity-backend/)                           | Main HTTP service — see its README |
| [`apps/api-docs/`](./apps/api-docs/)                                           | Scalar API reference               |
| [`apps/backend-cli/`](./apps/backend-cli/)                                     | AI guard-rail CLI wrapper          |
| [`apps/identity-backend-e2e/`](./apps/identity-backend-e2e/)                   | E2E test suite                     |
| [`apps/e2e-people-startup-container/`](./apps/e2e-people-startup-container/)   | E2E chain fixture                  |
| [`apps/identity-backend-load-testing/`](./apps/identity-backend-load-testing/) | k6 load testing                    |

## Quick Start

```bash
corepack enable
corepack pnpm install
docker run -d --name identity-postgres \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=identity \
  -p 5432:5432 postgres:18
pnpm --filter identity-backend-container db:migrate
pnpm --filter identity-backend-container dev
```

Server runs at `http://localhost:8080`.

```bash
curl http://localhost:8080/healthcheck
# {"status":"ok"}
```

## Common Commands

```bash
pnpm test              # unit + integration
pnpm test:e2e:local    # full Docker e2e stack
pnpm typecheck         # type checking
pnpm lint              # oxlint
pnpm check:ci          # lint + typecheck + api:check + migration sync
```

## Security

Before deploying this for real use cases, you are responsible for reviewing the code yourself, checking dependencies for vulnerabilities, securing your deployment environment, and tracking the latest tagged releases for security fixes.

> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.

Report vulnerabilities following [Parity's security policy](https://github.com/paritytech/.github/blob/main/SECURITY.md). For Parity's disclosure process and Bug Bounty programme, see [parity.io/bug-bounty](https://parity.io/bug-bounty).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

Licensed under the **GNU General Public License v3.0** — see [LICENSE](./LICENSE).
