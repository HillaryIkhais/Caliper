#!/usr/bin/env bash
#
# CALIPER testnet lifecycle procedure.
#
# STATUS: NOT EXECUTED. Do not cite this script as evidence until it has been run
# against a freshly deployed contract and the resulting transaction hashes are
# recorded in near/evidence/testnet-lifecycle.md.
#
# This script performs the full lifecycle:
#   deploy/init (optional) -> create root -> delegate roles -> create job
#   -> submit deliverable -> record signed attestation -> permissionless release
#   -> view final state.
#
# Requirements:
#   - NEAR CLI (`near`) authenticated for the owner and role accounts
#   - Funded testnet accounts for owner, coordinator, worker, and verifier
#   - A verifier key pair whose public key is CALIPER_VERIFIER_PUBKEY
#   - A signed attestation JSON produced by demo/runner.ts for this job/attempt
#
# Required environment:
#   CALIPER_OWNER              owner account (calls create_root)
#   CALIPER_COORDINATOR        coordinator account (holds root)
#   CALIPER_WORKER             worker account
#   CALIPER_VERIFIER           verifier account
#   CALIPER_VERIFIER_PUBKEY    32-byte hex Ed25519 public key
#   CALIPER_CRITERIA_HASH      pinned acceptance-criteria hash
#   CALIPER_SUITE_HASH         pinned acceptance-policy hash
#   CALIPER_BASELINE           pinned baseline commit
#   CALIPER_TRANSCRIPT         off-chain market transcript hash
#   CALIPER_DELIVERABLE        worker's artifact hash
#   CALIPER_ATTESTATION_FILE   signed attestation JSON (job_id 0, attempt 1)
#
# Optional environment:
#   CALIPER_CONTRACT           default: caliper.testnet
#   CALIPER_WASM               if set, deploy + init before the lifecycle
#   CALIPER_ROOT_ALLOCATION    yoctoNEAR, default 40 NEAR
#   CALIPER_CHILD_ALLOCATION   yoctoNEAR, default 10 NEAR per role
#   CALIPER_JOB_BUDGET         yoctoNEAR, default 20 NEAR (escrowed maximum)
#   CALIPER_WINNING_BID        yoctoNEAR, default 12 NEAR (exact payment)

set -euo pipefail

CONTRACT="${CALIPER_CONTRACT:-caliper.testnet}"
ROOT_ALLOCATION="${CALIPER_ROOT_ALLOCATION:-40000000000000000000000000}"
CHILD_ALLOCATION="${CALIPER_CHILD_ALLOCATION:-10000000000000000000000000}"
JOB_BUDGET="${CALIPER_JOB_BUDGET:-20000000000000000000000000}"
WINNING_BID="${CALIPER_WINNING_BID:-12000000000000000000000000}"
GAS=100000000000000

require() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "missing required environment variable: $name" >&2
    exit 2
  fi
}

for name in CALIPER_OWNER CALIPER_COORDINATOR CALIPER_WORKER CALIPER_VERIFIER \
  CALIPER_VERIFIER_PUBKEY CALIPER_CRITERIA_HASH CALIPER_SUITE_HASH \
  CALIPER_BASELINE CALIPER_TRANSCRIPT CALIPER_DELIVERABLE \
  CALIPER_ATTESTATION_FILE; do
  require "$name"
done

command -v near >/dev/null 2>&1 || { echo "near CLI not found" >&2; exit 2; }
[ -f "$CALIPER_ATTESTATION_FILE" ] || { echo "attestation file not found: $CALIPER_ATTESTATION_FILE" >&2; exit 2; }

echo "CALIPER lifecycle on $CONTRACT"
echo "  owner:       $CALIPER_OWNER"
echo "  coordinator: $CALIPER_COORDINATOR"
echo "  worker:      $CALIPER_WORKER"
echo "  verifier:    $CALIPER_VERIFIER"
echo "  budget:      $JOB_BUDGET yoctoNEAR"
echo "  winning bid: $WINNING_BID yoctoNEAR"

