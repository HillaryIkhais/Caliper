import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const ATTESTATION_VERSION = "caliper-attestation-v1";
export const RUNNER_VERSION = "caliper-runner-v1";

export interface AttestationFields {
  version: string;
  job_id: number;
  attempt: number;
  deliverable_hash: string;
  acceptance_criteria_hash: string;
  baseline_commit: string;
  acceptance_suite_hash: string;
  diff_hash: string;
  protected_files_clean: boolean;
  test_exit_code: number;
  runner_version: string;
  passed: boolean;
}

export interface VerificationAttestation extends AttestationFields {
  report_digest: string;
  verifier_public_key: string;
  signature: string;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Prefixed(data: string | Buffer): string {
  return `sha256:${sha256Hex(data)}`;
}

export function canonicalAttestationBody(a: AttestationFields): string {
  return [
    a.version,
    a.job_id,
    a.attempt,
    a.deliverable_hash,
    a.acceptance_criteria_hash,
    a.baseline_commit,
    a.acceptance_suite_hash,
    a.diff_hash,
    a.protected_files_clean ? "1" : "0",
    a.test_exit_code,
    a.runner_version,
    a.passed ? "1" : "0",
  ].join("|");
}

export function canonicalReportDigest(body: string): string {
  return sha256Prefixed(body);
}

export function canonicalAttestationMessage(a: VerificationAttestation): string {
  return [canonicalAttestationBody(a), a.report_digest, a.verifier_public_key].join("|");
}

export function publicKeyHexFromPrivate(privateKey: KeyObject): string {
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return Buffer.from(der).subarray(-32).toString("hex");
}

export function publicKeyObjectFromHex(publicKeyHex: string): KeyObject {
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  const raw = Buffer.from(publicKeyHex, "hex");
  if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return createPublicKey({
    key: Buffer.concat([prefix, raw]),
    format: "der",
    type: "spki",
  });
}

export function signAttestation(
  fields: AttestationFields,
  privateKey: KeyObject,
): VerificationAttestation {
  const body = canonicalAttestationBody(fields);
  const report_digest = canonicalReportDigest(body);
  const verifier_public_key = publicKeyHexFromPrivate(privateKey);
  const unsigned: VerificationAttestation = {
    ...fields,
    report_digest,
    verifier_public_key,
    signature: "",
  };
  const message = canonicalAttestationMessage(unsigned);
  unsigned.signature = cryptoSign(null, Buffer.from(message), privateKey).toString("hex");
  return unsigned;
}

export function verifyAttestationSignature(attestation: VerificationAttestation): boolean {
  try {
    const body = canonicalAttestationBody(attestation);
    if (attestation.report_digest !== canonicalReportDigest(body)) return false;
    const message = canonicalAttestationMessage(attestation);
    return cryptoVerify(
      null,
      Buffer.from(message),
      publicKeyObjectFromHex(attestation.verifier_public_key),
      Buffer.from(attestation.signature, "hex"),
    );
  } catch {
    return false;
  }
}

export interface AttestationExpected {
  job_id: number;
  attempt: number;
  deliverable_hash: string;
  acceptance_criteria_hash: string;
  baseline_commit: string;
  acceptance_suite_hash: string;
  verifier_public_key: string;
}

export function attestationMismatches(
  attestation: VerificationAttestation,
  expected: AttestationExpected,
): string[] {
  const mismatches: string[] = [];
  if (attestation.version !== ATTESTATION_VERSION) mismatches.push("version");
  if (attestation.job_id !== expected.job_id) mismatches.push("job_id");
  if (attestation.attempt !== expected.attempt) mismatches.push("attempt");
  if (attestation.deliverable_hash !== expected.deliverable_hash) mismatches.push("deliverable_hash");
  if (attestation.acceptance_criteria_hash !== expected.acceptance_criteria_hash) {
    mismatches.push("acceptance_criteria_hash");
  }
  if (attestation.baseline_commit !== expected.baseline_commit) mismatches.push("baseline_commit");
  if (attestation.acceptance_suite_hash !== expected.acceptance_suite_hash) {
    mismatches.push("acceptance_suite_hash");
  }
  if (attestation.verifier_public_key !== expected.verifier_public_key) {
    mismatches.push("verifier_public_key");
  }
  if (attestation.passed !== (attestation.protected_files_clean && attestation.test_exit_code === 0)) {
    mismatches.push("outcome");
  }
  return mismatches;
}

export interface VerifierKey {
  privateKey: KeyObject;
  publicKeyHex: string;
  privateKeyPath: string;
  publicKeyPath: string;
  generated: boolean;
}

export function loadOrCreateVerifierKey(keyDir: string): VerifierKey {
  fs.mkdirSync(keyDir, { recursive: true });
  const privateKeyPath = path.join(keyDir, "verifier.pem");
  const publicKeyPath = path.join(keyDir, "verifier.pub.hex");

  if (fs.existsSync(privateKeyPath)) {
    const privateKey = createPrivateKey(fs.readFileSync(privateKeyPath));
    const publicKeyHex = publicKeyHexFromPrivate(privateKey);
    if (!fs.existsSync(publicKeyPath)) fs.writeFileSync(publicKeyPath, publicKeyHex + "\n");
    return { privateKey, publicKeyHex, privateKeyPath, publicKeyPath, generated: false };
  }

  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  fs.writeFileSync(privateKeyPath, pem, { mode: 0o600 });
  const publicKeyHex = publicKeyHexFromPrivate(privateKey);
  fs.writeFileSync(publicKeyPath, publicKeyHex + "\n");
  return { privateKey, publicKeyHex, privateKeyPath, publicKeyPath, generated: true };
}
