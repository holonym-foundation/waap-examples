/**
 * Strategy settings from the environment, shared by the live loop (`agent.ts`) and the
 * offline replay (`replay.ts`) so a replayed strategy is exactly the one that would run.
 * Every default is in `.env.example` with its reason.
 */
import { DEFAULT_CYCLE } from './costs.ts'
import { DEFAULT_STRATEGY, type StrategyConfig } from './strategy.ts'

export function envNum(k: string, d: number, env: NodeJS.ProcessEnv = process.env): number {
	const v = env[k]
	if (v === undefined || v === '') return d
	const n = Number(v)
	if (!Number.isFinite(n)) {
		console.error(`[deepbook-maker] ${k}=${v} is not a number`)
		process.exit(1)
	}
	return n
}

export function envFlag(k: string, d: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
	const v = (env[k] ?? '').toLowerCase()
	return v === '' ? d : v === '1' || v === 'true'
}

export function strategyFromEnv(env: NodeJS.ProcessEnv = process.env): StrategyConfig {
	const num = (k: string, d: number) => envNum(k, d, env)
	const flag = (k: string, d: boolean) => envFlag(k, d, env)
	return {
		...DEFAULT_STRATEGY,
		targetBaseFraction: num('TARGET_BASE_FRACTION', DEFAULT_STRATEGY.targetBaseFraction),
		bandLow: num('BAND_LOW', DEFAULT_STRATEGY.bandLow),
		bandHigh: num('BAND_HIGH', DEFAULT_STRATEGY.bandHigh),
		skewMaxBps: num('SKEW_MAX_BPS', DEFAULT_STRATEGY.skewMaxBps),
		maxOrderSize: num('ORDER_SIZE', DEFAULT_STRATEGY.maxOrderSize),
		minSpreadBps: num('SPREAD_BPS', DEFAULT_STRATEGY.minSpreadBps),
		maxSpreadBps: num('MAX_SPREAD_BPS', DEFAULT_STRATEGY.maxSpreadBps),
		touchMultiple: num('TOUCH_MULTIPLE', DEFAULT_STRATEGY.touchMultiple),
		holdOnLiquidityPause: flag('HOLD_ON_LIQUIDITY_PAUSE', DEFAULT_STRATEGY.holdOnLiquidityPause),
		resumeMargin: num('LIQUIDITY_RESUME_MARGIN', DEFAULT_STRATEGY.resumeMargin),
		minLiquidityPauseMs: num('LIQUIDITY_MIN_PAUSE_MIN', DEFAULT_STRATEGY.minLiquidityPauseMs / 60_000) * 60_000,
		toleranceBps: num('REQUOTE_TOLERANCE_BPS', DEFAULT_STRATEGY.toleranceBps),
		minDwellMs: num('MIN_DWELL_SEC', DEFAULT_STRATEGY.minDwellMs / 1000) * 1000,
		orderTtlMs: num('ORDER_TTL_MIN', DEFAULT_STRATEGY.orderTtlMs / 60_000) * 60_000,
		refreshBeforeExpiryMs: num('REFRESH_BEFORE_EXPIRY_MIN', DEFAULT_STRATEGY.refreshBeforeExpiryMs / 60_000) * 60_000,
		staleBookMs: num('STALE_BOOK_SEC', DEFAULT_STRATEGY.staleBookMs / 1000) * 1000,
		payWithDeep: flag('PAY_WITH_DEEP', DEFAULT_STRATEGY.payWithDeep),
		deepFeeReserve: num('DEEP_FEE_RESERVE', DEFAULT_STRATEGY.deepFeeReserve),
		cycle: {
			...DEFAULT_CYCLE,
			replacementsPerCycle: num('COST_REPLACEMENTS_PER_CYCLE', DEFAULT_CYCLE.replacementsPerCycle),
			cyclesToAmortize: num('COST_CYCLES_TO_AMORTIZE', DEFAULT_CYCLE.cyclesToAmortize),
			quantile: (env.COST_QUANTILE as 'median' | 'p90' | 'max') ?? DEFAULT_CYCLE.quantile,
		},
	}
}
