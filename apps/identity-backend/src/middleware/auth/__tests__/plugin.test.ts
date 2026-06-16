import { describe, expect, it } from 'vitest'

import { ProblemDetailZod } from '#root/lib/problem-details.js'
import type { ProblemDetail } from '#root/lib/problem-details.js'
import {
  ConflictingPlatformHeaders,
  IncompleteAssertion,
  MissingAndroidAttestationChain,
  MissingAttestationTypeHeader,
  MissingAuthHeaders,
  UnknownAttestationType,
} from '@identity-backend/hono-auth/auth'
import { formatAuthError } from '../plugin.js'

const assertProblemDetail = (
  body: unknown,
  expectedStatus: ProblemDetail['status'],
  expectedTitle: string,
) => {
  expect(body).toEqual(expect.schemaMatching(ProblemDetailZod))
  const pd = body as ProblemDetail
  expect(pd.status).toBe(expectedStatus)
  expect(pd.title).toBe(expectedTitle)
  expect(typeof pd.type).toBe('string')
  expect(typeof pd.detail).toBe('string')
}

describe('formatAuthError', () => {
  it('Should_Return401MissingAuthHeaders_When_MissingAuthHeaders', () => {
    const result = formatAuthError(new MissingAuthHeaders())
    expect(result.status).toBe(401)
    expect(result.headers).toEqual({ 'Content-Type': 'application/problem+json' })
    assertProblemDetail(result.body, 401, 'Missing Authentication Headers')
  })

  it('Should_Return401ConflictingPlatformHeaders_When_ConflictingPlatformHeaders', () => {
    const result = formatAuthError(new ConflictingPlatformHeaders())
    expect(result.status).toBe(401)
    expect(result.headers).toEqual({ 'Content-Type': 'application/problem+json' })
    assertProblemDetail(result.body, 401, 'Conflicting Platform Headers')
  })

  it('Should_Return401MissingChain_When_MissingAndroidAttestationChain', () => {
    const result = formatAuthError(new MissingAndroidAttestationChain())
    expect(result.status).toBe(401)
    expect(result.headers).toEqual({ 'Content-Type': 'application/problem+json' })
    assertProblemDetail(result.body, 401, 'Missing Android Attestation Chain')
    const pd = result.body as ProblemDetail
    expect(pd.detail).not.toContain('REQUIRE_CHAIN_FOR_PLAY_INTEGRITY')
    expect(pd.detail).not.toContain('ENFORCE_AUTH')
  })

  it('Should_Return400MissingAttestationType_When_MissingAttestationTypeHeader', () => {
    const result = formatAuthError(new MissingAttestationTypeHeader())
    expect(result.status).toBe(400)
    expect(result.headers).toEqual({ 'Content-Type': 'application/problem+json' })
    assertProblemDetail(result.body, 400, 'Missing Attestation Type Header')
  })

  it('Should_Return400UnknownAttestationType_When_UnknownAttestationType', () => {
    const result = formatAuthError(new UnknownAttestationType())
    expect(result.status).toBe(400)
    expect(result.headers).toEqual({ 'Content-Type': 'application/problem+json' })
    assertProblemDetail(result.body, 400, 'Unknown Attestation Type')
  })

  it('Should_Return401IncompleteAssertion_When_IncompleteAssertion', () => {
    const missing = ['Auth-Payload', 'Auth-iOS-KeyId']
    const result = formatAuthError(new IncompleteAssertion({ missing }))
    expect(result.status).toBe(401)
    expect(result.headers).toEqual({ 'Content-Type': 'application/problem+json' })
    assertProblemDetail(result.body, 401, 'Incomplete App Attest Assertion')
    const pd = result.body as ProblemDetail
    expect(pd.detail).toContain('Auth-Payload')
    expect(pd.detail).toContain('Auth-iOS-KeyId')
  })
})
