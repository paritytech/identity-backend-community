import { Ss58String } from '@identity-backend/substrate-schema'

export const ALICE = {
  ss58Address: Ss58String.make('5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty'),
} as const

export const BOB = {
  ss58Address: Ss58String.make('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY'),
} as const

export const DIM_GAME = 'Game' as const
export const DIM_PROOF_OF_INK = 'ProofOfInk' as const
export const NETWORK_WESTEND2 = 'westend2' as const
export const POOL_TARGET = 50
export const BATCH_SIZE = 10
export const MAX_CONCURRENT_CLAIMS = 10

export const MOCK_INVITER = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy'
