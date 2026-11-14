import {
  ATTESTATION_VERSION,
  attestationMismatches,
  verifyAttestationSignature,
  type VerificationAttestation,
} from "../shared/attestation.ts";

export type Balance = string;
export type JobStatus =
  | "Open"
  | "Submitted"
  | "Verified"
  | "PaymentPending"
  | "Paid"
  | "PaymentFailed"
  | "Rejected"
  | "Exhausted"
  | "Cancelled";

export interface SimPermissions {
  recipients: string[];
  assets: string[];
  max_per_tx: Balance;
  may_delegate: boolean;
}

export interface SimNode {
  id: number;
  parent: number | null;
  holder: string;
  permissions: SimPermissions;
  allocation: Balance;
  spent: Balance;
  committed_to_children: Balance;
  active: boolean;
  children: number[];
  created_at: number;
}

export interface SimJob {
  id: number;
  coordinator_node: number;
  worker_node: number;
  verifier_node: number;
  coordinator_holder: string;
  worker_holder: string;
  verifier_holder: string;
  verifier_public_key: string;
  budget: Balance;
  winning_bid: Balance;
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
  verification: { attestation: VerificationAttestation; recorded_at: number } | null;
  status: JobStatus;
  payment_error: string | null;
  created_at: number;
  submitted_at: number | null;
  verified_at: number | null;
  resolved_at: number | null;
  paid_at: number | null;
}

export interface CreateJobInput {
  coordinator_node: number;
  worker_node: number;
  verifier_node: number;
  verifier_public_key: string;
  budget: Balance;
  winning_bid: Balance;
  acceptance_criteria_hash: string;
  acceptance_suite_hash: string;
  baseline_commit: string;
  market_transcript_hash: string;
  protected_files: string[];
}

const MAX_ATTEMPTS = 2;
const VERIFICATION_TIMEOUT_BLOCKS = 1000;

export class LocalCaliperChain {
  owner: string;
  nextNode = 1;
  nextJob = 1;
  block = 0;
  nodes = new Map<number, SimNode>();
  jobs = new Map<number, SimJob>();
  events: { block: number; type: string; detail: string }[] = [];

  constructor(owner: string) {
    this.owner = owner;
  }

  private tick(): number {
    this.block += 1;
    return this.block;
  }

  private log(type: string, detail: string): void {
    this.events.push({ block: this.block, type, detail });
  }

