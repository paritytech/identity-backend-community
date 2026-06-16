import { describe, expect, it } from '@effect/vitest'
import { checkResponse } from '@identity-backend/testing/hono'
import { Effect, Layer, Match, Schema as S } from 'effect'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import { testClient } from 'hono/testing'
import {
  AndroidAttestationMiddlewareConfig,
  AndroidAttestationOutcome,
  makeAndroidAttestationMiddleware,
} from '../attestation.middleware.js'
import { AuthMiddlewareConfig, makeAuthMiddleware } from '../middleware.js'
import type { AuthMiddlewareErrorFormatter } from '../middleware.js'

const VALID_LEAF = 'dmFsaWQtbGVhZg=='
const INVALID_LEAF = 'aW52YWxpZC1sZWFm'
const UNAVAILABLE_LEAF = 'dW5hdmFpbGFibGUtbGVhZg=='
const DEFECT_LEAF = 'ZGVmZWN0LWxlYWY='
const INTERMEDIATE = 'aW50ZXJtZWRpYXRl'

class FakeVerifyDefect extends S.TaggedError<FakeVerifyDefect>()('FakeVerifyDefect', {}) {}

const fakeVerifyChain: AndroidAttestationMiddlewareConfig['Type']['verifyChain'] = ({ leafCertDer }) => {
  const leaf = new TextDecoder().decode(new Uint8Array(leafCertDer))
  return Match.value(leaf).pipe(
    Match.when('valid-leaf', () => Effect.succeed(AndroidAttestationOutcome.Verified)),
    Match.when('unavailable-leaf', () => Effect.succeed(AndroidAttestationOutcome.Unavailable)),
    Match.when('defect-leaf', () => Effect.die(new FakeVerifyDefect())),
    Match.orElse(() => Effect.succeed(AndroidAttestationOutcome.Rejected)),
  )
}

const layerFakeAndroidAttestation = Layer.succeed(AndroidAttestationMiddlewareConfig, {
  verifyChain: fakeVerifyChain,
})

const mockPlayIntegrityMiddleware = createMiddleware(async (c, next) => {
  if (c.req.header('Auth-Android-Package') === 'invalid') {
    return c.json({ error: 'Invalid Android package' }, 401)
  }
  return next()
})

const mockAppAttestMiddleware = createMiddleware(async (c, next) => {
  const iosPackage = c.req.header('Auth-iOS-Package')
  if (iosPackage === undefined) {
    return c.json({ error: 'Missing iOS package name header' }, 401)
  }
  if (iosPackage === 'invalid') {
    return c.json({ error: 'Invalid iOS package' }, 401)
  }
  return next()
})

const testFormatter: AuthMiddlewareErrorFormatter = (error) =>
  Match.value(error).pipe(
    Match.tag('MissingAuthHeaders', () => ({ body: { _tag: 'MissingAuthHeaders' }, status: 401 as const })),
    Match.tag(
      'ConflictingPlatformHeaders',
      () => ({ body: { _tag: 'ConflictingPlatformHeaders' }, status: 401 as const }),
    ),
    Match.tag('MissingAndroidAttestationChain', () => ({
      body: { _tag: 'MissingAndroidAttestationChain' },
      status: 401 as const,
    })),
    Match.tag(
      'MissingAttestationTypeHeader',
      () => ({ body: { _tag: 'MissingAttestationTypeHeader' }, status: 400 as const }),
    ),
    Match.tag('UnknownAttestationType', () => ({
      body: { _tag: 'UnknownAttestationType' },
      status: 400 as const,
    })),
    Match.tag('IncompleteAssertion', ({ missing }) => ({
      body: { _tag: 'IncompleteAssertion', missing },
      status: 401 as const,
    })),
    Match.exhaustive,
  )

