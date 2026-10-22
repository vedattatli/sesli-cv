"""POST /api/cv — Sesli CV AI backend (Vercel Python function, BaseHTTPRequestHandler style).

Ops: extract | review | finalize | edit | translate | tailor | cover, plus "ping" (no model call:
reports whether the server is configured). The HTTP class at the bottom
is a thin adapter; all logic lives in importable functions so it can be tested without HTTP:

    handle_http(method, headers, body, ip)  -> (status, headers, body_bytes)   full pipeline
    handle(payload, headers, ip)            -> (status, dict)                  parsed JSON in
    process(payload, headers, ip)           -> (status, dict, meta)            + usage/latency

Privacy: request bodies and CV contents are never logged; one log line per request carries
only op, status, latency and token usage.
"""

import hashlib
import hmac
import ipaddress
import json
import math
import os
import random
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import anthropic  # noqa: E402

import _prompts as prompts  # noqa: E402
import _schema as schema  # noqa: E402
from _ratelimit import RateLimiter  # noqa: E402

# ---------------------------------------------------------------- model settings

MODEL = "claude-opus-5-5"
MAX_TOKENS = 16000
BETAS = ["server-side-fallback-2026-07-01"]
FALLBACKS = "default"
EFFORT = {
    "extract": "low",
    "edit": "low",
    "review": "low",
    "translate": "medium",
    "finalize": "medium",
    "tailor": "medium",
    "cover": "medium",
}
CLIENT_TIMEOUT = 240  # seconds per attempt
CLIENT_MAX_RETRIES = 2
# Retries are done here, not by the SDK: the SDK would retry a 240 s timeout twice more and wait out
# any server Retry-After, far beyond Vercel's maxDuration (300 s, vercel.json). Then the platform
# kills the function and the browser gets a non-JSON 504 instead of our Turkish error message.
DEADLINE = 285.0       # seconds for all attempts + waits; must stay below maxDuration
MIN_ATTEMPT = 60.0     # never start a retry with less time than this left
MAX_RETRY_WAIT = 30.0  # a longer Retry-After is passed on to the client (429) instead of waited out

# ---------------------------------------------------------------- request limits

OPS = ("extract", "review", "finalize", "edit", "translate", "tailor", "cover")
LANGS = ("tr", "en")
PROFILES = tuple(prompts.PROFILE_LABEL)
STYLES = tuple(prompts.STYLE_LABEL)
TOPICS = tuple(prompts.TOPIC_LABEL)
MAX_BODY = 120 * 1024
MAX_ANSWER = 8000
MAX_INSTRUCTION = 2000
MAX_AD = 10000
MIN_AD = 40
MAX_TARGET = 200
MAX_HINTS = 15
MAX_QUESTION = 500
MAX_GITHUB = 12
MAX_README = 2500
RATE_LIMIT = 30  # requests per IP per window per instance; env CV_RATE_LIMIT overrides (0 = off)
RATE_WINDOW = 600.0

# Used with fullmatch(): `match(...$)` would also accept a trailing "\n" and echo it into a header.
# Only this project's own deployments (production "sesli-cv.vercel.app" and its preview URLs
# "sesli-cv-<hash>-<team>.vercel.app"), the old GitHub Pages site and local development.
ALLOWED_ORIGIN = re.compile(
    r"https://vedattatli\.github\.io"
    r"|https://sesli-cv(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.vercel\.app"
    r"|http://(?:localhost|127\.0\.0\.1)(?::\d{1,5})?"
)

# ---------------------------------------------------------------- user-facing messages (Turkish)

