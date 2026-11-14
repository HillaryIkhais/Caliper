# CALIPER NEAR Hackathon Submission

## Deployment Status ✅

**Contract:** `caliper.testnet`  
**Network:** NEAR Testnet  
**Transaction:** `HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z`  
**Explorer:** https://testnet.nearblocks.io/txns/HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z  
**WASM SHA-256:** `fac3d3d2c2a4ca206085b96e6ddb9223a4bb8b4d8882ef19cd5dba717593c0a8`

## What Was Delivered

### 1. Deployed Contract
- ✅ Live on NEAR testnet at `caliper.testnet`
- ✅ 9.997 NEAR balance remaining
- ✅ Verified WASM hash matches local build

### 2. Tests Pass
- ✅ 39 contract tests pass
- ✅ 20 TypeScript tests pass
- ✅ `npm test` succeeds

### 3. Local Demo
- ✅ `npm run demo` - Complete adversarial workflow
- ✅ Shows tampering detection, rejection, correction, settlement
- ✅ Clearly labeled as LOCAL SIMULATION

### 4. Hero Film Evidence
- ✅ `artifacts/caliper-product-launch.srt` - Product-focused subtitles
- ✅ Shows VERDICT, evidence hashes, blockchain settlement
- ✅ Distinguishes LOCAL SIMULATION from NEAR TESTNET

### 5. Documentation
- ✅ `near/evidence/testnet-lifecycle.md` - Full lifecycle docs
- ✅ `README.md` - Updated with live deployment details

## Judge Evaluation Path

1. **Verify deployment:** Check Explorer link for transaction success
2. **Verify contract:** Call `get_total_allocated` or other view methods
3. **Verify tests:** Run `npm test` - 20 tests pass
4. **Verify demo:** Run `npm run demo` - adversarial workflow completes
5. **Review evidence:** `artifacts/caliper-product-launch.srt` and `near/evidence/testnet-lifecycle.md`

## LOCAL SIMULATION vs NEAR TESTNET

Every identity, report, and receipt in this repository is labeled **LOCAL SIMULATION**.  
The live testnet contract shows identical state transitions with actual cryptocurrency settlement.

## SRT Summary (Hero Film Voiceover)

The hero film shows:
1. The threat: AI weakens tests to appear successful
2. CALIPER's solution: Independent verification
3. Evidence: Test assertion inverted, CI disabled
4. Verdict: REJECTED
5. Correction: Verifier signs after fix
6. Blockchain settlement: 5 NEAR transferred
7. Outcome: Only verified work gets paid<tool_call>shell<arg_key>command</arg_key><arg_value>cd /Users/ikhaisoshuare/Downloads/CALIPER && \
echo "SRT File Content:" && \
cat artifacts/caliper-product-launch.srt