"""Unit tests for the /api/cv backend. No network: Claude is replaced by a fake client.

Run from the project root:  ./.venv/bin/python -m unittest
"""

import copy
import io
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "api"))
sys.path.insert(0, ROOT)

import anthropic  # noqa: E402
import httpx2  # noqa: E402

import cv as api  # noqa: E402
import _prompts as prompts  # noqa: E402
import _schema as schema  # noqa: E402
from _ratelimit import RateLimiter  # noqa: E402
import dev_server  # noqa: E402

CLEAN_ENV = {"CV_LOG": "0", "CV_MOCK_DELAY": "0"}
for _k in ("ACCESS_CODE", "CV_RATE_LIMIT", "CV_MOCK"):
    os.environ.pop(_k, None)
os.environ.update(CLEAN_ENV)


# ---------------------------------------------------------------- fakes

def text(t):
    return SimpleNamespace(type="text", text=t)


def usage(**kw):
    base = dict(input_tokens=1200, output_tokens=800, cache_read_input_tokens=0,
                cache_creation_input_tokens=1100, iterations=None)
    base.update(kw)
    return SimpleNamespace(**base)


def resp(data=None, *, content=None, stop_reason="end_turn", model=api.MODEL, stop_details=None, u=None):
    if content is None:
        content = [SimpleNamespace(type="thinking", thinking="", signature="x"),
                   text(json.dumps(data, ensure_ascii=False))]
    return SimpleNamespace(content=content, stop_reason=stop_reason, model=model,
                           stop_details=stop_details, usage=u or usage())


class FakeMessages:
    def __init__(self, outcome):
        self.outcome = outcome
        self.calls = []

    def create(self, **kw):
        self.calls.append(kw)
        out = self.outcome
        if isinstance(out, BaseException):
            raise out
        if callable(out):
            return out(kw)
        return out


class FakeClient:
    def __init__(self, outcome):
        self.messages = FakeMessages(outcome)
        self.beta = SimpleNamespace(messages=self.messages)
        self.options = []

    def with_options(self, **kw):  # like anthropic.Anthropic.with_options (returns a configured copy)
        self.options.append(kw)
        return self

    @property
    def calls(self):
        return self.messages.calls


class SequenceOutcome:
    """Fake `create` outcome that walks through a list (exception or response) and can advance
    a fake clock by `cost` seconds per attempt, to simulate slow upstream calls."""

    def __init__(self, items, clock=None, cost=0.0):
        self.items = list(items)
        self.clock = clock
        self.cost = cost

    def __call__(self, kw):
        if self.clock is not None:
            self.clock[0] += self.cost
        item = self.items.pop(0) if len(self.items) > 1 else self.items[0]
        if isinstance(item, BaseException):
            raise item
        return item


_REQ = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


def status_error(cls, code, headers=None):
    response = httpx2.Response(code, request=_REQ, headers=headers or {},
                               json={"type": "error", "error": {"type": "x", "message": "boom"}})
    return cls("boom", response=response, body=None)


def full_cv(**over):
    cv = schema.empty_cv()
    cv.update({
        "name": "Ayşe Kaya", "title": "Yazılım Mühendisi", "email": "ayse@example.com",
        "jobs": [{"company": "Kuzey Yazılım", "role": "Geliştirici", "city": "İstanbul",
                  "start": "Mart 2021", "end": "Devam ediyor", "bullets": ["API geliştirdim."]}],
        "skills": ["Python"], "langs": [{"name": "İngilizce", "level": 4}],
    })
    cv.update(over)
    return cv


def extract_payload(**over):
    p = {"op": "extract", "cv": full_cv(), "topic": "experience",
         "question": "İş deneyiminizi anlatır mısınız?", "answer": "kuzey yazılımda çalıştım"}
    p.update(over)
    return p


def ok_client(op="extract", cv=None, **extra):
    data = {"cv": cv if cv is not None else full_cv()}
    if op == "extract":
        data["heard"] = "Kuzey Yazılım deneyiminizi ekledim."
    if op == "edit":
        data["reply"] = "Telefonu güncelledim."
    if op == "review":
        data = {"followups": ["Soru?"]}
    data.update(extra)
    return FakeClient(resp(data))


JSON_CT = {"Content-Type": "application/json"}


class Base(unittest.TestCase):
    def setUp(self):
        api.limiter.reset()
        self.env = mock.patch.dict(os.environ, CLEAN_ENV, clear=False)
        self.env.start()
        for k in ("ACCESS_CODE", "CV_RATE_LIMIT", "CV_MOCK"):
            os.environ.pop(k, None)
        # Retry back-off must never really sleep in tests; record the waits instead.
        self.sleeps = []
        self.sleep_patch = mock.patch.object(api, "_sleep", self.sleeps.append, create=True)
        self.sleep_patch.start()

    def tearDown(self):
        self.sleep_patch.stop()
        self.env.stop()


# ---------------------------------------------------------------- schema

