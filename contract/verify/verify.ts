/**
 * CALIPER Independent Verifier
 *
 * Reconstructs the authority tree and job lifecycle from a snapshot of the contract's state and
 * checks the four CALIPER guarantees:
 *   1. Authority attenuation — every child's permissions ⊆ its parent's.
 *   2. Commitment isolation — spent + sum(children allocations) <= allocation.
 *   3. Branch revocation — revoking a node invalidates every descendant.
 *   4. Independent verification — every execution, job, and verification ties back to valid nodes.
 *
 * Usage:
 *   npx tsx verify/verify.ts <state.json> [current_block_height]
 *
 * The state.json is exported from the deployed contract's view methods:
 *   get_root, get_node (recursively), list_executions, list_revocations, get_owner, list_jobs.
 *
 * Exits 0 if all invariants hold, non-zero otherwise.
 */

import * as fs from "fs";

type AccountId = string;
type Balance = string; // yoctoNEAR as string
type AuthorityId = number;
type JobId = number;

interface Node {
    id: AuthorityId;
    parent: AuthorityId | null;
    holder: AccountId;
    permissions: {
        recipients: AccountId[];
        assets: AccountId[];
        max_per_tx: Balance;
        may_delegate: boolean;
    };
    allocation: Balance;
    spent: Balance;
    committed_to_children: Balance;
    expiry: number | null;
    active: boolean;
    children: AuthorityId[];
    created_at: number;
}

interface Execution {
    id: number;
    node_id: AuthorityId;
    recipient: AccountId;
    amount: Balance;
    asset: AccountId | null;
    block_height: number;
    status: string; // "Pending" | "Settled" | "Rejected"
}

interface Revocation {
    node_id: AuthorityId;
    revoked_by: AccountId;
    block_height: number;
}

interface Job {
    id: JobId;
    coordinator_node: AuthorityId;
    worker_node: AuthorityId;
    verifier_node: AuthorityId;
    coordinator_holder: AccountId;
    worker_holder: AccountId;
    verifier_holder: AccountId;
    verifier_public_key: string;
    budget: Balance;
    acceptance_criteria_hash: string;
    acceptance_suite_hash: string;
    baseline_commit: string;
    market_transcript_hash: string;
    protected_files: string[];
    deliverable_hash: string | null;
    attempt: number;
    max_attempts: number;
    modified_files_hash: string | null;
    tampering_detected: boolean;
    independent_report_hash: string | null;
    independent_passed: boolean | null;
    deliverable_matches_claim: boolean | null;
    test_exit_code: number | null;
    ci_exit_code: number | null;
    verification: {
        attestation: {
            version: string;
            job_id: JobId;
            attempt: number;
            deliverable_hash: string;
            acceptance_criteria_hash: string;
            baseline_commit: string;
            acceptance_suite_hash: string;
            diff_hash: string;
            deliverable_matches_claim: boolean;
            protected_files_clean: boolean;
            test_exit_code: number;
            ci_exit_code: number;
            runner_version: string;
            passed: boolean;
            report_digest: string;
            verifier_public_key: string;
            signature: string;
        };
        recorded_at: number;
    } | null;
    status: string; // "Open" | "Submitted" | "Verified" | "PaymentPending" | "Paid" | "PaymentFailed" | "Rejected" | "Exhausted" | "Cancelled"
    payment_error: string | null;
    created_at: number;
    submitted_at: number | null;
    verified_at: number | null;
    resolved_at: number | null;
    paid_at: number | null;
}

interface State {
    root: AuthorityId | null;
    owner: AccountId;
    nodes: Record<string, Node>;
    executions: Execution[];
    revocations: Revocation[];
    jobs: Job[];
}

function toBigInt(s: Balance | number): bigint {
    return BigInt(String(s));
}

function b2s(b: bigint): string {
    return b.toString();
}

interface Violation {
    node?: AuthorityId;
    execution?: number;
    job?: JobId;
    type: string;
    detail: string;
}

const violations: Violation[] = [];

function fail(type: string, detail: string, node?: AuthorityId, execution?: number, job?: JobId) {
    violations.push({ type, detail, node, execution, job });
}

