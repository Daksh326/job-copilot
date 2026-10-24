# JobCopilot

A job-application assistant built around one goal: **your accounts never get warned, restricted or banned.**
It's a Chrome extension that runs in your normal Chrome profile, plus a local FastAPI backend.
It reads pages you open, fills forms, and stops there. **You click every Submit yourself.**

```
extension/   Chrome MV3 extension (reads + fills, never clicks)
backend/     FastAPI + SQLite: profile, fit score, eligibility, limits, lockouts, generation, tracking
```

## Setup

1. **Backend.** Run `run-backend.cmd` (double-click it, or `.\run-backend.cmd` in a terminal). It creates `backend\.venv`
   the first time and listens on `127.0.0.1:8765` only. Keep that window open while you apply; Ctrl+C stops it.
   (`run-backend.ps1` does the same, but Windows blocks `.ps1` scripts unless you've changed PowerShell's execution policy.)
   For generated cover letters and answers, set `ANTHROPIC_API_KEY` (or run `ant auth login`) before you start it.
   Default model `claude-opus-5-5`; override with `JOBCOPILOT_MODEL` / `JOBCOPILOT_EFFORT`.
2. **Extension.** Go to `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and select
   `D:\job-copilot\extension`, the folder that directly contains `manifest.json`. Selecting `D:\job-copilot` instead gives
   "Manifest file is missing or unreadable".
3. **Profile.** Open the extension's options page. Edit the profile JSON (a template is pre-filled) and upload your resume PDF.
   Only facts in the profile are used for answers. Eligibility checks need `graduation_year`, `degree`, `locations` and `work_modes`.

## How you use it

- Browse search results on LinkedIn, Internshala, Naukri, Unstop or Wellfound the way you normally do. The extension reads
  the cards already on screen (it never scrolls or fetches), scores them, and queues the ones with fit ≥ 55.
- Optional passive sources: add RSS feeds (fetched at most every 6 h), or paste a job-alert email on the options page.
- Toolbar popup → **Apply to All (Rapid Review)**. Listings open one at a time in one tab:
  - the extension reads the full listing, re-checks eligibility, then fills fields, attaches your resume and pastes answers
    tailored to that listing;
  - **you** click Next/Review (blue dashed outline) and **Submit** (amber outline);
  - it spots the success message, logs the application and opens the next listing once pacing allows. Until then the next one
    stays greyed out with a countdown.
  - Keys: **S** = I submitted it → next · **K** = skip · **E** = edit the generated answer.
- Outside a session, open any listing and press **Fill this application** in the panel.

## Safety rules and where they're enforced

| Rule | Where |
|---|---|
| Never clicks Submit/Next/Easy Apply, never dispatches clicks, keys or form submits | `extension/content/filler.js`; checked by `extension/tests/no_autoclick.test.mjs` |
| Limits: LinkedIn 10/day and 3/hour; Internshala, Naukri, Unstop, Wellfound 15/day each; 40/day total; at least 60 s between submissions on a platform (rolling windows) | `backend/app/safety.py` `platform_status`, checked before every fill and before opening the next listing |
| Raising a cap needs a second "I understand the risk" confirmation and shows warnings. Gap, fit score and company cooldown can only be made stricter | `safety.validate_limit_change`, `PUT /settings/limits` |
| Only fit ≥ 55, eligible listings get queued or filled | `GET /queue`, `gate()` in `main.py` |
| No second application to the same company within 30 days, any role ("Acme Pvt Ltd" = "ACME") | `safety.normalize_company`, `company_recently_applied` |
| Eligibility: graduation year, degree, location, work mode, excluded companies | `safety.check_eligibility` |
| Every cover letter or long answer is compared with the last 20 submissions. Over 70% similar → regenerated (up to 3 tries). Still too similar → it isn't pasted and you write it | `generator.generate_draft`, `/similarity` re-checks your edits |
| CAPTCHA, "verify you're human", unusual-activity, rate-limit or restriction messages, a forced logout mid-session, or 3 errors in 15 min → **all activity on that platform stops for 48 h** and you get an alert | `extension/content/guard.js` → `safety.lock_platform`; also mirrored in `chrome.storage.local` so it holds while the backend is offline |
| Backend offline → the extension does nothing (fails closed) | `content.js` |
| Listing pages on one platform open at most once every 15 s | `background.js` `PAGE_OPEN_GAP_S` |
| No passwords stored, no multiple accounts, IP rotation or fingerprint tricks. Emails and phone numbers are removed from stored job descriptions | by design; `sources.redact` |

The guard only scans alerts, dialogs, toasts and headings (plus very short pages), not job descriptions, so a JD that
mentions "rate limiting" doesn't trigger a stop. Invisible reCAPTCHA v3 badges are ignored. A visible CAPTCHA is not.

## Tests

```bash
backend/.venv/Scripts/python.exe -m pytest backend/tests -q
```
```bash
node extension/tests/no_autoclick.test.mjs
```
`extension/tests/harness.html` exercises the filler and guard against a mock application form. Serve the `extension`
folder over HTTP and open `/tests/harness.html`; the page title becomes `ALL PASS`.

## Known limits

- The site selectors in `extension/content/platforms.js` come from each site's markup as I know it and **have not been tried on the
  live sites**. All five sites change their markup often. Each adapter falls back to generic heuristics, but expect to fix
  selectors. When a field can't be identified, it's outlined orange for you to fill in, never guessed.
- Success detection only fires after you click a highlighted Submit button. If a site's confirmation text isn't recognised,
  press **S**.
- Naukri's chat-style question drawer is only partly supported (contenteditable inputs).
