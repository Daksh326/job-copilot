// Form filling, the way autofill tools do it: set values and fire input/change
// events. HARD RULE: nothing in this file (or anywhere in the extension) calls
// .click(), .submit(), .requestSubmit() or dispatches a click. The user clicks
// every button, including Next and Submit. tests/no_autoclick.test.mjs enforces this.
"use strict";
window.JC = window.JC || {};

(() => {
  const norm = (s) => (s || "").replace(/\s+/g, " ").replace(/[*:]+\s*$/, "").trim();

  function labelFor(el) {
    const parts = [];
    const aria = el.getAttribute("aria-label");
    if (aria) parts.push(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) by.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) parts.push(n.innerText); });
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) parts.push(l.innerText);
    }
    const wrap = el.closest("label");
    if (wrap) parts.push(wrap.innerText);
    const fs = el.closest("fieldset");
    if (fs && fs.querySelector("legend")) parts.push(fs.querySelector("legend").innerText);
    if (!parts.length) {
      // Nearest preceding text in the same field group.
      const group = el.closest("[class*='form-group' i], [class*='form-element' i], [class*='question' i], [class*='field' i], div");
      if (group) {
        const t = [...group.querySelectorAll("label, legend, span, p, h3, h4, div")]
          .filter((n) => !n.contains(el) && n.innerText && n.innerText.length < 300)
          .map((n) => n.innerText)[0];
        if (t) parts.push(t);
      }
    }
    if (el.placeholder) parts.push(el.placeholder);
    if (!parts.length && el.name) parts.push(el.name.replace(/[_-]+/g, " "));
    return norm(parts.join(" ").split("\n")[0]);
  }

  // Profile fields matched by label. Order matters: first match wins.
  const PROFILE_FIELDS = [
    [/first name|given name/i, (p) => (p.name || "").split(" ")[0]],
    [/last name|surname|family name/i, (p) => (p.name || "").split(" ").slice(1).join(" ")],
    [/^(full )?name$|your name|candidate name/i, (p) => p.name],
    [/e-?mail/i, (p) => p.email],
    [/country code/i, (p) => p.phone_country_code],
    [/phone|mobile|contact (no|number)/i, (p) => p.phone],
    [/linkedin/i, (p) => p.links && p.links.linkedin],
    [/github/i, (p) => p.links && p.links.github],
    [/portfolio|personal (web)?site|website/i, (p) => p.links && p.links.portfolio],
    [/graduat\w* year|year of (graduation|passing)|passing year|pass ?out year|batch/i, (p) => p.graduation_year && String(p.graduation_year)],
    [/cgpa|gpa|cpi|percentage|aggregate/i, (p) => p.cgpa && String(p.cgpa)],
    [/college|university|institut/i, (p) => p.college],
    [/degree|qualification/i, (p) => p.degree],
    [/branch|major|specialization|stream/i, (p) => p.branch],
    [/current (city|location)|^city$|^location$|where are you (based|located)/i, (p) => p.current_city],
    [/notice period/i, (p) => p.answers && p.answers.notice_period],
    [/years? of (work |relevant |total )?experience|total experience/i, (p) => p.years_experience != null ? String(p.years_experience) : null],
    [/expected (stipend|salary|ctc|compensation)/i, (p) => p.answers && p.answers.expected_compensation],
    [/current (ctc|salary|compensation)/i, (p) => p.answers && p.answers.current_compensation],
    [/availab|start date|joining date|when can you (start|join)|how soon/i, (p) => p.answers && p.answers.availability],
    [/relocat/i, (p) => p.answers && p.answers.relocate],
  ];

  const COVER_RE = /cover letter|why should (you|we) (be )?hire|why (are you|do you think you are) (interested|a good fit|the right fit|suitable)|why do you want (to work|this role|to join)/i;
  const NEVER_TOUCH_RE = /captcha|password|otp|one[- ]time|i agree|terms|consent|privacy|declar|certify|confirm|signature|gender|disab|veteran|ethnic|race|religio|caste|marital/i;

  function fieldsIn(root) {
    return [...root.querySelectorAll("input, textarea, select, [contenteditable='true']")].filter((el) => {
      if (el.closest("#jc-root-host")) return false;
      if (el.disabled || el.readOnly) return false;
      const type = (el.type || "").toLowerCase();
      if (["hidden", "password", "search", "submit", "button", "image", "reset"].includes(type)) return false;
      // File inputs are often visually hidden behind an "Upload" button.
      if (type !== "file" && el.offsetParent === null) return false;
      return true;
    });
  }

  function isLongText(el, label) {
    if (el.tagName === "TEXTAREA" || el.isContentEditable) return true;
    const max = Number(el.getAttribute("maxlength") || 0);
    return (el.type === "text" || !el.type) && (max > 200 || (/\?$/.test(label) && label.length > 25));
  }

  function isEmpty(el) {
    if (el.type === "file") return !el.files || el.files.length === 0;
    if (el.type === "checkbox" || el.type === "radio") return false; // handled per group
    if (el.isContentEditable) return !(el.innerText || "").trim();
    return !(el.value || "").trim();
  }

  function setValue(el, value) {
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      return;
    }
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function setSelect(el, value) {
    const want = String(value).toLowerCase();
    const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want)
      || [...el.options].find((o) => o.text.trim().toLowerCase().startsWith(want));
    if (!opt) return false;
    setValue(el, opt.value);
    return true;
  }

  function setRadioGroup(radios, value) {
    const want = String(value).toLowerCase();
    const match = radios.find((r) => labelFor(r).toLowerCase() === want || (r.value || "").toLowerCase() === want);
    if (!match) return false;
    match.checked = true;
    match.dispatchEvent(new Event("input", { bubbles: true }));
    match.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function attachResume(input, resume) {
    const bytes = Uint8Array.from(atob(resume.base64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], resume.filename || "resume.pdf", { type: "application/pdf" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function mark(el, kind, note) {
    const colors = { filled: "#16a34a", review: "#f59e0b", blocked: "#dc2626" };
    el.style.outline = `2px solid ${colors[kind]}`;
    el.style.outlineOffset = "2px";
    el.dataset.jcState = kind;
    if (note) el.title = note;
  }

  function customAnswer(profile, label) {
    for (const c of profile.custom_answers || []) {
      try { if (c.match && new RegExp(c.match, "i").test(label)) return c.answer; } catch (_) { /* bad regex in profile */ }
    }
    return null;
  }

  // Classify every field in the form. Returns what can be filled from the
  // profile now, and the long-form questions that need a generated answer.
  function scan(root, profile) {
    const plan = { profile: [], questions: [], cover: [], files: [], manual: [], radios: new Map() };
    for (const el of fieldsIn(root)) {
      if (el.dataset.jcState) continue; // already handled
      const label = labelFor(el);
      if (NEVER_TOUCH_RE.test(label) || NEVER_TOUCH_RE.test(el.name || "")) { plan.manual.push({ el, label }); continue; }
      if (el.type === "file") {
        if (/resume|cv|curriculum/i.test(label + " " + (el.name || "") + " " + (el.accept || "")) || /pdf/.test(el.accept || "")) plan.files.push({ el, label });
        continue;
      }
      if (el.type === "radio") {
        const key = el.name || label;
        if (!plan.radios.has(key)) plan.radios.set(key, []);
        plan.radios.get(key).push(el);
        continue;
      }
      if (el.type === "checkbox") { plan.manual.push({ el, label }); continue; }
      if (!isEmpty(el)) continue;
      const custom = customAnswer(profile, label);
      if (custom) { plan.profile.push({ el, label, value: custom }); continue; }
      if (COVER_RE.test(label)) { plan.cover.push({ el, label }); continue; }
      const hit = PROFILE_FIELDS.find(([re]) => re.test(label));
      const value = hit && hit[1](profile);
      if (value && !isLongText(el, label)) { plan.profile.push({ el, label, value }); continue; }
      if (isLongText(el, label)) { plan.questions.push({ el, label }); continue; }
      plan.manual.push({ el, label });
    }
    return plan;
  }

  function fillProfile(plan, profile, resume) {
    let filled = 0;
    for (const { el, label, value } of plan.profile) {
      const ok = el.tagName === "SELECT" ? setSelect(el, value) : (setValue(el, value), true);
      mark(el, ok ? "filled" : "review", ok ? `Filled from profile: ${label}` : `Pick this yourself: ${label}`);
      if (ok) filled++;
    }
    for (const [key, radios] of plan.radios) {
      const label = labelFor(radios[0].closest("fieldset") || radios[0]) || key;
      if (radios.some((r) => r.checked)) continue;
      const custom = customAnswer(profile, label);
      const hit = PROFILE_FIELDS.find(([re]) => re.test(label));
      const value = custom || (hit && hit[1](profile));
      const ok = value ? setRadioGroup(radios, value) : false;
      radios.forEach((r) => mark(r.closest("label") || r, ok ? "filled" : "review"));
      if (ok) filled++;
    }
    for (const { el } of plan.files) {
      if (resume && isEmpty(el)) { attachResume(el, resume); mark(el.closest("label, div") || el, "filled", "Resume attached"); filled++; }
    }
    for (const { el, label } of plan.manual) {
      if (isEmpty(el)) mark(el, "review", `Fill this yourself: ${label}`);
    }
    return filled;
  }

  // Paste generated text. Fields flagged as too similar to a past submission
  // are NOT pasted: the user must write them.
  function fillGenerated(plan, draft) {
    const tooSimilar = new Set(draft.too_similar_fields || []);
    const filled = [];
    for (const { el } of plan.cover) {
      if (tooSimilar.has("cover_letter")) { mark(el, "blocked", "Too similar to a previous application: write this one yourself (E)."); continue; }
      setValue(el, draft.cover_letter);
      mark(el, "filled", "Generated for this listing. Review before you submit.");
      filled.push(el);
    }
    plan.questions.forEach(({ el, label }) => {
      const a = (draft.answers || []).find((x) => x.question === label);
      if (!a || !a.answer) { mark(el, "review", `No answer generated: ${label}`); return; }
      if (tooSimilar.has(label)) { mark(el, "blocked", "Too similar to a previous application: write this one yourself (E)."); return; }
      setValue(el, a.answer);
      mark(el, "filled", "Generated for this listing. Review before you submit.");
      filled.push(el);
    });
    return filled;
  }

  // Find the buttons the USER must click. We only highlight them.
  function actionButtons(root) {
    const btns = [...root.querySelectorAll("button, input[type='submit'], [role='button']")]
      .filter((b) => b.offsetParent !== null && !b.closest("#jc-root-host"));
    const label = (b) => norm(b.innerText || b.value || b.getAttribute("aria-label") || "");
    const submit = btns.filter((b) => /^(submit( application)?|send application|apply|apply now|submit & apply|confirm and apply|send)$/i.test(label(b)));
    const next = btns.filter((b) => /^(next|continue|review( your application)?|proceed|save (&|and) next)$/i.test(label(b)));
    return { submit, next };
  }

  function highlight(buttons, kind) {
    for (const b of buttons) {
      b.style.outline = kind === "submit" ? "4px solid #f59e0b" : "3px dashed #2563eb";
      b.style.outlineOffset = "3px";
      b.dataset.jcButton = kind;
    }
  }

  // Long-form text the user is about to send (for the uniqueness history).
  // Returns [label, text] pairs so multi-step forms can be accumulated per step.
  function longTexts(root) {
    return fieldsIn(root)
      .filter((el) => el.tagName === "TEXTAREA" || el.isContentEditable || (el.value || "").split(/\s+/).length > 25)
      .map((el) => [labelFor(el), (el.isContentEditable ? el.innerText : el.value) || ""])
      .filter(([, t]) => t.trim().split(/\s+/).length >= 25);
  }

  JC.filler = { scan, fillProfile, fillGenerated, actionButtons, highlight, longTexts, labelFor, mark };
})();
