"""AI CV ("AICV") JSON schema and the shape validator shared by requests and model output.

Vercel does not turn files whose name starts with "_" into functions, so this module is a
plain helper imported by api/cv.py.

The JSON schemas follow the structured-outputs rules: every object has
`additionalProperties: false` and lists every property in `required`; no numeric/string/array
constraints (limits are enforced here, server side, by `normalize_cv`).
"""

import math
import re

# ---------------------------------------------------------------- limits

MAX_STR = 1500
CAPS = {
    "jobs": 15,
    "edu": 10,
    "projects": 12,
    "skills": 40,
    "langs": 12,
    "certs": 20,
    "hobbies": 15,
    "refs": 8,
    "skillGroups": 6,
}
MAX_BULLETS = 10
MAX_FOLLOWUPS = 5
MAX_GROUP_ITEMS = 15
MAX_MISSING = 3
MAX_CONFIRM = 5
MAX_TERMS = 15
MAX_CHANGES = 8
MAX_PARAGRAPHS = 5
CEFR = ("A1", "A2", "B1", "B2", "C1", "C2")

SCALAR_KEYS = (
    "name", "title", "phone", "email", "city", "web", "github", "summary",
    "birth", "military", "license", "marital",
)
LINK_KEYS = ("web", "github")
JOB_KEYS = ("company", "role", "city", "start", "end")
EDU_KEYS = ("school", "program", "degree", "start", "end", "note")
PROJECT_KEYS = ("name", "tech", "link")
STR_LIST_KEYS = ("skills", "certs", "hobbies", "refs")

# ---------------------------------------------------------------- JSON schema

_STR = {"type": "string"}
_STR_LIST = {"type": "array", "items": _STR}


def _obj(props):
    return {
        "type": "object",
        "properties": props,
        "required": list(props),
        "additionalProperties": False,
    }


# extract asks the model to ground every bullet in a quote of the person's own words; the
# server drops bullets without one and hands the client plain strings (see _bullets()).
EVIDENCE_BULLET = _obj({"text": _STR, "evidence": _STR})
EDU_SCHEMA = _obj({
    "school": _STR, "program": _STR, "degree": _STR, "start": _STR, "end": _STR, "note": _STR,
})
LANG_SCHEMA = _obj({"name": _STR, "level": {"type": "integer"}, "cefr": _STR, "exam": _STR})
GROUP_SCHEMA = _obj({"name": _STR, "items": _STR_LIST})


def aicv_schema(evidence=False):
    bullets = {"type": "array", "items": EVIDENCE_BULLET} if evidence else _STR_LIST
    return _obj({
        "name": _STR, "title": _STR, "phone": _STR, "email": _STR, "city": _STR,
        "web": _STR, "github": _STR, "summary": _STR,
        "jobs": {"type": "array", "items": _obj({
            "company": _STR, "role": _STR, "city": _STR, "start": _STR, "end": _STR,
            "bullets": bullets,
        })},
        "edu": {"type": "array", "items": EDU_SCHEMA},
        "projects": {"type": "array", "items": _obj({
            "name": _STR, "tech": _STR, "link": _STR, "bullets": bullets,
        })},
        "skills": _STR_LIST,
        "skillGroups": {"type": "array", "items": GROUP_SCHEMA},
        "langs": {"type": "array", "items": LANG_SCHEMA},
        "certs": _STR_LIST, "hobbies": _STR_LIST, "refs": _STR_LIST,
        "birth": _STR, "military": _STR, "license": _STR, "marital": _STR,
    })


AICV_SCHEMA = aicv_schema()
LETTER_SCHEMA = _obj({
    "recipient": _STR_LIST, "subject": _STR, "greeting": _STR,
    "paragraphs": _STR_LIST, "closing": _STR,
})

