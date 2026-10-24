"""Every rule that keeps the user's accounts safe lives here.

The extension asks this module before it fills anything and before it opens the
next listing; the backend is the single source of truth for limits, lockouts,
company cooldowns, eligibility and answer similarity.
"""
import json
import re
import time
from difflib import SequenceMatcher

from . import config, db

DAY = 24 * 3600
HOUR = 3600


# ---------------------------------------------------------------- limits

def effective_limits() -> dict:
    """Defaults merged with the user's overrides (overrides only ever widen caps
    with a warning, or tighten floors)."""
    overrides = db.get_setting("limits", {}) or {}
    per_platform = {p: dict(v) for p, v in config.DEFAULT_LIMITS.items()}
    for p, v in (overrides.get("platforms") or {}).items():
        if p in per_platform:
            per_platform[p].update({k: v[k] for k in ("daily", "hourly") if k in v})
    return {
        "platforms": per_platform,
        "total_daily": overrides.get("total_daily", config.DEFAULT_TOTAL_DAILY),
        "min_gap_seconds": max(config.MIN_GAP_SECONDS, overrides.get("min_gap_seconds", 0)),
        "min_fit_score": max(config.MIN_FIT_SCORE, overrides.get("min_fit_score", 0)),
        "company_cooldown_days": max(config.COMPANY_COOLDOWN_DAYS, overrides.get("company_cooldown_days", 0)),
    }


def validate_limit_change(new: dict) -> tuple[dict, list[str], list[str]]:
    """Return (clean_overrides, warnings, errors). Raising a cap above the
    default is allowed but warned about; loosening a floor is an error."""
    warnings, errors, clean = [], [], {"platforms": {}}
    for p, v in (new.get("platforms") or {}).items():
        if p not in config.DEFAULT_LIMITS:
            errors.append(f"Unknown platform '{p}'.")
            continue
        clean["platforms"][p] = {}
        for k in ("daily", "hourly"):
            if k not in v or v[k] is None:
                continue
            val = int(v[k])
            if val < 0:
                errors.append(f"{p}.{k} cannot be negative.")
                continue
            default = config.DEFAULT_LIMITS[p][k]
            if default is None or val > default:
                warnings.append(
                    f"WARNING: raising {p} {k} limit to {val} (safe default: {default or 'none'}). "
                    f"Higher volume is the #1 reason accounts get flagged."
                )
            clean["platforms"][p][k] = val
    if "total_daily" in new:
        val = int(new["total_daily"])
        if val > config.DEFAULT_TOTAL_DAILY:
            warnings.append(
                f"WARNING: raising the total daily cap to {val} (safe default: {config.DEFAULT_TOTAL_DAILY})."
            )
        clean["total_daily"] = val
    for key, floor in (
        ("min_gap_seconds", config.MIN_GAP_SECONDS),
        ("min_fit_score", config.MIN_FIT_SCORE),
        ("company_cooldown_days", config.COMPANY_COOLDOWN_DAYS),
    ):
        if key in new:
            val = new[key]
            if val < floor:
                errors.append(f"{key} cannot go below {floor}; it can only be made stricter.")
            else:
                clean[key] = val
    return clean, warnings, errors


# ---------------------------------------------------------------- lockouts

def active_lockout(platform: str, now: float | None = None) -> dict | None:
    now = now or time.time()
    with db.session() as conn:
        row = conn.execute("SELECT * FROM lockouts WHERE platform = ?", (platform,)).fetchone()
    if row and row["until"] > now:
        return dict(row)
    return None


def lock_platform(platform: str, reason: str, now: float | None = None) -> dict:
    """Stop all activity on a platform for LOCKOUT_HOURS. Never shortens an
    existing lockout."""
    now = now or time.time()
    until = now + config.LOCKOUT_HOURS * HOUR
    existing = active_lockout(platform, now)
    if existing and existing["until"] >= until:
        return existing
    with db.session() as conn:
        conn.execute(
            "INSERT INTO lockouts(platform, until, reason, created_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(platform) DO UPDATE SET until = excluded.until, reason = excluded.reason, "
            "created_at = excluded.created_at",
            (platform, until, reason, now),
        )
    return {"platform": platform, "until": until, "reason": reason, "created_at": now}


