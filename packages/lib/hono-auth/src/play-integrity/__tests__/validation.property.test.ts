import { describe, it } from '@effect/vitest'
import { ruleOfSchemas } from '@identity-backend/testing/schema'
import { FastCheck as fc } from 'effect'
import { PlayIntegrityErrorCode, PlayIntegrityMode, PlayIntegrityToken } from '../types.js'
import {
  PlayIntegrityAccepted,
  PlayIntegrityRejected,
  PlayIntegrityValidation,
  validatePlayIntegrityToken,
} from '../validation.workflow.js'

const KNOWN_ERROR_CODES = new Set<string>([
  'APP_INTEGRITY_FAILED',
  'DEVICE_INTEGRITY_FAILED',
  'LICENSE_CHECK_FAILED',
  'APK_FINGERPRINT_MISMATCH',
  'PACKAGE_NAME_MISMATCH',
])

const EXPECTED_CERTIFICATE_DIGESTS = new Set(['valid-digest-base64'])
const EXPECTED_PACKAGE_NAMES = new Set(['io.pcf.polkadotapp'])

const isRejected = (v: PlayIntegrityValidation): v is PlayIntegrityRejected => v._tag === 'PlayIntegrityRejected'

const codesOf = (v: PlayIntegrityValidation): ReadonlySet<PlayIntegrityErrorCode> =>
  isRejected(v) ? new Set(v.codes) : new Set()

const withTrustedDigest = (token: PlayIntegrityToken): PlayIntegrityToken => ({
  ...token,
  certificateSha256Digest: [...EXPECTED_CERTIFICATE_DIGESTS],
})

const disjointDigests = fc.tuple(fc.string(), fc.string()).map(([a, b]): [string, string] =>
  a === b ? [a, `${b}_different`] : [a, b]
)

const validate = (mode: PlayIntegrityMode, token: PlayIntegrityToken) =>
  validatePlayIntegrityToken({
    mode,
    token,
    expectedCertificateDigests: EXPECTED_CERTIFICATE_DIGESTS,
    allowedPackageNames: EXPECTED_PACKAGE_NAMES,
  })

describe('Rule of Schemas', () => {
  ruleOfSchemas('PlayIntegrityToken', PlayIntegrityToken)
  ruleOfSchemas('PlayIntegrityMode', PlayIntegrityMode)
  ruleOfSchemas('PlayIntegrityErrorCode', PlayIntegrityErrorCode)
})

describe('validatePlayIntegrityToken — mode monotonicity', () => {
  it.prop(
    '∀Token_DeviceModeVerdicts_⊆StrictModeVerdicts',
    [PlayIntegrityToken],
    ([token]) => {
      const strict = codesOf(validate('strict', token))
      const device = codesOf(validate('relaxed_device', token))
      return [...device].every((code) => strict.has(code))
    },
  )

  it.prop(
    '∀Token_AllModeVerdicts_⊆DeviceModeVerdicts',
    [PlayIntegrityToken],
    ([token]) => {
      const device = codesOf(validate('relaxed_device', token))
      const all = codesOf(validate('relaxed_all', token))
      return [...all].every((code) => device.has(code))
    },
  )
})

