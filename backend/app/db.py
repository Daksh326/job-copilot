import json
import sqlite3
from contextlib import contextmanager

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,              -- "<platform>:<external_id>"
    platform TEXT NOT NULL,
    external_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    company TEXT,
    company_key TEXT,
    location TEXT,
    work_mode TEXT,
    description TEXT,
    source TEXT,                      -- results_page | listing_page | rss | email
    fit_score REAL,
    fit_reasons TEXT,
    eligible INTEGER,
    ineligible_reasons TEXT,
    status TEXT NOT NULL DEFAULT 'new',  -- new | skipped | applied
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id TEXT,
    platform TEXT NOT NULL,
    company_key TEXT,
    submitted_at REAL NOT NULL,
    texts TEXT NOT NULL DEFAULT '[]',  -- JSON list of long-form texts actually sent
    detected_by TEXT                   -- success_page | user_confirmed
);
CREATE INDEX IF NOT EXISTS idx_app_platform_time ON applications(platform, submitted_at);
CREATE TABLE IF NOT EXISTS drafts (
    listing_id TEXT PRIMARY KEY,
    cover_letter TEXT,
    answers TEXT,                      -- JSON list of {question, answer}
    max_similarity REAL,
    too_similar INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS lockouts (
    platform TEXT PRIMARY KEY,
    until REAL NOT NULL,
    reason TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS error_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    at REAL NOT NULL,
    detail TEXT
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feeds (
    url TEXT PRIMARY KEY,
    last_fetched REAL
);
"""


def connect() -> sqlite3.Connection:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def session():
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init() -> None:
    with session() as conn:
        conn.executescript(SCHEMA)


def get_setting(key: str, default=None):
    with session() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def set_setting(key: str, value) -> None:
    with session() as conn:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)),
        )


def get_profile() -> dict:
    with session() as conn:
        row = conn.execute("SELECT data FROM profile WHERE id = 1").fetchone()
    return json.loads(row["data"]) if row else {}


def save_profile(data: dict) -> None:
    with session() as conn:
        conn.execute(
            "INSERT INTO profile(id, data) VALUES (1, ?) "
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            (json.dumps(data),),
        )


def row_to_listing(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["fit_reasons"] = json.loads(d["fit_reasons"] or "[]")
    d["ineligible_reasons"] = json.loads(d["ineligible_reasons"] or "[]")
    d["eligible"] = None if d["eligible"] is None else bool(d["eligible"])
    return d