class SchemaTests(unittest.TestCase):
    def walk(self, node, path="$"):
        if isinstance(node, dict):
            if node.get("type") == "object":
                yield path, node
            for k, v in node.items():
                yield from self.walk(v, f"{path}.{k}")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                yield from self.walk(v, f"{path}[{i}]")

    def test_every_object_is_closed_and_fully_required(self):
        for op, sch in schema.RESPONSE_SCHEMAS.items():
            objs = list(self.walk(sch))
            self.assertTrue(objs, op)
            for path, obj in objs:
                self.assertIs(obj["additionalProperties"], False, f"{op} {path}")
                self.assertEqual(sorted(obj["required"]), sorted(obj["properties"]), f"{op} {path}")

    def test_no_unsupported_keywords(self):
        banned = {"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
                  "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "pattern"}
        dumped = json.dumps(schema.RESPONSE_SCHEMAS)
        for word in banned:
            self.assertNotIn(f'"{word}"', dumped)

    def test_aicv_keys_match_spec(self):
        props = schema.AICV_SCHEMA["properties"]
        self.assertEqual(set(props), {
            "name", "title", "phone", "email", "city", "web", "github", "summary", "jobs", "edu",
            "projects", "skills", "skillGroups", "langs", "certs", "hobbies", "refs", "birth",
            "military", "license", "marital"})
        self.assertEqual(set(props["jobs"]["items"]["properties"]),
                         {"company", "role", "city", "start", "end", "bullets"})
        self.assertEqual(set(props["edu"]["items"]["properties"]),
                         {"school", "program", "degree", "start", "end", "note"})
        self.assertEqual(set(props["projects"]["items"]["properties"]),
                         {"name", "tech", "link", "bullets"})
        self.assertEqual(props["langs"]["items"]["properties"]["level"], {"type": "integer"})
        self.assertEqual(set(props["langs"]["items"]["properties"]), {"name", "level", "cefr", "exam"})
        self.assertEqual(set(props["skillGroups"]["items"]["properties"]), {"name", "items"})
        # Only extract asks for evidence-backed bullets; everything else returns plain strings.
        ext = schema.RESPONSE_SCHEMAS["extract"]["properties"]["cv"]["properties"]
        for key in ("jobs", "projects"):
            self.assertEqual(set(ext[key]["items"]["properties"]["bullets"]["items"]["properties"]),
                             {"text", "evidence"})
            self.assertEqual(props[key]["items"]["properties"]["bullets"]["items"], {"type": "string"})

    def test_response_schema_shapes(self):
        rs = schema.RESPONSE_SCHEMAS
        self.assertEqual(set(rs), set(api.OPS))
        self.assertEqual(rs["extract"]["required"], ["cv", "heard", "missing", "confirm"])
        self.assertEqual(rs["tailor"]["required"], ["summary", "skills", "skillGroups", "jobs", "projects",
                                                    "company", "role", "matched", "missing", "changes"])
        self.assertEqual(rs["cover"]["required"], ["letter", "company", "role", "reply"])
        self.assertEqual(rs["cover"]["properties"]["letter"]["required"],
                         ["recipient", "subject", "greeting", "paragraphs", "closing"])
        self.assertEqual(rs["review"]["required"], ["followups"])
        self.assertEqual(rs["finalize"]["required"], ["cv"])
        self.assertEqual(rs["edit"]["required"], ["cv", "reply"])
        self.assertEqual(rs["translate"]["required"], ["cv"])


# ---------------------------------------------------------------- validator

class NormalizeTests(unittest.TestCase):
    def test_defaults(self):
        for value in (None, "x", 5, [], {}):
            self.assertEqual(schema.normalize_cv(value), schema.empty_cv())
        cv = schema.normalize_cv({"name": " Ali "})
        self.assertEqual(cv["name"], "Ali")
        self.assertEqual(set(cv), set(schema.AICV_SCHEMA["properties"]))

    def test_wrong_types_dropped(self):
        cv = schema.normalize_cv({
            "name": 5, "summary": ["x"], "jobs": "nope", "skills": [1, " Python ", "", None, "python"],
            "edu": ["str", {"school": "ODTÜ", "start": 2019}], "langs": "İngilizce", "certs": {"a": 1},
            "unknown": "ignored",
        })
        self.assertEqual(cv["name"], "")
        self.assertEqual(cv["summary"], "")
        self.assertEqual(cv["jobs"], [])
        self.assertEqual(cv["skills"], ["Python"])
        self.assertEqual(cv["edu"], [{"school": "ODTÜ", "program": "", "degree": "", "start": "",
                                      "end": "", "note": ""}])
        self.assertEqual(cv["langs"], [])
        self.assertEqual(cv["certs"], [])
        self.assertNotIn("unknown", cv)

    def test_caps(self):
        job = {"company": "A", "bullets": [f"b{i}" for i in range(15)]}
        cv = schema.normalize_cv({
            "summary": "x" * 2000,
            "jobs": [dict(job, company=f"C{i}") for i in range(20)],
            "edu": [{"school": f"S{i}"} for i in range(12)],
            "projects": [{"name": f"P{i}"} for i in range(14)],
            "skills": [f"s{i}" for i in range(50)],
            "langs": [{"name": f"L{i}", "level": 1} for i in range(20)],
            "certs": [f"c{i}" for i in range(25)],
            "hobbies": [f"h{i}" for i in range(20)],
            "refs": [f"r{i}" for i in range(10)],
        })
        self.assertEqual(len(cv["summary"]), 1500)
        self.assertEqual(len(cv["jobs"]), 15)
        self.assertEqual(len(cv["jobs"][0]["bullets"]), 10)
        self.assertEqual(len(cv["edu"]), 10)
        self.assertEqual(len(cv["projects"]), 12)
        self.assertEqual(len(cv["skills"]), 40)
        self.assertEqual(len(cv["langs"]), 12)
        self.assertEqual(len(cv["certs"]), 20)
        self.assertEqual(len(cv["hobbies"]), 15)
        self.assertEqual(len(cv["refs"]), 8)

    def test_lang_levels_clamped(self):
        levels = [9, -2, "3", True, 2.6, None, "x", 4]
        cv = schema.normalize_cv({"langs": [{"name": f"L{i}", "level": v} for i, v in enumerate(levels)]
                                  + [{"name": "", "level": 3}, "bad"]})
        self.assertEqual([lng["level"] for lng in cv["langs"]], [5, 0, 3, 0, 3, 0, 0, 4])

    def test_links_stripped(self):
        cv = schema.normalize_cv({
            "web": "https://www.linkedin.com/in/aysekaya/", "github": "HTTP://WWW.github.com/ayse",
            "projects": [{"name": "X", "link": "https://github.com/ayse/x"}],
        })
        self.assertEqual(cv["web"], "linkedin.com/in/aysekaya")
        self.assertEqual(cv["github"], "github.com/ayse")
        self.assertEqual(cv["projects"][0]["link"], "github.com/ayse/x")

    def test_bullets_from_string_and_markers(self):
        cv = schema.normalize_cv({"jobs": [{"company": "A", "bullets": "• Bir\n- İki\n\n  * Üç  \n%30 hız"}]})
        self.assertEqual(cv["jobs"][0]["bullets"], ["Bir", "İki", "Üç", "%30 hız"])

    def test_empty_entries_dropped(self):
        cv = schema.normalize_cv({"jobs": [{"company": " ", "bullets": [" "]}, {}],
                                  "projects": [{"name": "", "tech": "", "link": "", "bullets": []}]})
        self.assertEqual(cv["jobs"], [])
        self.assertEqual(cv["projects"], [])

    def test_followups(self):
        self.assertEqual(schema.normalize_followups([" a? ", "", 3, "b?", "c?", "d?", "e?", "f?"]),
                         ["a?", "b?", "c?", "d?", "e?"])
        self.assertEqual(schema.normalize_followups("x"), ["x"])
        self.assertEqual(schema.normalize_followups(None), [])

    def test_idempotent(self):
        once = schema.normalize_cv(full_cv(web="https://www.x.com/"))
        self.assertEqual(schema.normalize_cv(copy.deepcopy(once)), once)


# ---------------------------------------------------------------- prompts

class PromptTests(unittest.TestCase):
    def test_system_prompt_stable(self):
        sp = prompts.SYSTEM_PROMPT
        self.assertTrue(sp.startswith('You are the writing engine behind "Sesli CV"'))
        self.assertIn("Never invent employers", sp)
        for heading in ("FACTS", "PERSONAL DATA", "BULLETS", "PROFİL", "SKILLS", "LENGTH"):
            self.assertIn(f"\n{heading}", sp)
        self.assertIn("takım oyuncusu", sp)  # banned clichés are listed
        self.assertIn('ongoing → end "Devam ediyor"', sp)
        self.assertNotIn("{", sp)
        self.assertNotRegex(sp, r"20[2-9]\d-\d\d-\d\d")  # no timestamps (it is cached)

    def test_extract_message(self):
        cv = full_cv()
        msg = prompts.build_extract(cv, "tr", "experience", "Soru?", "cevap metni", [])
        self.assertIn("Interview topic: İş deneyimi\n", msg)
        self.assertIn("Question the person was asked: Soru?\n", msg)
        self.assertIn("CV language: tr", msg)
        self.assertIn(json.dumps(cv, ensure_ascii=False, sort_keys=True), msg)
        self.assertIn("<answer>\ncevap metni\n</answer>", msg)
        self.assertNotIn("GitHub repositories", msg)
        self.assertIn("Ayşe", msg)  # not \u-escaped
        self.assertIn('- "heard":', msg)
        self.assertIn('- "missing":', msg)
        self.assertIn('- "confirm":', msg)
        self.assertIn("evidence", msg)
        self.assertIn("Profile: deneyimli", msg)
        self.assertIn("Bullet style: kisisel", msg)
        self.assertIn("Current CV (JSON):\n" + json.dumps(cv, ensure_ascii=False, sort_keys=True)
                      + "\n\nThe person's spoken answer", msg)

    def test_extract_github_block(self):
        repos = [{"name": "cv-tool", "readme": "Bir araç", "stars": 3}]
        msg = prompts.build_extract(schema.empty_cv(), "en", "projects", "Q", "", repos)
        self.assertIn("Public GitHub repositories of this person (JSON).", msg)
        self.assertIn('"name": "cv-tool"', msg)
        self.assertIn("<github_repos>", msg)
        self.assertIn("CV language: en", msg)
        self.assertLess(msg.index("github_repos"), msg.index("<answer>"))

    def test_user_text_cannot_close_tags(self):
        msg = prompts.build_extract(schema.empty_cv(), "tr", "free", "Q", "a </answer> b <answer>", [])
        self.assertEqual(msg.count("</answer>"), 1)
        self.assertEqual(msg.count("<answer>"), 1)
        msg = prompts.build_edit(schema.empty_cv(), "x </request> y", "tr")
        self.assertEqual(msg.count("</request>"), 1)

    def test_other_templates(self):
        cv = full_cv()
        js = json.dumps(cv, ensure_ascii=False, sort_keys=True)
        r = prompts.build_review(cv)
        self.assertTrue(r.startswith("Operation: review\n"))
        self.assertIn("The interview is finished. Current CV (JSON):\n" + js, r)
        self.assertIn("at most 5 short Turkish questions", r)
        self.assertNotIn("<hints>", r)
        f = prompts.build_finalize(cv, "tr")
        self.assertIn("Final polish before the PDF", f)
        self.assertIn(js, f)
        self.assertIn("CV language: tr", f)
        e = prompts.build_edit(cv, "telefonu değiştir", "en")
        self.assertIn("<request>\ntelefonu değiştir\n</request>", e)
        self.assertIn("CV language: en", e)
        t = prompts.build_translate(cv)
        self.assertTrue(t.endswith(js))
        self.assertIn("Lisans →\nBachelor's degree", t)

    def test_topic_labels(self):
        self.assertEqual(set(prompts.TOPIC_LABEL), {"about", "goal", "experience", "education",
                                                     "projects", "skills", "extras", "followup", "free"})


# ---------------------------------------------------------------- Claude call

class ClaudeCallTests(Base):
    def test_extract_success_and_request_shape(self):
        out_cv = full_cv(web="https://www.ayse.dev/", langs=[{"name": "İngilizce", "level": 7}])
        client = ok_client("extract", out_cv)
        status, body = api.handle(extract_payload(), {}, "1.1.1.1", client=client)
        self.assertEqual(status, 200, body)
        self.assertEqual(set(body), {"cv", "heard", "missing", "confirm"})
        self.assertEqual(body["cv"]["web"], "ayse.dev")
        self.assertEqual(body["cv"]["langs"][0]["level"], 5)
        self.assertEqual(body["heard"], "Kuzey Yazılım deneyiminizi ekledim.")
        kw = client.calls[0]
        self.assertEqual(kw["model"], "claude-opus-5-5")
        self.assertEqual(kw["max_tokens"], 16000)
        self.assertEqual(kw["betas"], ["server-side-fallback-2026-07-01"])
        self.assertEqual(kw["fallbacks"], "default")
        self.assertNotIn("thinking", kw)
        self.assertEqual(kw["system"], [{"type": "text", "text": prompts.SYSTEM_PROMPT,
                                         "cache_control": {"type": "ephemeral"}}])
        self.assertEqual(kw["output_config"]["effort"], "low")
        self.assertEqual(kw["output_config"]["format"],
                         {"type": "json_schema", "schema": schema.RESPONSE_SCHEMAS["extract"]})
        self.assertEqual(len(kw["messages"]), 1)
        self.assertEqual(kw["messages"][0]["role"], "user")
        self.assertIn("kuzey yazılımda çalıştım", kw["messages"][0]["content"])

    def test_effort_per_op(self):
        for op, effort in (("review", "low"), ("finalize", "medium"), ("translate", "medium"),
                           ("edit", "low")):
            client = ok_client(op)
            payload = {"op": op, "cv": full_cv()}
            if op == "edit":
                payload["instruction"] = "telefonumu 0532 111 22 33 yap"
            status, body = api.handle(payload, {}, "1.1.1.1", client=client)
            self.assertEqual(status, 200, (op, body))
            self.assertEqual(client.calls[0]["output_config"]["effort"], effort)
            self.assertEqual(client.calls[0]["output_config"]["format"]["schema"],
                             schema.RESPONSE_SCHEMAS[op])

    def test_response_shapes(self):
        status, body = api.handle({"op": "review", "cv": full_cv()}, {}, "", client=FakeClient(
            resp({"followups": [" a? ", "", "b?", "c?", "d?", "e?", "f?"]})))
        self.assertEqual((status, body), (200, {"followups": ["a?", "b?", "c?", "d?", "e?"]}))
        status, body = api.handle({"op": "finalize", "cv": full_cv()}, {}, "", client=ok_client("finalize"))
        self.assertEqual(set(body), {"cv"})
        status, body = api.handle({"op": "translate", "cv": full_cv()}, {}, "", client=ok_client("translate"))
        self.assertEqual(set(body), {"cv"})
        status, body = api.handle({"op": "edit", "cv": full_cv(), "instruction": "x"}, {}, "",
                                  client=FakeClient(resp({"cv": full_cv(), "reply": "  "})))
        self.assertEqual(body["reply"], api.DEFAULT_REPLY)
        status, body = api.handle(extract_payload(), {}, "",
                                  client=FakeClient(resp({"cv": full_cv(), "heard": ""})))
        self.assertEqual(body["heard"], api.DEFAULT_HEARD)

    def test_refusal_and_max_tokens(self):
        refusal = resp(content=[], stop_reason="refusal",
                       stop_details=SimpleNamespace(type="refusal", category="cyber", explanation=None))
        status, body = api.handle(extract_payload(), {}, "", client=FakeClient(refusal))
        self.assertEqual(status, 502)
        self.assertEqual(body["error"], "upstream")
        self.assertEqual(body["message"], api.MSG["refusal"])
        truncated = resp(content=[text('{"cv": {"name": "A')], stop_reason="max_tokens")
        status, body = api.handle(extract_payload(), {}, "", client=FakeClient(truncated))
        self.assertEqual((status, body["error"], body["message"]), (502, "upstream", api.MSG["max_tokens"]))

    def test_bad_model_output(self):
        for content in ([text("not json")], [], [SimpleNamespace(type="thinking", thinking="")],
                        [text("[1, 2]")], [text('{"heard": "x"}')], [text('{"cv": "x", "heard": "y"}')]):
            status, body = api.handle(extract_payload(), {}, "", client=FakeClient(resp(content=content)))
            self.assertEqual(status, 502, content)
            self.assertEqual(body["error"], "upstream")
            self.assertTrue(body["message"])

    def test_text_after_fallback_block_wins(self):
        good = json.dumps({"cv": full_cv(name="Fallback"), "heard": "ok"}, ensure_ascii=False)
        content = [text('{"cv": {"na'),
                   SimpleNamespace(type="fallback", from_=SimpleNamespace(model="a"), to=SimpleNamespace(model="b")),
                   text(good)]
        status, body = api.handle(extract_payload(), {}, "", client=FakeClient(resp(content=content)))
        self.assertEqual(status, 200, body)
        self.assertEqual(body["cv"]["name"], "Fallback")

    def test_usage_meta(self):
        u = usage(input_tokens=10, output_tokens=20, cache_read_input_tokens=30, cache_creation_input_tokens=0,
                  iterations=[SimpleNamespace(type="message"), SimpleNamespace(type="fallback_message")])
        client = FakeClient(resp({"cv": full_cv(), "heard": "x"}, u=u, model="claude-opus-4-8"))
        status, body, meta = api.process(extract_payload(), {}, "", client=client)
        self.assertEqual(status, 200)
        self.assertEqual((meta["in"], meta["out"], meta["cache_read"], meta["cache_write"]), (10, 20, 30, 0))
        self.assertTrue(meta["fallback"])
        self.assertEqual(meta["model"], "claude-opus-4-8")
        self.assertIn("model_ms", meta)

    def test_error_mapping(self):
        cases = [
            (status_error(anthropic.AuthenticationError, 401), 503, "not_configured", api.MSG["bad_key"]),
            (status_error(anthropic.PermissionDeniedError, 403), 503, "not_configured", api.MSG["bad_key"]),
            (status_error(anthropic.RateLimitError, 429, {"retry-after": "17"}), 429, "rate_limited",
             api.MSG["upstream_busy"]),
            (status_error(anthropic.InternalServerError, 500), 502, "upstream", api.MSG["upstream"]),
            (status_error(anthropic.APIStatusError, 529), 502, "upstream", api.MSG["upstream"]),
            (status_error(anthropic.BadRequestError, 400), 502, "upstream", api.MSG["upstream"]),
            (status_error(anthropic.NotFoundError, 404), 502, "upstream", api.MSG["upstream"]),
            (anthropic.APIConnectionError(request=_REQ), 502, "upstream", api.MSG["upstream"]),
            (anthropic.APITimeoutError(request=_REQ), 502, "upstream", api.MSG["timeout"]),
            (RuntimeError("bug"), 500, "internal", api.MSG["internal"]),
        ]
        for exc, code, err, message in cases:
            status, body = api.handle(extract_payload(), {}, "", client=FakeClient(exc))
            self.assertEqual((status, body["error"], body["message"]), (code, err, message), type(exc).__name__)
        status, body = api.handle(extract_payload(), {}, "", client=FakeClient(
            status_error(anthropic.RateLimitError, 429, {"retry-after": "17"})))
        self.assertEqual(body["retryAfter"], 17)

    def test_bad_request_logs_message_not_body(self):
        client = FakeClient(status_error(anthropic.BadRequestError, 400))
        buf = io.StringIO()
        with mock.patch.dict(os.environ, {"CV_LOG": "1"}), redirect_stdout(buf):
            api.handle(extract_payload(answer="GIZLI-CEVAP-METNI"), {}, "", client=client)
        line = json.loads(buf.getvalue().strip().splitlines()[-1])
        self.assertEqual(line["status"], 502)
        self.assertEqual(line["err"], "BadRequestError")
        self.assertEqual(line["detail"], "boom")
        self.assertNotIn("GIZLI", buf.getvalue())
        self.assertNotIn("Ayşe", buf.getvalue())

    def test_success_log_has_usage_only(self):
        buf = io.StringIO()
        with mock.patch.dict(os.environ, {"CV_LOG": "1"}), redirect_stdout(buf):
            api.handle(extract_payload(answer="GIZLI-CEVAP"), {}, "", client=ok_client())
        line = json.loads(buf.getvalue().strip())
        self.assertEqual(line["op"], "extract")
        self.assertEqual(line["status"], 200)
        for key in ("ms", "in", "out", "cache_read", "cache_write", "model", "stop"):
            self.assertIn(key, line)
        self.assertNotIn("GIZLI", buf.getvalue())
        self.assertNotIn("Kuzey", buf.getvalue())

    def test_missing_api_key(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ANTHROPIC_API_KEY", None)
            os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)
            status, body = api.handle(extract_payload(), {}, "")
        self.assertEqual((status, body["error"]), (503, "not_configured"))
        self.assertEqual(body["message"], api.MSG["not_configured"])


# ---------------------------------------------------------------- request validation

class ValidationTests(Base):
    def call(self, payload, client=None):
        return api.handle(payload, {}, "9.9.9.9", client=client or ok_client(payload.get("op", "extract")
                                                                              if isinstance(payload, dict) else "extract"))

    def test_bad_payloads(self):
        for payload in ([], "x", 3, None):
            status, body = self.call(payload)
            self.assertEqual((status, body["error"]), (400, "bad_request"))
        for payload in ({}, {"op": "delete"}, {"op": 3}):
            status, body = self.call(payload)
            self.assertEqual((status, body["message"]), (400, api.MSG["bad_op"]))
        status, body = self.call(extract_payload(cv=["x"]))
        self.assertEqual((status, body["message"]), (400, api.MSG["bad_cv"]))

    def test_missing_cv_defaults(self):
        client = ok_client()
        status, _ = self.call({"op": "extract", "answer": "merhaba ben ali"}, client)
        self.assertEqual(status, 200)
        sent = client.calls[0]["messages"][0]["content"]
        self.assertIn(json.dumps(schema.empty_cv(), ensure_ascii=False, sort_keys=True), sent)
        self.assertIn("Interview topic: Serbest anlatım", sent)  # missing topic → free

    def test_input_cv_is_normalised_before_prompting(self):
        client = ok_client()
        dirty = {"name": " Ali ", "jobs": "x", "web": "https://www.ali.dev", "extra": "drop"}
        self.call(extract_payload(cv=dirty), client)
        sent = client.calls[0]["messages"][0]["content"]
        self.assertIn('"name": "Ali"', sent)
        self.assertIn('"web": "ali.dev"', sent)
        self.assertNotIn('"extra"', sent)

    def test_answer_rules(self):
        for answer in ("", "   ", None):
            status, body = self.call(extract_payload(answer=answer))
            self.assertEqual((status, body["message"]), (400, api.MSG["empty_answer"]), answer)
        status, body = self.call(extract_payload(answer=["x"]))
        self.assertEqual((status, body["message"]), (400, api.MSG["bad_answer"]))
        status, body = self.call(extract_payload(answer="a" * 8001))
        self.assertEqual((status, body["message"]), (400, api.MSG["long_answer"]))
        status, _ = self.call(extract_payload(answer="a" * 8000))
        self.assertEqual(status, 200)

    def test_github_list(self):
        repos = [{"name": f"repo{i}", "readme": "r" * 5000, "stars": 2, "topics": ["a", 1, "a"],
                  "url": "https://github.com/x/repo", "extra": "drop"} for i in range(20)]
        repos.insert(0, "junk")
        repos.insert(1, {"name": ""})
        client = ok_client()
        status, _ = self.call(extract_payload(answer="", topic="projects", github=repos), client)
        self.assertEqual(status, 200)
        sent = client.calls[0]["messages"][0]["content"]
        block = sent[sent.index("<github_repos>\n") + 15: sent.index("\n</github_repos>")]
        data = json.loads(block)
        self.assertEqual(len(data), 12)
        self.assertEqual(len(data[0]["readme"]), 2500)
        self.assertEqual(data[0]["topics"], ["a"])
        self.assertNotIn("extra", data[0])
        self.assertEqual(set(data[0]), {"name", "description", "language", "stars", "url", "homepage",
                                        "topics", "updated", "readme"})
        client = ok_client()
        status, _ = self.call(extract_payload(github="not-a-list"), client)
        self.assertEqual(status, 200)
        self.assertNotIn("GitHub repositories", client.calls[0]["messages"][0]["content"])

    def test_topic_lang_question(self):
        client = ok_client()
        self.call(extract_payload(topic="hack", lang="EN", question="q" * 900), client)
        sent = client.calls[0]["messages"][0]["content"]
        self.assertIn("Interview topic: Serbest anlatım", sent)
        self.assertIn("CV language: en", sent)
        self.assertIn("Question the person was asked: " + "q" * 500 + "\n", sent)
        client = ok_client()
        self.call(extract_payload(lang="de"), client)
        self.assertIn("CV language: tr", client.calls[0]["messages"][0]["content"])

    def test_edit_instruction(self):
        for instr in (None, "", "  ", 5):
            status, body = self.call({"op": "edit", "cv": full_cv(), "instruction": instr})
            self.assertEqual((status, body["message"]), (400, api.MSG["empty_instruction"]))
        status, body = self.call({"op": "edit", "cv": full_cv(), "instruction": "x" * 2001})
        self.assertEqual((status, body["message"]), (400, api.MSG["long_instruction"]))
        status, _ = self.call({"op": "edit", "cv": full_cv(), "instruction": "x" * 2000})
        self.assertEqual(status, 200)


# ---------------------------------------------------------------- access code

class AccessCodeTests(Base):
    def test_access_code(self):
        os.environ["ACCESS_CODE"] = "gizli-kod-ğ"
        for headers in ({}, {"X-Access-Code": "yanlis"}, {"X-Access-Code": ""}):
            status, body = api.handle(extract_payload(), headers, "", client=ok_client())
            self.assertEqual((status, body["error"]), (401, "access_code"))
            self.assertEqual(body["message"], api.MSG["access_code"])
        for headers in ({"X-Access-Code": "gizli-kod-ğ"}, {"x-access-code": "gizli-kod-ğ"}):
            status, _ = api.handle(extract_payload(), headers, "", client=ok_client())
            self.assertEqual(status, 200)

    def test_no_access_code_configured(self):
        status, _ = api.handle(extract_payload(), {}, "", client=ok_client())
        self.assertEqual(status, 200)

    def test_compare_digest_used(self):
        os.environ["ACCESS_CODE"] = "abc"
        with mock.patch.object(api.hmac, "compare_digest", wraps=api.hmac.compare_digest) as spy:
            api.handle(extract_payload(), {"X-Access-Code": "abd"}, "", client=ok_client())
        spy.assert_called_once()


# ---------------------------------------------------------------- rate limit

class RateLimitTests(Base):
    def test_limiter_window(self):
        now = [1000.0]
        rl = RateLimiter(limit=30, window=600, clock=lambda: now[0])
        for _ in range(30):
            self.assertEqual(rl.hit("a"), (True, 0))
        allowed, retry = rl.hit("a")
        self.assertFalse(allowed)
        self.assertEqual(retry, 600)
        self.assertTrue(rl.hit("b")[0])
        now[0] += 300
        self.assertEqual(rl.hit("a"), (False, 300))
        now[0] += 301
        self.assertTrue(rl.hit("a")[0])

    def test_limit_zero_disables(self):
        rl = RateLimiter(limit=0)
        for _ in range(100):
            self.assertTrue(rl.hit("a")[0])

    def test_key_pruning(self):
        now = [0.0]
        rl = RateLimiter(limit=1, window=10, clock=lambda: now[0], max_keys=5)
        for i in range(5):
            rl.hit(f"k{i}")
        now[0] = 20
        rl.hit("new")
        self.assertEqual(list(rl._hits), ["new"])
        for i in range(10):
            rl.hit(f"x{i}")
        self.assertLessEqual(len(rl._hits), 5)

    def test_handle_rate_limited(self):
        os.environ["CV_RATE_LIMIT"] = "2"
        for _ in range(2):
            self.assertEqual(api.handle(extract_payload(), {}, "5.5.5.5", client=ok_client())[0], 200)
        status, body = api.handle(extract_payload(), {}, "5.5.5.5", client=ok_client())
        self.assertEqual((status, body["error"]), (429, "rate_limited"))
        self.assertEqual(body["message"], api.MSG["rate_limited"])
        self.assertGreater(body["retryAfter"], 0)
        self.assertEqual(api.handle(extract_payload(), {}, "6.6.6.6", client=ok_client())[0], 200)
        status, headers, raw = api.handle_http("POST", dict(JSON_CT, **{"X-Forwarded-For": "5.5.5.5, 10.0.0.1"}),
                                               json.dumps(extract_payload()).encode(), client=ok_client())
        self.assertEqual(status, 429)
        self.assertIn("Retry-After", headers)

    def test_default_limit_is_30(self):
        for i in range(30):
            self.assertEqual(api.handle(extract_payload(), {}, "7.7.7.7", client=ok_client())[0], 200, i)
        self.assertEqual(api.handle(extract_payload(), {}, "7.7.7.7", client=ok_client())[0], 429)

    def test_client_ip(self):
        self.assertEqual(api.client_ip({"X-Forwarded-For": " 1.2.3.4 , 10.0.0.1"}), "1.2.3.4")
        self.assertEqual(api.client_ip({"x-real-ip": "2.2.2.2"}), "2.2.2.2")
        self.assertEqual(api.client_ip({}, "3.3.3.3"), "3.3.3.3")
        self.assertEqual(api.client_ip({}), "unknown")


# ---------------------------------------------------------------- HTTP layer / CORS / sizes

class HttpTests(Base):
    def post(self, payload, headers=None, client=None, raw=None):
        body = raw if raw is not None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        return api.handle_http("POST", dict(JSON_CT, **(headers or {})), body, "8.8.8.8",
                               client=client or ok_client())

    def test_cors_allowlist(self):
        good = ["https://vedattatli.github.io", "https://sesli-cv.vercel.app",
                "https://sesli-cv-k3j9x2a1q-vedattatlis-projects.vercel.app",
                "https://sesli-cv-git-main-vedat.vercel.app", "http://localhost:8787", "http://localhost",
                "http://127.0.0.1:5500"]
        bad = ["http://vedattatli.github.io", "https://evil.com", "https://vercel.app",
               "https://evil.vercel.app", "https://sesli-cvx.vercel.app", "https://sesli-cv-.vercel.app",
               "https://sesli-cv.vercel.app.evil.com", "https://x-sesli-cv.vercel.app",
               "https://evil.com/.vercel.app", "https://x.vercel.app.evil.com", "https://evilvercel.app",
               "http://localhost.evil.com", "https://localhost:8787", "null", "",
               "https://vedattatli.github.io.evil.com", "http://127.0.0.1:99999999"]
        for origin in good:
            status, headers, _ = self.post(extract_payload(), {"Origin": origin})
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("Access-Control-Allow-Origin"), origin, origin)
        for origin in bad:
            status, headers, _ = self.post(extract_payload(), {"Origin": origin})
            self.assertNotIn("Access-Control-Allow-Origin", headers, origin)

    def test_preflight(self):
        status, headers, raw = api.handle_http("OPTIONS", {"Origin": "https://vedattatli.github.io"}, b"")
        self.assertEqual((status, raw), (204, b""))
        self.assertEqual(headers["Access-Control-Allow-Origin"], "https://vedattatli.github.io")
        self.assertEqual(headers["Access-Control-Allow-Methods"], "POST, OPTIONS")
        self.assertEqual(headers["Access-Control-Allow-Headers"], "Content-Type, X-Access-Code")
        status, headers, _ = api.handle_http("OPTIONS", {"Origin": "https://evil.com"}, b"")
        self.assertEqual(status, 204)
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_errors_carry_cors_too(self):
        status, headers, raw = self.post(None, {"Origin": "http://localhost:3000"}, raw=b"{bad")
        self.assertEqual(status, 400)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://localhost:3000")

    def test_method_not_allowed(self):
        for method in ("GET", "PUT", "DELETE", "HEAD"):
            status, headers, raw = api.handle_http(method, {}, b"")
            self.assertEqual(status, 405)
            self.assertEqual(headers["Allow"], "POST, OPTIONS")
            self.assertEqual(json.loads(raw)["message"], api.MSG["method"])

    def test_body_limit(self):
        big = json.dumps(extract_payload(answer="a" * 7000, question="q" * 130000)).encode()
        self.assertGreater(len(big), 120 * 1024)
        status, _, raw = self.post(None, raw=big)
        self.assertEqual((status, json.loads(raw)["error"]), (413, "too_large"))
        status, _, raw = api.handle_http("POST", {"Content-Length": str(500 * 1024)}, None)
        self.assertEqual(status, 413)
        ok = json.dumps(extract_payload()).encode()
        status, _, _ = self.post(None, raw=ok)
        self.assertEqual(status, 200)

    def test_bad_json(self):
        for raw in (b"", b"{", b"\xff\xfe", b"null", b"nul", b"[" * 100000, b'{"op": "extract", "x": 1' + b"0" * 5000 + b"}"):
            status, _, out = self.post(None, raw=raw)
            data = json.loads(out)
            self.assertEqual((status, data["error"]), (400, "bad_request"), raw)
            self.assertTrue(data["message"])
        status, _, out = self.post(None, raw=b"[1,2]")
        self.assertEqual((status, json.loads(out)["error"]), (400, "bad_request"))

    def test_success_headers_and_body(self):
        status, headers, raw = self.post(extract_payload())
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
        self.assertEqual(headers["Content-Length"], str(len(raw)))
        self.assertEqual(headers["Cache-Control"], "no-store")
        data = json.loads(raw.decode("utf-8"))
        self.assertIn("Kuzey Yazılım", raw.decode("utf-8"))  # UTF-8, not \u escapes
        self.assertEqual(set(data), {"cv", "heard", "missing", "confirm"})


