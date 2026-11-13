import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadOrCreateVerifierKey } from "../shared/attestation.ts";
import {
  BASELINE_DIR,
  computeAcceptanceCriteriaHash,
  computeAcceptanceSuiteHash,
  hashTree,
  loadManifest,
  verifyArtifact,
} from "./runner.ts";

const manifest = loadManifest();
const acceptanceCriteriaHash = computeAcceptanceCriteriaHash(manifest, BASELINE_DIR);
const acceptanceSuiteHash = computeAcceptanceSuiteHash(BASELINE_DIR, manifest);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "caliper-runner-test-"));
const key = loadOrCreateVerifierKey(path.join(tempRoot, "keys"));
let jobCounter = 1;

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function copyBaseline(name: string): string {
  const dir = path.join(tempRoot, name);
  fs.cpSync(BASELINE_DIR, dir, { recursive: true });
  return dir;
}

function verify(candidateDir: string, attempt = 1) {
  const jobId = jobCounter++;
  return verifyArtifact({
    job_id: jobId,
    attempt,
    candidateDir,
    claimedDeliverableHash: hashTree(candidateDir),
    acceptanceCriteriaHash,
    acceptanceSuiteHash,
    verifierPrivateKey: key.privateKey,
    workDir: path.join(tempRoot, "work"),
    reportPath: path.join(tempRoot, "reports", `job-${jobId}.json`),
  });
}

test("genuine source fix passes the pinned suite", () => {
  const candidate = path.join(import.meta.dirname, "fixture", "submissions", "corrected");
  const report = verify(candidate);
  assert.equal(report.passed, true);
  assert.equal(report.test_exit_code, 0);
  assert.equal(report.ci_exit_code, 0);
  assert.deepEqual(report.protected_violations, []);
  assert.deepEqual(report.manipulation.deleted_tests, []);
  assert.deepEqual(report.manipulation.weakened_assertions, []);
  assert.deepEqual(report.manipulation.disabled_ci, []);
  assert.equal(report.attestation.passed, true);
  assert.equal(report.attestation.protected_files_clean, true);
});

test("deleted protected test is detected", () => {
  const candidate = copyBaseline("deleted-test");
  fs.rmSync(path.join(candidate, "tests", "auth.test.js"));
  const report = verify(candidate);
  assert.equal(report.passed, false);
  assert.ok(report.protected_violations.some((entry) => entry.startsWith("D tests/auth.test.js")));
  assert.ok(report.manipulation.deleted_tests.includes("tests/auth.test.js"));
  assert.equal(report.attestation.passed, false);
});

test("weakened assertion is detected", () => {
  const candidate = copyBaseline("weakened");
  fs.writeFileSync(
    path.join(candidate, "tests", "auth.test.js"),
    fs
      .readFileSync(path.join(candidate, "tests", "auth.test.js"), "utf8")
      .replace(
        'assert.equal(canAccess({ id: "u1", role: "member" }, "billing"), false);',
        "assert.ok(true);",
      ),
  );
  const report = verify(candidate);
  assert.equal(report.passed, false);
  assert.ok(report.manipulation.weakened_assertions.length > 0);
  assert.ok(
    report.manipulation.weakened_assertions.some((entry) => entry.includes("tautological") || entry.includes("assert.ok(true)")),
  );
});

test("disabled CI check is detected", () => {
  const candidate = copyBaseline("disabled-ci");
  fs.writeFileSync(path.join(candidate, "ci", "check.js"), "process.exit(0);\n");
  const report = verify(candidate);
  assert.equal(report.passed, false);
  assert.ok(report.protected_violations.some((entry) => entry.includes("ci/check.js")));
  assert.ok(report.manipulation.disabled_ci.length > 0);
});

test("the runner restores the pinned suite instead of trusting worker tests", () => {
  const candidate = copyBaseline("restored-suite");
  fs.writeFileSync(
    path.join(candidate, "tests", "auth.test.js"),
    'import assert from "node:assert/strict";\nassert.ok(true);\nprocess.exit(0);\n',
  );
  const report = verify(candidate);
  assert.equal(report.passed, false);
  assert.equal(report.test_stdout.includes("AUTH SUITE PASS"), false);
  assert.notEqual(report.test_exit_code, 0);
  assert.ok(report.protected_violations.some((entry) => entry.includes("tests/auth.test.js")));
});