MSG = {
    "bad_json": "İstek okunamadı (geçersiz JSON).",
    "bad_payload": "Geçersiz istek.",
    "bad_op": "Bilinmeyen işlem.",
    "bad_cv": "CV verisi geçersiz.",
    "bad_answer": "Cevap metni geçersiz.",
    "empty_answer": "Cevap boş görünüyor. Lütfen tekrar konuşun.",
    "long_answer": "Cevap çok uzun. Lütfen daha kısa parçalar halinde anlatın.",
    "empty_instruction": "Ne değiştirmek istediğinizi anlayamadım. Lütfen tekrar söyleyin.",
    "long_instruction": "İstek çok uzun. Lütfen daha kısa söyleyin.",
    "empty_ad": "İlan metni boş ya da çok kısa görünüyor. Lütfen ilanın tamamını yapıştırın.",
    "long_ad": "İlan metni çok uzun. Lütfen yalnızca ilanın kendisini yapıştırın.",
    "access_code": "Erişim kodu eksik ya da hatalı.",
    "method": "Bu adres yalnızca POST isteği kabul eder.",
    "content_type": "İstek JSON biçiminde gönderilmeli (Content-Type: application/json).",
    "too_large": "İstek çok büyük.",
    "rate_limited": "Çok fazla istek gönderildi. Lütfen birkaç dakika sonra tekrar deneyin.",
    "upstream_busy": "Yapay zekâ hizmeti şu an çok yoğun. Lütfen biraz sonra tekrar deneyin.",
    "not_configured": "Yapay zekâ hizmeti henüz ayarlanmamış.",
    "bad_key": "Yapay zekâ anahtarı geçersiz.",
    "upstream": "Yapay zekâ hizmetine şu an ulaşılamıyor. Lütfen biraz sonra tekrar deneyin.",
    "timeout": "Yapay zekâ zamanında yanıt vermedi. Lütfen tekrar deneyin.",
    "refusal": "Yapay zekâ bu isteği işleyemedi. Lütfen cevabınızı farklı bir şekilde söyleyip tekrar deneyin.",
    "max_tokens": "Yanıt çok uzun oldu ve tamamlanamadı. Lütfen tekrar deneyin.",
    "bad_output": "Yapay zekâdan beklenmeyen bir yanıt geldi. Lütfen tekrar deneyin.",
    "internal": "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.",
}

DEFAULT_HEARD = "Cevabınızı CV'nize işledim."
DEFAULT_REPLY = "İsteğinizi uyguladım."
DEFAULT_COVER_REPLY = "Ön yazınız hazır."
MAX_MISSING_Q = 300
MAX_CONFIRM_ITEM = 80


class ApiError(Exception):
    """An error that maps to a JSON response {error, message}."""

    def __init__(self, status, code, message, meta=None, retry_after=None):
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message
        self.meta = meta or {}
        self.retry_after = retry_after

    def body(self):
        out = {"error": self.code, "message": self.message}
        if self.retry_after:
            out["retryAfter"] = self.retry_after
        return out


# ---------------------------------------------------------------- helpers

limiter = RateLimiter(limit=RATE_LIMIT, window=RATE_WINDOW)
_clock = time.monotonic  # patched by tests
_sleep = time.sleep      # patched by tests


def _env_int(name, default):
    try:
        return int(os.environ.get(name, "").strip())
    except ValueError:
        return default


def lower_headers(headers):
    out = {}
    if headers is None:
        return out
    for k, v in headers.items():
        k = str(k).lower()
        if k not in out:
            out[k] = v if isinstance(v, str) else str(v)
    return out


def client_ip(headers, fallback=""):
    h = lower_headers(headers)
    # Behind a Cloudflare tunnel (start-sesli-cv.command) the edge sets CF-Connecting-IP and a client
    # can prepend fake X-Forwarded-For hops. Trust the header only when the launcher says so: on
    # Vercel anyone could send it.
    if os.environ.get("CV_TRUST_CF") == "1" and h.get("cf-connecting-ip", "").strip():
        return h["cf-connecting-ip"].strip()
    xff = h.get("x-forwarded-for", "")
    first = xff.split(",")[0].strip() if xff else ""
    return first or h.get("x-real-ip", "").strip() or fallback or "unknown"


def rate_key(ip):
    """Rate-limit bucket for a client IP. IPv6 is grouped by /64 (one subscriber's prefix), otherwise
    rotating the interface id would give every request a fresh bucket. Unparseable values are cut
    short so a junk header cannot bloat the limiter's memory."""
    text = (ip or "").strip()
    if not text:
        return "unknown"
    try:
        addr = ipaddress.ip_address(text.strip("[]"))
    except ValueError:
        return text[:64]
    if addr.version == 6:
        if addr.ipv4_mapped is not None:
            return str(addr.ipv4_mapped)
        return str(ipaddress.IPv6Network((int(addr) >> 64 << 64, 64)))
    return str(addr)


def cors_headers(origin, preflight=False):
    if not origin or not ALLOWED_ORIGIN.fullmatch(origin):
        return {}
    out = {"Access-Control-Allow-Origin": origin}
    if preflight:
        out.update({
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Access-Code",
            "Access-Control-Max-Age": "600",
        })
    return out


