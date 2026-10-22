/* Sesli CV — yapay zekâ istemcisi: /api/cv çağrıları, CV veri dönüşümleri ve gönderimden önce
   cihazda kişisel veri temizliği (global: CVAI) */
(function (root) {
  'use strict';

  const CODE_KEY = 'sesli-cv:code';
  // Uygulama başka bir alan adında (ör. GitHub Pages) çalışıyorsa sunucunun tam adresi buraya yazılır.
  const API_URL = root.SESLI_CV_API || '/api/cv';

  // parse.js loads first, but it is still being extended: every helper is looked up at call time
  // and has a small local fallback, so a missing or renamed function never breaks a call.
  function PF(name) {
    const P = root.CVParse;
    return P && typeof P[name] === 'function' ? P[name] : null;
  }

  // ---------------------------------------------------------------- erişim kodu
  // Davet linki: https://…/#k=KOD  (kod bir kez okunur, tarayıcıda saklanır, adres çubuğundan silinir)
  function readCodeFromUrl() {
    try {
      const m = /(?:^|[#&?])(?:k|kod|davet)=([^&#]+)/.exec(root.location.hash + '&' + root.location.search);
      if (!m) return;
      const code = decodeURIComponent(m[1]).trim();
      if (code) setCode(code);
      const clean = root.location.pathname + root.location.search.replace(/([?&])(k|kod|davet)=[^&]*&?/, '$1').replace(/[?&]$/, '');
      root.history.replaceState(root.history.state, '', clean);
    } catch (_) { /* ignore */ }
  }
  function getCode() { try { return root.localStorage.getItem(CODE_KEY) || ''; } catch (_) { return ''; } }
  function setCode(c) { try { root.localStorage.setItem(CODE_KEY, String(c || '').trim()); } catch (_) { /* ignore */ } }

  // ---------------------------------------------------------------- HTTP
  /**
   * call(op, payload, {signal}) → JSON. Rejects with {status, code, message, retryable, retryAfter}.
   * codes: bad_request | access_code | too_large | rate_limited | upstream | not_configured | internal |
   *        network | cancelled | unavailable | http_<status>
   * retryable: network errors, 429, and any 5xx except not_configured / bad_request.
   */
  async function call(op, payload, opts) {
    const o = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    const code = getCode();
    if (code) headers['X-Access-Code'] = code;
    let res;
    try {
      res = await root.fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(Object.assign({ op }, payload || {})), signal: o.signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw { status: 0, code: 'cancelled', message: '', retryable: false, retryAfter: 0 };
      throw { status: 0, code: 'network', message: 'İnternet bağlantısı yok ya da sunucuya ulaşılamadı.', retryable: true, retryAfter: 0 };
    }
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) {
      const status = Number(res.status) || 0;
      const codeName = (data && typeof data.error === 'string' && data.error) || (status === 404 ? 'unavailable' : 'http_' + status);
      let retryAfter = data ? Number(data.retryAfter) || 0 : 0;
      if (!retryAfter) {
        try { retryAfter = Number(res.headers && res.headers.get && res.headers.get('Retry-After')) || 0; } catch (_) { retryAfter = 0; }
      }
      throw {
        status,
        code: codeName,
        message: (data && typeof data.message === 'string' && data.message) || (status === 404 ? 'Yapay zekâ hizmeti bu adreste çalışmıyor.' : 'Sunucu bir hata döndürdü.'),
        retryable: status === 429 || (status >= 500 && codeName !== 'not_configured' && codeName !== 'bad_request'),
        retryAfter: Math.max(0, retryAfter),
      };
    }
    return data || {};
  }

  // ---------------------------------------------------------------- küçük yardımcılar
  const s = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && isFinite(v) ? String(v) : '');
  const arr = (v) => (Array.isArray(v) ? v : []);
  const strList = (v) => arr(v).map(s).filter(Boolean);
  const hasAny = (o, keys) => keys.some((k) => s(o[k]));
  const oneLine = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const nfc = (t) => (typeof t.normalize === 'function' ? t.normalize('NFC') : t);

  const FOLD = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' };
  function trLower(t) { return nfc(String(t)).replace(/I/g, 'ı').replace(/İ/g, 'i').toLowerCase().replace(/i̇/g, 'i'); }
  // Same-length key (Turkish lower case + ASCII fold, one UTF-16 unit each), so regex hits on the key
  // map straight back onto the original text.
  function keyStr(t) {
    let out = '';
    for (let i = 0; i < t.length; i++) {
      const ch = t.charAt(i);
      if (ch === 'I' || ch === 'İ' || ch === 'ı') { out += 'i'; continue; }
      const l = ch.toLowerCase();
      out += l.length !== 1 ? ch : own(FOLD, l) ? FOLD[l] : l;
    }
    return out;
  }
  const foldAscii = (t) => keyStr(trLower(t));

  function splitLines(t) {
    const f = PF('splitLines');
    if (f) return f(t);
    return String(t).split(/\r\n?|\n/).map((l) => l.replace(/^[-•*·–—]+\s*/, '').trim()).filter(Boolean);
  }
  function splitList(t) {
    const f = PF('splitList');
    if (f) return f(t);
    const seen = {}, out = [];
    String(t).replace(/(^|[\s,;])ve(?=[\s,;]|$)/gi, '$1,').split(/[,;\n\r•·|]/).forEach((raw) => {
      const it = oneLine(raw);
      const k = keyStr(it);
      if (it && !own(seen, k)) { seen[k] = 1; out.push(it); }
    });
    return out;
  }
  function parseLangs(t) {
    const f = PF('parseLanguages');
    let list = null;
    if (f) { try { list = f(t); } catch (_) { list = null; } }
    if (!Array.isArray(list)) list = splitList(t).map((it) => ({ name: it, level: 0, raw: it }));
    return list.filter((l) => l && typeof l === 'object' && s(l.name));
  }
  const clampLevel = (v) => Math.max(0, Math.min(5, Math.round(Number(v)) || 0));

  // ================================================================ scrub (critic C3)
  // Runs on the device before any transcript leaves it. Removes TC kimlik numbers (checksum
  // verified), Turkish phone numbers, e-mail addresses and IBANs, written as digits, as spoken
  // number words or mixed, with the digit groups split by spaces, dots, dashes or brackets.

  const NUM_WORDS = {
    'sıfır': 0, sifir: 0, bir: 1, iki: 2, 'üç': 3, uc: 3, 'dört': 4, dort: 4, 'beş': 5, bes: 5,
    'altı': 6, alti: 6, yedi: 7, sekiz: 8, dokuz: 9, on: 10, yirmi: 20, otuz: 30, 'kırk': 40, kirk: 40,
    elli: 50, 'altmış': 60, altmis: 60, 'yetmiş': 70, yetmis: 70, seksen: 80, doksan: 90,
    'yüz': 100, yuz: 100, bin: 1000,
  };
  // Exact lower-case words only: "ön", "uç" or "yüzde" are not number words.
  function numWord(w) {
    let k = trLower(w);
    if (own(NUM_WORDS, k)) return NUM_WORDS[k];
    k = nfc(String(w)).toLowerCase(); // "IKI" typed on an English keyboard
    return own(NUM_WORDS, k) ? NUM_WORDS[k] : -1;
  }

  // Turkish number words → numbers, keeping each number's span: [{start, end, v}] → [{start, end, digits}].
  // Same slot rules as CVParse.wordsToNumbers ("beş yüz otuz iki yüz yirmi üç" → 532 123), plus the
  // spoken country code: after a bare "doksan", a ones word right before "yüz" is that hundred's
  // multiplier, so "doksan beş yüz otuz iki" is 90 532 (not 95 132).
  function slotNumbers(words, cc) {
    const out = [];
    let c = null;
    const empty = (g) => g.h === null && g.te === null && g.o === null;
    const fits = (g, v) => {
      if (v <= 9) return g.o === null;
      if (v <= 90) return g.te === null && g.o === null;
      if (v === 100) return empty(g) || (g.h === null && g.te === null && g.o !== null && g.o >= 2);
      return g.t === null;
    };
    const flush = () => {
      if (!c) return;
      out.push({ start: c.start, end: c.end, digits: String((c.t || 0) * 1000 + (c.h || 0) * 100 + (c.te || 0) + (c.o || 0)), word: true });
      c = null;
    };
    words.forEach((w, i) => {
      const v = w.v;
      if (v === 0) { flush(); out.push({ start: w.start, end: w.end, digits: '0', word: true }); return; }
      const next = words[i + 1];
      if (cc && c && v >= 2 && v <= 9 && next && next.v === 100 && c.te === 90 && c.t === null && c.h === null && c.o === null) flush();
      if (c && !fits(c, v)) flush();
      if (!c) c = { t: null, h: null, te: null, o: null, start: w.start, end: w.end };
      if (v <= 9) c.o = v;
      else if (v <= 90) c.te = v;
      else if (v === 100) { if (empty(c)) c.h = 1; else { c.h = c.o; c.o = null; } }
      else { c.t = empty(c) ? 1 : (c.h || 0) * 100 + (c.te || 0) + (c.o || 0); c.h = c.te = c.o = null; }
      c.end = w.end;
    });
    flush();
    return out;
  }

  // Every number in the text, in order: digit runs and runs of number words (one run = number words
  // separated by spaces only; a word glued to letters or digits, like "4bir" or "onur", is not one).
  function numberAtoms(t, cc) {
    const atoms = [];
    let m;
    const dre = /\d+/g;
    while ((m = dre.exec(t)) !== null) atoms.push({ start: m.index, end: m.index + m[0].length, digits: m[0], word: false });
    const wre = /[\p{L}\p{M}\p{N}_]+/gu;
    let run = [];
    const flushRun = () => { if (run.length) slotNumbers(run, cc).forEach((a) => atoms.push(a)); run = []; };
    while ((m = wre.exec(t)) !== null) {
      const v = numWord(m[0]);
      if (v < 0) { flushRun(); continue; }
      const w = { start: m.index, end: m.index + m[0].length, v };
      if (run.length && !/^[^\S\n]+$/.test(t.slice(run[run.length - 1].end, w.start))) flushRun();
      run.push(w);
    }
    flushRun();
    return atoms.sort((a, b) => a.start - b.start);
  }

  // What may stand between two digit groups of one number: spaces, dots, dashes, slashes, brackets.
  // Never a comma ("3,41"), a colon ("9001:2015"), a letter or a line break.
  const JOIN_RE = /^[^\S\n]*(?:[.\-–—/()][^\S\n]*){0,3}$/;

  function tcValid(d) {
    if (!/^[1-9]\d{10}$/.test(d)) return false;
    const n = d.split('').map(Number);
    const odd = n[0] + n[2] + n[4] + n[6] + n[8];
    const even = n[1] + n[3] + n[5] + n[7];
    if ((((odd * 7 - even) % 10) + 10) % 10 !== n[9]) return false;
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += n[i];
    return sum % 10 === n[10];
  }

  // Turkish numbers: mobile 5xx, landline 2xx–4xx, 8xx (0850…). Digits only; plus = written "+"/"artı".
  function trPhone(d, plus) {
    const m = /^(?:00)?90([2-58]\d{9})$/.exec(d);
    if (m) return { national: '0' + m[1], intl: true };
    if (plus) return null;
    if (/^0[2-58]\d{9}$/.test(d)) return { national: d, intl: false };
    if (/^5\d{9}$/.test(d)) return { national: '0' + d, intl: false };
    return null;
  }
  function formatPhone(p) {
    const d = p.national;
    const raw = p.intl ? '+90' + d.slice(1) : d;
    const f = PF('normalizePhone');
    if (f) {
      try { const r = f(raw); if (typeof r === 'string' && /\d{2}/.test(r)) return r; } catch (_) { /* fallback below */ }
    }
    const tail = d.slice(4, 7) + ' ' + d.slice(7, 9) + ' ' + d.slice(9, 11);
    return p.intl ? '+90 ' + d.slice(1, 4) + ' ' + tail : d.slice(0, 4) + ' ' + tail;
  }

  // Start of a "+" / "artı" (and an optional "(") right before pos, or -1.
  function plusStart(t, pos) {
    const from = Math.max(0, pos - 12);
    const before = keyStr(t.slice(from, pos));
    const m = /(\+|arti)[^\S\n]*\(?[^\S\n]*$/.exec(before);
    if (!m) return -1;
    const at = from + m.index;
    if (m[1] !== '+' && at > 0 && /[\p{L}\p{N}_]/u.test(t.charAt(at - 1))) return -1;
    return at;
  }
  // Start of the "TR" (spoken "te re") in front of an IBAN, pos itself after the word "IBAN", or -1.
  function ibanStart(t, pos) {
    const from = Math.max(0, pos - 40);
    const before = keyStr(t.slice(from, pos));
    const m = /(?:^|[^a-z0-9])(tr|te[^\S\n]+re)[^\S\n]*[:.-]?[^\S\n]*$/.exec(before);
    if (m) return from + m.index + m[0].indexOf(m[1]);
    return /(?:^|[^a-z0-9])iban(?![a-z0-9])[^0-9\n]{0,30}$/.test(before) ? pos : -1;
  }

  // A span may cut a bracket pair in half ("(0532) 123 45 67"): take the other half too.
  function widen(t, a, b) {
    const inner = t.slice(a, b);
    const opens = (inner.match(/\(/g) || []).length, closes = (inner.match(/\)/g) || []).length;
    if (closes > opens) { const m = /\([^\S\n]*$/.exec(t.slice(0, a)); if (m) a = m.index; }
    else if (opens > closes) { const m = /^[^\S\n]*\)/.exec(t.slice(b)); if (m) b += m[0].length; }
    return [a, b];
  }

  function applyReps(t, reps) {
    let out = '', pos = 0;
    reps.sort((x, y) => x.start - y.start).forEach((r) => {
      if (r.start < pos) return;
      out += t.slice(pos, r.start) + r.label;
      pos = r.end;
    });
    return out + t.slice(pos);
  }

  // A written date inside the digit groups ("05.02.2000 - 12.8.1990", "2019-03-01", "5.3.21") means
  // they are dates: neither a TC kimlik no that happens to pass the checksum (about 1 in 100 do) nor
  // a phone number ("05.02.2000 - 12.8" has the digits of a 050x mobile).
  function hasDate(t, chain, i, j) {
    const sep = (a, b) => t.slice(a.end, b.start);
    const n = (a) => Number(a.digits);
    const dm = (d, m) => d.digits.length <= 2 && m.digits.length <= 2 && n(d) >= 1 && n(d) <= 31 && n(m) >= 1 && n(m) <= 12;
    const year4 = (x) => /^(?:19|20)\d\d$/.test(x.digits);
    for (let k = i; k + 2 <= j; k++) {
      const a = chain[k], b = chain[k + 1], c = chain[k + 2];
      const s1 = sep(a, b), s2 = sep(b, c);
      if (!/^[./-]$/.test(s1) || s2 !== s1) continue;
      if (year4(c) && dm(a, b)) return true;                                  // 05.02.2000
      if (year4(a) && dm(c, b)) return true;                                  // 2019-03-01
      if (s1 !== '-' && c.digits.length === 2 && dm(a, b)) return true;       // 05.02.20, 5/3/21
    }
    return false;
  }

  // An amount written with Turkish thousand dots ("5.000.000.000 TL") has the digits of a 5xx mobile
  // number. Only typed digit groups count (a dictated "beş üç yüz yirmi bir …" is not an amount).
  function isAmount(t, chain, i, j) {
    if (j - i < 2 || !/^\d{1,3}$/.test(chain[i].digits) || chain[i].word) return false;
    for (let k = i + 1; k <= j; k++) {
      if (chain[k].word || chain[k].digits.length !== 3 || t.slice(chain[k - 1].end, chain[k].start) !== '.') return false;
    }
    return true;
  }
  const notNumber = (t, chain, i, j) => hasDate(t, chain, i, j) || isAmount(t, chain, i, j);

  // IBAN (24 digits after "TR"), then TC (11 digits, checksum), then phone, tried at each digit
  // group from the left; groups only join across JOIN_RE gaps.
  function matchNumberAt(t, chain, i, res) {
    const wins = [];
    let d = '';
    for (let j = i; j < chain.length && d.length < 24; j++) { d += chain[j].digits; wins.push({ j, d }); }
    const win = (len) => wins.find((w) => w.d.length === len);
    const hit = (a, j, label) => { const ab = widen(t, a, chain[j].end); return { start: ab[0], end: ab[1], next: j + 1, label }; };

    const w24 = win(24);
    if (w24) {
      const st = ibanStart(t, chain[i].start);
      if (st >= 0) { res.removed.iban++; return hit(st, w24.j, '[IBAN]'); }
    }
    const w11 = win(11);
    if (w11 && tcValid(w11.d) && !notNumber(t, chain, i, w11.j)) { res.removed.tc++; return hit(chain[i].start, w11.j, '[kimlik no]'); }
    const plus = plusStart(t, chain[i].start);
    const from = plus >= 0 ? plus : chain[i].start;
    for (const len of [14, 12, 11, 10]) {
      const w = win(len);
      const p = w && trPhone(w.d, plus >= 0);
      if (!p || notNumber(t, chain, i, w.j)) continue;
      res.removed.phone++;
      if (!res.found.phone && p.national.charAt(1) === '5') res.found.phone = formatPhone(p);
      return hit(from, w.j, '[telefon]');
    }
    // "+49 151 …": another country's number is removed too, but never reported
    for (const len of [14, 13, 12, 11, 10]) {
      const w = plus >= 0 && win(len);
      if (w && !notNumber(t, chain, i, w.j)) { res.removed.phone++; return hit(from, w.j, '[telefon]'); }
    }
    return null;
  }

  function scrubNumbers(t, res, cc) {
    const atoms = numberAtoms(t, cc);
    const chains = [];
    let ch = [];
    atoms.forEach((a) => {
      if (ch.length && !JOIN_RE.test(t.slice(ch[ch.length - 1].end, a.start))) { chains.push(ch); ch = []; }
      ch.push(a);
    });
    if (ch.length) chains.push(ch);
    const reps = [];
    chains.forEach((c) => {
      for (let i = 0; i < c.length;) {
        const r = matchNumberAt(t, c, i, res);
        if (r) { reps.push(r); i = r.next; } else i++;
      }
    });
    return applyReps(t, reps);
  }

  // ---- e-mail: literal (ayse.kaya@gmail.com, "ayse @ gmail.com") and dictated
  // ("ayşe nokta kaya et gmail nokta com"). A spoken "et"/"at" only counts before a known provider
  // or a known top-level domain.
  const PROVIDERS = {};
  ('gmail googlemail hotmail outlook live msn windowslive yahoo ymail icloud me mac yandex mynet ' +
    'protonmail proton gmx aol zoho ttmail superonline mail').split(' ').forEach((w) => { PROVIDERS[w] = 1; });
  const TLDS = {};
  'com net org edu gov tr io co me info biz de uk nl fr az ru us eu dev app ai'.split(' ').forEach((w) => { TLDS[w] = 1; });
  const AT_WORDS = { et: 1, at: 1 };
  const DOT_WORDS = { nokta: 1, dot: 1 };
  // dictated separators inside the local part (folded keys)
  const SEP2 = { 'alt cizgi': '_', 'alt tire': '_', 'kisa cizgi': '-' };
  const SEP1 = { nokta: '.', dot: '.', underscore: '_', tire: '-', eksi: '-', '.': '.', '_': '_', '-': '-' };
  // words that introduce an address and are never its local part
  const STOP = {};
  ('adres adresim adresi adresimiz eposta epostam e-posta e-postam posta postam mail maili mailim ' +
    'email emailim e-mail e-mailim olarak ve ile de da benim su soyle sudur is iste yazin address')
    .split(' ').forEach((w) => { STOP[w] = 1; });
  // A typed address may end in a long top-level domain (".istanbul", ".software"); a dictated one is
  // only read with a short one, which keeps "… nokta kariyer" from turning into an address.
  const TLD_TYPED = /^\p{L}{2,24}$/u;
  const TLD_SAID = /^\p{L}{2,6}$/u;

  function emailTokens(t) {
    const out = [];
    const re = /@|[^\s@]+/g;
    let m;
    while ((m = re.exec(t)) !== null) {
      const raw = m[0], start = m.index;
      let cs = 0, core = raw;
      if (/^[._-]$/.test(raw) || raw === '@') {
        // a lone separator or "@" is its own token
      } else if (t.charAt(start + raw.length) === '@') {
        // glued to a following "@": only the tail that can be a local part ("e-posta:ayse@…")
        const tail = /[\p{L}\p{N}._%+-]+$/u.exec(raw);
        cs = tail ? tail.index : raw.length;
        core = tail ? tail[0] : '';
      } else {
        const lead = /^[(\[{"'“‘«<]+/.exec(raw);
        if (lead) { cs = lead[0].length; core = raw.slice(cs); }
        for (let k = 0; k < 2; k++) {
          core = core.replace(/[.,;:!?)\]}"'”’»>…]+$/, '');
          core = core.replace(/['’]\p{L}+$/u, ''); // "gmail.com'a"
        }
      }
      out.push({ start, end: start + raw.length, cs: start + cs, ce: start + cs + core.length, core, key: keyStr(trLower(core)) });
    }
    return out;
  }

  function matchEmail(tk, k, opts) {
    const at = tk[k];
    const literal = at.core === '@';
    let r = k + 1;
    let atWord = '';
    if (!literal) {
      if (AT_WORDS[at.key]) atWord = at.key;
      else if (at.key === 'kuyruklu' && tk[k + 1] && tk[k + 1].key === 'a') { atWord = 'kuyruklu'; r = k + 2; } // "kuyruklu a" = @
      else return null;
    }
    if (tk[r] && tk[r].key === 'isareti') r++; // "et işareti"
    const p = tk[r];
    if (!p || !/^[\p{L}\p{N}][\p{L}\p{N}.-]*$/u.test(p.core)) return null;
    const parts = p.core.split('.');
    if (parts.some((x) => !x)) return null;
    const provider = parts[0];
    const tlds = parts.slice(1);
    // A typed "x@firma.istanbul" may have a long TLD; anything glued to the provider word counts as typed.
    const tldRe = literal || tlds.length ? TLD_TYPED : TLD_SAID;
    let end = r;
    while (tlds.length < 3) {
      const dot = tk[end + 1], x = tk[end + 2];
      if (dot && x && (DOT_WORDS[dot.key] || dot.core === '.') && TLD_SAID.test(x.core)) { tlds.push(x.core); end += 2; } else break;
    }
    const pKey = keyStr(trLower(provider));
    if (!tlds.length && PROVIDERS[pKey] && tk[r + 1] && TLDS[tk[r + 1].key]) { tlds.push(tk[r + 1].core); end = r + 1; } // "gmail com"
    if (!tlds.length || !tlds.every((x) => tldRe.test(x))) return null;
    if (!literal && !PROVIDERS[pKey] && !tlds.some((x) => TLDS[keyStr(trLower(x))])) return null;

    // local part, leftwards from the "@": number words / digits ("seksen beş"), one word, then
    // "<word> nokta|alt çizgi|tire …" chains, then words of the person's name when it is known.
    const isNum = (x) => !!x && (/^\d+$/.test(x.core) || numWord(x.core) >= 0);
    const isWord = (x) => !!x && /^[\p{L}\p{N}._%+-]+$/u.test(x.core) && /[\p{L}\p{N}]/u.test(x.core) && !STOP[x.key] && !own(SEP1, x.key) && !AT_WORDS[x.key];
    const nameKeys = {};
    oneLine(opts && opts.name).split(' ').forEach((w) => { const kk = keyStr(trLower(w)); if (kk.length >= 2) nameKeys[kk] = 1; });
    let L = k;
    const piece = () => {
      const from = L;
      let n = 0;
      while (n < 6 && isNum(tk[L - 1])) { L--; n++; }
      if (isWord(tk[L - 1]) && !isNum(tk[L - 1])) { L--; if (nameKeys[tk[L].key]) nameKeys[tk[L].key] = 2; }
      return L < from;
    };
    const sepBefore = (idx) => { // separator made of the tokens ending at idx → its length in tokens
      if (idx >= 1 && own(SEP2, tk[idx - 1].key + ' ' + tk[idx].key)) return 2;
      return idx >= 0 && own(SEP1, tk[idx].key) ? 1 : 0;
    };
    const glued = literal && tk[k - 1] && tk[k - 1].end === at.start && tk[k - 1].core;
    if (glued) L = k - 1; // typed "mail@firma.com": the text glued to "@" is the local part, whatever it says
    else if (!piece()) return null;
    for (let guard = 0; guard < 6; guard++) {
      const n = sepBefore(L - 1);
      if (n) {
        const save = L;
        L -= n;
        if (!piece()) { L = save; break; }
        continue;
      }
      // each word of the name once: "adım ayşe kaya, ayşe kaya et …" stops at the first "kaya"
      let named = 0;
      while (named < 3 && tk[L - 1] && nameKeys[tk[L - 1].key] === 1 && isWord(tk[L - 1])) { nameKeys[tk[L - 1].key] = 2; L--; named++; }
      if (!named) break;
    }
    // Words between a lead-in ("mailim ayşe kaya et gmail …") and the address are its local part,
    // even when the name is not known yet. opts.whole (the text is only an address, as on the contact
    // card) lets the start of the text count as the lead-in. At most three words; never for a typed
    // "x@y.z", whose local part is exactly the text glued to the "@".
    let leadIn = false;
    if (!glued) {
      let n = 0;
      while (n < 3 && isWord(tk[L - 1 - n]) && !isNum(tk[L - 1 - n])) n++;
      const before = tk[L - 1 - n];
      leadIn = before ? !!STOP[before.key] : !!(opts && opts.whole);
      if (leadIn) L -= n;
    }

    // build the address
    let local = '';
    for (let i = L; i < k;) {
      const n2 = i + 1 < k && own(SEP2, tk[i].key + ' ' + tk[i + 1].key) ? 2 : 0;
      if (n2) { local += SEP2[tk[i].key + ' ' + tk[i + 1].key]; i += 2; continue; }
      if (own(SEP1, tk[i].key)) { local += SEP1[tk[i].key]; i++; continue; }
      if (numWord(tk[i].core) >= 0) {
        const run = [];
        while (i < k && numWord(tk[i].core) >= 0) { run.push({ start: i, end: i, v: numWord(tk[i].core) }); i++; }
        local += slotNumbers(run, false).map((x) => x.digits).join('');
        continue;
      }
      local += tk[i].core;
      i++;
    }
    local = local.replace(/^[._-]+|[._-]+$/g, '');
    // English "at" is an everyday word: "I worked at Amazon dot com" is an employer, not an address.
    // It counts only before a known mail provider, after a lead-in ("my email is …"), or when the
    // local part looks like one (a dot, dash, underscore or digit in it).
    if (atWord === 'at' && !PROVIDERS[pKey] && !leadIn && !/[._\-0-9]/.test(local)) return null;
    let email = foldAscii(local + '@' + provider + '.' + tlds.join('.')).replace(/\s+/g, '');
    const ne = PF('normalizeEmail');
    if (ne) { try { const v = ne(email); if (typeof v === 'string' && v) email = v; } catch (_) { /* keep ours */ } }
    if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/.test(email)) email = '';
    return { start: tk[L].cs, end: tk[end].ce, next: end + 1, email };
  }

  function scrubEmails(t, res, opts) {
    const tk = emailTokens(t);
    const reps = [];
    for (let k = 0; k < tk.length; k++) {
      const m = matchEmail(tk, k, opts);
      if (!m || (reps.length && m.start < reps[reps.length - 1].end)) continue;
      reps.push({ start: m.start, end: m.end, label: '[e-posta]' });
      res.removed.email++;
      if (!res.found.email && m.email) res.found.email = m.email;
      k = m.next - 1;
    }
    return applyReps(t, reps);
  }

  /**
   * scrub(text, {name}?) → {text, found:{phone, email}, removed:{tc, phone, email, iban}}
   * text: the input with every TC kimlik no → "[kimlik no]", phone → "[telefon]", e-mail →
   * "[e-posta]", IBAN → "[IBAN]"; everything else is left exactly as it was.
   * found: the first Turkish mobile number (formatted) and the first e-mail address, so the app can
   * fill an empty contact field locally. removed: how many of each were taken out.
   * opts.name (optional): the person's name, so "ayşe kaya et gmail nokta com" is read as one address.
   */
  function scrub(text, opts) {
    const res = { text: '', found: { phone: '', email: '' }, removed: { tc: 0, phone: 0, email: 0, iban: 0 } };
    let t = typeof text === 'string' ? text : text == null ? '' : String(text);
    if (!t) return res;
    t = scrubEmails(t, res, opts || {});
    // spoken "doksan beş yüz …" is read both ways: +90 5xx first, then 95 1xx (a TC can hold that too)
    t = scrubNumbers(t, res, true);
    t = scrubNumbers(t, res, false);
    res.text = t;
    return res;
  }

  // ================================================================ dönüşümler

  const LEVEL_TR = ['', 'başlangıç', 'orta', 'iyi', 'ileri', 'ana dil'];
  const LEVEL_EN = ['', 'beginner', 'intermediate', 'upper-intermediate', 'advanced', 'native'];
  const CEFR_LEVEL = { A1: 1, A2: 1, B1: 2, B2: 3, C1: 4, C2: 4 };
  // Kept on the device, never sent to the model (brief §3.3, critic C3).
  const DEVICE_FIELDS = ['phone', 'email', 'refs', 'birth', 'military', 'marital'];

  // ---- skills: "Diller: Go, C#\nFramework: .NET" (same line rule as PDF.skillGroups)
  const GROUP_RE = /^\s*([^:,\n]{2,30}):\s*(.+)$/;
  function groupMatch(line) {
    const m = GROUP_RE.exec(line);
    return m && !/^(?:https?|ftp|mailto)$/i.test(m[1].trim()) ? m : null;
  }
  function skillsToAI(text) {
    const lines = splitLines(text);
    if (!lines.some(groupMatch)) return { skills: splitList(text), skillGroups: [] };
    const groups = [];
    let loose = null;
    lines.forEach((line) => {
      const m = groupMatch(line);
      if (m) {
        const items = splitList(m[2]);
        if (items.length) groups.push({ name: oneLine(m[1]), items });
        return;
      }
      const more = splitList(line);
      if (!more.length) return;
      if (!loose) { loose = { name: '', items: [] }; groups.push(loose); }
      more.forEach((it) => { if (!loose.items.some((x) => keyStr(x) === keyStr(it))) loose.items.push(it); });
    });
    const flat = [], seen = {};
    groups.forEach((g) => g.items.forEach((it) => { const k = keyStr(trLower(it)); if (!own(seen, k)) { seen[k] = 1; flat.push(it); } }));
    return { skills: flat, skillGroups: groups };
  }
  // An item must stay one item when the text is read back: no list separators, no "label:" colon.
  const skillItem = (v) => oneLine(v).replace(/\s*[,;·•|]\s*/g, ' / ').replace(/\s*:\s*/g, ' - ').trim();
  function groupLabel(v) {
    const t = oneLine(v).replace(/[:,]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30).trim();
    return t.length >= 2 && !/^(?:https?|ftp|mailto)$/i.test(t) ? t : '';
  }
  function skillsFromAI(x) {
    const flat = strList(x.skills).map(skillItem).filter(Boolean);
    const groups = arr(x.skillGroups).filter((g) => g && typeof g === 'object')
      .map((g) => ({ name: groupLabel(s(g.name)), items: strList(g.items).map(skillItem).filter(Boolean) }))
      .filter((g) => g.items.length);
    if (!groups.length) return flat.join(', ');
    const inGroups = {};
    groups.forEach((g) => g.items.forEach((it) => { inGroups[keyStr(trLower(it))] = 1; }));
    const rest = flat.filter((it) => !own(inGroups, keyStr(trLower(it))));
    if (rest.length) {
      const loose = groups.find((g) => !g.name);
      if (loose) loose.items = loose.items.concat(rest); else groups.push({ name: '', items: rest });
    }
    return groups.map((g) => (g.name ? g.name + ': ' : '') + g.items.join(', ')).join('\n');
  }

  // ---- languages: {name, level 0–5, cefr 'A1'..'C2' | '', exam ''}
  // Exams: name + optional score (number or CEFR level) + optional year, matched on keyStr.
  const EXAM_RE = new RegExp('(^|[^a-z0-9])(toefl(?:[\\s-]*ibt)?|ielts|e[\\s-]?yds|yds|yokdil|toeic|' +
    'pte(?:\\s+academic)?|goethe(?:[\\s-]*zertifikat)?|delf|dalf|testdaf|dele)(?![a-z0-9])' +
    '(?:[^\\S\\n]*[:\\-–]?[^\\S\\n]*(\\d{1,3}(?:[.,]\\d{1,2})?|[abc][12])(?![a-z0-9]|[.,]\\d))?' +
    '(?:[^\\S\\n]*\\(?[^\\S\\n]*((?:19|20)\\d{2})[^\\S\\n]*\\)?(?![a-z0-9]))?');
  const EXAM_NAMES = {
    'toefl ibt': 'TOEFL iBT', toefl: 'TOEFL', ielts: 'IELTS', 'e yds': 'e-YDS', eyds: 'e-YDS', yds: 'YDS',
    yokdil: 'YÖKDİL', toeic: 'TOEIC', pte: 'PTE', 'pte academic': 'PTE Academic', goethe: 'Goethe',
    'goethe zertifikat': 'Goethe-Zertifikat', delf: 'DELF', dalf: 'DALF', testdaf: 'TestDaF', dele: 'DELE',
  };
  const CEFR_RE = /(^|[^a-z0-9])([abc][12])(?![a-z0-9])/;
  const CEFR_RE_G = /(^|[^a-z0-9])[abc][12](?![a-z0-9])/g;

  function findExam(text) {
    const m = EXAM_RE.exec(keyStr(text));
    if (!m) return null;
    const start = m.index + m[1].length, end = m.index + m[0].length;
    const name = EXAM_NAMES[m[2].replace(/[\s-]+/g, ' ')] || m[2].toUpperCase();
    const score = m[3] ? m[3].replace(',', '.').toUpperCase() : '';
    return {
      exam: name + (score ? ' ' + score : '') + (m[4] ? ' (' + m[4] + ')' : ''),
      start,
      rest: oneLine(text.slice(0, start) + ' ' + text.slice(end)),
    };
  }
  function findCefr(text) {
    const m = CEFR_RE.exec(keyStr(String(text || '')));
    return m ? m[2].toUpperCase() : '';
  }
  function cefrOf(v) {
    const t = s(v).toUpperCase().replace(/\s+/g, '');
    return own(CEFR_LEVEL, t) ? t : '';
  }
  // Exam text written by fromAI: one item, decimal point, no list separators.
  const cleanExam = (v) => oneLine(s(v).replace(/(\d),(\d)/g, '$1.$2').replace(/[,;·•|]/g, ' ')).slice(0, 80);
  const cleanLangName = (v) => oneLine(s(v).replace(/[,;·•|]/g, ' '));

  function isKnownLanguage(word) {
    const f = PF('languageName');
    if (!f || !word) return false;
    try { return f(word, 'en') !== word || f(word, 'tr') !== word; } catch (_) { return false; }
  }
  // The part after "·" is an exam ("· IELTS 6.5 (2024)", "· JLPT N4") unless it is a level or another language.
  function examTail(tail) {
    if (!tail) return false;
    const words = tail.split(' ');
    for (let i = 0; i < words.length; i++) {
      if (isKnownLanguage(words[i]) || (i + 1 < words.length && isKnownLanguage(words[i] + ' ' + words[i + 1]))) return false;
    }
    return !!findExam(tail) || /\d/.test(keyStr(tail).replace(CEFR_RE_G, '$1'));
  }
  function levelOf(name, text) {
    const l = parseLangs(name + ' ' + text)[0];
    return l ? clampLevel(l.level) : 0;
  }

  function langsToAI(text) {
    const out = [], byKey = Object.create(null);
    let last = null;
    // a decimal comma in a score ("YÖKDİL 82,5") is not a list separator
    s(text).replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2').split(/[,;\n\r•|]/).forEach((raw) => {
      let item = oneLine(raw).replace(/^[\s·\-–—:]+|[\s·\-–—:]+$/g, '');
      if (!item) return;
      let exam = '', examAt = -1;
      const dot = item.indexOf('·');
      if (dot >= 0) {
        const tail = oneLine(item.slice(dot + 1));
        if (examTail(tail)) {
          const ex = findExam(tail);
          exam = ex && !ex.rest ? ex.exam : cleanExam(tail);
          item = oneLine(item.slice(0, dot));
          examAt = item.length;
        }
      }
      if (!exam) {
        const ex = findExam(item);
        if (ex) { exam = ex.exam; examAt = ex.start; item = ex.rest; }
      }
      item = oneLine(item.replace(/·/g, ' '));
      const cefr = findCefr(item);
      const found = item ? parseLangs(item) : [];
      if (!found.length) {
        // "İngilizce, ileri" or "İngilizce C1, IELTS 7.0": completes the language before it
        if (last) {
          if (!last.level && item) last.level = levelOf(last.name, item);
          if (!last.cefr && cefr) last.cefr = cefr;
          if (!last.exam && exam) last.exam = exam;
        }
        return;
      }
      // a dictated run ("ingilizce ileri ielts 7 almanca orta"): the exam goes to the language before it
      let owner = found.length - 1;
      if (found.length > 1 && examAt >= 0) {
        let from = 0;
        owner = 0;
        found.forEach((l, i) => {
          const at = l.raw ? item.indexOf(oneLine(l.raw), from) : -1;
          if (at >= 0) { from = at + 1; if (at < examAt) owner = i; }
        });
      }
      found.forEach((l, i) => {
        const d = {
          name: cleanLangName(l.name),
          level: clampLevel(l.level),
          cefr: found.length === 1 ? cefr : findCefr(l.raw),
          exam: i === owner ? exam : '',
        };
        if (!d.name) return;
        const k = keyStr(trLower(d.name));
        const prev = byKey[k];
        if (prev) {
          if (!prev.level) prev.level = d.level;
          if (!prev.cefr) prev.cefr = d.cefr;
          if (!prev.exam) prev.exam = d.exam;
          last = prev;
          return;
        }
        byKey[k] = d;
        out.push(d);
        last = d;
      });
    });
    return out;
  }

  function langsFromAI(list, lang) {
    const levels = lang === 'en' ? LEVEL_EN : LEVEL_TR;
    return arr(list).filter((l) => l && typeof l === 'object').map((l) => {
      const name = cleanLangName(l.name);
      if (!name) return '';
      const cefr = cefrOf(l.cefr);
      const lv = clampLevel(l.level) || (cefr ? CEFR_LEVEL[cefr] : 0);
      const exam = cleanExam(l.exam);
      return name + (lv ? ' ' + levels[lv] : '') + (cefr ? ' (' + cefr + ')' : '') + (exam ? ' · ' + exam : '');
    }).filter(Boolean).join(', ');
  }

  /**
   * Uygulama modeli → yapay zekâ şeması (AICV), en az veriyle: telefon, e-posta, referanslar,
   * doğum, askerlik ve medeni durum hiç gönderilmez (cihazda kalır); fotoğraf zaten gönderilmez.
   */
  function toAI(cv) {
    const c = cv || {};
    const sk = skillsToAI(s(c.skills));
    return {
      name: s(c.name), title: s(c.title), phone: '', email: '', city: s(c.city),
      web: s(c.web), github: s(c.github), summary: s(c.summary),
      jobs: arr(c.jobs).filter((j) => j && hasAny(j, ['role', 'company', 'city', 'start', 'end', 'desc'])).map((j) => ({
        company: s(j.company), role: s(j.role), city: s(j.city), start: s(j.start), end: s(j.end), bullets: splitLines(s(j.desc)),
      })),
      edu: arr(c.edu).filter((e) => e && hasAny(e, ['school', 'program', 'degree', 'start', 'end', 'note'])).map((e) => ({
        school: s(e.school), program: s(e.program), degree: s(e.degree), start: s(e.start), end: s(e.end), note: s(e.note),
      })),
      projects: arr(c.projects).filter((p) => p && hasAny(p, ['name', 'tech', 'link', 'desc'])).map((p) => ({
        name: s(p.name), tech: s(p.tech), link: s(p.link), bullets: splitLines(s(p.desc)),
      })),
      skills: sk.skills,
      skillGroups: sk.skillGroups,
      langs: langsToAI(s(c.langs)),
      certs: splitLines(s(c.certs)), hobbies: splitList(s(c.hobbies)), refs: [],
      birth: '', military: '', license: s(c.license), marital: '',
    };
  }

  let uidN = 0;
  const uid = () => 'a' + Date.now().toString(36) + (uidN++).toString(36);
  const lines = (v) => strList(v).join('\n');
  const noProto = (v) => s(v).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');

  // A scrub placeholder never belongs in a CV. If the model copies one from a scrubbed answer into a
  // field ("telefonum [telefon]" → phone "[telefon]"), it is dropped, so the device value is kept.
  const MARK_RE = /[^\S\n]*\[(?:kimlik no|telefon|e-posta|IBAN)\][^\S\n]*/gi;
  function unmark(v, depth) {
    if (typeof v === 'string') {
      if (v.indexOf('[') < 0) return v;
      return v.replace(MARK_RE, ' ').split('\n').map((l) => l.replace(/[^\S\n]{2,}/g, ' ').trim()).join('\n').trim();
    }
    if (depth > 4 || !v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((it) => unmark(it, depth + 1));
    const out = {};
    Object.keys(v).forEach((k) => { out[k] = unmark(v[k], depth + 1); });
    return out;
  }

  /**
   * Yapay zekâ şeması → uygulama modeli. Fotoğraf her zaman önceki CV'den gelir. Cihazda kalan alanlar
   * (DEVICE_FIELDS) önceki CV'de doluysa korunur; boşsa yapay zekânın değeri alınır (ör. cevapta
   * söylenen ve temizleyicinin kaçırdığı bir telefon numarası).
   */
  function fromAI(a, prev, lang) {
    const x = (a && typeof a === 'object' && unmark(a, 0)) || {};
    const p = prev || {};
    const kept = (k, aiValue) => (typeof p[k] === 'string' && p[k].trim() ? p[k] : aiValue);
    return {
      name: s(x.name), title: s(x.title), phone: kept('phone', s(x.phone)), email: kept('email', s(x.email).toLowerCase()), city: s(x.city),
      web: noProto(x.web), github: noProto(x.github), photo: typeof p.photo === 'string' ? p.photo : '', summary: s(x.summary),
      jobs: arr(x.jobs).filter((j) => j && typeof j === 'object').map((j) => ({
        id: uid(), role: s(j.role), company: s(j.company), city: s(j.city), start: s(j.start), end: s(j.end), desc: lines(j.bullets),
      })).filter((j) => hasAny(j, ['role', 'company', 'desc'])),
      edu: arr(x.edu).filter((e) => e && typeof e === 'object').map((e) => ({
        id: uid(), school: s(e.school), program: s(e.program), degree: s(e.degree), start: s(e.start), end: s(e.end), note: s(e.note),
      })).filter((e) => hasAny(e, ['school', 'program', 'degree'])),
      projects: arr(x.projects).filter((q) => q && typeof q === 'object').map((q) => ({
        id: uid(), name: s(q.name), tech: s(q.tech), link: noProto(q.link), desc: lines(q.bullets),
      })).filter((q) => hasAny(q, ['name', 'desc'])),
      skills: skillsFromAI(x),
      langs: langsFromAI(x.langs, lang),
      certs: lines(x.certs), hobbies: strList(x.hobbies).join(', '), refs: kept('refs', lines(x.refs)),
      birth: kept('birth', s(x.birth)), military: kept('military', s(x.military)), license: s(x.license), marital: kept('marital', s(x.marital)),
    };
  }

  readCodeFromUrl();

  root.CVAI = { API_URL, call, toAI, fromAI, getCode, setCode, scrub, DEVICE_FIELDS: DEVICE_FIELDS.slice() };
})(typeof globalThis !== 'undefined' ? globalThis : this);
