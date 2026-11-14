import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runSwarm } from "./swarm.ts";
import { LocalCaliperChain } from "./local-chain.ts";
import {
  loadManifest,
  computeAcceptanceCriteriaHash,
  computeAcceptancePolicyHash,
  verifyArtifact,
  type VerificationReport,
} from "./runner.ts";
import { loadOrCreateVerifierKey } from "../shared/attestation.ts";
import { buildMarketRound } from "./market.ts";
import { nearFromTenths } from "./market.ts";
import { hashTree } from "./runner.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const WEB_DIR = path.resolve(REPO_ROOT, "web");
const RUNS_DIR = path.join(HERE, "runs");
const KEY_DIR = path.join(REPO_ROOT, ".caliper", "keys");
const PORT = Number(process.env.CALIPER_PORT ?? 4317);
const HOST = process.env.CALIPER_HOST ?? "127.0.0.1";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------- Interactive session state ----------
// Each session is an independent LocalCaliperChain + workflow state.
// Keyed by a session id cookie/header.
interface Session {
  chain: LocalCaliperChain;
  key: { publicKeyHex: string; privateKey: unknown };
  market: ReturnType<typeof buildMarketRound>;
  step: "idle" | "task_posted" | "bids_open" | "winner_selected" | "delivered" | "verified" | "settled" | "rejected";
  task: {
    title: string;
    acceptance_criteria: string;
    acceptance_criteria_hash: string;
    acceptance_suite_hash: string;
    baseline_commit: string;
    protected_files: string[];
    max_budget: string;
  } | null;
  jobId: number | null;
  winnerAccount: string | null;
  winnerNode: number | null;
  deliverableHash: string | null;
  attempts: Array<{
    attempt: number;
    worker_claim: { passed: boolean; summary: string; claimed_by: string };
    deliverable_hash: string;
    report: VerificationReport;
    chain_status: string;
    outcome: string;
  }>;
}

const sessions = new Map<string, Session>();

function getOrCreateSession(sessionId: string): Session {
  let session = sessions.get(sessionId);
  if (!session) {
    const chain = new LocalCaliperChain("owner.caliper.local");
    const rootAllocation = nearFromTenths(1000n);
    const root = chain.createRoot("coordinator.caliper.local", rootAllocation, {
      recipients: ["vendor.caliper.local"],
      assets: [],
      max_per_tx: rootAllocation,
      may_delegate: true,
    });
    const key = loadOrCreateVerifierKey(KEY_DIR);
    const manifest = loadManifest();
    const baselineDir = path.join(HERE, "fixture", "baseline");
    const acceptanceCriteriaHash = computeAcceptanceCriteriaHash(manifest, baselineDir);
    const acceptanceSuiteHash = computeAcceptancePolicyHash(baselineDir, manifest);
    const market = buildMarketRound();
    session = {
      chain,
      key,
      market,
      step: "idle",
      task: null,
      jobId: null,
      winnerAccount: null,
      winnerNode: null,
      deliverableHash: null,
      attempts: [],
    };
    sessions.set(sessionId, session);
  }
  return session;
}

function sessionIdFromReq(req: http.IncomingMessage): string {
  const cookie = req.headers.cookie ?? "";
  const match = cookie.match(/(?:^|; )caliper_session=([^;]+)/);
  return match ? match[1] : `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function setSessionCookie(res: http.ServerResponse, sessionId: string): void {
  res.setHeader(
    "Set-Cookie",
    `caliper_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
  );
}

