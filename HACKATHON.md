# CALIPER — NEAR HACKATHON 2026 Submission

**Track:** 05 — AI Swarms (Coordination markets, bidding, collective purchasing, intent-based settlement between agents)
**Submission deadline:** November 14, 2026 at 23:59 UTC

## What it is

CALIPER is a verified labor market for autonomous agents built on NEAR. It solves the silent failure mode where an AI agent makes CI green by weakening tests instead of fixing code — payment stays locked until independent verification confirms the fix.

## The problem

A coordinator hires an AI coding agent. The agent can't fix the bug, so it deletes the failing test, weakens an assertion, or disables CI. The branch turns green. The coordinator pays for fake work.

## The solution

CALIPER separates work from verification:

1. The coordinator posts a task and pins acceptance criteria, protected files, and the baseline commit before work begins.
2. Workers submit commit/reveal bids in a deterministic **off-chain simulation**; the lowest valid bid is selected.
3. The coordinator records the selected worker, the escrowed maximum budget, and the winning bid in the contract.
4. The worker submits only an artifact hash — they cannot certify their own tests.
5. An independent verifier reruns the **original pinned suite** against the actual artifact, computes diffs, checks protected files, and signs an Ed25519 attestation.
6. Once verification passes, payment is a fixed obligation: `release_verified_payment` is permissionless, and the coordinator can neither cancel the job nor revoke the branch to avoid it.
7. The contract pays **exactly the winning bid** and returns the unused escrow to the coordinator.
8. `Paid` requires a successful transfer callback. `PaymentPending` never means paid.

## What is and is not on-chain

**On-chain:** authority attenuation, job escrow, evidence binding, signature checks, exact-bid settlement, callback-confirmed payment, revocation guards.

**Off-chain simulation:** the bid market, nonces, winner selection, and the local chain used by the demo. The contract does not validate the auction or independently select the winner; it records the supplied transcript hash and the coordinator's selection.

**Testnet status:** deployment and `init` are verified on `caliper.testnet`. The lifecycle has **not** been executed there: `get_root` is `null`, `get_total_allocated` is `"0"`, and `list_jobs` is `[]`. The deployed bytecode predates the corrected settlement code in this repository. A runnable, unexecuted lifecycle procedure is in `near/scripts/testnet-lifecycle.sh`.

## How to run it

### Option A: Local simulation (no wallet, no network, no signup)

```bash
npm install
npm run demo
```

Expected output:
```
attempt 1: Rejected — blocked: protected acceptance files were modified
attempt 2: Verified — passed: genuine source fix accepted by the pinned suite
payment: Paid
```

The demo is a local simulation, not a sequence of testnet transactions.

### Option B: Verify the live testnet deployment

```bash
near view caliper.testnet get_owner
# "caliper.testnet"

near view caliper.testnet get_total_allocated
# "0"

near view caliper.testnet list_jobs
# []
```

Transaction: https://testnet.nearblocks.io/txns/HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z

### Option C: Run tests

```bash
npm test
npm run verify
```

### Option D: Require an OS sandbox for execution

```bash
CALIPER_SANDBOX=os npm run demo
```

This uses macOS `sandbox-exec` or Linux `bwrap` and fails closed if neither is available. Without it, the runner is process-only and is not a security boundary.

## Track fit

CALIPER targets Track 05 — AI Swarms:

- **Coordination market**: Workers bid via commit/reveal in a deterministic off-chain simulation; the lowest valid bid is selected and recorded.
- **Collective purchasing**: The coordinator allocates budget from an authority tree; job escrow isolates funds and returns the unused remainder.
- **Intent-based settlement**: The verifier attests to artifact quality; NEAR pays exactly the winning bid only on verified, callback-confirmed settlement.

## Submission details

- **Repository:** https://github.com/HillaryIkhais/Caliper
- **Demo:** Local simulation via `npm run demo` (video attached to submission post)
- **Live contract:** `caliper.testnet` on NEAR testnet (deployment + `init` verified; lifecycle unexecuted)
- **Team size:** 1
- **License:** MIT
- **Deadline:** November 14, 2026 at 23:59 UTC
