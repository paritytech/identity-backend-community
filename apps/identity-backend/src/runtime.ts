import { AccountBalance } from '#root/infrastructure/adapters/blockchain/mod.js'
import { APNService } from '#root/infrastructure/adapters/notifications/apn/index.js'
import { GetConnInfo, HttpMetricsMiddleware, Logger as HonoLoggingMiddleware } from '#root/middleware/mod.js'
import { FetchHttpClient } from '@effect/platform'
import { AppAttestService, AppAttestServiceConfig, AuthService } from '@identity-backend/auth/services'
import { sr25519 } from '@identity-backend/crypto'
import { DeviceCheckIOSEnvironment, layerDeviceCheckIOSService } from '@identity-backend/hono-auth/device-check'
import { ss58Address } from '@polkadot-labs/hdkd-helpers'
import { Config, Duration, Effect, Layer, Option, pipe, PubSub, Random, Redacted } from 'effect'

import { LeaderElectionDbLive } from '#root/leader-election/mod.js'
import * as config from './config.js'
import { DBLive, EffectSQLDbLive } from './db/mod.js'
import { ClaimInvitationTicketShell } from './features/dim/claim-invitation-ticket.shell.js'
import {
  DimTicketBlockchainService,
  DimTicketBlockchainServiceConfig,
} from './features/dim/dim-ticket-blockchain.service.js'
import { DimTicketDaemonShell } from './features/dim/dim-ticket-daemon.shell.js'
import { DimTicketConfig, DimTicketShell } from './features/dim/dim-ticket.shell.js'
import {
  InvitationTicketInviterConfig,
  TicketPoolConfig,
  TicketPoolShell,
} from './features/dim/invitation-ticket-pool.shell.js'
import { InviterSignerConfig, InviterSignerService } from './features/dim/inviter-signer.service.js'
import { OnChainTicketAPI } from './features/dim/onchain-ticket.adapter.js'
import { SubscriptionCrudShell } from './features/subscriptions/crud.shell.js'
import { StatementSubscriber } from './features/subscriptions/pipeline/processor.shell.js'
import { PushBroadcastUseCase } from './features/subscriptions/push-broadcast/push-broadcast.use-case.js'
import { SubscriptionRulesShell } from './features/subscriptions/rules.shell.js'
import { IssueTokenUseCase, RefreshTokenShellConfig } from './jwt/shell/issue-token.use-case.js'
import { JWTAuthService } from './jwt/shell/jwt-auth.service.js'
import { RotateTokenUseCase } from './jwt/shell/rotate-token.use-case.js'
import { CursorPaginationService } from './lib/cursor-pagination/mod.js'
import { RouteTimeout } from './lib/route-timeout.js'

import {
  IndividualityIndexerWorker,
  layerIndividualityIndexerSupervisor,
} from './supervision/individuality-indexer/mod.js'
import { InvitationTicketSupervisor } from './supervision/invitation-ticket/mod.js'
import { InvitationTicketNetworkConfig } from './supervision/invitation-ticket/workers/invitation-ticket.worker.js'
import { NotificationsProcessorSupervisor } from './supervision/notifications-processor/mod.js'
import { BalanceCheckWorkerDeps, RegistrationQueueSupervisor } from './supervision/registration-queue/mod.js'

import { layerWebSocketConstructor } from '@effect/platform-bun/BunSocket'

import { StatementStoreConfig, StatementStoreLive } from '@identity-backend/statement-store/live'
import { AssetHubRPCProviderService } from './infrastructure/adapters/blockchain/asset-hub-rpc-provider.service.js'
import { AssetHubTypedAPI } from './infrastructure/adapters/blockchain/asset-hub-typed-api.service.js'
import { IssueTurnCredentialsUseCase } from './webrtc/issue-turn-credentials.use-case.js'

