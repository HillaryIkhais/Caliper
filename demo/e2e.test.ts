import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  loadOrCreateVerifierKey,
  verifyAttestationSignature,
} from "../shared/attestation.ts";
import { LocalCaliperChain, type SimPermissions } from "./local-chain.ts";
import { nearFromTenths } from "./market.ts";
import { runSwarm } from "./swarm.ts";
import {
  BASELINE_DIR,
  computeAcceptanceCriteriaHash,
  computeAcceptanceSuiteHash,
  hashTree,
  loadManifest,
  verifyArtifact,
} from "./runner.ts";

function permissions(max: string): SimPermissions {
  return {
    recipients: ["vendor.local"],
    assets: [],
    max_per_tx: max,
    may_delegate: true,
  };
}

test("complete adversarial scenario runs end to end", () => {
  const run = runSwarm();

  assert.equal(run.mode, "local-simulation");
  assert.equal(run.market.winner, "worker-eve.local");
  assert.equal(run.identities.selected_worker.account, "worker-eve.local");
  assert.equal(run.attempts.length, 2);

  const tampered = run.attempts[0];
  assert.equal(tampered.chain_status, "Rejected");
  assert.ok(tampered.report.protected_violations.length > 0);
  assert.ok(tampered.report.manipulation.weakened_assertions.length > 0);
  assert.ok(tampered.report.manipulation.disabled_ci.length > 0);
  assert.equal(tampered.report.passed, false);
  assert.equal(tampered.worker_claim.passed, true);

  const corrected = run.attempts[1];
  assert.equal(corrected.chain_status, "Verified");
  assert.equal(corrected.report.passed, true);
  assert.equal(corrected.report.test_exit_code, 0);
  assert.equal(corrected.report.ci_exit_code, 0);
  assert.deepEqual(corrected.report.protected_violations, []);

  assert.equal(run.approval.approved_by, "coordinator.caliper.local");
  assert.equal(run.payment.status, "PaymentPending");
  assert.equal(run.payment.state, "Paid");
  assert.equal(run.payment.simulated, true);
  assert.equal(run.integrity.market_transcript_anchored, true);
  assert.equal(run.integrity.selected_worker_unchanged_after_failure, true);
  assert.equal(run.integrity.payment_requires_callback, true);

  assert.equal(verifyAttestationSignature(run.attempts[0].report.attestation), true);
  assert.equal(verifyAttestationSignature(run.attempts[1].report.attestation), true);
  assert.notEqual(
    run.attempts[0].report.attestation.report_digest,
    run.attempts[1].report.attestation.report_digest,
  );
});

test("old attempt report and old artifact report cannot be reused", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "caliper-old-report-"));
  try {
    const key = loadOrCreateVerifierKey(path.join(temp, "keys"));
    const manifest = loadManifest();
    const criteria = computeAcceptanceCriteriaHash(manifest, BASELINE_DIR);
    const suite = computeAcceptanceSuiteHash(BASELINE_DIR, manifest);

    const chain = new LocalCaliperChain("owner.local");
    const root = chain.createRoot("coordinator.local", nearFromTenths(1000n), permissions(nearFromTenths(1000n)));
    const worker = chain.delegate(root, "worker.local", nearFromTenths(100n), permissions(nearFromTenths(100n)));
    const verifier = chain.delegate(root, "verifier.local", nearFromTenths(100n), permissions(nearFromTenths(100n)));
    const jobId = chain.createJob({
      coordinator_node: root,
      worker_node: worker,
      verifier_node: verifier,
      verifier_public_key: key.publicKeyHex,
      budget: nearFromTenths(200n),
      acceptance_criteria_hash: criteria,
      acceptance_suite_hash: suite,
      baseline_commit: manifest.baseline_commit,
      market_transcript_hash: "sha256:market-test",
      protected_files: manifest.protected_files,
    });

    const tamperedDir = path.join(import.meta.dirname, "fixture", "submissions", "tampered");
    const correctedDir = path.join(import.meta.dirname, "fixture", "submissions", "corrected");
    const tamperedDeliverable = hashTree(tamperedDir);
    const correctedDeliverable = hashTree(correctedDir);

    const report1 = verifyArtifact({
      job_id: jobId,
      attempt: 1,
      candidateDir: tamperedDir,
      claimedDeliverableHash: tamperedDeliverable,
      acceptanceCriteriaHash: criteria,
      acceptanceSuiteHash: suite,
      verifierPrivateKey: key.privateKey,
      workDir: path.join(temp, "work"),
      reportPath: path.join(temp, "report1.json"),
    });

    // A report bound to the corrected artifact cannot be used for another artifact.
    const wrongArtifactReport = verifyArtifact({
      job_id: jobId,
      attempt: 1,
      candidateDir: correctedDir,
      claimedDeliverableHash: correctedDeliverable,
      acceptanceCriteriaHash: criteria,
      acceptanceSuiteHash: suite,
      verifierPrivateKey: key.privateKey,
      workDir: path.join(temp, "work"),
      reportPath: path.join(temp, "report-corrected.json"),
    });
    chain.submitDeliverable(jobId, "worker.local", tamperedDeliverable);
    assert.throws(
      () => chain.recordVerification(jobId, "verifier.local", wrongArtifactReport.attestation),
      /deliverable_hash/,
    );

    // A report bound to attempt 1 cannot be replayed against attempt 2.
    chain.recordVerification(jobId, "verifier.local", report1.attestation);
    assert.equal(chain.job(jobId).status, "Rejected");
    chain.requestChanges(jobId, "coordinator.local");
    chain.submitDeliverable(jobId, "worker.local", correctedDeliverable);
    assert.equal(chain.job(jobId).attempt, 2);
    assert.throws(
      () => chain.recordVerification(jobId, "verifier.local", report1.attestation),
      /attempt/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
