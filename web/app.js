const $ = (id) => document.getElementById(id);

const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const short = (value, head = 12, tail = 8) => {
  const text = String(value ?? "");
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
};

const NEAR = 10n ** 24n;

function near(yocto) {
  if (yocto === null || yocto === undefined) return "—";
  try {
    const value = BigInt(String(yocto));
    const whole = value / NEAR;
    const fraction = (value % NEAR).toString().padStart(24, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction.slice(0, 4)} NEAR` : `${whole} NEAR`;
  } catch {
    return String(yocto);
  }
}

function statusChip(text, tone = "") {
  return `<span class="chip ${tone}">${esc(text)}</span>`;
}

function fact(dt, dd, tone = "") {
  return `<div><dt>${esc(dt)}</dt><dd class="${tone}">${esc(dd)}</dd></div>`;
}

function setMode(state) {
  const chip = $("mode-chip");
  chip.textContent = state.mode === "local-simulation" ? "local simulation" : "idle";
  chip.className = state.mode === "local-simulation" ? "chip warn" : "chip muted";
}

function showIdle() {
  $("idle").hidden = false;
  $("run-view").hidden = true;
  $("raw-panel").hidden = true;
  setMode({ mode: "idle" });
  $("hero-status").textContent =
    "No run loaded. The demo is deterministic and runs offline with no model calls.";
}

function renderTask(run) {
  const task = run.task;
  $("retry-chip").textContent = `${task.retry_limit} attempts`;
  $("task-facts").innerHTML = [
    fact("Task", task.title),
    fact("Baseline", task.baseline_commit),
    fact("Acceptance criteria", short(task.acceptance_criteria_hash, 18, 10)),
    fact("Acceptance suite", short(task.acceptance_suite_hash, 18, 10)),
    fact("Protected paths", task.protected_files.join(", ")),
    fact("Max budget", near(task.max_budget)),
    fact("Workers", String(task.worker_count)),
  ].join("");
  $("criteria-text").textContent = task.acceptance_criteria;
}

function renderMarket(run) {
  const market = run.market;
  $("winner-chip").textContent = `winner: ${run.identities.selected_worker.display_name}`;
  const rows = [];
  for (const worker of market.eligible_workers) {
    const commitment = market.commitments.find((entry) => entry.worker === worker);
    const reveal = market.reveals.find((entry) => entry.worker === worker);
    const invalid = market.invalid_reveals.find((entry) => entry.worker === worker);
    const late = market.late_reveals.find((entry) => entry.worker === worker);
    const duplicate = market.duplicate_commitments.find((entry) => entry.worker === worker);
    const isWinner = worker === market.winner;
    let state = "valid";
    let tone = "good";
    if (isWinner) {
      state = "winner";
      tone = "good";
    } else if (invalid) {
      state = "invalid reveal";
      tone = "bad";
    } else if (late) {
      state = "late reveal";
      tone = "bad";
    } else if (duplicate) {
      state = "duplicate ignored";
      tone = "warn";
    }
    rows.push(`
      <tr class="${isWinner ? "winner" : ""}">
        <td class="mono">${esc(worker)}</td>
        <td class="mono muted">${esc(short(commitment?.commitment ?? "—", 14, 6))}</td>
        <td class="mono">${esc(reveal ? near(reveal.amount) : "—")}</td>
        <td class="num mono">${esc(reveal ? near(reveal.amount) : "—")}</td>
        <td>${statusChip(state, tone)}</td>
      </tr>`);
  }
  $("bids-table").querySelector("tbody").innerHTML = rows.join("");
  $("market-note").textContent =
    `${market.selection_rule}. ${market.invalid_reveals.length} invalid reveal(s), ` +
    `${market.late_reveals.length} late reveal(s), ${market.duplicate_commitments.length} duplicate commitment(s). ` +
    `Transcript ${short(market.transcript_hash, 22, 10)} is anchored in job ${run.job.id}.`;
}

function renderRoles(run) {
  const rows = [
    ["Coordinator", `${run.identities.coordinator.account} · node ${run.identities.coordinator.node}`],
    [
      "Selected worker",
      `${run.identities.selected_worker.account} · node ${run.identities.selected_worker.node}`,
    ],
    ["Verifier", `${run.identities.verifier.account} · node ${run.identities.verifier.node}`],
    ["Verifier key", short(run.identities.verifier.public_key, 18, 10)],
    ["Role check", "distinct nodes + distinct accounts"],
  ];
  $("role-list").innerHTML = rows
    .map(([label, value]) => `<li><span>${esc(label)}</span><span>${esc(value)}</span></li>`)
    .join("");
}

function renderAuthority(run) {
  const authority = run.authority;
  const root = authority.root_node;
  const committed = BigInt(authority.coordinator_committed_after_job);
  const allocation = BigInt(root.allocation);
  const pct = allocation === 0n ? 0 : Number((committed * 1000n) / allocation) / 10;
  $("root-alloc").textContent = near(root.allocation);
  $("committed-before").textContent = near(authority.coordinator_committed_before_job);
  $("committed-after").textContent = near(authority.coordinator_committed_after_job);
  $("available-after").textContent = near(authority.coordinator_available_after_job);
  $("alloc-bar").style.width = `${Math.min(100, pct)}%`;
}

function renderIntegrity(run) {
  const checks = [
    ["Market transcript hash is anchored in the job", run.integrity.market_transcript_anchored],
    ["Selected worker recorded by the contract", run.integrity.selected_worker_unchanged_after_failure],
    ["Reports are bound to the current attempt", run.integrity.attempts_bound_to_current_artifact],
    ["Payment required a transfer callback", run.integrity.payment_requires_callback],
  ];
  $("integrity-list").innerHTML = checks
    .map(
      ([label, ok]) =>
        `<li class="${ok ? "" : "fail"}">${esc(label)}</li>`,
    )
    .join("");
}

function renderAttempt(attempt) {
  const report = attempt.report;
  const blocked = attempt.chain_status === "Rejected";
  const changed = (report.changed_files ?? [])
    .map((change) => {
      const violation = (report.protected_violations ?? []).some((entry) =>
        entry.includes(change.path),
      );
      return `<li class="${violation ? "violation" : ""}">${esc(change.status)} ${esc(change.path)}${violation ? " — protected" : ""}</li>`;
    })
    .join("");
  const weak = report.manipulation?.weakened_assertions ?? [];
  const disabled = report.manipulation?.disabled_ci ?? [];
  const deleted = report.manipulation?.deleted_tests ?? [];
  const tags = [
    ...weak.map((entry) => `<span class="tag bad">${esc(entry)}</span>`),
    ...disabled.map((entry) => `<span class="tag bad">${esc(entry)}</span>`),
    ...deleted.map((entry) => `<span class="tag bad">deleted ${esc(entry)}</span>`),
  ];
  const evidence = [
    ["Deliverable", short(report.deliverable_hash, 20, 8)],
    ["Diff", short(report.diff_hash, 20, 8)],
    ["Acceptance suite exit", String(report.test_exit_code)],
    ["CI check exit", String(report.ci_exit_code)],
    ["Protected files clean", String(report.attestation.protected_files_clean)],
    ["Passed", String(report.attestation.passed)],
    ["Report digest", short(report.attestation.report_digest, 22, 10)],
    ["Signature", short(report.attestation.signature, 22, 10)],
  ]
    .map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`)
    .join("");

  return `
    <article class="attempt ${blocked ? "blocked" : "passed"}">
      <div class="attempt-head">
        <div>
          <p class="eyebrow">Attempt ${attempt.attempt} · ${esc(attempt.artifact)} artifact</p>
          <h3>${blocked ? "Worker claim rejected" : "Correction accepted"}</h3>
        </div>
        ${statusChip(attempt.chain_status, blocked ? "bad" : "good")}
      </div>
      <div class="attempt-body">
        <div class="attempt-col">
          <div class="claim-box">
            <div class="label">Worker's own claim</div>
            <p>“${esc(attempt.worker_claim.summary)}”</p>
            <div class="tag-row">
              <span class="tag ${attempt.worker_claim.passed ? "good" : "bad"}">claimed ${attempt.worker_claim.passed ? "PASS" : "FAIL"}</span>
              <span class="tag">${esc(attempt.worker_claim.claimed_by)}</span>
            </div>
          </div>
          <div class="label muted" style="font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;font-weight:700;margin-bottom:6px">Computed diff</div>
          <ul class="diff-list">${changed || "<li class=\"muted\">no changed files</li>"}</ul>
          <div class="tag-row">${tags.join("") || '<span class="tag good">no manipulation detected</span>'}</div>
          <p class="micro">${esc(attempt.outcome)}</p>
        </div>
        <div class="attempt-col">
          <dl class="evidence-grid">${evidence}</dl>
          <div class="attempt-actions">
            <button class="btn ghost small" data-report="${attempt.attempt}">View full signed report</button>
          </div>
        </div>
      </div>
    </article>`;
}