import {
  PostgresAdvisoryLeaderLockLive,
  PostgresAdvisoryLeaderLockServiceConfig,
  reaperDaemon,
} from '#root/leader-election/mod.js'
import { ChainSubmitter } from './infrastructure/adapters/blockchain/chain-submitter.adapter.js'
import { DotnsGatewayAPI } from './infrastructure/adapters/blockchain/dotns-gateway.adapter.js'
import { PeopleChainCodecs } from './infrastructure/adapters/blockchain/people-chain-codecs.service.js'
import { PeopleAPI } from './infrastructure/adapters/blockchain/people-chain.adapter.js'
import { PeopleRPCProviderService } from './infrastructure/adapters/blockchain/people-rpc-provider.service.js'
import { PeopleTypedAPI } from './infrastructure/adapters/blockchain/people-typed-api.service.js'
import { UtilityAPI } from './infrastructure/adapters/blockchain/utility-chain.adapter.js'
import { FCMPushService } from './infrastructure/adapters/notifications/fcm/index.js'
import { WebPushService, WebPushServiceConfig } from './infrastructure/adapters/notifications/web/web-push.service.js'

import { ChallengeServiceLive } from './infrastructure/adapters/challenge.service.js'
import { AppAttestationRepositoryLive } from './infrastructure/adapters/repositories/app-attest.repository.js'
import {
  AndroidAttestationCrlServiceConfig,
  AndroidAttestationCrlServiceLive,
} from './infrastructure/android-attestation-crl.service.js'
import {
  DaemonReporterLive,
  DefectPubSub,
  DefectReporterLive,
  type ExceptionEvent,
} from './infrastructure/observability/mod.js'
import { layerBlockFinalizationDaemon } from './infrastructure/telemetry/daemons/block-finalization.daemon.js'
import { TokenBucketRateLimiter } from './infrastructure/token-bucket-rate-limiter.service.js'
import { layerLogger } from './runtime/logger.js'
import { layerOTEL } from './runtime/otel.js'
import { layerRx } from './runtime/rx.js'
import { ChainMetricsSupervisor } from './supervision/chain-metrics/chain-metrics.daemon.js'
import { DimTicketSupervisor } from './supervision/dim-ticket/mod.js'
import { LiteUsernameRegistrationSupervisor } from './supervision/lite-username-registration/mod.js'
import { PgMonitorSupervisor } from './supervision/pg-monitor/mod.js'
import { InstantClaim, PaymentAddressProvider } from './username-registration/registration-queue/claim-ports.js'
import { ClaimUsernameExecutorDeps } from './username-registration/registration-queue/claim.executor.js'
import { EnqueueUsernameRegistrationUseCase } from './username-registration/registration-queue/enqueue.use-case.js'
import { RegistrationQueueNetworkConfig } from './username-registration/registration-queue/network.config.js'
import { RegistrationQueueStatusConfig } from './username-registration/registration-queue/queue-status.config.js'

