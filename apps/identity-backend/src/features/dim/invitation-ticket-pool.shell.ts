import { outcomeFromCause } from '#root/batch-backoff/batch-backoff.acl.js'
import { recordBatchOutcome, RecordBatchOutcomeDeps } from '#root/batch-backoff/batch-backoff.executor.js'
import {
  type BatchOutcome,
  BatchSize,
  BatchSizePolicy,
  OtherFailure,
  Succeeded,
} from '#root/batch-backoff/batch-backoff.schema.js'
import { DB, schema } from '#root/db/mod.js'
import {
  invitationTicketBatchSizeHistogram,
  invitationTicketPoolSizeGauge,
} from '#root/features/dim/invitation-ticket.metrics.js'
import { sr25519 } from '@identity-backend/crypto'
import { ss58Address } from '@polkadot-labs/hdkd-helpers'
import { encodeBase64 } from '@std/encoding'
import { and, count, eq } from 'drizzle-orm'
import { Array, Context, Duration, Effect, Either, Layer, Match, Metric, Redacted, Ref, Schema as S } from 'effect'
import { Dim, Network, TicketAddress } from './invitation-ticket.schema.js'
import { InviterSignerService } from './inviter-signer.service.js'
import { type OnChainTicket, OnChainTicketAPI } from './onchain-ticket.adapter.js'

// =============================================================================
// Pure core: pool-maintenance decision
// =============================================================================

const PoolStateTypeId: unique symbol = Symbol.for('@identity-backend/invitation-ticket/PoolState')
type PoolStateTypeId = typeof PoolStateTypeId

class PoolState extends S.Class<PoolState>('PoolState')({
  count: S.NonNegativeInt,
}) {
  readonly [PoolStateTypeId] = PoolStateTypeId
}

const InvitationTicketTypeId: unique symbol = Symbol.for('@identity-backend/invitation-ticket')
type InvitationTicketTypeId = typeof InvitationTicketTypeId

class NeedMore extends S.TaggedClass<NeedMore>()('NeedMore', {
  size: BatchSize,
}) {
  readonly [InvitationTicketTypeId] = InvitationTicketTypeId
}

class PoolOK extends S.TaggedClass<PoolOK>()('PoolOK', {}) {
  readonly [InvitationTicketTypeId] = InvitationTicketTypeId
}

type PoolStatus = NeedMore | PoolOK

const decidePoolStatus = (state: PoolState, target: number, maxBatch: BatchSize): PoolStatus =>
  Match.value(state.count < target).pipe(
    Match.when(true, () => {
      const needed = target - state.count
      const result = Math.min(needed, maxBatch)
      const size = BatchSize.make(Math.max(1, Math.trunc(result)))
      return new NeedMore({ size })
    }),
    Match.when(false, () => new PoolOK({})),
    Match.exhaustive,
  )

const selectByIndices = <A>(items: readonly A[], indices: readonly number[]): readonly A[] =>
  Array.filterMap(indices, (index) => Array.get(items, index))

// =============================================================================
// Errors and configuration
// =============================================================================

export class TicketPoolError extends S.TaggedError<TicketPoolError>()('TicketPoolError', {
  message: S.String,
  retryable: S.Boolean,
  cause: S.optional(S.Unknown),
}) {}

export class TicketPoolConfig extends Context.Reference<TicketPoolConfig>()(
  'TicketPoolConfig',
  {
    defaultValue: () => ({
      interval: Duration.seconds(6),
      batchSize: BatchSize.make(100),
      poolTargetSize: 10_000,
      timeout: Duration.seconds(60),
      maxRetries: 5,
      retryBaseDelay: Duration.seconds(1),
      retryMaxDelay: Duration.minutes(1),
    }),
  },
) {}

export class InvitationTicketInviterConfig extends Context.Tag('InvitationTicketInviterConfig')<
  InvitationTicketInviterConfig,
  {
    readonly inviterAddress: string
    readonly proxyAs: { readonly real: string } | undefined
  }
>() {}

