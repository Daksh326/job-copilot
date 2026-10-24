"use strict";
const NAMES = { linkedin: "LinkedIn", internshala: "Internshala", naukri: "Naukri", unstop: "Unstop", wellfound: "Wellfound" };
const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

function cell(text, cls) {
  const td = document.createElement("td");
  if (cls) { const s = document.createElement("span"); s.className = `pill ${cls}`; s.textContent = text; td.append(s); }
  else td.textContent = text;
  return td;
}

async function refresh() {
  const res = await send("status:get");
  if (!res.ok) {
    $("conn").textContent = "backend offline";
    $("conn").className = "pill bad";
    $("start").disabled = true;
    $("msg").textContent = "Start the backend (run-backend.cmd). Nothing runs on any site while it's offline.";
    return;
  }
  $("conn").textContent = "connected";
  $("conn").className = "pill ok";
  const { status, session, localLockouts } = res.data;
  const tbody = $("platforms");
  tbody.replaceChildren();
  $("alerts").replaceChildren();
  for (const [p, st] of Object.entries(status.platforms)) {
    const local = localLockouts[p] && localLockouts[p].until * 1000 > Date.now() ? localLockouts[p] : null;
    const lock = st.lockout || local;
    const tr = document.createElement("tr");
    tr.append(cell(NAMES[p]));
    const hourly = st.limits.hourly != null ? ` · ${st.counts.hour}/${st.limits.hourly} hr` : "";
    tr.append(cell(`${st.counts.day}/${st.limits.daily}${hourly}`));
    if (lock) tr.append(cell(`stopped until ${new Date(lock.until * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`, "bad"));
    else if (!st.allowed) tr.append(cell(st.reasons[0].replace(/\(.*\)/, "").trim(), "warn"));
    else tr.append(cell("ready", "ok"));
    tbody.append(tr);
    if (lock) {
      const a = document.createElement("div");
      a.className = "alert";
      a.textContent = `${NAMES[p]} stopped: ${lock.reason}`;
      $("alerts").append(a);
    }
  }
  const total = Object.values(status.platforms)[0];
  $("session").textContent = session.active
    ? `Rapid Review running · ${session.queue.length} left in queue · ${total.counts.total_day}/${total.limits.total_daily} total today`
    : `${total.counts.total_day}/${total.limits.total_daily} applications in the last 24h across all platforms.`;
  $("start").hidden = session.active;
  $("end").hidden = !session.active;
}

$("start").onclick = async () => {
  $("start").disabled = true;
  const res = await send("session:start");
  $("start").disabled = false;
  $("msg").textContent = !res.ok ? res.error : res.data.started ? `Queued ${res.data.count} listings.` : res.data.message;
  refresh();
};
$("end").onclick = async () => { await send("session:end"); refresh(); };
$("options").onclick = () => chrome.runtime.openOptionsPage();
$("feeds").onclick = async () => {
  const res = await send("api", { path: "/sources/feeds/refresh", method: "POST" });
  if (!res.ok) { $("msg").textContent = res.error; return; }
  const r = res.data;
  $("msg").textContent = `Feeds: ${r.ingested} listings read${r.errors.length ? ` · ${r.errors.length} errors` : ""}. Feeds are checked at most every 6h.`;
};
refresh();
