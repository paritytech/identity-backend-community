import { hc } from 'hono/client'
import { Jwt } from 'hono/utils/jwt'
import type { App } from 'identity-backend-container/v1'
import type { StartedDockerComposeEnvironment } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { checkResponseWithBody } from '@identity-backend/testing/hono'
import { JWT_AUTH_SECRET, setupTestEnvironment, teardownTestEnvironment } from '../setup.js'
import { type Puzzle, solvePuzzle } from './username-search-poc.helpers.js'

type TestApp = ReturnType<typeof hc<App>>

describe.skip('Username Search — Proof of Compute', () => {
  let environment: StartedDockerComposeEnvironment
  let app: TestApp

  beforeAll(async () => {
    ;({ environment, app } = await setupTestEnvironment<App>({
      peopleNetwork: 'pop-testnet',
      POC_ENABLED: 'true',
    }))
  })

  afterAll(async () => {
    await teardownTestEnvironment(environment)
  })

  it('Should_BypassPoC_When_JwtPresent', async () => {
    const token = await Jwt.sign(
      { sub: 'bypass-poc-account', exp: Math.floor(Date.now() / 1000) + 3600 },
      JWT_AUTH_SECRET,
      'HS256',
    )

    const response = await app.api.v1.usernames.search.$get(
      { query: { prefix: 'test' }, header: {} },
      { headers: { Authorization: `Bearer ${token}` } },
    )

    await checkResponseWithBody(response, 200)
    expect(response.headers.get('content-type')).toContain('application/json')
  }, 60_000)

  it.skip('Should_Return402_When_PoCRequiredAndMissing', async () => {
    const response = await app.api.v1.usernames.search.$get({
      query: { prefix: 'test' },
      header: {},
    })

    await checkResponseWithBody(response, 402)
    expect(response.headers.get('content-type')).toBe('application/problem+json')

    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      type: expect.stringContaining('payment-required'),
      title: expect.any(String),
      detail: expect.any(String),
      status: 402,
    })
  }, 60_000)

  it('Should_Return400_When_PoCHeaderMalformed', async () => {
    const response = await app.api.v1.usernames.search.$get({
      query: { prefix: 'test' },
      header: { 'Proof-Of-Compute': 'not-valid-base64!!!' },
    })

    await checkResponseWithBody(response, 400)
    expect(response.headers.get('content-type')).toBe('application/problem+json')

    const body = (await response.json()) as Record<string, unknown>
    expect(body.type).toContain('bad-request')
  }, 60_000)

  it('Should_ReturnSearchResults_When_ValidPoCSolutionProvided', async () => {
    const issueResponse = await app.api.v1.poc.issue.$post({})
    await checkResponseWithBody(issueResponse, 201)
    const puzzle = (await issueResponse.json()) as Puzzle

    const header = await solvePuzzle(puzzle)

    const response = await app.api.v1.usernames.search.$get({
      query: { prefix: 'test' },
      header: { 'Proof-Of-Compute': header },
    })

    await checkResponseWithBody(response, 200)
    expect(response.headers.get('content-type')).toContain('application/json')
  }, 60_000)
})
