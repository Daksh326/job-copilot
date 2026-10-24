"""Listing identity, passive sources (RSS feeds, pasted job-alert emails), and
the redaction that keeps recruiter contact details out of storage."""
import html
import re
import time
import urllib.request
import xml.etree.ElementTree as ET
from urllib.parse import urlparse

from . import config, db

_PATTERNS = {
    "linkedin": [r"linkedin\.com/(?:comm/)?jobs/view/(?:[\w-]*?-)?(\d{6,})", r"[?&]currentJobId=(\d{6,})"],
    "internshala": [r"internshala\.com/((?:internship|job)/detail/[\w-]+)"],
    "naukri": [r"naukri\.com/job-listings-[\w-]*?-(\d{9,})"],
    "unstop": [r"unstop\.com/((?:jobs|internships|o)/[\w-]+-\d{5,})"],
    "wellfound": [r"wellfound\.com/(?:company/[\w-]+/)?jobs/(\d+)"],
}


def platform_from_url(url: str) -> str | None:
    host = (urlparse(url).hostname or "").lower()
    for p in config.PLATFORMS:
        if host == f"{p}.com" or host.endswith(f".{p}.com") or host == f"{p}.in":
            return p
    return None


def external_id(url: str) -> tuple[str, str] | None:
    platform = platform_from_url(url)
    if not platform:
        return None
    for pat in _PATTERNS[platform]:
        m = re.search(pat, url)
        if m:
            return platform, m.group(1)
    return None


def canonical_url(platform: str, ext_id: str, fallback: str) -> str:
    if platform == "linkedin":
        return f"https://www.linkedin.com/jobs/view/{ext_id}/"
    if platform in ("internshala", "unstop"):
        return f"https://{platform}.com/{ext_id}"
    return fallback.split("#")[0]


_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE = re.compile(r"(?<!\d)(?:\+?\d[\d\s-]{8,}\d)(?!\d)")


def redact(text: str | None) -> str | None:
    """Strip emails and phone numbers. We only keep what the listing needs."""
    if not text:
        return text
    return _PHONE.sub("[phone removed]", _EMAIL.sub("[email removed]", text))


_LINK = re.compile(r"""<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)</a>""", re.I | re.S)
_URL = re.compile(r"https?://[^\s<>\"')]+")


def listings_from_email(raw: str) -> list[dict]:
    """Pull job links out of a pasted job-alert email (HTML or plain text)."""
    found: dict[str, dict] = {}
    for href, inner in _LINK.findall(raw):
        href = html.unescape(href)
        title = re.sub(r"<[^>]+>", " ", inner)
        title = re.sub(r"\s+", " ", html.unescape(title)).strip()
        ident = external_id(href)
        if ident and (ident not in found or (title and not found[ident]["title"])):
            found[ident] = {"url": href, "title": title or None}
    for url in _URL.findall(raw):
        ident = external_id(url)
        if ident and ident not in found:
            found[ident] = {"url": url, "title": None}
    return [{"url": v["url"], "title": v["title"], "source": "email"} for v in found.values()]


def add_feed(url: str) -> None:
    with db.session() as conn:
        conn.execute("INSERT OR IGNORE INTO feeds(url, last_fetched) VALUES (?, NULL)", (url,))


def list_feeds() -> list[dict]:
    with db.session() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM feeds")]


def due_feeds(now: float | None = None) -> list[str]:
    now = now or time.time()
    cutoff = now - config.RSS_MIN_INTERVAL_HOURS * 3600
    return [f["url"] for f in list_feeds() if not f["last_fetched"] or f["last_fetched"] < cutoff]


def fetch_feed(url: str, now: float | None = None) -> list[dict]:
    """One polite GET of a feed. Callers must go through due_feeds() first."""
    now = now or time.time()
    req = urllib.request.Request(url, headers={"User-Agent": "JobCopilot/0.1 (personal RSS reader)"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read()
    with db.session() as conn:
        conn.execute("UPDATE feeds SET last_fetched = ? WHERE url = ?", (now, url))
    root = ET.fromstring(body)
    items = []
    for item in root.iter():
        tag = item.tag.split("}")[-1]
        if tag not in ("item", "entry"):
            continue
        fields = {c.tag.split("}")[-1]: c for c in item}
        link = fields.get("link")
        href = (link.get("href") if link is not None and link.get("href") else (link.text if link is not None else "")) or ""
        title = fields.get("title").text if fields.get("title") is not None else None
        # Element truthiness means "has children", so pick explicitly.
        desc_el = next((fields[k] for k in ("description", "summary", "content") if k in fields), None)
        desc = re.sub(r"<[^>]+>", " ", html.unescape(desc_el.text or "")) if desc_el is not None else None
        if external_id(href.strip()):
            items.append({"url": href.strip(), "title": title, "description": desc, "source": "rss"})
    return items
