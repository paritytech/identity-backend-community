import { DB } from '#root/db/mod.js'
import { ChallengeServiceLive } from '#root/infrastructure/adapters/challenge.service.js'
import { AppAttestationRepositoryLive } from '#root/infrastructure/adapters/repositories/app-attest.repository.js'
import { AndroidAttestationCrlService } from '#root/infrastructure/android-attestation-crl.service.js'
import { buildProblemDetail } from '#root/lib/problem-details.js'
import {
  AttestationChallenge,
  GRAPHENEOS_VERIFIED_BOOT_KEYS,
  PackageName,
  SigningDigestHex,
  verifyAndroidAttestation as verifyAndroidAttestationLib,
} from '@identity-backend/android-attest'
import {
  AppAttestEnvironment,
  layerAppAttestMiddleware,
  makeAppAttestMiddleware,
} from '@identity-backend/hono-auth/app-attest'
import { AndroidAttestationOutcome } from '@identity-backend/hono-auth/auth'
import {
  AndroidAttestationMiddlewareConfig,
  AuthMiddlewareConfig,
  makeAndroidAttestationMiddleware,
  makeAuthMiddleware,
} from '@identity-backend/hono-auth/auth'
import type { AuthMiddlewareErrorFormatter } from '@identity-backend/hono-auth/auth'
import {
  layerPlayIntegrityMiddleware,
  makePlayIntegrityMiddleware,
  PlayIntegrityEnvironment,
} from '@identity-backend/hono-auth/play-integrity'
import { PlayIntegrityServiceConfig } from '@identity-backend/play-integrity'
import { decodeHex, encodeBase64Url } from '@std/encoding'
import { Config, Context, Effect, Layer, Match, pipe, Schema as S } from 'effect'
import { createMiddleware } from 'hono/factory'

const toDigestSet = (
  playstoreDigest: string,
  websiteDigest: string,
): ReadonlySet<string> =>
  new Set([
    encodeBase64Url(decodeHex(playstoreDigest)),
    encodeBase64Url(decodeHex(websiteDigest)),
  ])

export class AuthPluginConfig extends Context.Tag('app/AuthPluginConfig')<
  AuthPluginConfig,
  {
    enabled: boolean
  }
>() {}

export const formatAuthError: AuthMiddlewareErrorFormatter = (error) =>
  Match.value(error).pipe(
    Match.tag('MissingAuthHeaders', () => ({
      body: buildProblemDetail({
        slug: 'unauthorized',
        title: 'Missing Authentication Headers',
        detail:
          'Missing one of [Auth-iOS-Package, Auth-Android-Package, Auth-Attestation-Token, Auth-Attestation-Type] headers',
        status: 401,
      }),
      status: 401 as const,
      headers: { 'Content-Type': 'application/problem+json' },
    })),
    Match.tag('ConflictingPlatformHeaders', () => ({
      body: buildProblemDetail({
        slug: 'unauthorized',
        title: 'Conflicting Platform Headers',
        detail: "Only one of ['Auth-iOS-Package', 'Auth-Android-Package'] is allowed",
        status: 401,
      }),
      status: 401 as const,
      headers: { 'Content-Type': 'application/problem+json' },
    })),
    Match.tag('MissingAndroidAttestationChain', () => ({
      body: buildProblemDetail({
        slug: 'unauthorized',
        title: 'Missing Android Attestation Chain',
        detail:
          'The request requires an Android key-attestation certificate chain in the "attestationChain" body field, but none was provided.',
        status: 401,
      }),
      status: 401 as const,
      headers: { 'Content-Type': 'application/problem+json' },
    })),
    Match.tag('MissingAttestationTypeHeader', () => ({
      body: buildProblemDetail({
        slug: 'missing-request-header',
        title: 'Missing Attestation Type Header',
        detail:
          'Missing Auth-Attestation-Type header. Android requests must declare play-integrity, key-attestation, or voucher.',
        status: 400,
      }),
      status: 400 as const,
      headers: { 'Content-Type': 'application/problem+json' },
    })),
    Match.tag('UnknownAttestationType', () => ({
      body: buildProblemDetail({
        slug: 'invalid-request-header-format',
        title: 'Unknown Attestation Type',
        detail:
          'Unknown Auth-Attestation-Type header value. Expected one of: play-integrity, key-attestation, voucher.',
        status: 400,
      }),
      status: 400 as const,
      headers: { 'Content-Type': 'application/problem+json' },
    })),
    Match.tag('IncompleteAssertion', ({ missing }) => ({
      body: buildProblemDetail({
        slug: 'unauthorized',
        title: 'Incomplete App Attest Assertion',
        detail: `Missing required App Attest headers: ${missing.join(', ')}`,
        status: 401,
      }),
      status: 401 as const,
      headers: { 'Content-Type': 'application/problem+json' },
    })),
    Match.exhaustive,
  )