const applicationServicesLive = Layer.unwrapEffect(
  Effect.gen(function*() {
    // ── Section 1: Effectful config reads ──────────────────────

    const proxyKeypair = yield* sr25519.fromPrivateKey({
      privateKey: yield* config.PROXY_PRIVATE_KEY,
    })

    const proxyDelegationEnabled = yield* config.PROXY_DELEGATION_ENABLED

    const attesterPublicKey = yield* config.ATTESTER_PUBLIC_KEY

    const attesterSignerKeypair = proxyDelegationEnabled
      ? yield* sr25519.fromPrivateKey({
        privateKey: yield* config.ATTESTER_PROXY_PRIVATE_KEY,
      })
      : proxyKeypair

    const dimSigningProxyAs = proxyDelegationEnabled
      ? { real: ss58Address(attesterPublicKey) }
      : undefined

    const dimInviterAddress = proxyDelegationEnabled
      ? ss58Address(attesterPublicKey)
      : ss58Address(proxyKeypair.publicKey)

    const inviterPoolPrivateKey = yield* config.INVITER_POOL_PRIVATE_KEY
    const inviterPoolSignerKeypair = Option.isSome(inviterPoolPrivateKey)
      ? yield* sr25519.fromPrivateKey({ privateKey: inviterPoolPrivateKey.value })
      : attesterSignerKeypair

    yield* Option.isSome(inviterPoolPrivateKey)
      ? Effect.logInfo('Invitation ticket pool using dedicated signing account', {
        'invitation_ticket.pool.signer': ss58Address(inviterPoolSignerKeypair.publicKey),
      })
      : Effect.logWarning(
        'INVITER_POOL_PRIVATE_KEY is unset: invitation ticket pool is sharing the attester proxy ' +
          'signer and will contend with username registration on the shared submission permit',
        { 'invitation_ticket.pool.signer': ss58Address(inviterPoolSignerKeypair.publicKey) },
      )

    const invitationPoolTargetSize = yield* config.INVITATION_TICKET_POOL_TARGET
    const invitationPoolBatchSize = yield* config.INVITATION_TICKET_BATCH_SIZE

    const dotnsLayer = Layer.provideMerge(
      DotnsGatewayAPI.Default,
      Layer.provideMerge(
        AssetHubTypedAPI.Default,
        AssetHubRPCProviderService.Default,
      ),
    )

    const dotnsLayers = Layer.unwrapEffect(Effect.gen(function*() {
      const dotnsGatewayEnabled = yield* config.DOTNS_GATEWAY_ENABLED
      if (!dotnsGatewayEnabled) {
        return Layer.empty
      }

      return dotnsLayer
    }))

    const BlockchainLive = Layer.provideMerge(
      Layer.mergeAll(
        PeopleAPI.Default,
        dotnsLayers,
      ),
      Layer.mergeAll(UtilityAPI.Default, OnChainTicketAPI.Default),
    ).pipe(Layer.provideMerge(ChainSubmitter.Default))

    // ── Section 3: Database-dependent services ─────────────────

    const WebPushServiceLive = Layer.unwrapEffect(
      Effect.gen(function*() {
        const enabled = yield* config.WEB_PUSH_ENABLED
        if (!enabled) return Layer.empty

        const { publicKey, privateKey } = yield* config.WEB_PUSH_VAPID_KEYPAIR
        const subject = yield* config.WEB_PUSH_VAPID_SUBJECT

        return Layer.provide(
          WebPushService.DefaultWithoutDependencies,
          Layer.succeed(WebPushServiceConfig, { publicKey, privateKey, subject }),
        )
      }),
    )

    const DatabaseServicesLive = Layer.provideMerge(
      Layer.mergeAll(
        ChallengeServiceLive,
        AppAttestationRepositoryLive,
        SubscriptionCrudShell.Default,
        SubscriptionRulesShell.Default,
        Layer.provide(
          PushBroadcastUseCase.Default,
          Layer.mergeAll(APNService.Default, FCMPushService.Default, WebPushServiceLive),
        ),
      ),
      DBLive,
    )

    // ── Section 4: Feature layers (blockchain + DB) ────────────

    const DimTicketBlockchainServiceLive = Layer.provide(
      DimTicketBlockchainService.Default,
      Layer.succeed(DimTicketBlockchainServiceConfig, {
        submitTimeout: Duration.seconds(120),
        proxyAs: dimSigningProxyAs,
      }),
    )

    const FeaturesLive = Layer.provideMerge(
      Layer.mergeAll(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.provide(
              DimTicketShell.Default,
              Layer.succeed(DimTicketConfig, { inviterAddress: dimInviterAddress }),
            ),
            Layer.provide(
              DimTicketDaemonShell.DefaultWithoutDependencies,
              Layer.provide(
                Layer.fresh(InviterSignerService.Default),
                Layer.succeed(InviterSignerConfig, {
                  keypair: inviterPoolSignerKeypair,
                }),
              ),
            ),
          ),
          DimTicketBlockchainServiceLive,
        ),
        Layer.provideMerge(
          Layer.mergeAll(
            ClaimInvitationTicketShell.Default,
            Layer.provide(
              TicketPoolShell.Default,
              Layer.mergeAll(
                Layer.succeed(InvitationTicketInviterConfig, {
                  inviterAddress: dimInviterAddress,
                  proxyAs: dimSigningProxyAs,
                }),
                Layer.succeed(TicketPoolConfig, {
                  interval: Duration.seconds(6),
                  batchSize: invitationPoolBatchSize,
                  poolTargetSize: invitationPoolTargetSize,
                  timeout: Duration.seconds(60),
                  maxRetries: 5,
                  retryBaseDelay: Duration.seconds(1),
                  retryMaxDelay: Duration.minutes(1),
                }),
                Layer.succeed(InviterSignerConfig, {
                  keypair: inviterPoolSignerKeypair,
                }),
              ),
            ),
          ),
          Layer.succeed(InvitationTicketNetworkConfig, { network: yield* config.PEOPLE_NETWORK }),
        ),
        Layer.provide(
          AppAttestService.Default,
          Layer.succeed(AppAttestServiceConfig, {
            appIds: Array.from(yield* config.APPLE_APP_ATTEST_APP_IDS),
          }),
        ),
        ChainMetricsSupervisor.Default,
        PgMonitorSupervisor.Default.pipe(Layer.provide(EffectSQLDbLive)),
        EnqueueUsernameRegistrationUseCase.Default,
        RegistrationQueueNetworkConfig.Default,
        RegistrationQueueStatusConfig.Default,
        Layer.effect(
          ClaimUsernameExecutorDeps,
          Effect.gen(function*() {
            const payment = yield* PaymentAddressProvider
            const instant = yield* InstantClaim
            const enqueue = yield* EnqueueUsernameRegistrationUseCase
            return { quote: payment.quote, claimInstant: instant.claim, enqueue }
          }),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              PaymentAddressProvider.Default,
              InstantClaim.Default,
              EnqueueUsernameRegistrationUseCase.Default,
            ),
          ),
        ),
      ),
      Layer.mergeAll(BlockchainLive, DatabaseServicesLive),
    )

    // ── Section 5: Standalone services ─────────────────────────

    const IndividualityIndexerSupervisorLive = Layer.unwrapEffect(Effect.gen(function*() {
      const usernameIndexerEnabled = yield* config.USERNAME_INDEXER_ENABLED
      if (!usernameIndexerEnabled) return Layer.empty

      const network = yield* config.PEOPLE_NETWORK
      const peopleWsClient = yield* PeopleRPCProviderService
      return layerIndividualityIndexerSupervisor({
        children: Effect.all(
          [
            IndividualityIndexerWorker.make({
              client: peopleWsClient,
            }),
          ],
          { concurrency: 'unbounded' },
        ),
      }).pipe(
        Layer.provide(Layer.succeed(IndividualityIndexerWorker.IndividualityIndexerConfig, { network })),
        Layer.provide(
          Layer.effect(
            IndividualityIndexerWorker.IndividualityIndexerRuntimeConfig,
            Effect.gen(function*() {
              const defaults = yield* IndividualityIndexerWorker.IndividualityIndexerRuntimeConfig
              return IndividualityIndexerWorker.IndividualityIndexerRuntimeConfig.of({
                ...defaults,
                syncInterval: Duration.millis(yield* config.USERNAME_INDEXER_SYNC_INTERVAL_MS),
              })
            }),
          ),
        ),
        Layer.provide(DBLive),
      )
    }))

    const NotificationsProcessorSupervisorLive = Layer.unwrapEffect(Effect.gen(function*() {
      const notificationsProcessorEnabled = yield* config.PUSH_SUBSCRIPTIONS_INDEXER_ENABLED
      if (!notificationsProcessorEnabled) return Layer.empty
      const peopleWsClient = yield* PeopleRPCProviderService

      return NotificationsProcessorSupervisor.Default.pipe(
        Layer.provide(Layer.mergeAll(DBLive, APNService.Default, FCMPushService.Default, WebPushServiceLive)),
        Layer.provide(StatementStoreLive.pipe(
          Layer.provide(
            Layer.succeed(StatementStoreConfig, {
              provider: peopleWsClient.provider,
            }),
          ),
        )),
      )
    }))

    const RegistrationQueueSupervisorLive = Layer.unwrapEffect(Effect.gen(function*() {
      const registrationQueueEnabled = yield* config.REGISTRATION_QUEUE_ENABLED
      if (!registrationQueueEnabled) return Layer.empty

      const peopleClient = yield* PeopleRPCProviderService
      const { encodeKey, decodeValue } = yield* PeopleChainCodecs

      const reader = AccountBalance.make({ client: peopleClient, codec: { encodeKey, decodeValue } })

      return RegistrationQueueSupervisor.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            DBLive,
            Layer.succeed(BalanceCheckWorkerDeps, reader),
          ),
        ),
      )
    }))

    const jwtDependencies = Layer.mergeAll(
      AuthService.Default,
      JWTAuthService.Default,
      DBLive,
      Layer.effect(
        RefreshTokenShellConfig,
        Effect.gen(function*() {
          const { REFRESH_TOKEN_DURATION_DAYS } = yield* Effect.promise(() => import('#root/config.js'))
          return RefreshTokenShellConfig.of({ tokenDuration: yield* REFRESH_TOKEN_DURATION_DAYS })
        }),
      ),
    )

    const JwtServicesLive = Layer.mergeAll(
      Layer.provide(IssueTokenUseCase.Default, jwtDependencies),
      Layer.provide(RotateTokenUseCase.Default, jwtDependencies),
    )

    const deviceCheckIOSEnabled = yield* config.DEVICE_CHECK_IOS_ENABLED

    const DeviceCheckIOSLive = deviceCheckIOSEnabled
      ? layerDeviceCheckIOSService.pipe(
        Layer.provide(
          Layer.effect(
            DeviceCheckIOSEnvironment,
            Effect.gen(function*() {
              const { teamId, keyId, privateKeyPem, baseURL } = yield* Config.all({
                teamId: config.APPLE_TEAM_ID,
                keyId: config.DEVICE_CHECK_KEY_ID,
                privateKeyPem: config.DEVICE_CHECK_PRIVATE_KEY_P8,
                baseURL: config.DEVICE_CHECK_URL,
              })

              const { importPKCS8 } = yield* Effect.promise(() => import('jose'))

              const importedKey = yield* Effect.tryPromise({
                try: () => importPKCS8(Redacted.value(privateKeyPem), 'ES256', { extractable: false }),
                catch: (cause) => new Error('Failed to import DeviceCheck private key', { cause }),
              }).pipe(Effect.orDie)

              return {
                teamId,
                keyId,
                privateKey: importedKey,
                baseURL,
                jwtDuration: Duration.minutes(10),
                jwtCacheGracePeriod: Duration.seconds(30),
              }
            }),
          ),
        ),
        Layer.provide(FetchHttpClient.layer),
      )
      : Layer.empty

    const AndroidAttestationCrlLive = AndroidAttestationCrlServiceLive.pipe(
      Layer.provide(
        Layer.effect(
          AndroidAttestationCrlServiceConfig,
          Effect.gen(function*() {
            const crlUrl = yield* config.ANDROID_ATTESTATION_CRL_URL
            const cacheTtl = yield* config.ANDROID_ATTESTATION_CRL_CACHE_TTL
            return {
              crlUrl,
              cacheTtl,
            }
          }),
        ),
      ),
      Layer.provide(FetchHttpClient.layer),
    )

    const peopleWsClient = yield* PeopleRPCProviderService

    const StandaloneLive = Layer.mergeAll(
      IndividualityIndexerSupervisorLive,
      NotificationsProcessorSupervisorLive,
      RegistrationQueueSupervisorLive,
      CursorPaginationService.Default,
      APNService.Default,
      DeviceCheckIOSLive,
      FCMPushService.Default,
      WebPushServiceLive,
      TokenBucketRateLimiter.Default,
      GetConnInfo.Default,
      IssueTurnCredentialsUseCase.Default,
      JwtServicesLive,
      AuthService.Default,
      AndroidAttestationCrlLive,
      Layer.provide(
        StatementSubscriber.Default,
        Layer.provide(
          StatementStoreLive,
          Layer.succeed(StatementStoreConfig, { provider: peopleWsClient.provider }),
        ),
      ),
      HonoLoggingMiddleware.Default,
      HttpMetricsMiddleware.Default,
      Layer.succeed(RouteTimeout, yield* config.ROUTE_TIMEOUT),
      (yield* config.FINALIZED_BLOCK_DAEMON_ENABLED)
        ? layerBlockFinalizationDaemon(peopleWsClient, {
          blockTimeout: yield* config.FINALIZED_BLOCK_TIMEOUT,
        })
        : Layer.empty,
      LiteUsernameRegistrationSupervisor.Default.pipe(
        Layer.provide(Layer.mergeAll(BlockchainLive, DatabaseServicesLive)),
      ),
      (yield* config.INVITATION_TICKET_DAEMON_ENABLED)
        ? InvitationTicketSupervisor.Default.pipe(
          Layer.provideMerge(FeaturesLive),
        )
        : Layer.empty,
      DimTicketSupervisor.Default.pipe(
        Layer.provideMerge(FeaturesLive),
        Layer.provideMerge(observabilityLive),
      ),
    )

    return Layer.mergeAll(
      FeaturesLive,
      Layer.provideMerge(StandaloneLive, Layer.mergeAll(LeaderElectionDbLive, DBLive)),
    )
  }),
)

