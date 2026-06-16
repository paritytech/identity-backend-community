import { Match, Option, Schema as S } from 'effect'
import {
  AppLicensingVerdict,
  AppRecognitionVerdict,
  DeviceRecognitionVerdict,
  PlayIntegrityErrorCode,
  PlayIntegrityMode,
  PlayIntegrityToken,
} from './types.js'

export class PlayIntegrityAccepted extends S.TaggedClass<PlayIntegrityAccepted>()('PlayIntegrityAccepted', {}) {}

export class PlayIntegrityRejected extends S.TaggedClass<PlayIntegrityRejected>()('PlayIntegrityRejected', {
  codes: S.Array(PlayIntegrityErrorCode),
}) {}

export const PlayIntegrityValidation = S.Union(PlayIntegrityAccepted, PlayIntegrityRejected)
export type PlayIntegrityValidation = S.Schema.Type<typeof PlayIntegrityValidation>

export interface ValidatePlayIntegrityTokenParams {
  readonly mode: PlayIntegrityMode
  readonly token: PlayIntegrityToken
  readonly expectedCertificateDigests: ReadonlySet<string>
  readonly allowedPackageNames: ReadonlySet<string>
}

interface ModePolicy {
  readonly acceptAppRecognition: ReadonlySet<AppRecognitionVerdict | null>
  readonly acceptDeviceRecognition: ReadonlySet<DeviceRecognitionVerdict>
  readonly acceptEmptyDeviceRecognition: boolean
  readonly acceptAppLicensing: ReadonlySet<AppLicensingVerdict | null>
  readonly acceptMissingAppIntegrity: boolean
}

const STRICT_POLICY: ModePolicy = {
  acceptAppRecognition: new Set<AppRecognitionVerdict | null>(['PLAY_RECOGNIZED' as const]),
  acceptDeviceRecognition: new Set<DeviceRecognitionVerdict>([
    'MEETS_STRONG_INTEGRITY' as const,
    'MEETS_DEVICE_INTEGRITY' as const,
  ]),
  acceptEmptyDeviceRecognition: false,
  acceptAppLicensing: new Set<AppLicensingVerdict | null>(['LICENSED' as const]),
  acceptMissingAppIntegrity: false,
}

const RELAXED_DEVICE_POLICY: ModePolicy = {
  acceptAppRecognition: new Set<AppRecognitionVerdict | null>(['PLAY_RECOGNIZED' as const]),
  acceptDeviceRecognition: new Set<DeviceRecognitionVerdict>([
    'MEETS_DEVICE_INTEGRITY' as const,
    'MEETS_BASIC_INTEGRITY' as const,
    'MEETS_STRONG_INTEGRITY' as const,
  ]),
  acceptEmptyDeviceRecognition: false,
  acceptAppLicensing: new Set<AppLicensingVerdict | null>(['LICENSED' as const]),
  acceptMissingAppIntegrity: false,
}

const RELAXED_ALL_POLICY: ModePolicy = {
  acceptAppRecognition: new Set<AppRecognitionVerdict | null>([
    'PLAY_RECOGNIZED' as const,
    'UNRECOGNIZED_VERSION' as const,
    'UNEVALUATED' as const,
  ]),
  acceptDeviceRecognition: new Set<DeviceRecognitionVerdict>([
    'MEETS_DEVICE_INTEGRITY' as const,
    'MEETS_BASIC_INTEGRITY' as const,
    'MEETS_STRONG_INTEGRITY' as const,
    'MEETS_VIRTUAL_INTEGRITY' as const,
  ]),
  acceptEmptyDeviceRecognition: true,
  acceptAppLicensing: new Set<AppLicensingVerdict | null>([
    'LICENSED' as const,
    'UNLICENSED' as const,
    'UNEVALUATED' as const,
  ]),
  acceptMissingAppIntegrity: true,
}

const MODE_POLICY: Readonly<Record<PlayIntegrityMode, ModePolicy>> = {
  strict: STRICT_POLICY,
  relaxed_device: RELAXED_DEVICE_POLICY,
  relaxed_all: RELAXED_ALL_POLICY,
}

const DEVICE_INTEGRITY_FAILED = 'DEVICE_INTEGRITY_FAILED' as const satisfies PlayIntegrityErrorCode
const APK_FINGERPRINT_MISMATCH = 'APK_FINGERPRINT_MISMATCH' as const satisfies PlayIntegrityErrorCode
const PACKAGE_NAME_MISMATCH = 'PACKAGE_NAME_MISMATCH' as const satisfies PlayIntegrityErrorCode

const missingFieldResult = (
  acceptMissing: boolean,
  code: PlayIntegrityErrorCode,
): Option.Option<PlayIntegrityErrorCode> =>
  Match.value(acceptMissing).pipe(
    Match.when(true, () => Option.none()),
    Match.when(false, () => Option.some(code)),
    Match.exhaustive,
  )

