use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, UnorderedMap, UnorderedSet};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, near, AccountId, NearToken};
use near_sdk::json_types::U128;

pub type Balance = u128;
pub type AuthorityId = u64;
pub type ExecutionId = u64;

near_sdk::setup_alloc!();

/// One node in the authority tree: an agent (root owner, coordinator, or child).
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Node {
    /// Globally unique authority id.
    pub id: AuthorityId,
    /// Parent node (None for the root owner). Revoking an ancestor invalidates this node transitively.
    pub parent: Option<AuthorityId>,
    /// The account that holds this authority (the key that may spend/delegate under it).
    pub holder: AccountId,
    /// Permissions this node is allowed to exercise, attenuated from its parent.
    pub permissions: Permissions,
    /// Total allocation granted to this node (yoctoNEAR).
    pub allocation: Balance,
    /// Amount already spent by this node.
    pub spent: Balance,
    /// Amount reserved for this node's own children (committed, unavailable to this node).
    pub committed_to_children: Balance,
    /// Block height at which this authority expires (None = no expiry).
    pub expiry: Option<u64>,
    /// Whether this node (or any ancestor) has been revoked.
    pub active: bool,
    /// Direct children of this node.
    pub children: Vec<AuthorityId>,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Permissions {
    /// Allowed recipient accounts (deny-by-default empty = nothing).
    pub recipients: Vec<AccountId>,
    /// Allowed assets (token contract ids); NEAR is always allowed implicitly.
    pub assets: Vec<AccountId>,
    /// Maximum single spend (yoctoNEAR).
    pub max_per_tx: Balance,
    /// May delegate to children (attenuated only).
    pub may_delegate: bool,
}

/// A spend execution recorded for independent verification.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Execution {
    pub id: ExecutionId,
    pub node_id: AuthorityId,
    pub recipient: AccountId,
    pub amount: Balance,
    pub asset: Option<AccountId>,
    pub block_height: u64,
    pub status: ExecutionStatus,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub enum ExecutionStatus {
    Pending,
    Settled,
    Rejected,
}

/// A revocation recorded for independent verification.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Revocation {
    pub node_id: AuthorityId,
    pub revoked_by: AccountId,
    pub block_height: u64,
}

#[near(contract_state)]
pub struct Contract {
    /// Next authority id to assign.
    next_authority_id: AuthorityId,
    /// Next execution id to assign.
    next_execution_id: ExecutionId,
    /// All nodes by id.
    nodes: LookupMap<AuthorityId, Node>,
    /// Index: holder -> set of authority ids they hold.
    holders: LookupMap<AccountId, UnorderedSet<AuthorityId>>,
    /// All executions.
    executions: UnorderedMap<ExecutionId, Execution>,
    /// All revocations.
    revocations: UnorderedMap<AuthorityId, Revocation>,
    /// Total NEAR locked in the contract (reserved + uncommitted).
    total_locked: Balance,
    /// The root owner account (the only account that can create the root node).
    owner: AccountId,
    /// The root authority id, once created.
    root: Option<AuthorityId>,
}

impl Default for Contract {
    fn default() -> Self {
        Self {
            next_authority_id: 0,
            next_execution_id: 0,
            nodes: LookupMap::new(b"n"),
            holders: LookupMap::new(b"h"),
            executions: UnorderedMap::new(b"e"),
            revocations: UnorderedMap::new(b"r"),
            total_locked: 0,
            owner: "owner.near".parse().unwrap(),
            root: None,
        }
    }
}

impl Contract {
    fn new_for_test() -> Self {
        Self {
            next_authority_id: 1,
            next_execution_id: 1,
            nodes: LookupMap::new(b"n"),
            holders: LookupMap::new(b"h"),
            executions: UnorderedMap::new(b"e"),
            revocations: UnorderedMap::new(b"r"),
            total_locked: 0,
            owner: "owner.near".parse().unwrap(),
            root: None,
        }
    }

