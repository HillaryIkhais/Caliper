use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, UnorderedMap, UnorderedSet};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, near, AccountId, NearToken, Promise};

pub type Balance = u128;
pub type AuthorityId = u64;
pub type ExecutionId = u64;
pub type JobId = u64;

/// Version string included in every attestation canonical message.
pub const ATTESTATION_VERSION: &str = "caliper-attestation-v2";
/// The demonstration allows the initial attempt plus one correction.
pub const MAX_JOB_ATTEMPTS: u32 = 2;
/// A submitted job may be cancelled by the coordinator only after this many
/// blocks without a verification result. This stops a stalled verifier from
/// locking the escrowed budget forever without letting the coordinator cancel
/// prompt verification.
pub const VERIFICATION_TIMEOUT_BLOCKS: u64 = 1_000;


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
    /// Block height when this node was created.
    pub created_at: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Permissions {
    /// Allowed recipient accounts (deny-by-default empty = nothing).
    pub recipients: Vec<AccountId>,
    /// Reserved for future token support. Only native NEAR is payable today;
    /// `spend` rejects any non-`None` asset rather than silently transferring NEAR.
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

/// Status of a subcontracting job.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub enum JobStatus {
    /// Job created, waiting for worker to submit a deliverable.
    Open,
    /// Worker submitted a deliverable, awaiting independent verification.
    Submitted,
    /// Verification passed. Payment is now owed and any account may release it.
    Verified,
    /// The coordinator approved payment and the transfer is in flight.
    PaymentPending,
    /// The transfer callback confirmed success. This is the only paid state.
    Paid,
    /// The transfer callback reported failure. The budget remains reserved.
    PaymentFailed,
    /// Verification failed, but the worker still has a correction attempt.
    Rejected,
    /// All attempts failed. The remaining budget commitment was released.
    Exhausted,
    /// Job cancelled before settlement.
    Cancelled,
}

/// Canonical verifier attestation. The signature is over the canonical message
/// defined by `canonical_attestation_message`.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct VerificationAttestation {
    /// Must equal `ATTESTATION_VERSION`.
    pub version: String,
    pub job_id: JobId,
    pub attempt: u32,
    pub deliverable_hash: String,
    pub acceptance_criteria_hash: String,
    pub baseline_commit: String,
    pub acceptance_suite_hash: String,
    /// SHA-256 of the actual diff computed by the independent runner.
    pub diff_hash: String,
    /// True only when the on-disk artifact hashed by the verifier equals the
    /// deliverable hash the worker submitted. A hash mismatch is a failed
    /// verification, not an unrecordable attestation.
    pub deliverable_matches_claim: bool,
    /// True only when no protected file was changed or deleted.
    pub protected_files_clean: bool,
    /// Exit code of the pinned acceptance suite.
    pub test_exit_code: i32,
    /// Exit code of the pinned CI check.
    pub ci_exit_code: i32,
    pub runner_version: String,
    /// Must equal `deliverable_matches_claim && protected_files_clean &&
    /// test_exit_code == 0 && ci_exit_code == 0`.
    pub passed: bool,
    /// `sha256:<hex>` digest of the canonical attestation body.
    pub report_digest: String,
    /// Ed25519 public key, hex encoded. Must equal the key pinned at job creation.
    pub verifier_public_key: String,
    /// Ed25519 signature over `canonical_attestation_message`, hex encoded.
    pub signature: String,
}

/// Stored verification evidence, including the original signed attestation.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct VerificationRecord {
    pub attestation: VerificationAttestation,
    pub recorded_at: u64,
}

/// A subcontracting job: a unit of work delegated from a coordinator to a worker,
/// with pinned acceptance criteria and an artifact-bound verification outcome.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Job {
    pub id: JobId,
    /// The coordinator node that created and funds this job.
    pub coordinator_node: AuthorityId,
    /// The worker node assigned to do the work.
    pub worker_node: AuthorityId,
    /// The verifier node authorized to attest to this job.
    pub verifier_node: AuthorityId,
    /// Pinned account holders. Role separation is checked against these as well as nodes.
    pub coordinator_holder: AccountId,
    pub worker_holder: AccountId,
    pub verifier_holder: AccountId,
    /// Ed25519 public key pinned before work begins.
    pub verifier_public_key: String,
    /// Maximum budget escrowed for this job (yoctoNEAR). The coordinator commits
    /// this amount at creation. On settlement, the unused remainder returns to
    /// the coordinator's available allocation.
    pub budget: Balance,
    /// Exact amount paid to the worker on success: the agreed winning bid
    /// (yoctoNEAR). Pinned at creation and paid verbatim by the contract.
    pub winning_bid: Balance,
    /// Hash of the acceptance criteria document fixed before work began.
    pub acceptance_criteria_hash: String,
    /// Hash of the complete pinned acceptance policy, including the suite, commands,
    /// protected paths, and criteria. Produced and rechecked by the independent runner.
    pub acceptance_suite_hash: String,
    /// Baseline commit the artifact is diffed against.
    pub baseline_commit: String,
    /// Hash of the coordinator-supplied deterministic market transcript.
    /// The contract records this hash but does not validate the auction.
    pub market_transcript_hash: String,
    /// Protected paths the worker must not modify. Supports exact paths and `prefix/**`.
    pub protected_files: Vec<String>,
    /// Hash of the current submitted deliverable artifact.
    pub deliverable_hash: Option<String>,
    /// Current attempt number (1-based once submitted).
    pub attempt: u32,
    /// Maximum attempts allowed for this job.
    pub max_attempts: u32,
    /// Diff hash computed by the independent verifier, never by the worker.
    pub modified_files_hash: Option<String>,
    /// True when protected files were modified, deleted, or weakened.
    pub tampering_detected: bool,
    /// Digest of the signed verifier report.
    pub independent_report_hash: Option<String>,
    /// Result of the independent verification run for the current attempt.
    pub independent_passed: Option<bool>,
    /// Whether the on-disk artifact matched the worker's claimed hash.
    pub deliverable_matches_claim: Option<bool>,
    /// Exit code of the pinned acceptance suite for the current attempt.
    pub test_exit_code: Option<i32>,
    /// Exit code of the pinned CI check for the current attempt.
    pub ci_exit_code: Option<i32>,
    /// Full signed evidence for the current attempt.
    pub verification: Option<VerificationRecord>,
    /// Current job status.
    pub status: JobStatus,
    /// Error text from the payment callback, if the transfer failed.
    pub payment_error: Option<String>,
    /// Block height when the job was created.
    pub created_at: u64,
    /// Block height when the current deliverable was submitted.
    pub submitted_at: Option<u64>,
    /// Block height when the current attempt was verified.
    pub verified_at: Option<u64>,
    /// Block height when the job reached a terminal state.
    pub resolved_at: Option<u64>,
    /// Block height when payment was confirmed.
    pub paid_at: Option<u64>,
}

/// Canonical body is identical in Rust and TypeScript. Do not change field order
/// without bumping `ATTESTATION_VERSION`.
pub fn canonical_attestation_body(attestation: &VerificationAttestation) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        attestation.version,
        attestation.job_id,
        attestation.attempt,
        attestation.deliverable_hash,
        attestation.acceptance_criteria_hash,
        attestation.baseline_commit,
        attestation.acceptance_suite_hash,
        attestation.diff_hash,
        if attestation.deliverable_matches_claim { "1" } else { "0" },
        if attestation.protected_files_clean { "1" } else { "0" },
        attestation.test_exit_code,
        attestation.ci_exit_code,
        attestation.runner_version,
        if attestation.passed { "1" } else { "0" },
    )
}

pub fn canonical_report_digest(body: &str) -> String {
    format!("sha256:{}", hex::encode(env::sha256(body.as_bytes())))
}

pub fn canonical_attestation_message(attestation: &VerificationAttestation) -> String {
    format!(
        "{}|{}|{}",
        canonical_attestation_body(attestation),
        attestation.report_digest,
        attestation.verifier_public_key,
    )
}

fn decode_hex_array<const N: usize>(value: &str, label: &str) -> [u8; N] {
    let bytes = hex::decode(value).unwrap_or_else(|_| panic!("{} must be valid hex", label));
    bytes
        .try_into()
        .unwrap_or_else(|_| panic!("{} must be {} bytes", label, N))
}

#[near(contract_state)]
pub struct Contract {
    next_authority_id: AuthorityId,
    next_execution_id: ExecutionId,
    next_job_id: JobId,
    nodes: LookupMap<AuthorityId, Node>,
    holders: LookupMap<AccountId, UnorderedSet<AuthorityId>>,
    executions: UnorderedMap<ExecutionId, Execution>,
    revocations: UnorderedMap<AuthorityId, Revocation>,
    jobs: UnorderedMap<JobId, Job>,
    total_allocated: Balance,
    owner: AccountId,
    root: Option<AuthorityId>,
}

