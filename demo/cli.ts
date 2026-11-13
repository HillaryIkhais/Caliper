import { runSwarm } from "./swarm.ts";

const run = runSwarm();
const rejected = run.attempts.filter((attempt) => attempt.chain_status === "Rejected").length;
const paid = run.payment.state === "Paid";

console.log("");
console.log("CALIPER adversarial swarm demonstration");
console.log("---------------------------------------");
console.log(`mode:              ${run.mode}`);
console.log(`market winner:     ${run.identities.selected_worker.account} (${run.identities.selected_worker.display_name})`);
console.log(`market transcript: ${run.market.transcript_hash}`);
console.log(`job:               ${run.job.id}`);
console.log(`attempt 1:         ${run.attempts[0].chain_status} — ${run.attempts[0].outcome}`);
console.log(`  protected violations: ${run.attempts[0].report.protected_violations.join(", ") || "none"}`);
console.log(`  weakened assertions:  ${run.attempts[0].report.manipulation.weakened_assertions.join("; ") || "none"}`);
console.log(`  disabled CI:          ${run.attempts[0].report.manipulation.disabled_ci.join("; ") || "none"}`);
console.log(`attempt 2:         ${run.attempts[1].chain_status} — ${run.attempts[1].outcome}`);
console.log(`payment:           ${run.payment.state} (${run.payment.note})`);
console.log(`rejected attempts: ${rejected}`);
console.log(`receipt:           ${run.payment.receipt_id}`);
console.log("");
console.log(`Run state: ${run.files.run_json}`);
console.log(`Reports:   ${run.files.attempt_1_report}, ${run.files.attempt_2_report}`);
console.log("");
if (!paid || rejected !== 1) {
  console.error("FAIL: the demonstration did not reach the expected verified settlement.");
  process.exit(1);
}
console.log("PASS: manipulation detected, payment blocked, correction verified, settlement confirmed.");