describe('Auth Plugin Test', () => {
  const makeClient = (
    enforceAuth: boolean,
    overrides?: {
      readonly playIntegrityMiddleware?: MiddlewareHandler
      readonly requireChainForPlayIntegrity?: boolean
    },
  ) =>
    Effect.gen(function*() {
      const androidAttestationMiddleware = yield* makeAndroidAttestationMiddleware.pipe(
        Effect.provide(layerFakeAndroidAttestation),
      )

      const middleware = yield* makeAuthMiddleware(
        overrides?.playIntegrityMiddleware ?? mockPlayIntegrityMiddleware,
        mockAppAttestMiddleware,
        androidAttestationMiddleware,
        testFormatter,
      ).pipe(
        Effect.provide(
          Layer.succeed(AuthMiddlewareConfig, {
            enforceAuth,
            requireChainForPlayIntegrity: overrides?.requireChainForPlayIntegrity ?? false,
          }),
        ),
      )

      return yield* Effect.sync(() => {
        const app = new Hono()
          .use('*', middleware)
          .get('/', (c) => {
            const statusCode: 200 | 401 = 200 + 0 as 200 | 401
            return c.json({ success: true }, statusCode)
          })
          .post('/', async (c) => {
            const body = await c.req.json().catch(() => ({}))
            const text = await c.req.text()
            return c.json({ success: true, echoedChain: body.attestationChain ?? null, bodyLength: text.length }, 200)
          })

        return testClient(app)
      })
    })

  const completeIosAssertion = (iosPackage: string) => ({
    'Auth-iOS-Package': iosPackage,
    'Auth-Payload': 'some-payload',
    'Auth-iOS-KeyId': 'some-key-id',
    'Auth-Challenge': 'some-challenge',
    'Auth-ClientId': 'some-client-id',
  })

  it.effect('Should_EnforceAuthHeaders_When_EnforceAuthIsTrue', () =>
    Effect.gen(function*() {
      const client = yield* makeClient(true)
      const response = yield* Effect.tryPromise(() => client.index.$get({}, { headers: {} }))
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ _tag: 'MissingAuthHeaders' })
      checkResponse(response, 401)
    }))

  it.effect('Should_NotEnforceAuthHeaders_When_EnforceAuthIsFalse', () =>
    Effect.gen(function*() {
      const client = yield* makeClient(false)
      const response = yield* Effect.tryPromise(() => client.index.$get({}, { headers: {} }))
      expect(response.status).toBe(200)
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ success: true })
    }))

  it.effect('Should_RejectAndroid_When_AttestationTypeMissing', () =>
    Effect.gen(function*() {
      const client = yield* makeClient(true)
      const response = yield* Effect.tryPromise(() =>
        client.index.$get({}, { headers: { 'Auth-Android-Package': 'valid.android.package' } })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ _tag: 'MissingAttestationTypeHeader' })
      checkResponse(response, 400)
    }))

  it.effect('Should_RejectAndroid_When_AttestationTypeUnknown', () =>
    Effect.gen(function*() {
      const client = yield* makeClient(true)
      const response = yield* Effect.tryPromise(() =>
        client.index.$get({}, {
          headers: { 'Auth-Android-Package': 'valid.android.package', 'Auth-Attestation-Type': 'unknown' },
        })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ _tag: 'UnknownAttestationType' })
      checkResponse(response, 400)
    }))

  it.effect('Should_DispatchToNext_When_AttestationTypeIsKeyAttestation', () =>
    Effect.gen(function*() {
      const client = yield* makeClient(true)
      const response = yield* Effect.tryPromise(() =>
        client.index.$get({}, { headers: { 'Auth-Attestation-Type': 'key-attestation' } })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ success: true })
      checkResponse(response, 200)
    }))

  it.effect('Should_DispatchToNext_When_AttestationTypeIsVoucher', () =>
    Effect.gen(function*() {
      const client = yield* makeClient(true)
      const response = yield* Effect.tryPromise(() =>
        client.index.$get({}, { headers: { 'Auth-Attestation-Type': 'voucher' } })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ success: true })
      checkResponse(response, 200)
    }))

  it.effect('Should_DispatchToNext_When_VoucherCombinedWithAndroidPackage', () =>
    Effect.gen(function*() {
      const client = yield* makeClient(true)
      const response = yield* Effect.tryPromise(() =>
        client.index.$get({}, {
          headers: { 'Auth-Android-Package': 'io.example.app', 'Auth-Attestation-Type': 'voucher' },
        })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ success: true })
      checkResponse(response, 200)
    }))

  it.effect('Should_HandleInvalidAndroidPackage_When_PlayIntegrityRejects', () =>
    Effect.gen(function*() {
      const client = yield* makeClient(true)
      const response = yield* Effect.tryPromise(() =>
        client.index.$post({
          json: { attestationChain: [VALID_LEAF, INTERMEDIATE] },
        }, {
          headers: {
            'Auth-Android-Package': 'invalid',
            'Auth-Attestation-Type': 'play-integrity',
            'Auth-Challenge': 'c29tZS1jaGFsbGVuZ2U=',
          },
        })
      )
      expect(response.status).toBe(401)
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ error: 'Invalid Android package' })
    }))

  it.effect('Should_VerifyAppAttest_When_IosAssertionCompleteButPackageInvalid', () =>
    Effect.gen(function*() {
      const client = yield* makeClient(true)
      const response = yield* Effect.tryPromise(() =>
        client.index.$get({}, { headers: completeIosAssertion('invalid') })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ error: 'Invalid iOS package' })
      checkResponse(response, 401)
    }))

  it.effect('Should_IgnoreAttestationTypeForiOS_When_HeaderPresent', () =>
    Effect.gen(function*() {
      const client = yield* makeClient(true)
      const response = yield* Effect.tryPromise(() =>
        client.index.$get({}, {
          headers: { ...completeIosAssertion('valid.ios.package'), 'Auth-Attestation-Type': 'unknown' },
        })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ success: true })
      checkResponse(response, 200)
    }))

  it.effect('Should_Reject_When_BothiOSAndAndroidHeadersPresent', () =>
    Effect.gen(function*() {
      const client = yield* makeClient(true)
      const response = yield* Effect.tryPromise(() =>
        client.index.$get({}, {
          headers: {
            'Auth-iOS-Package': 'valid.ios.package',
            'Auth-Android-Package': 'valid.android.package',
            'Auth-Attestation-Type': 'play-integrity',
          },
        })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ _tag: 'ConflictingPlatformHeaders' })
      checkResponse(response, 401)
    }))

  it.effect('Should_FallThroughToDispatch_When_OnlyAttestationTokenPresentAndEnforced', () =>
    Effect.gen(function*() {
      const client = yield* makeClient(true)
      const response = yield* Effect.tryPromise(() =>
        client.index.$get({}, { headers: { 'Auth-Attestation-Token': 'some-token' } })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ _tag: 'MissingAttestationTypeHeader' })
      checkResponse(response, 400)
    }))

  it.effect('Should_SkipAppAttest_When_SoftGateAndNoIosPackage', () =>
    Effect.gen(function*() {
      const client = yield* makeClient(false)
      const response = yield* Effect.tryPromise(() =>
        client.index.$get({}, { headers: { 'Auth-Payload': 'some-payload' } })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ success: true })
      checkResponse(response, 200)
    }))

  it.effect('Should_RejectAppAttest_When_SoftGateAndIosAssertionIncomplete', () =>
    Effect.gen(function*() {
      const client = yield* makeClient(false)
      const response = yield* Effect.tryPromise(() =>
        client.index.$get({}, { headers: { 'Auth-iOS-Package': 'valid.ios.package' } })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({
        _tag: 'IncompleteAssertion',
        missing: ['Auth-Payload', 'Auth-iOS-KeyId', 'Auth-Challenge', 'Auth-ClientId'],
      })
      checkResponse(response, 401)
    }))

  it.effect('Should_RejectAppAttest_When_EnforcedAndIosAssertionIncomplete', () =>
    Effect.gen(function*() {
      const client = yield* makeClient(true)
      const response = yield* Effect.tryPromise(() =>
        client.index.$get({}, {
          headers: { 'Auth-iOS-Package': 'valid.ios.package', 'Auth-Payload': 'some-payload' },
        })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({
        _tag: 'IncompleteAssertion',
        missing: ['Auth-iOS-KeyId', 'Auth-Challenge', 'Auth-ClientId'],
      })
      checkResponse(response, 401)
    }))

  it.effect('Should_VerifyAppAttest_When_IosAssertionCompleteAndPackageValid', () =>
    Effect.gen(function*() {
      const client = yield* makeClient(false)
      const response = yield* Effect.tryPromise(() =>
        client.index.$get({}, { headers: completeIosAssertion('valid.ios.package') })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ success: true })
      checkResponse(response, 200)
    }))

  const countingPlayIntegrity = (counter: { count: number }): MiddlewareHandler =>
    createMiddleware(async (_c, next) => {
      counter.count += 1
      return next()
    })

  const playIntegrityHeaders = {
    'Auth-Android-Package': 'valid.android.package',
    'Auth-Attestation-Type': 'play-integrity',
    'Auth-Challenge': 'c29tZS1jaGFsbGVuZ2U=',
  }

  it.effect('Should_RejectAndSkipPlayIntegrity_When_EnforcedAndAttestationChainMissing', () =>
    Effect.gen(function*() {
      const playIntegrityCalls = { count: 0 }
      const client = yield* makeClient(true, { playIntegrityMiddleware: countingPlayIntegrity(playIntegrityCalls) })
      const response = yield* Effect.tryPromise(() =>
        client.index.$post({ json: {} }, { headers: playIntegrityHeaders })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ _tag: 'MissingAndroidAttestationChain' })
      checkResponse(response, 401)
      expect(playIntegrityCalls.count).toBe(0)
    }))

  it.effect('Should_RejectAndSkipPlayIntegrity_When_EnforcedAndAttestationChainInvalid', () =>
    Effect.gen(function*() {
      const playIntegrityCalls = { count: 0 }
      const client = yield* makeClient(true, { playIntegrityMiddleware: countingPlayIntegrity(playIntegrityCalls) })
      const response = yield* Effect.tryPromise(() =>
        client.index.$post({ json: { attestationChain: [INVALID_LEAF, INTERMEDIATE] } }, {
          headers: playIntegrityHeaders,
        })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({
        _tag: 'AndroidAttestationFailed',
        error: 'Android attestation verification failed',
      })
      checkResponse(response, 401)
      expect(playIntegrityCalls.count).toBe(0)
    }))

  it.effect('Should_DispatchToPlayIntegrity_When_EnforcedAndAttestationChainValid', () =>
    Effect.gen(function*() {
      const playIntegrityCalls = { count: 0 }
      const client = yield* makeClient(true, { playIntegrityMiddleware: countingPlayIntegrity(playIntegrityCalls) })
      const response = yield* Effect.tryPromise(() =>
        client.index.$post({ json: { attestationChain: [VALID_LEAF, INTERMEDIATE] } }, {
          headers: playIntegrityHeaders,
        })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({
        success: true,
        echoedChain: [VALID_LEAF, INTERMEDIATE],
        bodyLength: expect.any(Number),
      })
      checkResponse(response, 200)
      expect(playIntegrityCalls.count).toBe(1)
    }))

  it.effect('Should_DispatchToPlayIntegrity_When_SoftGateAndAttestationChainMissing', () =>
    Effect.gen(function*() {
      const playIntegrityCalls = { count: 0 }
      const client = yield* makeClient(false, { playIntegrityMiddleware: countingPlayIntegrity(playIntegrityCalls) })
      const response = yield* Effect.tryPromise(() =>
        client.index.$post({ json: {} }, { headers: playIntegrityHeaders })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ success: true, echoedChain: null, bodyLength: expect.any(Number) })
      checkResponse(response, 200)
      expect(playIntegrityCalls.count).toBe(1)
    }))

  it.effect('Should_RejectAndSkipPlayIntegrity_When_SoftGateAndAttestationChainInvalid', () =>
    Effect.gen(function*() {
      const playIntegrityCalls = { count: 0 }
      const client = yield* makeClient(false, { playIntegrityMiddleware: countingPlayIntegrity(playIntegrityCalls) })
      const response = yield* Effect.tryPromise(() =>
        client.index.$post({ json: { attestationChain: [INVALID_LEAF, INTERMEDIATE] } }, {
          headers: playIntegrityHeaders,
        })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({
        _tag: 'AndroidAttestationFailed',
        error: 'Android attestation verification failed',
      })
      checkResponse(response, 401)
      expect(playIntegrityCalls.count).toBe(0)
    }))

  it.effect('Should_DispatchToPlayIntegrity_When_SoftGateAndAttestationChainValid', () =>
    Effect.gen(function*() {
      const playIntegrityCalls = { count: 0 }
      const client = yield* makeClient(false, { playIntegrityMiddleware: countingPlayIntegrity(playIntegrityCalls) })
      const response = yield* Effect.tryPromise(() =>
        client.index.$post({ json: { attestationChain: [VALID_LEAF, INTERMEDIATE] } }, {
          headers: playIntegrityHeaders,
        })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({
        success: true,
        echoedChain: [VALID_LEAF, INTERMEDIATE],
        bodyLength: expect.any(Number),
      })
      checkResponse(response, 200)
      expect(playIntegrityCalls.count).toBe(1)
    }))

  it.effect('Should_RejectAndSkipPlayIntegrity_When_EnforcedAndChallengeHeaderMissing', () =>
    Effect.gen(function*() {
      const playIntegrityCalls = { count: 0 }
      const client = yield* makeClient(true, { playIntegrityMiddleware: countingPlayIntegrity(playIntegrityCalls) })
      const response = yield* Effect.tryPromise(() =>
        client.index.$post({
          json: { attestationChain: [VALID_LEAF, INTERMEDIATE] },
        }, {
          headers: { 'Auth-Android-Package': 'valid.android.package', 'Auth-Attestation-Type': 'play-integrity' },
        })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({
        _tag: 'AndroidAttestationFailed',
        error: 'Android attestation verification failed',
      })
      checkResponse(response, 401)
      expect(playIntegrityCalls.count).toBe(0)
    }))

  it.effect('Should_TreatMalformedBodyAsMissingChain_When_EnforcedAndPlayIntegrity', () =>
    Effect.gen(function*() {
      const playIntegrityCalls = { count: 0 }
      const client = yield* makeClient(true, { playIntegrityMiddleware: countingPlayIntegrity(playIntegrityCalls) })
      const response = yield* Effect.tryPromise(() =>
        client.index.$post({ json: { attestationChain: 'not-an-array' } }, { headers: playIntegrityHeaders })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ _tag: 'MissingAndroidAttestationChain' })
      checkResponse(response, 401)
      expect(playIntegrityCalls.count).toBe(0)
    }))

  it.effect('Should_Return503AndSkipPlayIntegrity_When_EnforcedAndCrlUnavailable', () =>
    Effect.gen(function*() {
      const playIntegrityCalls = { count: 0 }
      const client = yield* makeClient(true, { playIntegrityMiddleware: countingPlayIntegrity(playIntegrityCalls) })
      const response = yield* Effect.tryPromise(() =>
        client.index.$post({
          json: { attestationChain: [UNAVAILABLE_LEAF, INTERMEDIATE] },
        }, { headers: playIntegrityHeaders })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({
        _tag: 'AndroidAttestationCrlUnavailable',
        error: 'Android revocation list is currently unavailable. Retry with a fresh challenge.',
      })
      checkResponse(response, 503)
      expect(playIntegrityCalls.count).toBe(0)
    }))

  it.effect('Should_NotReturn401OrDispatch_When_EnforcedAndVerifyChainDies', () =>
    Effect.gen(function*() {
      const playIntegrityCalls = { count: 0 }
      const client = yield* makeClient(true, { playIntegrityMiddleware: countingPlayIntegrity(playIntegrityCalls) })
      const response = yield* Effect.tryPromise(() =>
        client.index.$post({
          json: { attestationChain: [DEFECT_LEAF, INTERMEDIATE] },
        }, { headers: playIntegrityHeaders })
      ).pipe(Effect.either)

      const status = Match.value(response).pipe(
        Match.tag('Left', () => 500),
        Match.tag('Right', ({ right }) => right.status),
        Match.exhaustive,
      )
      expect(status).not.toBe(401)
      expect(status).not.toBe(200)
      expect(status).toBeGreaterThanOrEqual(500)
      expect(playIntegrityCalls.count).toBe(0)
    }))

  it.effect('Should_RejectAndSkipPlayIntegrity_When_RequireChainAndChainMissing', () =>
    Effect.gen(function*() {
      const playIntegrityCalls = { count: 0 }
      const client = yield* makeClient(false, {
        playIntegrityMiddleware: countingPlayIntegrity(playIntegrityCalls),
        requireChainForPlayIntegrity: true,
      })
      const response = yield* Effect.tryPromise(() =>
        client.index.$post({ json: {} }, { headers: playIntegrityHeaders })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({ _tag: 'MissingAndroidAttestationChain' })
      checkResponse(response, 401)
      expect(playIntegrityCalls.count).toBe(0)
    }))

  it.effect('Should_DispatchToPlayIntegrity_When_RequireChainAndChainValid', () =>
    Effect.gen(function*() {
      const playIntegrityCalls = { count: 0 }
      const client = yield* makeClient(false, {
        playIntegrityMiddleware: countingPlayIntegrity(playIntegrityCalls),
        requireChainForPlayIntegrity: true,
      })
      const response = yield* Effect.tryPromise(() =>
        client.index.$post({ json: { attestationChain: [VALID_LEAF, INTERMEDIATE] } }, {
          headers: playIntegrityHeaders,
        })
      )
      const jsonResponse = yield* Effect.promise(() => response.json())
      expect(jsonResponse).toEqual({
        success: true,
        echoedChain: [VALID_LEAF, INTERMEDIATE],
        bodyLength: expect.any(Number),
      })
      checkResponse(response, 200)
      expect(playIntegrityCalls.count).toBe(1)
    }))
})
