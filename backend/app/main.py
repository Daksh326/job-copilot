import json
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import config, db, generator, matching, safety, sources

@asynccontextmanager
async def lifespan(_app):
    db.init()
    yield


app = FastAPI(title="JobCopilot backend", lifespan=lifespan)

# Only the extension may talk to us. The service worker uses host_permissions and
# needs no CORS at all; this just keeps random web pages from reading responses.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://[a-p]{32}$",
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------- models

class ListingIn(BaseModel):
    url: str
    title: str | None = None
    company: str | None = None
    location: str | None = None
    work_mode: str | None = None
    description: str | None = None
    source: str = "results_page"


class IngestIn(BaseModel):
    listings: list[ListingIn]


class GenerateIn(BaseModel):
    listing_id: str
    questions: list[str] = Field(default_factory=list)


class ApplicationIn(BaseModel):
    listing_id: str | None = None
    url: str | None = None
    platform: str
    company: str | None = None
    texts: list[str] = Field(default_factory=list)
    detected_by: str = "success_page"


class StopIn(BaseModel):
    platform: str
    reason: str


class ErrorIn(BaseModel):
    platform: str
    detail: str


class FeedIn(BaseModel):
    url: str


class EmailIn(BaseModel):
    raw: str


def _platform(p: str) -> str:
    if p not in config.PLATFORMS:
        raise HTTPException(400, f"Unknown platform '{p}'")
    return p


# ---------------------------------------------------------------- profile

@app.get("/health")
def health():
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    return {"ok": True, "model": config.LLM_MODEL, "anthropic_key_loaded": has_key}


@app.get("/profile")
def get_profile():
    p = db.get_profile()
    p["has_resume"] = config.RESUME_PATH.exists()
    return p


@app.put("/profile")
def put_profile(profile: dict):
    profile.pop("has_resume", None)
    db.save_profile(profile)
    return {"ok": True}


@app.post("/profile/resume")
async def upload_resume(file: UploadFile = File(...)):
    data = await file.read()
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, "Resume must be a PDF.")
    config.RESUME_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.RESUME_PATH.write_bytes(data)
    p = db.get_profile()
    p["resume_filename"] = file.filename or "resume.pdf"
    db.save_profile(p)
    return {"ok": True, "bytes": len(data)}


@app.get("/profile/resume")
def get_resume():
    if not config.RESUME_PATH.exists():
        raise HTTPException(404, "No resume uploaded.")
    name = db.get_profile().get("resume_filename", "resume.pdf")
    return FileResponse(config.RESUME_PATH, media_type="application/pdf", filename=name)


# ---------------------------------------------------------------- settings

@app.get("/settings/limits")
def get_limits():
    return {"limits": safety.effective_limits(), "defaults": {
        "platforms": config.DEFAULT_LIMITS, "total_daily": config.DEFAULT_TOTAL_DAILY,
        "min_gap_seconds": config.MIN_GAP_SECONDS, "min_fit_score": config.MIN_FIT_SCORE,
        "company_cooldown_days": config.COMPANY_COOLDOWN_DAYS,
    }}


@app.put("/settings/limits")
def put_limits(body: dict):
    clean, warnings, errors = safety.validate_limit_change(body)
    if errors:
        raise HTTPException(400, {"errors": errors})
    if warnings and not body.get("i_understand_the_risk"):
        # Two-step: the extension must show these and send the flag back.
        return {"saved": False, "warnings": warnings, "needs_confirmation": True}
    db.set_setting("limits", clean)
    return {"saved": True, "warnings": warnings, "limits": safety.effective_limits()}


# ---------------------------------------------------------------- listings

def _upsert(item: ListingIn, profile: dict, now: float) -> dict | None:
    ident = sources.external_id(item.url)
    if not ident:
        return None
    platform, ext = ident
    lid = f"{platform}:{ext}"
    with db.session() as conn:
        row = conn.execute("SELECT * FROM listings WHERE id = ?", (lid,)).fetchone()
        cur = db.row_to_listing(row) if row else {}
        merged = {
            "title": item.title or cur.get("title"),
            "company": item.company or cur.get("company"),
            "location": item.location or cur.get("location"),
            "work_mode": item.work_mode or cur.get("work_mode"),
            # Keep the longest description we've seen (listing page > results card).
            "description": max([sources.redact(item.description) or "", cur.get("description") or ""], key=len) or None,
        }
        listing = {**merged, "id": lid, "platform": platform, "url": sources.canonical_url(platform, ext, item.url)}
        score, reasons = matching.fit_score(listing, profile)
        elig = safety.check_eligibility(listing, profile)
        values = (
            platform, ext, listing["url"], merged["title"], merged["company"], safety.normalize_company(merged["company"]),
            merged["location"], merged["work_mode"], merged["description"], item.source if not row else cur["source"],
            score, json.dumps(reasons), int(elig["eligible"]), json.dumps(elig["reasons"]), now,
        )
        if row:
            conn.execute(
                "UPDATE listings SET platform=?, external_id=?, url=?, title=?, company=?, company_key=?, location=?, "
                "work_mode=?, description=?, source=?, fit_score=?, fit_reasons=?, eligible=?, ineligible_reasons=?, "
                "updated_at=? WHERE id=?",
                (*values, lid),
            )
        else:
            conn.execute(
                "INSERT INTO listings(platform, external_id, url, title, company, company_key, location, work_mode, "
                "description, source, fit_score, fit_reasons, eligible, ineligible_reasons, updated_at, id, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (*values, lid, now),
            )
        out = db.row_to_listing(conn.execute("SELECT * FROM listings WHERE id = ?", (lid,)).fetchone())
    out["unknowns"] = elig["unknowns"]
    return out


