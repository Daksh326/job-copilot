// Static guarantee for the hard rules: the extension never clicks, submits,
// synthesizes key presses, or touches CAPTCHAs. Run: node extension/tests/no_autoclick.test.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "tests" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js")) files.push(p);
  }
})(root);

const FORBIDDEN = [
  [/\.click\s*\(/, "calls .click()"],
  [/\.submit\s*\(/, "calls .submit()"],
  [/requestSubmit\s*\(/, "calls requestSubmit()"],
  [/new\s+(Mouse|Pointer|Keyboard|Touch)Event\s*\(/, "synthesizes mouse/pointer/keyboard/touch events"],
  [/dispatchEvent\s*\([^)]*["'`](click|mousedown|mouseup|pointerdown|pointerup|keydown|keypress|keyup|submit)["'`]/, "dispatches click/key/submit events"],
  [/initMouseEvent|createEvent\s*\(\s*["']MouseEvents?/, "legacy synthetic mouse events"],
  [/\bchrome\.debugger\b|\bchrome\.scripting\b|\bwebRequest\b/, "uses automation-capable APIs"],
  [/recaptcha[^\n]*\.(value|textContent)\s*=|captcha[^\n]*\.value\s*=/i, "writes into CAPTCHA fields"],
  [/document\.cookie|chrome\.cookies/, "reads cookies"],
];

let failures = 0;
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return; // comments may name the forbidden things
    for (const [re, why] of FORBIDDEN) {
      if (re.test(line)) {
        failures++;
        console.error(`${f.slice(root.length + 1)}:${i + 1} ${why}\n    ${line.trim()}`);
      }
    }
  });
}

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const perms = new Set(manifest.permissions || []);
for (const p of ["debugger", "scripting", "webRequest", "cookies", "tabs", "<all_urls>"]) {
  if (perms.has(p)) { failures++; console.error(`manifest requests forbidden permission: ${p}`); }
}

if (failures) { console.error(`\n${failures} violation(s)`); process.exit(1); }
console.log(`OK: ${files.length} files, no auto-click / auto-submit / synthetic input / captcha access.`);
