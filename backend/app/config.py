"""Safety defaults. Account safety beats speed everywhere in this file.

Daily/hourly caps are *defaults*: the user may raise them, but every raise comes
back with a loud warning. The quality floors (min gap, fit score, company
cooldown) can only be made stricter, never looser.
"""
import os
from pathlib import Path

PLATFORMS = ("linkedin", "internshala", "naukri", "unstop", "wellfound")

DEFAULT_LIMITS = {
    "linkedin": {"daily": 10, "hourly": 3},
    "internshala": {"daily": 15, "hourly": None},
    "naukri": {"daily": 15, "hourly": None},
    "unstop": {"daily": 15, "hourly": None},
    "wellfound": {"daily": 15, "hourly": None},
}
DEFAULT_TOTAL_DAILY = 40

# Floors: settings may raise these, never lower them.
MIN_GAP_SECONDS = 60
MIN_FIT_SCORE = 55
COMPANY_COOLDOWN_DAYS = 30

LOCKOUT_HOURS = 48
ERROR_STRIKES = 3            # unexpected errors ...
ERROR_WINDOW_MINUTES = 15    # ... within this window trigger a lockout

SIMILARITY_THRESHOLD = 0.70
SIMILARITY_WINDOW = 20       # compare against the last N submissions
SIMILARITY_MIN_WORDS = 25    # short factual answers ("Immediately") are exempt
MAX_GENERATION_ATTEMPTS = 3

RSS_MIN_INTERVAL_HOURS = 6   # never poll a feed more often than this

DATA_DIR = Path(os.environ.get("JOBCOPILOT_DATA", Path(__file__).resolve().parent.parent / "data"))
DB_PATH = Path(os.environ.get("JOBCOPILOT_DB", DATA_DIR / "jobcopilot.db"))
RESUME_PATH = DATA_DIR / "resume.pdf"

LLM_MODEL = os.environ.get("JOBCOPILOT_MODEL", "claude-opus-5-5")
LLM_EFFORT = os.environ.get("JOBCOPILOT_EFFORT", "medium")