def _log(**fields):
    if os.environ.get("CV_LOG", "1") == "0":
        return
    try:
        print(json.dumps(fields, ensure_ascii=False), flush=True)
    except Exception:  # logging must never break a request
        pass


# ---------------------------------------------------------------- Claude

_client = None
_client_lock = threading.Lock()


def has_credentials():
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip()
                or os.environ.get("ANTHROPIC_AUTH_TOKEN", "").strip())


def get_client():
    """One lazily created client per process (reads ANTHROPIC_API_KEY from the environment)."""
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = anthropic.Anthropic(max_retries=CLIENT_MAX_RETRIES, timeout=CLIENT_TIMEOUT)
    return _client


def _usage_meta(resp):
    meta = {"model": getattr(resp, "model", None), "stop": getattr(resp, "stop_reason", None)}
    usage = getattr(resp, "usage", None)
    if usage is not None:
        for src, dst in (("input_tokens", "in"), ("output_tokens", "out"),
                         ("cache_read_input_tokens", "cache_read"),
                         ("cache_creation_input_tokens", "cache_write")):
            val = getattr(usage, src, None)
            if isinstance(val, int):
                meta[dst] = val
        iterations = getattr(usage, "iterations", None) or []
        if any(getattr(it, "type", None) == "fallback_message" for it in iterations):
            meta["fallback"] = True
    return meta


def final_text(content):
    """Text of the response. A `fallback` block marks a model switch; only text after the last
    switch belongs to the model that produced the final answer."""
    parts = []
    for block in content or []:
        btype = getattr(block, "type", None)
        if btype == "fallback":
            parts = []
        elif btype == "text":
            parts.append(getattr(block, "text", "") or "")
    return "".join(parts)


def _should_retry(err):
    """The SDK's retry policy: connection errors/timeouts, 408/409/429/5xx, or x-should-retry."""
    if isinstance(err, anthropic.APIConnectionError):  # includes APITimeoutError
        return True
    if isinstance(err, anthropic.APIStatusError):
        flag = (err.response.headers.get("x-should-retry") or "").strip().lower()
        if flag in ("true", "false"):
            return flag == "true"
        return err.status_code in (408, 409, 429) or err.status_code >= 500
    return False


def _retry_wait(err, attempt):
    """Seconds before the next attempt: the server's retry-after(-ms) if given, else the SDK's
    back-off (0.5 s * 2^attempt, at most 8 s, minus up to 25 % jitter)."""
    headers = getattr(getattr(err, "response", None), "headers", None) or {}
    for name, scale in (("retry-after-ms", 0.001), ("retry-after", 1.0)):
        try:
            wait = float(headers.get(name)) * scale
        except (TypeError, ValueError):
            continue
        if math.isfinite(wait) and wait > 0:
            return wait
    return min(0.5 * 2 ** attempt, 8.0) * (1 - 0.25 * random.random())


def _create(client, params, started, state):
    """client.beta.messages.create with retries that respect DEADLINE (see the constants)."""
    attempt = 0
    while True:
        remaining = DEADLINE - (_clock() - started)
        try:
            return client.with_options(max_retries=0).beta.messages.create(
                **params, timeout=max(1.0, min(float(CLIENT_TIMEOUT), remaining)))
        except anthropic.AnthropicError as err:
            if attempt >= CLIENT_MAX_RETRIES or not _should_retry(err):
                raise
            wait = _retry_wait(err, attempt)
            left = DEADLINE - (_clock() - started)
            if wait > MAX_RETRY_WAIT or left - wait < MIN_ATTEMPT:
                raise
            _sleep(wait)
            attempt += 1
            state["retries"] = attempt


