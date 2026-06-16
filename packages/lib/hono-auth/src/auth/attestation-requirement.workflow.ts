import { Either, Match, Schema as S } from 'effect'

const AndroidAttestationRequirementTypeId: unique symbol = Symbol.for(
  '@identity-backend/hono-auth/AndroidAttestationRequirement',
)
type AndroidAttestationRequirementTypeId = typeof AndroidAttestationRequirementTypeId

export class AndroidAttestationRequirementCommand extends S.TaggedClass<AndroidAttestationRequirementCommand>()(
  'AndroidAttestationRequirementCommand',
  {
    enforceAuth: S.Boolean,
    chainPresent: S.Boolean,
    requireChainForPlayIntegrity: S.Boolean,
  },
) {}

export class VerifyChain extends S.TaggedClass<VerifyChain>()('VerifyChain', {}) {
  readonly [AndroidAttestationRequirementTypeId] = AndroidAttestationRequirementTypeId
}

export class SkipVerification extends S.TaggedClass<SkipVerification>()('SkipVerification', {}) {
  readonly [AndroidAttestationRequirementTypeId] = AndroidAttestationRequirementTypeId
}

export const AndroidAttestationRequirementDecision = S.Union(VerifyChain, SkipVerification)
export type AndroidAttestationRequirementDecision = S.Schema.Type<
  typeof AndroidAttestationRequirementDecision
>

export class MissingChainError extends S.TaggedClass<MissingChainError>()('MissingChainError', {}) {}

export const AndroidAttestationRequirementError = S.Union(MissingChainError)
export type AndroidAttestationRequirementError = S.Schema.Type<typeof AndroidAttestationRequirementError>

const rejectMissingChain = (
  command: AndroidAttestationRequirementCommand,
): Either.Either<void, MissingChainError> =>
  Match.value(command).pipe(
    Match.when({ chainPresent: true }, () => Either.right(undefined)),
    Match.when({ requireChainForPlayIntegrity: true }, () => Either.left(new MissingChainError())),
    Match.when({ enforceAuth: true }, () => Either.left(new MissingChainError())),
    Match.orElse(() => Either.right(undefined)),
  )

export const decideAndroidAttestationRequirement = (
  command: AndroidAttestationRequirementCommand,
): Either.Either<AndroidAttestationRequirementDecision, AndroidAttestationRequirementError> =>
  Either.gen(function*() {
    yield* rejectMissingChain(command)
    return Match.value(command.chainPresent).pipe(
      Match.when(true, () => new VerifyChain()),
      Match.orElse(() => new SkipVerification()),
    )
  })
