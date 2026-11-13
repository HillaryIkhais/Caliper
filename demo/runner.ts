import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { KeyObject } from "node:crypto";
import {
  ATTESTATION_VERSION,
  RUNNER_VERSION,
  sha256Hex,
  sha256Prefixed,
  signAttestation,
  type VerificationAttestation,
} from "../shared/attestation.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_DIR = path.join(HERE, "fixture");
export const BASELINE_DIR = path.join(FIXTURE_DIR, "baseline");
export const DEFAULT_MANIFEST_PATH = path.join(FIXTURE_DIR, "manifest.json");

export interface AcceptanceManifest {
  version: string;
  task: string;
  baseline_commit: string;
  test_command: string[];
  ci_command: string[];
  acceptance_suite: string;
  protected_files: string[];
  acceptance_criteria: string;
}

export interface ChangedFile {
  status: string;
  path: string;
}

export interface ManipulationEvidence {
  deleted_tests: string[];
  weakened_assertions: string[];
  disabled_ci: string[];
}

export interface VerificationReport {
  report_version: string;
  job_id: number;
  attempt: number;
  task: string;
  baseline_commit: string;
  acceptance_criteria_hash: string;
  acceptance_suite_hash: string;
  deliverable_hash: string;
  claimed_deliverable_hash: string;
  deliverable_matches_claim: boolean;
  changed_files: ChangedFile[];
  diff_hash: string;
  protected_files: string[];
  protected_violations: string[];
  manipulation: ManipulationEvidence;
  test_command: string[];
  test_exit_code: number;
  test_stdout: string;
  test_stderr: string;
  ci_command: string[];
  ci_exit_code: number;
  ci_stdout: string;
  ci_stderr: string;
  passed: boolean;
  passed_checks: string[];
  attestation: VerificationAttestation;
}

export interface VerifyOptions {
  job_id: number;
  attempt: number;
  candidateDir: string;
  claimedDeliverableHash: string;
  acceptanceCriteriaHash: string;
  acceptanceSuiteHash: string;
  verifierPrivateKey: KeyObject;
  baselineDir?: string;
  manifestPath?: string;
  workDir?: string;
  reportPath?: string;
}

export function loadManifest(manifestPath = DEFAULT_MANIFEST_PATH): AcceptanceManifest {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as AcceptanceManifest;
}

function walkFiles(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? path.join(base, entry.name) : entry.name;
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    if (entry.isDirectory()) out.push(...walkFiles(dir, rel));
    else if (entry.isFile()) out.push(rel.split(path.sep).join("/"));
  }
  return out.sort();
}

export function hashTree(dir: string): string {
  const lines: string[] = [];
  for (const rel of walkFiles(dir)) {
    const hash = sha256Hex(fs.readFileSync(path.join(dir, rel)));
    lines.push(`${rel}\u0000${hash}`);
  }
  return sha256Prefixed(lines.join("\n"));
}

export function protectedPatterns(manifest: AcceptanceManifest): string[] {
  return manifest.protected_files;
}

export function matchesProtected(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      return file === prefix || file.startsWith(prefix + "/");
    }
    return file === pattern;
  });
}

export function computeAcceptanceSuiteHash(
  baselineDir = BASELINE_DIR,
  manifest = loadManifest(),
): string {
  const lines: string[] = [];
  for (const rel of walkFiles(baselineDir)) {
    if (!matchesProtected(rel, manifest.protected_files)) continue;
    lines.push(`${rel}\u0000${sha256Hex(fs.readFileSync(path.join(baselineDir, rel)))}`);
  }
  return sha256Prefixed(lines.join("\n"));
}

export function computeAcceptanceCriteriaHash(
  manifest = loadManifest(),
  baselineDir = BASELINE_DIR,
): string {
  const criteriaPath = path.join(path.dirname(baselineDir), manifest.acceptance_criteria);
  return sha256Prefixed(fs.readFileSync(criteriaPath, "utf8"));
}

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dest);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
}

