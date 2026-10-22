"""
tests/pdf-qa/check.py — text-extraction QA for the generated CV and cover-letter PDFs (brief §4.1 "QA").

How to run (see tests/run-pdf-qa.sh, which does all of this):
  1. jsc tests/pdf-qa/shim.js <pdfmake.js 0.2.10> <Roboto vfs> public/fonts.js public/parse.js public/pdfdoc.js \
         [photo.js] tests/pdf-qa/gen.js > dump.txt
  2. python tests/pdf-qa/check.py dump.txt OUTDIR [--png]
Needs pdfminer.six and pypdf (tests/requirements-dev.txt; dev only, never in the deployed requirements.txt).
--png renders page 1 (and page 2 if any) of every PDF to OUTDIR/png with macOS Quick Look (qlmanage).

Two extractors are used, because parsers differ in how they order text:
  - pdfminer.six with default layout analysis (like pdftotext's reading order), and
  - pypdf (content-stream order, like pdf.js / pdf-parse).
Asserted for every document, with both extractors:
  (1) İ ı ğ ş ç ö ü Ç Ş Ğ Ü Ö survive: every Turkish-letter word of the CV is extracted intact;
  (2) the name, e-mail and phone come before the first section heading;
  (3) the section headings appear in the profile's order (brief §4.2) as whole words;
  (4) each job's title, company and dates are adjacent in reading order;
  (5) "fi" survives as two letters (no U+FB01 ligature, "fi" words intact);
  (6) page counts: deneyimli sample ≤ 2 pages, öğrenci and saha samples exactly 1, letters exactly 1.
"""
import base64
import json
import os
import re
import subprocess
import sys
import tempfile

from pdfminer.high_level import extract_pages, extract_text
from pdfminer.layout import LTChar
from pypdf import PdfReader, PdfWriter

# Brief §4.2, copied here on purpose (not read from pdfdoc.js) so the test checks the spec.
ORDER = {
    'deneyimli': ['profile', 'experience', 'projects', 'education', 'skills', 'languages', 'certs', 'personal', 'hobbies'],
    'ogrenci': ['profile', 'education', 'projects', 'experience', 'skills', 'languages', 'certs', 'personal', 'hobbies'],
    'saha': ['profile', 'certs', 'experience', 'projects', 'education', 'skills', 'languages', 'personal', 'hobbies'],
    'yazilim': ['profile', 'experience', 'projects', 'education', 'skills', 'languages', 'certs', 'personal', 'hobbies'],
}
LABELS = {
    'tr': {'profile': 'PROFİL', 'experience': 'İŞ DENEYİMİ', 'projects': 'PROJELER', 'education': 'EĞİTİM',
           'skills': 'YETENEKLER', 'languages': 'DİLLER', 'certs': 'SERTİFİKALAR', 'personal': 'KİŞİSEL BİLGİLER',
           'hobbies': 'İLGİ ALANLARI', 'refs': 'REFERANSLAR'},
    'en': {'profile': 'PROFILE', 'experience': 'EXPERIENCE', 'projects': 'PROJECTS', 'education': 'EDUCATION',
           'skills': 'SKILLS', 'languages': 'LANGUAGES', 'certs': 'CERTIFICATIONS', 'personal': 'PERSONAL DETAILS',
           'hobbies': 'INTERESTS', 'refs': 'REFERENCES'},
}
PROFILE_LABELS = {'ogrenci': {'experience': 'DENEYİM'}, 'saha': {'certs': 'BELGELER VE SERTİFİKALAR'}}
MODERN_MAIN = ['profile', 'experience', 'projects', 'education']
# Right page margin per template (pt); text must never run past it (letters: 71).
RIGHT_MARGIN = {'klasik': 51, 'sade': 57, 'modern': 40, 'letter': 71}
TR_CHARS = 'İığşçöüÇŞĞÜÖ'


def norm(s):
    return re.sub(r'\s+', ' ', s).strip()