describe('validatePlayIntegrityToken — certificate digest', () => {
  it.prop(
    '∀Token_MatchingDigest_⊥FingerprintError',
    [fc.string(), PlayIntegrityToken],
    ([digest, token]) => {
      const tokenWithDigest: PlayIntegrityToken = { ...token, certificateSha256Digest: [digest] }
      const result = validatePlayIntegrityToken({
        mode: 'strict',
        token: tokenWithDigest,
        expectedCertificateDigests: new Set([digest]),
        allowedPackageNames: EXPECTED_PACKAGE_NAMES,
      })
      return !codesOf(result).has('APK_FINGERPRINT_MISMATCH')
    },
  )

  it.prop(
    '∀Token_MismatchedDigest_∈FingerprintError',
    [disjointDigests, PlayIntegrityToken],
    ([[tokenDigest, expectedDigest], token]) => {
      const tokenWithDigest: PlayIntegrityToken = { ...token, certificateSha256Digest: [tokenDigest] }
      const result = validatePlayIntegrityToken({
        mode: 'strict',
        token: tokenWithDigest,
        expectedCertificateDigests: new Set([expectedDigest]),
        allowedPackageNames: EXPECTED_PACKAGE_NAMES,
      })
      return codesOf(result).has('APK_FINGERPRINT_MISMATCH')
    },
  )

  it.prop(
    '∀Token_NullOrEmptyDigest_∈FingerprintError',
    [PlayIntegrityToken, fc.boolean()],
    ([token, useNull]) => {
      const digest = useNull ? null : []
      const tokenWithDigest: PlayIntegrityToken = { ...token, certificateSha256Digest: digest }
      const result = validate('strict', tokenWithDigest)
      return codesOf(result).has('APK_FINGERPRINT_MISMATCH')
    },
  )

  it.prop(
    '∀RelaxedAllMode_NullDigest_⊥FingerprintError',
    [PlayIntegrityToken],
    ([token]) => {
      const tokenWithDigest: PlayIntegrityToken = { ...token, certificateSha256Digest: null }
      const result = validate('relaxed_all', tokenWithDigest)
      return !codesOf(result).has('APK_FINGERPRINT_MISMATCH')
    },
  )

  it.prop(
    '∀RelaxedAllMode_MismatchedDigest_∈FingerprintError',
    [disjointDigests, PlayIntegrityToken],
    ([[tokenDigest, expectedDigest], token]) => {
      const tokenWithDigest: PlayIntegrityToken = { ...token, certificateSha256Digest: [tokenDigest] }
      const result = validatePlayIntegrityToken({
        mode: 'relaxed_all',
        token: tokenWithDigest,
        expectedCertificateDigests: new Set([expectedDigest]),
        allowedPackageNames: EXPECTED_PACKAGE_NAMES,
      })
      return codesOf(result).has('APK_FINGERPRINT_MISMATCH')
    },
  )
})

describe('validatePlayIntegrityToken — app recognition boundaries', () => {
  it.prop(
    '∀Mode_PlayRecognized_⊥AppError',
    [PlayIntegrityMode, PlayIntegrityToken],
    ([mode, token]) => {
      const result = validate(
        mode,
        withTrustedDigest({ ...token, appRecognitionVerdict: 'PLAY_RECOGNIZED' }),
      )
      return !codesOf(result).has('APP_INTEGRITY_FAILED')
    },
  )

  it.prop(
    '∀StrictMode_NonPlayRecognized_∈AppError',
    [fc.constantFrom('UNRECOGNIZED_VERSION' as const, 'UNEVALUATED' as const), PlayIntegrityToken],
    ([verdict, token]) => {
      const result = validate(
        'strict',
        withTrustedDigest({ ...token, appRecognitionVerdict: verdict }),
      )
      return codesOf(result).has('APP_INTEGRITY_FAILED')
    },
  )

  it.prop(
    '∀RelaxedAllMode_AnyAppVerdict_⊥AppError',
    [
      fc.constantFrom('PLAY_RECOGNIZED' as const, 'UNRECOGNIZED_VERSION' as const, 'UNEVALUATED' as const),
      PlayIntegrityToken,
    ],
    ([verdict, token]) => {
      const result = validate(
        'relaxed_all',
        withTrustedDigest({ ...token, appRecognitionVerdict: verdict }),
      )
      return !codesOf(result).has('APP_INTEGRITY_FAILED')
    },
  )
})