// ---------- Static file serving ----------
function serveStatic(res: http.ServerResponse, urlPath: string): void {
  const clean = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
  const relative = clean === "" ? "index.html" : clean;
  const file = path.resolve(WEB_DIR, relative);
  if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const index = path.join(WEB_DIR, "index.html");
    if (!fs.existsSync(index)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(fs.readFileSync(index));
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(fs.readFileSync(file));
}

// ---------- API handlers ----------
async function handleTaskPost(
  res: http.ServerResponse,
  session: Session,
  body: string,
): Promise<void> {
  if (session.step !== "idle") {
    sendJson(res, 400, { error: "session already has an active task" });
    return;
  }
  let payload: {
    title?: string;
    acceptance_criteria?: string;
    protected_files?: string[];
    max_budget?: string;
  };
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "invalid JSON" });
    return;
  }
  if (!payload.title || !payload.acceptance_criteria) {
    sendJson(res, 400, { error: "title and acceptance_criteria required" });
    return;
  }

  const manifest = loadManifest();
  const baselineDir = path.join(HERE, "fixture", "baseline");
  const acceptanceCriteriaHash = computeAcceptanceCriteriaHash(
    manifest,
    baselineDir,
  );
  const acceptanceSuiteHash = computeAcceptancePolicyHash(baselineDir, manifest);
  const maxBudget = payload.max_budget ?? market.max_budget;

  session.task = {
    title: payload.title,
    acceptance_criteria: payload.acceptance_criteria,
    acceptance_criteria_hash: acceptanceCriteriaHash,
    acceptance_suite_hash: acceptanceSuiteHash,
    baseline_commit: manifest.baseline_commit,
    protected_files: payload.protected_files ?? manifest.protected_files,
    max_budget: maxBudget,
  };
  session.step = "task_posted";

  setSessionCookie(res, `sess-${Date.now()}`);
  sendJson(res, 200, {
    step: session.step,
    task: session.task,
    market: {
      winner: session.market.winner,
      winner_bid: session.market.winner_bid,
      valid_bids: session.market.valid_bids,
      transcript_hash: session.market.transcript_hash,
    },
  });
}

async function handleBid(
  res: http.ServerResponse,
  session: Session,
  body: string,
): Promise<void> {
  if (session.step !== "task_posted") {
    sendJson(res, 400, { error: "no task posted yet" });
    return;
  }
  let payload: { worker: string; amount: string };
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "invalid JSON" });
    return;
  }
  if (!payload.worker || !payload.amount) {
    sendJson(res, 400, { error: "worker and amount required" });
    return;
  }
  const bid = session.market.valid_bids.find(
    (b) => b.worker === payload.worker && b.amount === payload.amount,
  );
  if (!bid) {
    sendJson(res, 400, { error: "invalid bid" });
    return;
  }
  session.step = "bids_open";
  setSessionCookie(res, `sess-${Date.now()}`);
  sendJson(res, 200, { step: session.step, bid });
}

async function handleSelect(
  res: http.ServerResponse,
  session: Session,
  body: string,
): Promise<void> {
  if (session.step !== "bids_open") {
    sendJson(res, 400, { error: "no bids open" });
    return;
  }
  let payload: { worker: string };
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "invalid JSON" });
    return;
  }
  const bid = session.market.winner_bid;
  if (bid.worker !== payload.worker) {
    sendJson(res, 400, { error: "can only select the canonical winning bid" });
    return;
  }

  const manifest = loadManifest();
  const baselineDir = path.join(HERE, "fixture", "baseline");
  const chain = session.chain;
  const rootAllocation = nearFromTenths(1000n);
  const root = chain.createRoot("coordinator.caliper.local", rootAllocation, {
    recipients: ["vendor.caliper.local"],
    assets: [],
    max_per_tx: rootAllocation,
    may_delegate: true,
  });
  const workerNode = chain.delegate(
    root,
    payload.worker,
    nearFromTenths(80n),
    { recipients: ["vendor.caliper.local"], assets: [], max_per_tx: nearFromTenths(80n), may_delegate: true },
  );
  const verifierNode = chain.delegate(
    root,
    "verifier.caliper.local",
    nearFromTenths(100n),
    { recipients: ["vendor.caliper.local"], assets: [], max_per_tx: nearFromTenths(100n), may_delegate: true },
  );

  const settlementAmount = BigInt(bid.amount);
  const escrowBudget = BigInt(session.task.max_budget);
  if (settlementAmount > escrowBudget) {
    sendJson(res, 400, { error: "winning bid exceeds escrowed budget" });
    return;
  }

  const jobId = chain.createJob({
    coordinator_node: root,
    worker_node: workerNode,
    verifier_node: verifierNode,
    verifier_public_key: session.key.publicKeyHex,
    budget: escrowBudget.toString(),
    winning_bid: settlementAmount.toString(),
    acceptance_criteria_hash: session.task.acceptance_criteria_hash,
    acceptance_suite_hash: session.task.acceptance_suite_hash,
    baseline_commit: session.task.baseline_commit,
    market_transcript_hash: session.market.transcript_hash,
    protected_files: session.task.protected_files,
  });

  session.jobId = jobId;
  session.winnerAccount = payload.worker;
  session.winnerNode = workerNode;
  session.step = "winner_selected";

  setSessionCookie(res, `sess-${Date.now()}`);
  sendJson(res, 200, {
    step: session.step,
    job_id: jobId,
    worker: payload.worker,
    budget: escrowBudget.toString(),
    winning_bid: settlementAmount.toString(),
  });
}