function verify(state: State, currentBlock: number | null) {
    const nodesById = new Map<AuthorityId, Node>();
    for (const [idStr, node] of Object.entries(state.nodes)) {
        nodesById.set(Number(idStr), node);
    }

    const root = state.root;
    if (root == null || !nodesById.has(root)) {
        fail("tree", "no valid root node in state");
        return;
    }

    // Build a revocation lookup: node_id → revocation block height
    const revocationBlocks = new Map<AuthorityId, number>();
    for (const rev of state.revocations) {
        revocationBlocks.set(rev.node_id, rev.block_height);
    }

    // --- walk every node stored in state (including revoked subtrees) ---
    // Revoked children are removed from their parent's children list but remain
    // in storage, so we iterate all stored nodes rather than traversing from root.
    for (const [idStr, node] of Object.entries(state.nodes)) {
        const id = Number(idStr);

        // Walk the authority chain from this node up to the root.
        // A node is "historically valid" if no ancestor was revoked or expired
        // at the time this node was created. Since we don't store creation
        // block height, we use currentBlock as a proxy.
        let chainValid = true;
        let curr: AuthorityId | null = id;
        while (curr != null) {
            const n = nodesById.get(curr);
            if (!n) { chainValid = false; break; }
            // An ancestor that is inactive means the chain is broken.
            if (!n.active) chainValid = false;
            // An expired ancestor breaks the chain.
            if (currentBlock != null && n.expiry != null && currentBlock >= n.expiry) chainValid = false;
            curr = n.parent;
        }
        if (!chainValid && node.active) {
            fail("revocation", `node ${id} is active but an ancestor is revoked/expired`, id);
        }

        // 1. Authority attenuation: child's permissions ⊆ parent's.
        if (node.parent != null) {
            const parent = nodesById.get(node.parent);
            if (!parent) {
                fail("attenuation", `node ${id} has unknown parent ${node.parent}`, id);
            } else {
                for (const r of node.permissions.recipients) {
                    if (!parent.permissions.recipients.includes(r)) {
                        fail("attenuation", `node ${id} recipient ${r} not in parent's permissions`, id);
                    }
                }
                for (const a of node.permissions.assets) {
                    if (!parent.permissions.assets.includes(a)) {
                        fail("attenuation", `node ${id} asset ${a} not in parent's permissions`, id);
                    }
                }
                if (toBigInt(node.permissions.max_per_tx) > toBigInt(parent.permissions.max_per_tx)) {
                    fail("attenuation", `node ${id} max_per_tx exceeds parent's`, id);
                }
                if (node.permissions.may_delegate && !parent.permissions.may_delegate) {
                    fail("attenuation", `node ${id} may_delegate exceeds parent's`, id);
                }
            }
        }

        // 2. Commitment isolation: spent + sum(direct children allocations) <= allocation.
        // Direct children are tracked in node.children (revoked children are removed).
        let childrenSum = BigInt(0);
        for (const c of node.children) {
            const cn = nodesById.get(c);
            if (cn) childrenSum = childrenSum + toBigInt(cn.allocation);
        }
        const spent = toBigInt(node.spent);
        const allocation = toBigInt(node.allocation);
        if (spent > allocation) {
            fail("commitment", `node ${id} spent ${b2s(spent)} > allocation ${b2s(allocation)}`, id);
        }
        if (spent + childrenSum > allocation) {
            fail("commitment", `node ${id} spent+children(${b2s(spent + childrenSum)}) > allocation ${b2s(allocation)}`, id);
        }
        const uncommitted = allocation - spent - childrenSum;
        if (uncommitted < 0) {
            fail("commitment", `node ${id} uncommitted allocation negative`, id);
        }
    }

    // 4. Independent verification: every execution ties to a valid node at the time it ran.
    // An execution from a node that was later revoked is still valid if it happened before revocation.
    for (const ex of state.executions) {
        const node = nodesById.get(ex.node_id);
        if (!node) {
            fail("execution", `execution ${ex.id} references unknown node ${ex.node_id}`, undefined, ex.id);
            continue;
        }

        // Check if the node was revoked before this execution ran.
        const revokedAt = revocationBlocks.get(ex.node_id);
        if (revokedAt != null && ex.block_height >= revokedAt) {
            fail("execution", `execution ${ex.id} ran at block ${ex.block_height} from node ${ex.node_id} revoked at block ${revokedAt}`, ex.node_id, ex.id);
        }

        // Recipient must be allowed by the node's permissions.
        if (!node.permissions.recipients.includes(ex.recipient)) {
            fail("execution", `execution ${ex.id} recipient ${ex.recipient} not allowed by node ${ex.node_id}`, ex.node_id, ex.id);
        }

        // Amount must not exceed per-tx cap.
        if (toBigInt(ex.amount) > toBigInt(node.permissions.max_per_tx)) {
            fail("execution", `execution ${ex.id} amount exceeds node ${ex.node_id} per-tx cap`, ex.node_id, ex.id);
        }

        // Amount must not exceed node's allocation.
        if (toBigInt(ex.amount) > toBigInt(node.allocation)) {
            fail("execution", `execution ${ex.id} amount exceeds node ${ex.node_id} allocation`, ex.node_id, ex.id);
        }
    }

    // 4b. Job verification: every job's roles, evidence, and payment state are valid.
    for (const job of state.jobs) {
        const coordinator = nodesById.get(job.coordinator_node);
        const worker = nodesById.get(job.worker_node);
        const verifier = nodesById.get(job.verifier_node);

        if (!coordinator) {
            fail("job", `job ${job.id} has unknown coordinator node ${job.coordinator_node}`, job.coordinator_node, undefined, job.id);
            continue;
        }
        if (!worker) {
            fail("job", `job ${job.id} has unknown worker node ${job.worker_node}`, job.worker_node, undefined, job.id);
        }
        if (!verifier) {
            fail("job", `job ${job.id} has unknown verifier node ${job.verifier_node}`, job.verifier_node, undefined, job.id);
        }

        // Role separation: distinct node ids and distinct account holders.
        if (job.coordinator_node === job.worker_node || job.coordinator_node === job.verifier_node) {
            fail("job", `job ${job.id} reuses the coordinator node for another role`, undefined, undefined, job.id);
        }
        if (job.worker_node === job.verifier_node) {
            fail("job", `job ${job.id} reuses the worker node as verifier`, undefined, undefined, job.id);
        }
        const holders = [job.coordinator_holder, job.worker_holder, job.verifier_holder];
        if (new Set(holders).size !== 3) {
            fail("job", `job ${job.id} does not have three distinct account holders`, undefined, undefined, job.id);
        }
        if (coordinator && coordinator.holder !== job.coordinator_holder) {
            fail("job", `job ${job.id} coordinator holder does not match node`, job.coordinator_node, undefined, job.id);
        }
        if (worker && worker.holder !== job.worker_holder) {
            fail("job", `job ${job.id} worker holder does not match node`, job.worker_node, undefined, job.id);
        }
        if (verifier && verifier.holder !== job.verifier_holder) {
            fail("job", `job ${job.id} verifier holder does not match node`, job.verifier_node, undefined, job.id);
        }

        // Worker and verifier must hold authority beneath the coordinator's branch.
        if (!isDescendant(nodesById, job.worker_node, job.coordinator_node)) {
            fail("job", `job ${job.id} worker is not a descendant of coordinator`, job.worker_node, undefined, job.id);
        }
        if (!isDescendant(nodesById, job.verifier_node, job.coordinator_node)) {
            fail("job", `job ${job.id} verifier is not a descendant of coordinator`, job.verifier_node, undefined, job.id);
        }

        // Pinned evidence must exist.
        for (const [label, value] of Object.entries({
            acceptance_criteria_hash: job.acceptance_criteria_hash,
            acceptance_suite_hash: job.acceptance_suite_hash,
            baseline_commit: job.baseline_commit,
            market_transcript_hash: job.market_transcript_hash,
            verifier_public_key: job.verifier_public_key,
        })) {
            if (!value) fail("job", `job ${job.id} missing pinned ${label}`, undefined, undefined, job.id);
        }
        if (!/^[0-9a-f]{64}$/.test(job.verifier_public_key)) {
            fail("job", `job ${job.id} verifier public key is not 32-byte hex`, undefined, undefined, job.id);
        }
        if (job.attempt < 0 || job.attempt > job.max_attempts) {
            fail("job", `job ${job.id} attempt ${job.attempt} exceeds max ${job.max_attempts}`, undefined, undefined, job.id);
        }

        // Job creation time ordering
        if (job.created_at < coordinator.created_at || (worker && job.created_at < worker.created_at)) {
            fail("job", `job ${job.id} created before its nodes existed`, undefined, undefined, job.id);
        }
        if (job.submitted_at != null && job.submitted_at < job.created_at) {
            fail("job", `job ${job.id} submitted before creation`, undefined, undefined, job.id);
        }
        if (job.resolved_at != null && job.submitted_at != null && job.resolved_at < job.submitted_at) {
            fail("job", `job ${job.id} resolved before submission`, undefined, undefined, job.id);
        }

        // Any stored verification must be bound to the current attempt and artifact.
        if (job.verification != null) {
            const a = job.verification.attestation;
            if (a.job_id !== job.id) {
                fail("job", `job ${job.id} stores an attestation for job ${a.job_id}`, undefined, undefined, job.id);
            }
            if (a.attempt !== job.attempt) {
                fail("job", `job ${job.id} stores an attestation for attempt ${a.attempt}, current attempt is ${job.attempt}`, undefined, undefined, job.id);
            }
            if (a.deliverable_hash !== job.deliverable_hash) {
                fail("job", `job ${job.id} attestation is not bound to the current deliverable`, undefined, undefined, job.id);
            }
            if (a.acceptance_criteria_hash !== job.acceptance_criteria_hash) {
                fail("job", `job ${job.id} attestation uses different acceptance criteria`, undefined, undefined, job.id);
            }
            if (a.baseline_commit !== job.baseline_commit) {
                fail("job", `job ${job.id} attestation uses a different baseline`, undefined, undefined, job.id);
            }
            if (a.acceptance_suite_hash !== job.acceptance_suite_hash) {
                fail("job", `job ${job.id} attestation uses a different acceptance suite`, undefined, undefined, job.id);
            }
            if (a.verifier_public_key !== job.verifier_public_key) {
                fail("job", `job ${job.id} attestation uses a different verifier key`, undefined, undefined, job.id);
            }
            if (
                a.passed !==
                (a.deliverable_matches_claim &&
                    a.protected_files_clean &&
                    a.test_exit_code === 0 &&
                    a.ci_exit_code === 0)
            ) {
                fail("job", `job ${job.id} attestation outcome is inconsistent`, undefined, undefined, job.id);
            }
            if (job.deliverable_matches_claim !== a.deliverable_matches_claim) {
                fail("job", `job ${job.id} deliverable-match flag disagrees with the stored attestation`, undefined, undefined, job.id);
            }
            if (job.ci_exit_code !== a.ci_exit_code) {
                fail("job", `job ${job.id} CI exit code disagrees with the stored attestation`, undefined, undefined, job.id);
            }
            if (a.passed !== job.independent_passed || a.report_digest !== job.independent_report_hash) {
                fail("job", `job ${job.id} convenience fields disagree with the stored attestation`, undefined, undefined, job.id);
            }
        }

        const requiresVerification = ["Verified", "PaymentPending", "Paid"].includes(job.status);
        if (requiresVerification) {
            if (job.independent_passed !== true) {
                fail("job", `job ${job.id} is ${job.status} but independent_passed is not true`, undefined, undefined, job.id);
            }
            if (job.tampering_detected) {
                fail("job", `job ${job.id} is ${job.status} but tampering was detected`, undefined, undefined, job.id);
            }
            if (job.verification == null) {
                fail("job", `job ${job.id} is ${job.status} but has no signed attestation`, undefined, undefined, job.id);
            }
            if (job.paid_at != null && job.status !== "Paid") {
                fail("job", `job ${job.id} has paid_at set but status is ${job.status}`, undefined, undefined, job.id);
            }
        }

        if (job.status === "Paid" && job.paid_at == null) {
            fail("job", `job ${job.id} is Paid but has no paid_at block`, undefined, undefined, job.id);
        }
        if (["Rejected", "Exhausted"].includes(job.status) && job.independent_passed === true) {
            fail("job", `job ${job.id} is ${job.status} with a successful verification`, undefined, undefined, job.id);
        }
    }

    // Revocations must reference known nodes.
    for (const rev of state.revocations) {
        if (!nodesById.has(rev.node_id)) {
            fail("revocation", `revocation references unknown node ${rev.node_id}`, rev.node_id);
        }
    }
}

