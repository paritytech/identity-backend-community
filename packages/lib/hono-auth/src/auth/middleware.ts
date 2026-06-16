import { Context, Effect, Either, Match, Schema as S } from 'effect'
import type { Context as HonoContext, MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { AppAttestDispatchCommand, decideAppAttestDispatch } from '../app-attest/dispatch.workflow.js'
import {
  AndroidAttestationRequirementCommand,
  decideAndroidAttestationRequirement,
} from './attestation-requirement.workflow.js'
import { readAttestationChainPresence } from './attestation.middleware.js'
import { decideAndroidDispatch } from './dispatch.js'

export class AuthMiddlewareConfig extends Context.Tag('AuthMiddlewareConfig')<
  AuthMiddlewareConfig,
  { enforceAuth: boolean; requireChainForPlayIntegrity: boolean }
>() {}

const ASSERTION_HEADER_NAMES: Record<string, string> = {
  payload: 'Auth-Payload',
  keyId: 'Auth-iOS-KeyId',
  challenge: 'Auth-Challenge',
  clientId: 'Auth-ClientId',
}

export class MissingAuthHeaders extends S.TaggedClass<MissingAuthHeaders>()('MissingAuthHeaders', {}) {}
export class ConflictingPlatformHeaders
  extends S.TaggedClass<ConflictingPlatformHeaders>()('ConflictingPlatformHeaders', {})
{}
export class MissingAndroidAttestationChain
  extends S.TaggedClass<MissingAndroidAttestationChain>()('MissingAndroidAttestationChain', {})
{}
export class MissingAttestationTypeHeader
  extends S.TaggedClass<MissingAttestationTypeHeader>()('MissingAttestationTypeHeader', {})
{}
export class UnknownAttestationType extends S.TaggedClass<UnknownAttestationType>()('UnknownAttestationType', {}) {}
export class IncompleteAssertion extends S.TaggedClass<IncompleteAssertion>()('IncompleteAssertion', {
  missing: S.Array(S.String),
}) {}

export const AuthMiddlewareError = S.Union(
  MissingAuthHeaders,
  ConflictingPlatformHeaders,
  MissingAndroidAttestationChain,
  MissingAttestationTypeHeader,
  UnknownAttestationType,
  IncompleteAssertion,
)
export type AuthMiddlewareError = S.Schema.Type<typeof AuthMiddlewareError>

export interface AuthMiddlewareErrorResponse {
  readonly body: unknown
  readonly status: ContentfulStatusCode
  readonly headers?: Record<string, string>
}

export type AuthMiddlewareErrorFormatter = (
  error: AuthMiddlewareError,
) => AuthMiddlewareErrorResponse

export const makeAuthMiddleware = (
  // oxlint-disable-next-line typescript/no-explicit-any
  playIntegrityMiddleware: MiddlewareHandler<any, string, {}>,
  // oxlint-disable-next-line typescript/no-explicit-any
  appAttestMiddleware: MiddlewareHandler<any, string, {}>,
  // oxlint-disable-next-line typescript/no-explicit-any
  androidAttestationMiddleware: MiddlewareHandler<any, string, {}>,
  formatError: AuthMiddlewareErrorFormatter,
) =>
  Effect.gen(function*() {
    const config = yield* AuthMiddlewareConfig
    const { createMiddleware } = yield* Effect.promise(() => import('hono/factory'))
    const HonoCombine = yield* Effect.promise(() => import('hono/combine'))

    const reject = (c: HonoContext, error: AuthMiddlewareError) => {
      const { body, status, headers } = formatError(error)
      return c.json(body, status, headers)
    }

    const verifyThenPlayIntegrity = HonoCombine.every(androidAttestationMiddleware, playIntegrityMiddleware)

    const enforceAuthMiddleware = createMiddleware(async (c, next) => {
      const iosPackageHeader = c.req.header('Auth-iOS-Package')
      const androidPackageHeader = c.req.header('Auth-Android-Package')
      const attestationTokenHeader = c.req.header('Auth-Attestation-Token')
      const attestationTypeHeader = c.req.header('Auth-Attestation-Type')

      if (
        config.enforceAuth &&
        iosPackageHeader === undefined &&
        androidPackageHeader === undefined &&
        attestationTokenHeader === undefined &&
        attestationTypeHeader === undefined
      ) {
        return reject(c, new MissingAuthHeaders())
      }

      if (iosPackageHeader !== undefined && androidPackageHeader !== undefined) {
        return reject(c, new ConflictingPlatformHeaders())
      }

      return next()
    })

    const androidAttestationDispatchMiddleware = createMiddleware(async (c, next) => {
      const attestationTypeHeader = c.req.header('Auth-Attestation-Type')
      const decision = decideAndroidDispatch({
        iosPackage: c.req.header('Auth-iOS-Package'),
        androidPackage: c.req.header('Auth-Android-Package'),
        attestationToken: c.req.header('Auth-Attestation-Token'),
        attestationType: attestationTypeHeader,
      })

      return Match.value(decision).pipe(
        Match.tag('Skip', () => next()),
        Match.tag('PlayIntegrity', async () =>
          Either.match(
            decideAndroidAttestationRequirement(
              new AndroidAttestationRequirementCommand({
                enforceAuth: config.enforceAuth,
                chainPresent: await readAttestationChainPresence(c),
                requireChainForPlayIntegrity: config.requireChainForPlayIntegrity,
              }),
            ),
            {
              onLeft: (error) =>
                Match.value(error).pipe(
                  Match.tag(
                    'MissingChainError',
                    () => reject(c, new MissingAndroidAttestationChain()),
                  ),
                  Match.exhaustive,
                ),
              onRight: (decision) =>
                Match.value(decision).pipe(
                  Match.tag('VerifyChain', () => verifyThenPlayIntegrity(c, next)),
                  Match.tag('SkipVerification', () => playIntegrityMiddleware(c, next)),
                  Match.exhaustive,
                ),
            },
          )),
        Match.tag('KeyAttestation', () => next()),
        Match.tag('Voucher', () => next()),
        Match.tag('MissingAttestationType', () => reject(c, new MissingAttestationTypeHeader())),
        Match.tag(
          'UnknownAttestationType',
          () => reject(c, new UnknownAttestationType()),
        ),
        Match.exhaustive,
      )
    })

    const appAttestDispatchMiddleware = createMiddleware(async (c, next) => {
      const command = new AppAttestDispatchCommand({
        iosPackage: c.req.header('Auth-iOS-Package'),
        payload: c.req.header('Auth-Payload'),
        keyId: c.req.header('Auth-iOS-KeyId'),
        challenge: c.req.header('Auth-Challenge'),
        clientId: c.req.header('Auth-ClientId'),
      })

      return Either.match(decideAppAttestDispatch(command), {
        onLeft: (error) =>
          Match.value(error).pipe(
            Match.tag('IncompleteAssertion', ({ missing }) => {
              const missingHeaders = missing.map((field) => ASSERTION_HEADER_NAMES[field] ?? field)
              return reject(c, new IncompleteAssertion({ missing: missingHeaders }))
            }),
            Match.exhaustive,
          ),
        onRight: (decision) =>
          Match.value(decision).pipe(
            Match.tag('Skip', () => next()),
            Match.tag('Verify', () => appAttestMiddleware(c, next)),
            Match.exhaustive,
          ),
      })
    })

    return HonoCombine.every(
      enforceAuthMiddleware,
      androidAttestationDispatchMiddleware,
      appAttestDispatchMiddleware,
    )
  })