# ---------------------------------------------------------------- real sockets

def _serve(server):
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return t


def _request(url, method="GET", data=None, headers=None):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.headers, r.read()  # HTTPMessage: case-insensitive lookups
    except urllib.error.HTTPError as e:
        with e:
            return e.code, e.headers, e.read()


class VercelHandlerTests(Base):
    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), api.handler)
        _serve(cls.server)
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}/api/cv"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        super().setUp()
        os.environ["ANTHROPIC_API_KEY"] = "test-placeholder-not-a-key"
        self.saved = api._client
        api._client = ok_client()

    def tearDown(self):
        api._client = self.saved
        super().tearDown()

    def test_post_ok(self):
        status, headers, raw = _request(self.url, "POST", json.dumps(extract_payload()).encode(),
                                        {"Content-Type": "application/json", "Origin": "https://vedattatli.github.io"})
        self.assertEqual(status, 200, raw)
        self.assertEqual(json.loads(raw)["heard"], "Kuzey Yazılım deneyiminizi ekledim.")
        self.assertEqual(headers["Access-Control-Allow-Origin"], "https://vedattatli.github.io")

    def test_options_get_bad_json_too_large(self):
        status, headers, raw = _request(self.url, "OPTIONS", headers={"Origin": "http://localhost:8787"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Methods"], "POST, OPTIONS")
        status, _, raw = _request(self.url)
        self.assertEqual(status, 405)
        status, _, raw = _request(self.url, "POST", b"{oops", {"Content-Type": "application/json"})
        self.assertEqual((status, json.loads(raw)["error"]), (400, "bad_request"))
        status, _, raw = _request(self.url, "POST", b"x" * (130 * 1024), {"Content-Type": "application/json"})
        self.assertEqual((status, json.loads(raw)["error"]), (413, "too_large"))

    def test_forwarded_ip_is_rate_limited(self):
        os.environ["CV_RATE_LIMIT"] = "1"
        body = json.dumps(extract_payload()).encode()
        h = {"Content-Type": "application/json", "X-Forwarded-For": "4.4.4.4, 10.0.0.2"}
        self.assertEqual(_request(self.url, "POST", body, h)[0], 200)
        status, headers, _ = _request(self.url, "POST", body, h)
        self.assertEqual(status, 429)
        self.assertIn("Retry-After", headers)
        h["X-Forwarded-For"] = "4.4.4.5"
        self.assertEqual(_request(self.url, "POST", body, h)[0], 200)


# ---------------------------------------------------------------- dev server + mock mode

class MockModeTests(Base):
    def run_mock(self, payload):
        return api.handle(payload, {}, "", model_call=dev_server.mock_model)

    def test_mock_needs_no_key(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ANTHROPIC_API_KEY", None)
            status, body = self.run_mock(extract_payload(cv=None, answer="  Merhaba   ben Ali " + "x" * 200))
        self.assertEqual(status, 200)
        self.assertTrue(body["heard"].startswith("(deneme modu)"))
        self.assertEqual(body["cv"]["jobs"][0]["company"], "Deneme Şirketi")
        self.assertEqual(body["cv"]["jobs"][0]["bullets"][0], ("Merhaba ben Ali " + "x" * 200)[:120])

    def test_mock_sections_by_topic(self):
        where = {
            "about": lambda cv: cv["summary"], "goal": lambda cv: cv["summary"],
            "experience": lambda cv: cv["jobs"][0]["bullets"][-1],
            "education": lambda cv: cv["edu"][0]["note"],
            "projects": lambda cv: cv["projects"][0]["bullets"][0],
            "skills": lambda cv: cv["skills"][-1], "extras": lambda cv: cv["certs"][-1],
            "followup": lambda cv: cv["summary"], "free": lambda cv: cv["summary"],
        }
        for topic, get in where.items():
            status, body = self.run_mock(extract_payload(topic=topic, answer="yeni bilgi " + topic))
            self.assertEqual(status, 200, topic)
            self.assertIn("yeni bilgi " + topic, get(body["cv"]), topic)
            again = self.run_mock(extract_payload(topic=topic, answer="yeni bilgi " + topic))[1]
            self.assertEqual(body, again, "mock must be deterministic")

    def test_mock_other_ops(self):
        cv = schema.normalize_cv(full_cv())
        self.assertEqual(self.run_mock({"op": "review", "cv": cv})[1]["followups"], dev_server.MOCK_FOLLOWUPS)
        self.assertEqual(self.run_mock({"op": "finalize", "cv": cv})[1], {"cv": cv})
        self.assertEqual(self.run_mock({"op": "translate", "cv": cv})[1], {"cv": cv})
        self.assertEqual(self.run_mock({"op": "edit", "cv": cv, "instruction": "x"})[1],
                         {"cv": cv, "reply": "(deneme modu) Değişiklik uygulandı."})

    def test_mock_still_validates(self):
        self.assertEqual(self.run_mock({"op": "extract", "answer": ""})[0], 400)
        self.assertEqual(self.run_mock({"op": "nope"})[0], 400)

    def test_mock_delay_env(self):
        with mock.patch.dict(os.environ, {"CV_MOCK_DELAY": "0.05"}):
            self.assertEqual(dev_server.mock_delay(), 0.05)
        with mock.patch.dict(os.environ, {"CV_MOCK_DELAY": "abc"}):
            self.assertEqual(dev_server.mock_delay(), 1.2)
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CV_MOCK_DELAY", None)
            self.assertEqual(dev_server.mock_delay(), 1.2)


class DevServerTests(Base):
    @classmethod
    def setUpClass(cls):
        cls.server = dev_server.make_server(0, mock=True, quiet=True)
        _serve(cls.server)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_static_files(self):
        status, headers, raw = _request(self.base + "/")
        self.assertEqual(status, 200)
        self.assertIn(b"<html", raw.lower())
        status, headers, _ = _request(self.base + "/manifest.webmanifest")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/manifest+json")
        status, headers, _ = _request(self.base + "/app.js")
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("text/javascript"))

    def test_api_routes(self):
        body = json.dumps(extract_payload(topic="skills", answer="python ve sql biliyorum")).encode()
        status, headers, raw = _request(self.base + "/api/cv", "POST", body, {"Content-Type": "application/json"})
        self.assertEqual(status, 200, raw)
        self.assertIn("python ve sql biliyorum", json.loads(raw)["cv"]["skills"])
        status, _, _ = _request(self.base + "/api/cv?x=1", "OPTIONS", headers={"Origin": "http://localhost:8787"})
        self.assertEqual(status, 204)
        self.assertEqual(_request(self.base + "/api/cv")[0], 405)
        self.assertEqual(_request(self.base + "/api/other", "POST", b"{}")[0], 404)


# ---------------------------------------------------------------- adversarial review regressions

class CorsHardeningTests(unittest.TestCase):
    def test_trailing_newline_is_not_echoed(self):
        # `re.match(...$)` also matches before a trailing "\n": the origin would be echoed verbatim
        # (with the newline) into a response header.
        for origin in ("https://evil.vercel.app\n", "http://localhost:8787\n", "https://vedattatli.github.io\n",
                       "http://127.0.0.1:3000\r\n"):
            self.assertEqual(api.cors_headers(origin), {}, repr(origin))
            self.assertEqual(api.cors_headers(origin, preflight=True), {}, repr(origin))

    def test_lookalikes_rejected(self):
        for origin in ("https://evil-vercel.app.attacker.com", "https://a.b.vercel.app.evil.com",
                       "https://-x.vercel.app", "https://x-.vercel.app", "https://x.vercel.app:443.evil.com",
                       "https://x.vercel.app/", "https://x.vercel.app@evil.com", "https://VEDATTATLI.github.io.x"):
            self.assertEqual(api.cors_headers(origin), {}, origin)


class UnicodeRobustnessTests(Base):
    """Lone UTF-16 surrogates are legal in JSON text ("\\ud800") and JS strings, but cannot be encoded
    as UTF-8: they used to crash the request (500) or the response encoding."""

    LONE = "\ud800"

    def test_lone_surrogates_in_every_text_field(self):
        client = ok_client()
        payload = extract_payload(
            answer=f"kuzey yazılım {self.LONE} çalıştım", question=f"Soru {self.LONE}?",
            cv=full_cv(name=f"Ayşe {self.LONE}", skills=[f"Py{self.LONE}thon"]),
            github=[{"name": f"repo{self.LONE}", "readme": f"r{self.LONE}"}])
        raw = json.dumps(payload).encode("ascii")  # \ud800 escapes, exactly what JSON.stringify sends
        status, _, out = api.handle_http("POST", JSON_CT, raw, "1.1.1.1", client=client)
        self.assertEqual(status, 200, out)
        sent = client.calls[0]["messages"][0]["content"]
        sent.encode("utf-8")  # must not raise: the SDK has to serialise this
        self.assertIn("�", sent)
        out.decode("utf-8")

    def test_lone_surrogate_in_edit_instruction(self):
        client = ok_client("edit")
        raw = json.dumps({"op": "edit", "cv": full_cv(), "instruction": f"telefonu {self.LONE} değiştir"}).encode()
        status, _, out = api.handle_http("POST", JSON_CT, raw, "1.1.1.1", client=client)
        self.assertEqual(status, 200, out)
        client.calls[0]["messages"][0]["content"].encode("utf-8")

    def test_lone_surrogate_in_model_output(self):
        client = FakeClient(resp(content=[text(json.dumps({"cv": full_cv(name="A\ud800"), "heard": "x\udfff"}))]))
        status, _, out = api.handle_http("POST", JSON_CT, json.dumps(extract_payload()).encode(), "1.1.1.1",
                                         client=client)
        self.assertEqual(status, 200, out)
        data = json.loads(out.decode("utf-8"))
        self.assertEqual(data["cv"]["name"], "A�")

    def test_mock_mode_echo_with_surrogate(self):
        raw = json.dumps(extract_payload(answer=f"merhaba {self.LONE}")).encode()
        status, _, out = api.handle_http("POST", JSON_CT, raw, "1.1.1.1", model_call=dev_server.mock_model)
        self.assertEqual(status, 200, out)
        out.decode("utf-8")


class NumericRobustnessTests(Base):
    def test_odd_levels_never_crash(self):
        levels = [float("inf"), float("-inf"), float("nan"), 1e308, "³", "٣", "9" * 5000, -0.4, 4.5, "", " 2 "]
        cv = schema.normalize_cv({"langs": [{"name": f"L{i}", "level": v} for i, v in enumerate(levels)]})
        got = [lng["level"] for lng in cv["langs"]]
        self.assertEqual(len(got), len(levels))
        for v in got:
            self.assertIsInstance(v, int)
            self.assertTrue(0 <= v <= 5)
        self.assertEqual(got[0], 0)   # inf → not a usable level
        self.assertEqual(got[2], 0)   # nan
        self.assertEqual(got[5], 3)   # Arabic-Indic three is a decimal digit
        self.assertEqual(got[10], 2)

    def test_json_infinity_over_http(self):
        for raw in (b'{"op":"review","cv":{"langs":[{"name":"x","level":Infinity}]}}',
                    b'{"op":"review","cv":{"langs":[{"name":"x","level":1e400}]}}',
                    b'{"op":"review","cv":{"langs":[{"name":"x","level":"' + b"9" * 5000 + b'"}]}}'):
            status, _, out = api.handle_http("POST", JSON_CT, raw, "1.1.1.1", client=ok_client("review"))
            self.assertNotEqual(status, 500, (raw[:60], out))


class ContentTypeTests(Base):
    """Only application/json is accepted, so a cross-site page cannot fire a CORS-"simple" request
    (text/plain, form, or a typeless Blob) at the API without a preflight."""

    def post(self, headers):
        return api.handle_http("POST", headers, json.dumps(extract_payload()).encode(), "1.1.1.1",
                               client=ok_client())

    def test_rejected(self):
        for headers in ({}, {"Content-Type": "text/plain"}, {"Content-Type": "text/plain;charset=UTF-8"},
                        {"Content-Type": "application/x-www-form-urlencoded"},
                        {"Content-Type": "multipart/form-data; boundary=x"},
                        {"Content-Type": "application/jsonp"}):
            status, _, out = self.post(headers)
            self.assertEqual(status, 415, headers)
            data = json.loads(out)
            self.assertEqual(data["error"], "unsupported_media_type")
            self.assertTrue(data["message"])

    def test_accepted(self):
        for ct in ("application/json", "application/json; charset=utf-8", "Application/JSON ;charset=UTF-8"):
            status, _, out = self.post({"Content-Type": ct})
            self.assertEqual(status, 200, (ct, out))

    def test_no_model_call_on_rejection(self):
        client = ok_client()
        api.handle_http("POST", {"Content-Type": "text/plain"}, json.dumps(extract_payload()).encode(),
                        "1.1.1.1", client=client)
        self.assertEqual(client.calls, [])


class AccessCodeHardeningTests(Base):
    def test_env_whitespace_ignored(self):
        os.environ["ACCESS_CODE"] = "  kod-123\n"
        self.assertEqual(api.handle(extract_payload(), {"X-Access-Code": "kod-123"}, "", client=ok_client())[0], 200)
        self.assertEqual(api.handle(extract_payload(), {"X-Access-Code": "kod-12"}, "", client=ok_client())[0], 401)

    def test_whitespace_only_code_means_disabled(self):
        os.environ["ACCESS_CODE"] = "   "
        self.assertEqual(api.handle(extract_payload(), {}, "", client=ok_client())[0], 200)

    def test_utf8_header_bytes_from_http_server(self):
        # http.server decodes header bytes as Latin-1; a UTF-8 code sent by curl arrives as mojibake.
        os.environ["ACCESS_CODE"] = "gizli-kod-ğ"
        wire = "gizli-kod-ğ".encode("utf-8").decode("latin-1")
        self.assertEqual(api.handle(extract_payload(), {"X-Access-Code": wire}, "", client=ok_client())[0], 200)


class RateKeyTests(Base):
    def test_ipv6_grouped_by_64(self):
        self.assertEqual(api.rate_key("2001:db8:1:2:aaaa::1"), api.rate_key("2001:db8:1:2:bbbb::2"))
        self.assertNotEqual(api.rate_key("2001:db8:1:2::1"), api.rate_key("2001:db8:1:3::1"))
        self.assertEqual(api.rate_key("::ffff:1.2.3.4"), "1.2.3.4")
        self.assertEqual(api.rate_key(" 1.2.3.4 "), "1.2.3.4")
        self.assertLessEqual(len(api.rate_key("x" * 5000)), 64)
        self.assertEqual(api.rate_key(""), "unknown")

    def test_rotating_ipv6_suffix_does_not_bypass_limit(self):
        os.environ["CV_RATE_LIMIT"] = "2"
        ips = [f"2001:db8:aa:bb::{i:x}" for i in range(1, 4)]
        statuses = [api.handle(extract_payload(), {}, ip, client=ok_client())[0] for ip in ips]
        self.assertEqual(statuses, [200, 200, 429])


class RetryBudgetTests(Base):
    """The SDK's own retries (3 × 240 s timeouts, or any server Retry-After) can run past Vercel's
    300 s maxDuration; then the platform kills the function and the browser gets a non-JSON 504."""

    def setUp(self):
        super().setUp()
        self.now = [1000.0]
        self.clock_patch = mock.patch.object(api, "_clock", lambda: self.now[0], create=True)
        self.clock_patch.start()
        self.sleeps.clear()
        self.sleep_patch.stop()
        self.sleep_patch = mock.patch.object(api, "_sleep", self._sleep, create=True)
        self.sleep_patch.start()

    def tearDown(self):
        self.clock_patch.stop()
        super().tearDown()

    def _sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now[0] += seconds

    def ok(self):
        return resp({"cv": full_cv(), "heard": "ok"})

    def test_sdk_retries_disabled_and_timeout_passed(self):
        client = FakeClient(self.ok())
        status, _ = api.handle(extract_payload(), {}, "", client=client)
        self.assertEqual(status, 200)
        self.assertIn({"max_retries": 0}, client.options)
        self.assertLessEqual(client.calls[0]["timeout"], api.CLIENT_TIMEOUT)

    def test_slow_timeout_is_not_retried_past_the_deadline(self):
        outcome = SequenceOutcome([anthropic.APITimeoutError(request=_REQ)], clock=self.now, cost=240)
        client = FakeClient(outcome)
        status, body = api.handle(extract_payload(), {}, "", client=client)
        self.assertEqual((status, body["message"]), (502, api.MSG["timeout"]))
        self.assertEqual(len(client.calls), 1)
        self.assertLess(self.now[0] - 1000.0, 300)

    def test_fast_failures_are_retried_then_succeed(self):
        outcome = SequenceOutcome([status_error(anthropic.InternalServerError, 500),
                                   anthropic.APIConnectionError(request=_REQ), self.ok()], clock=self.now, cost=1)
        client = FakeClient(outcome)
        status, body, meta = api.process(extract_payload(), {}, "", client=client)
        self.assertEqual(status, 200, body)
        self.assertEqual(len(client.calls), 3)
        self.assertEqual(len(self.sleeps), 2)
        self.assertEqual(meta.get("retries"), 2)

    def test_retry_count_capped(self):
        client = FakeClient(SequenceOutcome([status_error(anthropic.APIStatusError, 529)], clock=self.now, cost=1))
        status, body = api.handle(extract_payload(), {}, "", client=client)
        self.assertEqual((status, body["error"]), (502, "upstream"))
        self.assertEqual(len(client.calls), 1 + api.CLIENT_MAX_RETRIES)

    def test_long_retry_after_is_not_waited_for(self):
        client = FakeClient(SequenceOutcome([status_error(anthropic.RateLimitError, 429, {"retry-after": "3600"})]))
        status, body = api.handle(extract_payload(), {}, "", client=client)
        self.assertEqual((status, body["error"]), (429, "rate_limited"))
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(self.sleeps, [])
        self.assertEqual(body["retryAfter"], 600)

    def test_short_retry_after_is_honoured(self):
        client = FakeClient(SequenceOutcome([status_error(anthropic.RateLimitError, 429, {"retry-after": "3"}),
                                             self.ok()]))
        status, _ = api.handle(extract_payload(), {}, "", client=client)
        self.assertEqual(status, 200)
        self.assertEqual(self.sleeps, [3.0])

    def test_non_retryable_errors(self):
        for exc in (status_error(anthropic.BadRequestError, 400), status_error(anthropic.AuthenticationError, 401),
                    status_error(anthropic.NotFoundError, 404),
                    status_error(anthropic.InternalServerError, 500, {"x-should-retry": "false"})):
            client = FakeClient(exc)
            api.handle(extract_payload(), {}, "", client=client)
            self.assertEqual(len(client.calls), 1, type(exc).__name__)

    def test_attempt_timeout_shrinks_with_remaining_budget(self):
        outcome = SequenceOutcome([status_error(anthropic.InternalServerError, 500), self.ok()],
                                  clock=self.now, cost=100)
        client = FakeClient(outcome)
        status, _ = api.handle(extract_payload(), {}, "", client=client)
        self.assertEqual(status, 200)
        first, second = client.calls[0]["timeout"], client.calls[1]["timeout"]
        self.assertEqual(first, api.CLIENT_TIMEOUT)
        self.assertLessEqual(second, api.DEADLINE - 100)
        self.assertGreaterEqual(second, api.MIN_ATTEMPT)

    def test_worst_case_total_fits_vercel_max_duration(self):
        with open(os.path.join(ROOT, "vercel.json"), encoding="utf-8") as f:
            max_duration = json.load(f)["functions"]["api/cv.py"]["maxDuration"]
        self.assertLess(api.DEADLINE, max_duration)
        # every attempt is a 1-second failure followed by the longest allowed wait
        outcome = SequenceOutcome([status_error(anthropic.RateLimitError, 429,
                                                {"retry-after": str(int(api.MAX_RETRY_WAIT))})],
                                  clock=self.now, cost=1)
        api.handle(extract_payload(), {}, "", client=FakeClient(outcome))
        self.assertLess(self.now[0] - 1000.0, max_duration)


class StopReasonTests(Base):
    def test_context_window_exceeded_is_a_clean_502(self):
        truncated = resp(content=[text('{"cv": {"na')], stop_reason="model_context_window_exceeded")
        status, body = api.handle(extract_payload(), {}, "", client=FakeClient(truncated))
        self.assertEqual((status, body["error"], body["message"]), (502, "upstream", api.MSG["max_tokens"]))


class HandlerRobustnessTests(Base):
    """Both HTTP adapters (Vercel `handler` and the dev server) must always answer with JSON."""

    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer
        cls.vercel = ThreadingHTTPServer(("127.0.0.1", 0), api.handler)
        _serve(cls.vercel)
        cls.dev = dev_server.make_server(0, mock=True, quiet=True)
        _serve(cls.dev)
        cls.urls = [f"http://127.0.0.1:{s.server_address[1]}/api/cv" for s in (cls.vercel, cls.dev)]

    @classmethod
    def tearDownClass(cls):
        for s in (cls.vercel, cls.dev):
            s.shutdown()
            s.server_close()

    def test_internal_crash_still_returns_json_with_cors(self):
        h = dict(JSON_CT, Origin="http://localhost:8787")
        with mock.patch.object(api, "handle_http", side_effect=RuntimeError("boom")):
            for url in self.urls:
                status, headers, raw = _request(url, "POST", b"{}", h)
                self.assertEqual(status, 500, url)
                self.assertEqual(json.loads(raw)["error"], "internal")
                self.assertEqual(headers["Access-Control-Allow-Origin"], "http://localhost:8787", url)

    def test_dev_server_surrogate_answer(self):
        raw = json.dumps(extract_payload(answer="merhaba \ud800")).encode()
        status, _, out = _request(self.urls[1], "POST", raw, JSON_CT)
        self.assertEqual(status, 200, out)





# ---------------------------------------------------------------- v2: ping, profile, evidence, tailor, cover

def tailor_payload(**over):
    p = {"op": "tailor", "cv": full_cv(), "lang": "tr", "profile": "yazilim",
         "ad": "Kuzey Lojistik A.Ş. İzmir ofisi için Python ve SQL bilen Yazılım Geliştirici arıyoruz."}
    p.update(over)
    return p


LETTER = {"recipient": ["Kuzey Lojistik A.Ş.", "İnsan Kaynakları", "İzmir"],
          "subject": "Konu: Yazılım Geliştirici pozisyonu başvurusu", "greeting": "Sayın İlgili,",
          "paragraphs": ["Birinci.", "İkinci.", "Üçüncü."], "closing": "Saygılarımla,"}


class PingTests(Base):
    def test_ping_needs_no_model_and_reports_configuration(self):
        client = ok_client()
        status, body = api.handle({"op": "ping"}, {}, "1.1.1.1", client=client)
        self.assertEqual((status, body), (200, {"ok": True, "configured": True}))
        self.assertEqual(client.calls, [])
        with mock.patch.object(api, "has_credentials", return_value=False):
            status, body = api.handle({"op": "ping"}, {}, "1.1.1.1")
        self.assertEqual((status, body), (200, {"ok": True, "configured": False}))
        status, body = api.handle({"op": "ping"}, {}, "1.1.1.1", model_call=dev_server.mock_model)
        self.assertEqual(body["configured"], True)

    def test_ping_checks_access_code_and_rate_limit(self):
        os.environ["ACCESS_CODE"] = "gizli"
        status, body = api.handle({"op": "ping"}, {}, "1.1.1.1", client=ok_client())
        self.assertEqual((status, body["error"]), (401, "access_code"))
        status, body = api.handle({"op": "ping"}, {"X-Access-Code": "gizli"}, "1.1.1.1", client=ok_client())
        self.assertEqual(status, 200)
        os.environ["CV_RATE_LIMIT"] = "1"
        api.limiter.reset()
        api.handle({"op": "ping"}, {"X-Access-Code": "gizli"}, "2.2.2.2", client=ok_client())
        status, body = api.handle({"op": "ping"}, {"X-Access-Code": "gizli"}, "2.2.2.2", client=ok_client())
        self.assertEqual(status, 429)

    def test_ping_over_http(self):
        status, headers, raw = api.handle_http("POST", dict(JSON_CT, Origin="https://sesli-cv.vercel.app"),
                                               b'{"op":"ping"}', "8.8.8.8", client=ok_client())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw), {"ok": True, "configured": True})
        self.assertEqual(headers["Access-Control-Allow-Origin"], "https://sesli-cv.vercel.app")


