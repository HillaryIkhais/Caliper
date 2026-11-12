# CALIPER — Judge's shortest path

CALIPER is independent acceptance for agent-created code with least-privilege delegation:

- **Authority attenuation**: child permissions ⊆ parent permissions
- **Commitment isolation**: spent + sum(children allocations) ≤ allocation  
- **Branch revocation**: revoking invalidates descendants
- **Independent verification**: job acceptance requires `tampering_detected == false` AND `independent_passed == true`

## What to check

| Claim | How to verify | Command |
|---|---|---|
| The contract builds | `cargo build --release --target wasm32-unknown-unknown` produces `contract/target/wasm32-unknown-unknown/release/caliper.wasm` | see below |
| 13 tests pass | All tests including proof-gated subcontracting, commitment isolation, attestation | see below |
| Verifier accepts valid | exits 0, prints `VERIFIED` | see below |
| Verifier rejects invalid | exits 1, names the violation | see below |

## Step-by-step (no network, no wallet, no testnet needed)

```bash
cd contract

# 1. Build the contract
cargo build --release --target wasm32-unknown-unknown
ls target/wasm32-unknown-unknown/release/caliper.wasm   # ~286 KB

# 2. Run the tests (13 tests)
cargo test
# expect: test result: ok. 13 passed; 0 failed

# 3. Run the independent verifier
npx tsx verify/verify.ts verify/sample-valid.json
# expect: VERIFIED ... (exit 0)
echo $?   # 0

npx tsx verify/verify.ts verify/sample-invalid-attenuation.json
# expect: FAILED ... [attenuation] ... (exit 1)
echo $?   # 1

npx tsx verify/verify.ts verify/sample-invalid-commitment.json
# expect: FAILED ... [commitment] ... (exit 1)
echo $?   # 1
```

## The 13 unit tests

- `create_root_and_delegate` — authority attenuation + commitment isolation
- `delegate_attenuation_enforced` — child cannot get max_per_tx above parent's
- `spend_within_allocation_succeeds` — worker spends inside its allocation
- `spend_to_unauthorized_recipient_rejected` — deny-by-default recipient list
- `commitment_isolation_coordinator_cannot_spend_promised_funds` — signature demo: 0.60 + 0.20 committed, 0.80 attempt rejected
- `revoked_node_spend_is_rejected` — a revoked branch cannot execute
- `revoke_child_releases_parent_commitment` — revoking a child releases budget back up
- `revoke_root_invalidates_whole_branch_transitively` — revoking root invalidates all descendants
- `nested_revocation_releases_correct_commitments` — revoking interior node releases only that node's allocation
- `proof_gated_subcontracting_tampering_detected` — worker modifies protected files → tampering detected → acceptance blocked
- `proof_gated_subcontracting_clean_then_accepted` — clean deliverable → independent verification pass → coordinator accepts → payment
- `proof_gated_subcontracting_independent_verification_fails` — verification fails → acceptance blocked
- `create_root_twice_panics` — only one root allowed

## What the verifier checks

`verify/verify.ts` reconstructs the authority tree from exported contract state and verifies:

1. **Authority attenuation** — every child's recipients, assets, max_per_tx, may_delegate ⊆ parent's
2. **Commitment isolation** — spent + sum(children allocations) ≤ allocation per node
3. **Branch revocation** — revoked nodes and their descendants are inactive
4. **Node ordering** — `created_at` timestamps enforce proper causality

## Deadline

November 14 at 23:59 UTC.