@app.post("/listings/ingest")
def ingest(body: IngestIn):
    profile, now = db.get_profile(), time.time()
    out = [r for r in (_upsert(i, profile, now) for i in body.listings[:100]) if r]
    return {"listings": out}


@app.get("/listings/{listing_id:path}")
def get_listing(listing_id: str):
    with db.session() as conn:
        row = conn.execute("SELECT * FROM listings WHERE id = ?", (listing_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Unknown listing")
    return db.row_to_listing(row)


@app.post("/listings/{listing_id:path}/skip")
def skip(listing_id: str):
    with db.session() as conn:
        conn.execute("UPDATE listings SET status = 'skipped', updated_at = ? WHERE id = ?", (time.time(), listing_id))
    return {"ok": True}


@app.get("/listings")
def list_listings(status: str | None = None, limit: int = 200):
    q, args = "SELECT * FROM listings", []
    if status:
        q += " WHERE status = ?"
        args.append(status)
    q += " ORDER BY updated_at DESC LIMIT ?"
    args.append(limit)
    with db.session() as conn:
        return {"listings": [db.row_to_listing(r) for r in conn.execute(q, args)]}


def gate(listing: dict, now: float | None = None) -> dict:
    """Everything that must be true before the extension may fill a form."""
    now = now or time.time()
    limits = safety.effective_limits()
    blockers = []
    status = safety.platform_status(listing["platform"], now)
    blockers += status["reasons"]
    if listing["status"] == "applied":
        blockers.append("Already applied to this listing.")
    if listing["eligible"] is False:
        blockers += [f"Not eligible: {r}" for r in listing["ineligible_reasons"]]
    if (listing["fit_score"] or 0) < limits["min_fit_score"]:
        blockers.append(f"Fit score {listing['fit_score'] or 0:.0f} is below {limits['min_fit_score']}.")
    last = safety.company_recently_applied(listing.get("company_key"), now)
    if last:
        blockers.append(
            f"Applied to {listing['company']} on {time.strftime('%d %b', time.localtime(last))}; "
            f"wait {limits['company_cooldown_days']} days between applications to the same company."
        )
    # Limits that only lift with time are "wait"; everything else is a hard skip.
    only_waiting = bool(blockers) and len(blockers) == len(status["reasons"]) and not status["lockout"]
    return {"ok": not blockers, "blockers": blockers, "wait_only": only_waiting,
            "next_allowed_at": status["next_allowed_at"], "platform_status": status}


@app.get("/check/{listing_id:path}")
def check(listing_id: str):
    listing = get_listing(listing_id)
    return {"listing": listing, **gate(listing)}


@app.get("/queue")
def queue(limit: int = 40):
    """Listings worth a human review, capped by each platform's remaining
    capacity today. One listing per company."""
    now = time.time()
    limits = safety.effective_limits()
    with db.session() as conn:
        rows = conn.execute(
            "SELECT * FROM listings WHERE status = 'new' AND eligible = 1 AND fit_score >= ? "
            "ORDER BY fit_score DESC, updated_at DESC",
            (limits["min_fit_score"],),
        ).fetchall()
    remaining = {}
    total_left = limits["total_daily"]
    for p in config.PLATFORMS:
        st = safety.platform_status(p, now)
        if st["lockout"]:
            remaining[p] = 0
            continue
        remaining[p] = max(0, st["limits"]["daily"] - st["counts"]["day"])
        total_left = min(total_left, limits["total_daily"] - st["counts"]["total_day"])
    picked, seen_companies = [], set()
    for r in rows:
        item = db.row_to_listing(r)
        key = item["company_key"]
        if remaining.get(item["platform"], 0) <= 0 or len(picked) >= min(limit, max(0, total_left)):
            continue
        if key and (key in seen_companies or safety.company_recently_applied(key, now)):
            continue
        picked.append(item)
        seen_companies.add(key)
        remaining[item["platform"]] -= 1
    return {"queue": picked, "remaining": remaining, "total_left": max(0, total_left)}


# ---------------------------------------------------------------- generation

@app.post("/generate")
def generate(body: GenerateIn):
    listing = get_listing(body.listing_id)
    g = gate(listing)
    if not g["ok"]:
        raise HTTPException(409, {"blockers": g["blockers"]})
    try:
        draft = generator.generate_draft(listing, db.get_profile(), body.questions[:15])
    except generator.GenerationUnavailable as e:
        raise HTTPException(503, str(e))
    with db.session() as conn:
        conn.execute(
            "INSERT INTO drafts(listing_id, cover_letter, answers, max_similarity, too_similar, created_at) "
            "VALUES (?,?,?,?,?,?) ON CONFLICT(listing_id) DO UPDATE SET cover_letter=excluded.cover_letter, "
            "answers=excluded.answers, max_similarity=excluded.max_similarity, too_similar=excluded.too_similar, "
            "created_at=excluded.created_at",
            (listing["id"], draft["cover_letter"], json.dumps(draft["answers"]), draft["max_similarity"],
             int(draft["too_similar"]), time.time()),
        )
    return draft


class SimilarityIn(BaseModel):
    text: str


@app.post("/similarity")
def check_similarity(body: SimilarityIn):
    """Used when the user edits an answer (E): is the edited text still unique?"""
    if not safety.needs_uniqueness_check(body.text):
        return {"similarity": 0.0, "too_similar": False}
    score, _ = safety.max_similarity(body.text, safety.recent_submission_texts())
    return {"similarity": round(score, 3), "too_similar": score > config.SIMILARITY_THRESHOLD}


# ---------------------------------------------------------------- applications

@app.post("/applications")
def log_application(body: ApplicationIn):
    _platform(body.platform)
    now = time.time()
    listing = None
    lid = body.listing_id
    if not lid and body.url:
        ident = sources.external_id(body.url)
        lid = f"{ident[0]}:{ident[1]}" if ident else None
    if lid:
        with db.session() as conn:
            row = conn.execute("SELECT * FROM listings WHERE id = ?", (lid,)).fetchone()
            listing = db.row_to_listing(row) if row else None
            if listing and listing["status"] == "applied":
                return {"ok": True, "duplicate": True, "status": safety.platform_status(body.platform, now)}
    company = (listing or {}).get("company") or body.company
    with db.session() as conn:
        conn.execute(
            "INSERT INTO applications(listing_id, platform, company_key, submitted_at, texts, detected_by) "
            "VALUES (?,?,?,?,?,?)",
            (lid, body.platform, safety.normalize_company(company), now,
             json.dumps([t for t in body.texts if t]), body.detected_by),
        )
        if lid:
            conn.execute("UPDATE listings SET status = 'applied', updated_at = ? WHERE id = ?", (now, lid))
    return {"ok": True, "status": safety.platform_status(body.platform, now)}


@app.get("/applications")
def list_applications(days: int = 30):
    since = time.time() - days * 86400
    with db.session() as conn:
        rows = conn.execute(
            "SELECT a.id, a.listing_id, a.platform, a.submitted_at, a.detected_by, l.title, l.company, l.url "
            "FROM applications a LEFT JOIN listings l ON l.id = a.listing_id "
            "WHERE a.submitted_at >= ? ORDER BY a.submitted_at DESC",
            (since,),
        ).fetchall()
    return {"applications": [dict(r) for r in rows]}


# ---------------------------------------------------------------- safety

@app.get("/safety/status")
def safety_status():
    now = time.time()
    return {"now": now, "platforms": {p: safety.platform_status(p, now) for p in config.PLATFORMS}}


@app.post("/safety/stop")
def safety_stop(body: StopIn):
    return {"lockout": safety.lock_platform(_platform(body.platform), body.reason)}


@app.post("/safety/error")
def safety_error(body: ErrorIn):
    return {"lockout": safety.record_error(_platform(body.platform), body.detail)}


# ---------------------------------------------------------------- passive sources

@app.get("/sources/feeds")
def feeds():
    return {"feeds": sources.list_feeds(), "min_interval_hours": config.RSS_MIN_INTERVAL_HOURS}


@app.post("/sources/feeds")
def add_feed(body: FeedIn):
    sources.add_feed(body.url)
    return {"ok": True}


@app.post("/sources/feeds/refresh")
def refresh_feeds():
    """Fetch only feeds not fetched in the last RSS_MIN_INTERVAL_HOURS."""
    items, errors = [], []
    for url in sources.due_feeds():
        try:
            items += sources.fetch_feed(url)
        except Exception as e:  # one bad feed shouldn't block the rest
            errors.append(f"{url}: {e}")
    res = ingest(IngestIn(listings=[ListingIn(**i) for i in items]))
    return {"ingested": len(res["listings"]), "errors": errors}


@app.post("/sources/email")
def import_email(body: EmailIn):
    found = sources.listings_from_email(body.raw)
    res = ingest(IngestIn(listings=[ListingIn(**i) for i in found]))
    return {"found": len(found), "listings": res["listings"]}