    // ---------- internal helpers ----------

    fn node(&self, id: AuthorityId) -> Node {
        self.nodes.get(&id).expect("authority not found")
    }

    fn set_node(&mut self, id: AuthorityId, node: Node) {
        self.nodes.insert(&id, &node);
    }

    /// Returns the chain of nodes from `id` up to the root (inclusive).
    fn authority_chain(&self, id: AuthorityId) -> Vec<Node> {
        let mut chain = Vec::new();
        let mut current = id;
        loop {
            let node = self.node(current);
            let parent = node.parent;
            chain.push(node);
            match parent {
                None => break,
                Some(p) => current = p,
            }
        }
        chain
    }

    /// Returns the set of descendant authority ids (direct and indirect children).
    fn descendants(&self, id: AuthorityId) -> Vec<AuthorityId> {
        let mut out = Vec::new();
        let mut stack = self.node(id).children.clone();
        while let Some(child) = stack.pop() {
            out.push(child);
            stack.extend(self.node(child).children.iter().copied());
        }
        out
    }

    /// True if `id` or any ancestor is revoked or expired at `block_height`.
    fn is_authority_valid(&self, id: AuthorityId, block_height: u64) -> bool {
        for node in self.authority_chain(id) {
            if !node.active {
                return false;
            }
            if let Some(exp) = node.expiry {
                if block_height >= exp {
                    return false;
                }
            }
        }
        true
    }

    /// Uncommitted allocation still available to this node to spend or delegate.
    fn available(&self, id: AuthorityId) -> Balance {
        let node = self.node(id);
        node.allocation
            .checked_sub(node.spent)
            .and_then(|v| v.checked_sub(node.committed_to_children))
            .expect("spent + committed exceeds allocation")
    }

    /// Checks that `child` permissions are attenuated within `parent` permissions.
    fn check_attenuation(parent: &Node, child: &Node) {
        // recipients: child's set must be subset of parent's
        for r in &child.permissions.recipients {
            assert!(
                parent.permissions.recipients.contains(r),
                "child recipient not in parent's permissions"
            );
        }
        // assets: child's set must be subset of parent's
        for a in &child.permissions.assets {
            assert!(
                parent.permissions.assets.contains(a),
                "child asset not in parent's permissions"
            );
        }
        // max_per_tx: child's must not exceed parent's
        assert!(
            child.permissions.max_per_tx <= parent.permissions.max_per_tx,
            "child max_per_tx exceeds parent's"
        );
        // may_delegate: child cannot delegate if parent cannot
        assert!(
            !child.permissions.may_delegate || parent.permissions.may_delegate,
            "child may_delegate exceeds parent's"
        );
    }

    /// Total allocation of the subtree rooted at `id` (including `id` itself).
    fn subtree_allocation(&self, id: AuthorityId) -> Balance {
        let mut total = self.node(id).allocation;
        for child in &self.node(id).children {
            total = total.checked_add(self.subtree_allocation(*child)).expect("overflow");
        }
        total
    }

    /// Add `id` to the holder's index.
    fn add_holder(&mut self, holder: &AccountId, id: AuthorityId) {
        let mut set = self.holders.get(holder).unwrap_or_else(|| {
            UnorderedSet::new(format!("h{}", id).as_bytes())
        });
        set.insert(&id);
        self.holders.insert(holder, &set);
    }
}

#[near]
impl Contract {
    #[init]
    pub fn init(owner: AccountId) -> Self {
        Self {
            next_authority_id: 1,
            next_execution_id: 1,
            nodes: LookupMap::new(b"n"),
            holders: LookupMap::new(b"h"),
            executions: UnorderedMap::new(b"e"),
            revocations: UnorderedMap::new(b"r"),
            total_locked: 0,
            owner,
            root: None,
        }
    }

