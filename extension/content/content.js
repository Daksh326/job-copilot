// Orchestrates one platform tab: guard first, then read, then (only when allowed)
// fill. The final Submit is always the user's click.
"use strict";

(async () => {
  const { platforms, guard: guardMod, filler, overlay } = JC;
  const platform = platforms.detect();
  if (!platform || window.top !== window) return;
  const adapter = platforms.adapters[platform];
  const NAMES = { linkedin: "LinkedIn", internshala: "Internshala", naukri: "Naukri", unstop: "Unstop", wellfound: "Wellfound" };
  const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, platform, ...payload }).catch((e) => ({ ok: false, error: String(e) }));

  const ui = overlay.create(NAMES[platform]);
  const h = overlay.el;
  let halted = false;
  const observers = [];
  const halt = () => { halted = true; observers.forEach((o) => o.disconnect()); };

  function showStopped(reason, until) {
    halt();
    ui.setStatus("stopped");
    ui.render(
      h("div", { class: "stop" }, `All activity on ${NAMES[platform]} is stopped for 48 hours.`),
      h("div", {}, h("b", {}, "Why: "), reason),
      until ? h("div", { class: "muted" }, `Resumes after ${new Date(until * 1000).toLocaleString()}.`) : null,
      h("div", { class: "callout" }, "If there is a CAPTCHA or check, solve it yourself. JobCopilot will not touch it. Take a break from applying on this platform."),
    );
  }

  // ---- 1. Is this platform allowed at all? Fail closed if the backend is down.
  const lock = await send("lock:get");
  if (!lock || !lock.ok) {
    ui.setStatus("offline");
    ui.render(h("div", {}, "Backend not reachable, so JobCopilot is doing nothing on this page."),
      h("div", { class: "muted" }, "Start it with run-backend.cmd, then reload."));
    return;
  }
  if (lock.data.lockout) { showStopped(lock.data.lockout.reason, lock.data.lockout.until); return; }

  const session = (await send("session:here")).data || {};

  // ---- 2. Watchdog. Runs before anything else reads or fills.
  const watchdog = guardMod.start(platform, adapter, { sessionActiveHere: !!(session && session.platformActive) }, {
    onStop: async (reason) => {
      halt();
      const res = await send("platform:stop", { reason });
      showStopped(reason, res.ok && res.data.lockout && res.data.lockout.until);
    },
    onError: async (detail) => {
      const res = await send("platform:error", { detail });
      if (res.ok && res.data.lockout) showStopped(res.data.lockout.reason, res.data.lockout.until);
    },
  });
  observers.push(watchdog);
  const safe = () => !halted && !watchdog.check();
  if (!safe()) return;

  // ---- 3. Route (SPA-aware).
  let route = null;
  let lastHref = "";
  const tick = () => {
    if (halted || location.href === lastHref) return;
    lastHref = location.href;
    if (route && route.stop) route.stop();
    route = adapter.isListing() ? listingPage() : adapter.isResults() ? resultsPage() : idle();
  };
  setInterval(tick, 1000);
  tick();

  function idle() {
    ui.setStatus("");
    ui.render(h("div", { class: "muted" }, "Open a job listing or a search results page."));
    return null;
  }

  // ---------------------------------------------------------------- results page
  function resultsPage() {
    let timer = null;
    let seen = 0;
    const scanCards = async () => {
      timer = null;
      if (!safe()) return;
      const cards = platforms.extractCards(platform);
      if (cards.length === seen) return;
      seen = cards.length;
      const res = await send("ingest", { listings: cards });
      if (!res.ok || halted) return;
      const ls = res.data.listings;
      const good = ls.filter((l) => l.eligible && l.fit_score >= 55 && l.status === "new");
      ui.setStatus(`${ls.length} read`);
      ui.render(
        h("div", {}, `Read ${ls.length} listings already on this page. `, h("b", {}, `${good.length} fit (score ≥ 55)`), " were added to your queue."),
        good.length ? h("ul", {}, good.slice(0, 6).map((l) => h("li", {}, `${Math.round(l.fit_score)} · ${l.title || "Untitled"} · ${l.company || "?"}`))) : null,
        h("div", { class: "muted" }, "Only what you scrolled to is read. Use the toolbar popup → Apply to All to start Rapid Review."),
      );
    };
    const mo = new MutationObserver(() => { if (!timer) timer = setTimeout(scanCards, 3000); });
    mo.observe(document.body, { childList: true, subtree: true });
    observers.push(mo);
    timer = setTimeout(scanCards, 1500);
    return { stop: () => { mo.disconnect(); clearTimeout(timer); } };
  }

  // ---------------------------------------------------------------- listing page
  function listingPage() {
    const state = { listing: null, gate: null, prepared: false, profile: null, resume: null, draft: null,
      askedQuestions: new Set(), texts: new Map(), logged: false, nextTimer: null, stopped: false };
    const isReview = () => session && session.isReviewTab && session.item && state.listing && session.item.id === state.listing.id;
    let formObserver = null;

    (async () => {
      // Listing details render late on SPAs; give the page up to ~10s.
      let details = null;
      for (let i = 0; i < 10 && !state.stopped; i++) {
        details = platforms.extractListing(platform);
        if (details && details.description && details.company) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!details || state.stopped || !safe()) return;
      const ing = await send("ingest", { listings: [details] });
      if (!ing.ok || !ing.data.listings.length) { ui.render(h("div", {}, "Couldn't read this listing.")); return; }
      state.listing = ing.data.listings[0];
      await refreshGate();
      const pending = await send("pending:get");
      if (pending && pending.data && pending.data.listingId === state.listing.id) {
        // We navigated after the user clicked Submit: look for the success page.
        startFormWatch();
      }
      if (isReview() && state.gate.ok) prepare();
      else if (isReview() && !state.gate.wait_only) {
        // Full listing showed it's not a fit (eligibility, company cooldown...): move on.
        render(h("div", { class: "muted" }, "Skipping in 5s…"));
        state.nextTimer = setTimeout(() => { if (!state.stopped) skip(false); }, 5000);
      }
    })();

    async function refreshGate() {
      const res = await send("check", { listingId: state.listing.id });
      state.gate = res.ok ? res.data : { ok: false, blockers: [res.error || "Check failed"] };
      render();
    }

    function render(extra) {
      const l = state.listing, g = state.gate;
      if (!l || !g) return;
      const st = g.platform_status;
      ui.setStatus(st ? `${st.counts.day}/${st.limits.daily} today` : "");
      const score = Math.round(l.fit_score || 0);
      const nodes = [
        h("div", {}, h("b", {}, l.title || "Untitled"), h("div", { class: "muted" }, `${l.company || "Unknown company"} · ${l.location || "location n/a"}`)),
        h("div", { class: "row" },
          h("span", { class: `pill ${score >= 55 ? "ok" : "bad"}` }, `Fit ${score}`),
          h("span", { class: `pill ${l.eligible ? "ok" : "bad"}` }, l.eligible ? "Eligible" : "Not eligible"),
          isReview() ? h("span", { class: "pill warn" }, "Rapid Review") : null),
      ];
      if (!g.ok) {
        nodes.push(h("div", { class: "callout" }, h("b", {}, g.wait_only ? "Not yet:" : "Won't fill this one:"), h("ul", {}, g.blockers.map((b) => h("li", {}, b)))));
        if (isReview()) nodes.push(h("div", { class: "row" }, h("button", { class: "btn secondary", onclick: skip }, "Skip (K)")));
      } else if (!state.prepared) {
        nodes.push(h("button", { class: "btn", onclick: prepare }, "Fill this application"));
        nodes.push(h("div", { class: "muted" }, "Fills fields and attaches your resume. You review and click Submit yourself."));
      } else {
        nodes.push(h("div", { class: "callout" }, "Review every field, then ", h("b", {}, "you"), " click the highlighted ", h("b", {}, "Submit"), ". Blue dashed = Next/Review buttons, also yours to click."));
        if (state.draft && state.draft.too_similar) {
          nodes.push(h("div", { class: "pill bad" }, "Some text was too similar to past applications and was left blank (red). Write it yourself."));
        }
        nodes.push(h("div", { class: "row" },
          h("button", { class: "btn", onclick: () => confirmSubmitted("user_confirmed") }, "I submitted it (S)"),
          isReview() ? h("button", { class: "btn secondary", onclick: skip }, "Skip (K)") : null,
          h("button", { class: "btn secondary", onclick: editMode }, "Edit (E)")));
      }
      if (extra) nodes.push(extra);
      nodes.push(h("div", { class: "muted" }, h("kbd", {}, "S"), " submitted → next  ", h("kbd", {}, "K"), " skip  ", h("kbd", {}, "E"), " edit answer"));
      ui.render(nodes);
    }

    async function prepare() {
      if (state.prepared || !safe()) return;
      await refreshGate(); // limits may have changed since the page loaded
      if (!state.gate.ok) return;
      const [p, r] = await Promise.all([send("profile:get"), send("resume:get")]);
      if (!p.ok) { render(h("div", { class: "pill bad" }, "Couldn't load profile.")); return; }
      state.profile = p.data;
      state.resume = r.ok ? r.data : null;
      state.prepared = true;
      await send("activity:mark"); // a forced logout from here on counts as a stop condition
      render();
      startFormWatch();
    }

    function startFormWatch() {
      if (formObserver) return;
      let t = null;
      const step = () => { t = null; onFormChange(); };
      formObserver = new MutationObserver(() => { if (!t) t = setTimeout(step, 600); });
      formObserver.observe(document.body, { childList: true, subtree: true });
      observers.push(formObserver);
      step();
    }

    async function onFormChange() {
      if (!safe() || state.logged) return;
      const root = adapter.formRoot() || (platform === "internshala" && /\/application\//.test(location.pathname) ? document.body : null);
      if (await checkSuccess(root)) return;
      if (!root || !state.prepared) return;

      const plan = filler.scan(root, state.profile);
      filler.fillProfile(plan, state.profile, state.resume);

      const newQs = plan.questions.map((q) => q.label).filter((q) => !state.askedQuestions.has(q));
      const needCover = plan.cover.length && !(state.draft && state.draft.cover_letter);
      if (newQs.length || needCover) {
        newQs.forEach((q) => state.askedQuestions.add(q));
        render(h("div", { class: "muted" }, "Writing tailored answers…"));
        const res = await send("generate", { listingId: state.listing.id, questions: newQs });
        if (!safe()) return;
        if (!res.ok) {
          render(h("div", { class: "pill bad" }, `Couldn't generate answers: ${res.error}. Write them yourself.`));
          plan.cover.concat(plan.questions).forEach(({ el }) => filler.mark(el, "review"));
        } else {
          const d = res.data;
          state.draft = state.draft
            ? { ...d, cover_letter: state.draft.cover_letter || d.cover_letter, answers: [...state.draft.answers, ...d.answers],
                too_similar_fields: [...new Set([...(state.draft.too_similar_fields || []), ...d.too_similar_fields])] }
            : d;
          state.draft.too_similar = state.draft.too_similar_fields.length > 0;
        }
      }
      if (state.draft) filler.fillGenerated(plan, state.draft);

      const { submit, next } = filler.actionButtons(root);
      filler.highlight(next, "next");
      filler.highlight(submit, "submit");
      // Passive listeners: we only remember what the user is sending when THEY
      // click. We never prevent or trigger anything.
      for (const b of next) {
        if (b.dataset.jcListening) continue;
        b.dataset.jcListening = "1";
        b.addEventListener("click", () => rememberTexts(root), { capture: true, passive: true });
      }
      for (const b of submit) {
        if (b.dataset.jcListening) continue;
        b.dataset.jcListening = "1";
        b.addEventListener("click", () => {
          rememberTexts(root);
          send("pending:set", { data: { listingId: state.listing.id, texts: [...state.texts.values()], at: Date.now() } });
        }, { capture: true, passive: true });
      }
      render();
    }

    function rememberTexts(root) {
      for (const [label, text] of filler.longTexts(root)) state.texts.set(label, text);
    }

    async function checkSuccess(root) {
      const pending = await send("pending:get");
      const mine = pending && pending.data && pending.data.listingId === state.listing.id && Date.now() - pending.data.at < 5 * 60_000;
      if (!mine) return false;
      const scope = [root, ...document.querySelectorAll("[role='dialog'], [role='alert'], [aria-live], h1, h2, h3")].filter(Boolean);
      const hit = scope.some((n) => adapter.success.test((n.innerText || "").slice(0, 3000)));
      if (!hit) return false;
      await confirmSubmitted("success_page", pending.data.texts);
      return true;
    }

    async function confirmSubmitted(how, texts) {
      if (state.logged || !state.listing) return;
      state.logged = true;
      const root = adapter.formRoot();
      if (root) rememberTexts(root);
      const sent = texts || [...state.texts.values()];
      const res = await send("application:log", { listingId: state.listing.id, url: state.listing.url, company: state.listing.company, texts: sent, detectedBy: how });
      await send("pending:clear");
      if (!res.ok) { state.logged = false; render(h("div", { class: "pill bad" }, `Couldn't log: ${res.error}`)); return; }
      ui.setStatus("logged ✓");
      if (session && session.isReviewTab) goNext();
      else render(h("div", { class: "pill ok" }, "Logged. Nice work."));
    }

    // persist=false drops it from this session only (e.g. a 30-day company
    // cooldown that will lift later); the K key marks it skipped for good.
    async function skip(persist = true) {
      if (!state.listing) return;
      clearTimeout(state.nextTimer);
      await send("session:skip", { listingId: state.listing.id, persist: persist !== false });
      goNext();
    }

    // Ask the background for the next listing; it enforces the pacing gap and
    // greys the next item out until it's allowed.
    async function goNext() {
      clearTimeout(state.nextTimer);
      const res = await send("session:next");
      if (!res.ok) { render(h("div", { class: "pill bad" }, res.error)); return; }
      const d = res.data;
      if (d.done) { render(h("div", { class: "pill ok" }, d.message || "Queue finished. Good session.")); return; }
      if (d.opened) return; // tab is navigating
      if (d.waitUntil) {
        const card = h("div", { class: "next" });
        const draw = () => {
          const left = Math.max(0, Math.ceil(d.waitUntil - Date.now() / 1000));
          card.replaceChildren(
            h("div", { class: "muted" }, "Next up"),
            h("b", {}, d.next ? `${d.next.title || "Untitled"} · ${d.next.company || ""}` : "…"),
            h("div", {}, left > 0 ? `Unlocks in ${left}s (${d.reason})` : "Opening…"));
          if (left > 0) state.nextTimer = setTimeout(draw, 1000);
          else goNext();
        };
        render(card);
        draw();
      }
    }

    function editMode() {
      const root = adapter.formRoot() || document;
      const target = root.querySelector("[data-jc-state='blocked'], textarea[data-jc-state='filled'], [contenteditable][data-jc-state='filled']");
      if (!target) return;
      target.scrollIntoView({ block: "center" });
      target.focus();
      if (!target.dataset.jcEditWatch) {
        target.dataset.jcEditWatch = "1";
        target.addEventListener("blur", async () => {
          const text = target.isContentEditable ? target.innerText : target.value;
          const res = await send("similarity", { text });
          if (res.ok && res.data.too_similar) filler.mark(target, "blocked", `Still ${Math.round(res.data.similarity * 100)}% similar to a past application. Rewrite it more.`);
          else if (text.trim()) filler.mark(target, "filled", "Edited by you");
        });
      }
    }

    const onKey = (e) => {
      if (halted || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === "s" && state.prepared) { e.preventDefault(); confirmSubmitted("user_confirmed"); }
      else if (k === "k" && isReview()) { e.preventDefault(); skip(); }
      else if (k === "e" && state.prepared) { e.preventDefault(); editMode(); }
    };
    document.addEventListener("keydown", onKey);

    return { stop: () => { state.stopped = true; clearTimeout(state.nextTimer); document.removeEventListener("keydown", onKey); if (formObserver) formObserver.disconnect(); } };
  }
})();