// Helper to check if a node is a descendant of another
function isDescendant(nodesById: Map<AuthorityId, Node>, nodeId: AuthorityId, ancestorId: AuthorityId): boolean {
    let current: AuthorityId | null = nodeId;
    while (current != null) {
        const node = nodesById.get(current);
        if (!node) return false;
        if (node.id === ancestorId) return true;
        current = node.parent;
    }
    return false;
}

async function main() {
    const statePath = process.argv[2];
    const currentBlock = process.argv[3] ? Number(process.argv[3]) : null;
    if (!statePath) {
        console.error("Usage: npx tsx verify/verify.ts <state.json> [current_block_height]");
        process.exit(2);
    }

    let state: State;
    try {
        state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch (e) {
        console.error(`Failed to read/parse ${statePath}: ${e}`);
        process.exit(2);
    }

    verify(state, currentBlock);

    if (violations.length === 0) {
        console.log("VERIFIED: all CALIPER authority invariants hold");
        console.log(`  root: ${state.root}  nodes: ${Object.keys(state.nodes).length}  executions: ${state.executions.length}  revocations: ${state.revocations.length}  jobs: ${state.jobs.length}`);
        process.exit(0);
    } else {
        console.log("FAILED: authority invariant violations detected:");
        for (const v of violations) {
            const loc = v.node != null ? `node ${v.node}` : (v.execution != null ? `execution ${v.execution}` : (v.job != null ? `job ${v.job}` : "tree"));
            console.log(`  [${v.type}] ${loc}: ${v.detail}`);
        }
        process.exit(1);
    }
}

main();