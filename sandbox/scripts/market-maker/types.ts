/**
 * DeepBook V3 constants and shared types for market maker.
 */

export const ORDER_TYPE = {
	NO_RESTRICTION: 0,
	IMMEDIATE_OR_CANCEL: 1,
	FILL_OR_KILL: 2,
	POST_ONLY: 3,
} as const

export const SELF_MATCHING = {
	ALLOWED: 0,
	CANCEL_TAKER: 1,
	CANCEL_MAKER: 2,
} as const

export const DECIMALS = {
	DEEP: 6,
	SUI: 9,
} as const

export const SUI_CLOCK_OBJECT_ID = '0x6'

export interface DeploymentManifest {
	network: {
		type: 'localnet' | 'testnet'
		rpcUrl: string
		faucetUrl: string
	}
	packages: {
		[key: string]: {
			packageId: string
			objects: Array<{
				objectId: string
				objectType: string
			}>
			transactionDigest: string
		}
	}
	pool: {
		poolId: string
		baseCoin: string
		quoteCoin: string
		transactionDigest: string
	}
	deploymentTime: string
	deployerAddress: string
}

export interface GridLevel {
	price: bigint
	quantity: bigint
	isBid: boolean
}

export interface ActiveOrder {
	orderId: string
	clientOrderId: bigint
	price: bigint
	quantity: bigint
	isBid: boolean
	placedAt: Date
}