describe('validatePlayIntegrityToken — device recognition boundaries', () => {
  it.prop(
    '∀Mode_StrongIntegrity_⊥DeviceError',
    [PlayIntegrityMode, PlayIntegrityToken],
    ([mode, token]) => {
      const result = validate(
        mode,
        withTrustedDigest({ ...token, deviceRecognitionVerdict: ['MEETS_STRONG_INTEGRITY'] }),
      )
      return !codesOf(result).has('DEVICE_INTEGRITY_FAILED')
    },
  )

  it.prop(
    '∀StrictMode_BasicIntegrity_∈DeviceError',
    [PlayIntegrityToken],
    ([token]) => {
      const result = validate(
        'strict',
        withTrustedDigest({ ...token, deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY'] }),
      )
      return codesOf(result).has('DEVICE_INTEGRITY_FAILED')
    },
  )

  it.prop(
    '∀RelaxedDeviceMode_BasicIntegrity_⊥DeviceError',
    [PlayIntegrityToken],
    ([token]) => {
      const result = validate(
        'relaxed_device',
        withTrustedDigest({ ...token, deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY'] }),
      )
      return !codesOf(result).has('DEVICE_INTEGRITY_FAILED')
    },
  )

  it.prop(
    '∀StrictMode_EmptyDeviceVerdict_∈DeviceError',
    [PlayIntegrityToken],
    ([token]) => {
      const result = validate(
        'strict',
        withTrustedDigest({ ...token, deviceRecognitionVerdict: [] }),
      )
      return codesOf(result).has('DEVICE_INTEGRITY_FAILED')
    },
  )

  it.prop(
    '∀RelaxedDeviceMode_EmptyDeviceVerdict_∈DeviceError',
    [PlayIntegrityToken],
    ([token]) => {
      const result = validate(
        'relaxed_device',
        withTrustedDigest({ ...token, deviceRecognitionVerdict: [] }),
      )
      return codesOf(result).has('DEVICE_INTEGRITY_FAILED')
    },
  )

  it.prop(
    '∀RelaxedAllMode_EmptyDeviceVerdict_⊥DeviceError',
    [PlayIntegrityToken],
    ([token]) => {
      const result = validate(
        'relaxed_all',
        withTrustedDigest({ ...token, deviceRecognitionVerdict: [] }),
      )
      return !codesOf(result).has('DEVICE_INTEGRITY_FAILED')
    },
  )

  it.prop(
    '∀StrictMode_MixedDeviceVerdicts_⊥DeviceError',
    [PlayIntegrityToken],
    ([token]) => {
      const result = validate(
        'strict',
        withTrustedDigest({
          ...token,
          deviceRecognitionVerdict: ['MEETS_STRONG_INTEGRITY', 'MEETS_BASIC_INTEGRITY'],
        }),
      )
      return !codesOf(result).has('DEVICE_INTEGRITY_FAILED')
    },
  )
})

describe('validatePlayIntegrityToken — licensing boundaries', () => {
  it.prop(
    '∀Mode_Licensed_⊥LicenseError',
    [PlayIntegrityMode, PlayIntegrityToken],
    ([mode, token]) => {
      const result = validate(
        mode,
        withTrustedDigest({ ...token, appLicensingVerdict: 'LICENSED' }),
      )
      return !codesOf(result).has('LICENSE_CHECK_FAILED')
    },
  )

  it.prop(
    '∀StrictMode_Unlicensed_∈LicenseError',
    [PlayIntegrityToken],
    ([token]) => {
      const result = validate(
        'strict',
        withTrustedDigest({ ...token, appLicensingVerdict: 'UNLICENSED' }),
      )
      return codesOf(result).has('LICENSE_CHECK_FAILED')
    },
  )

  it.prop(
    '∀RelaxedAllMode_Unlicensed_⊥LicenseError',
    [PlayIntegrityToken],
    ([token]) => {
      const result = validate(
        'relaxed_all',
        withTrustedDigest({ ...token, appLicensingVerdict: 'UNLICENSED' }),
      )
      return !codesOf(result).has('LICENSE_CHECK_FAILED')
    },
  )
})

describe('validatePlayIntegrityToken — package name boundaries', () => {
  it.prop(
    '∀Mode_KnownPackageName_⊥PackageError',
    [PlayIntegrityMode, PlayIntegrityToken],
    ([mode, token]) => {
      const result = validate(
        mode,
        withTrustedDigest({ ...token, packageName: 'io.pcf.polkadotapp' }),
      )
      return !codesOf(result).has('PACKAGE_NAME_MISMATCH')
    },
  )

  it.prop(
    '∀Mode_UnknownPackageName_∈PackageError',
    [PlayIntegrityMode, fc.string(), PlayIntegrityToken],
    ([mode, unknownPkg, token]) => {
      const tokenWithPkg: PlayIntegrityToken = { ...withTrustedDigest(token), packageName: unknownPkg }
      const result = validate(mode, tokenWithPkg)
      const hasMismatch = codesOf(result).has('PACKAGE_NAME_MISMATCH')
      return EXPECTED_PACKAGE_NAMES.has(unknownPkg) ? !hasMismatch : hasMismatch
    },
  )

  it.prop(
    '∀NonRelaxedAllMode_NullPackageName_∈PackageError',
    [fc.constantFrom('strict' as const, 'relaxed_device' as const), PlayIntegrityToken],
    ([mode, token]) => {
      const result = validate(
        mode,
        withTrustedDigest({ ...token, packageName: null }),
      )
      return codesOf(result).has('PACKAGE_NAME_MISMATCH')
    },
  )

  it.prop(
    '∀RelaxedAllMode_NullPackageName_⊥PackageError',
    [PlayIntegrityToken],
    ([token]) => {
      const result = validate(
        'relaxed_all',
        withTrustedDigest({ ...token, packageName: null }),
      )
      return !codesOf(result).has('PACKAGE_NAME_MISMATCH')
    },
  )
})

describe('validatePlayIntegrityToken — verdict monotonicity', () => {
  it.prop(
    '∀Token_SetPlayRecognized_⊥AppError',
    [PlayIntegrityToken],
    ([token]) => {
      const before = codesOf(validate('strict', token))
      const after = codesOf(
        validate(
          'strict',
          { ...token, appRecognitionVerdict: 'PLAY_RECOGNIZED' },
        ),
      )
      return !after.has('APP_INTEGRITY_FAILED') || before.has('APP_INTEGRITY_FAILED')
    },
  )

  it.prop(
    '∀Token_AddStrongVerdict_⊥DeviceError',
    [PlayIntegrityToken],
    ([token]) => {
      const before = codesOf(validate('strict', token))
      const current = token.deviceRecognitionVerdict ?? []
      const improved: PlayIntegrityToken = {
        ...token,
        deviceRecognitionVerdict: [...current, 'MEETS_STRONG_INTEGRITY'],
      }
      const after = codesOf(validate('strict', improved))
      return !after.has('DEVICE_INTEGRITY_FAILED') || before.has('DEVICE_INTEGRITY_FAILED')
    },
  )

  it.prop(
    '∀Token_SetLicensed_⊥LicenseError',
    [PlayIntegrityToken],
    ([token]) => {
      const before = codesOf(validate('strict', token))
      const after = codesOf(
        validate(
          'strict',
          { ...token, appLicensingVerdict: 'LICENSED' },
        ),
      )
      return !after.has('LICENSE_CHECK_FAILED') || before.has('LICENSE_CHECK_FAILED')
    },
  )
})

describe('validatePlayIntegrityToken — maximal token', () => {
  it.prop(
    '∀Mode_MaximalToken_=Accepted',
    [PlayIntegrityMode],
    ([mode]) => {
      const maximalToken: PlayIntegrityToken = {
        appRecognitionVerdict: 'PLAY_RECOGNIZED',
        deviceRecognitionVerdict: ['MEETS_STRONG_INTEGRITY'],
        appLicensingVerdict: 'LICENSED',
        certificateSha256Digest: [...EXPECTED_CERTIFICATE_DIGESTS],
        packageName: 'io.pcf.polkadotapp',
      }
      const result = validate(mode, maximalToken)
      return result instanceof PlayIntegrityAccepted
    },
  )
})

describe('validatePlayIntegrityToken — empty token', () => {
  it.prop(
    '∀Mode_EmptyToken_≡ErrorCount',
    [PlayIntegrityMode],
    ([mode]) => {
      const emptyToken: PlayIntegrityToken = {
        appRecognitionVerdict: null,
        deviceRecognitionVerdict: null,
        appLicensingVerdict: null,
        certificateSha256Digest: null,
        packageName: null,
      }
      const result = validate(mode, emptyToken)
      const expectedCount = mode === 'relaxed_all' ? 2 : 5
      return isRejected(result) && result.codes.length === expectedCount
    },
  )
})

describe('validatePlayIntegrityToken — error code completeness', () => {
  it.prop(
    '∀Mode,Token_ValidationResult_⊆KnownCodes',
    [PlayIntegrityMode, PlayIntegrityToken],
    ([mode, token]) => {
      const result = validate(mode, token)
      return !isRejected(result) || result.codes.every((code) => KNOWN_ERROR_CODES.has(code))
    },
  )
})

describe('validatePlayIntegrityToken — encoding roundtrip', () => {
  const decodeHexTest = (hex: string): Uint8Array => {
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16)
    }
    return bytes
  }

  const encodeBase64UrlTest = (bytes: Uint8Array): string => {
    const lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const len = bytes.length
    const triplets = Math.floor(len / 3)
    const remainder = len % 3
    const chars: string[] = []
    let inIdx = 0
    for (const _ of Array.from({ length: triplets })) {
      const b0 = bytes[inIdx++]!
      const b1 = bytes[inIdx++]!
      const b2 = bytes[inIdx++]!
      chars.push(lookup[b0 >> 2]!)
      chars.push(lookup[((b0 & 0x03) << 4) | (b1 >> 4)]!)
      chars.push(lookup[((b1 & 0x0f) << 2) | (b2 >> 6)]!)
      chars.push(lookup[b2 & 0x3f]!)
    }
    if (remainder === 1) {
      const b0 = bytes[inIdx++]!
      chars.push(lookup[b0 >> 2]!)
      chars.push(lookup[(b0 & 0x03) << 4]!)
    } else if (remainder === 2) {
      const b0 = bytes[inIdx++]!
      const b1 = bytes[inIdx++]!
      chars.push(lookup[b0 >> 2]!)
      chars.push(lookup[((b0 & 0x03) << 4) | (b1 >> 4)]!)
      chars.push(lookup[(b1 & 0x0f) << 2]!)
    }
    return chars.join('')
  }

  it.prop(
    '∀RandomDigest_HexBase64UrlRoundtrip_=Accepted',
    [fc.uint8Array({ minLength: 32, maxLength: 32 })],
    ([rawBytes]) => {
      const hexDigest = Array.from(rawBytes, (b) => b.toString(16).padStart(2, '0')).join('')
      const base64urlDigest = encodeBase64UrlTest(decodeHexTest(hexDigest))

      const token: PlayIntegrityToken = {
        appRecognitionVerdict: 'PLAY_RECOGNIZED',
        deviceRecognitionVerdict: ['MEETS_STRONG_INTEGRITY'],
        appLicensingVerdict: 'LICENSED',
        certificateSha256Digest: [base64urlDigest],
        packageName: 'io.pcf.polkadotapp',
      }

      const result = validatePlayIntegrityToken({
        mode: 'strict',
        token,
        expectedCertificateDigests: new Set([base64urlDigest]),
        allowedPackageNames: EXPECTED_PACKAGE_NAMES,
      })

      return result instanceof PlayIntegrityAccepted
    },
  )
})