function renderAttempts(run) {
  $("attempts").innerHTML = run.attempts.map(renderAttempt).join("");
}

function renderPayment(run) {
  const payment = run.payment;
  const paid = payment.state === "Paid";
  $("payment-chip").textContent = paid ? "settled" : payment.state;
  $("payment-chip").className = `chip ${paid ? "good" : "warn"}`;
  const steps = ["Verified", "PaymentPending", "Paid"];
  $("payment-pipeline").innerHTML = steps
    .map(
      (step) =>
        `<div class="step ${paid ? "done" : step === payment.state ? "active" : ""}">${esc(step)}</div>`,
    )
    .join("");
  $("payment-facts").innerHTML = [
    fact("Approved by", run.approval.approved_by),
    fact("Budget", near(payment.budget)),
    fact("Paid at block", payment.paid_at_block === null ? "—" : String(payment.paid_at_block)),
    fact("Receipt", payment.receipt_id),
    fact("Execution mode", payment.mode),
  ].join("");
  $("payment-note").textContent = payment.note;
}

function renderEvents(run) {
  $("event-list").innerHTML = run.events
    .map(
      (event) => `
      <li>
        <span class="block">#${esc(event.block)}</span>
        <span><span class="type">${esc(event.type)}</span><br /><span class="detail">${esc(event.detail)}</span></span>
      </li>`,
    )
    .join("");
}