export namespace TicketPoolShell {
  export interface Definition {
    readonly execute: (
      dim: Dim,
      network: Network,
    ) => Effect.Effect<void, TicketPoolError>
  }
}

interface GeneratedTicket {
  readonly onChainTicket: OnChainTicket
  readonly keypair: sr25519.Keypair
}

// =============================================================================
// Imperative shell
// =============================================================================

const make = Effect.gen(function*() {
  const db = yield* DB
  const config = yield* TicketPoolConfig
  const inviterConfig = yield* InvitationTicketInviterConfig
  const onChainAPI = yield* OnChainTicketAPI
  const signerService = yield* InviterSignerService
  const batchSizePolicy = BatchSizePolicy.Default(config.batchSize)
  const batchSizeRef = yield* Ref.make(batchSizePolicy.max)
  const batchBackoff: Context.Tag.Service<typeof RecordBatchOutcomeDeps> = {
    daemon: 'invitation-ticket-pool',
    policy: batchSizePolicy,
    size: batchSizeRef,
  }

  const countAvailable = (dim: Dim, network: Network) =>
    Effect.tryPromise(async () => {
      const rows = await db
        .select({ count: count() })
        .from(schema.invitationTickets)
        .where(
          and(
            eq(schema.invitationTickets.dim, dim),
            eq(schema.invitationTickets.network, network),
            eq(schema.invitationTickets.state, 'available'),
          ),
        )
      return rows[0]?.count ?? 0
    }).pipe(
      Effect.mapError((cause) =>
        new TicketPoolError({ message: 'Failed to count available tickets', retryable: true, cause })
      ),
    )

  const generateTicket = (dim: Dim): Effect.Effect<GeneratedTicket> =>
    sr25519.generateKeypair().pipe(
      Effect.map((keypair) => ({
        keypair,
        onChainTicket: { ticket: TicketAddress.make(ss58Address(keypair.publicKey, 0)), dim },
      })),
    )

  const persist = (accepted: readonly GeneratedTicket[], network: Network) =>
    Effect.tryPromise(() =>
      db.insert(schema.invitationTickets).values(
        accepted.map(({ keypair, onChainTicket }) => ({
          publicKey: encodeBase64(keypair.publicKey),
          privateKey: encodeBase64(Redacted.value(keypair.privateKey)),
          dim: onChainTicket.dim,
          network,
          inviter: inviterConfig.inviterAddress,
          state: 'available' as const,
        })),
      ).onConflictDoNothing({ target: schema.invitationTickets.publicKey })
    ).pipe(
      Effect.tapError(() =>
        Effect.logError('Invitation tickets registered on chain but DB insert failed', {
          'invitation_ticket.network': network,
          'invitation_ticket.pool.registered': accepted.length,
          'error.category': 'data-integrity',
        })
      ),
    )

  const refillBatch = (dim: Dim, network: Network, size: number): Effect.Effect<BatchOutcome> =>
    Effect.gen(function*() {
      const signer = yield* signerService.getSigner()
      const generated = yield* Effect.forEach(
        Array.makeBy(size, (index) => index),
        () => generateTicket(dim),
        { concurrency: 'unbounded' },
      )
      const options = inviterConfig.proxyAs !== undefined ? { proxyAs: inviterConfig.proxyAs } : undefined

      const submission = yield* onChainAPI.setTickets(
        Array.map(generated, ({ onChainTicket }) => onChainTicket),
        signer,
        options,
      ).pipe(
        Effect.withSpan('blockchain.set_invite_ticket', {
          attributes: { 'invitation_ticket.network': network, 'blockchain.batch.size': size },
        }),
        Effect.either,
      )

      return yield* Either.match(submission, {
        onLeft: (error) =>
          Effect.gen(function*() {
            yield* Effect.logWarning('Invitation ticket batch registration failed', {
              'invitation_ticket.dim': dim,
              'invitation_ticket.network': network,
              'invitation_ticket.pool.batch_size': size,
              'error.type': error._tag,
            })
            return outcomeFromCause(error)
          }),
        onRight: (result) =>
          Effect.gen(function*() {
            const accepted = selectByIndices(generated, result.completedIndices)
            if (accepted.length > 0) {
              const persisted = yield* persist(accepted, network).pipe(Effect.either)
              if (Either.isLeft(persisted)) {
                return new OtherFailure({})
              }
              yield* Metric.update(invitationTicketBatchSizeHistogram, accepted.length)
            }
            yield* Effect.logInfo('Invitation ticket batch registered on chain', {
              'invitation_ticket.dim': dim,
              'invitation_ticket.network': network,
              'invitation_ticket.pool.registered': accepted.length,
              'invitation_ticket.pool.failed': result.failedIndices.length,
              'blockchain.tx.block_number': result.blockNumber,
            })
            return new Succeeded({})
          }),
      })
    })

  const execute = Effect.fn('job.maintain_pool')(
    function*(dim: Dim, network: Network) {
      yield* Effect.annotateCurrentSpan('invitation_ticket.dim', dim)
      yield* Effect.annotateCurrentSpan('invitation_ticket.network', network)

      const count = yield* countAvailable(dim, network)
      yield* Metric.update(
        Metric.tagged(
          Metric.tagged(invitationTicketPoolSizeGauge, 'dim', dim),
          'network',
          network,
        ),
        count,
      )

      const current = yield* Ref.get(batchSizeRef)
      const status = decidePoolStatus(new PoolState({ count }), config.poolTargetSize, current)

      yield* Match.value(status).pipe(
        Match.tag('PoolOK', () => Effect.void),
        Match.tag('NeedMore', ({ size }) =>
          Effect.gen(function*() {
            yield* Effect.logDebug('Pool status: below target, generating ticket batch', {
              'invitation_ticket.pool.current_size': count,
              'invitation_ticket.pool.target_size': config.poolTargetSize,
              'invitation_ticket.pool.batch_size': size,
            })
            const outcome = yield* refillBatch(dim, network, size)
            yield* recordBatchOutcome(outcome).pipe(
              Effect.provideService(RecordBatchOutcomeDeps, batchBackoff),
            )
          })),
        Match.exhaustive,
      )
    },
  ) satisfies TicketPoolShell['Type']['execute']

  return TicketPoolShell.of({ execute })
})