    /// The root owner creates the root authority node and seeds it with an allocation and
    /// boundary permissions. Every descendant must attenuate within these permissions.
    pub fn create_root(
        &mut self,
        holder: AccountId,
        allocation: U128,
        permissions: Permissions,
    ) -> AuthorityId {
        assert_eq!(
            &env::predecessor_account_id(),
            &self.owner,
            "only the owner may create the root"
        );
        assert!(self.root.is_none(), "root already exists");
        let amount: Balance = allocation.into();
        assert!(amount > 0, "allocation must be positive");
        assert!(
            env::attached_deposit() >= NearToken::from_yoctonear(amount),
            "attach at least the allocation in NEAR"
        );

        let id = self.next_authority_id;
        self.next_authority_id += 1;

        let node = Node {
            id,
            parent: None,
            holder: holder.clone(),
            permissions,
            allocation: amount,
            spent: 0,
            committed_to_children: 0,
            expiry: None,
            active: true,
            children: vec![],
        };
        self.nodes.insert(&id, &node);
        self.add_holder(&holder, id);
        self.total_locked += amount;
        self.root = Some(id);

        id
    }

    /// Create a child authority under `parent_id`, attenuated from the parent's permissions.
    pub fn delegate(
        &mut self,
        parent_id: AuthorityId,
        holder: AccountId,
        permissions: Permissions,
        allocation: U128,
        expiry: Option<u64>,
    ) -> AuthorityId {
        let caller = env::predecessor_account_id();
        let block_height = env::block_height();
        let amount: Balance = allocation.into();

        let parent = self.node(parent_id).clone();
        assert_eq!(&caller, &parent.holder, "only the parent's holder may delegate");
        assert!(
            self.is_authority_valid(parent_id, block_height),
            "parent authority is revoked or expired"
        );
        assert!(
            parent.permissions.may_delegate,
            "parent is not allowed to delegate"
        );
        assert!(amount > 0, "allocation must be positive");
        assert!(
            amount <= self.available(parent_id),
            "delegation exceeds parent's uncommitted allocation"
        );
        assert!(
            env::attached_deposit() >= NearToken::from_yoctonear(amount),
            "attach at least the allocation in NEAR"
        );

        let id = self.next_authority_id;
        self.next_authority_id += 1;

        let child_node = Node {
            id,
            parent: Some(parent_id),
            holder: holder.clone(),
            permissions,
            allocation: amount,
            spent: 0,
            committed_to_children: 0,
            expiry,
            active: true,
            children: vec![],
        };
        Self::check_attenuation(&parent, &child_node);

        self.nodes.insert(&id, &child_node);
        self.add_holder(&holder, id);

        // Commit parent's budget to this child.
        let mut parent = parent;
        parent.committed_to_children = parent
            .committed_to_children
            .checked_add(amount)
            .expect("overflow");
        parent.children.push(id);
        self.set_node(parent_id, parent);
        self.total_locked += amount;

        id
    }

    /// Spend from `node_id`. The caller must be the holder of `node_id`.
    pub fn spend(
        &mut self,
        node_id: AuthorityId,
        recipient: AccountId,
        amount: U128,
        asset: Option<AccountId>,
    ) -> ExecutionId {
        let caller = env::predecessor_account_id();
        let block_height = env::block_height();
        let amount: Balance = amount.into();

        let node = self.node(node_id).clone();
        assert_eq!(&caller, &node.holder, "only the node's holder may spend");
        assert!(
            self.is_authority_valid(node_id, block_height),
            "authority is revoked or expired"
        );
        assert!(amount > 0, "amount must be positive");
        assert!(
            amount <= self.available(node_id),
            "spend exceeds node's uncommitted allocation"
        );
        assert!(
            amount <= node.permissions.max_per_tx,
            "spend exceeds per-tx cap"
        );
        // recipient allow-list (deny by default: empty set allows nothing)
        assert!(
            node.permissions.recipients.contains(&recipient),
            "recipient not allowed"
        );
        // asset check: NEAR is always allowed; other assets must be in the permissions set.
        if let Some(a) = &asset {
            assert!(
                node.permissions.assets.contains(a),
                "asset not allowed"
            );
        }

        let id = self.next_execution_id;
        self.next_execution_id += 1;

        let execution = Execution {
            id,
            node_id,
            recipient: recipient.clone(),
            amount,
            asset,
            block_height,
            status: ExecutionStatus::Settled,
        };
        self.executions.insert(&id, &execution);

        let mut node = node;
        node.spent = node.spent.checked_add(amount).expect("overflow");
        self.set_node(node_id, node);

        id
    }

