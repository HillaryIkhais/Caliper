# CALIPER

**The authority-control layer for autonomous agent teams.**

An agent should be able to delegate work without delegating its entire authority.

CALIPER converts an owner's initial authorization into a tree of independently constrained
capabilities. Each child receives a narrower set of permissions, a reserved budget, an expiry
and explicit delegation rules. Every descendant is checked against the full chain of authority
that created it.

## The problem this solves

Basic budget enforcement is already crowded. Veto and Banbo are serious, well-executed
competitors, but both are single-agent wallet firewalls: an owner constrains one agent.
NEAR's Agent API gives an agent one policy shared by all its grants; a grant carries no
permissions of its own.

None of them answer the consequential question:

> When an agent becomes a coordinator and hires other agents, how do you give each child
> only the authority needed for its task — without giving it the coordinator's entire
> permission set? How do you prevent the coordinator from spending funds already committed
> to its children? And how do you prove that revoking one branch disables every descendant?

That is CALIPER's opening, and Veto's and Banbo's actual contract implementations (reviewed)
confirmed neither supports child-specific delegated capabilities, nested authority, or
transitive revocation.

## The four guarantees

CALIPER enforces one system, not four unrelated features:

1. **Authority attenuation** — a child cannot acquire permissions, recipients, assets or
   spending limits its parent does not possess. Every delegation is checked against the
   parent's permissions.
2. **Commitment isolation** — a parent cannot spend funds already reserved for its children.
   A child cannot spend or delegate beyond its own uncommitted allocation.
3. **Branch revocation** — revoking a parent invalidates every descendant, including pending
   authority and subsequent execution attempts. Committed budget is released back up the chain.
4. **Independent verification** — an external verifier reconstructs the authority tree from
   contract state and checks every allocation, execution and revocation against the invariants.

## The VECT-level demo

One agent team. One exploitable failure. One complete proof.

```
OWNER
# 1.00 NEAR   (maximum authority granted to coordinator)

COORDINATOR A
# 0.60 reserved for Research B  ·  0.20 for Verifier C  ·  0.20 available

RESEARCH B
# 0.60   research payments only

VERIFIER C
# 0.20   approved verification service only
```

Now attack it:

| Attempt | Result |
|---|---|
| Coordinator spends 0.80 NEAR | **REJECTED** — funds already committed to children |
| Research pays an unauthorized recipient | **REJECTED** — not in its permissions |
| Research delegates more than its remaining authority | **REJECTED** — exceeds uncommitted allocation |
| Owner revokes Coordinator A; descendants execute | **REJECTED** — branch revoked transitively |

Then the independent verifier reconstructs the delegation tree, checks reservations and
execution receipts, and confirms no unauthorized action succeeded: **VERIFIED**.

The crucial moment is the first attack: the coordinator tries to spend funds it has already
promised to its children. The contract rejects it. Then the verifier proves why.

That is the memorable product demonstration — you don't tell judges the system is safe, you
let them watch it fail an attack, enforce the correction, and prove the result.

## Why this wins

| Project | Main security question |
|---|---|
| Veto | Can this wallet execute this transaction under its spending policy? |
| Banbo | Did the payment instructions come from a trusted source? |
| NEAR Agent API | What can this agent do under its owner's policy? |
| CALIPER | Can this agent safely create and control a hierarchy of less-privileged agents? |

## Repo contents

- `contract/` — Rust NEAR smart contract (near-sdk 5). `create_root`, `delegate`, `spend`,
  `revoke` and view methods implementing the four guarantees.
- `contract/verify/` — independent TypeScript verifier (`npx tsx verify/verify.ts <state.json>`)
  that reconstructs the authority tree from contract state and checks the four invariants.
- `contract/src/lib.rs` — contains 9 unit tests reproducing the VECT demo sequence
  (attenuation, commitment isolation, branch revocation, revoked-spend rejection).

## Judge path (frictionless)

See `JUDGES.md` for the shortest path. In short:

```bash
# 1. Build the contract (no network, no Rust install needed beyond cargo)
cd contract
cargo build --release --target wasm32-unknown-unknown

# 2. Run the attack tests reproducing the VECT demo
cargo test

# 3. Run the independent verifier against exported contract state
npx tsx verify/verify.ts verify/sample-valid.json        # VERIFIED (exit 0)
npx tsx verify/verify.ts verify/sample-invalid-attenuation.json   # FAILED (exit 1)
npx tsx verify/verify.ts verify/sample-invalid-commitment.json    # FAILED (exit 1)
```

## Deadline

November 14 at 23:59 UTC. Judges screen with Claude Code and Codex whether the public
repository actually runs and does what its README promises. CALIPER ships with reproducible
attack tests and a verifier — not just a pitch.