def call_claude(op, user_message, client):
    """Run one structured-output request. Returns (data_dict, meta). Raises ApiError."""
    started = _clock()
    state = {"retries": 0}
    params = dict(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        betas=BETAS,
        fallbacks=FALLBACKS,
        system=[{"type": "text", "text": prompts.SYSTEM_PROMPT,
                 "cache_control": {"type": "ephemeral"}}],
        output_config={
            "effort": EFFORT[op],
            "format": {"type": "json_schema", "schema": schema.RESPONSE_SCHEMAS[op]},
        },
        messages=[{"role": "user", "content": user_message}],
    )
    try:
        resp = _create(client, params, started, state)
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as e:
        raise ApiError(503, "not_configured", MSG["bad_key"], _err_meta(e, started, state))
    except anthropic.RateLimitError as e:
        retry = _retry_after(e)
        raise ApiError(429, "rate_limited", MSG["upstream_busy"], _err_meta(e, started, state), retry)
    except anthropic.BadRequestError as e:
        raise ApiError(502, "upstream", MSG["upstream"], _err_meta(e, started, state, detail=True))
    except anthropic.APIStatusError as e:
        raise ApiError(502, "upstream", MSG["upstream"],
                       _err_meta(e, started, state, detail=e.status_code < 500))
    except anthropic.APITimeoutError as e:
        raise ApiError(502, "upstream", MSG["timeout"], _err_meta(e, started, state))
    except anthropic.APIConnectionError as e:
        raise ApiError(502, "upstream", MSG["upstream"], _err_meta(e, started, state))
    except anthropic.CredentialsError as e:
        raise ApiError(503, "not_configured", MSG["not_configured"], _err_meta(e, started, state))
    except anthropic.AnthropicError as e:  # e.g. APIResponseValidationError
        raise ApiError(502, "upstream", MSG["upstream"], _err_meta(e, started, state))

    meta = _usage_meta(resp)
    meta["model_ms"] = int((_clock() - started) * 1000)
    if state["retries"]:
        meta["retries"] = state["retries"]
    stop = getattr(resp, "stop_reason", None)
    if stop == "refusal":
        details = getattr(resp, "stop_details", None)
        meta["refusal_category"] = getattr(details, "category", None)
        raise ApiError(502, "upstream", MSG["refusal"], meta)
    if stop in ("max_tokens", "model_context_window_exceeded"):
        raise ApiError(502, "upstream", MSG["max_tokens"], meta)
    text = final_text(getattr(resp, "content", None)).strip()
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        meta["err"] = "non_json_output"
        raise ApiError(502, "upstream", MSG["bad_output"], meta)
    if not isinstance(data, dict):
        meta["err"] = "non_object_output"
        raise ApiError(502, "upstream", MSG["bad_output"], meta)
    return data, meta


def _retry_after(err):
    try:
        val = int(float(err.response.headers.get("retry-after", "")))
        return max(1, min(val, 600))
    except Exception:
        return 30


def _err_meta(err, started, state=None, detail=False):
    meta = {"err": type(err).__name__, "model_ms": int((_clock() - started) * 1000)}
    if state and state.get("retries"):
        meta["retries"] = state["retries"]
    status = getattr(err, "status_code", None)
    if status:
        meta["upstream_status"] = status
    req_id = getattr(err, "request_id", None)
    if req_id:
        meta["request_id"] = req_id
    if detail:
        # The API's error message (never the request body). Kept short.
        meta["detail"] = str(getattr(err, "message", "") or "")[:300]
    return meta


# ---------------------------------------------------------------- request validation

def _clean_github(value):
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        if not isinstance(item, dict):
            continue
        name = schema.clean_str(item.get("name"), 200)
        if not name:
            continue
        stars = item.get("stars")
        stars = stars if isinstance(stars, int) and not isinstance(stars, bool) and stars > 0 else 0
        out.append({
            "name": name,
            "description": schema.clean_str(item.get("description"), 500),
            "language": schema.clean_str(item.get("language"), 60),
            "stars": stars,
            "url": schema.clean_str(item.get("url"), 300),
            "homepage": schema.clean_str(item.get("homepage"), 300),
            "topics": schema.str_list(item.get("topics"), 20, limit=60, dedupe=True),
            "updated": schema.clean_str(item.get("updated"), 40),
            "readme": schema.clean_str(item.get("readme"), MAX_README),
        })
        if len(out) >= MAX_GITHUB:
            break
    return out