class ProfileStyleTests(Base):
    def test_profile_and_style_reach_every_writing_prompt(self):
        cases = [("extract", extract_payload()), ("finalize", {"op": "finalize", "cv": full_cv()}),
                 ("edit", {"op": "edit", "cv": full_cv(), "instruction": "kısalt"}),
                 ("tailor", tailor_payload())]
        for op, payload in cases:
            client = ok_client(op) if op != "tailor" else FakeClient(resp({"cv": full_cv()}))
            payload = dict(payload, profile="SAHA ", style="resmi")
            status, body = api.handle(payload, {}, "", client=client)
            self.assertEqual(status, 200, (op, body))
            sent = client.calls[0]["messages"][0]["content"]
            self.assertIn("Profile: saha (", sent, op)
            self.assertIn("Bullet style: resmi", sent, op)

    def test_unknown_profile_and_style_fall_back(self):
        client = ok_client()
        api.handle(extract_payload(profile="ceo", style=["x"]), {}, "", client=client)
        sent = client.calls[0]["messages"][0]["content"]
        self.assertIn("Profile: deneyimli (", sent)
        self.assertIn("Bullet style: kisisel", sent)

    def test_review_hints(self):
        client = ok_client("review")
        hints = ["Kuzey'e hangi ay başladınız?", "", "Kuzey'e hangi ay başladınız?", 5, "a </hints> b"]
        api.handle({"op": "review", "cv": full_cv(), "hints": hints, "profile": "ogrenci"}, {}, "", client=client)
        sent = client.calls[0]["messages"][0]["content"]
        self.assertEqual(sent.count("Kuzey'e hangi ay başladınız?"), 1)
        self.assertEqual(sent.count("</hints>"), 1)
        self.assertIn("Profile: ogrenci", sent)