impl Default for Contract {
    fn default() -> Self {
        Self {
            next_authority_id: 0,
            next_execution_id: 0,
            next_job_id: 0,
            nodes: LookupMap::new(b"n"),
            holders: LookupMap::new(b"h"),
            executions: UnorderedMap::new(b"e"),
            revocations: UnorderedMap::new(b"r"),
            jobs: UnorderedMap::new(b"j"),
            total_allocated: 0,
            owner: "owner.near".parse().unwrap(),
            root: None,
        }
    }
}

impl Contract {
    #[cfg(test)]
    fn new_for_test() -> Self {
        Self {
            next_authority_id: 1,
            next_execution_id: 1,
            next_job_id: 1,
            nodes: LookupMap::new(b"n"),
            holders: LookupMap::new(b"h"),
            executions: UnorderedMap::new(b"e"),
            revocations: UnorderedMap::new(b"r"),
            jobs: UnorderedMap::new(b"j"),
            total_allocated: 0,
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

    fn descendants(&self, id: AuthorityId) -> Vec<AuthorityId> {
        let mut out = Vec::new();
        let mut stack = self.node(id).children.clone();
        while let Some(child) = stack.pop() {
            out.push(child);
            stack.extend(self.node(child).children.iter().copied());
        }
        out
    }

    /// Nearest ancestor that can still exercise authority. Used to return a
    /// failed pending payout to a live branch after the spending node was revoked.
    fn nearest_valid_ancestor(&self, id: AuthorityId, block_height: u64) -> Option<AuthorityId> {
        let mut current = self.node(id).parent;
        while let Some(candidate) = current {
            if self.is_authority_valid(candidate, block_height) {
                return Some(candidate);
            }
            current = self.node(candidate).parent;
        }
        None
    }

    fn is_descendant_of(&self, id: AuthorityId, ancestor: AuthorityId) -> bool {
        if id == ancestor {
            return true;
        }
        let mut current = self.node(id).parent;
        while let Some(p) = current {
            if p == ancestor {
                return true;
            }
            current = self.node(p).parent;
        }
        false
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

    fn check_attenuation(parent: &Node, child: &Node) {
        for r in &child.permissions.recipients {
            assert!(
                parent.permissions.recipients.contains(r),
                "child recipient not in parent's permissions"
            );
        }
        for a in &child.permissions.assets {
            assert!(
                parent.permissions.assets.contains(a),
                "child asset not in parent's permissions"
            );
        }
        assert!(
            child.permissions.max_per_tx <= parent.permissions.max_per_tx,
            "child max_per_tx exceeds parent's"
        );
        assert!(
            !child.permissions.may_delegate || parent.permissions.may_delegate,
            "child may_delegate exceeds parent's"
        );
    }

    fn add_holder(&mut self, holder: &AccountId, id: AuthorityId) {
        let mut set = self
            .holders
            .get(holder)
            .unwrap_or_else(|| UnorderedSet::new(format!("h{}", id).as_bytes()));
        set.insert(&id);
        self.holders.insert(holder, &set);
    }

    /// Revalidate every role participating in a job. Revoked or expired roles are
    /// blocked even if they were valid when the job was created.
    fn assert_job_roles_valid(&self, job: &Job, block_height: u64) {
        assert!(
            self.is_authority_valid(job.coordinator_node, block_height),
            "coordinator authority is revoked or expired"
        );
        assert!(
            self.is_authority_valid(job.worker_node, block_height),
            "worker authority is revoked or expired"
        );
        assert!(
            self.is_authority_valid(job.verifier_node, block_height),
            "verifier authority is revoked or expired"
        );
        assert_eq!(
            self.node(job.coordinator_node).holder,
            job.coordinator_holder,
            "coordinator holder changed"
        );
        assert_eq!(
            self.node(job.worker_node).holder,
            job.worker_holder,
            "worker holder changed"
        );
        assert_eq!(
            self.node(job.verifier_node).holder,
            job.verifier_holder,
            "verifier holder changed"
        );
    }

    /// Clear every piece of evidence that could otherwise survive into a new artifact.
    fn clear_verification(job: &mut Job) {
        job.modified_files_hash = None;
        job.tampering_detected = false;
        job.independent_report_hash = None;
        job.independent_passed = None;
        job.deliverable_matches_claim = None;
        job.test_exit_code = None;
        job.ci_exit_code = None;
        job.verification = None;
        job.verified_at = None;
    }

    fn release_job_commitment(&mut self, job: &Job) {
        let mut coordinator = self.node(job.coordinator_node);
        coordinator.committed_to_children = coordinator
            .committed_to_children
            .checked_sub(job.budget)
            .expect("job commitment underflow");
        self.set_node(job.coordinator_node, coordinator);
    }

    fn verify_attestation_signature(job: &Job, attestation: &VerificationAttestation) {
        assert_eq!(
            attestation.version, ATTESTATION_VERSION,
            "unsupported attestation version"
        );
        assert_eq!(
            attestation.verifier_public_key, job.verifier_public_key,
            "attestation uses a different verifier key"
        );
        let body = canonical_attestation_body(attestation);
        assert_eq!(
            attestation.report_digest,
            canonical_report_digest(&body),
            "report digest does not match attestation body"
        );
        let message = canonical_attestation_message(attestation);
        let signature: [u8; 64] = decode_hex_array(&attestation.signature, "signature");
        let public_key: [u8; 32] =
            decode_hex_array(&attestation.verifier_public_key, "verifier public key");
        assert!(
            env::ed25519_verify(&signature, message.as_bytes(), &public_key),
            "invalid verifier signature"
        );
    }
}

#[near]
impl Contract {
    #[init]
    pub fn init(owner: AccountId) -> Self {
        Self {
            next_authority_id: 1,
            next_execution_id: 1,
            next_job_id: 1,
            nodes: LookupMap::new(b"n"),
            holders: LookupMap::new(b"h"),
            executions: UnorderedMap::new(b"e"),
            revocations: UnorderedMap::new(b"r"),
            jobs: UnorderedMap::new(b"j"),
            total_allocated: 0,
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
        let block_height = env::block_height();
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
            created_at: block_height,
        };
        self.nodes.insert(&id, &node);
        self.add_holder(&holder, id);
        self.total_allocated += amount;
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
            created_at: block_height,
        };
        Self::check_attenuation(&parent, &child_node);

        self.nodes.insert(&id, &child_node);
        self.add_holder(&holder, id);

        let mut parent = parent;
        parent.committed_to_children = parent
            .committed_to_children
            .checked_add(amount)
            .expect("overflow");
        parent.children.push(id);
        self.set_node(parent_id, parent);
        self.total_allocated += amount;

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
        assert!(
            node.permissions.recipients.contains(&recipient),
            "recipient not allowed"
        );
        assert!(
            asset.is_none(),
            "only native NEAR is supported; token transfers are not implemented"
        );

        let id = self.next_execution_id;
        self.next_execution_id += 1;

        let execution = Execution {
            id,
            node_id,
            recipient: recipient.clone(),
            amount,
            asset,
            block_height,
            status: ExecutionStatus::Pending,
        };
        self.executions.insert(&id, &execution);

        let mut node = node;
        node.spent = node.spent.checked_add(amount).expect("overflow");
        self.set_node(node_id, node);

        Promise::new(recipient)
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).on_payout(id, amount))
            .detach();

        id
    }

    /// Private callback invoked after a spend's transfer promise resolves.
    /// Success marks the execution Settled. Failure releases the spent budget.
    #[private]
    pub fn on_payout(&mut self, execution_id: ExecutionId, amount: Balance) {
        let mut execution = self
            .executions
            .get(&execution_id)
            .expect("execution not found");

        // Idempotent: a duplicate callback must not release or settle twice.
        if !matches!(execution.status, ExecutionStatus::Pending) {
            return;
        }

        match env::promise_result_checked(0, 0) {
            Ok(_) => {
                execution.status = ExecutionStatus::Settled;
            }
            Err(_) => {
                execution.status = ExecutionStatus::Rejected;
                let mut node = self.node(execution.node_id);
                node.spent = node.spent.checked_sub(amount).expect("spent underflow");
                let revoked = !node.active;
                self.set_node(execution.node_id, node);

                // Revocation rolls the branch's spent budget into the parent. If a
                // pending payout later fails, the refund must land in a live node
                // too, otherwise the parent would permanently lose that budget.
                if revoked {
                    if let Some(ancestor_id) =
                        self.nearest_valid_ancestor(execution.node_id, env::block_height())
                    {
                        let mut ancestor = self.node(ancestor_id);
                        ancestor.spent = ancestor
                            .spent
                            .checked_sub(amount)
                            .expect("ancestor spent underflow");
                        self.set_node(ancestor_id, ancestor);
                    }
                }
            }
        }
        self.executions.insert(&execution_id, &execution);
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
                    .skip(1)
                    .any(|n| &caller == &n.holder),
            "only the owner or an ancestor's holder may revoke"
        );

