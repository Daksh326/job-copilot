import json
import time

import pytest
from fastapi.testclient import TestClient

from app import config, db, generator, safety

PROFILE = {
    "name": "Test Student",
    "degree": "B.Tech Computer Science",
    "graduation_year": 2026,
    "locations": ["Bengaluru", "Delhi"],
    "work_modes": ["remote", "hybrid", "onsite"],
    "skills": ["Python", "React", "SQL", "FastAPI", "Docker"],
    "target_roles": ["Software Engineer Intern", "Backend Developer"],
}


@pytest.fixture(autouse=True)
def fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setattr(config, "RESUME_PATH", tmp_path / "resume.pdf")
    db.init()
    db.save_profile(PROFILE)


def log_app(platform, at, company="Acme", texts=()):
    with db.session() as conn:
        conn.execute(
            "INSERT INTO applications(platform, company_key, submitted_at, texts) VALUES (?,?,?,?)",
            (platform, safety.normalize_company(company), at, json.dumps(list(texts))),
        )


# ---------------------------------------------------------------- pacing

def test_linkedin_hourly_and_gap():
    now = 1_000_000.0
    log_app("linkedin", now - 30, "A")
    st = safety.platform_status("linkedin", now)
    assert not st["allowed"]
    assert any("60s gap" in r for r in st["reasons"])
    assert st["next_allowed_at"] == pytest.approx(now + 30)

    log_app("linkedin", now - 3000, "B")
    log_app("linkedin", now - 2000, "C")
    st = safety.platform_status("linkedin", now + 100)
    assert any("Hourly limit" in r for r in st["reasons"])
    # Oldest of the three in the last hour drops out at (now-3000)+3600
    assert st["next_allowed_at"] == pytest.approx(now - 3000 + 3600)


def test_daily_limits_per_platform_and_total():
    now = 2_000_000.0
    for i in range(10):
        log_app("linkedin", now - 80000 + i * 4000, f"L{i}")
    assert any("Daily limit" in r for r in safety.platform_status("linkedin", now)["reasons"])

    for i in range(15):
        log_app("naukri", now - 50000 + i * 100, f"N{i}")
    for i in range(15):
        log_app("internshala", now - 40000 + i * 100, f"I{i}")
    st = safety.platform_status("unstop", now)
    assert any("Total daily limit" in r for r in st["reasons"])  # 40 total


def test_lockout_blocks_and_never_shortens():
    now = 3_000_000.0
    lock = safety.lock_platform("naukri", "CAPTCHA shown", now)
    assert lock["until"] == pytest.approx(now + 48 * 3600)
    st = safety.platform_status("naukri", now + 3600)
    assert not st["allowed"] and st["lockout"]
    # A later, separate lockout extends; nothing shortens it.
    safety.lock_platform("naukri", "warning banner", now + 10)
    assert safety.active_lockout("naukri", now + 48 * 3600 + 5)
    assert safety.active_lockout("naukri", now + 49 * 3600) is None


def test_repeated_errors_lock_platform():
    now = 4_000_000.0
    assert safety.record_error("unstop", "500", now) is None
    assert safety.record_error("unstop", "500", now + 60) is None
    assert safety.record_error("unstop", "500", now + 120) is not None
    assert safety.active_lockout("unstop", now + 200)


def test_limit_changes_warn_and_floors_hold():
    clean, warnings, errors = safety.validate_limit_change({"platforms": {"linkedin": {"daily": 25}}})
    assert warnings and not errors
    _, _, errors = safety.validate_limit_change({"min_gap_seconds": 10})
    assert errors
    _, _, errors = safety.validate_limit_change({"min_fit_score": 40})
    assert errors
    clean, warnings, errors = safety.validate_limit_change({"min_gap_seconds": 120})
    assert clean["min_gap_seconds"] == 120 and not warnings and not errors


# ---------------------------------------------------------------- companies

def test_company_normalization_and_cooldown():
    assert safety.normalize_company("Acme Technologies Pvt. Ltd.") == safety.normalize_company("ACME")
    now = 5_000_000.0
    log_app("linkedin", now - 29 * 86400, "Acme Technologies Pvt Ltd")
    assert safety.company_recently_applied("acme", now)
    assert safety.company_recently_applied("acme", now + 2 * 86400) is None


# ---------------------------------------------------------------- eligibility

def test_eligibility_grad_year_degree_location_mode():
    ok = safety.check_eligibility(
        {"title": "SDE Intern", "location": "Bangalore", "description": "Open to 2025/2026 batch. B.Tech/B.E. students."},
        PROFILE,
    )
    assert ok["eligible"], ok

    wrong_year = safety.check_eligibility({"description": "Only for batch of 2024", "location": "Delhi"}, PROFILE)
    assert not wrong_year["eligible"]

    wrong_degree = safety.check_eligibility({"description": "MBA graduates only. You will be working with sales.",
                                             "location": "Delhi"}, PROFILE)
    assert not wrong_degree["eligible"]

    # "will be" must not be read as the B.E degree, nor "me" as M.E
    words = safety.check_eligibility({"description": "You will be mentoring; tell me more", "location": "Delhi"}, PROFILE)
    assert words["eligible"], words

    far = safety.check_eligibility({"description": "On-site role", "location": "Chennai, Tamil Nadu"}, PROFILE)
    assert not far["eligible"]

    remote_far = safety.check_eligibility({"description": "Fully remote", "location": "Chennai"}, PROFILE)
    assert remote_far["eligible"]

    p = {**PROFILE, "work_modes": ["remote"]}
    assert not safety.check_eligibility({"description": "Hybrid, 3 days in office", "location": "Delhi"}, p)["eligible"]


