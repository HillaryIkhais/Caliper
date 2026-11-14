# CALIPER — NEAR HACKATHON 2026 Submission

**Track:** 05 — AI Swarms (Coordination markets, bidding, collective purchasing, intent-based settlement between agents)
**Submission deadline:** November 14, 2026 at 23:59 UTC

## What it is

CALIPER is a verified labor market for autonomous agents built on NEAR. It solves the silent failure mode where an AI agent makes CI green by weakening tests instead of fixing code — payment stays locked until independent verification confirms the fix.

## The problem

A coordinator hires an AI coding agent. The agent can't fix the bug, so it deletes the failing test, weakens an assertion, or disables CI. The branch turns green. The coordinator pays for fake work.

## The solution

CALIPER separates work from verification:

1. Coordinator posts a task and pins acceptance criteria + protected files + baseline commit before work begins.
2. Workers submit commit/reveal bids; lowest valid bid wins (deterministic selection).
3. Worker submits only an artifact hash — they cannot certify their own tests.
4. An independent verifier reruns the **original pinned suite** against the actual artifact, computes diffs, checks protected files, and signs an Ed25519 attestation.
5. Coordinator approves only if verification passed.
6. NEAR releases payment only after the transfer callback confirms success.

## How to run it

### Option A: Local simulation (no wallet, no network, no signup)

```bash
# 1. Install dependencies
npm install

# 2. Run the complete adversarial demonstration
npm run demo
```

Expected output:
```
attempt 1: Rejected — blocked: protected acceptance files were modified
attempt 2: Verified — passed: genuine source fix accepted by the pinned suite
payment: Paid
```

### Option B: Verify live testnet contract

The contract is deployed on NEAR testnet at `caliper.testnet`:

```bash
near view caliper.testnet get_total_allocated
```

Transaction: https://testnet.nearblocks.io/txns/HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z

### Option C: Run tests

```bash
npm test          # 39 contract tests + 20 off-chain tests
npm run verify    # exported-state fixtures
```

## Track fit

CALIPER directly targets Track 05 — AI Swarms:
- **Coordination market**: Workers bid via commit/reveal; contract selects lowest valid bid.
- **Collective purchasing**: Coordinator allocates budget from an authority tree; job commitment isolates funds.
- **Intent-based settlement**: Verifier attests to artifact quality; NEAR pays only on verified settlement.

## Submission details

- **Repository:** https://github.com/HillaryIkhais/Caliper
- **Demo:** Local simulation via `npm run demo` (video attached to submission post)
- **Live contract:** `caliper.testnet` on NEAR testnet
- **Team size:** 1
- **License:** MIT
- **Deadline:** November 14, 2026 at 23:59 UTC
