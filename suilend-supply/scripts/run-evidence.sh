#!/bin/sh
# Regenerates raw evidence. Offline: tests and the contract check run under a network trap.
# Repair round 01: writes to $EVIDENCE_DIR (default evidence/repair-01/latest) so the
# first attempt's evidence/ files are never overwritten.
set -u
cd "$(dirname "$0")/.."
E="${EVIDENCE_DIR:-evidence/repair-01/latest}"
mkdir -p "$E" .test-tmp
rm -f .test-tmp/net-trap.log
{
  echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "node: $(node --version)  npm: $(npm --version)  os: $(uname -srm)"
  echo "--- installed versions (npm ls --depth=0)"
  npm ls --depth=0 2>&1
  echo "--- package-lock.json sha256"
  shasum -a 256 package-lock.json
  echo "--- source sha256"
  shasum -a 256 src/*.ts test/*.ts test/fixtures/* scripts/* bin/* docs/*.md package.json
} > "$E/environment.txt" 2>&1

npx tsc --noEmit > "$E/typecheck.txt" 2>&1; echo "tsc exit: $?" >> "$E/typecheck.txt"
npx vitest run --reporter=verbose > "$E/test-run.txt" 2>&1; echo "vitest exit: $?" >> "$E/test-run.txt"
node scripts/classifier-selftest.mjs > "$E/classifier-selftest.txt" 2>&1; echo "exit: $?" >> "$E/classifier-selftest.txt"
node scripts/check-waap-cli-contract.mjs > "$E/waap-cli-contract-check.txt" 2>&1; echo "exit: $?" >> "$E/waap-cli-contract-check.txt"
{
  echo "network attempts trapped during the test run (expected: only the deliberate live-adapter test, cli.test.ts):"
  if [ -f .test-tmp/net-trap.log ]; then cat .test-tmp/net-trap.log; else echo "(none)"; fi
} > "$E/net-trap-during-tests.txt"
./bin/suilend-waap.mjs --help > "$E/cli-help.txt" 2>&1; echo "exit: $?" >> "$E/cli-help.txt"
echo "evidence written to $E/"