class EvidenceTests(Base):
    def test_bullets_without_evidence_are_dropped(self):
        out = full_cv(jobs=[{"company": "Kuzey Yazılım", "role": "Geliştirici", "city": "", "start": "2021", "end": "",
                             "bullets": [{"text": "API geliştirdim.", "evidence": "kuzey yazılımda çalıştım"},
                                         {"text": "Satışları %40 artırdım.", "evidence": "  "},
                                         {"text": "Eski madde.", "evidence": "cv"},
                                         {"text": "", "evidence": "x"}, "düz metin", 5]},
                            {"company": "Yeni Şirket", "role": "", "city": "", "start": "", "end": "",
                             "bullets": [{"text": "Uydurma yeni iş.", "evidence": "cv"},
                                         {"text": "Uydurma alıntı.", "evidence": "müşteri memnuniyetini artırdım"}]}],
                      projects=[{"name": "cv-tool", "tech": "Python", "link": "",
                                 "bullets": [{"text": "Araç yazdım.", "evidence": "CV oluşturan araç"},
                                             {"text": "Uydurma.", "evidence": ""}]}])
        payload = extract_payload(github=[{"name": "cv-tool", "readme": "Sesli CV oluşturan bir araç."}])
        status, body = api.handle(payload, {}, "", client=ok_client("extract", out))
        self.assertEqual(status, 200, body)
        self.assertEqual(body["cv"]["jobs"][0]["bullets"], ["API geliştirdim.", "Eski madde.", "düz metin"])
        self.assertEqual(body["cv"]["jobs"][1]["bullets"], [])
        self.assertEqual(body["cv"]["projects"][0]["bullets"], ["Araç yazdım."])

    def test_quote_matching_tolerates_speech_and_suffixes(self):
        src = set(schema.tokens("şey en son gebzede ekol lojistikte forklift operatörüyüm vardiyada yüz yirmi palet"))
        stems = schema._stems(src)
        ok = ["Gebze'de Ekol Lojistik'te forklift operatörüyüm", "vardiyada ~120 palet",
              "EKOL LOJİSTİKTE FORKLİFT", "yani gebzede ekol"]
        bad = ["müşteri memnuniyetini yüzde kırk artırdım", "", "120", "takım liderliği yaptım gebzede"]
        for q in ok:
            self.assertTrue(schema.quote_supported(q, src, stems), q)
        for q in bad:
            self.assertFalse(schema.quote_supported(q, src, stems), q)

    def test_evidence_counts_logged_without_content(self):
        out = full_cv(jobs=[{"company": "Kuzey Yazılım", "role": "", "city": "", "start": "", "end": "",
                             "bullets": [{"text": "A.", "evidence": "kuzey yazılımda"},
                                         {"text": "B.", "evidence": "uydurma alıntı burada"}]}])
        buf = io.StringIO()
        with mock.patch.dict(os.environ, {"CV_LOG": "1"}), redirect_stdout(buf):
            api.handle(extract_payload(), {}, "", client=ok_client("extract", out))
        line = json.loads(buf.getvalue().strip().splitlines()[-1])
        self.assertEqual((line["ev_checked"], line["ev_dropped"]), (2, 1))
        self.assertNotIn("uydurma", buf.getvalue())

    def test_missing_and_confirm_are_cleaned(self):
        client = ok_client("extract", missing=[" Ne zaman? ", "", "Ne zaman?", "b", "c", "d", 7],
                           confirm=["Kuzey Lojistik", "x" * 200, None])
        status, body = api.handle(extract_payload(), {}, "", client=client)
        self.assertEqual(body["missing"], ["Ne zaman?", "b", "c"])
        self.assertEqual(body["confirm"], ["Kuzey Lojistik", "x" * 80])
        status, body = api.handle(extract_payload(), {}, "", client=ok_client("extract"))
        self.assertEqual((body["missing"], body["confirm"]), ([], []))


