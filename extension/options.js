"use strict";
const $ = (id) => document.getElementById(id);
const PLATFORMS = ["linkedin", "internshala", "naukri", "unstop", "wellfound"];

const TEMPLATE = {
  name: "Your Name",
  email: "you@example.com",
  phone: "9876543210",
  phone_country_code: "+91",
  current_city: "Delhi",
  locations: ["Delhi", "Bengaluru", "Gurugram"],
  willing_to_relocate: false,
  work_modes: ["remote", "hybrid", "onsite"],
  college: "Your College",
  degree: "B.Tech Computer Science",
  branch: "Computer Science",
  graduation_year: 2026,
  cgpa: 8.1,
  years_experience: 0,
  target_roles: ["Software Engineer Intern", "Backend Developer Intern", "Data Analyst Intern"],
  avoid_keywords: ["sales", "telecaller", "business development"],
  excluded_companies: [],
  skills: ["Python", "Java", "SQL", "React", "FastAPI", "Git"],
  links: { linkedin: "", github: "", portfolio: "" },
  summary: "Two or three sentences about you, in your own words.",
  experience: [{ role: "Intern", org: "Company", dates: "May-Jul 2025", highlights: ["What you built, with a number if you have one"] }],
  projects: [{ name: "Project", stack: ["Python"], highlights: ["What it does and what you did"] }],
  answers: {
    availability: "Immediately",
    notice_period: "Immediate",
    relocate: "Yes",
    expected_compensation: "As per company norms",
    current_compensation: "",
  },
  custom_answers: [{ match: "how did you hear", answer: "Through the job listing." }],
};

// All backend calls go through the background service worker (see "api" in
// background.js), the same path the popup uses.
async function api(path, { method = "GET", body } = {}) {
  const res = await chrome.runtime.sendMessage({ type: "api", path, method, body });
  if (!res || !res.ok) throw new Error(res ? res.error : "Extension background not responding; reload the extension.");
  return res.data;
}

let retryTimer = null;
async function loadAll() {
  clearTimeout(retryTimer);
  const { backendUrl } = await chrome.storage.local.get("backendUrl");
  $("backendUrl").value = (backendUrl || "http://127.0.0.1:8765").replace(/\/$/, "");
  try {
    await api("/health");
    $("backendMsg").textContent = "Connected.";
  } catch (e) {
    $("backendMsg").textContent = `Not reachable (${e.message}). Start run-backend.cmd; retrying every 3 seconds…`;
    retryTimer = setTimeout(loadAll, 3000);
    return;
  }
  const profile = await api("/profile");
  const hasResume = profile.has_resume;
  delete profile.has_resume;
  $("profile").value = JSON.stringify(Object.keys(profile).length ? profile : TEMPLATE, null, 2);
  $("resumeMsg").textContent = hasResume ? `Current: ${profile.resume_filename || "resume.pdf"}` : "No resume uploaded yet.";
  await loadLimits();
  await loadFeeds();
  await loadApps();
}

let limitData = null;
async function loadLimits() {
  limitData = await api("/settings/limits");
  const { limits, defaults } = limitData;
  const tbody = $("limitRows");
  tbody.replaceChildren();
  for (const p of PLATFORMS) {
    const tr = document.createElement("tr");
    const d = defaults.platforms[p], l = limits.platforms[p];
    tr.innerHTML = `<td>${p}</td><td><input type="number" min="0" data-p="${p}" data-k="daily" style="width:80px"></td>`
      + `<td><input type="number" min="0" data-p="${p}" data-k="hourly" style="width:80px" placeholder="none"></td>`
      + `<td class="muted">${d.daily}/day${d.hourly ? `, ${d.hourly}/hour` : ""}</td>`;
    tr.querySelector("[data-k=daily]").value = l.daily;
    tr.querySelector("[data-k=hourly]").value = l.hourly ?? "";
    tbody.append(tr);
  }
  $("totalDaily").value = limits.total_daily;
  $("minGap").value = limits.min_gap_seconds;
  $("minFit").value = limits.min_fit_score;
  $("cooldown").value = limits.company_cooldown_days;
}

