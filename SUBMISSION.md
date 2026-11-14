# CALIPER NEAR Hackathon Submission

## Deployment status (verified)

**Contract:** `caliper.testnet`
**Network:** NEAR Testnet
**Transaction:** `HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z`
**Status:** `FINAL`
**Actions:** `DeployContract` + `FunctionCall` (`init`)
**Signer / receiver:** `caliper.testnet` / `caliper.testnet`
**Explorer:** https://testnet.nearblocks.io/txns/HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z
**Deployed code hash:** `Hst7gb5bXE4DoY99CgbrG2McRGBm41LkUKodpF7Fc2Bh`
**Balance:** 9,997.3034170156228 NEAR

Verified view results:

| View | Result |
|------|--------|
| `get_owner` | `"caliper.testnet"` |
| `get_root` | `null` |
| `get_total_allocated` | `"0"` |
| `list_jobs` | `[]` |

### What this proves

- The `caliper.testnet` account exists.
- Bytecode is deployed and `init` executed.
- The deployment transaction is final.

### What this does not prove

- No root authority, delegation, job, verification, or payment has run on testnet.
- The deployed bytecode predates the corrected settlement code in this repository. It does **not** implement the exact-bid payment, permissionless release, cancellation guard, or revocation guard described below.
- A redeploy is required before any on-chain lifecycle claim. `near/scripts/testnet-lifecycle.sh` is provided but has **not** been run.

## What was delivered

### 1. Corrected economic and security model

- Coordinator escrows its maximum budget; worker is paid exactly the winning bid.
- Unused escrow returns to the coordinator's available allocation.
- `Verified` jobs cannot be cancelled.
- `release_verified_payment` is permissionless after verification, so the coordinator cannot withhold payment.
- Settlement revalidates only the coordinator's authority; worker or verifier revocation does not extinguish the payment right.
- Revocation is blocked for a branch with an outstanding verified payment or a job awaiting verification.
- `Submitted` jobs are cancellable only after `VERIFICATION_TIMEOUT_BLOCKS = 1_000`, preventing indefinite escrow lock without allowing prompt cancellation.
- `winning_bid` is validated at job creation: positive and no greater than the escrowed budget.

### 2. Off-chain market, honestly labeled

- `demo/market.ts` exposes a canonical `winner_bid` used by both selection and settlement.
- The market is a deterministic commit/reveal simulation. Selection happens off-chain.
- The contract records the transcript hash, selected worker, escrowed budget, and winning bid. It does not validate the auction or select the winner.

### 3. Runner isolation, honestly bounded

- Default execution is process-only: scrubbed environment, fixed cwd, 15-second timeout.
- The report records `isolation.requested`, `isolation.enforced`, `isolation.filesystem`, and `isolation.network`.
- `CALIPER_SANDBOX=os` selects macOS `sandbox-exec` or Linux `bwrap`, confines writes to the job workspace and scratch directory, denies network access, and fails closed if no supported sandbox is available.

### 4. Tests and fixtures

- Contract tests updated for `winning_bid`, exact settlement, permissionless release, non-cancellable `Verified` jobs, and revocation guards.
- Off-chain tests updated for the canonical winning bid and permissionless settlement.
- `contract/verify/verify.ts` adds the `winning_bid <= budget` invariant and validates the new job field.
- `contract/verify/sample-valid-job.json` updated to a paid job whose spent amount equals the winning bid.

### 5. Documentation

- `README.md` — corrected claims and status.
- `JUDGES.md` — judge checklist with the deployment/lifecycle distinction.
- `HACKATHON.md` — Track 05 submission framing.
- `near/evidence/testnet-lifecycle.md` — evidence boundary and reproduction steps.
- `near/scripts/testnet-lifecycle.sh` — runnable, unexecuted lifecycle procedure.

## Test status

The Rust and TypeScript changes in this submission were prepared in an environment without `node`, `npm`, `cargo`, or `near`. **The test suites were not executed here.** Run them before treating the code as validated:

```bash
cd contract && cargo test
npm run test:node
npm run verify
```

cd contract && cargo build --release --target wasm32-unknown-unknown

## Judge evaluation path

1. **Verify deployment:** open the Explorer link and confirm `FINAL`.
2. **Verify initialization:** `near view caliper.testnet get_owner` → `"caliper.testnet"`.
3. **Confirm lifecycle is unexecuted:** `near view caliper.testnet list_jobs` → `[]`.
4. **Run the demo:** `npm run demo` — adversarial workflow completes in the local simulation.
5. **Run the tests:** `cargo test`, `npm run test:node`, `npm run verify`.
6. **Review evidence:** `near/evidence/testnet-lifecycle.md`.

## LOCAL SIMULATION vs NEAR TESTNET

Every identity, report, and receipt in the demo is labeled **LOCAL SIMULATION**. It mirrors the contract's intended state machine but is not a chain of testnet transactions.

The testnet deployment currently proves tooling and initialization only. It does not show a job lifecycle, and its bytecode predates the fixes in this working tree.
