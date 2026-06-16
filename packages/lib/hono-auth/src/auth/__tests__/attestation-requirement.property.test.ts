import { describe, it } from '@effect/vitest'
import { Either } from 'effect'
import {
  AndroidAttestationRequirementCommand,
  decideAndroidAttestationRequirement,
} from '../attestation-requirement.workflow.js'

describe('decideAndroidAttestationRequirement', () => {
  it.prop(
    '∀Command_FullMatrix_=SpecOutcome',
    [AndroidAttestationRequirementCommand],
    ([command]) => {
      const { chainPresent, requireChainForPlayIntegrity, enforceAuth } = command
      const expectError = !chainPresent && (requireChainForPlayIntegrity || enforceAuth)
      return Either.match(decideAndroidAttestationRequirement(command), {
        onLeft: (error) =>
          expectError &&
          error._tag === 'MissingChainError',
        onRight: (decision) =>
          !expectError &&
          decision._tag === (chainPresent ? 'VerifyChain' : 'SkipVerification'),
      })
    },
  )
})