function clearTreeExceptGit(dir: string): void {
  for (const entry of fs.readdirSync(dir)) {
    if (entry === ".git") continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function parseNameStatus(output: string): ChangedFile[] {
  const changes: ChangedFile[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length >= 2) changes.push({ status: parts[0], path: parts.slice(1).join("/") });
  }
  return changes;
}

function assertionCount(text: string): number {
  return (text.match(/assert\.[A-Za-z]+/g) ?? []).length;
}

function testNames(text: string): string[] {
  const names: string[] = [];
  const regex = /\btest\(\s*["'`]([^"'`]+)["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) names.push(match[1]);
  return names;
}

function weakenedAssertionReasons(baseline: string, candidate: string): string[] {
  const reasons: string[] = [];
  if (assertionCount(candidate) < assertionCount(baseline)) {
    reasons.push("fewer assertions than the pinned suite");
  }
  for (const name of testNames(baseline)) {
    if (!testNames(candidate).includes(name)) reasons.push(`removed test "${name}"`);
  }
  if (/assert\.(ok|equal|strictEqual|deepEqual)\(\s*(true\s*,\s*true|1\s*,\s*1)\s*\)/.test(candidate)) {
    reasons.push("replaced a requirement with a tautological assertion");
  }
  if (/assert\.ok\(\s*true\s*\)/.test(candidate)) {
    reasons.push("weakened an assertion to assert.ok(true)");
  }
  return reasons;
}

function disabledCiReasons(baseline: string, candidate: string): string[] {
  const reasons: string[] = [];
  if (baseline.includes("CI FAIL") && !candidate.includes("CI FAIL")) {
    reasons.push("removed the CI failure condition");
  }
  if (/if\s*\(\s*false\s*\)/.test(candidate)) reasons.push("disabled the CI condition");
  if (/\/\/\s*disabled/i.test(candidate)) reasons.push("marked the CI check as disabled");
  if (/process\.exit\(\s*0\s*\)/.test(candidate) && !candidate.includes("CI FAIL")) {
    reasons.push("forced the CI check to exit successfully");
  }
  return reasons;
}

function detectManipulation(
  baselineDir: string,
  tempDir: string,
  manifest: AcceptanceManifest,
  changes: ChangedFile[],
): { protected_violations: string[]; manipulation: ManipulationEvidence } {
  const protected_violations: string[] = [];
  const manipulation: ManipulationEvidence = {
    deleted_tests: [],
    weakened_assertions: [],
    disabled_ci: [],
  };

  for (const change of changes) {
    if (!matchesProtected(change.path, manifest.protected_files)) continue;
    protected_violations.push(`${change.status} ${change.path}`);

    const baselinePath = path.join(baselineDir, change.path);
    const candidatePath = path.join(tempDir, change.path);

    if (change.status.startsWith("D")) {
      if (change.path.startsWith("tests/")) manipulation.deleted_tests.push(change.path);
      if (change.path.startsWith("ci/")) manipulation.disabled_ci.push(`${change.path}: deleted`);
      continue;
    }

    const baseline = fs.existsSync(baselinePath) ? fs.readFileSync(baselinePath, "utf8") : "";
    const candidate = fs.existsSync(candidatePath) ? fs.readFileSync(candidatePath, "utf8") : "";

    if (change.path.startsWith("tests/")) {
      for (const reason of weakenedAssertionReasons(baseline, candidate)) {
        manipulation.weakened_assertions.push(`${change.path}: ${reason}`);
      }
    }
    if (change.path.startsWith("ci/") || change.path.includes(".github/workflows")) {
      for (const reason of disabledCiReasons(baseline, candidate)) {
        manipulation.disabled_ci.push(`${change.path}: ${reason}`);
      }
    }
  }

  return { protected_violations, manipulation };
}

function restoreProtectedFiles(
  baselineDir: string,
  tempDir: string,
  manifest: AcceptanceManifest,
): void {
  for (const rel of walkFiles(baselineDir)) {
    if (!matchesProtected(rel, manifest.protected_files)) continue;
    const dest = path.join(tempDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(baselineDir, rel), dest);
  }
  for (const rel of walkFiles(tempDir)) {
    if (!matchesProtected(rel, manifest.protected_files)) continue;
    if (!fs.existsSync(path.join(baselineDir, rel))) {
      fs.rmSync(path.join(tempDir, rel), { force: true });
    }
  }
}

function runCheckedCommand(
  command: string[],
  cwd: string,
): { exit_code: number; stdout: string; stderr: string } {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      TMPDIR: os.tmpdir(),
      NODE_ENV: "test",
      CI: "1",
      // Intentionally do not forward wallet keys, API keys, or the host environment.
    },
  });
  const timedOut = result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  return {
    exit_code: result.status ?? (timedOut ? 124 : 1),
    stdout: (result.stdout ?? "").slice(0, 8000),
    stderr: (result.stderr ?? "").slice(0, 8000),
  };
}

