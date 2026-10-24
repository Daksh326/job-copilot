"""Deterministic fit score (0-100). No LLM call, so scoring a results page is free."""
import re

from . import safety


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower())


def _contains(text: str, term: str) -> bool:
    term = term.lower().strip()
    if not term:
        return False
    # word-ish boundary that still works for "c++", "node.js", "c#"
    return re.search(r"(?<![a-z0-9])" + re.escape(term) + r"(?![a-z0-9])", text) is not None


def fit_score(listing: dict, profile: dict) -> tuple[int, list[str]]:
    title = _norm(listing.get("title"))
    body = _norm(" ".join(filter(None, [listing.get("title"), listing.get("description")])))
    reasons: list[str] = []

    # Skills: 55 points
    skills = [s for s in profile.get("skills") or [] if s.strip()]
    matched = [s for s in skills if _contains(body, s)]
    if listing.get("description"):
        # Of the skills the listing actually mentions, how many do we have?
        skill_pts = min(55, 55 * len(matched) / max(4, min(len(skills), 10)))
    else:
        # Results-page cards rarely carry a description; lean on the title.
        skill_pts = 30 if any(_contains(title, s) for s in skills) else 18
    if matched:
        reasons.append("Skills matched: " + ", ".join(matched[:8]))

    # Role/title: 30 points
    roles = [r for r in profile.get("target_roles") or [] if r.strip()]
    role_pts = 0
    for r in roles:
        words = [w for w in re.findall(r"[a-z0-9+#.]+", r.lower()) if len(w) > 2]
        if r.lower() in title:
            role_pts = 30
            reasons.append(f"Title matches target role '{r}'")
            break
        if words and sum(w in title for w in words) / len(words) >= 0.5:
            role_pts = max(role_pts, 20)
    if role_pts == 20:
        reasons.append("Title partially matches a target role")
    avoid = [a for a in profile.get("avoid_keywords") or [] if a.strip()]
    hit_avoid = [a for a in avoid if _contains(title, a)]
    if hit_avoid:
        role_pts = 0
        reasons.append("Title contains avoided keyword(s): " + ", ".join(hit_avoid))

    # Location / mode: 15 points
    loc_pts = 8
    mode = safety.detect_work_mode(listing)
    modes = [m.lower() for m in profile.get("work_modes") or []]
    if mode and modes:
        loc_pts = 15 if mode in modes else 0
    if mode != "remote" and safety.location_ok(listing.get("location"), profile) is False:
        loc_pts = 0

    score = round(skill_pts + role_pts + loc_pts)
    if hit_avoid:
        score = min(score, 40)
    return max(0, min(100, score)), reasons
