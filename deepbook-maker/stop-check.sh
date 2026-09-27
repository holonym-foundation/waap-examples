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
#   2. stop     SIGTERM to the agent's pid                (the handler writes `shutdown`)
#   3. confirm  no agent process survives
#   4. clean up ./node_modules/.bin/tsx stop.ts           (cancel every order, withdraw both coins)
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
# - State, pid and log paths are all inside the temp directory; the recipe's own
#   `state.json`, `agent.pid` and `logs/` are untouched.
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
PIDFILE="$TMP/agent.pid"
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
		PID_FILE="$PIDFILE" \
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

for _ in $(seq 1 60); do
	[ -s "$PIDFILE" ] && grep -q '"message":"tick_done"' "$LOG" 2>/dev/null && break
	sleep 1
done
AGENT_PID=$(cat "$PIDFILE" 2>/dev/null || echo "")
note "launched pid: $LAUNCH_PID · agent pid (from PID_FILE): ${AGENT_PID:-<none>}"

check "the agent wrote a pid file" '[ -n "$AGENT_PID" ]'
if [ -z "$AGENT_PID" ]; then
	note "no pid file; output follows:"; tail -5 "$TMP/agent.stdout"; kill "$LAUNCH_PID" 2>/dev/null; exit 1
fi
check "agent_start logged with dryRun true" 'grep "\"message\":\"agent_start\"" "$LOG" | grep -q "\"dryRun\":true"'
check "at least one tick completed" 'grep -q "\"message\":\"tick_done\"" "$LOG"'

# --- 2. SIGTERM to the agent -----------------------------------------------------
[ "$AGENT_PID" = "$$" ] && { note "refusing to signal this shell"; exit 1; }
note "sending SIGTERM to the agent, pid $AGENT_PID"
kill -TERM "$AGENT_PID" 2>/dev/null
for _ in $(seq 1 20); do
	grep -q '"message":"shutdown"' "$LOG" && break
	sleep 1
done
check "a shutdown line was written" 'grep -q "\"message\":\"shutdown\"" "$LOG"'
check "the shutdown reports sendTxCalls 0" 'grep "\"message\":\"shutdown\"" "$LOG" | grep -q "\"sendTxCalls\":0"'

# --- 3. no survivor ----------------------------------------------------------------
for _ in $(seq 1 20); do
	kill -0 "$AGENT_PID" 2>/dev/null || break
	sleep 1
done
check "no agent process survives" '! kill -0 "$AGENT_PID" 2>/dev/null'
check "the launched process exited too" '! kill -0 "$LAUNCH_PID" 2>/dev/null'
check "the pid file was removed" '[ ! -e "$PIDFILE" ]'

# --- 4. cleanup transaction, dry --------------------------------------------------------
run_isolated "$RECIPE_DIR/node_modules/.bin/tsx" stop.ts > "$TMP/stop.stdout" 2>&1
check "stop.ts built the cancel-and-withdraw transaction" 'grep "\"message\":\"tx_built\"" "$LOG" | grep -q "\"kind\":\"stop\""'
check "stop.ts finished dry, with no digest" 'grep "\"message\":\"stop_done\"" "$LOG" | grep -q "\"dryRun\":true"'

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