function limitBody() {
  const body = { platforms: {} };
  document.querySelectorAll("#limitRows input").forEach((i) => {
    body.platforms[i.dataset.p] = body.platforms[i.dataset.p] || {};
    if (i.value !== "") body.platforms[i.dataset.p][i.dataset.k] = Number(i.value);
  });
  body.total_daily = Number($("totalDaily").value);
  body.min_gap_seconds = Number($("minGap").value);
  body.min_fit_score = Number($("minFit").value);
  body.company_cooldown_days = Number($("cooldown").value);
  return body;
}

async function saveLimits(confirmed) {
  $("limitWarnings").replaceChildren();
  $("limitMsg").textContent = "";
  try {
    const res = await api("/settings/limits", { method: "PUT", body: { ...limitBody(), i_understand_the_risk: !!confirmed } });
    for (const w of res.warnings || []) {
      const d = document.createElement("div");
      d.className = "alert";
      d.textContent = w;
      $("limitWarnings").append(d);
    }
    $("confirmLimits").hidden = !res.needs_confirmation;
    $("limitMsg").textContent = res.saved ? "Saved." : "Not saved yet: read the warnings.";
    if (res.saved) await loadLimits();
  } catch (e) {
    $("limitMsg").textContent = e.message;
  }
}

async function loadFeeds() {
  const { feeds } = await api("/sources/feeds");
  $("feeds").replaceChildren(...feeds.map((f) => {
    const li = document.createElement("li");
    li.textContent = `${f.url} · last checked ${f.last_fetched ? new Date(f.last_fetched * 1000).toLocaleString() : "never"}`;
    return li;
  }));
}

async function loadApps() {
  const { applications } = await api("/applications?days=30");
  $("apps").replaceChildren(...applications.map((a) => {
    const tr = document.createElement("tr");
    [new Date(a.submitted_at * 1000).toLocaleString(), a.platform, `${a.title || "?"} · ${a.company || "?"}`, a.detected_by]
      .forEach((t) => { const td = document.createElement("td"); td.textContent = t; tr.append(td); });
    return tr;
  }));
}

$("saveBackend").onclick = async () => {
  await chrome.storage.local.set({ backendUrl: $("backendUrl").value.trim() || "http://127.0.0.1:8765" });
  loadAll();
};
$("saveProfile").onclick = async () => {
  let data;
  try { data = JSON.parse($("profile").value); } catch (e) { $("profileMsg").textContent = `Invalid JSON: ${e.message}`; return; }
  try { await api("/profile", { method: "PUT", body: data }); $("profileMsg").textContent = "Saved."; }
  catch (e) { $("profileMsg").textContent = e.message; }
};

async function uploadResume() {
  const f = $("resume").files[0];
  if (!f) { $("resumeMsg").textContent = "Pick a PDF first."; return; }
  if (f.type && f.type !== "application/pdf") { $("resumeMsg").textContent = "That isn't a PDF. Export your resume as PDF first."; return; }
  if (f.size > 5 * 1024 * 1024) { $("resumeMsg").textContent = "That PDF is over 5 MB; most application forms reject files that big."; return; }
  $("resumeMsg").textContent = `Uploading ${f.name}…`;
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const res = await chrome.runtime.sendMessage({ type: "resume:upload", base64: btoa(bin), filename: f.name });
    if (!res || !res.ok) throw new Error(res ? res.error : "Extension background not responding; reload the extension.");
    $("resumeMsg").textContent = `Uploaded ${f.name} (${Math.round(f.size / 1024)} KB).`;
  } catch (e) {
    $("resumeMsg").textContent = `Upload failed: ${e.message}`;
  }
}
$("resume").onchange = uploadResume;
$("uploadResume").onclick = uploadResume;
$("saveLimits").onclick = () => saveLimits(false);
$("confirmLimits").onclick = () => saveLimits(true);
$("addFeed").onclick = async () => {
  const url = $("feedUrl").value.trim();
  if (!url) return;
  await api("/sources/feeds", { method: "POST", body: { url } });
  $("feedUrl").value = "";
  loadFeeds();
};
$("importEmail").onclick = async () => {
  try {
    const r = await api("/sources/email", { method: "POST", body: { raw: $("email").value } });
    const fit = r.listings.filter((l) => l.eligible && l.fit_score >= 55).length;
    $("emailMsg").textContent = `Found ${r.found} job links, ${fit} look like a fit. Open them once so the full description can be checked.`;
  } catch (e) { $("emailMsg").textContent = e.message; }
};
loadAll();