def parse_request(payload):
    """Validate and normalise a request object. Returns a dict; raises ApiError(400)."""
    if not isinstance(payload, dict):
        raise ApiError(400, "bad_request", MSG["bad_payload"])
    op = payload.get("op")
    if op not in OPS:
        raise ApiError(400, "bad_request", MSG["bad_op"])
    lang = payload.get("lang")
    lang = lang.strip().lower() if isinstance(lang, str) else "tr"
    if lang not in LANGS:
        lang = "tr"
    raw_cv = payload.get("cv")
    if raw_cv is not None and not isinstance(raw_cv, dict):
        raise ApiError(400, "bad_request", MSG["bad_cv"])
    req = {"op": op, "lang": lang, "cv": schema.normalize_cv(raw_cv),
           "profile": _choice(payload.get("profile"), PROFILES, "deneyimli"),
           "style": _choice(payload.get("style"), STYLES, "kisisel")}

    if op == "extract":
        topic = payload.get("topic")
        req["topic"] = topic if topic in TOPICS else "free"
        req["question"] = schema.clean_str(payload.get("question"), MAX_QUESTION)
        answer = payload.get("answer", "")
        if answer is None:
            answer = ""
        if not isinstance(answer, str):
            raise ApiError(400, "bad_request", MSG["bad_answer"])
        answer = schema.scrub(answer.strip())
        if len(answer) > MAX_ANSWER:
            raise ApiError(400, "bad_request", MSG["long_answer"])
        req["answer"] = answer
        req["github"] = _clean_github(payload.get("github"))
        if not answer and not req["github"]:
            raise ApiError(400, "bad_request", MSG["empty_answer"])
    elif op == "edit":
        instruction = payload.get("instruction")
        instruction = schema.scrub(instruction.strip()) if isinstance(instruction, str) else ""
        if not instruction:
            raise ApiError(400, "bad_request", MSG["empty_instruction"])
        if len(instruction) > MAX_INSTRUCTION:
            raise ApiError(400, "bad_request", MSG["long_instruction"])
        req["instruction"] = instruction
    elif op == "review":
        req["hints"] = schema.str_list(payload.get("hints"), MAX_HINTS, limit=300, dedupe=True)
    elif op == "tailor":
        req["ad"] = _ad(payload.get("ad"), required=True)
    elif op == "cover":
        req["ad"] = _ad(payload.get("ad"), required=False)
        req["target"] = schema.clean_str(payload.get("target"), MAX_TARGET)
        letter = schema.normalize_letter(payload.get("letter"))
        instruction = payload.get("instruction")
        instruction = schema.scrub(instruction.strip()) if isinstance(instruction, str) else ""
        if len(instruction) > MAX_INSTRUCTION:
            raise ApiError(400, "bad_request", MSG["long_instruction"])
        # A revision needs both the letter and what to change; otherwise write a fresh letter.
        req["letter"] = letter if letter and instruction else None
        req["instruction"] = instruction if req["letter"] else ""
    return req


def _choice(value, allowed, default):
    value = value.strip().lower() if isinstance(value, str) else ""
    return value if value in allowed else default


def _ad(value, required):
    ad = schema.scrub(value.strip()) if isinstance(value, str) else ""
    if len(ad) > MAX_AD:
        raise ApiError(400, "bad_request", MSG["long_ad"])
    if required and len(ad) < MIN_AD:
        raise ApiError(400, "bad_request", MSG["empty_ad"])
    return ad


def build_prompt(req):
    op, cv, lang, profile, style = req["op"], req["cv"], req["lang"], req["profile"], req["style"]
    if op == "extract":
        return prompts.build_extract(cv, lang, req["topic"], req["question"], req["answer"],
                                     req["github"], profile, style)
    if op == "review":
        return prompts.build_review(cv, req["hints"], profile)
    if op == "finalize":
        return prompts.build_finalize(cv, lang, profile, style)
    if op == "edit":
        return prompts.build_edit(cv, req["instruction"], lang, profile, style)
    if op == "tailor":
        return prompts.build_tailor(cv, req["ad"], lang, profile, style)
    if op == "cover":
        return prompts.build_cover(cv, lang, req["ad"], req["target"], req["letter"],
                                   req["instruction"])
    return prompts.build_translate(cv, profile)


def _github_texts(repos):
    for r in repos or []:
        yield " ".join([r.get("name", ""), r.get("description", ""), r.get("language", ""),
                        " ".join(r.get("topics", [])), r.get("readme", "")])