RESPONSE_SCHEMAS = {
    "extract": _obj({"cv": aicv_schema(evidence=True), "heard": _STR,
                     "missing": _STR_LIST, "confirm": _STR_LIST}),
    "review": _obj({"followups": _STR_LIST}),
    "finalize": _obj({"cv": AICV_SCHEMA}),
    "edit": _obj({"cv": AICV_SCHEMA, "reply": _STR}),
    "translate": _obj({"cv": AICV_SCHEMA}),
    # Only the parts a tailored copy may change; merge_tailored() applies them to the request CV,
    # so the model cannot add entries (and the whole AICV schema plus these lists is too large a
    # grammar for structured outputs).
    "tailor": _obj({
        "summary": _STR, "skills": _STR_LIST,
        "skillGroups": {"type": "array", "items": GROUP_SCHEMA},
        "jobs": {"type": "array", "items": _obj({"bullets": _STR_LIST})},
        "projects": {"type": "array", "items": _obj({"bullets": _STR_LIST})},
        "company": _STR, "role": _STR,
        "matched": {"type": "array", "items": _obj({"term": _STR, "where": _STR})},
        "missing": {"type": "array", "items": _obj({"term": _STR, "question": _STR})},
        "changes": _STR_LIST,
    }),
    "cover": _obj({"letter": LETTER_SCHEMA, "company": _STR, "role": _STR, "reply": _STR}),
}

# ---------------------------------------------------------------- normalisation

_LINK_PREFIX = re.compile(r"^(?:https?:)?//", re.I)
_WWW = re.compile(r"^www\.", re.I)
_BULLET_MARK = re.compile(r"^(?:[•·▪◦‣*]|[-–—](?=\s))\s*")
# Lone UTF-16 surrogates: legal in JSON text ("\ud800") and JS strings, but not encodable as UTF-8,
# so they would crash the SDK request or our own response encoding.
_SURROGATES = re.compile("[\\ud800-\\udfff]")


def scrub(text):
    """Replace lone surrogates with U+FFFD so the text is always valid UTF-8."""
    return _SURROGATES.sub("\ufffd", text)


def clean_str(value, limit=MAX_STR):
    """Trimmed, UTF-8-safe string, or "" for anything that is not a string."""
    if not isinstance(value, str):
        return ""
    return scrub(value.strip()[:limit].strip())


# Model output sometimes fills a required string with a stand-in instead of "" (seen live:
# "MISSING_PLACEHOLDER_FIX" in marital). None of these can be real CV content.
_PLACEHOLDER = re.compile(
    r"^\[[^\]]*\]$"                         # [X], [Şirket Adı]
    r"|^[A-Z0-9]+(?:_[A-Z0-9]+)+$"            # NOT_PROVIDED, MISSING_PLACEHOLDER_FIX
    r"|placeholder"
    r"|^(?:n/?a|null|none|undefined|tbd|x{2,4}|\.\.\.|…|-|—|–)$",
    re.I,
)


def drop_placeholder(text):
    return "" if text and _PLACEHOLDER.search(text) else text


def clean_link(value):
    s = clean_str(value)
    s = _LINK_PREFIX.sub("", s)
    s = _WWW.sub("", s)
    return s.rstrip("/")


def str_list(value, cap, limit=MAX_STR, dedupe=False):
    if isinstance(value, str):
        # The app keeps bullets as one string with one bullet per line; accept that too.
        value = value.splitlines()
    if not isinstance(value, list):
        return []
    out, seen = [], set()
    for item in value:
        s = clean_str(item, limit)
        s = drop_placeholder(_BULLET_MARK.sub("", s).strip())
        if not s:
            continue
        if dedupe:
            key = s.casefold()
            if key in seen:
                continue
            seen.add(key)
        out.append(s)
        if len(out) >= cap:
            break
    return out


def _clean_level(value):
    """0..5 from an int, a finite float or a short decimal string; anything else is 0.
    (JSON allows Infinity/NaN/1e400 and "³".isdigit() is True; none of them may raise.)"""
    if isinstance(value, bool):
        return 0
    if isinstance(value, float):
        value = round(value) if math.isfinite(value) else 0
    elif isinstance(value, str):
        text = value.strip()
        if not (0 < len(text) <= 3 and text.isdecimal()):
            return 0
        value = int(text)
    if not isinstance(value, int):
        return 0
    return max(0, min(5, value))


def _bullets(value):
    """Plain bullet strings. Evidence objects ({text, evidence}, extract output) keep only the
    bullets the model could ground in a quote; plain strings (requests, other ops) pass."""
    if isinstance(value, list):
        value = [
            (item.get("text") if clean_str(item.get("evidence")) else None)
            if isinstance(item, dict) else item
            for item in value
        ]
    return str_list(value, MAX_BULLETS)


def _entries(value, cap, keys, has_bullets, link_key=None):
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        if not isinstance(item, dict):
            continue
        entry = {k: drop_placeholder(clean_str(item.get(k))) for k in keys}
        if link_key:
            entry[link_key] = clean_link(item.get(link_key))
        if has_bullets:
            entry["bullets"] = _bullets(item.get("bullets"))
        if not any(entry.values()):
            continue
        out.append(entry)
        if len(out) >= cap:
            break
    return out


