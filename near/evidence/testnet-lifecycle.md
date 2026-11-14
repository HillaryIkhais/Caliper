# CALIPER Testnet Evidence Boundary

This document separates what is verified on NEAR testnet from what is only demonstrated locally.

## Verified: deployment and initialization

| Item | Value |
|------|-------|
| Contract account | `caliper.testnet` |
| Network | NEAR Testnet |
| Deployment transaction | `HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z` |
| Final execution status | `FINAL` |
| Transaction outcome | `SuccessValue("")` |
| Signer / receiver | `caliper.testnet` / `caliper.testnet` |
| Actions | `DeployContract` + `FunctionCall` (`init`) |
| Transaction outcome block hash | `CV8aCm1TPwdzjQUHcCgqmozwuu6kkRKL8MAu1JpTCnKv` |
| Deployed code hash | `Hst7gb5bXE4DoY99CgbrG2McRGBm41LkUKodpF7Fc2Bh` |
| Code hash query block height | 277626735 |
| Account balance | 9,997.3034170156228 NEAR |
| Account query block height | 277626729 |
| Storage usage | 348,365 bytes |
| Explorer | https://testnet.nearblocks.io/txns/HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z |

The `init` call set the owner:

```text
get_owner() -> "caliper.testnet"
```

## Not verified: the job lifecycle

The following views were queried at finality and returned:

```text
get_root()            -> null
get_total_allocated() -> "0"
list_jobs()           -> []
```

Interpretation:

- No root authority has been created on testnet.
- No budget has been allocated or delegated.
- No job has been created, submitted, verified, cancelled, or paid on testnet.

Therefore this repository does **not** claim an on-chain job lifecycle, an on-chain auction, or on-chain settlement on testnet.

## Deployment caveat: bytecode predates the fixes

The deployed code hash `Hst7gb5bXE4DoY99CgbrG2McRGBm41LkUKodpF7Fc2Bh` corresponds to the bytecode that was deployed in the transaction above. The working tree now contains corrected settlement semantics:

- escrowed maximum budget vs. exact winning-bid payment;
- permissionless `release_verified_payment`;
- `Verified` jobs are not cancellable;
- revocation guards for outstanding obligations;
- `Submitted` jobs become cancellable only after `VERIFICATION_TIMEOUT_BLOCKS`.

Those changes are **not** in the deployed bytecode. A redeploy is required before claiming that the testnet contract implements them.

## Reproduce the verified views

Using the NEAR CLI:

```bash
near view caliper.testnet get_owner
near view caliper.testnet get_root
near view caliper.testnet get_total_allocated
near view caliper.testnet list_jobs
near state caliper.testnet
```

Using JSON-RPC:

```bash
curl -s https://rpc.testnet.near.org \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"caliper.testnet"}}'

curl -s https://rpc.testnet.near.org \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tx","params":{"tx_hash":"HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z","sender_account_id":"caliper.testnet","wait_until":"FINAL"}}'
```

## Unexecuted lifecycle procedure

`near/scripts/testnet-lifecycle.sh` contains the full sequence: redeploy, `init`, create root, delegate roles, create a job with `budget` and `winning_bid`, submit a deliverable, record a signed attestation, release payment permissionlessly, and assert the final state.

It requires a funded testnet account, role accounts, a matching verifier keypair, and a signed attestation produced by the runner. **It has not been executed.** Do not cite it as evidence until it has run and the resulting transaction hashes are recorded here.

## Local simulation vs testnet

| Property | Local simulation (`npm run demo`) | Testnet (`caliper.testnet`) |
|----------|-----------------------------------|-----------------------------|
| Bid market | Deterministic off-chain simulation | Not present |
| Winner selection | Off-chain lowest valid bid | Not executed |
| Job lifecycle | Mirrored in `demo/local-chain.ts` | Not executed |
| Payment | Local state transition | Not executed |
| Deployment | N/A | Verified, final |
| `init` | N/A | Verified, final |
| Deployed code matches working tree | N/A | **No** |

The local simulation is useful for inspecting the intended state machine. It is not on-chain evidence.
