import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOrCreateVerifierKey, sha256Prefixed } from "../shared/attestation.ts";
import { buildMarketRound, formatNear, nearFromTenths, WORKERS } from "./market.ts";
import {
  BASELINE_DIR,
  computeAcceptanceCriteriaHash,
  computeAcceptancePolicyHash,
  hashTree,
  loadManifest,
  verifyArtifact,
  type VerificationReport,
} from "./runner.ts";
import { LocalCaliperChain, type SimNode } from "./local-chain.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const RUNS_DIR = path.join(HERE, "runs");
const LATEST_DIR = path.join(RUNS_DIR, "latest");
const KEY_DIR = path.join(REPO_ROOT, ".caliper", "keys");
const VERIFIER_ACCOUNT = "verifier.caliper.local";
const COORDINATOR_ACCOUNT = "coordinator.caliper.local";
const OWNER_ACCOUNT = "owner.caliper.local";

export interface WorkerClaim {
  passed: boolean;
  summary: string;
  claimed_by: string;
}

export interface AttemptEvidence {
  attempt: number;
  artifact: "tampered" | "corrected";
  worker_claim: WorkerClaim;
  deliverable_hash: string;
  report_path: string;
  report: VerificationReport;
  chain_status: string;
  outcome: string;
}

export interface SwarmRun {
  mode: "local-simulation";
  run_id: string;
  task: {
    title: string;
    acceptance_criteria: string;
    acceptance_criteria_hash: string;
    acceptance_suite_hash: string;
    baseline_commit: string;
    protected_files: string[];
    max_budget: string;
    worker_count: number;
    retry_limit: number;
  };
  identities: {
    owner: string;
    coordinator: { account: string; node: number };
    verifier: { account: string; node: number; public_key: string };
    selected_worker: { account: string; node: number; display_name: string; adversarial: boolean };
    all_workers: typeof WORKERS;
    note: string;
  };
  authority: {
    root_node: SimNode;
    nodes: SimNode[];
    job_budget: string;
    coordinator_committed_before_job: string;
    coordinator_committed_after_job: string;
    coordinator_available_after_job: string;
  };
  market: ReturnType<typeof buildMarketRound>;
  job: ReturnType<LocalCaliperChain["snapshot"]>["jobs"][number];
  attempts: AttemptEvidence[];
  approval: {
    approved_by: string;
    approved_at_block: number;
    gate: string;
  };
  payment: {
    status: string;
    state: string;
    mode: "local-simulation";
    simulated: true;
    note: string;
    budget: string;
    budget_display: string;
    paid_at_block: number | null;
    receipt_id: string;
  };
  integrity: {
    market_transcript_hash_matches_job: boolean;
    market_transcript_hash_in_job: string;
    market_transcript_hash_recomputed: string;
    market_selection_validated_by_contract: false;
    selected_worker_recorded_by_contract: string;
    selected_worker_unchanged_after_failure: boolean;
    attempts_bound_to_current_artifact: boolean;
    payment_requires_callback: boolean;
  };
  events: { block: number; type: string; detail: string }[];
  files: {
    run_json: string;
    market_transcript: string;
    attempt_1_report: string;
    attempt_2_report: string;
  };
}

function permissions(nodeAllocation: string) {
  return {
    recipients: ["vendor.caliper.local"],
    assets: [] as string[],
    max_per_tx: nodeAllocation,
    may_delegate: true,
  };
}

