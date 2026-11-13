import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMarketRound,
  bidCommitment,
  bidNonce,
  bidPayload,
  selectWinner,
} from "./market.ts";

test("market rejects duplicate commitments", () => {
  const round = buildMarketRound();
  assert.equal(round.duplicate_commitments.length, 1);
  assert.equal(round.duplicate_commitments[0].reason.includes("duplicate"), true);
  const workerCommitments = round.commitments.map((entry) => entry.worker);
  assert.equal(new Set(workerCommitments).size, workerCommitments.length);
});

test("invalid reveal is rejected and excluded from selection", () => {
  const round = buildMarketRound();
  assert.equal(round.invalid_reveals.length, 1);
  assert.equal(round.invalid_reveals[0].worker, "worker-chen.local");
  assert.equal(round.valid_bids.some((bid) => bid.worker === "worker-chen.local"), false);
});

test("late reveal is rejected", () => {
  const round = buildMarketRound();
  assert.equal(round.late_reveals.length, 1);
  assert.equal(round.late_reveals[0].worker, "worker-bruno.local");
  assert.equal(round.valid_bids.some((bid) => bid.worker === "worker-bruno.local"), false);
});

test("lowest valid bid selects the adversarial worker", () => {
  const round = buildMarketRound();
  assert.equal(round.winner, "worker-eve.local");
  const sorted = [...round.valid_bids].sort((a, b) => {
    const diff = BigInt(a.amount) - BigInt(b.amount);
    return diff < 0n ? -1 : diff > 0n ? 1 : 0;
  });
  assert.equal(sorted[0].worker, round.winner);
});

test("tie-break is deterministic by account id", () => {
  const winner = selectWinner([
    { worker: "worker-z.local", amount: "100" },
    { worker: "worker-a.local", amount: "100" },
    { worker: "worker-m.local", amount: "200" },
  ]);
  assert.equal(winner?.worker, "worker-a.local");
});

test("selection excludes invalid bids", () => {
  const round = buildMarketRound();
  const validWorkers = new Set(round.valid_bids.map((bid) => bid.worker));
  for (const invalid of round.invalid_reveals) {
    assert.equal(validWorkers.has(invalid.worker), false);
  }
  for (const late of round.late_reveals) {
    assert.equal(validWorkers.has(late.worker), false);
  }
});

test("transcript hash is reproducible and binds bid payloads", () => {
  const first = buildMarketRound();
  const second = buildMarketRound();
  assert.equal(first.transcript_hash, second.transcript_hash);
  const payload = bidPayload(first.round_id, "worker-eve.local", "1", "nonce");
  const commitment = bidCommitment(first.round_id, "worker-eve.local", "1", "nonce");
  assert.equal(commitment.commitment, bidCommitment(first.round_id, "worker-eve.local", "1", "nonce").commitment);
  assert.equal(payload.includes("caliper-bid-v1"), true);
  assert.notEqual(bidNonce(first.round_id, "worker-eve.local"), bidNonce(first.round_id, "worker-ada.local"));
});