if [ -n "${CALIPER_WASM:-}" ]; then
  echo "== 0. deploy + init =="
  near deploy "$CONTRACT" "$CALIPER_WASM" \
    --initFunction init \
    --initArgs "{\"owner\":\"$CALIPER_OWNER\"}"
fi

echo "== 1. create root (holder = coordinator) =="
near call "$CONTRACT" create_root "{
  \"holder\": \"$CALIPER_COORDINATOR\",
  \"allocation\": \"$ROOT_ALLOCATION\",
  \"permissions\": {
    \"recipients\": [],
    \"assets\": [],
    \"max_per_tx\": \"$ROOT_ALLOCATION\",
    \"may_delegate\": true
  }
}" --accountId "$CALIPER_OWNER" --depositYocto "$ROOT_ALLOCATION" --gas "$GAS"

echo "== 2. delegate worker (root id 0) =="
near call "$CONTRACT" delegate "{
  \"parent_id\": 0,
  \"holder\": \"$CALIPER_WORKER\",
  \"permissions\": {
    \"recipients\": [],
    \"assets\": [],
    \"max_per_tx\": \"$CHILD_ALLOCATION\",
    \"may_delegate\": false
  },
  \"allocation\": \"$CHILD_ALLOCATION\",
  \"expiry\": null
}" --accountId "$CALIPER_COORDINATOR" --gas "$GAS"

echo "== 3. delegate verifier (root id 0) =="
near call "$CONTRACT" delegate "{
  \"parent_id\": 0,
  \"holder\": \"$CALIPER_VERIFIER\",
  \"permissions\": {
    \"recipients\": [],
    \"assets\": [],
    \"max_per_tx\": \"$CHILD_ALLOCATION\",
    \"may_delegate\": false
  },
  \"allocation\": \"$CHILD_ALLOCATION\",
  \"expiry\": null
}" --accountId "$CALIPER_COORDINATOR" --gas "$GAS"

echo "== 4. create job (job id 0) =="
near call "$CONTRACT" create_job "{
  \"coordinator_node\": 0,
  \"worker_node\": 1,
  \"verifier_node\": 2,
  \"verifier_public_key\": \"$CALIPER_VERIFIER_PUBKEY\",
  \"budget\": \"$JOB_BUDGET\",
  \"winning_bid\": \"$WINNING_BID\",
  \"acceptance_criteria_hash\": \"$CALIPER_CRITERIA_HASH\",
  \"acceptance_suite_hash\": \"$CALIPER_SUITE_HASH\",
  \"baseline_commit\": \"$CALIPER_BASELINE\",
  \"market_transcript_hash\": \"$CALIPER_TRANSCRIPT\",
  \"protected_files\": [\"tests/**\", \"ci/**\"]
}" --accountId "$CALIPER_COORDINATOR" --gas "$GAS"

echo "== 5. submit deliverable (attempt 1) =="
near call "$CONTRACT" submit_deliverable "{
  \"job_id\": 0,
  \"deliverable_hash\": \"$CALIPER_DELIVERABLE\"
}" --accountId "$CALIPER_WORKER" --gas "$GAS"

echo "== 6. record independent verification =="
ATTESTATION="$(cat "$CALIPER_ATTESTATION_FILE")"
near call "$CONTRACT" record_independent_verification "{
  \"job_id\": 0,
  \"attestation\": $ATTESTATION
}" --accountId "$CALIPER_VERIFIER" --gas "$GAS"

echo "== 7. permissionless release (worker releases its own payment) =="
near call "$CONTRACT" release_verified_payment '{"job_id": 0}' \
  --accountId "$CALIPER_WORKER" --gas "$GAS"

echo "== 8. final views =="
near view "$CONTRACT" get_root
near view "$CONTRACT" get_total_allocated
near view "$CONTRACT" get_node '{"id": 0}'
near view "$CONTRACT" get_job '{"id": 0}'
near view "$CONTRACT" list_jobs

echo "Lifecycle complete. Record the transaction hashes in near/evidence/testnet-lifecycle.md."