function renderVerdict(run) {
  const first = run.attempts[0];
  const blocked = first.chain_status === "Rejected";
  $("verdict-title").textContent = blocked
    ? "The worker reported success. CALIPER refused to pay."
    : "Independent acceptance completed.";
  $("verdict-copy").textContent =
    `Attempt 1 claimed success, but the runner found ${first.report.protected_violations.length} protected-file violation(s) and reran the pinned suite against the actual source. ` +
    `Attempt 2 fixed the source and passed. Payment is ${run.payment.state.toLowerCase()} only after the transfer callback.`;
  $("verdict-state").textContent = blocked ? "Payment blocked, then verified" : run.payment.state;
  $("verdict-eyebrow").textContent = `run ${run.run_id}`;
}

function renderRun(run) {
  $("idle").hidden = true;
  $("run-view").hidden = false;
  $("raw-panel").hidden = true;
  setMode(run);
  $("hero-status").textContent = `Loaded ${run.mode} run ${run.run_id}. Evidence is inspectable below.`;
  renderVerdict(run);
  renderTask(run);
  renderMarket(run);
  renderRoles(run);
  renderAuthority(run);
  renderIntegrity(run);
  renderAttempts(run);
  renderPayment(run);
  renderEvents(run);
}

async function loadState() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    const state = await response.json();
    if (state.mode === "idle") showIdle();
    else renderRun(state);
  } catch (error) {
    $("hero-status").textContent = `Could not load state: ${error.message}`;
    showIdle();
  }
}

async function runDemo() {
  const buttons = [$("run-btn"), $("hero-run-btn")];
  for (const button of buttons) {
    button.disabled = true;
    button.textContent = "Running independent verification…";
  }
  $("hero-status").textContent = "Sealing bids, running the pinned suite, checking signatures…";
  try {
    const response = await fetch("/api/run", { method: "POST", cache: "no-store" });
    const state = await response.json();
    if (!response.ok) throw new Error(state.error ?? "demo failed");
    renderRun(state);
    document.getElementById("run-view").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    $("hero-status").textContent = `Demo failed: ${error.message}`;
  } finally {
    for (const button of buttons) {
      button.disabled = false;
      button.textContent = button.id === "run-btn" ? "Run adversarial demo" : "Watch the adversarial loop";
    }
  }
}

async function resetDemo() {
  await fetch("/api/reset", { method: "POST" });
  showIdle();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function showReport(attempt) {
  const panel = $("raw-panel");
  $("raw-title").textContent = `Attempt ${attempt} verification report`;
  $("raw-json").textContent = "Loading…";
  panel.hidden = false;
  try {
    const response = await fetch(`/api/report/attempt-${attempt}-report.json`, { cache: "no-store" });
    const report = await response.json();
    $("raw-json").textContent = JSON.stringify(report, null, 2);
  } catch (error) {
    $("raw-json").textContent = `Could not load report: ${error.message}`;
  }
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

$("run-btn").addEventListener("click", runDemo);
$("hero-run-btn").addEventListener("click", runDemo);
$("reset-btn").addEventListener("click", resetDemo);
$("raw-close").addEventListener("click", () => {
  $("raw-panel").hidden = true;
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-report]");
  if (button) showReport(Number(button.dataset.report));
});

loadState();
