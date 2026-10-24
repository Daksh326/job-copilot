// The JobCopilot panel. Lives in a shadow root so it never restyles (or gets
// restyled by) the site.
"use strict";
window.JC = window.JC || {};

(() => {
  const CSS = `
    :host { all: initial; }
    .panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; width: 340px; max-height: 70vh;
      overflow: auto; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #0f172a;
      background: #fff; border: 1px solid #cbd5e1; border-radius: 12px; box-shadow: 0 10px 30px rgba(15,23,42,.18); }
    .hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #e2e8f0;
      font-weight: 600; position: sticky; top: 0; background: inherit; }
    .hd .grow { flex: 1; }
    .hd button { all: unset; cursor: pointer; padding: 0 4px; color: #64748b; }
    .bd { padding: 10px 12px; display: grid; gap: 8px; }
    .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; background: #e2e8f0; }
    .ok { background: #dcfce7; color: #166534; } .warn { background: #fef3c7; color: #92400e; } .bad { background: #fee2e2; color: #991b1b; }
    .stop { background: #dc2626; color: #fff; border-radius: 8px; padding: 10px; font-weight: 600; }
    .muted { color: #64748b; font-size: 12px; }
    ul { margin: 0; padding-left: 18px; }
    .btn { all: unset; cursor: pointer; text-align: center; padding: 7px 10px; border-radius: 8px; background: #0f172a; color: #fff; font-weight: 600; }
    .btn.secondary { background: #e2e8f0; color: #0f172a; }
    .btn[disabled] { opacity: .45; cursor: not-allowed; }
    .row { display: flex; gap: 6px; flex-wrap: wrap; }
    .next { border: 1px dashed #94a3b8; border-radius: 8px; padding: 8px; opacity: .55; }
    .next.ready { opacity: 1; border-style: solid; }
    kbd { font: 11px ui-monospace, monospace; border: 1px solid #cbd5e1; border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; background: #f8fafc; }
    .callout { border-left: 3px solid #f59e0b; padding: 6px 8px; background: #fffbeb; border-radius: 4px; }
    @media (prefers-color-scheme: dark) {
      .panel { background: #0f172a; color: #e2e8f0; border-color: #334155; }
      .hd { border-color: #1e293b; } .pill { background: #1e293b; } .btn { background: #e2e8f0; color: #0f172a; }
      .btn.secondary { background: #1e293b; color: #e2e8f0; } kbd { background: #1e293b; border-color: #475569; }
      .callout { background: #422006; } .muted { color: #94a3b8; }
    }`;

  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : String(kid));
    return n;
  }

  function create(platformName) {
    const host = document.createElement("div");
    host.id = "jc-root-host";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.append(el("style", {}, CSS));
    const status = el("span", { class: "muted" });
    const body = el("div", { class: "bd" });
    let collapsed = false;
    const toggle = el("button", { title: "Collapse", onclick: () => { collapsed = !collapsed; body.style.display = collapsed ? "none" : ""; } }, "–");
    const panel = el("div", { class: "panel" },
      el("div", { class: "hd" }, el("span", {}, "JobCopilot"), el("span", { class: "pill" }, platformName), el("span", { class: "grow" }), status, toggle),
      body);
    shadow.append(panel);
    document.documentElement.append(host);

    return {
      el,
      setStatus(t) { status.textContent = t; },
      render(...nodes) { body.replaceChildren(...nodes.flat().filter(Boolean)); },
      remove() { host.remove(); },
    };
  }

  JC.overlay = { create, el };
})();