export class TicketPoolShell extends Context.Tag('@app/TicketPoolShell')<
  TicketPoolShell,
  TicketPoolShell.Definition
>() {
  static readonly DefaultWithoutDependencies = Layer.scoped(TicketPoolShell, make)
  static readonly Default = Layer.suspend(() => TicketPoolShell.DefaultWithoutDependencies).pipe(
    Layer.provideMerge(OnChainTicketAPI.Default),
    Layer.provideMerge(Layer.fresh(InviterSignerService.Default)),
  )
}

if (import.meta.vitest) {
  const { describe, it } = await import('@effect/vitest')

  describe('decidePoolStatus', () => {
    it.prop(
      '∀x_DecidesByThreshold_=x',
      [PoolState, S.NonNegativeInt, BatchSize],
      ([state, target, maxBatch]) =>
        Match.value(decidePoolStatus(state, target, maxBatch)).pipe(
          Match.tag(
            'NeedMore',
            (s) =>
              state.count < target &&
              s.size >= 1 &&
              s.size <= maxBatch &&
              s.size <= target - state.count &&
              (s.size === maxBatch || s.size === target - state.count),
          ),
          Match.tag('PoolOK', () => state.count >= target),
          Match.exhaustive,
        ),
    )
  })

  describe('selectByIndices', () => {
    it.prop(
      '∀x_SelectsItemsAtInBoundsIndicesInOrder_=x',
      [S.Array(S.Int), S.Array(S.Int)],
      ([items, indices]) => {
        const kept = indices.filter((i) => i >= 0 && i < items.length)
        const result = selectByIndices(items, indices)
        return result.length === kept.length && result.every((v, k) => v === items[kept[k]!])
      },
    )
  })
}