const observabilityLive = Layer.provideMerge(
  DaemonReporterLive,
  Layer.provideMerge(DefectReporterLive, Layer.effect(DefectPubSub, PubSub.unbounded<ExceptionEvent>())),
)

const leaderLockConfigLayer = Layer.effect(
  PostgresAdvisoryLeaderLockServiceConfig,
  Effect.gen(function*() {
    const cfg = yield* Effect.promise(() => import('#root/config.js'))
    const podId = yield* pipe(
      Config.string('POD_ID'),
      Config.withDefault(process.env.HOSTNAME ?? 'unknown'),
      Config.map((s: string) => s.trim()),
    )
    const { reaperInterval } = yield* Config.all({ reaperInterval: cfg.LEADER_DB_REAPER_INTERVAL })
    return { podId, reaperInterval }
  }),
)

const runtimeInfrastructureLive = Layer.mergeAll(
  PostgresAdvisoryLeaderLockLive.pipe(
    Layer.provideMerge(LeaderElectionDbLive),
    Layer.provideMerge(leaderLockConfigLayer),
    Layer.provideMerge(observabilityLive),
  ),
  reaperDaemon.pipe(
    Layer.provideMerge(LeaderElectionDbLive),
    Layer.provideMerge(leaderLockConfigLayer),
    Layer.provideMerge(observabilityLive),
  ),
  PeopleChainCodecs.Default,
  PeopleTypedAPI.Default,
  PeopleRPCProviderService.Default,
)

export const layerRuntime = Layer.provideMerge(applicationServicesLive, runtimeInfrastructureLive).pipe(
  Layer.provide(layerWebSocketConstructor),
  Layer.provide(layerOTEL),
  Layer.provide(layerLogger),
  Layer.provide(layerRx),
  Layer.provide(Layer.effect(Random.Random, Effect.random)),
  Layer.provide(RegistrationQueueNetworkConfig.Default),
)
