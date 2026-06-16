import { Schema as S } from 'effect'

/**
 * Per-verdict acceptance rule for Play Integrity token validation.
 *
 * `strict`         — production: require a Play Store build on a
 *                    hardware-backed, non-rooted device.
 * `relaxed_device` — nightly/paseo: relax device integrity to permit
 *                    real devices that have not received the strongest
 *                    verdict, but keep app recognition and licensing
 *                    strict.
 * `relaxed_all`    — preview/debug: relax device integrity, app
 *                    recognition (allow `UNRECOGNIZED_VERSION` and
 *                    `UNEVALUATED` from sideloaded builds) and licensing
 *                    (allow `UNLICENSED`). Google populates
 *                    `packageName` and `certificateSha256Digest` only
 *                    when `appRecognitionVerdict != UNEVALUATED`, so this
 *                    mode also tolerates those fields being absent. A
 *                    field that is present but does not match is still
 *                    rejected in every mode.
 */
export type PlayIntegrityMode = 'strict' | 'relaxed_device' | 'relaxed_all'
export const PlayIntegrityMode: S.Schema<PlayIntegrityMode> = S.Literal(
  'strict' as const,
  'relaxed_device' as const,
  'relaxed_all' as const,
)

export type AppRecognitionVerdict = 'PLAY_RECOGNIZED' | 'UNRECOGNIZED_VERSION' | 'UNEVALUATED'
export const AppRecognitionVerdict: S.Schema<AppRecognitionVerdict> = S.Literal(
  'PLAY_RECOGNIZED' as const,
  'UNRECOGNIZED_VERSION' as const,
  'UNEVALUATED' as const,
)

export type DeviceRecognitionVerdict =
  | 'MEETS_DEVICE_INTEGRITY'
  | 'MEETS_BASIC_INTEGRITY'
  | 'MEETS_STRONG_INTEGRITY'
  | 'MEETS_VIRTUAL_INTEGRITY'
export const DeviceRecognitionVerdict: S.Schema<DeviceRecognitionVerdict> = S.Literal(
  'MEETS_DEVICE_INTEGRITY' as const,
  'MEETS_BASIC_INTEGRITY' as const,
  'MEETS_STRONG_INTEGRITY' as const,
  'MEETS_VIRTUAL_INTEGRITY' as const,
)

export type AppLicensingVerdict = 'LICENSED' | 'UNLICENSED' | 'UNEVALUATED'
export const AppLicensingVerdict: S.Schema<AppLicensingVerdict> = S.Literal(
  'LICENSED' as const,
  'UNLICENSED' as const,
  'UNEVALUATED' as const,
)

export type PlayIntegrityErrorCode =
  | 'APP_INTEGRITY_FAILED'
  | 'DEVICE_INTEGRITY_FAILED'
  | 'LICENSE_CHECK_FAILED'
  | 'APK_FINGERPRINT_MISMATCH'
  | 'PACKAGE_NAME_MISMATCH'
export const PlayIntegrityErrorCode: S.Schema<PlayIntegrityErrorCode> = S.Literal(
  'APP_INTEGRITY_FAILED' as const,
  'DEVICE_INTEGRITY_FAILED' as const,
  'LICENSE_CHECK_FAILED' as const,
  'APK_FINGERPRINT_MISMATCH' as const,
  'PACKAGE_NAME_MISMATCH' as const,
)

export const PlayIntegrityToken = S.Struct({
  appRecognitionVerdict: S.NullOr(AppRecognitionVerdict),
  deviceRecognitionVerdict: S.NullOr(S.Array(DeviceRecognitionVerdict)),
  appLicensingVerdict: S.NullOr(AppLicensingVerdict),
  certificateSha256Digest: S.NullOr(S.Array(S.String)),
  packageName: S.NullOr(S.String),
})
export type PlayIntegrityToken = S.Schema.Type<typeof PlayIntegrityToken>

export class InvalidTokenError extends S.Class<InvalidTokenError>('InvalidTokenError')({
  codes: S.Array(PlayIntegrityErrorCode),
}) {}

export class PlayIntegrityMiddlewareError
  extends S.TaggedError<PlayIntegrityMiddlewareError>('PlayIntegrityMiddlewareError')(
    'PlayIntegrityMiddlewareError',
    {
      cause: S.optionalWith(S.Unknown, { nullable: true }),
    },
  )
{}

export class IntegrityErrorResponse extends S.Class<IntegrityErrorResponse>('IntegrityErrorResponse')({
  error: S.String,
  errorCodes: S.Array(PlayIntegrityErrorCode),
}) {}

export { ChallengeRejectedError } from '@identity-backend/auth/types'
