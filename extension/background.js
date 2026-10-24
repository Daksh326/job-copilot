// Service worker: talks to the local backend, runs the Rapid Review queue and
// enforces pacing. It opens listing pages (like clicking a link) and nothing else.
"use strict";

const DEFAULT_BACKEND = "http://127.0.0.1:8765";
const PAGE_OPEN_GAP_S = 15;      // never load listing pages on one platform faster than this
const ACTIVITY_WINDOW_MS = 30 * 60_000;
const NAMES = { linkedin: "LinkedIn", internshala: "Internshala", naukri: "Naukri", unstop: "Unstop", wellfound: "Wellfound" };

async function backend() {
  const { backendUrl } = await chrome.storage.local.get("backendUrl");
  return (backendUrl || DEFAULT_BACKEND).replace(/\/$/, "");
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch((await backend()) + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data.detail;
    const msg = typeof d === "string" ? d : d && (d.blockers || d.errors) ? (d.blockers || d.errors).join(" ") : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// ---------------------------------------------------------------- state helpers

const getS = async (key, fallback) => (await chrome.storage.session.get(key))[key] ?? fallback;
const setS = (key, value) => chrome.storage.session.set({ [key]: value });

async function getSession() {
  return getS("session", { active: false, tabId: null, queue: [], currentId: null, lastOpen: {} });
}

// Lockouts are mirrored locally so they hold even if the backend is offline
// or its database is reset.
async function localLockout(platform) {
  const { lockouts = {} } = await chrome.storage.local.get("lockouts");
  const l = lockouts[platform];
  return l && l.until * 1000 > Date.now() ? l : null;
}

async function saveLockout(lock) {
  const { lockouts = {} } = await chrome.storage.local.get("lockouts");
  const prev = lockouts[lock.platform];
  if (!prev || prev.until < lock.until) lockouts[lock.platform] = lock;
  await chrome.storage.local.set({ lockouts });
  await refreshBadge();
}

async function refreshBadge() {
  const { lockouts = {} } = await chrome.storage.local.get("lockouts");
  const locked = Object.values(lockouts).filter((l) => l.until * 1000 > Date.now());
  await chrome.action.setBadgeBackgroundColor({ color: locked.length ? "#dc2626" : "#0f172a" });
  const s = await getSession();
  await chrome.action.setBadgeText({ text: locked.length ? "!" : s.active ? String(s.queue.length) : "" });
}

async function stopPlatform(platform, reason) {
  let lock;
  try {
    lock = (await api("/safety/stop", { method: "POST", body: { platform, reason } })).lockout;
  } catch (_) {
    lock = { platform, reason, until: Date.now() / 1000 + 48 * 3600 };
  }
  await saveLockout(lock);
  const s = await getSession();
  s.queue = s.queue.filter((i) => i.platform !== platform);
  if (s.currentId && s.currentId.startsWith(platform + ":")) s.currentId = null;
  await setS("session", s);
  await refreshBadge();
  chrome.notifications.create(`stop-${platform}-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `JobCopilot stopped ${NAMES[platform]} for 48 hours`,
    message: `${reason}. If there's a CAPTCHA, solve it yourself. Nothing will run on ${NAMES[platform]} until it lifts.`,
    priority: 2,
    requireInteraction: true,
  });
  return lock;
}

// ---------------------------------------------------------------- Rapid Review

async function openItem(s, item) {
  s.currentId = item.id;
  s.lastOpen[item.platform] = Date.now() / 1000;
  await setS("session", s);
  try {
    await chrome.tabs.update(s.tabId, { url: item.url, active: true });
  } catch (_) {
    const tab = await chrome.tabs.create({ url: item.url, active: true });
    s.tabId = tab.id;
    await setS("session", s);
  }
  await refreshBadge();
}

// Pick the next listing that is allowed right now. If the only candidates are
// waiting on a pacing gap, report when the earliest one unlocks.
async function nextItem() {
  const s = await getSession();
  if (!s.active) return { done: true, message: "No review session running." };
  s.queue = s.queue.filter((i) => i.id !== s.currentId);
  s.currentId = null;
  await setS("session", s);

  let soonest = null;
  const keep = [];
  for (const item of s.queue) {
    if (await localLockout(item.platform)) continue;
    let gate;
    try {
      gate = await api(`/check/${encodeURIComponent(item.id)}`);
    } catch (e) {
      return { error: `Backend error: ${e.message}` };
    }
    if (!gate.ok && !gate.wait_only) continue; // hard blocker: drop from this session
    keep.push(item);
    const openGapUntil = (s.lastOpen[item.platform] || 0) + PAGE_OPEN_GAP_S;
    const waitUntil = Math.max(gate.ok ? 0 : gate.next_allowed_at, openGapUntil);
    if (waitUntil <= Date.now() / 1000) {
      s.queue = [item, ...s.queue.filter((i) => i.id !== item.id)];
      await openItem(s, item);
      return { opened: true };
    }
    const reason = gate.ok ? "page pacing" : gate.blockers[0];
    if (!soonest || waitUntil < soonest.waitUntil) soonest = { waitUntil, next: item, reason };
  }
  s.queue = keep;
  await setS("session", s);
  await refreshBadge();
  if (soonest) return soonest;
  s.active = false;
  await setS("session", s);
  await refreshBadge();
  return { done: true, message: "Queue finished, or every remaining platform hit today's limit." };
}

async function startSession() {
  const { queue } = await api("/queue");
  const items = [];
  for (const item of queue) if (!(await localLockout(item.platform))) items.push(item);
  if (!items.length) return { started: false, message: "Nothing in the queue. Browse some results pages first." };
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  await setS("session", { active: true, tabId: tab.id, queue: items, currentId: null, lastOpen: {} });
  const res = await nextItem();
  if (res.waitUntil) await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL("waiting.html") });
  return { started: true, count: items.length, ...res };
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getSession();
  if (s.active && s.tabId === tabId) {
    await setS("session", { ...s, active: false });
    await refreshBadge();
  }
});