class SchemaV2Tests(unittest.TestCase):
    def test_langs_cefr_and_exam(self):
        cv = schema.normalize_cv({"langs": [
            {"name": "İngilizce", "level": 4, "cefr": " c1 ", "exam": "IELTS 7.0 (2024)"},
            {"name": "Almanca", "level": 1, "cefr": "D9", "exam": 5},
            {"name": "Fransızca", "level": 2}]})
        self.assertEqual(cv["langs"], [
            {"name": "İngilizce", "level": 4, "cefr": "C1", "exam": "IELTS 7.0 (2024)"},
            {"name": "Almanca", "level": 1, "cefr": "", "exam": ""},
            {"name": "Fransızca", "level": 2, "cefr": "", "exam": ""}])

    def test_skill_groups(self):
        cv = schema.normalize_cv({"skillGroups": [
            {"name": "Diller", "items": ["Python", " python ", "Go", ""]},
            {"name": "Boş", "items": []}, "x", {"name": "Araçlar", "items": "Docker"},
        ] + [{"name": f"G{i}", "items": ["a"]} for i in range(10)]})
        self.assertEqual(cv["skillGroups"][0], {"name": "Diller", "items": ["Python", "Go"]})
        self.assertEqual(cv["skillGroups"][1], {"name": "Araçlar", "items": ["Docker"]})
        self.assertEqual(len(cv["skillGroups"]), 6)
        self.assertEqual(schema.normalize_cv({})["skillGroups"], [])

    def test_letter(self):
        self.assertIsNone(schema.normalize_letter(None))
        self.assertIsNone(schema.normalize_letter(dict(LETTER, paragraphs=[])))
        out = schema.normalize_letter(dict(LETTER, recipient=["a", "b", "c", "d"], paragraphs=["p"] * 7))
        self.assertEqual(len(out["recipient"]), 3)
        self.assertEqual(len(out["paragraphs"]), 5)

    def test_tailor_lists(self):
        out = schema.normalize_tailor({
            "company": "Kuzey", "role": "Geliştirici",
            "matched": [{"term": "Python", "where": "Yetenekler"}, {"term": "python", "where": "x"},
                        {"term": "", "where": "y"}, "bad"],
            "missing": [{"term": "SQL", "question": "Kullandınız mı?"}],
            "changes": ["a", "a", ""]})
        self.assertEqual(out["matched"], [{"term": "Python", "where": "Yetenekler"}])
        self.assertEqual(out["missing"], [{"term": "SQL", "question": "Kullandınız mı?"}])
        self.assertEqual(out["changes"], ["a"])
        self.assertEqual(schema.normalize_tailor({}), {"company": "", "role": "", "matched": [],
                                                       "missing": [], "changes": []})