def heading_list(meta):
    """Expected headings: one list for one-column templates; [main, sidebar] lists for Modern."""
    cv, profile, lang, tpl = meta['cv'], meta['profile'], meta['lang'], meta['template']
    has = {
        'profile': bool(cv.get('summary', '').strip()),
        'experience': any((j.get('role') or j.get('company')) for j in cv.get('jobs', [])),
        'projects': any((p.get('name') or p.get('desc')) for p in cv.get('projects', []) or []),
        'education': bool(cv.get('edu')),
        'skills': bool(cv.get('skills', '').strip()),
        'languages': bool(cv.get('langs', '').strip()),
        'certs': bool(cv.get('certs', '').strip()),
        'personal': any(cv.get(k, '').strip() for k in ('birth', 'military', 'license', 'marital')),
        'hobbies': bool(cv.get('hobbies', '').strip()),
        'refs': bool(cv.get('refs', '').strip()),
    }
    # the yazılım sample has more than 24 months of experience: Projeler stays after İş Deneyimi
    keys = [k for k in ORDER[profile] + ['refs'] if has[k]]
    labels = dict(LABELS[lang])
    if lang == 'tr':
        labels.update(PROFILE_LABELS.get(profile, {}))
    elif profile == 'saha':
        labels['certs'] = 'LICENCES AND CERTIFICATES'
    if tpl == 'modern':
        main = [labels[k] for k in keys if k in MODERN_MAIN or k == 'refs']
        side = [labels[k] for k in keys if k not in MODERN_MAIN and k != 'refs']
        return [main, side]
    return [[labels[k] for k in keys]]


def visible_strings(cv, tpl):
    # Modern prints the title in capitals: it is checked as a heading-like string instead.
    out = [cv.get('name', ''), '' if tpl == 'modern' else cv.get('title', ''), cv.get('summary', ''), cv.get('skills', ''),
           cv.get('certs', ''), cv.get('hobbies', '')]
    for j in cv.get('jobs', []):
        out += [j.get('role', ''), j.get('company', ''), j.get('city', ''), j.get('desc', '')]
    for e in cv.get('edu', []):
        out += [e.get('school', ''), e.get('program', ''), e.get('note', '')]
    for p in cv.get('projects', []) or []:
        out += [p.get('name', ''), p.get('desc', '')]
    return ' '.join(out)


class Checker:
    def __init__(self):
        self.passed = 0
        self.failed = 0

    def ok(self, cond, msg):
        if cond:
            self.passed += 1
        else:
            self.failed += 1
            print('  FAIL: ' + msg)
        return cond


def find_seq(text, needles):
    """Index of each needle, searched left to right; -1 when missing or out of order."""
    pos, out = 0, []
    for n in needles:
        i = text.find(n, pos)
        out.append(i)
        if i >= 0:
            pos = i + len(n)
    return out


def check_margins(c, meta, path):
    """No glyph to the right of the right margin, or below the bottom edge (overlap/overflow check)."""
    right_margin = RIGHT_MARGIN['letter' if meta['kind'] == 'letter' else meta['template']]
    worst, count = 0, 0
    for page in extract_pages(path):
        limit = page.width - right_margin + 1.0
        stack = list(page)
        while stack:
            obj = stack.pop()
            if isinstance(obj, LTChar):
                if obj.get_text().strip() and (obj.x1 > limit or obj.y0 < 0):
                    count += 1
                    worst = max(worst, obj.x1 - limit)
            elif hasattr(obj, '__iter__'):
                stack.extend(list(obj))
    c.ok(count == 0, '%s: no text past the right margin (%d chars, worst +%.1fpt)' % (meta['id'], count, worst))


