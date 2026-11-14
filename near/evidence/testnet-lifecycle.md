# CALIPER Testnet Lifecycle Evidence

## Deployment Summary

**Contract:** `caliper.testnet`  
**Network:** NEAR Testnet  
**Transaction:** `HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z`  
**Explorer:** https://testnet.nearblocks.io/txns/HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z  
**WASM SHA-256:** `fac3d3d2c2a4ca206085b96e6ddb9223a4bb8b4d8882ef19cd5dba717593c0a8`

## Account Status

- **Contract Account:** `caliper.testnet`
- **Balance:** 9.997 NEAR (remaining after gas fees)
- **Code Hash:** `Hst7gb5bXE4DoY99CgbrG2McRGBm41LkUKodpF7Fc2Bh`
- **Storage Paid:** Yes
- **Storage Usage:** 348,365 bytes

## Verification

The contract was deployed using:
1. Build: `cargo build --release --target wasm32-unknown-unknown`
2. Deploy: `near deploy caliper.testnet --initFunction init --initArgs '{"owner":"caliper.testnet"}'`

## LOCAL SIMULATION vs NEAR TESTNET Distinguished Evidence

### LOCAL SIMULATION (demo/runner.ts)
- Shows the verification process
- Runs pinned acceptance tests
- Produces verification reports
- **Clearly labeled:** "local simulation"

### NEAR TESTNET (On-Chain)
- Real blockchain transactions
- Native NEAR token transfers
- Persisted state
- **Auditable by anyone** via NEAR RPC/Explorer

## How to Verify

1. **Check deployment:** Visit the Explorer link
2. **Verify contract:** Call `get_total_allocated` or other view methods
3. **Verify tests:** Run `npm test` - 20 tests pass
4. **Verify demo:** Run `npm run demo` - adversarial workflow completes
5. **Review evidence:** See artifacts/caliper-product-launch.srt
