import { sha256Hex, sha256Prefixed } from "../shared/attestation.ts";
import { hashCanonical } from "../shared/canonical.ts";

export const BID_VERSION = "caliper-bid-v1";
export const NEAR = 10n ** 24n;

export interface WorkerAgent {
  account: string;
  display_name: string;
  strategy: string;
  adversarial: boolean;
}

export const WORKERS: WorkerAgent[] = [
  {
    account: "worker-ada.local",
    display_name: "Ada",
    strategy: "balanced",
    adversarial: false,
  },
  {
    account: "worker-bruno.local",
    display_name: "Bruno",
    strategy: "premium",
    adversarial: false,
  },
  {
    account: "worker-chen.local",
    display_name: "Chen",
    strategy: "lowball-invalid",
    adversarial: false,
  },
  {
    account: "worker-dara.local",
    display_name: "Dara",
    strategy: "close-second",
    adversarial: false,
  },
  {
    account: "worker-eve.local",
    display_name: "Eve",
    strategy: "adversarial-underbid",
    adversarial: true,
  },
];

export interface BidCommitment {
  worker: string;
  commitment: string;
  payload_hash: string;
}

export interface BidReveal {
  worker: string;
  amount: string;
  nonce: string;
  commitment: string;
  on_time: boolean;
  valid: boolean;
  reason?: string;
}

export interface MarketRound {
  version: string;
  round_id: string;
  task: string;
  max_budget: string;
  eligible_workers: string[];
  commitments: BidCommitment[];
  duplicate_commitments: { worker: string; commitment: string; reason: string }[];
  reveals: BidReveal[];
  invalid_reveals: { worker: string; reason: string }[];
  late_reveals: { worker: string; reason: string }[];
  valid_bids: { worker: string; amount: string }[];
  selection_rule: string;
  winner: string;
  transcript_hash: string;
}

export function nearFromTenths(tenths: bigint): string {
  return ((tenths * NEAR) / 10n).toString();
}

export function formatNear(yocto: string): string {
  const value = BigInt(yocto);
  const whole = value / NEAR;
  const fraction = (value % NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction.slice(0, 4)} NEAR` : `${whole} NEAR`;
}

export function bidNonce(roundId: string, worker: string): string {
  return sha256Hex(`${roundId}:${worker}:nonce`).slice(0, 32);
}

export function bidPayload(
  roundId: string,
  worker: string,
  amount: string,
  nonce: string,
): string {
  return [BID_VERSION, roundId, worker, amount, nonce].join("|");
}

export function bidCommitment(
  roundId: string,
  worker: string,
  amount: string,
  nonce: string,
): { commitment: string; payload_hash: string } {
  const payload = bidPayload(roundId, worker, amount, nonce);
  return {
    commitment: sha256Prefixed(payload),
    payload_hash: sha256Prefixed(JSON.stringify({ payload, commitment: sha256Prefixed(payload) })),
  };
}

function amountFor(strategy: string): string {
  switch (strategy) {
    case "balanced":
      return nearFromTenths(150n);
    case "premium":
      return nearFromTenths(185n);
    case "lowball-invalid":
      return nearFromTenths(90n);
    case "close-second":
      return nearFromTenths(120n);
    case "adversarial-underbid":
      return nearFromTenths(118n);
    default:
      throw new Error(`unknown bidding strategy: ${strategy}`);
  }
}

export function selectWinner(
  bids: { worker: string; amount: string }[],
): { worker: string; amount: string } | null {
  if (bids.length === 0) return null;
  return [...bids].sort((a, b) => {
    const diff = BigInt(a.amount) - BigInt(b.amount);
    if (diff < 0n) return -1;
    if (diff > 0n) return 1;
    return a.worker < b.worker ? -1 : a.worker > b.worker ? 1 : 0;
  })[0];
}

export function transcriptHash(round: Omit<MarketRound, "transcript_hash">): string {
  return hashCanonical(round);
}

export function buildMarketRound(
  roundId = "round-auth-001",
  task = "Fix the billing authorization bypass in src/auth.js",
  maxBudget = nearFromTenths(200n),
): MarketRound {
  const commitments: BidCommitment[] = [];
  const reveals: BidReveal[] = [];
  const invalidReveals: { worker: string; reason: string }[] = [];
  const lateReveals: { worker: string; reason: string }[] = [];
  const validBids: { worker: string; amount: string }[] = [];

  for (const worker of WORKERS) {
    const amount = amountFor(worker.strategy);
    const nonce = bidNonce(roundId, worker.account);
    const { commitment, payload_hash } = bidCommitment(roundId, worker.account, amount, nonce);
    commitments.push({ worker: worker.account, commitment, payload_hash });

    if (worker.strategy === "lowball-invalid") {
      const badNonce = sha256Hex(`${roundId}:${worker.account}:wrong`).slice(0, 32);
      const invalid: BidReveal = {
        worker: worker.account,
        amount,
        nonce: badNonce,
        commitment,
        on_time: true,
        valid: false,
        reason: "revealed nonce does not match the sealed commitment",
      };
      reveals.push(invalid);
      invalidReveals.push({ worker: worker.account, reason: invalid.reason! });
      continue;
    }

    if (worker.strategy === "premium") {
      const late: BidReveal = {
        worker: worker.account,
        amount,
        nonce,
        commitment,
        on_time: false,
        valid: false,
        reason: "reveal arrived after the reveal phase closed",
      };
      reveals.push(late);
      lateReveals.push({ worker: worker.account, reason: late.reason! });
      continue;
    }

    const reveal: BidReveal = {
      worker: worker.account,
      amount,
      nonce,
      commitment,
      on_time: true,
      valid: true,
    };
    reveals.push(reveal);
    validBids.push({ worker: worker.account, amount });
  }

  const winner = selectWinner(validBids);
  if (!winner) throw new Error("market produced no valid winner");

  const duplicateWorker = WORKERS[0];
  const duplicateAmount = amountFor(duplicateWorker.strategy);
  const duplicateNonce = bidNonce(roundId, duplicateWorker.account);
  const duplicateCommitment = bidCommitment(
    roundId,
    duplicateWorker.account,
    duplicateAmount,
    duplicateNonce,
  ).commitment;

  const base: Omit<MarketRound, "transcript_hash"> = {
    version: "caliper-market-v1",
    round_id: roundId,
    task,
    max_budget: maxBudget,
    eligible_workers: WORKERS.map((worker) => worker.account),
    commitments,
    duplicate_commitments: [
      {
        worker: duplicateWorker.account,
        commitment: duplicateCommitment,
        reason: "duplicate commitment ignored after first sealed bid",
      },
    ],
    reveals,
    invalid_reveals: invalidReveals,
    late_reveals: lateReveals,
    valid_bids: validBids,
    selection_rule: "lowest valid bid; ties broken by lexicographically smallest worker account",
    winner: winner.worker,
  };

  return { ...base, transcript_hash: transcriptHash(base) };
}