def shape_response(op, data, meta=None, req=None):
    """Post-process model JSON into the API response for `op`. `req` is the parsed request."""
    req = req or {"cv": schema.empty_cv()}
    if op == "review":
        return {"followups": schema.normalize_followups(data.get("followups"))}
    if op == "cover":
        letter = schema.normalize_letter(data.get("letter"))
        if letter is None:
            if meta is not None:
                meta["err"] = "missing_letter"
            raise ApiError(502, "upstream", MSG["bad_output"], meta)
        return {
            "letter": letter,
            "company": schema.clean_str(data.get("company"), 120),
            "role": schema.clean_str(data.get("role"), 120),
            "reply": schema.clean_str(data.get("reply"), 600) or DEFAULT_COVER_REPLY,
        }
    if op == "tailor":
        out = {"cv": schema.merge_tailored(req["cv"], data)}
        out.update(schema.normalize_tailor(data))
        return out
    if not isinstance(data.get("cv"), dict):
        # Never hand the client an empty CV it would overwrite its data with.
        if meta is not None:
            meta["err"] = "missing_cv"
        raise ApiError(502, "upstream", MSG["bad_output"], meta)
    if op == "extract":
        checked, dropped = schema.verify_evidence(
            data["cv"], req["cv"], [req.get("answer", "")] + list(_github_texts(req.get("github"))))
        if meta is not None and checked:
            meta["ev_checked"], meta["ev_dropped"] = checked, dropped
    out = {"cv": schema.normalize_cv(data["cv"])}
    if op == "extract":
        out["heard"] = schema.clean_str(data.get("heard"), 600) or DEFAULT_HEARD
        out["missing"] = schema.str_list(data.get("missing"), schema.MAX_MISSING,
                                         limit=MAX_MISSING_Q, dedupe=True)
        out["confirm"] = schema.str_list(data.get("confirm"), schema.MAX_CONFIRM,
                                         limit=MAX_CONFIRM_ITEM, dedupe=True)
    elif op == "edit":
        out["reply"] = schema.clean_str(data.get("reply"), 600) or DEFAULT_REPLY
    return out


# ---------------------------------------------------------------- pipeline

def _digest(raw):
    return hashlib.sha256(raw).digest()


def _check_access(h):
    # Stray whitespace/newlines are a common copy-paste accident in dashboard env vars.
    code = os.environ.get("ACCESS_CODE", "").strip()
    if not code:
        return
    given = h.get("x-access-code", "").strip()
    expected = _digest(code.encode("utf-8"))
    # http.server decodes header bytes as Latin-1, so a UTF-8 code arrives as mojibake; accept the
    # bytes the client actually sent as well as the text itself. Fixed-length digests keep the
    # comparison time independent of the code's length.
    candidates = {given.encode("utf-8", "replace")}
    try:
        candidates.add(given.encode("latin-1"))
    except UnicodeEncodeError:
        pass
    ok = False
    for raw in candidates:
        ok = hmac.compare_digest(_digest(raw), expected) or ok
    if not ok:
        raise ApiError(401, "access_code", MSG["access_code"])


def _check_rate(ip):
    allowed, retry = limiter.hit(rate_key(ip), _env_int("CV_RATE_LIMIT", RATE_LIMIT))
    if not allowed:
        raise ApiError(429, "rate_limited", MSG["rate_limited"], retry_after=retry)


def process(payload, headers=None, ip="", *, client=None, model_call=None):
    """Full request logic after JSON parsing. Returns (status, body_dict, meta).

    client:     an Anthropic-like client (tests inject a fake); default: get_client().
    model_call: callable(op, req) -> raw model dict, replaces Claude entirely (dev mock mode).
    """
    h = lower_headers(headers)
    meta = {}
    try:
        _check_rate(ip)
        _check_access(h)
        if isinstance(payload, dict) and payload.get("op") == "ping":
            # Lets the app decide up front whether to offer the AI interview. No model call.
            configured = model_call is not None or client is not None or has_credentials()
            return 200, {"ok": True, "configured": configured}, meta
        req = parse_request(payload)
        if model_call is not None:
            data = model_call(req["op"], req)
            meta["mock"] = True
        else:
            if client is None:
                if not has_credentials():
                    raise ApiError(503, "not_configured", MSG["not_configured"])
                try:
                    client = get_client()
                except anthropic.AnthropicError as e:
                    raise ApiError(503, "not_configured", MSG["not_configured"], {"err": type(e).__name__})
            data, meta = call_claude(req["op"], build_prompt(req), client)
        return 200, shape_response(req["op"], data, meta, req), meta
    except ApiError as e:
        return e.status, e.body(), e.meta or meta
    except Exception as e:  # a bug must still produce a JSON answer
        return 500, {"error": "internal", "message": MSG["internal"]}, {"err": type(e).__name__}


def handle(payload, headers=None, ip="", *, client=None, model_call=None):
    """Spec entry point: (status, dict). Logs one privacy-safe line."""
    started = time.monotonic()
    status, body, meta = process(payload, headers, ip, client=client, model_call=model_call)
    op = payload.get("op") if isinstance(payload, dict) else None
    _log(op=op if op in OPS or op == "ping" else "invalid", status=status,
         ms=int((time.monotonic() - started) * 1000), **meta)
    return status, body


