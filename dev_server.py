#!/usr/bin/env python3
"""Local development server for Sesli CV.

Serves public/ as static files and routes POST/OPTIONS /api/cv to the same code the Vercel
function runs (api/cv.py: handle_http -> handle).

    # real Claude calls (key stays in the environment, never printed):
    set -a; . ./.env.local; set +a; ./.venv/bin/python dev_server.py

    # deterministic offline mock, no API key needed:
    CV_MOCK=1 ./.venv/bin/python dev_server.py

Env: PORT (default 8787), CV_MOCK=1, CV_MOCK_DELAY seconds (default 1.2), ACCESS_CODE,
CV_RATE_LIMIT (requests per IP per 10 min; default 30, or 0 = off in mock mode).
Binds to 127.0.0.1 only.
"""

import copy
import os
import sys
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
sys.path.insert(0, os.path.join(ROOT, "api"))

import cv as api  # noqa: E402  (api/cv.py)

API_PATH = "/api/cv"

# ---------------------------------------------------------------- mock mode

MOCK_SECTION_LABEL = {
    "summary": "özet",
    "jobs": "iş deneyimi",
    "edu": "eğitim",
    "projects": "projeler",
    "skills": "yetenekler",
    "certs": "sertifikalar",
}
MOCK_TOPIC_SECTION = {
    "about": "summary",
    "goal": "summary",
    "experience": "jobs",
    "education": "edu",
    "projects": "projects",
    "skills": "skills",
    "extras": "certs",
    "followup": "summary",
    "free": "summary",
}
MOCK_FOLLOWUPS = [
    "(deneme modu) Son işinize hangi ay ve yılda başladınız?",
    "(deneme modu) Size ulaşılabilecek bir e-posta adresi söyler misiniz?",
]


def mock_delay():
    try:
        return max(0.0, float(os.environ.get("CV_MOCK_DELAY", "1.2")))
    except ValueError:
        return 1.2


def mock_model(op, req):
    """Deterministic stand-in for Claude: returns the raw shape the model would return."""
    time.sleep(mock_delay())
    cv = copy.deepcopy(req["cv"])
    if op == "review":
        return {"followups": list(MOCK_FOLLOWUPS)}
    if op == "edit":
        return {"cv": cv, "reply": "(deneme modu) Değişiklik uygulandı."}
    if op in ("finalize", "translate"):
        return {"cv": cv}
    if op == "tailor":
        return {"cv": cv, "company": "Deneme Lojistik A.Ş.", "role": "Deneme Pozisyonu",
                "matched": [{"term": "Excel", "where": "Yetenekler"}],
                "missing": [{"term": "SQL", "question": "İlanda “SQL” geçiyor. Kullandınız mı? Nerede?"}],
                "changes": ["(deneme modu) Yetenekler ilana göre sıralandı."]}
    if op == "cover":
        return {"letter": {"recipient": ["Deneme Lojistik A.Ş.", "İnsan Kaynakları"],
                           "subject": "Konu: Deneme Pozisyonu başvurusu", "greeting": "Sayın İlgili,",
                           "paragraphs": ["(deneme modu) Birinci paragraf.", "İkinci paragraf.",
                                          "Üçüncü paragraf."],
                           "closing": "Saygılarımla,"},
                "company": "Deneme Lojistik A.Ş.", "role": "Deneme Pozisyonu",
                "reply": "(deneme modu) Ön yazınız hazır."}
    # extract
    snippet = " ".join(req.get("answer", "").split())[:120]
    if not snippet and req.get("github"):
        snippet = "GitHub: " + req["github"][0]["name"]
    section = MOCK_TOPIC_SECTION.get(req.get("topic"), "summary")
    if section == "summary":
        cv["summary"] = (cv["summary"] + " " + snippet).strip()
    elif section == "jobs":
        if not cv["jobs"]:
            cv["jobs"].append({"company": "Deneme Şirketi", "role": "", "city": "", "start": "",
                               "end": "", "bullets": []})
        cv["jobs"][0]["bullets"].append(snippet)
    elif section == "edu":
        cv["edu"].insert(0, {"school": "Deneme Okulu", "program": "", "degree": "", "start": "",
                             "end": "", "note": snippet})
    elif section == "projects":
        cv["projects"].insert(0, {"name": "Deneme Projesi", "tech": "", "link": "",
                                  "bullets": [snippet]})
    else:
        cv[section].append(snippet)
    label = MOCK_SECTION_LABEL[section]
    return {"cv": cv, "heard": f"(deneme modu) Söylediklerinizi {label} bölümüne ekledim.",
            "missing": ["(deneme modu) Hangi ay ve yılda başladınız?"], "confirm": []}


# ---------------------------------------------------------------- HTTP

class DevHandler(SimpleHTTPRequestHandler):
    server_version = "SesliCVDev"
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".js": "text/javascript",
    }
    model_call = None  # set by make_server

    def _is_api(self):
        return urlsplit(self.path).path.rstrip("/") == API_PATH

    def _api(self, method):
        # Same adapter as the Vercel function (size guard, JSON-only, last-resort 500 as JSON).
        api.serve(self, method, model_call=type(self).model_call)

    def end_headers(self):
        if not self._is_api():
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self._is_api():
            return self._api("POST")
        self.send_error(404)

    def do_OPTIONS(self):
        if self._is_api():
            return self._api("OPTIONS")
        self.send_error(404)

    def do_GET(self):
        if self._is_api():
            return self._api("GET")
        super().do_GET()

    def do_HEAD(self):
        if self._is_api():
            return self._api("HEAD")
        super().do_HEAD()


def make_server(port=8787, host="127.0.0.1", mock=False, quiet=False):
    attrs = {"model_call": staticmethod(mock_model) if mock else None}
    if quiet:
        attrs["log_message"] = lambda self, *args: None
    handler_cls = type("BoundDevHandler", (DevHandler,), attrs)
    return ThreadingHTTPServer((host, port), partial(handler_cls, directory=PUBLIC))


def main():
    mock = os.environ.get("CV_MOCK") == "1"
    if mock:
        os.environ.setdefault("CV_RATE_LIMIT", "0")
    try:
        port = int(os.environ.get("PORT", "8787"))
    except ValueError:
        port = 8787
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        port = int(sys.argv[1])
    server = make_server(port, mock=mock)
    mode = "deneme modu (CV_MOCK=1)" if mock else (
        "gerçek yapay zekâ" if api.has_credentials() else "ANTHROPIC_API_KEY yok → /api/cv 503 döner")
    print(f"Sesli CV: http://127.0.0.1:{port}/  [{mode}]", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
