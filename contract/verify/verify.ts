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

    // --- walk every node, checking parent chain ---
    const visited = new Set<AuthorityId>();
    const stack: AuthorityId[] = [root];
    while (stack.length) {
        const id = stack.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodesById.get(id);
        if (!node) continue;

        // push children for traversal
        for (const c of node.children) stack.push(c);

        // 3. branch revocation: walk up to root; any inactive/expired ancestor invalidates
        let chainValid = true;
        let curr: AuthorityId | null = id;
        const chain: AuthorityId[] = [];
        while (curr != null) {
            chain.push(curr);
            const n = nodesById.get(curr);
            if (!n) { chainValid = false; break; }
            if (!n.active) chainValid = false;
            if (currentBlock != null && n.expiry != null && currentBlock >= n.expiry) chainValid = false;
            curr = n.parent;
        }
        if (!chainValid && node.active) {
            fail("revocation", `node ${id} is active but an ancestor is revoked/expired`, id);
        }
        if (!node.active && chain.some(c => {
            const n = nodesById.get(c);
            return !n || !n.active;
        })) {
            // an inactive node whose chain is otherwise fine is OK (explicitly revoked)
        }

        // 1. authority attenuation: child's permissions ⊆ parent's
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

        // 2. commitment isolation: spent + sum(children allocations) <= allocation
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

    // every node should be reachable from root
    for (const idStr of Object.keys(state.nodes)) {
        if (!visited.has(Number(idStr))) {
            fail("tree", `node ${idStr} not reachable from root`, Number(idStr));
        }
    }

    // 4. independent verification: every execution ties to a valid node
    for (const ex of state.executions) {
        const node = nodesById.get(ex.node_id);
        if (!node) {
            fail("execution", `execution ${ex.id} references unknown node ${ex.node_id}`, undefined, ex.id);
            continue;
        }
        if (!node.active) {
            fail("execution", `execution ${ex.id} from inactive node ${ex.node_id}`, ex.node_id, ex.id);
        }
        if (currentBlock != null && node.expiry != null && currentBlock >= node.expiry) {
            fail("execution", `execution ${ex.id} from expired node ${ex.node_id}`, ex.node_id, ex.id);
        }
        // recipient allowed
        if (!node.permissions.recipients.includes(ex.recipient)) {
            fail("execution", `execution ${ex.id} recipient ${ex.recipient} not allowed by node ${ex.node_id}`, ex.node_id, ex.id);
        }
        // amount within per-tx cap
        if (toBigInt(ex.amount) > toBigInt(node.permissions.max_per_tx)) {
            fail("execution", `execution ${ex.id} amount exceeds node ${ex.node_id} per-tx cap`, ex.node_id, ex.id);
        }
        // amount within node's allocation (at least structurally)
        if (toBigInt(ex.amount) > toBigInt(node.allocation)) {
            fail("execution", `execution ${ex.id} amount exceeds node ${ex.node_id} allocation`, ex.node_id, ex.id);
        }
    }

    // revocations reference known nodes
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