def empty_cv():
    cv = {k: "" for k in SCALAR_KEYS}
    cv.update({"jobs": [], "edu": [], "projects": [], "skills": [], "skillGroups": [],
               "langs": [], "certs": [], "hobbies": [], "refs": []})
    return cv


def _cefr(value):
    s = clean_str(value, 10).upper().replace(" ", "")
    return s if s in CEFR else ""


def normalize_cv(value):
    """Return a well-formed AICV dict from anything: missing keys get defaults, wrong types are
    dropped, lists and strings are capped, links lose their protocol and "www.", list items are
    trimmed and empty ones removed. Unknown keys are ignored."""
    cv = empty_cv()
    if not isinstance(value, dict):
        return cv
    for key in SCALAR_KEYS:
        raw = clean_link(value.get(key)) if key in LINK_KEYS else clean_str(value.get(key))
        cv[key] = drop_placeholder(raw)
    cv["jobs"] = _entries(value.get("jobs"), CAPS["jobs"], JOB_KEYS, True)
    cv["edu"] = _entries(value.get("edu"), CAPS["edu"], EDU_KEYS, False)
    cv["projects"] = _entries(value.get("projects"), CAPS["projects"], ("name", "tech"), True,
                              link_key="link")
    for key in STR_LIST_KEYS:
        cv[key] = str_list(value.get(key), CAPS[key], dedupe=True)
    langs = []
    if isinstance(value.get("langs"), list):
        for item in value["langs"]:
            if not isinstance(item, dict):
                continue
            name = clean_str(item.get("name"))
            if not name:
                continue
            langs.append({"name": name, "level": _clean_level(item.get("level")),
                          "cefr": _cefr(item.get("cefr")),
                          "exam": clean_str(item.get("exam"), 80)})
            if len(langs) >= CAPS["langs"]:
                break
    cv["langs"] = langs
    groups = []
    if isinstance(value.get("skillGroups"), list):
        for item in value["skillGroups"]:
            if not isinstance(item, dict):
                continue
            items = str_list(item.get("items"), MAX_GROUP_ITEMS, limit=80, dedupe=True)
            if not items:
                continue
            groups.append({"name": clean_str(item.get("name"), 40), "items": items})
            if len(groups) >= CAPS["skillGroups"]:
                break
    cv["skillGroups"] = groups
    return cv


# ---------------------------------------------------------------- evidence check (extract)
#
# The model must back every new bullet with a short quote of the person's own words. A model that
# invents a bullet could invent its quote too, so the quote is checked against the answer (and
# the GitHub data) here; bullets that fail are dropped before the client ever sees them.

_FOLD = str.maketrans("çğıöşüâîûÇĞİÖŞÜÂÎÛ", "cgiosuaiuCGIOSUAIU")
_WORD = re.compile(r"[a-z0-9]+")
_FILLERS = {"sey", "yani", "hani", "iste", "ee", "eee", "ii", "iii", "aa", "ha", "hm", "ve", "bir", "de", "da"}
EVIDENCE_MIN_SHARE = 0.6


def tokens(text):
    if not isinstance(text, str):
        return []
    return [w for w in _WORD.findall(text.translate(_FOLD).lower()) if w not in _FILLERS]


def _word_found(word, source, stems):
    if word in source:
        return True
    # Turkish suffixes: "yazılımda" in the answer, "yazılım" in the quote (or the other way round).
    return len(word) >= 5 and word[:max(4, len(word) - 3)] in stems


def quote_supported(quote, source, stems):
    words = [w for w in tokens(quote) if not w.isdigit()]  # "120" vs spoken "yüz yirmi"
    if not words:
        return False
    found = sum(1 for w in words if _word_found(w, source, stems))
    return found / len(words) >= EVIDENCE_MIN_SHARE


def _stems(source):
    out = set()
    for w in source:
        for n in range(4, len(w) + 1):
            out.add(w[:n])
    return out


def _entry_key(entry, keys):
    for k in keys:
        v = entry.get(k) if isinstance(entry, dict) else None
        if isinstance(v, str) and v.strip():
            return " ".join(tokens(v))
    return ""


