#!/usr/bin/env bash
# stop-check — prove the documented launch and stop path, with nothing able to sign.
#
#   ./stop-check.sh
#
# ## What it checks
#
# The supported path for a long run is:
#
#   1. launch   ./node_modules/.bin/tsx agent.ts          (directly: npm does not forward
#                                                          SIGTERM to the agent on Linux)
#   2. a second loop on the same account and pool is refused (the lock)
#   3. stop     ./node_modules/.bin/tsx stop.ts           (hands off to the live loop: SIGTERM,
#                                                          the loop stops quoting, runs its own
#                                                          cancel → settle → withdraw, exits;
#                                                          stop then verifies)
#   4. confirm  no agent process survives and the lock is gone
#
# This script runs exactly that sequence as a dry run and grades each step.
#
# ## Why it cannot send anything
#
# - `AGENT_DRY_RUN=1` is set explicitly. The guard in lib/waap.ts refuses to invoke
#   waap-cli unless the value is exactly `0`.
# - The environment is replaced (`env -i`): no inherited AGENT_DRY_RUN, session, RPC or
#   manager setting reaches the agent.
# - `DOTENV_CONFIG_PATH` points at an empty file, so a local `.env` is never read.
# - `HOME` is a fresh temp directory, so no waap-cli session is visible.
# - A fake `waap-cli` sits first on PATH. It records every invocation and rejects every
#   one. The check passes only if it recorded zero `send-tx` calls.
# - State, lock and log paths are all inside the temp directory; the recipe's own
#   `state.json`, lock directory and `logs/` are untouched.
#
# It reads mainnet (the book and the manager object) and writes nothing to chain.
set -u
cd "$(dirname "$0")"
RECIPE_DIR=$(pwd)

TMP=$(mktemp -d "${TMPDIR:-/tmp}/deepbook-stopcheck.XXXXXX")
mkdir -p "$TMP/bin" "$TMP/home"
: > "$TMP/empty.env"
LOG="$TMP/run.jsonl"
STATE="$TMP/state.json"
LOCKS="$TMP/locks"
CALLS="$TMP/waap-cli-calls.log"
: > "$CALLS"
# Any existing BalanceManager works for a dry build; the default is the one the recipe's
# mainnet run used. Nothing is sent to it.
MANAGER=${STOP_CHECK_MANAGER_ID:-0xdceb4ba0957e681550518f87b62c12a5bed5d420f1cfadf156cb08be9f2dd2b5}
fail=0

note() { printf '%s\n' "$1"; }
check() { if eval "$2"; then note "PASS  $1"; else note "FAIL  $1"; fail=1; fi; }

# The fake CLI: records its arguments, answers with an error event, exits 1.
cat > "$TMP/bin/waap-cli" <<EOF
#!/bin/sh
echo "\$*" >> "$CALLS"
echo '{"event":"error","code":"STOP_CHECK_FAKE","message":"stop-check fake waap-cli: nothing is signed here"}'
exit 1
EOF
chmod 755 "$TMP/bin/waap-cli"

NODE_DIR=$(dirname "$(command -v node)")
run_isolated() {
	env -i \
		PATH="$TMP/bin:$NODE_DIR:/usr/bin:/bin" \
		HOME="$TMP/home" \
		TMPDIR="$TMP" \
		DOTENV_CONFIG_PATH="$TMP/empty.env" \
		AGENT_DRY_RUN=1 \
		NETWORK=mainnet \
		STATE_FILE="$STATE" \
		LOCK_DIR="$LOCKS" \
		AGENT_LOG_FILE="$LOG" \
		DEEPBOOK_BALANCE_MANAGER_ID="$MANAGER" \
		POLL_MS=2000 \
		FILL_SCAN=0 \
		"$@"
}

note "isolated dir: $TMP"
note ""

# --- 1. launch, directly -------------------------------------------------------
run_isolated "$RECIPE_DIR/node_modules/.bin/tsx" agent.ts > "$TMP/agent.stdout" 2>&1 &
LAUNCH_PID=$!
for _ in $(seq 1 90); do
	grep -qE '"message":"(quote_plan|quote_paused|tick_no_submit|inventory_limited)"' "$LOG" 2>/dev/null && break
	sleep 1