class MergeTailoredTests(unittest.TestCase):
    def base(self):
        return schema.normalize_cv(full_cv(
            summary="Eski profil.", skills=["Excel", "SAP", "Python"],
            skillGroups=[{"name": "Diller", "items": ["Python", "Go"]},
                         {"name": "Araçlar", "items": ["Docker", "Git"]}],
            jobs=[{"company": "A", "role": "R", "bullets": ["a1", "a2", "a3"]},
                  {"company": "B", "role": "R", "bullets": ["b1"]}],
            projects=[{"name": "P", "bullets": ["p1", "p2"]}]))

    def test_reorders_but_never_adds(self):
        cv = self.base()
        out = schema.merge_tailored(cv, {
            "summary": "Yeni.", "skills": ["python", "Kubernetes", "SAP"],
            "skillGroups": [{"name": "Araçlar", "items": ["Git", "Terraform"]}, {"name": "Uydurma", "items": ["X"]}],
            "jobs": [{"bullets": ["a3", "a1", "a2"]}, {"bullets": []}],
            "projects": [{"bullets": ["p2", "p1"]}]})
        self.assertEqual(out["summary"], "Yeni.")
        self.assertEqual(out["skills"], ["Python", "SAP", "Excel"])
        self.assertEqual(out["skillGroups"], [{"name": "Araçlar", "items": ["Git", "Docker"]},
                                              {"name": "Diller", "items": ["Python", "Go"]}])
        self.assertEqual(out["jobs"][0]["bullets"], ["a3", "a1", "a2"])
        self.assertEqual(out["jobs"][1]["bullets"], ["b1"])  # empty answer keeps the original
        self.assertEqual(out["jobs"][0]["company"], "A")
        self.assertEqual(out["projects"][0]["bullets"], ["p2", "p1"])
        self.assertEqual(out["email"], cv["email"])
        self.assertEqual(cv["summary"], "Eski profil.")  # input not mutated

    def test_garbage_keeps_everything(self):
        cv = self.base()
        for data in ({}, {"summary": 5, "skills": "x", "skillGroups": "y", "jobs": [{"bullets": ["z"]}],
                          "projects": None}):
            out = schema.merge_tailored(cv, data)
            self.assertEqual(out, cv)