async function handleDeliver(
  res: http.ServerResponse,
  session: Session,
  body: string,
): Promise<void> {
  if (session.step !== "winner_selected") {
    sendJson(res, 400, { error: "no winner selected" });
    return;
  }
  let payload: { artifact: "tampered" | "corrected"; worker: string; summary?: string };
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "invalid JSON" });
    return;
  }
  if (!payload.artifact || !payload.worker) {
    sendJson(res, 400, { error: "artifact and worker required" });
    return;
  }
  if (payload.worker !== session.winnerAccount) {
    sendJson(res, 400, { error: "only the selected worker may deliver" });
    return;
  }

  const candidateDir = path.join(
    HERE,
    "fixture",
    "submissions",
    payload.artifact,
  );
  const deliverableHash = hashTree(candidateDir);

  session.chain.submitDeliverable(session.jobId!, payload.worker, deliverableHash);
  session.deliverableHash = deliverableHash;
  session.step = "delivered";

  setSessionCookie(res, `sess-${Date.now()}`);
  sendJson(res, 200, {
    step: session.step,
    attempt: session.chain.job(session.jobId!).attempt,
    deliverable_hash: deliverableHash,
  });
}

async function handleVerify(
  res: http.ServerResponse,
  session: Session,
): Promise<void> {
  if (session.step !== "delivered") {
    sendJson(res, 400, { error: "no deliverable to verify" });
    return;
  }

  const manifest = loadManifest();
  const baselineDir = path.join(HERE, "fixture", "baseline");
  const chain = session.chain;
  const job = chain.job(session.jobId!);
  const attempt = job.attempt;

  const artifactDir = path.join(
    HERE,
    "fixture",
    "submissions",
    attempt === 1 ? "tampered" : "corrected",
  );

  const reportPath = path.join(
    RUNS_DIR,
    `latest`,
    `attempt-${attempt}-report.json`,
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  const report = verifyArtifact({
    job_id: session.jobId!,
    attempt,
    candidateDir: artifactDir,
    claimedDeliverableHash: session.deliverableHash!,
    acceptanceCriteriaHash: session.task!.acceptance_criteria_hash,
    acceptanceSuiteHash: session.task!.acceptance_suite_hash,
    verifierPrivateKey: session.key.privateKey,
    baselineDir,
    reportPath,
  });

  chain.recordVerification(session.jobId!, "verifier.caliper.local", report.attestation);

  const status = chain.job(session.jobId!).status;
  const blocked = status === "Rejected";
  const exhausted = status === "Exhausted";

  session.attempts.push({
    attempt,
    worker_claim: {
      passed: true,
      summary: attempt === 1
        ? "Updated the flaky billing expectation and the CI check; all reported checks are green."
        : "Fixed src/auth.js so billing requires the admin role. The pinned suite and CI check pass unmodified.",
      claimed_by: session.winnerAccount!,
    },
    deliverable_hash: session.deliverableHash!,
    report,
    chain_status: status,
    outcome: blocked
      ? "blocked: protected acceptance files were modified"
      : exhausted
      ? "exhausted: retry limit reached"
      : "passed: genuine source fix accepted by the pinned suite",
  });

  if (blocked && attempt < 2) {
    session.step = "rejected";
    setSessionCookie(res, `sess-${Date.now()}`);
    sendJson(res, 200, {
      step: session.step,
      attempt,
      status,
      outcome: "rejected — coordinator may request changes",
      report: {
        protected_violations: report.protected_violations,
        manipulation: report.manipulation,
        test_exit_code: report.test_exit_code,
        ci_exit_code: report.ci_exit_code,
        passed: report.passed,
      },
    });
    return;
  }

  if (exhausted) {
    session.step = "settled";
    setSessionCookie(res, `sess-${Date.now()}`);
    sendJson(res, 200, {
      step: session.step,
      attempt,
      status: "Exhausted",
      outcome: "exhausted — no attempts remain, commitment released",
      report: {
        protected_violations: report.protected_violations,
        manipulation: report.manipulation,
        test_exit_code: report.test_exit_code,
        ci_exit_code: report.ci_exit_code,
        passed: report.passed,
      },
    });
    return;
  }

  session.step = "verified";
  setSessionCookie(res, `sess-${Date.now()}`);
  sendJson(res, 200, {
    step: session.step,
    attempt,
    status: "Verified",
    outcome: "verified — payment can now be released permissionlessly",
    report: {
      protected_violations: report.protected_violations,
      manipulation: report.manipulation,
      test_exit_code: report.test_exit_code,
      ci_exit_code: report.ci_exit_code,
      passed: report.passed,
    },
  });
}

async function handleRequestChanges(
  res: http.ServerResponse,
  session: Session,
): Promise<void> {
  if (session.step !== "rejected") {
    sendJson(res, 400, { error: "no rejected job to reopen" });
    return;
  }
  session.chain.requestChanges(session.jobId!, "coordinator.caliper.local");
  session.step = "winner_selected";
  setSessionCookie(res, `sess-${Date.now()}`);
  sendJson(res, 200, {
    step: session.step,
    outcome: "changes requested — worker may submit a corrected deliverable",
  });
}

async function handleSettle(
  res: http.ServerResponse,
  session: Session,
): Promise<void> {
  if (session.step !== "verified") {
    sendJson(res, 400, { error: "no verified job to settle" });
    return;
  }
  const chain = session.chain;
  chain.releaseVerifiedPayment(session.jobId!, session.winnerAccount!);
  const pendingStatus = chain.job(session.jobId!).status;
  chain.settlePayment(session.jobId!, true);
  const finalJob = chain.job(session.jobId!);
  if (finalJob.status !== "Paid") {
    sendJson(res, 500, { error: "payment did not settle" });
    return;
  }
  session.step = "settled";
  setSessionCookie(res, `sess-${Date.now()}`);
  sendJson(res, 200, {
    step: session.step,
    status: "Paid",
    winning_bid: finalJob.winning_bid,
    escrowed_budget: finalJob.budget,
    note: "Payment settled for exactly the winning bid.",
  });
}

async function handleReset(res: http.ServerResponse, session: Session): Promise<void> {
  session.chain = new LocalCaliperChain("owner.caliper.local");
  const rootAllocation = nearFromTenths(1000n);
  session.chain.createRoot("coordinator.caliper.local", rootAllocation, {
    recipients: ["vendor.caliper.local"],
    assets: [],
    max_per_tx: rootAllocation,
    may_delegate: true,
  });
  session.market = buildMarketRound();
  session.step = "idle";
  session.task = null;
  session.jobId = null;
  session.winnerAccount = null;
  session.winnerNode = null;
  session.deliverableHash = null;
  session.attempts = [];
  setSessionCookie(res, `sess-${Date.now()}`);
  sendJson(res, 200, { step: "idle" });
}

async function handleState(res: http.ServerResponse, session: Session): Promise<void> {
  const chain = session.chain;
  const job = session.jobId ? chain.job(session.jobId) : null;
  sendJson(res, 200, {
    step: session.step,
    task: session.task,
    market: {
      winner: session.market.winner,
      winner_bid: session.market.winner_bid,
      valid_bids: session.market.valid_bids,
      transcript_hash: session.market.transcript_hash,
    },
    job: job
      ? {
          id: job.id,
          status: job.status,
          budget: job.budget,
          winning_bid: job.winning_bid,
          attempt: job.attempt,
          submitted_at: job.submitted_at,
          verified_at: job.verified_at,
          paid_at: job.paid_at,
          independent_passed: job.independent_passed,
          tampering_detected: job.tampering_detected,
        }
      : null,
    identities: {
      coordinator: "coordinator.caliper.local",
      worker: session.winnerAccount ?? null,
      verifier: "verifier.caliper.local",
    },
    attempts: session.attempts,
  });
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  try {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }
    res.setHeader("access-control-allow-origin", "*");

    if (req.method === "GET" && url.startsWith("/api/state")) {
      const session = getOrCreateSession(sessionIdFromReq(req));
      await handleState(res, session);
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/task")) {
      const session = getOrCreateSession(sessionIdFromReq(req));
      const body = await readBody(req);
      await handleTaskPost(res, session, body);
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/bid")) {
      const session = getOrCreateSession(sessionIdFromReq(req));
      const body = await readBody(req);
      await handleBid(res, session, body);
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/select")) {
      const session = getOrCreateSession(sessionIdFromReq(req));
      const body = await readBody(req);
      await handleSelect(res, session, body);
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/deliver")) {
      const session = getOrCreateSession(sessionIdFromReq(req));
      const body = await readBody(req);
      await handleDeliver(res, session, body);
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/verify")) {
      const session = getOrCreateSession(sessionIdFromReq(req));
      await handleVerify(res, session);
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/request-changes")) {
      const session = getOrCreateSession(sessionIdFromReq(req));
      await handleRequestChanges(res, session);
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/settle")) {
      const session = getOrCreateSession(sessionIdFromReq(req));
      await handleSettle(res, session);
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/reset")) {
      const session = getOrCreateSession(sessionIdFromReq(req));
      await handleReset(res, session);
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/run")) {
      // Backward-compat: run the full deterministic swarm
      const run = runSwarm();
      sendJson(res, 200, run);
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/report/")) {
      const name = url.split("/").pop() ?? "";
      if (!/^attempt-[12]-report\.json$/.test(name)) {
        sendJson(res, 404, { error: "report not found" });
        return;
      }
      const file = path.join(RUNS_DIR, "latest", name);
      if (!fs.existsSync(file)) {
        sendJson(res, 404, { error: "report not found" });
        return;
      }
      sendJson(res, 200, JSON.parse(fs.readFileSync(file, "utf8")));
      return;
    }
    if (req.method === "GET") {
      serveStatic(res, url);
      return;
    }
    sendJson(res, 405, { error: "method not allowed" });
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    );
  }
});

server.listen(PORT, HOST, () => {
  console.log(`CALIPER workbench: http://${HOST}:${PORT}`);
  console.log("Local simulation only. No on-chain transactions are created.");
  console.log("Endpoints: POST /api/task, /api/bid, /api/select, /api/deliver, /api/verify, /api/request-changes, /api/settle, /api/reset");
  console.log("GET: /api/state, /api/report/attempt-N-report.json");
});