export function verifyArtifact(options: VerifyOptions): VerificationReport {
  const baselineDir = options.baselineDir ?? BASELINE_DIR;
  const manifest = loadManifest(options.manifestPath ?? DEFAULT_MANIFEST_PATH);
  const workRoot = options.workDir ?? os.tmpdir();
  fs.mkdirSync(workRoot, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(workRoot, "caliper-run-"));
  const repoDir = path.join(tempRoot, "repo");

  try {
    copyTree(baselineDir, repoDir);
    run("git", ["init", "-q"], repoDir);
    run("git", ["config", "user.email", "runner@caliper.local"], repoDir);
    run("git", ["config", "user.name", "CALIPER Runner"], repoDir);
    run("git", ["add", "-A"], repoDir);
    run("git", ["commit", "-q", "-m", "pinned baseline"], repoDir);

    const actualDeliverableHash = hashTree(options.candidateDir);
    clearTreeExceptGit(repoDir);
    copyTree(options.candidateDir, repoDir);
    run("git", ["add", "-A"], repoDir);

    const nameStatus = run("git", ["diff", "--cached", "--name-status", "HEAD"], repoDir);
    const diff = run(
      "git",
      ["diff", "--cached", "--no-color", "--no-ext-diff", "--binary", "--full-index", "HEAD"],
      repoDir,
    );
    const changes = parseNameStatus(nameStatus);
    const diffHash = sha256Prefixed(diff);
    const { protected_violations, manipulation } = detectManipulation(
      baselineDir,
      repoDir,
      manifest,
      changes,
    );

    // The runner always executes the pinned acceptance suite, never the worker's
    // replacement, even when the worker modified or deleted it.
    restoreProtectedFiles(baselineDir, repoDir, manifest);
    const testRun = runCheckedCommand(manifest.test_command, repoDir);
    const ciRun = runCheckedCommand(manifest.ci_command, repoDir);

    const deliverableMatchesClaim = actualDeliverableHash === options.claimedDeliverableHash;
    const clean = protected_violations.length === 0;
    const passed =
      deliverableMatchesClaim &&
      clean &&
      testRun.exit_code === 0 &&
      ciRun.exit_code === 0;
    const combinedExit =
      testRun.exit_code === 0 ? ciRun.exit_code : testRun.exit_code;

    const passedChecks: string[] = [];
    if (deliverableMatchesClaim) passedChecks.push("artifact matches submitted hash");
    if (clean) passedChecks.push("no protected files changed");
    if (testRun.exit_code === 0) passedChecks.push("pinned acceptance suite passed");
    if (ciRun.exit_code === 0) passedChecks.push("pinned CI check passed");

    const attestation = signAttestation(
      {
        version: ATTESTATION_VERSION,
        job_id: options.job_id,
        attempt: options.attempt,
        deliverable_hash: options.claimedDeliverableHash,
        acceptance_criteria_hash: options.acceptanceCriteriaHash,
        baseline_commit: manifest.baseline_commit,
        acceptance_suite_hash: options.acceptanceSuiteHash,
        diff_hash: diffHash,
        protected_files_clean: clean,
        test_exit_code: combinedExit,
        runner_version: RUNNER_VERSION,
        passed,
      },
      options.verifierPrivateKey,
    );

    const report: VerificationReport = {
      report_version: RUNNER_VERSION,
      job_id: options.job_id,
      attempt: options.attempt,
      task: manifest.task,
      baseline_commit: manifest.baseline_commit,
      acceptance_criteria_hash: options.acceptanceCriteriaHash,
      acceptance_suite_hash: options.acceptanceSuiteHash,
      deliverable_hash: actualDeliverableHash,
      claimed_deliverable_hash: options.claimedDeliverableHash,
      deliverable_matches_claim: deliverableMatchesClaim,
      changed_files: changes,
      diff_hash: diffHash,
      protected_files: manifest.protected_files,
      protected_violations,
      manipulation,
      test_command: manifest.test_command,
      test_exit_code: testRun.exit_code,
      test_stdout: testRun.stdout,
      test_stderr: testRun.stderr,
      ci_command: manifest.ci_command,
      ci_exit_code: ciRun.exit_code,
      ci_stdout: ciRun.stdout,
      ci_stderr: ciRun.stderr,
      passed,
      passed_checks: passedChecks,
      attestation,
    };

    if (options.reportPath) {
      fs.mkdirSync(path.dirname(options.reportPath), { recursive: true });
      fs.writeFileSync(options.reportPath, JSON.stringify(report, null, 2) + "\n");
    }
    return report;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
