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

function hideAllViews() {
  for (const el of document.querySelectorAll("section[id^=view-], #evidence")) {
    el.hidden = true;
  }
}

function setMode(mode, step) {
  $("mode-chip").textContent = mode === "local-simulation" ? "local simulation" : "idle";
  $("mode-chip").className = mode === "local-simulation" ? "chip warn" : "chip muted";
  $("step-chip").textContent = step;
  $("step-chip").className = `chip ${step === "idle" ? "muted" : "warn"}`;
}

async function api(path, method = "GET", body) {
  const opts = { method, cache: "no-store", headers: {} };
  if (body) opts.headers["content-type"] = "application/json";
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

function showView(id) {
  hideAllViews();
  $(id).hidden = false;
}

function renderTask(state) {
  $("task-title").value = state.task?.title || "";
  $("task-criteria").value = state.task?.acceptance_criteria || "";
  $("task-budget").value = state.task?.max_budget ? String(Number(state.task.max_budget) / 1e24) : "20";
}

function renderBids(state) {
  const tbody = $("bids-table").querySelector("tbody");
  const bids = state.market?.valid_bids || [];
  const winner = state.market?.winner_bid?.worker;
  tbody.innerHTML = bids
    .map(
      (b) => {
        const isWinner = b.worker === winner;
        return `
          <tr class="${isWinner ? "winner" : ""}">
            <td class="mono">${esc(b.worker)}</td>
            <td class="num mono">${near(b.amount)}</td>
            <td>${isWinner ? statusChip("winning bid", "good") : statusChip("valid", "")}</td>
            <td>
              ${isWinner
                ? `<button class="btn primary small" data-select="${esc(b.worker)}">Select</button>`
                : `<button class="btn ghost small" data-bid="${esc(b.worker)}|${esc(b.amount)}">Bid ${near(b.amount)}</button>`}
            </td>
          </tr>`;
      },
    )
    .join("");
  $("market-note").textContent =
    state.market?.note ??
    "Deterministic commit/reveal simulation. Not a private auction; the contract records the transcript hash.";
}

async function loadState() {
  try {
    const state = await api("/api/state");
    setMode(state.mode ?? "local-simulation", state.step);
    if (state.step === "idle") {
      showView("#view-idle");
      return;
    }
    renderTask(state);
    switch (state.step) {
      case "task_posted":
        showView("#view-bids");
        renderBids(state);
        break;
      case "bids_open":
        showView("#view-bids");
        renderBids(state);
        break;
      case "winner_selected":
        showView("#view-deliver");
        break;
      case "delivered":
        showView("#view-verify");
        break;
      case "verified":
        renderDecision(state);
        showView("#view-decide");
        break;
      case "rejected":
        renderDecision(state);
        showView("#view-decide");
        break;
      case "settled":
        showView("#evidence");
        renderEvidence(state);
        break;
      default:
        showView("#view-idle");
    }
  } catch (error) {
    console.error(error);
    showView("#view-idle");
  }
}

function renderDecision(state) {
  const last = state.attempts?.[state.attempts.length - 1];
  const title = $("decide-title");
  const content = $("decision-content");
  const actions = $("decision-actions");

  if (!last) {
    title.textContent = "Verification result";
    content.innerHTML = "<p>No verification result available.</p>";
    actions.innerHTML = "";
    return;
  }

  const blocked = last.chain_status === "Rejected";
  const exhausted = last.chain_status === "Exhausted";

  title.textContent = blocked
    ? "Worker claim rejected — payment blocked"
    : exhausted
    ? "Exhausted — no attempts remain"
    : "Verification passed — payment due";

  const report = last.report || {};
  const violations = report.protected_violations || [];
  const weak = report.manipulation?.weakened_assertions || [];
  const disabled = report.manipulation?.disabled_ci || [];

  content.innerHTML = `
    <div class="verdict-card ${blocked || exhausted ? "blocked" : "passed"}">
      <div class="verdict-head">
        <span class="status-dot"></span>
        <strong>${blocked ? "REJECTED" : exhausted ? "EXHAUSTED" : "VERIFIED"}</strong>
      </div>
      <p>${last.outcome}</p>
      ${violations.length ? `<p><strong>Protected-file violations:</strong> ${violations.join(", ")}</p>` : ""}
      ${weak.length ? `<p><strong>Weakened assertions:</strong> ${weak.join(", ")}</p>` : ""}
      ${disabled.length ? `<p><strong>Disabled CI:</strong> ${disabled.join(", ")}</p>` : ""}
      <p>Test exit: ${report.test_exit_code ?? "—"} &nbsp;|&nbsp; CI exit: ${report.ci_exit_code ?? "—"}</p>
      <p>Artifact matches claim: ${report.attestation?.deliverable_matches_claim ?? "—"}</p>
      <p>Protected files clean: ${report.attestation?.protected_files_clean ?? "—"}</p>
    </div>
  `;

  actions.innerHTML = "";
  if (blocked && state.step === "rejected") {
    actions.innerHTML += `
      <button class="btn primary" id="req-changes-btn">Request changes (reopen correction)</button>
    `;
  }
  if (state.step === "verified") {
    actions.innerHTML += `
      <button class="btn primary" id="settle-btn">Release payment to worker</button>
    `;
  }
  if (exhausted) {
    actions.innerHTML += `<p class="micro">No attempts remain. The commitment is released to the coordinator.</p>`;
  }
}

function renderEvidence(state) {
  const attemptsEl = $("attempts");
  const integrityEl = $("integrity-list");
  attemptsEl.innerHTML = "";
  integrityEl.innerHTML = "";

  if (!state.attempts || state.attempts.length === 0) {
    attemptsEl.innerHTML = "<p class=" + '"muted"' + ">No attempts recorded.</p>";
    return;
  }

  for (const attempt of state.attempts) {
    const report = attempt.report || {};
    const blocked = attempt.chain_status === "Rejected";
    const weak = report.manipulation?.weakened_assertions || [];
    const disabled = report.manipulation?.disabled_ci || [];
    const deleted = report.manipulation?.deleted_tests || [];

    const tags = [
      ...weak.map((e) => `<span class="tag bad">${esc(e)}</span>`),
      ...disabled.map((e) => `<span class="tag bad">${esc(e)}</span>`),
      ...deleted.map((e) => `<span class="tag bad">deleted ${esc(e)}</span>`),
    ];

    attemptsEl.innerHTML += `
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
            <p class="micro">${esc(attempt.outcome)}</p>
          </div>
          <div class="attempt-col">
            <dl class="evidence-grid">
              <div><dt>Test exit</dt><dd>${report.test_exit_code ?? "—"}</dd></div>
              <div><dt>CI exit</dt><dd>${report.ci_exit_code ?? "—"}</dd></div>
              <div><dt>Artifact matches claim</dt><dd>${report.attestation?.deliverable_matches_claim ?? "—"}</dd></div>
              <div><dt>Protected files clean</dt><dd>${report.attestation?.protected_files_clean ?? "—"}</dd></div>
              <div><dt>Passed</dt><dd>${report.attestation?.passed ?? "—"}</dd></div>
              <div><dt>Report digest</dt><dd class="mono">${short(report.attestation?.report_digest, 22, 10)}</dd></div>
            </dl>
            <div class="tag-row">${tags.join("") || '<span class="tag good">no manipulation detected</span>'}</div>
            <button class="btn ghost small" data-report="${attempt.attempt}">View full signed report</button>
          </div>
        </div>
      </article>`;
  }

  const last = state.attempts[state.attempts.length - 1];
  if (last) {
    const checks = [
      ["Market transcript hash matches the job record", state.integrity?.market_transcript_hash_matches_job],
      ["Selected worker unchanged after failure", state.integrity?.selected_worker_unchanged_after_failure],
      ["Reports bound to current attempt", state.integrity?.attempts_bound_to_current_artifact],
      ["Payment required a transfer callback", state.integrity?.payment_requires_callback],
      ["Settlement equals winning bid", state.integrity?.settlement_amount_equals_winning_bid],
      ["Release is permissionless after verification", state.integrity?.payment_permissionless_after_verification],
      ["Verified job cannot be cancelled", state.integrity?.coordinator_cannot_cancel_verified_job],
    ];
    integrityEl.innerHTML = checks
      .map(
        ([label, ok]) =>
          `<li class="${ok ? "" : "fail"}">${esc(label)}</li>`,
      )
      .join("");
  }
}

// ---------- Event wiring ----------
$("start-btn").addEventListener("click", () => {
  showView("#view-post-task");
});

$("back-to-idle").addEventListener("click", () => {
  showView("#view-idle");
});

$("task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const btn = $("task-form").querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = "Posting task…";
  try {
    const budgetNear = Number($("task-budget").value);
    const maxBudget = String(Math.round(budgetNear * 1e24));
    await api("/api/task", "POST", {
      title: $("task-title").value,
      acceptance_criteria: $("task-criteria").value,
      protected_files: ["tests/**", "ci/**"],
      max_budget: maxBudget,
    });
    await loadState();
  } catch (error) {
    alert(`Failed to post task: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Post task and open bidding";
  }
});

$("back-to-task").addEventListener("click", async () => {
  await loadState();
});

$("bids-table").addEventListener("click", async (event) => {
  const selectBtn = event.target.closest("[data-select]");
  const bidBtn = event.target.closest("[data-bid]");
  if (selectBtn) {
    try {
      await api("/api/select", "POST", { worker: selectBtn.dataset.select });
      await loadState();
    } catch (error) {
      alert(`Failed to select: ${error.message}`);
    }
    return;
  }
  if (bidBtn) {
    const [worker, amount] = bidBtn.dataset.bid.split("|");
    try {
      await api("/api/bid", "POST", { worker, amount });
      await loadState();
    } catch (error) {
      alert(`Failed to place bid: ${error.message}`);
    }
    return;
  }
});

$("back-to-bids").addEventListener("click", async () => {
  await loadState();
});

$("deliver-btn").addEventListener("click", async () => {
  const artifact = document.querySelector('input[name="artifact"]:checked')?.value;
  if (!artifact) {
    alert("Select a submission type");
    return;
  }
  const btn = $("deliver-btn");
  btn.disabled = true;
  btn.textContent = "Submitting…";
  try {
    await api("/api/deliver", "POST", {
      artifact,
      worker: "worker-eve.local",
      summary: artifact === "tampered"
        ? "Updated the flaky billing expectation and the CI check; all reported checks are green."
        : "Fixed src/auth.js so billing requires the admin role. The pinned suite and CI check pass unmodified.",
    });
    await loadState();
  } catch (error) {
    alert(`Failed to deliver: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Submit deliverable";
  }
});

$("back-to-deliver").addEventListener("click", async () => {
  await loadState();
});

$("verify-btn").addEventListener("click", async () => {
  const btn = $("verify-btn");
  btn.disabled = true;
  btn.textContent = "Verifying…";
  try {
    await api("/api/verify", "POST");
    await loadState();
  } catch (error) {
    alert(`Verification failed: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Run independent verification";
  }
});

$("back-to-decide").addEventListener("click", async () => {
  await loadState();
});

document.addEventListener("click", async (event) => {
  const reqChanges = event.target.closest("#req-changes-btn");
  const settle = event.target.closest("#settle-btn");
  const reportBtn = event.target.closest("[data-report]");
  const rawClose = event.target.closest("#raw-close");

  if (reqChanges) {
    try {
      await api("/api/request-changes", "POST");
      await loadState();
    } catch (error) {
      alert(`Failed to request changes: ${error.message}`);
    }
    return;
  }
  if (settle) {
    try {
      await api("/api/settle", "POST");
      await loadState();
    } catch (error) {
      alert(`Failed to settle: ${error.message}`);
    }
    return;
  }
  if (reportBtn) {
    const panel = document.querySelector(".raw-panel");
    const rawJson = $("raw-json");
    panel.hidden = false;
    rawJson.textContent = "Loading…";
    try {
      const report = await api(`/api/report/attempt-${reportBtn.dataset.report}-report.json`);
      rawJson.textContent = JSON.stringify(report, null, 2);
    } catch (error) {
      rawJson.textContent = `Could not load report: ${error.message}`;
    }
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (rawClose) {
    document.querySelector(".raw-panel").hidden = true;
    return;
  }
});

$("reset-btn").addEventListener("click", async () => {
  try {
    await api("/api/reset", "POST");
    await loadState();
  } catch (error) {
    alert(`Reset failed: ${error.message}`);
  }
});

// ---------- Bootstrap ----------
loadState();