def record_error(platform: str, detail: str, now: float | None = None) -> dict | None:
    """Log an unexpected error; repeated errors lock the platform."""
    now = now or time.time()
    window_start = now - config.ERROR_WINDOW_MINUTES * 60
    with db.session() as conn:
        conn.execute("INSERT INTO error_events(platform, at, detail) VALUES (?, ?, ?)", (platform, now, detail))
        n = conn.execute(
            "SELECT COUNT(*) FROM error_events WHERE platform = ? AND at >= ?", (platform, window_start)
        ).fetchone()[0]
    if n >= config.ERROR_STRIKES:
        return lock_platform(
            platform, f"{n} unexpected errors in {config.ERROR_WINDOW_MINUTES} minutes (last: {detail})", now
        )
    return None


# ---------------------------------------------------------------- submission gate

def _count(conn, platform: str | None, since: float) -> int:
    if platform:
        q = "SELECT COUNT(*) FROM applications WHERE platform = ? AND submitted_at >= ?"
        return conn.execute(q, (platform, since)).fetchone()[0]
    return conn.execute("SELECT COUNT(*) FROM applications WHERE submitted_at >= ?", (since,)).fetchone()[0]


def platform_status(platform: str, now: float | None = None) -> dict:
    """Can the user be shown (and have filled) one more application on this
    platform right now? Uses rolling 24h / 60min windows."""
    now = now or time.time()
    limits = effective_limits()
    plat = limits["platforms"][platform]
    reasons, waits = [], []

    lock = active_lockout(platform, now)
    if lock:
        reasons.append(f"Paused until {time.strftime('%d %b %H:%M', time.localtime(lock['until']))}: {lock['reason']}")
        waits.append(lock["until"])

    with db.session() as conn:
        day_count = _count(conn, platform, now - DAY)
        hour_count = _count(conn, platform, now - HOUR)
        total_count = _count(conn, None, now - DAY)
        last = conn.execute(
            "SELECT MAX(submitted_at) FROM applications WHERE platform = ?", (platform,)
        ).fetchone()[0]
        day_rows = [r[0] for r in conn.execute(
            "SELECT submitted_at FROM applications WHERE platform = ? AND submitted_at >= ? ORDER BY submitted_at",
            (platform, now - DAY),
        )]
        hour_rows = [r[0] for r in conn.execute(
            "SELECT submitted_at FROM applications WHERE platform = ? AND submitted_at >= ? ORDER BY submitted_at",
            (platform, now - HOUR),
        )]
        total_rows = [r[0] for r in conn.execute(
            "SELECT submitted_at FROM applications WHERE submitted_at >= ? ORDER BY submitted_at", (now - DAY,)
        )]

    if day_count >= plat["daily"]:
        reasons.append(f"Daily limit reached ({day_count}/{plat['daily']}).")
        waits.append(day_rows[day_count - plat["daily"]] + DAY)
    if plat.get("hourly") is not None and hour_count >= plat["hourly"]:
        reasons.append(f"Hourly limit reached ({hour_count}/{plat['hourly']}).")
        waits.append(hour_rows[hour_count - plat["hourly"]] + HOUR)
    if total_count >= limits["total_daily"]:
        reasons.append(f"Total daily limit reached ({total_count}/{limits['total_daily']}).")
        waits.append(total_rows[total_count - limits["total_daily"]] + DAY)
    if last and now - last < limits["min_gap_seconds"]:
        reasons.append(f"Minimum {limits['min_gap_seconds']}s gap between submissions.")
        waits.append(last + limits["min_gap_seconds"])

    return {
        "platform": platform,
        "allowed": not reasons,
        "reasons": reasons,
        "next_allowed_at": max(waits) if waits else now,
        "counts": {"day": day_count, "hour": hour_count, "total_day": total_count},
        "limits": {**plat, "total_daily": limits["total_daily"], "min_gap_seconds": limits["min_gap_seconds"]},
        "lockout": lock,
    }


# ---------------------------------------------------------------- companies