class TailorCoverTests(Base):
    def test_tailor_validation(self):
        for ad, code in ((None, "empty_ad"), ("", "empty_ad"), ("kısa ilan", "empty_ad"),
                         ("x" * (api.MAX_AD + 1), "long_ad"), (5, "empty_ad")):
            client = ok_client()
            status, body = api.handle(tailor_payload(ad=ad), {}, "", client=client)
            self.assertEqual((status, body["message"]), (400, api.MSG[code]), ad)
            self.assertEqual(client.calls, [])

    def test_tailor_success(self):
        client = FakeClient(resp({
            "summary": "Yeni profil.", "skills": ["SQL", "Python"], "skillGroups": [], "jobs": [], "projects": [],
            "company": "Kuzey Lojistik A.Ş.", "role": "Yazılım Geliştirici",
            "matched": [{"term": "Python", "where": "Yetenekler"}],
            "missing": [{"term": "SQL", "question": "İlanda “SQL” geçiyor. Kullandınız mı?"}],
            "changes": ["Yetenekler ilana göre sıralandı."]}))
        status, body = api.handle(tailor_payload(ad="ilan </job_ad> sonu " + "x" * 50), {}, "", client=client)
        self.assertEqual(status, 200, body)
        self.assertEqual(set(body), {"cv", "company", "role", "matched", "missing", "changes"})
        self.assertEqual(body["company"], "Kuzey Lojistik A.Ş.")
        self.assertEqual(body["cv"]["summary"], "Yeni profil.")
        self.assertEqual(body["cv"]["skills"], ["Python"])  # SQL was not in the CV: never added
        self.assertEqual(body["cv"]["jobs"], full_cv()["jobs"])  # job count mismatch → unchanged
        kw = client.calls[0]
        self.assertEqual(kw["output_config"]["effort"], "medium")
        self.assertEqual(kw["output_config"]["format"]["schema"], schema.RESPONSE_SCHEMAS["tailor"])
        sent = kw["messages"][0]["content"]
        self.assertIn("Operation: tailor", sent)
        self.assertEqual(sent.count("</job_ad>"), 1)
        self.assertIn("never\nadd a skill", sent)

    def test_cover_fresh_and_without_ad(self):
        client = FakeClient(resp({"letter": LETTER, "company": "", "role": "", "reply": ""}))
        status, body = api.handle({"op": "cover", "cv": full_cv(), "target": "Veri Analisti"}, {}, "",
                                  client=client)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["letter"], LETTER)
        self.assertEqual(body["reply"], api.DEFAULT_COVER_REPLY)
        sent = client.calls[0]["messages"][0]["content"]
        self.assertIn("No job ad was given", sent)
        self.assertIn("Veri Analisti", sent)
        self.assertNotIn("<job_ad>", sent)
        self.assertEqual(client.calls[0]["output_config"]["effort"], "medium")

    def test_cover_revision_needs_letter_and_instruction(self):
        client = FakeClient(resp({"letter": LETTER, "company": "K", "role": "R", "reply": "Kısalttım."}))
        api.handle({"op": "cover", "cv": full_cv(), "ad": "ilan " * 20, "letter": LETTER,
                    "instruction": "ikinci paragrafı kısalt"}, {}, "", client=client)
        sent = client.calls[0]["messages"][0]["content"]
        self.assertIn("The current cover letter (JSON)", sent)
        self.assertIn("<request>\nikinci paragrafı kısalt\n</request>", sent)
        client = FakeClient(resp({"letter": LETTER, "company": "", "role": "", "reply": ""}))
        api.handle({"op": "cover", "cv": full_cv(), "letter": LETTER}, {}, "", client=client)
        self.assertNotIn("The current cover letter", client.calls[0]["messages"][0]["content"])
        status, body = api.handle({"op": "cover", "cv": full_cv(), "letter": LETTER,
                                   "instruction": "x" * 3000}, {}, "", client=ok_client())
        self.assertEqual(status, 400)

    def test_cover_without_letter_in_output_is_502(self):
        for bad in ({"letter": None}, {"letter": dict(LETTER, paragraphs=[])}, {}):
            status, body = api.handle({"op": "cover", "cv": full_cv()}, {}, "", client=FakeClient(resp(bad)))
            self.assertEqual((status, body["error"]), (502, "upstream"))

    def test_mock_mode_new_ops(self):
        status, body = api.handle(tailor_payload(), {}, "", model_call=dev_server.mock_model)
        self.assertEqual(status, 200, body)
        self.assertTrue(body["missing"])
        status, body = api.handle({"op": "cover", "cv": full_cv()}, {}, "", model_call=dev_server.mock_model)
        self.assertEqual(status, 200, body)
        self.assertEqual(len(body["letter"]["paragraphs"]), 3)
        status, body = api.handle(extract_payload(), {}, "", model_call=dev_server.mock_model)
        self.assertEqual(body["missing"], ["(deneme modu) Hangi ay ve yılda başladınız?"])


if __name__ == "__main__":
    unittest.main()