def _content_length(h):
    raw = h.get("content-length")
    if raw is None or raw == "":
        return None
    try:
        n = int(raw)
    except ValueError:
        return -1
    return n


def _is_json(content_type):
    return (content_type or "").split(";", 1)[0].strip().lower() == "application/json"


def handle_http(method, headers, body, ip=None, *, client=None, model_call=None):
    """HTTP-level pipeline. `body` is bytes, or None when the caller refused to read an
    oversized body. Returns (status, headers_dict, body_bytes)."""
    h = lower_headers(headers)
    origin = h.get("origin", "")
    method = (method or "").upper()
    base = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Vary": "Origin"}

    if method == "OPTIONS":
        out = dict(base, **cors_headers(origin, preflight=True))
        out["Content-Length"] = "0"
        return 204, out, b""

    if ip is None:
        ip = client_ip(h)
    extra = {}
    declared = _content_length(h)
    if method != "POST":
        status, data = 405, {"error": "method_not_allowed", "message": MSG["method"]}
        extra["Allow"] = "POST, OPTIONS"
        _log(op="-", status=405, ms=0)
    elif (declared is not None and declared > MAX_BODY) or body is None or len(body) > MAX_BODY:
        status, data = 413, {"error": "too_large", "message": MSG["too_large"]}
        _log(op="-", status=413, ms=0)
    elif not _is_json(h.get("content-type")):
        # Only JSON: text/plain, form or typeless-Blob POSTs are CORS "simple" requests a foreign
        # page can fire without a preflight; requiring JSON makes the allowlist above apply.
        status, data = 415, {"error": "unsupported_media_type", "message": MSG["content_type"]}
        _log(op="-", status=415, ms=0)
    else:
        try:
            payload = json.loads(body.decode("utf-8")) if body else None
        except (ValueError, RecursionError):  # bad JSON / bad UTF-8 / absurd nesting
            payload = None
        if payload is None:
            status, data = 400, {"error": "bad_request", "message": MSG["bad_json"]}
            _log(op="-", status=400, ms=0)
        else:
            status, data = handle(payload, h, ip, client=client, model_call=model_call)
            if status == 429 and data.get("retryAfter"):
                extra["Retry-After"] = str(data["retryAfter"])

    raw = json.dumps(data, ensure_ascii=False).encode("utf-8", "replace")
    out = dict(base, **cors_headers(origin), **extra)
    out["Content-Type"] = "application/json; charset=utf-8"
    out["Content-Length"] = str(len(raw))
    return status, out, raw


# ---------------------------------------------------------------- Vercel entry point

def serve(req, method, *, model_call=None):
    """Answer one request on a BaseHTTPRequestHandler instance. Shared by the Vercel `handler`
    below and dev_server.py, so both always answer with JSON (and CORS headers), even on a bug."""
    origin = ""
    try:
        h = lower_headers(req.headers)
        origin = h.get("origin", "")
        body = b""
        if method == "POST":
            n = _content_length(h)
            if n is not None and n > MAX_BODY:
                body = None  # do not read an oversized body
            elif n is not None and n > 0:
                body = req.rfile.read(n)
        ip = client_ip(h, req.client_address[0] if req.client_address else "")
        status, headers, data = handle_http(method, h, body, ip, model_call=model_call)
    except Exception as e:  # last resort; handle_http already guards the request logic
        _log(op="-", status=500, ms=0, err=type(e).__name__)
        status, data = 500, json.dumps({"error": "internal", "message": MSG["internal"]},
                                       ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json; charset=utf-8", "Content-Length": str(len(data)),
                   "Cache-Control": "no-store", "Vary": "Origin", **cors_headers(origin)}
    req.send_response(status)
    for key, value in headers.items():
        req.send_header(key, value)
    req.end_headers()
    if data and method != "HEAD":
        req.wfile.write(data)


class handler(BaseHTTPRequestHandler):
    server_version = "SesliCV"
    sys_version = ""

    def _dispatch(self, method):
        serve(self, method)

    def do_POST(self):
        self._dispatch("POST")

    def do_OPTIONS(self):
        self._dispatch("OPTIONS")

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def log_message(self, format, *args):  # noqa: A002 - BaseHTTPRequestHandler signature
        pass  # handle() logs one privacy-safe line per request