    /// Revoke `node_id` and every descendant, transitively invalidating the whole branch.
    pub fn revoke(&mut self, node_id: AuthorityId) {
        let caller = env::predecessor_account_id();
        let block_height = env::block_height();

        let _ = self.node(node_id);
        assert!(
            self.is_authority_valid(node_id, block_height),
            "authority already revoked or expired"
        );
        assert!(
            &caller == &self.owner
                || self
                    .authority_chain(node_id)
                    .iter()
                    .skip(1) // skip the node itself
                    .any(|n| &caller == &n.holder),
            "only the owner or an ancestor's holder may revoke"
        );

        let subtree_total = self.subtree_allocation(node_id);

        // Mark the node and all descendants inactive.
        let descendants = self.descendants(node_id);
        let mut to_revoke = vec![node_id];
        to_revoke.extend(descendants);
        for id in &to_revoke {
            let mut node = self.node(*id).clone();
            node.active = false;
            self.set_node(*id, node);
            self.revocations.insert(
                id,
                &Revocation {
                    node_id: *id,
                    revoked_by: caller.clone(),
                    block_height,
                },
            );
        }

        // Release commitments back up to the root.
        let mut current = node_id;
        while let Some(parent_id) = self.node(current).parent {
            let mut parent = self.node(parent_id).clone();
            parent.committed_to_children = parent
                .committed_to_children
                .checked_sub(subtree_total)
                .expect("commitment underflow");
            parent.children.retain(|&c| c != current);
            self.set_node(parent_id, parent);
            current = parent_id;
        }
    }

    // ---------- views ----------

    pub fn get_node(&self, id: AuthorityId) -> Option<Node> {
        self.nodes.get(&id)
    }

    pub fn get_root(&self) -> Option<AuthorityId> {
        self.root
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_available(&self, id: AuthorityId) -> U128 {
        U128(self.available(id))
    }

    pub fn is_valid(&self, id: AuthorityId) -> bool {
        self.is_authority_valid(id, env::block_height())
    }

    pub fn get_execution(&self, id: ExecutionId) -> Option<Execution> {
        self.executions.get(&id)
    }

    pub fn list_executions(&self) -> Vec<Execution> {
        self.executions.values().collect()
    }

    pub fn list_revocations(&self) -> Vec<Revocation> {
        self.revocations.values().collect()
    }

    pub fn get_total_locked(&self) -> U128 {
        U128(self.total_locked)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> AccountId {
        "owner.near".parse().unwrap()
    }
    fn bob() -> AccountId {
        "bob.near".parse().unwrap()
    }
    fn carol() -> AccountId {
        "carol.near".parse().unwrap()
    }

    fn root_permissions() -> Permissions {
        Permissions {
            recipients: vec![
                "vendor.near".parse().unwrap(),
                "research-vendor.near".parse().unwrap(),
                "verify-vendor.near".parse().unwrap(),
            ],
            assets: vec![],
            max_per_tx: 100_000_000_000_000_000_000_000_000,
            may_delegate: true,
        }
    }

    fn context(predecessor: AccountId, deposit: Balance) {
        near_sdk::testing_env!(
            near_sdk::test_utils::VMContextBuilder::new()
                .predecessor_account_id(predecessor)
                .attached_deposit(near_sdk::NearToken::from_yoctonear(deposit))
                .build()
        );
    }

    #[test]
    fn create_root_and_delegate() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100_000_000_000_000_000_000_000_000); // 100 NEAR
        let root = contract.create_root(
            bob(),
            U128(100_000_000_000_000_000_000_000_000),
            root_permissions(),
        );
        assert!(root > 0);
        let node = contract.get_node(root).unwrap();
        assert_eq!(node.allocation, 100_000_000_000_000_000_000_000_000);
        assert!(node.active);

        // delegate a child from root
        context(bob(), 40_000_000_000_000_000_000_000_000); // 40 NEAR
        let child = contract.delegate(
            root,
            carol(),
            Permissions {
                recipients: vec!["vendor.near".parse().unwrap()],
                assets: vec![],
                max_per_tx: 10_000_000_000_000_000_000_000_000,
                may_delegate: false,
            },
            U128(40_000_000_000_000_000_000_000_000),
            None,
        );
        assert!(child > 0);
        let child_node = contract.get_node(child).unwrap();
        assert_eq!(child_node.allocation, 40_000_000_000_000_000_000_000_000);
        assert_eq!(child_node.parent, Some(root));
        // root's uncommitted allocation reduced by commitment isolation
        let root_node = contract.get_node(root).unwrap();
        assert_eq!(root_node.committed_to_children, 40_000_000_000_000_000_000_000_000);
        assert_eq!(contract.get_available(root), U128(60_000_000_000_000_000_000_000_000));
    }

