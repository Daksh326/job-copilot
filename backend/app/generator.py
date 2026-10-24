"""Tailored cover letters and answers, with a uniqueness gate.

Every long-form text is compared against the last 20 submissions; anything over
70% similar is regenerated (up to MAX_GENERATION_ATTEMPTS). If it is still too
similar, the draft is flagged and the extension will not paste it: the user has
to write or edit that text themselves.
"""
import json
from typing import Callable

from . import config, safety

DRAFT_SCHEMA = {
    "type": "object",
    "properties": {
        "cover_letter": {"type": "string"},
        "answers": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"question": {"type": "string"}, "answer": {"type": "string"}},
                "required": ["question", "answer"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["cover_letter", "answers"],
    "additionalProperties": False,
}

SYSTEM = """You write job and internship applications for one candidate, using only facts from their profile.

Rules:
- Never invent experience, skills, grades, dates or numbers that are not in the profile.
- Tailor every piece to this specific listing: reference the company's actual work and the listing's actual requirements, and connect them to concrete items from the profile.
- Write like a real student/early-career person: plain, specific, confident, no clichés ("I am writing to express", "passionate", "esteemed organization", "synergy").
- Cover letter: 150-220 words, no address block, no placeholders. Start with something specific to the role.
- Answers: answer each question directly. Factual questions (notice period, availability, relocation, stipend) get one short sentence from the profile. Open questions get 60-150 words.
- If the profile lacks the fact a question needs, answer with an empty string rather than guessing."""


class GenerationUnavailable(RuntimeError):
    pass


def _profile_for_prompt(profile: dict) -> dict:
    hidden = {"email", "phone", "resume_filename"}
    return {k: v for k, v in profile.items() if k not in hidden}


def build_prompt(listing: dict, profile: dict, questions: list[str], avoid: list[str]) -> str:
    parts = [
        "<profile>\n" + json.dumps(_profile_for_prompt(profile), indent=2) + "\n</profile>",
        "<listing>\n" + json.dumps(
            {k: listing.get(k) for k in ("title", "company", "location", "work_mode", "description")}, indent=2
        ) + "\n</listing>",
        "<questions>\n" + json.dumps(questions) + "\n</questions>",
    ]
    if avoid:
        parts.append(
            "<previously_submitted>\nThese were already sent to other employers. Your new text must be clearly "
            "different in structure, opening and wording, not a light rewrite:\n"
            + "\n---\n".join(a[:1500] for a in avoid)
            + "\n</previously_submitted>"
        )
    parts.append("Write the cover letter and answer every question in <questions>, in the same order.")
    return "\n\n".join(parts)


def claude_generate(prompt: str) -> dict:
    try:
        import anthropic
    except ImportError as e:  # pragma: no cover
        raise GenerationUnavailable("The 'anthropic' package is not installed.") from e

    client = anthropic.Anthropic()
    try:
        response = client.beta.messages.create(
            model=config.LLM_MODEL,
            max_tokens=16000,
            system=SYSTEM,
            messages=[{"role": "user", "content": prompt}],
            output_config={
                "effort": config.LLM_EFFORT,
                "format": {"type": "json_schema", "schema": DRAFT_SCHEMA},
            },
            # On a policy decline the API re-runs the request on a fallback model.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.AuthenticationError as e:
        raise GenerationUnavailable(
            "No valid Anthropic credentials. Set ANTHROPIC_API_KEY or run `ant auth login`."
        ) from e
    except anthropic.RateLimitError as e:
        raise GenerationUnavailable("Anthropic rate limit hit; try again in a minute.") from e
    except anthropic.APIConnectionError as e:
        raise GenerationUnavailable("Could not reach the Anthropic API.") from e
    except anthropic.APIStatusError as e:
        raise GenerationUnavailable(f"Anthropic API error {e.status_code}: {e.message}") from e

    if response.stop_reason == "refusal":
        raise GenerationUnavailable("The model declined to write this application.")
    if response.stop_reason == "max_tokens":
        raise GenerationUnavailable("The response was cut off; try again.")
    text = next((b.text for b in response.content if b.type == "text"), None)
    if text is None:
        raise GenerationUnavailable("The model returned no text.")
    return json.loads(text)


def generate_draft(
    listing: dict,
    profile: dict,
    questions: list[str],
    generate: Callable[[str], dict] = claude_generate,
) -> dict:
    corpus = safety.recent_submission_texts()
    avoid: list[str] = []
    best = None

    for attempt in range(1, config.MAX_GENERATION_ATTEMPTS + 1):
        draft = generate(build_prompt(listing, profile, questions, avoid))
        answers = draft.get("answers") or []
        # Re-key answers by the questions we asked, in case the model reordered.
        by_q = {a.get("question", "").strip().lower(): a.get("answer", "") for a in answers}
        aligned = [
            {"question": q, "answer": by_q.get(q.strip().lower(), answers[i]["answer"] if i < len(answers) else "")}
            for i, q in enumerate(questions)
        ]

        texts = [("cover_letter", draft.get("cover_letter", ""))] + [(a["question"], a["answer"]) for a in aligned]
        checks = []
        for label, text in texts:
            if not safety.needs_uniqueness_check(text):
                continue
            score, other = safety.max_similarity(text, corpus)
            checks.append({"field": label, "similarity": round(score, 3), "too_similar": score > config.SIMILARITY_THRESHOLD, "other": other})

        worst = max((c["similarity"] for c in checks), default=0.0)
        result = {
            "cover_letter": draft.get("cover_letter", ""),
            "answers": aligned,
            "max_similarity": worst,
            "too_similar_fields": [c["field"] for c in checks if c["too_similar"]],
            "attempts": attempt,
        }
        if best is None or worst < best["max_similarity"]:
            best = result
        if not result["too_similar_fields"]:
            best = result
            break
        avoid = list(dict.fromkeys([c["other"] for c in checks if c["too_similar"] and c["other"]] + avoid))[:5]

    best["too_similar"] = bool(best["too_similar_fields"])
    best["attempts"] = attempt
    return best