_COMPANY_SUFFIXES = re.compile(
    r"\b(private|pvt|limited|ltd|llp|llc|inc|incorporated|corp|corporation|co|company|technologies|"
    r"technology|tech|solutions|services|labs|india|global|software|systems)\b\.?",
    re.I,
)


def normalize_company(name: str | None) -> str:
    if not name:
        return ""
    s = name.lower().replace("&", " and ")
    s = re.sub(r"[^\w\s]", " ", s)
    stripped = _COMPANY_SUFFIXES.sub(" ", s)
    stripped = re.sub(r"\s+", " ", stripped).strip()
    return stripped or re.sub(r"\s+", " ", s).strip()


def company_recently_applied(company_key: str, now: float | None = None) -> float | None:
    """Return the timestamp of the last application to this company inside the
    cooldown window, or None."""
    if not company_key:
        return None
    now = now or time.time()
    days = effective_limits()["company_cooldown_days"]
    with db.session() as conn:
        row = conn.execute(
            "SELECT MAX(submitted_at) FROM applications WHERE company_key = ? AND submitted_at >= ?",
            (company_key, now - days * DAY),
        ).fetchone()
    return row[0] if row and row[0] else None


# ---------------------------------------------------------------- eligibility

_CITY_ALIASES = [
    {"bangalore", "bengaluru"},
    {"gurgaon", "gurugram"},
    {"mumbai", "bombay", "navi mumbai"},
    {"delhi", "new delhi", "ncr", "delhi ncr", "noida", "greater noida", "ghaziabad", "faridabad"},
    {"chennai", "madras"},
    {"kolkata", "calcutta"},
    {"pune"},
    {"hyderabad", "secunderabad"},
]

_DEGREES = {
    # "B.E"/"M.E" need the dot, otherwise every "will be" / "me" would match.
    "btech": [r"\bb\.?\s?tech\b", r"\bb\.\s?e\b", r"bachelor of (?:technology|engineering)"],
    "mtech": [r"\bm\.?\s?tech\b", r"\bm\.\s?e\b", r"master of (?:technology|engineering)"],
    "bca": [r"\bbca\b"],
    "mca": [r"\bmca\b"],
    "bsc": [r"\bb\.?\s?sc\b"],
    "msc": [r"\bm\.?\s?sc\b"],
    "bba": [r"\bbba\b"],
    "mba": [r"\bmba\b", r"\bpgdm\b"],
    "bcom": [r"\bb\.\s?com\b", r"\bbcom\b"],
    "phd": [r"\bph\.?\s?d\b"],
}
_ANY_DEGREE = re.compile(r"any (?:degree|graduate|stream|discipline)|or equivalent|or related|all (?:degrees|streams)", re.I)


def canonical_degree(text: str) -> str | None:
    t = f" {text.lower()} "
    for key, pats in _DEGREES.items():
        if any(re.search(p, t) for p in pats):
            return key
    return None


def degrees_mentioned(text: str) -> set[str]:
    t = f" {text.lower()} "
    return {key for key, pats in _DEGREES.items() if any(re.search(p, t) for p in pats)}


_YEAR_CONTEXT = re.compile(
    r"(?:batch(?:es)?|graduat\w*|pass(?:ing)?[\s-]?out|class)\s*(?:of|in|year|years)?\s*[:\-]?\s*"
    r"((?:20\d{2}\s*(?:,|/|&|and|or|-|to)?\s*)+)",
    re.I,
)


def required_grad_years(text: str) -> set[int]:
    years: set[int] = set()
    for m in _YEAR_CONTEXT.finditer(text or ""):
        chunk = m.group(1)
        found = [int(y) for y in re.findall(r"20\d{2}", chunk)]
        rng = re.search(r"(20\d{2})\s*(?:-|to)\s*(20\d{2})", chunk)
        if rng:
            a, b = int(rng.group(1)), int(rng.group(2))
            if 0 <= b - a <= 6:
                found += list(range(a, b + 1))
        years.update(found)
    return years


