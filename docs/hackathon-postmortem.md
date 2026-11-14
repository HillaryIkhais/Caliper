# Hackathon Postmortem — Applied to CALIPER

## 1. Event / track / result

- **Event:** NEAR HACKATHON 2026
- **Track:** 05 — AI Swarms
- **Submission status:** Committed and pushed to `origin/main` (commit `79857d8`)
- **Result:** Pending (submission not yet judged)

## 2. Primary failure category

**Proof.** The original submission overclaimed on-chain lifecycle behavior (deployment ≠ lifecycle executed) and implied OS-level runner isolation by default. Both were corrected with honest documentation, but the proof gap (testnet lifecycle not executed, deployed bytecode predates fixes) remains the weakest dimension.

## 3. Score delta

| Dimension | Before | After | Why |
|---|---|---|---|
| Silent failure | 2 | 2 | Already sharp |
| Insight | 2 | 2 | Non-obvious second-order failure |
| Invariant | 2 | 2 | One sentence, testable |
| Architecture | 1 | 2 | Revocation guards + permissionless release added |
| Completeness | 2 | 2 | Full loop incl. failure + recovery |
| Verification | 2 | 2 | Independent oracle + callback confirmation |
| Evidence | 0 | 1 | Testnet lifecycle unexecuted; deployed bytecode predates fixes (honestly documented) |
| Sponsor fit | 2 | 2 | Load-bearing NEAR integration |
| Narrative | 1 | 2 | Overclaims removed; honest limitations |
| Honesty | 0 | 2 | All false claims corrected; specific limitations stated |
| **Total** | **14/20** | **19/20** | **+5 points** |

**Weakest dimension:** Evidence (1/2) — the deployed bytecode predates fixes and the testnet lifecycle has not been executed.

## 4. What the winner proved that we did not

A winning submission would have:
- Executed the full testnet lifecycle (create root, delegate, create job, submit, verify, settle) and recorded transaction hashes.
- Deployed the fixed contract to testnet so deployed bytecode matches the working tree.
- Demonstrated the OS sandbox path in the demo video.

We were honest about these gaps rather than hiding them — which is a competitive advantage in itself, but costs points on the Evidence dimension.

## 5. What broke / what was unverifiable

| Item | Status | Reason |
|---|---|---|
| `cargo test` | Fixed | One test (`revoked_verifier_cannot_attest`) needed rewrite for new revocation guard |
| `npm test` | Pass | 21/21 off-chain tests pass |
| `npm run verify` | Pass | Both fixtures verify |
| Wasm release build | Pass | `cargo build --release --target wasm32-unknown-unknown` succeeds |
| Testnet lifecycle | Unverified | No funded testnet accounts, no wallet keys, no `near` CLI in original environment |
| Deployed bytecode match | Unverified | Deployed code hash predates fixes; redeploy required |

## 6. Time audit

| Phase | Hours | Notes |
|---|---|---|
| Economic/security fixes (contract) | ~4 | winning_bid, permissionless release, cancellation guard, revocation guard |
| Local chain mirror fixes | ~2 | Same semantics as contract |
| Runner isolation | ~3 | CALIPER_SANDBOX=os, fail-closed, isolation metadata |
| Market canonical bid | ~1 | winner_bid exposed, off-chain labeling |
| Test verification | ~2 | Ran all test suites, fixed one test |
| Documentation rewrite | ~4 | 5 docs rewritten to remove overclaims |
| Skill application | ~3 | This document |

## 7. One process change

**Never claim deployment ≠ lifecycle.** A deployed contract with `get_root=null` and `list_jobs=[]` proves init only. Every future submission must separate "deployed" from "executed" in the README above the fold, and must execute the lifecycle before claiming on-chain behavior.

## 8. One reusable asset

The **honesty framework** — specific limitations, deployment-vs-lifecycle distinction, off-chain labeling, claim discipline (E/D/M/F). This is portable to any future blockchain submission.

## 9. Track ledger entry

| Event | Track | Failure type | Score /20 | Result | Lesson |
|---|---|---|---|---|---|
| NEAR Hackathon 2026 | 05 AI Swarms | Verified labor market + escrow | 19/20 | Submitted | Deployment ≠ lifecycle; honest limitations win trust |

## 10. Next event hypothesis

If we redeploy the fixed contract and execute the testnet lifecycle before the next event, the Evidence dimension moves from 1 to 2, yielding 20/20 — competitive to win.