export function runSwarm(): SwarmRun {
  fs.rmSync(LATEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(LATEST_DIR, { recursive: true });

  const manifest = loadManifest();
  const key = loadOrCreateVerifierKey(KEY_DIR);
  const acceptanceCriteria = fs.readFileSync(path.join(path.dirname(BASELINE_DIR), manifest.acceptance_criteria), "utf8");
  const acceptanceCriteriaHash = computeAcceptanceCriteriaHash(manifest, BASELINE_DIR);
  const acceptanceSuiteHash = computeAcceptancePolicyHash(BASELINE_DIR, manifest);

  const chain = new LocalCaliperChain(OWNER_ACCOUNT);
  const rootAllocation = nearFromTenths(1000n);
  const root = chain.createRoot(COORDINATOR_ACCOUNT, rootAllocation, permissions(rootAllocation));

  const workerNodes = new Map<string, number>();
  for (const worker of WORKERS) {
    const workerAllocation = nearFromTenths(80n);
    const node = chain.delegate(root, worker.account, workerAllocation, permissions(workerAllocation));
    workerNodes.set(worker.account, node);
  }
  const verifierNode = chain.delegate(
    root,
    VERIFIER_ACCOUNT,
    nearFromTenths(100n),
    permissions(nearFromTenths(100n)),
  );

  const market = buildMarketRound();
  const winner = WORKERS.find((worker) => worker.account === market.winner);
  if (!winner) throw new Error("market winner is not a known worker");
  const workerNode = workerNodes.get(winner.account);
  if (!workerNode) throw new Error("winner has no authority node");

  const committedBeforeJob = chain.node(root).committed_to_children;
  const jobId = chain.createJob({
    coordinator_node: root,
    worker_node: workerNode,
    verifier_node: verifierNode,
    verifier_public_key: key.publicKeyHex,
    budget: nearFromTenths(200n),
    acceptance_criteria_hash: acceptanceCriteriaHash,
    acceptance_suite_hash: acceptanceSuiteHash,
    baseline_commit: manifest.baseline_commit,
    market_transcript_hash: market.transcript_hash,
    protected_files: manifest.protected_files,
  });
  const committedAfterJob = chain.node(root).committed_to_children;
  const coordinatorAvailableAfterJob = (
    BigInt(chain.node(root).allocation) -
    BigInt(chain.node(root).spent) -
    BigInt(chain.node(root).committed_to_children)
  ).toString();
  const job = chain.job(jobId);

  const attempts: AttemptEvidence[] = [];
  const candidateFor = (name: "tampered" | "corrected") =>
    path.join(HERE, "fixture", "submissions", name);

  // Attempt 1: the adversarial worker weakens the protected test and disables CI,
  // while claiming success. The independent runner recomputes everything.
  const tamperedDir = candidateFor("tampered");
  const tamperedDeliverable = hashTree(tamperedDir);
  const claim1: WorkerClaim = {
    passed: true,
    summary: "Updated the flaky billing expectation and the CI check; all reported checks are green.",
    claimed_by: winner.account,
  };
  chain.submitDeliverable(jobId, winner.account, tamperedDeliverable);
  const report1 = verifyArtifact({
    job_id: jobId,
    attempt: chain.job(jobId).attempt,
    candidateDir: tamperedDir,
    claimedDeliverableHash: tamperedDeliverable,
    acceptanceCriteriaHash,
    acceptanceSuiteHash,
    verifierPrivateKey: key.privateKey,
    reportPath: path.join(LATEST_DIR, "attempt-1-report.json"),
  });
  chain.recordVerification(jobId, VERIFIER_ACCOUNT, report1.attestation);
  attempts.push({
    attempt: 1,
    artifact: "tampered",
    worker_claim: claim1,
    deliverable_hash: tamperedDeliverable,
    report_path: "demo/runs/latest/attempt-1-report.json",
    report: report1,
    chain_status: chain.job(jobId).status,
    outcome: "blocked: protected acceptance files were modified",
  });

  if (chain.job(jobId).status !== "Rejected") {
    throw new Error("adversarial attempt was not rejected");
  }

  chain.requestChanges(jobId, COORDINATOR_ACCOUNT);

  // Attempt 2: same selected worker, genuine source fix, pinned suite executes.
  const correctedDir = candidateFor("corrected");
  const correctedDeliverable = hashTree(correctedDir);
  const claim2: WorkerClaim = {
    passed: true,
    summary: "Fixed src/auth.js so billing requires the admin role. The pinned suite and CI check pass unmodified.",
    claimed_by: winner.account,
  };
  chain.submitDeliverable(jobId, winner.account, correctedDeliverable);
  const report2 = verifyArtifact({
    job_id: jobId,
    attempt: chain.job(jobId).attempt,
    candidateDir: correctedDir,
    claimedDeliverableHash: correctedDeliverable,
    acceptanceCriteriaHash,
    acceptanceSuiteHash,
    verifierPrivateKey: key.privateKey,
    reportPath: path.join(LATEST_DIR, "attempt-2-report.json"),
  });
  chain.recordVerification(jobId, VERIFIER_ACCOUNT, report2.attestation);
  attempts.push({
    attempt: 2,
    artifact: "corrected",
    worker_claim: claim2,
    deliverable_hash: correctedDeliverable,
    report_path: "demo/runs/latest/attempt-2-report.json",
    report: report2,
    chain_status: chain.job(jobId).status,
    outcome: "passed: genuine source fix accepted by the pinned suite",
  });

  if (chain.job(jobId).status !== "Verified") {
    throw new Error("corrected attempt did not pass");
  }

  chain.acceptJob(jobId, COORDINATOR_ACCOUNT);
  const pendingStatus = chain.job(jobId).status;
  chain.settlePayment(jobId, true);
  const paymentJob = chain.job(jobId);
  if (paymentJob.status !== "Paid") throw new Error("payment did not settle");

  const snapshot = chain.snapshot();
  const finalJob = snapshot.jobs.find((candidate) => candidate.id === jobId);
  if (!finalJob) throw new Error("final job missing");

  const recomputedMarketHash = market.transcript_hash;
  const runId = sha256Prefixed(
    JSON.stringify({
      market: recomputedMarketHash,
      attempt1: report1.attestation.report_digest,
      attempt2: report2.attestation.report_digest,
    }),
  ).slice(0, 22);

  const run: SwarmRun = {
    mode: "local-simulation",
    run_id: runId,
    task: {
      title: manifest.task,
      acceptance_criteria: acceptanceCriteria,
      acceptance_criteria_hash: acceptanceCriteriaHash,
      acceptance_suite_hash: acceptanceSuiteHash,
      baseline_commit: manifest.baseline_commit,
      protected_files: manifest.protected_files,
      max_budget: market.max_budget,
      worker_count: WORKERS.length,
      retry_limit: 2,
    },
    identities: {
      owner: OWNER_ACCOUNT,
      coordinator: { account: COORDINATOR_ACCOUNT, node: root },
      verifier: {
        account: VERIFIER_ACCOUNT,
        node: verifierNode,
        public_key: key.publicKeyHex,
      },
      selected_worker: {
        account: winner.account,
        node: workerNode,
        display_name: winner.display_name,
        adversarial: winner.adversarial,
      },
      all_workers: WORKERS,
      note: "All identities are local simulation accounts. They are not deployed NEAR subaccounts.",
    },
    authority: {
      root_node: chain.node(root),
      nodes: snapshot.nodes,
      job_budget: nearFromTenths(200n),
      coordinator_committed_before_job: committedBeforeJob,
      coordinator_committed_after_job: committedAfterJob,
      coordinator_available_after_job: coordinatorAvailableAfterJob,
    },
    market,
    job: finalJob,
    attempts,
    approval: {
      approved_by: COORDINATOR_ACCOUNT,
      approved_at_block: snapshot.events.find((event) => event.type === "payment_pending")?.block ?? 0,
      gate: "coordinator approval requires the current attempt to pass the pinned acceptance suite",
    },
    payment: {
      status: pendingStatus,
      state: finalJob.status,
      mode: "local-simulation",
      simulated: true,
      note: "Local chain simulation. No on-chain transaction, transaction hash, or wallet signature was created.",
      budget: finalJob.budget,
      budget_display: formatNear(finalJob.budget),
      paid_at_block: finalJob.paid_at,
      receipt_id: `local-receipt:${runId}`,
    },
    integrity: {
      market_transcript_hash_matches_job: finalJob.market_transcript_hash === recomputedMarketHash,
      market_transcript_hash_in_job: finalJob.market_transcript_hash,
      market_transcript_hash_recomputed: recomputedMarketHash,
      market_selection_validated_by_contract: false,
      selected_worker_recorded_by_contract: finalJob.worker_holder,
      selected_worker_unchanged_after_failure: finalJob.worker_holder === winner.account,
      attempts_bound_to_current_artifact:
        report1.attestation.attempt === 1 && report2.attestation.attempt === 2,
      payment_requires_callback: pendingStatus === "PaymentPending" && finalJob.status === "Paid",
    },
    events: snapshot.events,
    files: {
      run_json: "demo/runs/latest/run.json",
      market_transcript: "demo/runs/latest/market-transcript.json",
      attempt_1_report: "demo/runs/latest/attempt-1-report.json",
      attempt_2_report: "demo/runs/latest/attempt-2-report.json",
    },
  };

  fs.writeFileSync(
    path.join(LATEST_DIR, "market-transcript.json"),
    JSON.stringify(market, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(LATEST_DIR, "run.json"), JSON.stringify(run, null, 2) + "\n");
  return run;
}