        let descendants = self.descendants(node_id);
        let mut to_revoke = vec![node_id];
        to_revoke.extend(descendants);

        // Revocation must not destroy a payment obligation or sabotage an
        // in-flight verification. A verified payment depends only on the
        // coordinator branch staying live; a submitted job needs all three roles
        // to reach a verdict. The timeout in `cancel_job` is the escape hatch for
        // a verifier that never answers.
        for job in self.jobs.values() {
            let coordinator_hit = to_revoke.contains(&job.coordinator_node);
            let role_hit = to_revoke.contains(&job.worker_node)
                || to_revoke.contains(&job.verifier_node);
            if matches!(
                job.status,
                JobStatus::Verified | JobStatus::PaymentPending | JobStatus::PaymentFailed
            ) && coordinator_hit
            {
                panic!("cannot revoke a branch with an outstanding verified payment");
            }
            if matches!(job.status, JobStatus::Submitted) && (coordinator_hit || role_hit) {
                panic!("cannot revoke a branch with a job awaiting verification");
            }
        }

        // Funds already spent anywhere in the branch were paid out, so they cannot
        // be reissued when the branch is revoked. Roll them up into the parent as
        // spent while releasing only the unspent remainder of the commitment.
        // Pending spends are included here and refunded by `on_payout` if they fail.
        let branch_spent = to_revoke
            .iter()
            .map(|id| self.node(*id).spent)
            .fold(0u128, |acc, spent| acc.checked_add(spent).expect("overflow"));
        let node_allocation = self.node(node_id).allocation;
        assert!(
            branch_spent <= node_allocation,
            "branch spend exceeds revoked allocation"
        );

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