# ---------------------------------------------------------------- similarity

LETTER = (
    "I built a FastAPI service that cut report generation time from minutes to seconds for our college fest, "
    "and your backend internship asks for exactly that mix of Python, SQL and shipping under deadlines. "
    "I would like to bring the same habits of measuring first and then optimising to your payments team."
)


def test_similarity_detects_light_rewrites():
    rewrite = LETTER.replace("I would like to", "I'd love to").replace("payments team", "platform team")
    assert safety.similarity(LETTER, rewrite) > 0.7
    other = ("Your data team's work on vernacular search caught my eye. In my third year I trained a small "
             "Hindi-English classifier on 40k tweets and deployed it with Docker; I'd like to learn how you evaluate "
             "ranking changes offline before they reach users.")
    assert safety.similarity(LETTER, other) < 0.5


def test_generator_regenerates_when_too_similar():
    log_app("linkedin", time.time() - 5000, "Old Co", texts=[LETTER])
    calls = []

    def fake(prompt):
        calls.append(prompt)
        if len(calls) == 1:
            return {"cover_letter": LETTER.replace("payments", "growth"), "answers": []}
        return {"cover_letter": "Completely different text about a robotics club project where I wrote the motor "
                                "controller firmware in C, debugged it with a logic analyser and documented it for "
                                "juniors; your embedded role needs that patience with hardware.", "answers": []}

    draft = generator.generate_draft({"title": "x"}, PROFILE, [], generate=fake)
    assert len(calls) == 2
    assert "previously_submitted" in calls[1]
    assert not draft["too_similar"]


def test_generator_flags_when_it_cannot_get_unique():
    log_app("linkedin", time.time() - 5000, "Old Co", texts=[LETTER])
    draft = generator.generate_draft({"title": "x"}, PROFILE, [], generate=lambda p: {"cover_letter": LETTER, "answers": []})
    assert draft["too_similar"] and draft["attempts"] == config.MAX_GENERATION_ATTEMPTS


# ---------------------------------------------------------------- API

def test_api_queue_gate_and_logging():
    from app.main import app

    with TestClient(app) as c:
        good = {"url": "https://www.linkedin.com/jobs/view/4123456789/", "title": "Backend Developer Intern",
                "company": "Acme Pvt Ltd", "location": "Bengaluru",
                "description": "Python, FastAPI, SQL, Docker. Hybrid. 2026 batch. Contact hr@acme.com or +91 98765 43210"}
        same_co = {**good, "url": "https://www.linkedin.com/jobs/view/4123456790/", "title": "Backend Developer"}
        bad = {"url": "https://www.naukri.com/job-listings-sales-exec-xyz-mumbai-1-3-years-123456789012",
               "title": "Sales Executive", "company": "Other", "location": "Mumbai", "description": "MBA only"}
        res = c.post("/listings/ingest", json={"listings": [good, same_co, bad]}).json()["listings"]
        assert "[email removed]" in res[0]["description"] and "98765" not in res[0]["description"]

        q = c.get("/queue").json()["queue"]
        ids = [i["id"] for i in q]
        assert ids == ["linkedin:4123456789"] or ids == ["linkedin:4123456790"]  # one per company, bad excluded

        assert c.get("/check/linkedin:4123456789").json()["ok"]
        c.post("/applications", json={"listing_id": "linkedin:4123456789", "platform": "linkedin", "texts": [LETTER]})

        chk = c.get("/check/linkedin:4123456790").json()
        assert not chk["ok"]
        assert any("wait 30 days" in b for b in chk["blockers"])
        assert any("60s gap" in b for b in chk["blockers"])

        # Raising a limit needs an explicit confirmation round-trip
        r = c.put("/settings/limits", json={"platforms": {"linkedin": {"daily": 20}}}).json()
        assert r["needs_confirmation"] and not r["saved"]
        r = c.put("/settings/limits", json={"platforms": {"linkedin": {"daily": 20}}, "i_understand_the_risk": True}).json()
        assert r["saved"]
        assert c.put("/settings/limits", json={"min_gap_seconds": 5}).status_code == 400


def test_ids_with_slashes_route_correctly():
    from urllib.parse import quote

    from app.main import app

    with TestClient(app) as c:
        url = "https://internshala.com/internship/detail/python-internship-in-delhi-at-foo1700000000"
        lid = c.post("/listings/ingest", json={"listings": [{"url": url, "title": "Python Intern", "company": "Foo",
                                                             "location": "Delhi"}]}).json()["listings"][0]["id"]
        assert "/" in lid
        assert c.get(f"/check/{quote(lid, safe='')}").status_code == 200
        assert c.post(f"/listings/{quote(lid, safe='')}/skip").json()["ok"]
        assert c.get(f"/listings/{quote(lid, safe='')}").json()["status"] == "skipped"


def test_email_import_extracts_job_links():
    from app import sources

    raw = ('<a href="https://www.linkedin.com/comm/jobs/view/4000000001/?trk=eml">Python Intern</a>'
           " and https://internshala.com/internship/detail/web-development-internship-in-delhi-at-foo1234567890 ")
    found = sources.listings_from_email(raw)
    assert {f["url"].split("?")[0] for f in found} >= {"https://www.linkedin.com/comm/jobs/view/4000000001/"}
    assert len(found) == 2