done
LOCKFILE=$(ls "$LOCKS"/*.lock 2>/dev/null | head -1)
AGENT_PID=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$LOCKFILE" 2>/dev/null)
note "launched pid: $LAUNCH_PID · agent pid (from its lock): ${AGENT_PID:-<none>}"
check "the agent holds the account/pool lock" '[ -n "$AGENT_PID" ]'
if [ -z "$AGENT_PID" ]; then
	note "no lock; output follows:"; tail -5 "$TMP/agent.stdout"; kill "$LAUNCH_PID" 2>/dev/null; exit 1
fi
check "agent_start logged with dryRun true" 'grep "\"message\":\"agent_start\"" "$LOG" | grep -q "\"dryRun\":true"'
check "at least one tick planned" 'grep -qE "\"message\":\"(quote_plan|quote_paused|tick_no_submit)\"" "$LOG"'

# --- 2. a duplicate loop is refused ----------------------------------------------
run_isolated "$RECIPE_DIR/node_modules/.bin/tsx" agent.ts > "$TMP/dup.stdout" 2>&1
DUP_EXIT=$?
check "a second loop on the same account and pool exits non-zero" '[ "$DUP_EXIT" -ne 0 ]'
check "and says the lock is held by a live process" 'grep -q "holder is live" "$TMP/dup.stdout"'

# --- 3. stop hands off to the live loop ----------------------------------------------
[ "$AGENT_PID" = "$$" ] && { note "refusing to signal this shell"; exit 1; }
run_isolated "$RECIPE_DIR/node_modules/.bin/tsx" stop.ts > "$TMP/stop.stdout" 2>&1
STOP_EXIT=$?
check "stop.ts handed off to the loop (SIGTERM) instead of withdrawing under it" 'grep -q "\"message\":\"stop_handoff\"" "$LOG"'
check "the loop logged quotes_stopped before any cleanup" 'awk "/\"quotes_stopped\"/{q=NR} /\"cleanup_(dry_run|started|not_needed)\"/{if(!c)c=NR} END{exit !(q && c && q<c)}" "$LOG"'
check "the loop built its own cancel → settle → withdraw" 'grep "\"message\":\"tx_built\"" "$LOG" | grep -q "\"kind\":\"cleanup\""'
check "the loop exited through process_exit with sendTxCalls 0" 'grep "\"message\":\"process_exit\"" "$LOG" | grep "\"proc\":\"loop\"" | grep -q "\"sendTxCalls\":0"'
check "stop.ts finished (exit 0) after the handoff" '[ "$STOP_EXIT" -eq 0 ] && grep -q "\"message\":\"stop_done\"" "$LOG"'

# --- 4. no survivor, no lock ---------------------------------------------------------
for _ in $(seq 1 20); do
	kill -0 "$AGENT_PID" 2>/dev/null || break
	sleep 1
done
check "no agent process survives" '! kill -0 "$AGENT_PID" 2>/dev/null'
check "the launched process exited too" '! kill -0 "$LAUNCH_PID" 2>/dev/null'
check "the lock was released" '[ -z "$(ls "$LOCKS"/*.lock 2>/dev/null)" ]'

# --- the boundary: nothing reached a signer ---------------------------------------------
check "the fake waap-cli recorded zero send-tx calls" '! grep -q "send-tx" "$CALLS"'
note "fake waap-cli invocations (any command): $(wc -l < "$CALLS" | tr -d ' ')"

# --- leave nothing behind ------------------------------------------------------------------
for p in "$AGENT_PID" "$LAUNCH_PID"; do
	if kill -0 "$p" 2>/dev/null; then
		note "SURVIVOR: pid $p still running; killing it"
		kill -TERM "$p" 2>/dev/null; sleep 2; kill -9 "$p" 2>/dev/null
	fi
done

note ""
note "log: $LOG"
if [ $fail -eq 0 ]; then note "RESULT: launch and stop path is sound"; else note "RESULT: launch and stop path is NOT sound"; fi
exit $fail
