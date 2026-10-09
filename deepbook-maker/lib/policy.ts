/**
 * Reading the policy engine's answer.
 *
 * the policy probe is graded on an **observed policy ask or rejection** — not on a nonzero exit code,
 * which a dead network, a bad argument or an insufficient balance would also produce.
 * The distinction matters because the probe deliberately asks for 999 SUI from a wallet
 * that holds about one: "it was refused" is only evidence of policy if the refusal came
 * from the policy and not from arithmetic.
 *
 * So the raw text is classified here, as a pure function over the CLI's own output, and
 * the classification is logged BESIDE the verbatim response, never instead of it. When
 * nothing matches, the answer is `unknown` and the grader reads the raw text — an
 * honest "I could not tell" rather than a guess dressed as a grade.
 *
 * The patterns are deliberately broad and are matched against stdout and stderr
 * together. They have not been exercised against a live refusal: waap-cli's exact
 * refusal wording is not documented in this workspace and no refusal has been observed
 * on this account. That is why `unknown` keeps the raw text and why the policy probe must be graded by
 * a human reading `policy_probe.response`, not by this label alone.
 */

export type ProbeOutcome =
	/** The enclave signed it. On a 999 SUI probe this means the limit did not bite. */
	| 'signed'
	/** The policy sent it to the owner for approval — the ask this probe is looking for. */
	| 'policy_ask'
	/** The policy said no outright. */
	| 'policy_reject'
	/** It never reached the policy: the account cannot afford it. */
	| 'insufficient_funds'
	/** No session, so nothing was evaluated. */
	| 'no_session'
	/** Nothing matched. Read `response`. */
	| 'unknown'

export interface ProbeClassification {
	outcome: ProbeOutcome
	/** The substring that decided it, so a grader can check the call. */
	matched: string | null
	/** True when this outcome is evidence for the policy probe. */
	isPolicyEvidence: boolean
}

const PATTERNS: Array<{ outcome: ProbeOutcome; needles: string[] }> = [
	{
		outcome: 'insufficient_funds',
		needles: [
			// Sui's own execution error, verbatim and lowercased — the 999 SUI probe's most
			// likely non-policy outcome, measured against this wallet by RPC dry run.
			'insufficientcoinbalance',
			'insufficient balance',
			'insufficient funds',
			'insufficient gas',
			'insufficient address balance',
			'not enough sui',
			'no coins of type',
		],
	},
	{ outcome: 'no_session', needles: ['no_session', 'no session', 'not logged in', 'run `waap-cli signup`', 'unauthorized'] },
	{
		outcome: 'policy_ask',
		needles: [
			'approval required',
			'approval_required',
			'requires approval',
			'awaiting approval',
			'pending approval',
			'owner approval',
			'approval request',
			'confirm on telegram',
			'2fa',
			'two-factor',
		],
	},
	{
		outcome: 'policy_reject',
		needles: [
			'policy denied',
			'policy_denied',
			'denied by policy',
			'rejected by policy',
			'policy rejected',
			'policy violation',
			'spend limit',
			'daily limit',
			'daily-spend-limit',
			'limit exceeded',
			'exceeds limit',
			'declined',
		],
	},
	{ outcome: 'signed', needles: ['"txhash"', '"digest"', 'transaction submitted'] },
]

export function classifyProbeResponse(raw: string | null | undefined): ProbeClassification {
	if (!raw || !raw.trim()) return { outcome: 'unknown', matched: null, isPolicyEvidence: false }
	const hay = raw.toLowerCase()
	for (const { outcome, needles } of PATTERNS) {
		for (const needle of needles) {
			if (hay.includes(needle)) {
				return { outcome, matched: needle, isPolicyEvidence: outcome === 'policy_ask' || outcome === 'policy_reject' }
			}
		}
	}
	return { outcome: 'unknown', matched: null, isPolicyEvidence: false }
}