  node(id: number): SimNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`authority ${id} not found`);
    return node;
  }

  job(id: number): SimJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`job ${id} not found`);
    return job;
  }

  isAuthorityValid(id: number): boolean {
    let current: number | null = id;
    while (current !== null) {
      const node = this.node(current);
      if (!node.active) return false;
      current = node.parent;
    }
    return true;
  }

  private isDescendantOf(id: number, ancestor: number): boolean {
    if (id === ancestor) return true;
    let current = this.node(id).parent;
    while (current !== null) {
      if (current === ancestor) return true;
      current = this.node(current).parent;
    }
    return false;
  }

  private available(id: number): bigint {
    const node = this.node(id);
    return BigInt(node.allocation) - BigInt(node.spent) - BigInt(node.committed_to_children);
  }

  createRoot(holder: string, allocation: Balance, permissions: SimPermissions): number {
    if (this.nodes.size > 0) throw new Error("root already exists");
    const id = this.nextNode++;
    this.tick();
    this.nodes.set(id, {
      id,
      parent: null,
      holder,
      permissions,
      allocation,
      spent: "0",
      committed_to_children: "0",
      active: true,
      children: [],
      created_at: this.block,
    });
    this.log("create_root", `${holder} received ${allocation} yoctoNEAR`);
    return id;
  }

  delegate(
    parentId: number,
    holder: string,
    allocation: Balance,
    permissions: SimPermissions,
  ): number {
    const parent = this.node(parentId);
    if (!parent.active) throw new Error("parent authority is revoked");
    if (!parent.permissions.may_delegate) throw new Error("parent may not delegate");
    if (BigInt(allocation) <= 0n) throw new Error("allocation must be positive");
    if (BigInt(allocation) > this.available(parentId)) {
      throw new Error("delegation exceeds uncommitted allocation");
    }
    for (const recipient of permissions.recipients) {
      if (!parent.permissions.recipients.includes(recipient)) {
        throw new Error("child recipient not in parent permissions");
      }
    }
    if (BigInt(permissions.max_per_tx) > BigInt(parent.permissions.max_per_tx)) {
      throw new Error("child max_per_tx exceeds parent");
    }

    const id = this.nextNode++;
    this.tick();
    const child: SimNode = {
      id,
      parent: parentId,
      holder,
      permissions,
      allocation,
      spent: "0",
      committed_to_children: "0",
      active: true,
      children: [],
      created_at: this.block,
    };
    this.nodes.set(id, child);
    parent.children.push(id);
    parent.committed_to_children = (BigInt(parent.committed_to_children) + BigInt(allocation)).toString();
    this.log("delegate", `${holder} received authority node ${id}`);
    return id;
  }

  spend(nodeId: number, caller: string, recipient: string, amount: Balance): void {
    const node = this.node(nodeId);
    if (caller !== node.holder) throw new Error("only the node's holder may spend");
    if (!this.isAuthorityValid(nodeId)) throw new Error("authority is revoked or expired");
    if (BigInt(amount) <= 0n) throw new Error("amount must be positive");
    if (BigInt(amount) > this.available(nodeId)) {
      throw new Error("spend exceeds uncommitted allocation");
    }
    if (BigInt(amount) > BigInt(node.permissions.max_per_tx)) {
      throw new Error("spend exceeds per-tx cap");
    }
    if (!node.permissions.recipients.includes(recipient)) {
      throw new Error("recipient not allowed");
    }
    node.spent = (BigInt(node.spent) + BigInt(amount)).toString();
    this.log("spend", `${caller} spent ${amount} from node ${nodeId}`);
  }

  revoke(nodeId: number, caller: string): void {
    const node = this.node(nodeId);
    if (caller !== this.owner) {
      let current = node.parent;
      let allowed = false;
      while (current !== null) {
        if (this.node(current).holder === caller) allowed = true;
        current = this.node(current).parent;
      }
      if (!allowed) throw new Error("only the owner or an ancestor may revoke");
    }
    const stack = [nodeId, ...this.descendantIds(nodeId)];

    // Do not let revocation destroy a payment obligation or sabotage an
    // in-flight verification.
    for (const job of this.jobs.values()) {
      const coordinatorHit = stack.includes(job.coordinator_node);
      const roleHit = stack.includes(job.worker_node) || stack.includes(job.verifier_node);
      if (
        ["Verified", "PaymentPending", "PaymentFailed"].includes(job.status) &&
        coordinatorHit
      ) {
        throw new Error("cannot revoke a branch with an outstanding verified payment");
      }
      if (job.status === "Submitted" && (coordinatorHit || roleHit)) {
        throw new Error("cannot revoke a branch with a job awaiting verification");
      }
    }

    let branchSpent = 0n;
    for (const id of stack) {
      branchSpent += BigInt(this.node(id).spent);
    }
    if (branchSpent > BigInt(node.allocation)) {
      throw new Error("branch spend exceeds revoked allocation");
    }
    for (const id of stack) {
      const n = this.node(id);
      n.active = false;
    }
    if (node.parent !== null) {
      const parent = this.node(node.parent);
      parent.committed_to_children = (
        BigInt(parent.committed_to_children) - BigInt(node.allocation)
      ).toString();
      parent.spent = (BigInt(parent.spent) + branchSpent).toString();
      parent.children = parent.children.filter((child) => child !== nodeId);
    }
    this.log("revoke", `authority node ${nodeId} revoked; retained ${branchSpent} spent`);
  }

  private descendantIds(id: number): number[] {
    const out: number[] = [];
    const stack = [...this.node(id).children];
    while (stack.length > 0) {
      const child = stack.pop()!;
      out.push(child);
      stack.push(...this.node(child).children);
    }
    return out;
  }

  createJob(input: CreateJobInput): number {
    const coordinator = this.node(input.coordinator_node);
    const worker = this.node(input.worker_node);
    const verifier = this.node(input.verifier_node);
    for (const id of [input.coordinator_node, input.worker_node, input.verifier_node]) {
      if (!this.isAuthorityValid(id)) throw new Error("role authority is revoked or expired");
    }
    if (input.coordinator_node === input.worker_node || input.coordinator_node === input.verifier_node) {
      throw new Error("coordinator must be distinct from worker and verifier");
    }
    if (input.worker_node === input.verifier_node) {
      throw new Error("worker and verifier must be distinct");
    }
    if (coordinator.holder === worker.holder || coordinator.holder === verifier.holder) {
      throw new Error("coordinator must be a different account");
    }
    if (worker.holder === verifier.holder) {
      throw new Error("worker and verifier must be different accounts");
    }
    if (!this.isDescendantOf(input.worker_node, input.coordinator_node)) {
      throw new Error("worker must be a descendant of the coordinator");
    }
    if (!this.isDescendantOf(input.verifier_node, input.coordinator_node)) {
      throw new Error("verifier must be a descendant of the coordinator");
    }
    if (!/^[0-9a-f]{64}$/.test(input.verifier_public_key)) {
      throw new Error("verifier public key must be 32-byte hex");
    }
    if (BigInt(input.budget) <= 0n) throw new Error("budget must be positive");
    if (BigInt(input.budget) > this.available(input.coordinator_node)) {
      throw new Error("budget exceeds coordinator uncommitted allocation");
    }
    if (BigInt(input.winning_bid) <= 0n) throw new Error("winning bid must be positive");
    if (BigInt(input.winning_bid) > BigInt(input.budget)) {
      throw new Error("winning bid exceeds escrowed budget");
    }
    for (const [label, value] of Object.entries({
      acceptance_criteria_hash: input.acceptance_criteria_hash,
      acceptance_suite_hash: input.acceptance_suite_hash,
      baseline_commit: input.baseline_commit,
      market_transcript_hash: input.market_transcript_hash,
    })) {
      if (!value) throw new Error(`${label} required`);
    }

    const id = this.nextJob++;
    this.tick();
    const job: SimJob = {
      id,
      coordinator_node: input.coordinator_node,
      worker_node: input.worker_node,
      verifier_node: input.verifier_node,
      coordinator_holder: coordinator.holder,
      worker_holder: worker.holder,
      verifier_holder: verifier.holder,
      verifier_public_key: input.verifier_public_key,
      budget: input.budget,
      winning_bid: input.winning_bid,
      acceptance_criteria_hash: input.acceptance_criteria_hash,
      acceptance_suite_hash: input.acceptance_suite_hash,
      baseline_commit: input.baseline_commit,
      market_transcript_hash: input.market_transcript_hash,
      protected_files: input.protected_files,
      deliverable_hash: null,
      attempt: 0,
      max_attempts: MAX_ATTEMPTS,
      modified_files_hash: null,
      tampering_detected: false,
      independent_report_hash: null,
      independent_passed: null,
      deliverable_matches_claim: null,
      test_exit_code: null,
      ci_exit_code: null,
      verification: null,
      status: "Open",
      payment_error: null,
      created_at: this.block,
      submitted_at: null,
      verified_at: null,
      resolved_at: null,
      paid_at: null,
    };
    this.jobs.set(id, job);
    coordinator.committed_to_children = (
      BigInt(coordinator.committed_to_children) + BigInt(input.budget)
    ).toString();
    this.log("create_job", `job ${id} recorded supplied market transcript hash ${input.market_transcript_hash}`);
    return id;
  }

  private assertJobRoles(job: SimJob): void {
    for (const id of [job.coordinator_node, job.worker_node, job.verifier_node]) {
      if (!this.isAuthorityValid(id)) throw new Error("job role authority is revoked or expired");
    }
    if (this.node(job.coordinator_node).holder !== job.coordinator_holder) {
      throw new Error("coordinator holder changed");
    }
    if (this.node(job.worker_node).holder !== job.worker_holder) {
      throw new Error("worker holder changed");
    }
    if (this.node(job.verifier_node).holder !== job.verifier_holder) {
      throw new Error("verifier holder changed");
    }
  }

  private clearVerification(job: SimJob): void {
    job.modified_files_hash = null;
    job.tampering_detected = false;
    job.independent_report_hash = null;
    job.independent_passed = null;
    job.deliverable_matches_claim = null;
    job.test_exit_code = null;
    job.ci_exit_code = null;
    job.verification = null;
    job.verified_at = null;
  }

  submitDeliverable(jobId: number, caller: string, deliverableHash: string): void {
    const job = this.job(jobId);
    if (caller !== job.worker_holder) throw new Error("only the worker may submit");
    this.assertJobRoles(job);
    if (job.status !== "Open") throw new Error("job is not open for submission");
    if (!deliverableHash) throw new Error("deliverable hash required");
    if (job.attempt >= job.max_attempts) throw new Error("retry limit exhausted");
    job.attempt += 1;
    this.clearVerification(job);
    job.deliverable_hash = deliverableHash;
    job.submitted_at = this.tick();
    job.status = "Submitted";
    job.resolved_at = null;
    job.payment_error = null;
    this.log("submit", `attempt ${job.attempt} submitted by ${caller}`);
  }

  recordVerification(jobId: number, caller: string, attestation: VerificationAttestation): void {
    const job = this.job(jobId);
    if (caller !== job.verifier_holder) throw new Error("only the designated verifier may attest");
    this.assertJobRoles(job);
    if (job.status !== "Submitted") throw new Error("job is not submitted");
    if (attestation.version !== ATTESTATION_VERSION) throw new Error("unsupported attestation version");
    const mismatches = attestationMismatches(attestation, {
      job_id: job.id,
      attempt: job.attempt,
      deliverable_hash: job.deliverable_hash ?? "",
      acceptance_criteria_hash: job.acceptance_criteria_hash,
      baseline_commit: job.baseline_commit,
      acceptance_suite_hash: job.acceptance_suite_hash,
      verifier_public_key: job.verifier_public_key,
    });
    if (mismatches.length > 0) {
      throw new Error(`attestation binding failed: ${mismatches.join(", ")}`);
    }
    if (!verifyAttestationSignature(attestation)) {
      throw new Error("invalid verifier signature");
    }

    job.modified_files_hash = attestation.diff_hash;
    job.tampering_detected = !attestation.protected_files_clean;
    job.independent_report_hash = attestation.report_digest;
    job.independent_passed = attestation.passed;
    job.deliverable_matches_claim = attestation.deliverable_matches_claim;
    job.test_exit_code = attestation.test_exit_code;
    job.ci_exit_code = attestation.ci_exit_code;
    job.verified_at = this.tick();
    job.verification = { attestation, recorded_at: job.verified_at };

    if (attestation.passed) {
      job.status = "Verified";
      job.resolved_at = null;
      this.log("verified", `attempt ${job.attempt} passed independent verification`);
    } else if (job.attempt >= job.max_attempts) {
      job.status = "Exhausted";
      job.resolved_at = this.block;
      this.releaseCommitment(job);
      this.log("exhausted", `attempt ${job.attempt} failed; commitment released`);
    } else {
      job.status = "Rejected";
      job.resolved_at = this.block;
      this.log("rejected", `attempt ${job.attempt} failed verification`);
    }
  }

  private releaseCommitment(job: SimJob): void {
    const coordinator = this.node(job.coordinator_node);
    coordinator.committed_to_children = (
      BigInt(coordinator.committed_to_children) - BigInt(job.budget)
    ).toString();
  }

  requestChanges(jobId: number, caller: string): void {
    const job = this.job(jobId);
    if (caller !== job.coordinator_holder) throw new Error("only the coordinator may request changes");
    this.assertJobRoles(job);
    if (job.status !== "Rejected") throw new Error("changes can only follow a failed verification");
    if (job.attempt >= job.max_attempts) throw new Error("retry limit exhausted");
    this.clearVerification(job);
    job.deliverable_hash = null;
    job.submitted_at = null;
    job.resolved_at = null;
    job.status = "Open";
    this.log("request_changes", `coordinator opened correction attempt ${job.attempt + 1}`);
  }

  acceptJob(jobId: number, caller: string): void {
    const job = this.job(jobId);
    if (caller !== job.coordinator_holder) throw new Error("only the coordinator may accept");
    this.startVerifiedPayment(job, caller);
  }

  /**
   * Once independent verification passes, the payment obligation is fixed.
   * Anyone may release it, so a coordinator cannot withhold settlement.
   */
  releaseVerifiedPayment(jobId: number, caller: string): void {
    this.startVerifiedPayment(this.job(jobId), caller);
  }

  private startVerifiedPayment(job: SimJob, caller: string): void {
    if (job.status !== "Verified" && job.status !== "PaymentFailed") {
      throw new Error("job is not verified or retryable");
    }
    if (job.independent_passed !== true) throw new Error("job has not passed verification");
    if (job.tampering_detected) throw new Error("tampering detected");
    if (!job.verification) throw new Error("verified job has no attestation");
    // Only the coordinator authority is required for accounting. Worker and
    // verifier authority may be revoked without extinguishing the payment right.
    if (!this.isAuthorityValid(job.coordinator_node)) {
      throw new Error("coordinator authority is revoked or expired");
    }
    const mismatches = attestationMismatches(job.verification.attestation, {
      job_id: job.id,
      attempt: job.attempt,
      deliverable_hash: job.deliverable_hash ?? "",
      acceptance_criteria_hash: job.acceptance_criteria_hash,
      baseline_commit: job.baseline_commit,
      acceptance_suite_hash: job.acceptance_suite_hash,
      verifier_public_key: job.verifier_public_key,
    });
    if (mismatches.length > 0) throw new Error("stale verification evidence");
    job.status = "PaymentPending";
    job.payment_error = null;
    this.log("payment_pending", `payment released by ${caller} for job ${job.id}`);
  }

  settlePayment(jobId: number, success: boolean): void {
    const job = this.job(jobId);
    if (job.status !== "PaymentPending") return;
    if (success) {
      const coordinator = this.node(job.coordinator_node);
      coordinator.committed_to_children = (
        BigInt(coordinator.committed_to_children) - BigInt(job.budget)
      ).toString();
      coordinator.spent = (BigInt(coordinator.spent) + BigInt(job.winning_bid)).toString();
      job.status = "Paid";
      job.paid_at = this.tick();
      job.resolved_at = job.paid_at;
      job.payment_error = null;
      this.log("paid", `transfer callback confirmed payment for job ${job.id}`);
    } else {
      job.status = "PaymentFailed";
      job.payment_error = "NEAR transfer failed";
      this.log("payment_failed", `transfer callback failed for job ${job.id}; budget remains reserved`);
    }
  }

  cancelJob(jobId: number, caller: string): void {
    const job = this.job(jobId);
    if (caller !== job.coordinator_holder) throw new Error("only the coordinator may cancel");
    // A Verified job is a fixed payment obligation and cannot be cancelled.
    // Submitted jobs are cancellable only after the verification timeout.
    const cancellable =
      job.status === "Open" ||
      job.status === "Rejected" ||
      (job.status === "Submitted" &&
        job.submitted_at !== null &&
        this.block >= job.submitted_at + VERIFICATION_TIMEOUT_BLOCKS);
    if (!cancellable) throw new Error("job cannot be cancelled in its current state");
    job.status = "Cancelled";
    job.resolved_at = this.tick();
    this.releaseCommitment(job);
    this.log("cancelled", `job ${job.id} cancelled`);
  }

  snapshot() {
    return {
      owner: this.owner,
      block: this.block,
      nodes: [...this.nodes.values()],
      jobs: [...this.jobs.values()],
      events: this.events,
    };
  }
}