const checkAppRecognition = (
  verdict: AppRecognitionVerdict | null,
  accepted: ReadonlySet<AppRecognitionVerdict | null>,
): Option.Option<PlayIntegrityErrorCode> =>
  Match.value(accepted.has(verdict)).pipe(
    Match.when(true, () => Option.none()),
    Match.when(false, () => Option.some('APP_INTEGRITY_FAILED' as const satisfies PlayIntegrityErrorCode)),
    Match.exhaustive,
  )

const checkDeviceRecognition = (
  verdicts: ReadonlyArray<DeviceRecognitionVerdict> | null,
  accepted: ReadonlySet<DeviceRecognitionVerdict>,
  acceptEmpty: boolean,
): Option.Option<PlayIntegrityErrorCode> => {
  const handleEmpty = (): Option.Option<PlayIntegrityErrorCode> =>
    Match.value(acceptEmpty).pipe(
      Match.when(true, () => Option.none()),
      Match.when(false, () => Option.some(DEVICE_INTEGRITY_FAILED)),
      Match.exhaustive,
    )
  const handleVerdicts = (vs: ReadonlyArray<DeviceRecognitionVerdict>): Option.Option<PlayIntegrityErrorCode> =>
    Match.value(vs.length === 0).pipe(
      Match.when(true, () => handleEmpty()),
      Match.when(false, () =>
        Match.value(vs.some((v) => accepted.has(v))).pipe(
          Match.when(true, () => Option.none()),
          Match.when(false, () => Option.some(DEVICE_INTEGRITY_FAILED)),
          Match.exhaustive,
        )),
      Match.exhaustive,
    )
  return Match.value(verdicts).pipe(
    Match.when(
      (v: ReadonlyArray<DeviceRecognitionVerdict> | null): v is ReadonlyArray<DeviceRecognitionVerdict> => v !== null,
      handleVerdicts,
    ),
    Match.orElse(() => handleEmpty()),
  )
}

const checkAppLicensing = (
  verdict: AppLicensingVerdict | null,
  accepted: ReadonlySet<AppLicensingVerdict | null>,
): Option.Option<PlayIntegrityErrorCode> =>
  Match.value(accepted.has(verdict)).pipe(
    Match.when(true, () => Option.none()),
    Match.when(false, () => Option.some('LICENSE_CHECK_FAILED' as const satisfies PlayIntegrityErrorCode)),
    Match.exhaustive,
  )

const checkCertificateDigest = (
  tokenDigests: ReadonlyArray<string> | null,
  expectedDigests: ReadonlySet<string>,
  acceptMissing: boolean,
): Option.Option<PlayIntegrityErrorCode> =>
  Match.value(tokenDigests).pipe(
    Match.when(
      (d: ReadonlyArray<string> | null): d is ReadonlyArray<string> => d !== null,
      (digests) =>
        Match.value(digests.some((d) => expectedDigests.has(d))).pipe(
          Match.when(true, () => Option.none()),
          Match.when(false, () => Option.some(APK_FINGERPRINT_MISMATCH)),
          Match.exhaustive,
        ),
    ),
    Match.orElse(() => missingFieldResult(acceptMissing, APK_FINGERPRINT_MISMATCH)),
  )

const checkPackageName = (
  packageName: string | null,
  allowedNames: ReadonlySet<string>,
  acceptMissing: boolean,
): Option.Option<PlayIntegrityErrorCode> =>
  Match.value(packageName).pipe(
    Match.when(null, () => missingFieldResult(acceptMissing, PACKAGE_NAME_MISMATCH)),
    Match.when(Match.string, (name) =>
      Match.value(allowedNames.has(name)).pipe(
        Match.when(true, () => Option.none()),
        Match.when(false, () => Option.some(PACKAGE_NAME_MISMATCH)),
        Match.exhaustive,
      )),
    Match.exhaustive,
  )

const collectErrors = (
  ...results: ReadonlyArray<Option.Option<PlayIntegrityErrorCode>>
): ReadonlyArray<PlayIntegrityErrorCode> => results.flatMap((opt) => Option.toArray(opt))

export const validatePlayIntegrityToken = (
  params: ValidatePlayIntegrityTokenParams,
): PlayIntegrityValidation => {
  const policy = MODE_POLICY[params.mode]

  const errors = collectErrors(
    checkAppRecognition(params.token.appRecognitionVerdict, policy.acceptAppRecognition),
    checkDeviceRecognition(
      params.token.deviceRecognitionVerdict,
      policy.acceptDeviceRecognition,
      policy.acceptEmptyDeviceRecognition,
    ),
    checkAppLicensing(params.token.appLicensingVerdict, policy.acceptAppLicensing),
    checkCertificateDigest(
      params.token.certificateSha256Digest,
      params.expectedCertificateDigests,
      policy.acceptMissingAppIntegrity,
    ),
    checkPackageName(params.token.packageName, params.allowedPackageNames, policy.acceptMissingAppIntegrity),
  )

  return Match.value(errors.length === 0).pipe(
    Match.when(true, () => new PlayIntegrityAccepted({})),
    Match.when(false, () => new PlayIntegrityRejected({ codes: [...errors] })),
    Match.exhaustive,
  )
}
