#!/usr/bin/env python3
"""Manual check against the REAL Claude API (costs credit — run rarely).

Runs ONE `extract` on a realistic, messy Turkish spoken answer (two jobs, dates with a
self-correction, achievements, a dictated e-mail correction) and ONE `finalize` on the result,
through the same pipeline the HTTP function uses (validation → prompt → Claude → normalisation).
Prints latency, token usage and the resulting JSON, plus a few automatic fact checks.

    set -a; . ./.env.local; set +a
    ./.venv/bin/python tests/live_api_check.py            # extract + finalize (2 calls)
    ./.venv/bin/python tests/live_api_check.py extract    # extract only (1 call)

The API key is read from the environment by the SDK and is never printed.
"""

import json
import os
import re
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "api"))

import cv as api  # noqa: E402

START_CV = {
    "name": "Mehmet Yılmaz",
    "title": "Yazılım Geliştirici",
    "phone": "0532 123 45 67",
    "email": "mehmet.yilmaz@hotmail.com",
    "city": "İstanbul",
}

QUESTION = ("İş deneyiminizi anlatır mısınız? Hangi şirketlerde, hangi görevde, hangi tarihler arasında "
            "çalıştınız ve neler yaptınız?")

ANSWER = (
    "evet şimdi şöyle anlatayım en son kuzey yazılımda çalışıyorum istanbulda kıdemli yazılım geliştirici "
    "olarak 2021 martında başladım hala oradayım orada ödeme altyapısını baştan yazdık pay ton ve jango ile "
    "ee işlem süresini yüzde kırk azalttık bir de dört kişilik bir ekibi yönetiyorum yeni gelen arkadaşlara "
    "mentorluk yapıyorum kod incelemelerini de ben yürütüyorum ondan önce ankarada deniz teknoloji a ş diye "
    "bir firmada yazılım geliştiriciydim 2018 de başladım yok yok 2017 eylülde başladım 2021 şubatına kadar "
    "kaldım orada müşteri portalını reakt ile geliştirdim günde yirmi bin kişi kullanıyordu bir de birim test "
    "kapsamını yüzde otuzdan yüzde seksene çıkardım ha bu arada mail adresimi yanlış söylemişim doğrusu "
    "mehmet nokta yılmaz et gmail nokta com"
)

# Numbers the person actually said (anything else in bullets/summary needs a human look).
SPOKEN_NUMBERS = {"2017", "2018", "2021", "40", "4", "20", "20.000", "20000", "30", "80", "0532", "123", "45", "67"}


def run(op, payload, client):
    t0 = time.monotonic()
    status, body, meta = api.process(payload, {}, "live-check", client=client)
    wall = time.monotonic() - t0
    print(f"\n=== {op}: HTTP {status}  wall {wall:.1f}s  model {meta.get('model_ms', 0) / 1000:.1f}s")
    print("usage:", json.dumps({k: meta.get(k) for k in ("model", "stop", "in", "out", "cache_read",
                                                          "cache_write", "fallback", "err", "detail")
                                if meta.get(k) is not None}, ensure_ascii=False))
    print(json.dumps(body, ensure_ascii=False, indent=2))
    return status, body


def check(label, ok):
    print(f"  [{'OK ' if ok else 'BAD'}] {label}")
    return ok


def fact_checks(cv, heard=None):
    print("\n--- automatic checks")
    jobs = cv["jobs"]
    check("2 jobs", len(jobs) == 2)
    if len(jobs) >= 2:
        j0, j1 = jobs[0], jobs[1]
        check(f"job0 company Kuzey Yazılım ({j0['company']!r})", "kuzey" in j0["company"].lower())
        check(f"job0 dates Mart 2021 – Devam ediyor ({j0['start']!r} – {j0['end']!r})",
              j0["start"] == "Mart 2021" and j0["end"] == "Devam ediyor")
        check(f"job0 city İstanbul ({j0['city']!r})", j0["city"] == "İstanbul")
        check(f"job1 company Deniz Teknoloji A.Ş. ({j1['company']!r})", j1["company"] == "Deniz Teknoloji A.Ş.")
        check(f"job1 dates Eylül 2017 – Şubat 2021 ({j1['start']!r} – {j1['end']!r})",
              j1["start"] == "Eylül 2017" and j1["end"] == "Şubat 2021")
        check(f"job1 city Ankara ({j1['city']!r})", j1["city"] == "Ankara")
        for j in jobs:
            check(f"{j['company']}: {len(j['bullets'])} bullets (2–6)", 2 <= len(j["bullets"]) <= 6)
            for b in j["bullets"]:
                words = len(b.split())
                if words > 22:
                    check(f"bullet too long ({words} words): {b}", False)
    check(f"email corrected ({cv['email']!r})", cv["email"] == "mehmet.yilmaz@gmail.com")
    check(f"phone kept ({cv['phone']!r})", cv["phone"] == "0532 123 45 67")
    check(f"name kept ({cv['name']!r})", cv["name"] == "Mehmet Yılmaz")
    skills = {s.lower() for s in cv["skills"]}
    check(f"skills include Python/Django/React ({cv['skills']})", {"python", "django", "react"} <= skills)
    text = " ".join([cv["summary"]] + [b for j in jobs for b in j["bullets"]])
    numbers = set(re.findall(r"\d+(?:\.\d+)?", text))
    unexpected = sorted(numbers - SPOKEN_NUMBERS)
    check(f"numbers in bullets/summary all spoken (unexpected: {unexpected})", not unexpected)
    if heard is not None:
        check(f"heard names both companies: {heard!r}", "Kuzey" in heard and "Deniz" in heard)


def main():
    ops = sys.argv[1:] or ["extract", "finalize"]
    if not api.has_credentials():
        sys.exit("ANTHROPIC_API_KEY yok. Önce: set -a; . ./.env.local; set +a")
    os.environ.setdefault("CV_LOG", "0")
    client = api.get_client()
    print(f"model={api.MODEL} effort={api.EFFORT} max_tokens={api.MAX_TOKENS}")

    status, body = run("extract", {"op": "extract", "lang": "tr", "topic": "experience",
                                   "question": QUESTION, "answer": ANSWER, "cv": START_CV}, client)
    if status != 200:
        sys.exit(1)
    fact_checks(body["cv"], body["heard"])

    if "finalize" in ops:
        status, fin = run("finalize", {"op": "finalize", "lang": "tr", "cv": body["cv"]}, client)
        if status != 200:
            sys.exit(1)
        fact_checks(fin["cv"])
        summary = fin["cv"]["summary"]
        sentences = [s for s in re.split(r"(?<=[.!?])\s+", summary) if s.strip()]
        check(f"summary has 3–4 sentences ({len(sentences)})", 3 <= len(sentences) <= 4)


if __name__ == "__main__":
    main()