// ---------------------------------------------------------------- messages

function fromExtensionPage(sender) {
  return !sender.tab || (sender.url || "").startsWith(chrome.runtime.getURL(""));
}

async function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const handlers = {
  async "lock:get"({ platform }) {
    const local = await localLockout(platform);
    if (local) return { lockout: local };
    const st = await api("/safety/status");
    const lock = st.platforms[platform] && st.platforms[platform].lockout;
    if (lock) await saveLockout(lock);
    return { lockout: lock || null };
  },
  async "session:here"({ platform }, sender) {
    const s = await getSession();
    const isReviewTab = s.active && sender.tab && sender.tab.id === s.tabId;
    const item = isReviewTab ? s.queue.find((i) => i.id === s.currentId) || null : null;
    const activity = await getS("activity", {});
    const platformActive = (isReviewTab && item && item.platform === platform) || Date.now() - (activity[platform] || 0) < ACTIVITY_WINDOW_MS;
    return { isReviewTab, item, platformActive };
  },
  async "activity:mark"({ platform }) {
    const activity = await getS("activity", {});
    activity[platform] = Date.now();
    await setS("activity", activity);
    return {};
  },
  async "platform:stop"({ platform, reason }) {
    return { lockout: await stopPlatform(platform, reason) };
  },
  async "platform:error"({ platform, detail }) {
    const res = await api("/safety/error", { method: "POST", body: { platform, detail } });
    if (res.lockout) return { lockout: await stopPlatform(platform, res.lockout.reason) };
    return { lockout: null };
  },
  async ingest({ listings }) { return api("/listings/ingest", { method: "POST", body: { listings } }); },
  async check({ listingId }) { return api(`/check/${encodeURIComponent(listingId)}`); },
  async generate({ listingId, questions }) { return api("/generate", { method: "POST", body: { listing_id: listingId, questions } }); },
  async similarity({ text }) { return api("/similarity", { method: "POST", body: { text } }); },
  async "profile:get"() { return api("/profile"); },
  async "resume:get"() {
    const res = await fetch((await backend()) + "/profile/resume");
    if (!res.ok) throw new Error("No resume uploaded");
    const cd = res.headers.get("content-disposition") || "";
    const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    return { base64: await arrayBufferToBase64(await res.arrayBuffer()), filename: m ? decodeURIComponent(m[1]) : "resume.pdf" };
  },
  async "pending:set"({ data }) { await setS("pending", data); return {}; },
  async "pending:get"() { return getS("pending", null); },
  async "pending:clear"() { await setS("pending", null); return {}; },
  async "application:log"({ platform, listingId, url, company, texts, detectedBy }) {
    return api("/applications", { method: "POST", body: { platform, listing_id: listingId, url, company, texts, detected_by: detectedBy } });
  },
  async "session:skip"({ listingId, persist }) {
    if (persist) await api(`/listings/${encodeURIComponent(listingId)}/skip`, { method: "POST" });
    return {};
  },
  async "session:next"() { const r = await nextItem(); if (r.error) throw new Error(r.error); return r; },
  // popup
  async "session:start"() { return startSession(); },
  async "session:end"() { const s = await getSession(); await setS("session", { ...s, active: false }); await refreshBadge(); return {}; },
  // Extension pages (options, popup) reach the backend through here rather than
  // with their own fetch, so they get the same network path as the popup status.
  async api({ path, method, body }, sender) {
    if (!fromExtensionPage(sender)) throw new Error("Not allowed from a web page");
    return api(path, { method, body });
  },
  async "resume:upload"({ base64, filename }, sender) {
    if (!fromExtensionPage(sender)) throw new Error("Not allowed from a web page");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "application/pdf" }), filename || "resume.pdf");
    const res = await fetch((await backend()) + "/profile/resume", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : `HTTP ${res.status}`);
    return data;
  },
  async "status:get"() {
    const [st, s] = await Promise.all([api("/safety/status"), getSession()]);
    const { lockouts = {} } = await chrome.storage.local.get("lockouts");
    return { status: st, session: s, localLockouts: lockouts };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg && msg.type];
  if (!fn) return false;
  Promise.resolve(fn(msg, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true;
});

chrome.runtime.onStartup.addListener(refreshBadge);
chrome.runtime.onInstalled.addListener(refreshBadge);
