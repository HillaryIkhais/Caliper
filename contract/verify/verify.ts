/**
 * CALIPER Independent Verifier
 *
 * Reconstructs the authority tree from a snapshot of the contract's state and
 * checks the four CALIPER guarantees:
 *   1. Authority attenuation — every child's permissions ⊆ its parent's.
 *   2. Commitment isolation — spent + sum(children allocations) <= allocation.
 *   3. Branch revocation — revoking a node invalidates every descendant.
 *   4. Independent verification — every execution ties back to a valid node.
 *
 * Usage:
 *   npx tsx verify/verify.ts <state.json> [current_block_height]
 *
 * The state.json is exported from the deployed contract's view methods:
 *   get_root, get_node (recursively), list_executions, list_revocations, get_owner.
 *
 * Exits 0 if all invariants hold, non-zero otherwise.
 */

import * as fs from "fs";

type AccountId = string;
type Balance = string; // yoctoNEAR as string
type AuthorityId = number;

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
}

interface Execution {
    id: number;
    node_id: AuthorityId;
    recipient: AccountId;
    amount: Balance;
    asset: AccountId | null;
    block_height: number;
    status: string;
}

interface Revocation {
    node_id: AuthorityId;
    revoked_by: AccountId;
    block_height: number;
}

interface State {
    root: AuthorityId | null;
    owner: AccountId;
    nodes: Record<string, Node>;
    executions: Execution[];
    revocations: Revocation[];
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
    type: string;
    detail: string;
}

const violations: Violation[] = [];

function fail(type: string, detail: string, node?: AuthorityId, execution?: number) {
    violations.push({ type, detail, node, execution });
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

    // Revocations must reference known nodes.
    for (const rev of state.revocations) {
        if (!nodesById.has(rev.node_id)) {
            fail("revocation", `revocation references unknown node ${rev.node_id}`, rev.node_id);
        }
    }
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
        console.log(`  root: ${state.root}  nodes: ${Object.keys(state.nodes).length}  executions: ${state.executions.length}  revocations: ${state.revocations.length}`);
        process.exit(0);
    } else {
        console.log("FAILED: authority invariant violations detected:");
        for (const v of violations) {
            const loc = v.node != null ? `node ${v.node}` : (v.execution != null ? `execution ${v.execution}` : "tree");
            console.log(`  [${v.type}] ${loc}: ${v.detail}`);
        }
        process.exit(1);
    }
}

main();
