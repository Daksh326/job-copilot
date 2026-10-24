// Stop-condition watchdog. If a platform shows a CAPTCHA, a warning, a
// rate-limit or restriction message, or forces a logout mid-session, all
// activity on that platform stops for 48 hours. The guard only LOOKS: it never
// touches a CAPTCHA or any other element.
"use strict";
window.JC = window.JC || {};

(() => {
  const STOP_PHRASES = [
    /verify (that )?you('| a)re (a )?human/i,
    /are you a robot/i,
    /i'?m not a robot/i,
    /complete (this|the|a) security (check|verification)/i,
    /quick security check/i,
    /security verification/i,
    /unusual (activity|traffic)/i,
    /suspicious activity/i,
    /too many requests/i,
    /rate[- ]limit/i,
    /you'?ve (reached|hit) (the|your) (daily |weekly )?(limit|maximum)/i,
    /(temporarily )?restricted (your|from)/i,
    /account (has been |is |was )?(temporarily )?(restricted|suspended|limited|locked|blocked)/i,
    /we('ve| have) (restricted|limited|suspended)/i,
    /violat(es|ed|ion of) (our )?(user agreement|terms)/i,
    /automated (activity|behaviou?r|tools?)/i,
  ];
  const ERROR_PHRASES = [/something went wrong/i, /an (unexpected )?error (has )?occurred/i, /please try again later/i, /unable to process/i];

  // Places where a site shows warnings. Job descriptions are deliberately not
  // scanned, so a JD mentioning "rate limiting" can't trigger a false stop.
  const NOTICE_SELECTORS = [
    "[role='alert']", "[role='alertdialog']", "[role='dialog']", "[aria-live='assertive']", "[aria-live='polite']",
    ".artdeco-toast-item", ".artdeco-inline-feedback--error", "[class*='toast' i]", "[class*='snackbar' i]",
    "[class*='notification' i]", "[class*='error' i]", "[class*='alert' i]", "[class*='banner' i]", "h1", "h2",
  ].join(",");

  const CAPTCHA_FRAMES = /recaptcha\/(api2|enterprise)\/(anchor|bframe)|hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs|funcaptcha|geetest|captcha/i;

  // minSize 20 for CAPTCHA widgets (tracking pixels and 1px frames aren't
  // challenges); any non-zero size for text notices.
  function visible(el, minSize = 1) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < minSize || r.height < minSize) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  }

  function findCaptcha() {
    for (const f of document.querySelectorAll("iframe[src]")) {
      const src = f.getAttribute("src") || "";
      // Invisible reCAPTCHA v3 badges sit on many normal pages; ignore them.
      if (/size=invisible/.test(src) || f.closest(".grecaptcha-badge")) continue;
      if (CAPTCHA_FRAMES.test(src) && visible(f, 20)) return "CAPTCHA shown";
    }
    for (const el of document.querySelectorAll(".g-recaptcha, .h-captcha, .cf-turnstile, #captcha, [id*='captcha' i]:not(.grecaptcha-badge), img[src*='captcha' i], input[name*='captcha' i]")) {
      if (el.closest(".grecaptcha-badge")) continue;
      if (visible(el, 20)) return "CAPTCHA shown";
    }
    return null;
  }

  function scanText(nodes) {
    for (const el of nodes) {
      const t = (el.innerText || "").slice(0, 2000);
      if (!t) continue;
      const hit = STOP_PHRASES.find((re) => re.test(t));
      if (hit) return { kind: "stop", detail: `Platform message: "${t.match(hit)[0]}"` };
    }
    for (const el of nodes) {
      const t = (el.innerText || "").slice(0, 500);
      const hit = ERROR_PHRASES.find((re) => re.test(t));
      if (hit && visible(el)) return { kind: "error", detail: t.match(hit)[0] };
    }
    return null;
  }

  function inspect(platform, adapter, { sessionActiveHere }) {
    if (adapter.challengeRe.test(location.href)) return { kind: "stop", detail: "Security challenge page" };
    const captcha = findCaptcha();
    if (captcha) return { kind: "stop", detail: captcha };
    if (sessionActiveHere && adapter.loginRe.test(location.href)) {
      return { kind: "stop", detail: "Forced logout during a review session" };
    }
    const titleHit = STOP_PHRASES.find((re) => re.test(document.title));
    if (titleHit) return { kind: "stop", detail: `Page title: "${document.title}"` };
    const nodes = [...document.querySelectorAll(NOTICE_SELECTORS)].filter((el) => !el.closest("#jc-root-host"));
    const hit = scanText(nodes);
    if (hit) return hit;
    // Challenge/interstitial pages are short; a full scan of a short body is safe.
    const body = document.body ? document.body.innerText || "" : "";
    if (body.length < 3000) {
      const bodyHit = STOP_PHRASES.find((re) => re.test(body));
      if (bodyHit) return { kind: "stop", detail: `Platform message: "${body.match(bodyHit)[0]}"` };
    }
    return null;
  }

  // Calls onStop exactly once; reports at most one error per distinct message
  // per minute (the backend turns 3 errors in 15 minutes into a stop).
  function start(platform, adapter, opts, { onStop, onError }) {
    let stopped = false;
    const reported = new Map();
    let pending = null;

    const run = () => {
      pending = null;
      if (stopped) return;
      const res = inspect(platform, adapter, opts);
      if (!res) return;
      if (res.kind === "stop") {
        stopped = true;
        observer.disconnect();
        onStop(res.detail);
      } else {
        const last = reported.get(res.detail) || 0;
        if (Date.now() - last > 60_000) {
          reported.set(res.detail, Date.now());
          onError(res.detail);
        }
      }
    };
    const observer = new MutationObserver(() => {
      if (!pending) pending = setTimeout(run, 400);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    run();
    return {
      check: () => { run(); return stopped; },
      get stopped() { return stopped; },
      disconnect: () => observer.disconnect(),
    };
  }

  JC.guard = { start, inspect };
})();