def check_doc(c, meta, extractor, text, strict):
    """strict: stream-order extractors, and every extractor for Sade. Otherwise (pdfminer's layout
    analysis on Klasik/Modern) the right-aligned dates and the two Modern columns may be reordered by
    geometry: Klasik keeps (3) and requires (4) only within the job's block (title … next title);
    Modern keeps (1), (2), (5) and whole-word headings."""
    tag = '%s [%s]' % (meta['id'], extractor)
    flat = norm(text)
    cv = meta['cv']
    # (5) no ligature glyphs at all
    c.ok('\ufb01' not in text and '\ufb02' not in text, tag + ': no fi/fl ligature characters')
    if meta['kind'] == 'letter':
        letter = meta['letter']
        c.ok(flat.find(cv['name']) == 0 or flat.find(cv['name']) < flat.find(letter['greeting']), tag + ': letter header first')
        for part in [letter['greeting']] + letter['paragraphs'] + [letter['closing']]:
            c.ok(norm(part) in flat, tag + ': letter text intact: ' + part[:30])
        return
    src = visible_strings(cv, meta['template'])
    # (1) Turkish letters: every word with a Turkish letter is extracted intact
    words = set(w for w in re.findall(r"[\wçğıöşüÇĞİÖŞÜ’']+", src) if any(ch in TR_CHARS for ch in w))
    if meta['lang'] == 'en':
        words = set(w for w in words if w not in ('İngilizce', 'Türkçe', 'Almanca', 'İtalyanca'))  # translated names
    missing = sorted(w for w in words if w not in flat)
    c.ok(not missing, tag + ': Turkish words intact (%d words) %s' % (len(words), missing[:6]))
    for ch in set(src) & set(TR_CHARS):
        c.ok(ch in text, tag + ': letter %s survives' % ch)
    # (5) "fi" words intact
    fi_words = set(w for w in re.findall(r'\w*fi\w*', src))
    c.ok(all(w in flat for w in fi_words), tag + ': "fi" words intact %s' % sorted(w for w in fi_words if w not in flat)[:5])
    # (3) headings in order, as whole words
    groups = heading_list(meta)
    heads = [h for g in groups for h in g]
    if strict and len(groups) == 2:
        # stream order: header, then on every page the main column before the sidebar
        idx = [flat.find(h) for h in heads]
        c.ok(all(i >= 0 for i in idx), tag + ': all headings present')
        c.ok(all(find_seq(flat, g)[-1] >= 0 for g in groups if g), tag + ': headings in profile order within each column')
        page1_main = [h for h in groups[0] if h in meta['page1']]
        page1_side = [h for h in groups[1] if h in meta['page1']]
        if page1_main and page1_side:
            p1 = norm(meta['page1'])
            c.ok(max(p1.find(h) for h in page1_main) < min(p1.find(h) for h in page1_side), tag + ': page 1: main column before sidebar')
    elif len(groups) == 1:
        idx = find_seq(flat, groups[0])
        c.ok(all(i >= 0 for i in idx), tag + ': headings in profile order %s' % [h for h, i in zip(groups[0], idx) if i < 0])
    # Modern under layout analysis: two columns are interleaved by geometry (the documented column
    # risk, brief §4.5); only presence as whole words (below) and (1), (2), (5) are asserted.
    for h in heads:
        spaced = ' '.join(h.replace(' ', ''))
        c.ok(h in flat and spaced not in flat, tag + ': heading "%s" as whole words' % h)
    # (2) name, e-mail and phone before the first heading
    first = min([flat.find(h) for h in heads if flat.find(h) >= 0] or [len(flat)])
    for field in ('name', 'email', 'phone'):
        v = cv.get(field, '').strip()
        if v:
            c.ok(0 <= flat.find(v) < first, tag + ': %s before the first heading' % field)
    # (4) each job: title, company and dates adjacent
    jobs = meta['jobs'] if strict or len(groups) == 1 else []
    for n, j in enumerate(jobs):
        good = False
        for m in re.finditer(re.escape(j['title']), flat):
            t = m.start()
            if strict:
                window = flat[t: t + len(j['title']) + len(j['company']) + len(j['range']) + 50]
                good = j['company'] in window and j['range'] in window
            else:
                after = flat[t:]
                stops = [after.find(o['title'], len(j['title'])) for o in jobs[n + 1:]] + [after.find(h) for h in heads]
                stops = [s for s in stops if s > 0]
                block = after[:min(stops)] if stops else after
                good = j['company'] in block[:len(j['title']) + len(j['company']) + len(j['range']) + 50] and j['range'] in block
            if good:
                break
        c.ok(good, tag + ': job "%s" title/company/dates %s' % (j['title'], 'adjacent' if strict else 'in one block'))