export const makeAuthPluginWithoutDependencies = Effect.gen(function*() {
  const config = yield* AuthPluginConfig

  if (!config.enabled) {
    return yield* Effect.sync(() => createMiddleware(async (c, next) => next()))
  }

  const db = yield* DB

  const layerAppAttestEnvironment = Layer.effect(
    AppAttestEnvironment,
    Effect.gen(function*() {
      const { IOS_PACKAGE_NAMES, APPLE_APP_ATTEST_APP_IDS } = yield* Effect.promise(() => import('#root/config.js'))

      const appConfig = yield* Config.all({
        IOS_PACKAGE_NAMES,
        APPLE_APP_ATTEST_APP_IDS,
      })

      return {
        iosPackageNames: appConfig.IOS_PACKAGE_NAMES,
        appIds: appConfig.APPLE_APP_ATTEST_APP_IDS,
      }
    }),
  )

  const layerPlayIntegrityEnvironment = Layer.effect(
    PlayIntegrityEnvironment,
    Effect.gen(function*() {
      const {
        PLAY_INTEGRITY_MODE,
        ANDROID_PACKAGE_NAMES,
        ANDROID_SIGNING_DIGEST_PLAYSTORE,
        ANDROID_SIGNING_DIGEST_WEBSITE,
      } = yield* Effect.promise(() => import('#root/config.js'))

      const playConfig = yield* Config.all({
        androidPackageNames: ANDROID_PACKAGE_NAMES,
        mode: PLAY_INTEGRITY_MODE,
        playstoreDigest: ANDROID_SIGNING_DIGEST_PLAYSTORE,
        websiteDigest: ANDROID_SIGNING_DIGEST_WEBSITE,
      })

      return {
        androidPackageNames: playConfig.androidPackageNames,
        mode: playConfig.mode,
        androidSigningDigests: toDigestSet(playConfig.playstoreDigest, playConfig.websiteDigest),
      }
    }),
  )

  const layerPlayIntegrityServiceConfig = Layer.effect(
    PlayIntegrityServiceConfig,
    Effect.gen(function*() {
      const { GOOGLE_CREDENTIALS } = yield* Effect.promise(() => import('#root/config.js'))
      const { GOOGLE_CREDENTIALS: googleCredentials } = yield* Config.all({ GOOGLE_CREDENTIALS })

      return {
        googleCredentials,
      }
    }),
  )

  const layerAuthMiddlewareConfig = Layer.effect(
    AuthMiddlewareConfig,
    Effect.gen(function*() {
      const { ENFORCE_AUTH, REQUIRE_CHAIN_FOR_PLAY_INTEGRITY } = yield* Effect.promise(() => import('#root/config.js'))
      const [enforceAuth, requireChainForPlayIntegrity] = yield* Effect.all([
        ENFORCE_AUTH,
        REQUIRE_CHAIN_FOR_PLAY_INTEGRITY,
      ])

      return {
        enforceAuth,
        requireChainForPlayIntegrity,
      }
    }),
  )

  const layerAndroidAttestationMiddlewareConfig = Layer.effect(
    AndroidAttestationMiddlewareConfig,
    Effect.gen(function*() {
      const {
        ANDROID_PACKAGE_NAMES,
        ANDROID_SIGNING_DIGEST_PLAYSTORE,
        ANDROID_SIGNING_DIGEST_WEBSITE,
        ANDROID_ATTESTATION_ROOT_PEMS,
      } = yield* Effect.promise(() => import('#root/config.js'))

      const crlService = yield* AndroidAttestationCrlService

      const [packageNames, playStoreDigest, websiteDigest, rootPems] = yield* Config.all([
        ANDROID_PACKAGE_NAMES,
        ANDROID_SIGNING_DIGEST_PLAYSTORE,
        ANDROID_SIGNING_DIGEST_WEBSITE,
        ANDROID_ATTESTATION_ROOT_PEMS,
      ])

      const knownDigests = {
        playStore: yield* S.decode(SigningDigestHex)(playStoreDigest),
        website: yield* S.decode(SigningDigestHex)(websiteDigest),
      }

      const expectedPackageNames = yield* Effect.forEach(
        Array.from(packageNames),
        (n) => S.decode(PackageName)(n),
      )

      const decodeChallenge = S.decodeSync(AttestationChallenge)

      const verifyChain: AndroidAttestationMiddlewareConfig['Type']['verifyChain'] = (params) =>
        Effect.gen(function*() {
          const crlEntries = yield* crlService.getEntries
          yield* verifyAndroidAttestationLib({
            expectedPackageNames,
            expectedChallenge: decodeChallenge(params.challenge),
            crlEntries,
            knownDigests,
            trustedVerifiedBootKeys: GRAPHENEOS_VERIFIED_BOOT_KEYS,
            googleRootPems: rootPems,
          })({
            leafCertDer: params.leafCertDer,
            intermediateCertDers: params.intermediateCertDers,
          })
          return AndroidAttestationOutcome.Verified
        }).pipe(
          Effect.catchTags({
            CertificateChainError: () => Effect.succeed(AndroidAttestationOutcome.Rejected),
            CertificateRevokedError: () => Effect.succeed(AndroidAttestationOutcome.Rejected),
            AttestationStatementError: () => Effect.succeed(AndroidAttestationOutcome.Rejected),
            AppDistributionError: () => Effect.succeed(AndroidAttestationOutcome.Rejected),
            FetchCrlError: () => Effect.succeed(AndroidAttestationOutcome.Unavailable),
            ParseCrlError: () => Effect.succeed(AndroidAttestationOutcome.Unavailable),
          }),
        )

      return { verifyChain }
    }),
  )

  const layerServices = Layer.provide(
    Layer.mergeAll(
      ChallengeServiceLive,
      AppAttestationRepositoryLive,
    ),
    Layer.succeed(DB, db),
  )

  const layerAppAttestComplete = pipe(
    layerAppAttestMiddleware,
    Layer.provide(layerAppAttestEnvironment),
  )

  const layerPlayIntegrityComplete = pipe(
    layerPlayIntegrityMiddleware,
    Layer.provide(
      Layer.mergeAll(
        layerPlayIntegrityEnvironment,
        layerPlayIntegrityServiceConfig,
      ),
    ),
  )

  const layerAuthMiddleware = Layer.provide(
    Layer.mergeAll(
      layerAppAttestComplete,
      layerPlayIntegrityComplete,
      layerAndroidAttestationMiddlewareConfig,
      layerAuthMiddlewareConfig,
    ),
    Layer.mergeAll(
      layerServices,
    ),
  )

  return yield* Effect.gen(function*() {
    const playIntegrityMiddleware = yield* makePlayIntegrityMiddleware
    const appAttestMiddleware = yield* makeAppAttestMiddleware
    const androidAttestationMiddleware = yield* makeAndroidAttestationMiddleware

    return yield* makeAuthMiddleware(
      playIntegrityMiddleware,
      appAttestMiddleware,
      androidAttestationMiddleware,
      formatAuthError,
    )
  }).pipe(
    Effect.provide(layerAuthMiddleware),
  )
})

export const makeAuthPlugin = makeAuthPluginWithoutDependencies.pipe(
  Effect.provide(
    Layer.effect(
      AuthPluginConfig,
      Effect.gen(function*() {
        const { AUTH_ENABLED } = yield* Effect.promise(() => import('#root/config.js'))

        const enabled = yield* AUTH_ENABLED

        return {
          enabled,
        }
      }),
    ),
  ),
)