    #[test]
    #[should_panic(expected = "root already exists")]
    fn create_root_twice_panics() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        contract.create_root(bob(), U128(100), root_permissions());
        context(owner(), 100);
        contract.create_root(carol(), U128(100), root_permissions());
    }

    #[test]
    fn spend_within_allocation_succeeds() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());
        context(bob(), 40);
        let child = contract.delegate(
            root,
            carol(),
            Permissions {
                recipients: vec!["vendor.near".parse().unwrap()],
                assets: vec![],
                max_per_tx: 100,
                may_delegate: false,
            },
            U128(40),
            None,
        );
        // child spends 30 of its 40
        context(carol(), 30);
        let id = contract.spend(child, "vendor.near".parse().unwrap(), U128(30), None);
        assert!(id > 0);
        let child_node = contract.get_node(child).unwrap();
        assert_eq!(child_node.spent, 30);
        assert_eq!(contract.get_available(child), U128(10));
    }

    #[test]
    #[should_panic(expected = "recipient not allowed")]
    fn spend_to_unauthorized_recipient_rejected() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());
        // root has empty recipients -> deny by default
        context(bob(), 10);
        let _ = contract.spend(root, "anyone.near".parse().unwrap(), U128(10), None);
    }

    #[test]
    fn delegate_attenuation_enforced() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());

        // child requests max_per_tx greater than parent's -> must reject
        context(bob(), 10);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.delegate(
                root,
                carol(),
                Permissions {
                    recipients: vec![],
                    assets: vec![],
                    max_per_tx: 200_000_000_000_000_000_000_000_000, // > parent's 100 NEAR
                    may_delegate: false,
                },
                U128(10),
                None,
            )
        }));
        assert!(result.is_err());
    }

    #[test]
    fn revoke_child_releases_parent_commitment() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());
        context(bob(), 40);
        let child = contract.delegate(
            root,
            carol(),
            Permissions {
                recipients: vec!["vendor.near".parse().unwrap()],
                assets: vec![],
                max_per_tx: 40,
                may_delegate: false,
            },
            U128(40),
            None,
        );
        let root_node_before = contract.get_node(root).unwrap();
        assert_eq!(root_node_before.committed_to_children, 40);

        // carol (child holder) revokes her own child — allowed? no, only owner or ancestor.
        // bob (root holder, ancestor of child) revokes the child.
        context(bob(), 0);
        contract.revoke(child);

        assert!(!contract.get_node(child).unwrap().active);
        // root's commitment to the child is released
        let root_node = contract.get_node(root).unwrap();
        assert_eq!(root_node.committed_to_children, 0);
        assert_eq!(root_node.children.len(), 0);
        assert!(root_node.active);
    }

    #[test]
    fn revoke_root_invalidates_whole_branch_transitively() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());
        context(bob(), 40);
        let child = contract.delegate(
            root,
            carol(),
            Permissions {
                recipients: vec!["vendor.near".parse().unwrap()],
                assets: vec![],
                max_per_tx: 40,
                may_delegate: true,
            },
            U128(40),
            None,
        );
        context(carol(), 20);
        let grandchild = contract.delegate(
            child,
            "dave.near".parse().unwrap(),
            Permissions {
                recipients: vec!["vendor.near".parse().unwrap()],
                assets: vec![],
                max_per_tx: 20,
                may_delegate: false,
            },
            U128(20),
            None,
        );

        // owner revokes root → child and grandchild transitively invalidated
        context(owner(), 0);
        contract.revoke(root);

        assert!(!contract.get_node(root).unwrap().active);
        assert!(!contract.get_node(child).unwrap().active);
        assert!(!contract.get_node(grandchild).unwrap().active);
        assert_eq!(contract.list_revocations().len(), 3);
    }

    #[test]
    fn commitment_isolation_coordinator_cannot_spend_promised_funds() {
        // VECT demo moment: OWNER 1.0 → coordinator reserves 0.60 (Research) + 0.20 (Verifier)
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());

        // coordinator delegates 60 to research and 20 to verifier; keeps 20 available
        context(bob(), 60);
        let research = contract.delegate(
            root,
            carol(),
            Permissions {
                recipients: vec!["research-vendor.near".parse().unwrap()],
                assets: vec![],
                max_per_tx: 60,
                may_delegate: false,
            },
            U128(60),
            None,
        );
        context(bob(), 20);
        let verifier = contract.delegate(
            root,
            "dave.near".parse().unwrap(),
            Permissions {
                recipients: vec!["verify-vendor.near".parse().unwrap()],
                assets: vec![],
                max_per_tx: 20,
                may_delegate: false,
            },
            U128(20),
            None,
        );
        let root_node = contract.get_node(root).unwrap();
        assert_eq!(root_node.committed_to_children, 80);
        assert_eq!(contract.get_available(root), U128(20));

        // coordinator tries to spend 80 (more than its uncommitted 20) → REJECTED
        context(bob(), 80);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.spend(
                root,
                "vendor.near".parse().unwrap(),
                U128(80),
                None,
            )
        }));
        assert!(result.is_err());

        // root's spent counter unchanged, no execution recorded as settled
        let root_node = contract.get_node(root).unwrap();
        assert_eq!(root_node.spent, 0);
        assert_eq!(contract.list_executions().len(), 0);

        // research can spend within its own 60
        context(carol(), 30);
        let id = contract.spend(
            research,
            "research-vendor.near".parse().unwrap(),
            U128(30),
            None,
        );
        assert!(id > 0);
        assert_eq!(contract.get_available(research), U128(30));
    }

    #[test]
    fn revoked_node_spend_is_rejected() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());
        context(bob(), 40);
        let child = contract.delegate(
            root,
            carol(),
            Permissions {
                recipients: vec!["vendor.near".parse().unwrap()],
                assets: vec![],
                max_per_tx: 40,
                may_delegate: false,
            },
            U128(40),
            None,
        );
        // owner revokes the child
        context(owner(), 0);
        contract.revoke(child);

        // child holder tries to spend → REJECTED (branch revoked)
        context(carol(), 10);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.spend(
                child,
                "vendor.near".parse().unwrap(),
                U128(10),
                None,
            )
        }));
        assert!(result.is_err());
        assert_eq!(contract.get_node(child).unwrap().spent, 0);
    }
}