def render_png(pdf_path, out_dir, pages):
    os.makedirs(out_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(pdf_path))[0]
    made = []
    reader = PdfReader(pdf_path)
    for p in range(min(pages, len(reader.pages))):
        src = pdf_path
        if p > 0:
            w = PdfWriter()
            w.add_page(reader.pages[p])
            src = os.path.join(tempfile.mkdtemp(), base + '-p%d.pdf' % (p + 1))
            with open(src, 'wb') as f:
                w.write(f)
        subprocess.run(['qlmanage', '-t', '-s', '1400', '-o', out_dir, src], capture_output=True)
        png = os.path.join(out_dir, os.path.basename(src) + '.png')
        final = os.path.join(out_dir, '%s-p%d.png' % (base, p + 1))
        if os.path.exists(png):
            os.replace(png, final)
            made.append(final)
    return made


def main():
    dump, out = sys.argv[1], sys.argv[2]
    want_png = '--png' in sys.argv
    os.makedirs(out, exist_ok=True)
    c = Checker()
    docs, meta = [], None
    with open(dump, encoding='utf-8') as f:
        for line in f:
            line = line.rstrip('\n')
            if line.startswith('DOC '):
                meta = json.loads(line[4:])
            elif line.startswith('PDF ') and meta:
                path = os.path.join(out, meta['id'] + '.pdf')
                with open(path, 'wb') as g:
                    g.write(base64.b64decode(line[4:]))
                docs.append((meta, path))
                meta = None
            elif line.startswith('ERROR'):
                c.ok(False, line)
    c.ok(len(docs) >= 20, 'generated %d PDFs' % len(docs))
    all_text = ''
    for meta, path in docs:
        reader = PdfReader(path)
        n = len(reader.pages)
        size = os.path.getsize(path)
        c.ok(size < 1_000_000, '%s: file under 1 MB (%d bytes)' % (meta['id'], size))
        pm = extract_text(path)
        pages = [pg.extract_text() or '' for pg in reader.pages]
        pp = '\n'.join(pages)
        meta['page1'] = pages[0]
        all_text += pm
        check_margins(c, meta, path)
        if meta['kind'] != 'stress':
            check_doc(c, meta, 'pypdf: stream order', pp, True)
            check_doc(c, meta, 'pdfminer: layout order', pm, meta['template'] == 'sade' or meta['kind'] == 'letter')
        else:
            c.ok('\ufb01' not in pm and meta['cv']['name'] in norm(pm), '%s: stress text extracted' % meta['id'])
        # (6) page counts
        if meta['kind'] == 'letter':
            c.ok(n == 1, '%s: letter is exactly 1 page (%d)' % (meta['id'], n))
        elif meta['profile'] == 'deneyimli' and meta['id'].count('-') <= 2:
            c.ok(n <= 2, '%s: deneyimli ≤ 2 pages (%d)' % (meta['id'], n))
        elif meta['profile'] in ('ogrenci', 'saha'):
            c.ok(n == 1, '%s: %s sample exactly 1 page (%d)' % (meta['id'], meta['profile'], n))
        c.ok(meta['info']['title'].startswith(meta['cv']['name'] + ' — '), '%s: PDF title metadata' % meta['id'])
        c.ok(reader.metadata is not None and (reader.metadata.title or '') == meta['info']['title'], '%s: title stored in the PDF' % meta['id'])
        print('%-28s %d page(s) %7d bytes' % (meta['id'], n, size))
        if want_png:
            render_png(path, os.path.join(out, 'png'), 2)
    for ch in TR_CHARS:
        c.ok(ch in all_text, 'all PDFs together: %s survives' % ch)
    print('pdf-qa: %d passed, %d failed' % (c.passed, c.failed))
    sys.exit(1 if c.failed else 0)


if __name__ == '__main__':
    main()
