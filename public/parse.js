/*
 * parse.js — CVParse
 * Turns raw Turkish speech-recognition segments (and typed input) into clean CV field values,
 * and parses free lists for the PDF. Classic script, no dependencies, attaches `CVParse`.
 *
 * Notes for maintainers:
 *  - No regex lookbehind is used (Safari < 16.4 would refuse to parse the whole file).
 *  - Turkish casing is done by hand (I→ı, İ→i, i→İ, ı→I) because some engines lack the tr locale.
 *  - Every normalizer is idempotent: feeding its own output back returns the same string.
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------------------------------
  // small helpers
  // ------------------------------------------------------------------------------------------
  function str(s) { return s == null ? '' : String(s); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function nfc(s) { return typeof s.normalize === 'function' ? s.normalize('NFC') : s; }

  var LETTER = /\p{L}/u;
  var WORDCHAR = /[\p{L}\p{M}\p{N}_]/u;

  // whole-word "ve" used as a list separator ("Excel ve Word", also next to , or ;)
  var VE_SEPARATOR = /(^|[\s,;])ve(?=[\s,;]|$)/gi;

  function isLetter(ch) { return !!ch && LETTER.test(ch); }
  function isWordChar(ch) { return !!ch && WORDCHAR.test(ch); }
  function lettersOf(s) { return str(s).replace(/[^\p{L}]/gu, ''); }

  // ------------------------------------------------------------------------------------------
  // Casing / text
  // ------------------------------------------------------------------------------------------
  function trLower(s) {
    s = nfc(str(s));
    // "i̇" (i + combining dot, produced by a plain toLowerCase of "İ" elsewhere) → "i"
    return s.replace(/I/g, 'ı').replace(/İ/g, 'i').toLowerCase().replace(/i̇/g, 'i');
  }

  function trUpper(s) {
    s = nfc(str(s));
    return s.replace(/i/g, 'İ').replace(/ı/g, 'I').toUpperCase();
  }

  function isUpperChar(ch) { return ch !== trLower(ch) && ch === trUpper(ch); }

  // Characters capFirst skips before the first letter. Opening brackets are skipped too so that
  // "(eski) ..." becomes "(Eski) ...". If the first significant character is not a letter
  // (e.g. a digit: "2019 yılında"), the string is returned unchanged.
  var CAP_SKIP = /[\s"'“”‘’«»„‚‹›`´([{]/;

  // Index just past the letter at s[i]. "i" + U+0307 (a non-Turkish toLowerCase of "İ") counts as
  // one letter, so uppercasing it drops the combining dot instead of rendering "İ̇" (two dots).
  function letterEnd(s, i) {
    return s.charAt(i) === 'i' && s.charAt(i + 1) === '̇' ? i + 2 : i + 1;
  }

  function capFirst(s) {
    s = str(s);
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (CAP_SKIP.test(ch)) continue;
      if (isLetter(ch)) return s.slice(0, i) + trUpper(ch) + s.slice(letterEnd(s, i));
      return s;
    }
    return s;
  }

  var SMALL_WORDS = {
    've': 1, 'ile': 1, 'veya': 1, 'ya': 1, 'da': 1, 'de': 1, 'ki': 1, 'için': 1,
    'of': 1, 'and': 1, 'the': 1, 'in': 1, 'at': 1, 'for': 1, '&': 1
  };

  // Keep a word (or hyphen part) as typed when it is an acronym (all upper, ≤5 letters: ODTÜ,
  // İTÜ, SAP, IT) or has deliberate inner capitals (iPhone, LinkedIn, McKinsey, ODTÜ'de).
  // An all-upper word longer than 5 letters ("YILMAZ") is shouting, not an acronym → normal casing.
  function keepCasing(letters) {
    if (!letters) return false;
    var allUpper = letters === trUpper(letters) && letters !== trLower(letters);
    if (allUpper) return letters.length <= 5;
    for (var i = 1; i < letters.length; i++) {
      if (isUpperChar(letters.charAt(i))) return true;
    }
    return false;
  }

  // Dotted initials ("a.ş.", "u.s.a.") are written in capitals: "A.Ş.", "U.S.A.".
  var INITIALS = /^(?:\p{L}\.)+\p{L}?$/u;

  function titleCasePart(p) {
    var letters = lettersOf(p);
    if (!letters || keepCasing(letters)) return p;
    if (letters.length >= 2 && INITIALS.test(p)) return trUpper(p);
    var m = LETTER.exec(p);
    var i = m.index;
    // Everything after the first letter is lowered, so "ali'nin" → "Ali'nin" (suffix stays lower).
    return p.slice(0, i) + trUpper(p.charAt(i)) + trLower(p.slice(letterEnd(p, i)));
  }

  // Parts joined by "/" are capitalised like hyphen parts: "satış/pazarlama" → "Satış/Pazarlama"
  // (the spec only names "-"; a slash-joined title such as "İK/Bordro Uzmanı" is just as common).
  function titleCaseWord(w, first) {
    var core = trLower(w).replace(/[^\p{L}&]/gu, '');
    if (!first && has(SMALL_WORDS, core) && !keepCasing(lettersOf(w))) return trLower(w);
    return w.split(/([-\/])/).map(titleCasePart).join('');
  }

  // "First" (for the small-word rule) means the first word of each line.
  function titleCase(s) {
    var parts = str(s).split(/(\s+)/);
    var first = true;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      if (/^\s+$/.test(p)) {
        if (p.indexOf('\n') >= 0) first = true;
        continue;
      }
      parts[i] = titleCaseWord(p, first);
      first = false;
    }
    return parts.join('');
  }

  // Collapses horizontal whitespace runs to one space and trims every line. Line breaks are kept
  // (CRLF/CR become LF); leading/trailing empty lines are dropped as well.
  function cleanSpaces(s) {
    return str(s).replace(/\r\n?/g, '\n').split('\n').map(function (line) {
      return line.replace(/[^\S\n]+/g, ' ').trim();
    }).join('\n').replace(/^\n+|\n+$/g, '');
  }

  // Single-line variant used by single-value fields (name, title, city, phone, date): any
  // whitespace, newlines included, becomes one space.
  function oneLine(s) { return str(s).replace(/\s+/g, ' ').trim(); }

  var FOLD = {
    'ç': 'c', 'Ç': 'C', 'ğ': 'g', 'Ğ': 'G', 'ı': 'i', 'İ': 'I', 'ö': 'o', 'Ö': 'O',
    'ş': 's', 'Ş': 'S', 'ü': 'u', 'Ü': 'U', 'â': 'a', 'Â': 'A', 'î': 'i', 'Î': 'I',
    'û': 'u', 'Û': 'U'
  };

  function foldAscii(s) {
    return nfc(str(s))
      .replace(/[çÇğĞıİöÖşŞüÜâÂîÎûÛ]/g, function (c) { return FOLD[c]; })
      .replace(/([iI])̇/g, '$1');
  }

  // Length-preserving lowercase+fold of one UTF-16 unit; used to search keywords in a string and
  // map the hit positions back onto the original text.
  function keyChar(ch) {
    if (ch === 'I' || ch === 'İ' || ch === 'ı') return 'i';
    var l = ch.toLowerCase();
    if (l.length !== 1) return ch;
    return has(FOLD, l) ? FOLD[l] : l;
  }
  function keyString(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) out += keyChar(s.charAt(i));
    return out;
  }
  // lowercase + ASCII fold, for dictionary lookups ("İngilizce", "ingilizce", "INGILIZCE" → "ingilizce")
  function foldKey(s) { return foldAscii(trLower(str(s))); }

  function sanitizeFilePart(s, sep) {
    var t = foldAscii(str(s))
      .normalize('NFD').replace(/[̀-ͯ]/g, '')   // José → Jose
      .replace(/['’`]/g, '');                             // O'Neil → ONeil
    if (sep === '-') return t.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return t
      .replace(/[^A-Za-z0-9-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[_-]+|[_-]+$/g, '');
  }

  // Parts are joined with "_"; an empty suffix gives "Ayse_Yilmaz.pdf"; empty ext gives no dot.
  // opts.sep === '-' (optional, v2): every gap becomes one hyphen and parts are joined with "-":
  // fileName('Ayşe Kaya', 'CV Kuzey Lojistik', 'pdf', { sep: '-' }) → "Ayse-Kaya-CV-Kuzey-Lojistik.pdf".
  function fileName(name, suffix, ext, opts) {
    if (suffix == null) suffix = 'CV';
    if (ext == null) ext = 'pdf';
    var sep = opts && opts.sep === '-' ? '-' : '_';
    var parts = [sanitizeFilePart(name, sep), sanitizeFilePart(suffix, sep)].filter(Boolean);
    var base = parts.join(sep) || 'CV';
    ext = str(ext).replace(/^\.+/, '').trim();
    return ext ? base + '.' + ext : base;
  }

  // ------------------------------------------------------------------------------------------
  // Numbers
  // ------------------------------------------------------------------------------------------
  var NUMBER_WORDS = {
    'sıfır': 0, 'bir': 1, 'iki': 2, 'üç': 3, 'dört': 4, 'beş': 5, 'altı': 6, 'yedi': 7,
    'sekiz': 8, 'dokuz': 9, 'on': 10, 'yirmi': 20, 'otuz': 30, 'kırk': 40, 'elli': 50,
    'altmış': 60, 'yetmiş': 70, 'seksen': 80, 'doksan': 90, 'yüz': 100, 'bin': 1000
  };

  function numberWordValue(w) {
    var k = trLower(w);
    if (has(NUMBER_WORDS, k)) return NUMBER_WORDS[k];
    k = w.toLowerCase(); // "IKI", "BIR" typed on an English keyboard
    if (has(NUMBER_WORDS, k)) return NUMBER_WORDS[k];
    return -1;
  }

  // Applies the slot rules to a run of number-word values and returns the numbers it forms.
  function slotNumbers(vals) {
    var out = [];
    var cur = null; // {t, h, te, o}; null = no number in progress

    function flush() {
      if (!cur) return;
      out.push((cur.t || 0) * 1000 + (cur.h || 0) * 100 + (cur.te || 0) + (cur.o || 0));
      cur = null;
    }
    function groupEmpty(c) { return c.h === null && c.te === null && c.o === null; }
    function groupValue(c) { return (c.h || 0) * 100 + (c.te || 0) + (c.o || 0); }
    function fits(c, v) {
      if (v >= 1 && v <= 9) return c.o === null;
      if (v >= 10 && v <= 90) return c.te === null && c.o === null;
      if (v === 100) {
        return groupEmpty(c) || (c.h === null && c.te === null && c.o !== null && c.o >= 2 && c.o <= 9);
      }
      if (v === 1000) return c.t === null;
      return false;
    }
    function put(c, v) {
      if (v >= 1 && v <= 9) c.o = v;
      else if (v >= 10 && v <= 90) c.te = v;
      else if (v === 100) {
        if (groupEmpty(c)) c.h = 1;
        else { c.h = c.o; c.o = null; }
      } else if (v === 1000) {
        c.t = groupEmpty(c) ? 1 : groupValue(c);
        c.h = c.te = c.o = null;
      }
    }

    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (v === 0) { flush(); out.push(0); continue; } // "sıfır" is always its own number
      if (cur && !fits(cur, v)) flush();
      if (!cur) cur = { t: null, h: null, te: null, o: null };
      put(cur, v);
    }
    flush();
    return out;
  }

  // Whole words only: a number word must be a complete run of letters, not glued to other
  // letters/digits ("onur", "bina", "yedinci", "birlikte", "4bir" untouched). An apostrophe
  // suffix is fine: "dokuz'da" → "9'da". Words in one run must be separated by spaces/tabs only.
  function wordsToNumbers(s) {
    s = str(s);
    var re = /[\p{L}\p{M}\p{N}_]+/gu;
    var m, words = [];
    while ((m = re.exec(s)) !== null) {
      var v = numberWordValue(m[0]);
      if (v >= 0) words.push({ start: m.index, end: m.index + m[0].length, v: v });
    }
    if (!words.length) return s;

    var runs = [], run = [words[0]];
    for (var i = 1; i < words.length; i++) {
      var gap = s.slice(words[i - 1].end, words[i].start);
      if (/^[^\S\n]+$/.test(gap)) run.push(words[i]);
      else { runs.push(run); run = [words[i]]; }
    }
    runs.push(run);

    var out = '', pos = 0;
    runs.forEach(function (r) {
      var nums = slotNumbers(r.map(function (w) { return w.v; }));
      out += s.slice(pos, r[0].start) + nums.join(' ');
      pos = r[r.length - 1].end;
    });
    return out + s.slice(pos);
  }

  // ------------------------------------------------------------------------------------------
  // Field normalizers
  // ------------------------------------------------------------------------------------------
  function stripTrailingPunct(s) { return s.replace(/[\s.,;:!?…\-–—]+$/, ''); }

  // Person names: when no word of 2+ letters contains a lowercase letter ("AYŞE YILMAZ", caps-lock
  // or a form copied in capitals) the name is lowered first; otherwise "AYŞE" (≤5 letters) would
  // be kept as an "acronym". Names essentially never contain acronyms; titles and cities do (IT,
  // SAP, ABD), so normalizeTitle/normalizeCity follow titleCase exactly. Single-letter words are
  // ignored by the test so the rule gives the same answer on its own output (idempotence).
  function isShouting(t) {
    var words = t.split(' '), cased = false;
    for (var i = 0; i < words.length; i++) {
      var l = lettersOf(words[i]);
      if (l !== trLower(l)) cased = true;
      if (l.length >= 2 && l !== trUpper(l)) return false;
    }
    return cased;
  }
  function normalizeName(s) {
    var t = stripTrailingPunct(oneLine(s));
    if (isShouting(t)) t = trLower(t);
    return titleCase(t);
  }

  function normalizeTitle(s) {
    return titleCase(stripTrailingPunct(oneLine(s)));
  }

  function normalizeCity(s) {
    return titleCase(stripTrailingPunct(oneLine(s)));
  }

  // Spoken tokens are matched against whole whitespace-delimited tokens, so a typed address such
  // as "ahmet.at@gmail.com" is never touched and "Ahmet" keeps its "et".
  var EMAIL_TOKENS = [
    ['et işareti', '@'], ['at işareti', '@'],
    ['alt çizgi', '_'], ['alt tire', '_'], ['kısa çizgi', '-'],
    ['et', '@'], ['at', '@'], ['nokta', '.'], ['dot', '.'], ['underscore', '_'],
    ['tire', '-'], ['eksi', '-']
  ];
  // URLs: same tokens without "et/at", plus slashes. "iki nokta" is deliberately NOT a token here
  // ("ayşe iki nokta com" is far more likely "ayse2.com" than a colon); a dictated protocol
  // ("https iki nokta slash slash ...") is removed up front instead.
  var URL_TOKENS = [
    ['eğik çizgi', '/'],
    ['alt çizgi', '_'], ['alt tire', '_'], ['kısa çizgi', '-'],
    ['slash', '/'], ['bölü', '/'], ['taksim', '/'],
    ['nokta', '.'], ['dot', '.'], ['underscore', '_'], ['tire', '-'], ['eksi', '-']
  ];

  function compileTokens(list) {
    return list.map(function (p) {
      return { words: p[0].split(' ').map(foldKey), out: p[1] };
    }).sort(function (a, b) { return b.words.length - a.words.length; });
  }
  var EMAIL_TOKENS_C = compileTokens(EMAIL_TOKENS);
  var URL_TOKENS_C = compileTokens(URL_TOKENS);

  function replaceSpokenTokens(s, table) {
    var toks = s.split(/\s+/).filter(Boolean);
    var keys = toks.map(foldKey);
    var out = [];
    for (var i = 0; i < toks.length;) {
      var hit = null;
      for (var j = 0; j < table.length && !hit; j++) {
        var w = table[j].words, ok = i + w.length <= toks.length;
        for (var k = 0; ok && k < w.length; k++) ok = keys[i + k] === w[k];
        if (ok) hit = table[j];
      }
      if (hit) { out.push(hit.out); i += hit.words.length; }
      else { out.push(toks[i]); i++; }
    }
    return out.join('');
  }

  // The trailing dot is a sentence dot only once the address is complete ("…gmail.com." →
  // "…gmail.com"). While it is still being dictated, a pause right after "nokta" leaves the field
  // at "ayse." / "ayse@gmail." and the next segment is appended to that stored value; stripping
  // the dot there would lose it for good ("ayse" + "yılmaz…" → "ayseyilmaz@…", "gmail" + "com" →
  // "gmailcom"). `complete(rest)` gets the address without its trailing dots.
  function stripFinalDot(t, complete) {
    var m = /\.+$/.exec(t);
    if (!m) return t;
    var rest = t.slice(0, m.index);
    return complete(rest) ? rest : rest + '.';
  }
  function emailComplete(a) { var at = a.lastIndexOf('@'); return at >= 0 && a.indexOf('.', at) > at; }
  function urlComplete(a) { return a.indexOf('.') >= 0; }

  // Typed addresses only get lowercased/trimmed in practice; foldAscii is still applied because
  // Turkish letters in an e-mail address are almost always a typing slip ("ayşe@" → "ayse@").
  function normalizeEmail(s) {
    var t = replaceSpokenTokens(trLower(s), EMAIL_TOKENS_C);
    t = foldAscii(t).replace(/\s+/g, '').replace(/\.{2,}/g, '.');
    return stripFinalDot(t, emailComplete);
  }

  // A trailing sentence dot is removed (as for e-mail); a trailing slash is kept (it is valid).
  function normalizeUrl(s) {
    var t = trLower(s).trim().replace(/^https?\s+iki\s+nokta\s+/, '');
    t = replaceSpokenTokens(t, URL_TOKENS_C);
    t = foldAscii(t).replace(/\s+/g, '').replace(/\.{2,}/g, '.');
    t = t.replace(/^(?:https?:?)?\/\//, '').replace(/^www\./, '');
    return stripFinalDot(t, urlComplete);
  }

  function fmtTr11(d) { // "05321234567" → "0532 123 45 67"
    return d.slice(0, 4) + ' ' + d.slice(4, 7) + ' ' + d.slice(7, 9) + ' ' + d.slice(9, 11);
  }

  // "+90" dictated in words: "artı doksan beş yüz otuz iki …". The slot rules read
  // "doksan beş | yüz otuz iki" (95 132), but a ones word directly before "yüz" is that hundred's
  // multiplier ("beş yüz" = 500), so it cannot also be the ones digit of "doksan". When the FIRST
  // number words of the answer are "doksan <2–9> yüz", "doksan" is written as "90" so the area
  // code stays whole. "artı doksan sekiz" (+98, Iran) and "doksan bir …" are not touched.
  function spokenCountryCode(t) {
    var re = /[\p{L}\p{M}\p{N}_]+/gu, m, w = [];
    while (w.length < 3 && (m = re.exec(t)) !== null) {
      if (/^\d/.test(m[0])) return t;              // digits come first: nothing to repair
      var v = numberWordValue(m[0]);
      if (v < 0) { if (w.length) return t; continue; } // leading filler ("telefonum", "artı")
      if (w.length && !/^[^\S\n]+$/.test(t.slice(w[w.length - 1].end, m.index))) return t;
      w.push({ start: m.index, end: m.index + m[0].length, v: v });
    }
    if (w.length === 3 && w[0].v === 90 && w[1].v >= 2 && w[1].v <= 9 && w[2].v === 100) {
      return t.slice(0, w[0].start) + '90' + t.slice(w[0].end);
    }
    return t;
  }

  // A leading spoken "artı" means "+". Numbers that start with "+" are only reformatted when they
  // are Turkish (+90 + 10 digits); "+49 151 ..." is never mistaken for a Turkish 10-digit number.
  function normalizePhone(s) {
    var t = oneLine(s);
    if (/^art[ıi]\s/i.test(t)) t = '+' + t.slice(5);
    t = oneLine(wordsToNumbers(spokenCountryCode(t)));
    var plus = t.charAt(0) === '+';
    var d = t.replace(/\D/g, '');
    if (d.length === 12 && d.slice(0, 2) === '90') {
      return '+90 ' + d.slice(2, 5) + ' ' + d.slice(5, 8) + ' ' + d.slice(8, 10) + ' ' + d.slice(10, 12);
    }
    if (!plus && d.length === 11 && d.charAt(0) === '0') return fmtTr11(d);
    if (!plus && d.length === 10 && /^[2-5]/.test(d)) return fmtTr11('0' + d);
    return t;
  }

  // ---- dates
  var MONTHS_TR = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos',
    'Eylül', 'Ekim', 'Kasım', 'Aralık'];
  var MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // folded prefixes; a word STARTING with one counts ("mayısta", "eylülde", "Mart'ta" → "mart")
  var MONTH_PREFIX_TR = MONTHS_TR.map(foldKey);
  var MONTH_EN_WORDS = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
    june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
    october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12
  };

  // Present keywords, folded. Exact words, except the ones in PRESENT_PREFIX which also accept
  // Turkish/English suffixes ("günümüze", "şimdiki", "currently", "devamında"). "present" is
  // exact so that "presentation" does not count. "şu an" (also "şu anda", "şu ana kadar") is
  // matched as two words.
  var PRESENT_EXACT = { hala: 1, halen: 1, suan: 1, suanda: 1, present: 1, presently: 1, now: 1, still: 1 };
  var PRESENT_PREFIX = ['devam', 'gunumuz', 'simdi', 'current'];
  var SU_AN_NEXT = { an: 1, anda: 1, ana: 1, anki: 1 };

  function hasPresentKeyword(s) {
    var toks = foldKey(s).match(/[\p{L}\p{N}]+/gu) || [];
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (has(PRESENT_EXACT, t)) return true;
      for (var j = 0; j < PRESENT_PREFIX.length; j++) {
        if (t.indexOf(PRESENT_PREFIX[j]) === 0) return true;
      }
      if (t === 'su' && has(SU_AN_NEXT, toks[i + 1] || '')) return true;
    }
    return false;
  }

  function monthOfWord(word, haveYear) {
    var w = foldKey(word);
    for (var j = 0; j < 12; j++) {
      if (w.indexOf(MONTH_PREFIX_TR[j]) === 0) return j + 1;
    }
    if (has(MONTH_EN_WORDS, w) && (w !== 'may' || haveYear)) return MONTH_EN_WORDS[w];
    return 0;
  }

  // "iki bin on dokuzda", "iki bin yirmide", "bin dokuz yüz doksan sekizde": spoken Turkish glues
  // the case suffix to the last number word, which wordsToNumbers (whole words only) then skips —
  // the year silently became 2010 / 2000 / 1990. In a date answer only, a known suffix is split
  // off a number word that directly follows another number word ("dokuzda" → "dokuz'da", which
  // wordsToNumbers reads as "9'da"). Ordinals ("onuncu") and other words are never touched.
  var NUM_SUFFIX = /^(?:[dt][ae]n?|[dt][ae]ki|y?[ae]|y?[ıiuü]|n?[ıiuü]n|n?[ıiuü]nd[ae]n?|[dt][ıiuü]r?|y?l[ae])$/;
  var NUMBER_KEYS = Object.keys(NUMBER_WORDS).sort(function (a, b) { return b.length - a.length; });
  function suffixedNumberStem(w) { // → length of the number-word stem of w, or 0
    var lw = trLower(w);
    for (var i = 0; i < NUMBER_KEYS.length; i++) {
      var k = NUMBER_KEYS[i];
      if (lw.length > k.length && lw.indexOf(k) === 0 && NUM_SUFFIX.test(lw.slice(k.length))) return k.length;
    }
    return 0;
  }
  function splitNumberSuffix(s) {
    var re = /[\p{L}\p{M}\p{N}_]+/gu, m, out = '', pos = 0, prevEnd = -1;
    while ((m = re.exec(s)) !== null) {
      if (numberWordValue(m[0]) >= 0) { prevEnd = m.index + m[0].length; continue; }
      var n = prevEnd >= 0 && /^[^\S\n]+$/.test(s.slice(prevEnd, m.index)) ? suffixedNumberStem(m[0]) : 0;
      if (n) { out += s.slice(pos, m.index + n) + "'"; pos = m.index + n; }
      prevEnd = -1;
    }
    return out + s.slice(pos);
  }

  // A year finished in a later segment: once "iki bin" is stored as "2000", appending "on sekiz"
  // gives "2000 18". The number right after a round year continues it when it fits the year's
  // empty slots, as in wordsToNumbers: "2000 18" → 2018, "1900 98" → 1998, "2010 8" → 2018.
  // "2010 12" and "2019 5" do not fit and are left alone.
  function continueYear(t) {
    return t.replace(/(^|\D)((?:19|20)\d\d) ([1-9]\d?)(?![\d.,\/:-])/, function (all, pre, y, n) {
      var yy = +y, nn = +n;
      return yy % 100 === 0 || (yy % 10 === 0 && nn < 10) ? pre + (yy + nn) : all;
    });
  }

  // → { present, month (1–12 or 0), year ('2019' or ''), text (after wordsToNumbers),
  //     clean (true when nothing but the recognised month/year/suffixes/punctuation is left) }
  function parseDateParts(s) {
    var raw = oneLine(s);
    var res = { present: false, month: 0, year: '', text: raw, clean: false };
    if (!raw) return res;
    if (hasPresentKeyword(raw)) { res.present = true; res.clean = true; return res; }

    var t = continueYear(oneLine(wordsToNumbers(splitNumberSuffix(raw))));
    var rest = t;
    res.text = t;
    // blank out [a, b) of `rest`, plus an attached suffix ("2019'da", "2019da", "Mart'ta")
    function cut(a, b) {
      var suf = /^['’]?\p{L}*/u.exec(rest.slice(b));
      b += suf ? suf[0].length : 0;
      rest = rest.slice(0, a) + ' '.repeat(b - a) + rest.slice(b);
    }

    // numeric forms: 03/2019, 3.2019, 03-2019, 15.03.2019 (→ 03.2019), 2019-03, 2019/03
    var m = /(^|\D)(\d{1,2})[./-]((?:19|20)\d{2})(?!\d)/.exec(t);
    if (m && +m[2] >= 1 && +m[2] <= 12) {
      res.month = +m[2]; res.year = m[3];
      cut(m.index + m[1].length, m.index + m[0].length);
    } else {
      m = /(^|\D)((?:19|20)\d{2})[./-](\d{1,2})(?!\d)/.exec(t);
      if (m && +m[3] >= 1 && +m[3] <= 12) {
        res.month = +m[3]; res.year = m[2];
        cut(m.index + m[1].length, m.index + m[0].length);
      }
    }

    if (!res.month) {
      // year: no trailing word boundary, so "2019'da" / "2019da" work; not part of a longer number
      m = /(^|\D)((?:19|20)\d{2})(?!\d)/.exec(t);
      if (m) {
        res.year = m[2];
        cut(m.index + m[1].length, m.index + m[0].length);
      }
      var re = /\p{L}+/gu, w;
      while ((w = re.exec(t)) !== null) {
        var mo = monthOfWord(w[0], !!res.year);
        if (mo) { res.month = mo; cut(w.index, w.index + w[0].length); break; }
      }
    }
    res.clean = !!(res.month || res.year) && !/[\p{L}\p{N}]/u.test(rest);
    return res;
  }

  // Unrecognised input is returned as capFirst of the cleaned (single-line, number-converted) text.
  function normalizeDate(s) {
    var p = parseDateParts(s);
    if (!p.text) return '';
    if (p.present) return 'Devam ediyor';
    if (p.month && p.year) return MONTHS_TR[p.month - 1] + ' ' + p.year;
    if (p.year) return p.year;
    if (p.month) return MONTHS_TR[p.month - 1];
    return capFirst(p.text);
  }

  function isEn(lang) { return /^en/i.test(str(lang)); }

  // Unlike normalizeDate (which extracts a date from a whole spoken answer), formatDate only
  // reformats a value that is entirely a date: month name / numeric form / year (with an optional
  // suffix: "2019'da") or a present keyword. Anything with extra words ("Yaz 2019",
  // "2019'dan beri", "15.03.2019") is printed as the person wrote it, trimmed, so nothing they
  // typed silently disappears from the PDF.
  // opts.numeric (optional, v2; used by the Sade template): month + year as "03/2021" instead of
  // "Mart 2021". A year alone stays "2021"; a month alone and the present keyword are unchanged.
  function formatDate(s, lang, opts) {
    var raw = str(s).trim();
    if (!raw) return '';
    var en = isEn(lang);
    var p = parseDateParts(raw);
    var names = en ? MONTHS_EN : MONTHS_TR;
    if (p.present) return en ? 'Present' : 'Günümüz';
    if (!p.clean) return raw;
    if (p.month && p.year) {
      if (opts && opts.numeric) return (p.month < 10 ? '0' : '') + p.month + '/' + p.year;
      return names[p.month - 1] + ' ' + p.year;
    }
    if (p.year) return p.year;
    return names[p.month - 1];
  }

  function formatRange(start, end, lang, opts) {
    var a = formatDate(start, lang, opts), b = formatDate(end, lang, opts);
    if (a && b) return a + ' – ' + b;
    return a || b || '';
  }

  // ------------------------------------------------------------------------------------------
  // Speech segments
  // ------------------------------------------------------------------------------------------
  // Besides the spec'd words, "noktalı virgül" → ";" and "üç nokta" → "..." are recognised, so
  // they do not come out as "noktalı," / "üç nokta". "nokta" also counts as last word when it is
  // directly followed by a line-break command ("bitti nokta yeni satır").
  var PUNCT_PHRASES = compileTokens([
    ['soru işareti', '?'], ['ünlem işareti', '!'], ['noktalı virgül', ';'], ['iki nokta', ':'],
    ['üç nokta', '...'], ['yeni satır', '\n'], ['alt satır', '\n'], ['ünlem', '!'], ['virgül', ',']
  ]);
  var NEWLINE_CMDS = [['yeni', 'satir'], ['alt', 'satir']];

  function isNewlineAt(keys, i) {
    if (keys[i] === '\n') return true;
    for (var j = 0; j < NEWLINE_CMDS.length; j++) {
      if (keys[i] === NEWLINE_CMDS[j][0] && keys[i + 1] === NEWLINE_CMDS[j][1]) return true;
    }
    return false;
  }

  function applySpokenPunctuation(s) {
    // One space after , ; : ? ! when a letter follows directly (typed "merhaba,dünya"). Not
    // after "." — that would break "gmail.com", "A.Ş." — and not before digits ("3,5", "10:30").
    // Done before tokenising so a re-run sees exactly the same tokens (idempotence).
    var src = str(s).replace(/\r\n?/g, '\n').replace(/([,;:?!])(?=\p{L})/gu, '$1 ');
    var toks = src.match(/\n|[^\s]+/g) || [];
    var keys = toks.map(function (t) { return t === '\n' ? t : foldKey(t); });
    var out = [];
    for (var i = 0; i < toks.length;) {
      var hit = null;
      for (var j = 0; j < PUNCT_PHRASES.length && !hit; j++) {
        var w = PUNCT_PHRASES[j].words, ok = i + w.length <= toks.length;
        for (var k = 0; ok && k < w.length; k++) ok = keys[i + k] === w[k];
        if (ok) hit = PUNCT_PHRASES[j];
      }
      if (hit) { out.push({ p: hit.out }); i += hit.words.length; continue; }
      if (keys[i] === 'nokta' && (i === toks.length - 1 || isNewlineAt(keys, i + 1))) {
        out.push({ p: '.' }); i++; continue;
      }
      if (toks[i] === '\n') out.push({ p: '\n' });
      else if (/^[,.;:!?…]+$/.test(toks[i])) out.push({ p: toks[i] }); // typed " , " → attach
      else out.push({ w: toks[i] });
      i++;
    }
    var res = '';
    out.forEach(function (o) {
      if (o.w !== undefined) {
        if (res && res.charAt(res.length - 1) !== '\n') res += ' ';
        res += o.w;
      } else {
        res = res.replace(/[^\S\n]+$/, '') + o.p; // no space before , . ? ! : (or a line break)
      }
    });
    return cleanSpaces(res);
  }

  var BULLET_RE = /^(?:[-•*·–—▪◦‣●○■□►➢✓✔]+\s*|\d{1,2}[.)-](?:\s+|$)|\d{1,2}\)\s*)/;
  function stripBullet(line) {
    var prev;
    line = str(line).trim();
    do { prev = line; line = line.replace(BULLET_RE, '').trim(); } while (line !== prev);
    return line;
  }

  function hasInnerCapital(s) {
    var letters = lettersOf(s);
    for (var i = 1; i < letters.length; i++) if (isUpperChar(letters.charAt(i))) return true;
    return false;
  }

  function hasContent(s) { return /[\p{L}\p{N}]/u.test(s); }

  function normSentences(seg) {
    var t = capFirst(applySpokenPunctuation(seg));
    if (!t) return '';
    if (/[.!?…]["'”’»)\]]*$/.test(t)) return t;
    return t.replace(/[\s,;:]+$/, '') + '.';
  }

  // Each resulting line (a spoken "yeni satır" can create several) gets bullet-stripping + capFirst.
  function normLines(seg) {
    return applySpokenPunctuation(seg).split('\n').map(stripBullet).filter(Boolean)
      .map(capFirst).join('\n');
  }

  // Items are split on , ; and line breaks. Each item also loses leading bullets and a trailing
  // sentence dot (a spoken "nokta" at the end of an item included), as in splitList: a list
  // needs no full stops, and this keeps the result stable when normalised again.
  // Items without any letter or digit (a stray "!") are dropped.
  function cleanListItem(it) {
    for (var i = 0, prev = null; i < 8 && it !== prev; i++) {
      prev = it;
      it = stripItemDot(stripBullet(applySpokenPunctuation(it)));
    }
    return it;
  }
  function normList(seg) {
    var t = applySpokenPunctuation(seg).replace(VE_SEPARATOR, '$1,');
    return t.split(/[,;\n]/).map(cleanListItem).filter(hasContent).map(function (it) {
      return hasInnerCapital(it) ? it : capFirst(it);
    }).join(', ');
  }

  // Unknown types are treated like "text".
  function normalizeSegment(type, seg) {
    switch (str(type).toLowerCase()) {
      case 'name': return normalizeName(seg);
      case 'title': return normalizeTitle(seg);
      case 'city': return normalizeCity(seg);
      case 'email': return normalizeEmail(seg);
      case 'url': return normalizeUrl(seg);
      case 'phone': return normalizePhone(seg);
      case 'date': return normalizeDate(seg);
      case 'sentences': return normSentences(seg);
      case 'lines': return normLines(seg);
      case 'list': return normList(seg);
      default: return capFirst(cleanSpaces(seg));
    }
  }

  // A segment that normalises to nothing meaningful (only punctuation, e.g. a lone "nokta" after
  // a pause) leaves the field unchanged instead of appending " .".
  function mergeSegment(type, current, seg, opts) {
    var cur = str(current);
    var s = str(seg);
    if (!s.trim()) return cur;
    var t = str(type).toLowerCase();
    var append = !!(opts && opts.append);
    var n;
    if (t === 'sentences' || t === 'lines' || t === 'list') {
      n = normalizeSegment(t, s);
      if (!hasContent(n)) return cur;
      if (!cur.trim()) return n;
      if (t === 'sentences') {
        var c = cur.replace(/[^\S\n]+$/, '');
        return c + (c.charAt(c.length - 1) === '\n' ? '' : ' ') + n;
      }
      if (t === 'lines') return cur.replace(/\s+$/, '') + '\n' + n;
      return cur.replace(/[\s,;]+$/, '') + ', ' + n;
    }
    if (append && cur.trim()) return normalizeSegment(t, cur + ' ' + s);
    return normalizeSegment(t, s);
  }

  var COMMANDS = {
    next: ['tamam', 'devam', 'devam et', 'sonraki', 'sonraki soru', 'ileri', 'geçelim', 'bitti',
      'bu kadar', 'tamamdır'],
    skip: ['atla', 'geç', 'boş bırak', 'pas', 'pas geç'],
    back: ['geri', 'geri dön', 'önceki', 'önceki soru'],
    clear: ['sil', 'temizle', 'hepsini sil'],
    undo: ['geri al', 'son kısmı sil', 'sonuncuyu sil'],
    stop: ['dur', 'durdur', 'mikrofonu kapat', 'dinlemeyi durdur'],
    yes: ['evet', 'olur', 'ekle', 'evet ekle', 'var', 'tabii', 'tabi', 'isterim', 'evet var'],
    no: ['hayır', 'yok', 'istemiyorum', 'gerek yok', 'hayır teşekkürler', 'yok teşekkürler'],
    repeat: ['tekrar oku', 'soruyu tekrarla', 'tekrar et', 'anlamadım', 'tekrar']
  };
  var COMMAND_MAP = {};
  Object.keys(COMMANDS).forEach(function (cmd) {
    COMMANDS[cmd].forEach(function (p) { COMMAND_MAP[foldKey(p)] = cmd; });
  });

  // Matching is done on the ASCII-folded form, so "hayir", "gec" also work. "lütfen" is
  // tolerated at the end and, as natural Turkish also allows, at the start ("lütfen tekrar et").
  function detectCommand(seg) {
    var k = foldKey(seg).replace(/['’`]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ').trim();
    if (!k) return null;
    if (has(COMMAND_MAP, k)) return COMMAND_MAP[k];
    k = k.replace(/ lutfen$/, '').replace(/^lutfen /, '');
    return has(COMMAND_MAP, k) ? COMMAND_MAP[k] : null;
  }

  // ------------------------------------------------------------------------------------------
  // Lists for the PDF
  // ------------------------------------------------------------------------------------------
  // A trailing sentence dot is removed from list items ("Takım çalışması." → "Takım çalışması")
  // unless the item ends in an abbreviation ("vb.", "Ltd. Şti.", "A.Ş.").
  var ABBREV = { vb: 1, vs: 1, vd: 1, ltd: 1, sti: 1, inc: 1, co: 1, corp: 1, dr: 1, prof: 1,
    doc: 1, mr: 1, mrs: 1, ms: 1, jr: 1, sr: 1, etc: 1, no: 1, st: 1 };
  function stripItemDot(it) {
    if (!/\.$/.test(it)) return it;
    var m = /([\p{L}.]*\p{L})\.+$/u.exec(it); // last word, ending in a letter ("A.Ş", "Excel")
    if (m) {
      var last = foldKey(m[1]);
      if (has(ABBREV, last) || last.indexOf('.') >= 0) return it;
    }
    return it.replace(/\.+$/, '').trim();
  }

  function splitList(s) {
    var t = str(s).replace(VE_SEPARATOR, '$1,');
    var seen = {}, out = [];
    t.split(/[,;\n\r•·|]/).forEach(function (raw) {
      var it = stripItemDot(stripBullet(oneLine(raw)));
      if (!it) return;
      var key = trLower(it);
      if (has(seen, key)) return;
      seen[key] = 1;
      out.push(it);
    });
    return out;
  }

  function splitLines(s) {
    return str(s).replace(/\r\n?/g, '\n').split('\n').map(function (l) {
      return stripBullet(l.replace(/[^\S\n]+/g, ' '));
    }).filter(Boolean);
  }

  // Level keywords (whole words). "ana dili"/"anadili" are accepted for level 5 as well, being
  // the usual inflected form ("Türkçe (ana dili)").
  var LEVEL_WORDS = [
    [5, ['ana dil', 'anadil', 'ana dilim', 'anadilim', 'ana dili', 'anadili', 'native', 'mother tongue']],
    [4, ['akıcı', 'ileri', 'ileri seviye', 'ileri düzey', 'çok iyi', 'advanced', 'fluent',
      'profesyonel', 'c1', 'c2']],
    // "orta ileri": the spoken form of "orta-ileri" (speech recognition never emits the hyphen);
    // without it "ileri" (level 4) would win as the longest keyword.
    [3, ['iyi', 'orta üstü', 'orta-ileri', 'orta ileri', 'upper intermediate', 'upper-intermediate', 'b2', 'good']],
    [2, ['orta', 'orta seviye', 'orta düzey', 'intermediate', 'b1']],
    [1, ['başlangıç', 'temel', 'az', 'biraz', 'beginner', 'basic', 'elementary', 'a1', 'a2']]
  ];
  var LEVEL_KEYS = [];
  LEVEL_WORDS.forEach(function (g) {
    g[1].forEach(function (w) { LEVEL_KEYS.push({ k: foldKey(w), level: g[0] }); });
  });
  LEVEL_KEYS.sort(function (a, b) { return b.k.length - a.k.length; }); // stable: ties keep order
  // Filler removed from the name; "seviyede", "düzeyde", "seviyesi", "düzeyi", "level" added
  // as they occur just as often as the spec'd forms.
  var FILLER_KEYS = ['seviyesinde', 'seviyede', 'seviyesi', 'seviye', 'düzeyinde', 'düzeyde',
    'düzeyi', 'düzey', 'derecede', 'olarak', 'level'].map(foldKey)
    .sort(function (a, b) { return b.length - a.length; });

  function findWhole(key, kw, taken) {
    var hits = [], from = 0, i;
    while ((i = key.indexOf(kw, from)) >= 0) {
      var e = i + kw.length;
      from = i + 1;
      if (isWordChar(key.charAt(i - 1)) || isWordChar(key.charAt(e))) continue;
      var overlap = taken.some(function (r) { return i < r[1] && e > r[0]; });
      if (!overlap) { hits.push([i, e]); taken.push([i, e]); }
    }
    return hits;
  }

  function parseLanguageItem(raw) {
    var item = oneLine(raw);
    var key = keyString(item);
    var taken = [], level = 0;
    LEVEL_KEYS.forEach(function (lk) {
      if (findWhole(key, lk.k, taken).length && !level) level = lk.level;
    });
    FILLER_KEYS.forEach(function (fk) { findWhole(key, fk, taken); });
    taken.sort(function (a, b) { return b[0] - a[0]; });
    var name = item;
    taken.forEach(function (r) { name = name.slice(0, r[0]) + ' ' + name.slice(r[1]); });
    name = oneLine(name.replace(/[()[\]{}:\-–—\/]/g, ' '));
    // A known language gets its proper spelling: titleCase alone turns "INGILIZCE" (caps lock on an
    // English keyboard) into "Ingılızce" and keeps "Ingilizce".
    var k = foldKey(name);
    name = has(TR_CANON, k) ? TR_CANON[k] : has(EN_CANON, k) ? EN_CANON[k] : titleCase(name);
    return { name: name, level: level, raw: item };
  }

  // Dictated lists have no commas: "ingilizce ileri seviye almanca başlangıç". An item is cut so
  // that each piece holds one known language name. Usually the level follows the name: cut before
  // each name after the first, and also before the first one when the text in front of it is an
  // unknown language with a level ("klingonca ileri almanca orta"). When the item opens with a
  // bare level ("ileri seviye ingilizce başlangıç seviyesinde almanca") each level belongs to the
  // name after it: cut after each name but the last. Without a known name nothing is cut.
  var LANG_NAME_KEYS = null;
  function splitLanguageRun(item) {
    if (!LANG_NAME_KEYS) {
      LANG_NAME_KEYS = Object.keys(TR_CANON).concat(Object.keys(EN_CANON))
        .sort(function (a, b) { return b.length - a.length; });
    }
    var key = keyString(item), hits = [];
    LANG_NAME_KEYS.forEach(function (k) { findWhole(key, k, hits); });
    if (!hits.length) return [item];
    hits.sort(function (a, b) { return a[0] - b[0]; });
    var head = parseLanguageItem(item.slice(0, hits[0][0]));
    var cuts;
    if (head.level && !head.name) {
      cuts = hits.slice(0, -1).map(function (h) { return h[1]; });
    } else {
      cuts = hits.slice(head.level ? 0 : 1).map(function (h) { return h[0]; });
    }
    var pieces = [], from = 0;
    cuts.concat([item.length]).forEach(function (c) {
      // separators left at a cut ("English (C1) - German (A2)") are not part of either piece
      pieces.push(oneLine(item.slice(from, c)).replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, ''));
      from = c;
    });
    return pieces.filter(Boolean);
  }

  // Language exams (v2). Matched on keyString (lower case, ASCII-folded, same length as the input),
  // so "YÖKDİL", "yokdil" and "Yökdil" all count. An exam is the name, then an optional score
  // (number with a dot or comma decimal, or a CEFR level for Goethe/DELF/DALF/DELE) and an optional
  // year, bare or in brackets: "IELTS 6.5 (2024)", "TOEFL iBT 105", "YDS 85 (2025)", "Goethe B1".
  var EXAM_RE = new RegExp('(^|[^\\p{L}\\p{N}])(toefl(?:[\\s-]*ibt)?|ielts|e-?yds|yds|yokdil|toeic|' +
    'pte(?:\\s+academic)?|goethe(?:-zertifikat)?|delf|dalf|testdaf|dele)(?![\\p{L}\\p{N}])' +
    '(?:\\s*[:\\-–]?\\s*(\\d{1,3}(?:[.,]\\d{1,2})?|[abc][12])(?![\\p{L}\\p{N}]))?' +
    '(?:\\s*\\(?\\s*((?:19|20)\\d{2})\\s*\\)?(?![\\p{L}\\p{N}]))?', 'u');
  var EXAM_NAMES = {
    'toefl ibt': 'TOEFL iBT', toefl: 'TOEFL', ielts: 'IELTS', 'e yds': 'e-YDS', eyds: 'e-YDS', yds: 'YDS',
    yokdil: 'YÖKDİL', toeic: 'TOEIC', 'pte academic': 'PTE Academic', pte: 'PTE',
    'goethe zertifikat': 'Goethe-Zertifikat', goethe: 'Goethe', delf: 'DELF', dalf: 'DALF', testdaf: 'TestDaF', dele: 'DELE'
  };
  var CEFR_RE = /(^|[^\p{L}\p{N}])([abc][12])(?![\p{L}\p{N}])/u;

  // → { exam: "IELTS 6.5 (2024)", rest: the item without it } or null.
  function findExam(item) {
    var m = EXAM_RE.exec(keyString(item));
    if (!m) return null;
    var start = m.index + m[1].length, end = m.index + m[0].length;
    var name = EXAM_NAMES[m[2].replace(/[\s-]+/g, ' ')] || m[2].toUpperCase();
    var score = m[3] ? m[3].toUpperCase() : ''; // digits are unchanged by keyString; "b1" → "B1"
    var text = name + (score ? ' ' + score : '') + (m[4] ? ' (' + m[4] + ')' : '');
    return { exam: text, rest: oneLine(item.slice(0, start) + ' ' + item.slice(end)) };
  }

  // An item that is only a level ("İngilizce, ileri") is attached to the previous language when
  // that one had no level yet; otherwise it is dropped. A language named twice is listed once
  // (its level filled in from the repeat if the first mention had none). An exam inside an item
  // ("İngilizce YDS 85 (2025)") is not part of the name; an item that is only an exam is dropped
  // here (parseLanguageDetails keeps it).
  function parseLanguages(s) {
    var out = [], byName = Object.create(null);
    splitList(s).forEach(function (item) {
      splitLanguageRun(item).forEach(function (it) {
        var ex = findExam(it);
        var p = parseLanguageItem(ex ? ex.rest : it), k = foldKey(p.name);
        if (ex) p.raw = oneLine(it);
        var prev = !p.name ? out[out.length - 1] : has(byName, k) ? byName[k] : null;
        if (prev) {
          if (!prev.level && p.level) { prev.level = p.level; prev.raw += ', ' + p.raw; }
          return;
        }
        if (!p.name) return;
        byName[k] = p;
        out.push(p);
      });
    });
    return out;
  }

  var LEVEL_LABELS = {
    tr: ['', 'Başlangıç', 'Orta', 'İyi', 'İleri', 'Ana dil'],
    en: ['', 'Beginner', 'Intermediate', 'Upper-intermediate', 'Advanced', 'Native']
  };
  function levelLabel(level, lang) {
    var n = Math.round(Number(level));
    var labels = isEn(lang) ? LEVEL_LABELS.en : LEVEL_LABELS.tr;
    return n >= 1 && n <= 5 ? labels[n] : '';
  }

  // ---- language details (v2): { name, level, cefr, exam, raw }
  // CEFR words (Jobseeker mapping, brief §3.2).
  var CEFR_LABELS = {
    tr: { A1: 'Başlangıç', A2: 'Temel', B1: 'Orta', B2: 'Orta-üst', C1: 'İleri', C2: 'Yetkin' },
    en: { A1: 'Beginner', A2: 'Elementary', B1: 'Intermediate', B2: 'Upper-intermediate', C1: 'Advanced', C2: 'Proficient' }
  };
  function cefrLabel(cefr, lang) {
    var k = str(cefr).trim().toUpperCase();
    var t = isEn(lang) ? CEFR_LABELS.en : CEFR_LABELS.tr;
    return has(t, k) ? t[k] : '';
  }

  // One language piece: the exam is cut out first (its score is not a level), then the first
  // whole-word CEFR level is read, then parseLanguageItem finds the name and the 1–5 level.
  function parseLanguageDetail(piece) {
    var ex = findExam(piece);
    var rest = ex ? ex.rest : piece;
    var cm = CEFR_RE.exec(keyString(rest));
    var p = parseLanguageItem(rest.replace(/[·•|]/g, ' '));
    return { name: p.name, level: p.level, cefr: cm ? cm[2].toUpperCase() : '', exam: ex ? ex.exam : '', raw: oneLine(piece) };
  }

  /*
   * parseLanguageDetails(s) → [{ name, level (0–5), cefr ('B2' or ''), exam ('IELTS 6.5 (2024)' or ''), raw }].
   * Items are split on commas, semicolons, new lines, "|" and "•" — not on "·", which joins a level
   * and an exam inside one item: "İngilizce ileri (C1) · IELTS 6.5 (2024), Almanca B1". A dictated
   * run without commas is cut at each known language name, as in parseLanguages. An item without a
   * language name (only a level, CEFR or exam: "İngilizce C1, IELTS 7.0") fills in what the previous
   * language is missing; a language named twice is listed once.
   */
  function parseLanguageDetails(s) {
    var out = [], byName = Object.create(null);
    // a decimal comma in a score ("YÖKDİL 82,5") is not a list separator
    str(s).replace(VE_SEPARATOR, '$1,').replace(/(\d),(\d{1,2})(?!\d)/g, '$1\u0000$2').split(/[,;\n\r•|]/).forEach(function (raw) {
      var item = stripItemDot(stripBullet(oneLine(raw.replace(/\u0000/g, ','))));
      if (!item) return;
      splitLanguageRun(item).forEach(function (piece) {
        piece = piece.replace(/^[\s·\-–—:]+|[\s·\-–—:]+$/g, '');
        if (!piece) return;
        var d = parseLanguageDetail(piece);
        if (!isLetter((d.name.match(/\p{L}/u) || [''])[0])) d.name = ''; // "5", "(2024)": no language name
        var k = foldKey(d.name);
        var prev = !d.name ? out[out.length - 1] : has(byName, k) ? byName[k] : null;
        if (prev) {
          var used = false;
          if (!prev.level && d.level) { prev.level = d.level; used = true; }
          if (!prev.cefr && d.cefr) { prev.cefr = d.cefr; used = true; }
          if (!prev.exam && d.exam) { prev.exam = d.exam; used = true; }
          if (used) prev.raw += ', ' + d.raw;
          return;
        }
        if (!d.name) return;
        byName[k] = d;
        out.push(d);
      });
    });
    return out;
  }

  /*
   * The text after the language name on a CV (no bars or dots, brief §4):
   * native → "Ana dil"; a CEFR level → "B2 (Orta-üst)"; otherwise the 1–5 level word ("İleri");
   * then the exam: "B2 (Orta-üst) · IELTS 6.5 (2024)". Nothing known → ''.
   */
  function languageDetailText(d, lang) {
    if (!d || typeof d !== 'object') return '';
    var parts = [], level = Math.round(Number(d.level)) || 0, cefr = str(d.cefr).trim().toUpperCase();
    if (level === 5) parts.push(levelLabel(5, lang));
    else if (cefrLabel(cefr, lang)) parts.push(cefr + ' (' + cefrLabel(cefr, lang) + ')');
    else if (level >= 1 && level <= 4) parts.push(levelLabel(level, lang));
    var exam = oneLine(d.exam);
    if (exam) parts.push(exam);
    return parts.join(' · ');
  }

  // The first Turkish name listed for an English name wins on the way back (Dutch → Felemenkçe).
  var LANG_PAIRS = [
    ['İngilizce', 'English'], ['Almanca', 'German'], ['Fransızca', 'French'],
    ['İspanyolca', 'Spanish'], ['İtalyanca', 'Italian'], ['Rusça', 'Russian'], ['Arapça', 'Arabic'],
    ['Türkçe', 'Turkish'], ['Kürtçe', 'Kurdish'], ['Farsça', 'Persian'], ['Azerice', 'Azerbaijani'],
    ['Çince', 'Chinese'], ['Japonca', 'Japanese'], ['Korece', 'Korean'], ['Portekizce', 'Portuguese'],
    ['Felemenkçe', 'Dutch'], ['Hollandaca', 'Dutch'], ['Yunanca', 'Greek'], ['Lehçe', 'Polish'],
    ['Ukraynaca', 'Ukrainian'], ['Bulgarca', 'Bulgarian'], ['Gürcüce', 'Georgian'],
    ['Ermenice', 'Armenian'], ['Boşnakça', 'Bosnian'], ['Arnavutça', 'Albanian'],
    ['İşaret Dili', 'Sign Language'],
    // a few more common ones
    ['İbranice', 'Hebrew'], ['Hintçe', 'Hindi'], ['İsveççe', 'Swedish'], ['Norveççe', 'Norwegian'],
    ['Danca', 'Danish'], ['Fince', 'Finnish'], ['Macarca', 'Hungarian'], ['Çekçe', 'Czech'],
    ['Rumence', 'Romanian'], ['Sırpça', 'Serbian'], ['Hırvatça', 'Croatian'], ['Latince', 'Latin'],
    ['Farsça', 'Farsi'], ['Azerice', 'Azeri'],
    // Turkic and regional languages often listed on Turkish CVs; parseLanguages also needs to
    // know them to split a comma-less dictated list ("kazakça ana dil rusça ileri")
    ['Kazakça', 'Kazakh'], ['Özbekçe', 'Uzbek'], ['Türkmence', 'Turkmen'], ['Kırgızca', 'Kyrgyz'],
    ['Tatarca', 'Tatar'], ['Zazaca', 'Zazaki'], ['Lazca', 'Laz'], ['Çerkezce', 'Circassian'],
    ['Makedonca', 'Macedonian'], ['Endonezce', 'Indonesian'], ['Urduca', 'Urdu']
  ];
  var TR_TO_EN = {}, EN_TO_TR = {}, TR_CANON = {}, EN_CANON = {};
  LANG_PAIRS.forEach(function (p) {
    var tk = foldKey(p[0]), ek = foldKey(p[1]);
    if (!has(TR_TO_EN, tk)) TR_TO_EN[tk] = p[1];
    if (!has(EN_TO_TR, ek)) EN_TO_TR[ek] = p[0];
    TR_CANON[tk] = p[0];
    EN_CANON[ek] = p[1];
  });

  // Matching is case/diacritic-insensitive ("ingilizce", "INGILIZCE"). Known names also get their
  // canonical spelling in the target language (languageName('english', 'en') → 'English');
  // unknown names are returned unchanged.
  function languageName(name, lang) {
    var s = str(name);
    var k = foldKey(oneLine(s));
    if (!k) return s;
    if (isEn(lang)) {
      if (has(TR_TO_EN, k)) return TR_TO_EN[k];
      if (has(EN_CANON, k)) return EN_CANON[k];
      return s;
    }
    if (has(EN_TO_TR, k)) return EN_TO_TR[k];
    if (has(TR_CANON, k)) return TR_CANON[k];
    return s;
  }

  var API = {
    trLower: trLower,
    trUpper: trUpper,
    capFirst: capFirst,
    titleCase: titleCase,
    cleanSpaces: cleanSpaces,
    foldAscii: foldAscii,
    fileName: fileName,
    wordsToNumbers: wordsToNumbers,
    normalizeName: normalizeName,
    normalizeTitle: normalizeTitle,
    normalizeCity: normalizeCity,
    normalizeEmail: normalizeEmail,
    normalizeUrl: normalizeUrl,
    normalizePhone: normalizePhone,
    normalizeDate: normalizeDate,
    formatDate: formatDate,
    formatRange: formatRange,
    applySpokenPunctuation: applySpokenPunctuation,
    normalizeSegment: normalizeSegment,
    mergeSegment: mergeSegment,
    detectCommand: detectCommand,
    splitList: splitList,
    splitLines: splitLines,
    parseLanguages: parseLanguages,
    parseLanguageDetails: parseLanguageDetails,
    levelLabel: levelLabel,
    cefrLabel: cefrLabel,
    languageDetailText: languageDetailText,
    languageName: languageName,
    MONTHS_TR: MONTHS_TR.slice(),
    MONTHS_EN: MONTHS_EN.slice()
  };

  root.CVParse = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