def detect_work_mode(listing: dict) -> str | None:
    explicit = (listing.get("work_mode") or "").lower()
    text = " ".join(filter(None, [explicit, listing.get("location"), listing.get("title"), listing.get("description")])).lower()
    if "hybrid" in text:
        return "hybrid"
    if re.search(r"\b(remote|work from home|wfh)\b", text):
        return "remote"
    if re.search(r"\b(on-?site|in[- ]office|work from office|wfo)\b", text):
        return "onsite"
    return None


def _city_set(name: str) -> set[str]:
    n = name.lower().strip()
    for group in _CITY_ALIASES:
        if n in group:
            return group
    return {n}


def location_ok(location: str | None, profile: dict) -> bool | None:
    if not location:
        return None
    wanted = profile.get("locations") or []
    if profile.get("willing_to_relocate") or any(w.lower() in ("anywhere", "any") for w in wanted):
        return True
    loc = location.lower()
    for w in wanted:
        if any(alias in loc for alias in _city_set(w)):
            return True
    return False


def check_eligibility(listing: dict, profile: dict) -> dict:
    """Hard eligibility. Unknowns are reported but do not disqualify; a known
    mismatch always does."""
    reasons, unknowns = [], []
    text = " ".join(filter(None, [listing.get("title"), listing.get("description")]))

    years = required_grad_years(text)
    grad_year = profile.get("graduation_year")
    if years and grad_year:
        if int(grad_year) not in years:
            reasons.append(f"Requires graduation year {sorted(years)}, you graduate in {grad_year}.")
    elif not years:
        unknowns.append("graduation year")

    my_degree = canonical_degree(profile.get("degree", "") or "")
    wanted_degrees = degrees_mentioned(text)
    if wanted_degrees and my_degree and my_degree not in wanted_degrees and not _ANY_DEGREE.search(text):
        reasons.append(f"Asks for {', '.join(sorted(wanted_degrees))}; your degree is {profile.get('degree')}.")

    mode = detect_work_mode(listing)
    modes = [m.lower() for m in (profile.get("work_modes") or [])]
    if mode and modes and mode not in modes:
        reasons.append(f"Work mode is {mode}; you accept {', '.join(modes)}.")
    elif not mode:
        unknowns.append("work mode")

    if mode != "remote":
        loc = location_ok(listing.get("location"), profile)
        if loc is False:
            reasons.append(f"Location '{listing.get('location')}' is not in your preferred locations.")
        elif loc is None:
            unknowns.append("location")

    blocked = {normalize_company(c) for c in profile.get("excluded_companies") or []}
    if normalize_company(listing.get("company")) in blocked:
        reasons.append("Company is on your exclusion list.")

    return {"eligible": not reasons, "reasons": reasons, "unknowns": unknowns}


# ---------------------------------------------------------------- similarity

def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", (text or "").lower())


def _shingles(words: list[str], n: int = 3) -> set[tuple]:
    return {tuple(words[i:i + n]) for i in range(max(0, len(words) - n + 1))}


def similarity(a: str, b: str) -> float:
    """Max of character-sequence ratio and word-trigram Jaccard. Either one
    catching a near-duplicate is enough."""
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return 0.0
    seq = SequenceMatcher(None, " ".join(wa), " ".join(wb), autojunk=False).ratio()
    sa, sb = _shingles(wa), _shingles(wb)
    jac = len(sa & sb) / len(sa | sb) if sa and sb else 0.0
    return max(seq, jac)


def needs_uniqueness_check(text: str) -> bool:
    return len(_words(text)) >= config.SIMILARITY_MIN_WORDS


def recent_submission_texts(limit: int = config.SIMILARITY_WINDOW) -> list[str]:
    with db.session() as conn:
        rows = conn.execute(
            "SELECT texts FROM applications ORDER BY submitted_at DESC LIMIT ?", (limit,)
        ).fetchall()
    out: list[str] = []
    for r in rows:
        out.extend(t for t in json.loads(r["texts"] or "[]") if t)
    return out


def max_similarity(text: str, corpus: list[str]) -> tuple[float, str | None]:
    best, best_text = 0.0, None
    for other in corpus:
        s = similarity(text, other)
        if s > best:
            best, best_text = s, other
    return best, best_text