        if let Some(parent_id) = self.node(node_id).parent {
            let mut parent = self.node(parent_id).clone();
            parent.committed_to_children = parent
                .committed_to_children
                .checked_sub(node_allocation)
                .expect("commitment underflow");
            parent.spent = parent
                .spent
                .checked_add(branch_spent)
                .expect("overflow");
            parent.children.retain(|&c| c != node_id);
            self.set_node(parent_id, parent);
        }
    }

    /// Create a subcontracting job. The coordinator allocates budget from its
    /// uncommitted authority and assigns a distinct worker and verifier.
    /// All acceptance evidence is pinned here, before work begins.
    pub fn create_job(
        &mut self,
        coordinator_node: AuthorityId,
        worker_node: AuthorityId,
        verifier_node: AuthorityId,
        verifier_public_key: String,
        budget: U128,
        winning_bid: U128,
        acceptance_criteria_hash: String,
        acceptance_suite_hash: String,
        baseline_commit: String,
        market_transcript_hash: String,
        protected_files: Vec<String>,
    ) -> JobId {
        let caller = env::predecessor_account_id();
        let block_height = env::block_height();
        let amount: Balance = budget.into();
        let bid: Balance = winning_bid.into();

        let coordinator = self.node(coordinator_node).clone();
        let worker = self.node(worker_node).clone();
        let verifier = self.node(verifier_node).clone();

        assert_eq!(
            &caller, &coordinator.holder,
            "only the coordinator's holder may create jobs"
        );
        assert!(
            self.is_authority_valid(coordinator_node, block_height),
            "coordinator authority is revoked or expired"
        );
        assert!(
            self.is_authority_valid(worker_node, block_height),
            "worker authority is revoked or expired"
        );
        assert!(
            self.is_authority_valid(verifier_node, block_height),
            "verifier authority is revoked or expired"
        );

        // Nodes must be distinct.
        assert_ne!(coordinator_node, worker_node, "coordinator and worker must be distinct");
        assert_ne!(coordinator_node, verifier_node, "coordinator and verifier must be distinct");
        assert_ne!(worker_node, verifier_node, "worker and verifier must be distinct");

        // Distinct node IDs under the same account holder are not independent.
        assert_ne!(
            coordinator.holder, worker.holder,
            "coordinator and worker must be different accounts"
        );
        assert_ne!(
            coordinator.holder, verifier.holder,
            "coordinator and verifier must be different accounts"
        );
        assert_ne!(
            worker.holder, verifier.holder,
            "worker and verifier must be different accounts"
        );

        // Worker and verifier must hold authority beneath the coordinator's branch.
        assert!(
            self.is_descendant_of(worker_node, coordinator_node),
            "worker must be a descendant of the coordinator"
        );
        assert!(
            self.is_descendant_of(verifier_node, coordinator_node),
            "verifier must be a descendant of the coordinator"
        );

        assert!(!acceptance_criteria_hash.is_empty(), "acceptance criteria hash required");
        assert!(!acceptance_suite_hash.is_empty(), "acceptance-policy hash required");
        assert!(!baseline_commit.is_empty(), "baseline commit required");
        assert!(!market_transcript_hash.is_empty(), "market transcript hash required");
        assert!(amount > 0, "budget must be positive");
        assert!(
            amount <= self.available(coordinator_node),
            "job budget exceeds coordinator's uncommitted allocation"
        );
        assert!(bid > 0, "winning bid must be positive");
        assert!(bid <= amount, "winning bid exceeds the escrowed budget");

        let public_key: [u8; 32] =
            decode_hex_array(&verifier_public_key, "verifier public key");

        let id = self.next_job_id;
        self.next_job_id += 1;

        let job = Job {
            id,
            coordinator_node,
            worker_node,
            verifier_node,
            coordinator_holder: coordinator.holder.clone(),
            worker_holder: worker.holder.clone(),
            verifier_holder: verifier.holder.clone(),
            verifier_public_key: hex::encode(public_key),
            budget: amount,
            winning_bid: bid,
            acceptance_criteria_hash,
            acceptance_suite_hash,
            baseline_commit,
            market_transcript_hash,
            protected_files,
            deliverable_hash: None,
            attempt: 0,
            max_attempts: MAX_JOB_ATTEMPTS,
            modified_files_hash: None,
            tampering_detected: false,
            independent_report_hash: None,
            independent_passed: None,
            deliverable_matches_claim: None,
            test_exit_code: None,
            ci_exit_code: None,
            verification: None,
            status: JobStatus::Open,
            payment_error: None,
            created_at: block_height,
            submitted_at: None,
            verified_at: None,
            resolved_at: None,
            paid_at: None,
        };
        self.jobs.insert(&id, &job);

        let mut coordinator = coordinator;
        coordinator.committed_to_children = coordinator
            .committed_to_children
            .checked_add(amount)
            .expect("overflow");
        self.set_node(coordinator_node, coordinator);

        id
    }

    /// Worker submits an artifact identity. The worker supplies only the artifact hash;
    /// the diff, protected-file result, and test outcome are produced by the verifier.
    /// Every submission increments the attempt and clears all prior evidence.
    pub fn submit_deliverable(&mut self, job_id: JobId, deliverable_hash: String) {
        let caller = env::predecessor_account_id();
        let block_height = env::block_height();

        let mut job = self.jobs.get(&job_id).expect("job not found");
        assert_eq!(caller, job.worker_holder, "only the worker may submit");
        self.assert_job_roles_valid(&job, block_height);
        assert!(
            matches!(job.status, JobStatus::Open),
            "job is not open for submission"
        );
        assert!(!deliverable_hash.is_empty(), "deliverable hash required");
        assert!(
            job.attempt < job.max_attempts,
            "retry limit exhausted"
        );

        job.attempt += 1;
        Self::clear_verification(&mut job);
        job.deliverable_hash = Some(deliverable_hash);
        job.submitted_at = Some(block_height);
        job.status = JobStatus::Submitted;
        job.resolved_at = None;
        job.payment_error = None;
        self.jobs.insert(&job_id, &job);
    }

    /// Record an artifact-bound, signed verification attestation. Only the designated
    /// verifier may call this. The attestation must match the current job, attempt,
    /// artifact, criteria, baseline, suite, and pinned key.
    pub fn record_independent_verification(
        &mut self,
        job_id: JobId,
        attestation: VerificationAttestation,
    ) {
        let caller = env::predecessor_account_id();
        let block_height = env::block_height();

        let mut job = self.jobs.get(&job_id).expect("job not found");
        assert_eq!(caller, job.verifier_holder, "only the designated verifier may attest");
        self.assert_job_roles_valid(&job, block_height);
        assert!(
            matches!(job.status, JobStatus::Submitted),
            "job is not in submitted state"
        );

        assert_eq!(attestation.job_id, job.id, "attestation is for a different job");
        assert_eq!(
            attestation.attempt, job.attempt,
            "attestation is for a different attempt"
        );
        assert_eq!(
            Some(attestation.deliverable_hash.clone()),
            job.deliverable_hash,
            "attestation is for a different deliverable"
        );
        assert_eq!(
            attestation.acceptance_criteria_hash, job.acceptance_criteria_hash,
            "attestation is for different acceptance criteria"
        );
        assert_eq!(
            attestation.baseline_commit, job.baseline_commit,
            "attestation is for a different baseline"
        );
        assert_eq!(
            attestation.acceptance_suite_hash, job.acceptance_suite_hash,
            "attestation is for a different acceptance suite"
        );
        assert!(!attestation.diff_hash.is_empty(), "diff hash required");
        assert_eq!(
            attestation.passed,
            attestation.deliverable_matches_claim
                && attestation.protected_files_clean
                && attestation.test_exit_code == 0
                && attestation.ci_exit_code == 0,
            "attestation outcome is inconsistent with its evidence"
        );

        Self::verify_attestation_signature(&job, &attestation);

        job.modified_files_hash = Some(attestation.diff_hash.clone());
        job.tampering_detected = !attestation.protected_files_clean;
        job.independent_report_hash = Some(attestation.report_digest.clone());
        job.independent_passed = Some(attestation.passed);
        job.deliverable_matches_claim = Some(attestation.deliverable_matches_claim);
        job.test_exit_code = Some(attestation.test_exit_code);
        job.ci_exit_code = Some(attestation.ci_exit_code);
        job.verified_at = Some(block_height);

        let record = VerificationRecord {
            attestation: attestation.clone(),
            recorded_at: block_height,
        };
        job.verification = Some(record);

        if attestation.passed {
            job.status = JobStatus::Verified;
            job.resolved_at = None;
        } else if job.attempt >= job.max_attempts {
            job.status = JobStatus::Exhausted;
            job.resolved_at = Some(block_height);
            let exhausted = job.clone();
            self.jobs.insert(&job_id, &job);
            self.release_job_commitment(&exhausted);
            return;
        } else {
            job.status = JobStatus::Rejected;
            job.resolved_at = Some(block_height);
        }

        self.jobs.insert(&job_id, &job);
    }

    /// The coordinator opens a controlled correction attempt after a failed verification.
    /// This clears the failed evidence and cannot be used after a successful verification.
    pub fn request_changes(&mut self, job_id: JobId) {
        let caller = env::predecessor_account_id();
        let block_height = env::block_height();

        let mut job = self.jobs.get(&job_id).expect("job not found");
        assert_eq!(caller, job.coordinator_holder, "only the coordinator may request changes");
        self.assert_job_roles_valid(&job, block_height);
        assert!(
            matches!(job.status, JobStatus::Rejected),
            "changes can only be requested after a failed verification"
        );
        assert!(
            job.attempt < job.max_attempts,
            "retry limit exhausted"
        );

        Self::clear_verification(&mut job);
        job.deliverable_hash = None;
        job.submitted_at = None;
        job.resolved_at = None;
        job.status = JobStatus::Open;
        self.jobs.insert(&job_id, &job);
    }

    /// Coordinator approves a verified job and initiates payment. The job enters
    /// PaymentPending; only the transfer callback can move it to Paid.
    pub fn accept_job(&mut self, job_id: JobId) {
        let caller = env::predecessor_account_id();
        let job = self.jobs.get(&job_id).expect("job not found");
        assert_eq!(caller, job.coordinator_holder, "only the coordinator may accept");
        self.initiate_verified_payment(job_id);
    }

    /// Release payment for a job that has already passed independent verification.
    /// Verification fixes the payment obligation, so this method is permissionless:
    /// the worker, the verifier, or any third party may call it. A coordinator can
    /// therefore neither cancel a Verified job nor withhold settlement indefinitely.
    pub fn release_verified_payment(&mut self, job_id: JobId) {
        self.initiate_verified_payment(job_id);
    }

    /// Shared settlement path. Only the coordinator's authority is revalidated:
    /// worker and verifier authority may have been revoked after verification
    /// without extinguishing the worker's right to be paid.
    fn initiate_verified_payment(&mut self, job_id: JobId) {
        let block_height = env::block_height();

        let mut job = self.jobs.get(&job_id).expect("job not found");
        assert!(
            matches!(job.status, JobStatus::Verified | JobStatus::PaymentFailed),
            "job is not verified or retryable"
        );
        assert!(
            job.independent_passed == Some(true),
            "job has not passed independent verification"
        );
        assert!(
            !job.tampering_detected,
            "tampering detected: worker modified protected files"
        );
        assert!(
            self.is_authority_valid(job.coordinator_node, block_height),
            "coordinator authority is revoked or expired"
        );

        let record = job
            .verification
            .as_ref()
            .expect("verified job has no attestation");
        assert_eq!(record.attestation.job_id, job.id, "stale attestation job");
        assert_eq!(record.attestation.attempt, job.attempt, "stale attestation attempt");
        assert_eq!(
            Some(record.attestation.deliverable_hash.clone()),
            job.deliverable_hash,
            "stale attestation deliverable"
        );
        assert_eq!(
            record.attestation.acceptance_criteria_hash, job.acceptance_criteria_hash,
            "stale attestation acceptance criteria"
        );
        assert_eq!(
            record.attestation.baseline_commit, job.baseline_commit,
            "stale attestation baseline"
        );
        assert_eq!(
            record.attestation.acceptance_suite_hash, job.acceptance_suite_hash,
            "stale attestation suite"
        );

        let amount = job.winning_bid;
        let worker_account = job.worker_holder.clone();

        job.status = JobStatus::PaymentPending;
        job.payment_error = None;
        self.jobs.insert(&job_id, &job);

        Promise::new(worker_account)
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).on_job_payment(job_id))
            .detach();
    }

    /// Private settlement callback. This is the only path that marks a job Paid.
    /// Duplicate callbacks are ignored, so a worker cannot be paid twice.
    #[private]
    pub fn on_job_payment(&mut self, job_id: JobId) {
        let mut job = self.jobs.get(&job_id).expect("job not found");
        if !matches!(job.status, JobStatus::PaymentPending) {
            return;
        }

        let block_height = env::block_height();
        match env::promise_result_checked(0, 0) {
            Ok(_) => {
                let mut coordinator = self.node(job.coordinator_node);
                coordinator.committed_to_children = coordinator
                    .committed_to_children
                    .checked_sub(job.budget)
                    .expect("job commitment underflow");
                // Only the winning bid is spent. The unused portion of the
                // escrowed budget stays available to the coordinator.
                coordinator.spent = coordinator
                    .spent
                    .checked_add(job.winning_bid)
                    .expect("overflow");
                self.set_node(job.coordinator_node, coordinator);

                job.status = JobStatus::Paid;
                job.payment_error = None;
                job.paid_at = Some(block_height);
                job.resolved_at = Some(block_height);
            }
            Err(_) => {
                // Keep the budget committed so it can be retried safely.
                job.status = JobStatus::PaymentFailed;
                job.payment_error = Some("NEAR transfer failed".to_string());
            }
        }
        self.jobs.insert(&job_id, &job);
    }

    /// Coordinator may cancel a job that has not passed verification. Committed
    /// budget is released. A Verified job is a fixed payment obligation and is
    /// deliberately not cancellable; use `release_verified_payment` instead.
    /// A Submitted job becomes cancellable only after `VERIFICATION_TIMEOUT_BLOCKS`
    /// so a stalled verifier cannot lock escrowed funds forever.
    pub fn cancel_job(&mut self, job_id: JobId) {
        let caller = env::predecessor_account_id();
        let block_height = env::block_height();

        let mut job = self.jobs.get(&job_id).expect("job not found");
        assert_eq!(caller, job.coordinator_holder, "only the coordinator may cancel");
        let cancellable = match job.status {
            JobStatus::Open | JobStatus::Rejected => true,
            JobStatus::Submitted => {
                block_height
                    >= job
                        .submitted_at
                        .unwrap_or(block_height)
                        .saturating_add(VERIFICATION_TIMEOUT_BLOCKS)
            }
            _ => false,
        };
        assert!(cancellable, "job cannot be cancelled in its current state");
        assert!(
            self.is_authority_valid(job.coordinator_node, block_height),
            "coordinator authority is revoked or expired"
        );

        job.status = JobStatus::Cancelled;
        job.resolved_at = Some(block_height);
        self.jobs.insert(&job_id, &job);
        let cancelled = job.clone();
        self.release_job_commitment(&cancelled);
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

    pub fn get_total_allocated(&self) -> U128 {
        U128(self.total_allocated)
    }

    pub fn get_job(&self, id: JobId) -> Option<Job> {
        self.jobs.get(&id)
    }

    pub fn get_job_verification(&self, id: JobId) -> Option<VerificationRecord> {
        self.jobs.get(&id).and_then(|job| job.verification)
    }

    pub fn list_jobs(&self) -> Vec<Job> {
        self.jobs.values().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{test_vm_config, PromiseResult, RuntimeFeesConfig};

    const UNIT: u128 = 1_000_000_000_000_000_000_000_000;
    const CALIPER: &str = "caliper.near";

    fn owner() -> AccountId {
        "owner.near".parse().unwrap()
    }
    fn bob() -> AccountId {
        "bob.near".parse().unwrap()
    }
    fn carol() -> AccountId {
        "carol.near".parse().unwrap()
    }
    fn dave() -> AccountId {
        "dave.near".parse().unwrap()
    }
    fn erin() -> AccountId {
        "erin.near".parse().unwrap()
    }

    fn root_permissions() -> Permissions {
        Permissions {
            recipients: vec![
                "vendor.near".parse().unwrap(),
                "research-vendor.near".parse().unwrap(),
                "verify-vendor.near".parse().unwrap(),
            ],
            assets: vec![],
            max_per_tx: 1_000 * UNIT,
            may_delegate: true,
        }
    }

    fn child_permissions(max: u128) -> Permissions {
        Permissions {
            recipients: vec!["vendor.near".parse().unwrap()],
            assets: vec![],
            max_per_tx: max,
            may_delegate: false,
        }
    }

    fn context(predecessor: AccountId, deposit: Balance) {
        near_sdk::testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id(predecessor)
                .current_account_id(CALIPER.parse().unwrap())
                .attached_deposit(NearToken::from_yoctonear(deposit))
                .build()
        );
    }

    fn context_with_promise(predecessor: AccountId, result: PromiseResult) {
        near_sdk::testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id(predecessor)
                .current_account_id(CALIPER.parse().unwrap())
                .build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            std::collections::HashMap::default(),
            vec![result],
        );
    }

    fn verifier_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn public_key_hex(key: &SigningKey) -> String {
        hex::encode(key.verifying_key().to_bytes())
    }

    struct JobFixture {
        contract: Contract,
        root: AuthorityId,
        worker: AuthorityId,
        verifier: AuthorityId,
        job: JobId,
        key: SigningKey,
    }

    fn setup_job() -> JobFixture {
        let key = verifier_key(7);
        let mut contract = Contract::new_for_test();
        context(owner(), 10_000 * UNIT);
        let root = contract.create_root(bob(), U128(10_000 * UNIT), root_permissions());

        context(bob(), 0);
        let worker = contract.delegate(root, carol(), child_permissions(100 * UNIT), U128(100 * UNIT), None);
        context(bob(), 0);
        let verifier = contract.delegate(root, dave(), child_permissions(50 * UNIT), U128(50 * UNIT), None);

        context(bob(), 0);
        let job = contract.create_job(
            root,
            worker,
            verifier,
            public_key_hex(&key),
            U128(20 * UNIT),
            U128(12 * UNIT),
            "sha256:acceptance-criteria-v1".to_string(),
            "sha256:suite-v1".to_string(),
            "commit-baseline-abc123".to_string(),
            "sha256:market-transcript-v1".to_string(),
            vec!["tests/**".to_string(), "ci/**".to_string()],
        );

        JobFixture {
            contract,
            root,
            worker,
            verifier,
            job,
            key,
        }
    }

    fn make_attestation_full(
        contract: &Contract,
        job_id: JobId,
        key: &SigningKey,
        attempt: u32,
        deliverable_hash: &str,
        deliverable_matches_claim: bool,
        clean: bool,
        test_exit_code: i32,
        ci_exit_code: i32,
        passed: bool,
    ) -> VerificationAttestation {
        let job = contract.get_job(job_id).unwrap();
        let mut attestation = VerificationAttestation {
            version: ATTESTATION_VERSION.to_string(),
            job_id,
            attempt,
            deliverable_hash: deliverable_hash.to_string(),
            acceptance_criteria_hash: job.acceptance_criteria_hash.clone(),
            baseline_commit: job.baseline_commit.clone(),
            acceptance_suite_hash: job.acceptance_suite_hash.clone(),
            diff_hash: "sha256:diff-v1".to_string(),
            deliverable_matches_claim,
            protected_files_clean: clean,
            test_exit_code,
            ci_exit_code,
            runner_version: "caliper-runner-v1".to_string(),
            passed,
            report_digest: String::new(),
            verifier_public_key: public_key_hex(key),
            signature: String::new(),
        };
        let body = canonical_attestation_body(&attestation);
        attestation.report_digest = canonical_report_digest(&body);
        let message = canonical_attestation_message(&attestation);
        attestation.signature = hex::encode(key.sign(message.as_bytes()).to_bytes());
        attestation
    }

    fn make_attestation(
        contract: &Contract,
        job_id: JobId,
        key: &SigningKey,
        attempt: u32,
        deliverable_hash: &str,
        clean: bool,
        exit_code: i32,
        passed: bool,
    ) -> VerificationAttestation {
        make_attestation_full(
            contract,
            job_id,
            key,
            attempt,
            deliverable_hash,
            true,
            clean,
            exit_code,
            exit_code,
            passed,
        )
    }

    fn submit_and_verify_pass(f: &mut JobFixture, deliverable: &str) {
        context(carol(), 0);
        f.contract.submit_deliverable(f.job, deliverable.to_string());
        let attempt = f.contract.get_job(f.job).unwrap().attempt;
        let attestation = make_attestation(
            &f.contract,
            f.job,
            &f.key,
            attempt,
            deliverable,
            true,
            0,
            true,
        );
        context(dave(), 0);
        f.contract.record_independent_verification(f.job, attestation);
    }

    // ---------- preserved authority tests ----------

    #[test]
    fn create_root_and_delegate() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100 * UNIT);
        let root = contract.create_root(bob(), U128(100 * UNIT), root_permissions());
        let node = contract.get_node(root).unwrap();
        assert_eq!(node.allocation, 100 * UNIT);
        assert!(node.active);

        context(bob(), 0);
        let child = contract.delegate(root, carol(), child_permissions(40 * UNIT), U128(40 * UNIT), None);
        assert_eq!(contract.get_node(root).unwrap().committed_to_children, 40 * UNIT);
        assert_eq!(contract.get_available(root), U128(60 * UNIT));
        assert_eq!(contract.get_node(child).unwrap().parent, Some(root));
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
        context(bob(), 0);
        let child = contract.delegate(root, carol(), child_permissions(40), U128(40), None);
        context(carol(), 0);
        let id = contract.spend(child, "vendor.near".parse().unwrap(), U128(30), None);
        assert!(id > 0);
        assert_eq!(contract.get_node(child).unwrap().spent, 30);
        assert_eq!(contract.get_available(child), U128(10));
    }

    #[test]
    #[should_panic(expected = "only native NEAR is supported")]
    fn spend_with_token_asset_rejected() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());
        context(bob(), 0);
        contract.spend(
            root,
            "vendor.near".parse().unwrap(),
            U128(10),
            Some("usdc.near".parse().unwrap()),
        );
    }

    #[test]
    #[should_panic(expected = "recipient not allowed")]
    fn spend_to_unauthorized_recipient_rejected() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());
        context(bob(), 0);
        let _ = contract.spend(root, "anyone.near".parse().unwrap(), U128(10), None);
    }

    #[test]
    fn delegate_attenuation_enforced() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());
        context(bob(), 0);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.delegate(
                root,
                carol(),
                Permissions {
                    recipients: vec![],
                    assets: vec![],
                    max_per_tx: 2_000 * UNIT,
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
        context(bob(), 0);
        let child = contract.delegate(root, carol(), child_permissions(40), U128(40), None);
        assert_eq!(contract.get_node(root).unwrap().committed_to_children, 40);

        context(bob(), 0);
        contract.revoke(child);

        assert!(!contract.get_node(child).unwrap().active);
        assert_eq!(contract.get_node(root).unwrap().committed_to_children, 0);
        assert_eq!(contract.get_node(root).unwrap().children.len(), 0);
    }

    #[test]
    fn revoke_root_invalidates_whole_branch_transitively() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());
        context(bob(), 0);
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
        context(carol(), 0);
        let grandchild = contract.delegate(child, dave(), child_permissions(20), U128(20), None);

        context(owner(), 0);
        contract.revoke(root);

        assert!(!contract.get_node(root).unwrap().active);
        assert!(!contract.get_node(child).unwrap().active);
        assert!(!contract.get_node(grandchild).unwrap().active);
        assert_eq!(contract.list_revocations().len(), 3);
    }

    #[test]
    fn commitment_isolation_coordinator_cannot_spend_promised_funds() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());

        context(bob(), 0);
        let _research = contract.delegate(root, carol(), child_permissions(60), U128(60), None);
        context(bob(), 0);
        let _verifier = contract.delegate(root, dave(), child_permissions(20), U128(20), None);

        assert_eq!(contract.get_node(root).unwrap().committed_to_children, 80);
        assert_eq!(contract.get_available(root), U128(20));

        context(bob(), 0);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.spend(root, "vendor.near".parse().unwrap(), U128(80), None)
        }));
        assert!(result.is_err());
        assert_eq!(contract.get_node(root).unwrap().spent, 0);
        assert_eq!(contract.list_executions().len(), 0);
    }

    #[test]
    fn revoked_node_spend_is_rejected() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());
        context(bob(), 0);
        let child = contract.delegate(root, carol(), child_permissions(40), U128(40), None);
        context(owner(), 0);
        contract.revoke(child);

        context(carol(), 0);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.spend(child, "vendor.near".parse().unwrap(), U128(10), None)
        }));
        assert!(result.is_err());
        assert_eq!(contract.get_node(child).unwrap().spent, 0);
    }

    #[test]
    fn nested_revocation_releases_correct_commitments() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());

        context(bob(), 0);
        let coordinator = contract.delegate(
            root,
            carol(),
            Permissions {
                recipients: vec!["vendor.near".parse().unwrap()],
                assets: vec![],
                max_per_tx: 80,
                may_delegate: true,
            },
            U128(80),
            None,
        );
        context(carol(), 0);
        let research = contract.delegate(
            coordinator,
            dave(),
            Permissions {
                recipients: vec!["vendor.near".parse().unwrap()],
                assets: vec![],
                max_per_tx: 30,
                may_delegate: true,
            },
            U128(30),
            None,
        );
        context(dave(), 0);
        let sub = contract.delegate(research, erin(), child_permissions(10), U128(10), None);

        context(carol(), 0);
        contract.revoke(research);

        assert!(!contract.get_node(research).unwrap().active);
        assert!(!contract.get_node(sub).unwrap().active);
        assert_eq!(contract.get_node(coordinator).unwrap().committed_to_children, 0);
        assert_eq!(contract.get_node(root).unwrap().committed_to_children, 80);
    }

    #[test]
    fn revoke_child_after_settled_spend_does_not_reissue_it() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());
        context(bob(), 0);
        let child = contract.delegate(root, carol(), child_permissions(40), U128(40), None);

        context(carol(), 0);
        let execution = contract.spend(child, "vendor.near".parse().unwrap(), U128(30), None);
        context_with_promise(CALIPER.parse().unwrap(), PromiseResult::Successful(vec![]));
        contract.on_payout(execution, 30);
        assert_eq!(contract.get_node(child).unwrap().spent, 30);

        context(bob(), 0);
        contract.revoke(child);

        let root_node = contract.get_node(root).unwrap();
        assert_eq!(root_node.committed_to_children, 0);
        assert_eq!(root_node.spent, 30);
        assert_eq!(contract.get_available(root), U128(70));

        context(bob(), 0);
        let _ = contract.spend(root, "vendor.near".parse().unwrap(), U128(70), None);
        let overdraw = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.spend(root, "vendor.near".parse().unwrap(), U128(1), None)
        }));
        assert!(overdraw.is_err());
    }

    #[test]
    fn revocation_retains_pending_spend_until_failed_callback_refunds_it() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());
        context(bob(), 0);
        let child = contract.delegate(root, carol(), child_permissions(40), U128(40), None);

        context(carol(), 0);
        let execution = contract.spend(child, "vendor.near".parse().unwrap(), U128(30), None);
        context(bob(), 0);
        contract.revoke(child);

        let root_node = contract.get_node(root).unwrap();
        assert_eq!(root_node.committed_to_children, 0);
        assert_eq!(root_node.spent, 30);
        assert_eq!(contract.get_available(root), U128(70));

        context_with_promise(CALIPER.parse().unwrap(), PromiseResult::Failed);
        contract.on_payout(execution, 30);

        let root_node = contract.get_node(root).unwrap();
        assert_eq!(root_node.spent, 0);
        assert_eq!(contract.get_available(root), U128(100));
        assert!(matches!(
            contract.get_execution(execution).unwrap().status,
            ExecutionStatus::Rejected
        ));

        // Duplicate callbacks must not refund twice.
        context_with_promise(CALIPER.parse().unwrap(), PromiseResult::Failed);
        contract.on_payout(execution, 30);
        assert_eq!(contract.get_node(root).unwrap().spent, 0);
    }

    #[test]
    fn nested_revocation_rolls_up_spend_once() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());

        context(bob(), 0);
        let coordinator = contract.delegate(
            root,
            carol(),
            Permissions {
                recipients: vec!["vendor.near".parse().unwrap()],
                assets: vec![],
                max_per_tx: 60,
                may_delegate: true,
            },
            U128(60),
            None,
        );
        context(carol(), 0);
        let research = contract.delegate(
            coordinator,
            dave(),
            Permissions {
                recipients: vec!["vendor.near".parse().unwrap()],
                assets: vec![],
                max_per_tx: 30,
                may_delegate: true,
            },
            U128(30),
            None,
        );
        context(dave(), 0);
        let sub = contract.delegate(research, erin(), child_permissions(10), U128(10), None);

        context(erin(), 0);
        let _ = contract.spend(sub, "vendor.near".parse().unwrap(), U128(5), None);

        context(carol(), 0);
        contract.revoke(research);
        assert_eq!(contract.get_node(coordinator).unwrap().spent, 5);
        assert_eq!(contract.get_node(coordinator).unwrap().committed_to_children, 0);

        context(bob(), 0);
        contract.revoke(coordinator);
        let root_node = contract.get_node(root).unwrap();
        assert_eq!(root_node.spent, 5);
        assert_eq!(root_node.committed_to_children, 0);
        assert_eq!(contract.get_available(root), U128(95));
    }

    // ---------- role separation ----------

    #[test]
    #[should_panic(expected = "worker and verifier must be distinct")]
    fn same_worker_and_verifier_node_rejected() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());
        context(bob(), 0);
        let worker = contract.delegate(root, carol(), child_permissions(40), U128(40), None);
        let key = public_key_hex(&verifier_key(1));
        context(bob(), 0);
        contract.create_job(
            root,
            worker,
            worker,
            key,
            U128(10),
            U128(10),
            "criteria".to_string(),
            "suite".to_string(),
            "baseline".to_string(),
            "market".to_string(),
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "worker and verifier must be different accounts")]
    fn different_nodes_same_account_rejected() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());
        context(bob(), 0);
        let worker = contract.delegate(root, carol(), child_permissions(40), U128(40), None);
        context(bob(), 0);
        let verifier = contract.delegate(root, carol(), child_permissions(40), U128(40), None);
        let key = public_key_hex(&verifier_key(2));
        context(bob(), 0);
        contract.create_job(
            root,
            worker,
            verifier,
            key,
            U128(10),
            U128(10),
            "criteria".to_string(),
            "suite".to_string(),
            "baseline".to_string(),
            "market".to_string(),
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "coordinator and worker must be distinct")]
    fn coordinator_cannot_be_worker() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());
        context(bob(), 0);
        let verifier = contract.delegate(root, dave(), child_permissions(40), U128(40), None);
        let key = public_key_hex(&verifier_key(3));
        context(bob(), 0);
        contract.create_job(
            root,
            root,
            verifier,
            key,
            U128(10),
            U128(10),
            "criteria".to_string(),
            "suite".to_string(),
            "baseline".to_string(),
            "market".to_string(),
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "coordinator and verifier must be distinct")]
    fn coordinator_cannot_be_verifier() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());
        context(bob(), 0);
        let worker = contract.delegate(root, carol(), child_permissions(40), U128(40), None);
        let key = public_key_hex(&verifier_key(4));
        context(bob(), 0);
        contract.create_job(
            root,
            worker,
            root,
            key,
            U128(10),
            U128(10),
            "criteria".to_string(),
            "suite".to_string(),
            "baseline".to_string(),
            "market".to_string(),
            vec![],
        );
    }

    #[test]
    fn worker_cannot_supply_its_own_verification_evidence() {
        let mut f = setup_job();
        context(carol(), 0);
        f.contract.submit_deliverable(f.job, "sha256:artifact".to_string());
        let job = f.contract.get_job(f.job).unwrap();
        // Submission cannot set diff, tampering, or pass/fail fields.
        assert_eq!(job.modified_files_hash, None);
        assert!(!job.tampering_detected);
        assert_eq!(job.independent_passed, None);
        assert_eq!(job.test_exit_code, None);
        assert!(job.verification.is_none());
    }

    // ---------- authority revalidation ----------

    #[test]
    #[should_panic(expected = "worker authority is revoked or expired")]
    fn revoked_worker_cannot_submit() {
        let mut f = setup_job();
        context(owner(), 0);
        f.contract.revoke(f.worker);
        context(carol(), 0);
        f.contract.submit_deliverable(f.job, "sha256:artifact".to_string());
    }

    #[test]
    #[should_panic(expected = "cannot revoke a branch with a job awaiting verification")]
    fn revoked_verifier_cannot_attest() {
        let mut f = setup_job();
        context(carol(), 0);
        f.contract.submit_deliverable(f.job, "sha256:artifact".to_string());
        // Once a job is Submitted, revoking the verifier would sabotage
        // in-flight verification. The revocation itself is blocked; a revoked
        // verifier can therefore never record attestation for this job.
        context(owner(), 0);
        f.contract.revoke(f.verifier);
    }

    #[test]
    #[should_panic(expected = "cannot revoke a branch with an outstanding verified payment")]
    fn coordinator_with_verified_payment_cannot_be_revoked() {
        let mut f = setup_job();
        submit_and_verify_pass(&mut f, "sha256:artifact");
        context(owner(), 0);
        f.contract.revoke(f.root);
    }

    // ---------- attestation binding ----------

    #[test]
    #[should_panic(expected = "attestation is for a different deliverable")]
    fn wrong_artifact_hash_rejected() {
        let mut f = setup_job();
        context(carol(), 0);
        f.contract.submit_deliverable(f.job, "sha256:artifact".to_string());
        let attestation = make_attestation(
            &f.contract,
            f.job,
            &f.key,
            1,
            "sha256:different-artifact",
            true,
            0,
            true,
        );
        context(dave(), 0);
        f.contract.record_independent_verification(f.job, attestation);
    }

    #[test]
    #[should_panic(expected = "attestation is for different acceptance criteria")]
    fn wrong_acceptance_criteria_hash_rejected() {
        let mut f = setup_job();
        context(carol(), 0);
        f.contract.submit_deliverable(f.job, "sha256:artifact".to_string());
        let mut attestation = make_attestation(
            &f.contract,
            f.job,
            &f.key,
            1,
            "sha256:artifact",
            true,
            0,
            true,
        );
        attestation.acceptance_criteria_hash = "sha256:tampered-criteria".to_string();
        let body = canonical_attestation_body(&attestation);
        attestation.report_digest = canonical_report_digest(&body);
        let message = canonical_attestation_message(&attestation);
        attestation.signature = hex::encode(f.key.sign(message.as_bytes()).to_bytes());
        context(dave(), 0);
        f.contract.record_independent_verification(f.job, attestation);
    }

    #[test]
    #[should_panic(expected = "invalid verifier signature")]
    fn wrong_verifier_signature_rejected() {
        let mut f = setup_job();
        context(carol(), 0);
        f.contract.submit_deliverable(f.job, "sha256:artifact".to_string());
        let mut attestation = make_attestation(
            &f.contract,
            f.job,
            &f.key,
            1,
            "sha256:artifact",
            true,
            0,
            true,
        );
        attestation.signature = hex::encode([0u8; 64]);
        context(dave(), 0);
        f.contract.record_independent_verification(f.job, attestation);
    }

    #[test]
    #[should_panic(expected = "attestation is for a different attempt")]
    fn old_attempt_attestation_rejected() {
        let mut f = setup_job();
        context(carol(), 0);
        f.contract.submit_deliverable(f.job, "sha256:artifact".to_string());
        let attestation = make_attestation(
            &f.contract,
            f.job,
            &f.key,
            0,
            "sha256:artifact",
            true,
            0,
            true,
        );
        context(dave(), 0);
        f.contract.record_independent_verification(f.job, attestation);
    }

    #[test]
    #[should_panic(expected = "job is not open for submission")]
    fn old_success_cannot_authorize_new_submission() {
        let mut f = setup_job();
        submit_and_verify_pass(&mut f, "sha256:artifact");
        // A successful verification moves the job to Verified; it cannot be
        // reused to authorize a different artifact.
        context(carol(), 0);
        f.contract.submit_deliverable(f.job, "sha256:new-artifact".to_string());
    }

    #[test]
    #[should_panic(expected = "changes can only be requested after a failed verification")]
    fn request_changes_cannot_reopen_verified_job() {
        let mut f = setup_job();
        submit_and_verify_pass(&mut f, "sha256:artifact");
        context(bob(), 0);
        f.contract.request_changes(f.job);
    }

    // ---------- retry lifecycle ----------

    #[test]
    fn deliverable_hash_mismatch_is_recorded_as_rejected_not_unrecordable() {
        let mut f = setup_job();
        context(carol(), 0);
        f.contract.submit_deliverable(f.job, "sha256:claimed-artifact".to_string());

        // The verifier hashed the on-disk artifact and it did not match the worker's
        // claimed hash. Tests and protected files were clean, so the old v1
        // single-exit encoding would have produced an unrecordable attestation.
        let attestation = make_attestation_full(
            &f.contract,
            f.job,
            &f.key,
            1,
            "sha256:claimed-artifact",
            false,
            true,
            0,
            0,
            false,
        );
        context(dave(), 0);
        f.contract.record_independent_verification(f.job, attestation);

        let job = f.contract.get_job(f.job).unwrap();
        assert!(matches!(job.status, JobStatus::Rejected));
        assert_eq!(job.independent_passed, Some(false));
        assert_eq!(job.deliverable_matches_claim, Some(false));
        assert_eq!(job.test_exit_code, Some(0));
        assert_eq!(job.ci_exit_code, Some(0));
        assert!(!job.tampering_detected);

        let record = job.verification.unwrap();
        assert!(!record.attestation.deliverable_matches_claim);
        assert_eq!(record.attestation.test_exit_code, 0);
        assert_eq!(record.attestation.ci_exit_code, 0);
    }

    #[test]
    #[should_panic(expected = "attestation outcome is inconsistent with its evidence")]
    fn passed_attestation_requires_matching_deliverable_claim() {
        let mut f = setup_job();
        context(carol(), 0);
        f.contract.submit_deliverable(f.job, "sha256:artifact".to_string());
        let attestation = make_attestation_full(
            &f.contract,
            f.job,
            &f.key,
            1,
            "sha256:artifact",
            false,
            true,
            0,
            0,
            true,
        );
        context(dave(), 0);
        f.contract.record_independent_verification(f.job, attestation);
    }

    #[test]
    fn failed_verification_blocks_payment_and_allows_correction() {
        let mut f = setup_job();
        context(carol(), 0);
        f.contract.submit_deliverable(f.job, "sha256:bad-artifact".to_string());
        let attestation = make_attestation(
            &f.contract,
            f.job,
            &f.key,
            1,
            "sha256:bad-artifact",
            false,
            1,
            false,
        );
        context(dave(), 0);
        f.contract.record_independent_verification(f.job, attestation);

        let job = f.contract.get_job(f.job).unwrap();
        assert!(matches!(job.status, JobStatus::Rejected));
        assert!(job.tampering_detected);
        assert_eq!(job.independent_passed, Some(false));

        context(bob(), 0);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            f.contract.accept_job(f.job)
        }));
        assert!(result.is_err());

        context(bob(), 0);
        f.contract.request_changes(f.job);
        let job = f.contract.get_job(f.job).unwrap();
        assert!(matches!(job.status, JobStatus::Open));
        assert_eq!(job.independent_passed, None);
        assert!(!job.tampering_detected);
        assert!(job.verification.is_none());

        submit_and_verify_pass(&mut f, "sha256:good-artifact");
        let job = f.contract.get_job(f.job).unwrap();
        assert!(matches!(job.status, JobStatus::Verified));
        assert_eq!(job.attempt, 2);
        assert_eq!(job.independent_passed, Some(true));
    }

    #[test]
    fn retry_limit_enforced_and_commitment_released() {
        let mut f = setup_job();
        let committed_before = f.contract.get_node(f.root).unwrap().committed_to_children;

        context(carol(), 0);
        f.contract.submit_deliverable(f.job, "sha256:attempt-1".to_string());
        let bad1 = make_attestation(
            &f.contract,
            f.job,
            &f.key,
            1,
            "sha256:attempt-1",
            false,
            1,
            false,
        );
        context(dave(), 0);
        f.contract.record_independent_verification(f.job, bad1);
        assert!(matches!(f.contract.get_job(f.job).unwrap().status, JobStatus::Rejected));

        context(bob(), 0);
        f.contract.request_changes(f.job);
        context(carol(), 0);
        f.contract.submit_deliverable(f.job, "sha256:attempt-2".to_string());
        let bad2 = make_attestation(
            &f.contract,
            f.job,
            &f.key,
            2,
            "sha256:attempt-2",
            false,
            1,
            false,
        );
        context(dave(), 0);
        f.contract.record_independent_verification(f.job, bad2);

        let job = f.contract.get_job(f.job).unwrap();
        assert!(matches!(job.status, JobStatus::Exhausted));
        assert_eq!(job.attempt, 2);

        let committed_after = f.contract.get_node(f.root).unwrap().committed_to_children;
        assert_eq!(committed_after, committed_before - job.budget);

        context(carol(), 0);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            f.contract.request_changes(f.job)
        }));
        assert!(result.is_err());
    }

    // ---------- payment lifecycle ----------

    #[test]
    fn payment_stays_pending_until_callback() {
        let mut f = setup_job();
        submit_and_verify_pass(&mut f, "sha256:artifact");

        context(bob(), 0);
        f.contract.accept_job(f.job);
        let job = f.contract.get_job(f.job).unwrap();
        assert!(matches!(job.status, JobStatus::PaymentPending));
        assert_eq!(job.paid_at, None);
        assert_eq!(f.contract.get_node(f.root).unwrap().spent, 0);

        context_with_promise(CALIPER.parse().unwrap(), PromiseResult::Successful(vec![]));
        f.contract.on_job_payment(f.job);
        let job = f.contract.get_job(f.job).unwrap();
        assert!(matches!(job.status, JobStatus::Paid));
        assert!(job.paid_at.is_some());
        assert_eq!(f.contract.get_node(f.root).unwrap().spent, job.winning_bid);
    }

    #[test]
    fn failed_transfer_does_not_mark_paid_and_can_retry() {
        let mut f = setup_job();
        submit_and_verify_pass(&mut f, "sha256:artifact");
        let committed_before = f.contract.get_node(f.root).unwrap().committed_to_children;

        context(bob(), 0);
        f.contract.accept_job(f.job);
        context_with_promise(CALIPER.parse().unwrap(), PromiseResult::Failed);
        f.contract.on_job_payment(f.job);

        let job = f.contract.get_job(f.job).unwrap();
        assert!(matches!(job.status, JobStatus::PaymentFailed));
        assert!(job.payment_error.is_some());
        assert_eq!(f.contract.get_node(f.root).unwrap().spent, 0);
        assert_eq!(
            f.contract.get_node(f.root).unwrap().committed_to_children,
            committed_before
        );

        context(bob(), 0);
        f.contract.accept_job(f.job);
        assert!(matches!(
            f.contract.get_job(f.job).unwrap().status,
            JobStatus::PaymentPending
        ));
        context_with_promise(CALIPER.parse().unwrap(), PromiseResult::Successful(vec![]));
        f.contract.on_job_payment(f.job);

        let job = f.contract.get_job(f.job).unwrap();
        assert!(matches!(job.status, JobStatus::Paid));
        assert_eq!(f.contract.get_node(f.root).unwrap().spent, job.winning_bid);
    }

    #[test]
    fn successful_callback_marks_paid_once() {
        let mut f = setup_job();
        submit_and_verify_pass(&mut f, "sha256:artifact");
        context(bob(), 0);
        f.contract.accept_job(f.job);

        context_with_promise(CALIPER.parse().unwrap(), PromiseResult::Successful(vec![]));
        f.contract.on_job_payment(f.job);
        let spent_after_first = f.contract.get_node(f.root).unwrap().spent;

        context_with_promise(CALIPER.parse().unwrap(), PromiseResult::Successful(vec![]));
        f.contract.on_job_payment(f.job);
        let spent_after_second = f.contract.get_node(f.root).unwrap().spent;

        assert_eq!(spent_after_first, spent_after_second);
        assert!(matches!(f.contract.get_job(f.job).unwrap().status, JobStatus::Paid));
    }

    #[test]
    fn failed_spend_callback_releases_budget() {
        let mut contract = Contract::new_for_test();
        context(owner(), 100);
        let root = contract.create_root(bob(), U128(100), root_permissions());
        context(bob(), 0);
        let child = contract.delegate(root, carol(), child_permissions(40), U128(40), None);
        context(carol(), 0);
        let execution = contract.spend(child, "vendor.near".parse().unwrap(), U128(30), None);
        assert_eq!(contract.get_node(child).unwrap().spent, 30);

        context_with_promise(CALIPER.parse().unwrap(), PromiseResult::Failed);
        contract.on_payout(execution, 30);
        assert_eq!(contract.get_node(child).unwrap().spent, 0);
        assert!(matches!(
            contract.get_execution(execution).unwrap().status,
            ExecutionStatus::Rejected
        ));
    }

    #[test]
    fn cancel_job_releases_commitment() {
        let mut f = setup_job();
        let committed_before = f.contract.get_node(f.root).unwrap().committed_to_children;
        context(bob(), 0);
        f.contract.cancel_job(f.job);
        let job = f.contract.get_job(f.job).unwrap();
        assert!(matches!(job.status, JobStatus::Cancelled));
        assert_eq!(
            f.contract.get_node(f.root).unwrap().committed_to_children,
            committed_before - job.budget
        );
    }

    #[test]
    #[should_panic(expected = "job cannot be cancelled in its current state")]
    fn verified_job_cannot_be_cancelled() {
        let mut f = setup_job();
        submit_and_verify_pass(&mut f, "sha256:artifact");
        context(bob(), 0);
        f.contract.cancel_job(f.job);
    }

    #[test]
    fn worker_revocation_does_not_block_permissionless_settlement() {
        let mut f = setup_job();
        submit_and_verify_pass(&mut f, "sha256:artifact");

        // Worker authority can be revoked after verification; the payment right
        // is bound to the holder account, not to a live authority node.
        context(bob(), 0);
        f.contract.revoke(f.worker);

        // Any third party can release the verified payment.
        context(erin(), 0);
        f.contract.release_verified_payment(f.job);
        context_with_promise(CALIPER.parse().unwrap(), PromiseResult::Successful(vec![]));
        f.contract.on_job_payment(f.job);

        let job = f.contract.get_job(f.job).unwrap();
        assert!(matches!(job.status, JobStatus::Paid));
        assert_eq!(f.contract.get_node(f.root).unwrap().spent, job.winning_bid);
    }

    #[test]
    fn settlement_pays_winning_bid_and_returns_unused_budget() {
        let mut f = setup_job();
        let committed_before = f.contract.get_node(f.root).unwrap().committed_to_children;
        submit_and_verify_pass(&mut f, "sha256:artifact");

        context(erin(), 0);
        f.contract.release_verified_payment(f.job);
        context_with_promise(CALIPER.parse().unwrap(), PromiseResult::Successful(vec![]));
        f.contract.on_job_payment(f.job);

        let job = f.contract.get_job(f.job).unwrap();
        let root = f.contract.get_node(f.root).unwrap();
        assert_eq!(job.winning_bid, 12 * UNIT);
        assert_eq!(root.spent, 12 * UNIT);
        assert_eq!(root.committed_to_children, committed_before - job.budget);
    }

    #[test]
    fn cross_language_attestation_vector_matches() {
        let raw = include_str!("../../shared/attestation-vector.json");
        let vector: serde_json::Value = serde_json::from_str(raw).unwrap();
        let mut a = VerificationAttestation {
            version: vector["attestation"]["version"].as_str().unwrap().to_string(),
            job_id: vector["attestation"]["job_id"].as_u64().unwrap(),
            attempt: vector["attestation"]["attempt"].as_u64().unwrap() as u32,
            deliverable_hash: vector["attestation"]["deliverable_hash"].as_str().unwrap().to_string(),
            acceptance_criteria_hash: vector["attestation"]["acceptance_criteria_hash"].as_str().unwrap().to_string(),
            baseline_commit: vector["attestation"]["baseline_commit"].as_str().unwrap().to_string(),
            acceptance_suite_hash: vector["attestation"]["acceptance_suite_hash"].as_str().unwrap().to_string(),
            diff_hash: vector["attestation"]["diff_hash"].as_str().unwrap().to_string(),
            deliverable_matches_claim: vector["attestation"]["deliverable_matches_claim"].as_bool().unwrap(),
            protected_files_clean: vector["attestation"]["protected_files_clean"].as_bool().unwrap(),
            test_exit_code: vector["attestation"]["test_exit_code"].as_i64().unwrap() as i32,
            ci_exit_code: vector["attestation"]["ci_exit_code"].as_i64().unwrap() as i32,
            runner_version: vector["attestation"]["runner_version"].as_str().unwrap().to_string(),
            passed: vector["attestation"]["passed"].as_bool().unwrap(),
            report_digest: String::new(),
            verifier_public_key: vector["attestation"]["verifier_public_key"].as_str().unwrap().to_string(),
            signature: String::new(),
        };
        assert_eq!(
            canonical_attestation_body(&a),
            vector["expected"]["body"].as_str().unwrap()
        );
        a.report_digest = canonical_report_digest(&canonical_attestation_body(&a));
        assert_eq!(
            a.report_digest,
            vector["expected"]["report_digest"].as_str().unwrap()
        );
        assert_eq!(
            canonical_attestation_message(&a),
            vector["expected"]["message"].as_str().unwrap()
        );
    }
}