def verify_evidence(model_cv, req_cv, texts):
    """Blank the evidence of every bullet in model_cv (in place) that the given source texts do not
    support. "cv" is accepted only inside an entry that already existed in the request CV.
    Returns (checked, dropped) counts for content-free logging."""
    source = set()
    for t in texts:
        source.update(tokens(t))
    stems = _stems(source)
    checked = dropped = 0
    for key, id_keys in (("jobs", ("company", "role")), ("projects", ("name",))):
        known = {_entry_key(e, id_keys) for e in req_cv.get(key, [])} - {""}
        entries = model_cv.get(key) if isinstance(model_cv, dict) else None
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("bullets"), list):
                continue
            carried_ok = _entry_key(entry, id_keys) in known
            for b in entry["bullets"]:
                if not isinstance(b, dict):
                    continue
                checked += 1
                ev = b.get("evidence")
                ev = ev.strip() if isinstance(ev, str) else ""
                ok = (carried_ok if ev.casefold() == "cv" else quote_supported(ev, source, stems))
                if not ok:
                    b["evidence"] = ""
                    dropped += 1
    return checked, dropped


def normalize_followups(value):
    return str_list(value, MAX_FOLLOWUPS, limit=400, dedupe=True)


def _pairs(value, keys, cap, limit=200):
    out, seen = [], set()
    if not isinstance(value, list):
        return out
    for item in value:
        if not isinstance(item, dict):
            continue
        entry = {k: clean_str(item.get(k), limit) for k in keys}
        key = entry[keys[0]].casefold()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(entry)
        if len(out) >= cap:
            break
    return out


def normalize_tailor(data):
    return {
        "company": clean_str(data.get("company"), 120),
        "role": clean_str(data.get("role"), 120),
        "matched": _pairs(data.get("matched"), ("term", "where"), MAX_TERMS),
        "missing": _pairs(data.get("missing"), ("term", "question"), MAX_TERMS, limit=300),
        "changes": str_list(data.get("changes"), MAX_CHANGES, limit=300, dedupe=True),
    }


def _ordered_subset(tailored, original):
    """`original` reordered by `tailored`: items the model added are dropped, items it left out are
    appended in their original order."""
    by_key = {item.casefold(): item for item in original}
    out, seen = [], set()
    for item in tailored:
        key = item.casefold()
        if key in by_key and key not in seen:
            seen.add(key)
            out.append(by_key[key])
    out.extend(item for item in original if item.casefold() not in seen)
    return out


def merge_tailored(cv, data):
    """Apply a tailor answer to the (normalised) request CV. Entries, contact details and every
    other field stay as they were."""
    out = {k: (list(v) if isinstance(v, list) else v) for k, v in cv.items()}
    summary = clean_str(data.get("summary"))
    if summary:
        out["summary"] = summary
    out["skills"] = _ordered_subset(str_list(data.get("skills"), CAPS["skills"]), cv["skills"])
    groups = data.get("skillGroups")
    if cv["skillGroups"] and isinstance(groups, list):
        order = {}
        for g in groups:
            if isinstance(g, dict):
                order[clean_str(g.get("name"), 40).casefold()] = str_list(g.get("items"), MAX_GROUP_ITEMS, limit=80)
        merged = [{"name": g["name"], "items": _ordered_subset(order.get(g["name"].casefold(), []), g["items"])}
                  for g in cv["skillGroups"]]
        ranked = [g for g in merged if g["name"].casefold() in order]
        ranked.sort(key=lambda g: list(order).index(g["name"].casefold()))
        out["skillGroups"] = ranked + [g for g in merged if g["name"].casefold() not in order]
    for key in ("jobs", "projects"):
        tailored = data.get(key)
        if not isinstance(tailored, list) or len(tailored) != len(cv[key]):
            continue  # cannot be matched to the CV's entries safely
        entries = []
        for entry, t in zip(cv[key], tailored):
            bullets = str_list(t.get("bullets"), MAX_BULLETS) if isinstance(t, dict) else []
            entries.append(dict(entry, bullets=bullets or entry["bullets"]))
        out[key] = entries
    return out


def normalize_letter(value):
    """A cover letter, or None when the model returned nothing usable."""
    if not isinstance(value, dict):
        return None
    paragraphs = str_list(value.get("paragraphs"), MAX_PARAGRAPHS, limit=2000)
    if not paragraphs:
        return None
    return {
        "recipient": str_list(value.get("recipient"), 3, limit=120),
        "subject": clean_str(value.get("subject"), 200),
        "greeting": clean_str(value.get("greeting"), 120),
        "paragraphs": paragraphs,
        "closing": clean_str(value.get("closing"), 80),
    }
