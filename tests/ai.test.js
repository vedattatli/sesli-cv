/*
 * tests/ai.test.js — tests for public/ai.js (CVAI): the on-device scrubber (critic C3), data
 * minimisation in toAI, fromAI and its round trip, call() error handling, the access code, and the
 * test-only fake API (tests/fake-ai.js) that dev.html uses.
 *
 * The scrubber is privacy-critical, so most of this file is adversarial: TC kimlik numbers built
 * with the official checksum and written every way speech-to-text might write them, phone numbers
 * in every format, dictated and literal e-mail addresses, IBANs — and a long list of ordinary CV
 * text (years, date ranges, amounts, GNO, percentages, 11-digit numbers with a bad checksum) that
 * must come through byte for byte.
 *
 * Run from the project folder:  sh tests/run-ai.sh
 */
/* global load, print, drainMicrotasks */

// ---------------------------------------------------------------------------------------------
// Browser stubs, before any script loads
// ---------------------------------------------------------------------------------------------
globalThis.window = globalThis;
globalThis.console = { log: print, error: print, warn: print };
var store = {};
globalThis.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; }
};
// an invite link: https://…/app/?x=1#k=DAVET-42
globalThis.location = { hash: '#k=DAVET-42', search: '?x=1', pathname: '/app/' };
var replacedUrls = [];
globalThis.history = { state: null, replaceState: function (st, title, url) { replacedUrls.push(url); } };
function Response(body, init) {
  var hdr = (init && init.headers) || {};
  this._body = body;
  this.status = (init && init.status) || 200;
  this.ok = this.status >= 200 && this.status < 300;
  this.headers = { get: function (k) {
    for (var key in hdr) if (key.toLowerCase() === String(k).toLowerCase()) return hdr[key];
    return null;
  } };
}
Response.prototype.json = function () {
  var b = this._body;
  return new Promise(function (resolve, reject) { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
};
globalThis.Response = Response;
globalThis.fetch = function () { return Promise.reject(new TypeError('no network in tests')); };
// timers fire at once, so drainMicrotasks() settles every fake request
globalThis.setTimeout = function (f) { f(); return 0; };

load('tests/fake-ai.js');
var fakeFetch = globalThis.fetch;
load('public/parse.js');
load('public/ai.js');

var AI = globalThis.CVAI;
var P = globalThis.CVParse;
var passed = 0, failed = 0;

function show(v) { return v === undefined ? 'undefined' : JSON.stringify(v); }
function check(label, actual, expected) {
  if (show(actual) === show(expected)) { passed++; return; }
  failed++;
  print('FAIL ' + label + '\n     expected: ' + show(expected) + '\n     actual:   ' + show(actual));
}
function ok(label, cond, info) {
  if (cond) { passed++; return; }
  failed++;
  print('FAIL ' + label + (info === undefined ? '' : '\n     ' + show(info)));
}
function scrub(t, o) { try { return AI.scrub(t, o); } catch (e) { return { text: 'THREW ' + e, found: {}, removed: {} }; } }
function settle(promise) {
  var out = { done: false };
  promise.then(function (v) { out.done = true; out.value = v; }, function (e) { out.done = true; out.error = e; });
  drainMicrotasks();
  return out;
}
var ZERO = { tc: 0, phone: 0, email: 0, iban: 0 };
function removed(tc, phone, email, iban) { return { tc: tc || 0, phone: phone || 0, email: email || 0, iban: iban || 0 }; }

// deterministic PRNG (mulberry32), so a failure always reproduces
var seed = 0x5e511c;
function rnd() {
  seed = (seed + 0x6D2B79F5) | 0;
  var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function rint(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }
function pick(list) { return list[rint(0, list.length - 1)]; }

// ---- TC kimlik no, written independently of ai.js from the official rules
function tcFrom9(nine) {
  var d = nine.split('').map(Number);
  var d10 = (((d[0] + d[2] + d[4] + d[6] + d[8]) * 7 - (d[1] + d[3] + d[5] + d[7])) % 10 + 10) % 10;
  var sum = 0;
  for (var i = 0; i < 9; i++) sum += d[i];
  var d11 = (sum + d10) % 10;
  return nine + d10 + d11;
}
function randomTc() {
  var s = String(rint(1, 9));
  for (var i = 0; i < 8; i++) s += rint(0, 9);
  return tcFrom9(s);
}
function badTc(tc) { // same number, last digit changed → the 11th-digit check fails
  return tc.slice(0, 10) + ((Number(tc[10]) + rint(1, 9)) % 10);
}
function badTc10(tc) { // 10th digit changed and the 11th recomputed to match → only the 10th-digit check fails
  var d10 = (Number(tc[9]) + rint(1, 9)) % 10, sum = 0;
  for (var i = 0; i < 9; i++) sum += Number(tc[i]);
  return tc.slice(0, 9) + d10 + ((sum + d10) % 10);
}
// ---- Turkish number words (independent of ai.js / parse.js)
var ONES = ['', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz'];
var TENS = ['', 'on', 'yirmi', 'otuz', 'kırk', 'elli', 'altmış', 'yetmiş', 'seksen', 'doksan'];
function words3(n) { // 1..999
  var h = Math.floor(n / 100), t = Math.floor(n / 10) % 10, o = n % 10, out = [];
  if (h) out.push((h > 1 ? ONES[h] + ' ' : '') + 'yüz');
  if (t) out.push(TENS[t]);
  if (o) out.push(ONES[o]);
  return out.join(' ');
}
// a digit group as people say it: leading zeros one by one ("045" → "sıfır kırk beş")
function sayGroup(g) {
  var out = [], i = 0;
  while (i < g.length - 1 && g[i] === '0') { out.push('sıfır'); i++; }
  var rest = Number(g.slice(i));
  out.push(rest ? words3(rest) : 'sıfır');
  return out.join(' ');
}
function sayDigits(d) { return d.split('').map(function (c) { return c === '0' ? 'sıfır' : ONES[Number(c)]; }).join(' '); }
function groupsOf(d, sizes) { var out = [], i = 0; sizes.forEach(function (n) { out.push(d.slice(i, i + n)); i += n; }); return out; }
// Spoken groups are only unambiguous when no group ends in a bare tens/hundred word (last digit 0)
// and no group that ends in a lone ones word ("sıfır iki") is followed by one that starts "yüz …":
// "yüz yirmi | üç yüz" and "iki | yüz" are heard the same way as "yüz yirmi üç | yüz", "iki yüz".
function sayableGroups(groups) {
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    if (g[g.length - 1] === '0') return false;
    var next = groups[i + 1];
    if (next && Number(g) % 100 < 10 && next.length === 3 && next[0] === '1') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------------------------
['call', 'toAI', 'fromAI', 'getCode', 'setCode', 'scrub'].forEach(function (f) {
  check('CVAI.' + f + ' is a function', typeof AI[f], 'function');
});
check('CVAI.API_URL', AI.API_URL, '/api/cv');
check('CVAI.DEVICE_FIELDS', AI.DEVICE_FIELDS, ['phone', 'email', 'refs', 'birth', 'military', 'marital']);

// ---------------------------------------------------------------------------------------------
// scrub: result shape
// ---------------------------------------------------------------------------------------------
check('scrub("") shape', scrub(''), { text: '', found: { phone: '', email: '' }, removed: ZERO });
check('scrub(null)', scrub(null), { text: '', found: { phone: '', email: '' }, removed: ZERO });
check('scrub(undefined)', scrub(undefined).text, '');
check('scrub(number)', scrub(2019).text, '2019');
check('scrub(object) does not throw', typeof scrub({}).text, 'string');
check('scrub plain text', scrub('Depoda forklift kullandım.'), { text: 'Depoda forklift kullandım.', found: { phone: '', email: '' }, removed: ZERO });

// ---------------------------------------------------------------------------------------------
// scrub: TC kimlik no
// ---------------------------------------------------------------------------------------------
check('checksum helper sanity: 10000000146', tcFrom9('100000001'), '10000000146');
check('checksum helper sanity: 12345678950', tcFrom9('123456789'), '12345678950');

[
  ['10000000146', '[kimlik no]'],
  ['12345678950', '[kimlik no]'],
  ['TC kimlik numaram 12345678950.', 'TC kimlik numaram [kimlik no].'],
  ['TC: 123 456 789 50', 'TC: [kimlik no]'],
  ['kimlik no 123.456.789.50 olarak geçiyor', 'kimlik no [kimlik no] olarak geçiyor'],
  ['123-456-789-50', '[kimlik no]'],
  ['1234 5678 950', '[kimlik no]'],
  ['12 34 56 78 950', '[kimlik no]'],
  ['1 2 3 4 5 6 7 8 9 5 0', '[kimlik no]'],
  ['TC12345678950', 'TC[kimlik no]'],
  ['T.C. Kimlik No: 12345678950, doğum yeri İzmir', 'T.C. Kimlik No: [kimlik no], doğum yeri İzmir'],
  ['numaram 12345678950\'dir', 'numaram [kimlik no]\'dir'],
  ['(12345678950)', '([kimlik no])'],
  // spoken
  ['yüz yirmi üç dört yüz elli altı yedi yüz seksen dokuz elli', '[kimlik no]'],
  ['bir iki üç dört beş altı yedi sekiz dokuz beş sıfır', '[kimlik no]'],
  ['kimlik numaram on iki otuz dört elli altı yetmiş sekiz dokuz yüz elli tamam', 'kimlik numaram [kimlik no] tamam'],
  ['BİR İKİ ÜÇ DÖRT BEŞ ALTI YEDİ SEKİZ DOKUZ BEŞ SIFIR', '[kimlik no]'],
  // mixed digits and words
  ['123 456 yedi yüz seksen dokuz 50', '[kimlik no]'],
  ['1 0 0 0 0 0 0 0 1 4 6', '[kimlik no]'],
  // two in one answer
  ['12345678950 ve 10000000146', '[kimlik no] ve [kimlik no]']
].forEach(function (r) {
  var res = scrub(r[0]);
  check('TC removed: ' + show(r[0]), res.text, r[1]);
  ok('TC counted: ' + show(r[0]), res.removed.tc >= 1 && res.removed.phone === 0, res.removed);
});
check('TC found stays empty', scrub('12345678950').found, { phone: '', email: '' });
check('two TCs counted', scrub('12345678950 ve 10000000146').removed, removed(2));

// "doksan beş yüz" inside a TC is 95 1xx, not the spoken "+90 5xx": the TC must still go
(function () {
  var tc = tcFrom9('495123456'); // 49 | 5 12 …: say "kırk dokuz beş yüz on iki …"? use a 95-group instead
  var tc95 = tcFrom9('195123456');
  var spoken = 'yüz doksan beş yüz yirmi üç ' + sayGroup(tc95.slice(6, 9)) + ' ' + sayGroup(tc95.slice(9));
  // 195 | 123 | 456 | xx
  check('TC with "doksan beş yüz" (' + tc95 + ')', scrub(spoken).text, '[kimlik no]');
  ok('tc helper used', tc.length === 11);
})();

// generated: 300 valid numbers, each in a random written format
(function () {
  var formats = [
    function (d) { return d; },
    function (d) { return groupsOf(d, [3, 3, 3, 2]).join(' '); },
    function (d) { return groupsOf(d, [3, 3, 3, 2]).join('.'); },
    function (d) { return groupsOf(d, [3, 3, 3, 2]).join('-'); },
    function (d) { return groupsOf(d, [4, 4, 3]).join(' '); },
    function (d) { return groupsOf(d, [2, 2, 2, 2, 3]).join(' '); },
    function (d) { return groupsOf(d, [3, 2, 2, 2, 2]).join(' '); },
    function (d) { return d.split('').join(' '); },
    function (d) { return sayDigits(d); },
    function (d) { return groupsOf(d, [3, 3, 3, 2]).join(' - '); }
  ];
  var prefixes = ['', 'TC ', 'TC kimlik numaram ', 'Kimlik no: ', 'numaram şu: '];
  var suffixes = ['', '.', ' dir', ', telefonumu da yazayım', '\'dir'];
  var bad = [];
  for (var n = 0; n < 300; n++) {
    var tc = randomTc(), f = n % formats.length;
    var pre = pick(prefixes), suf = pick(suffixes);
    var input = pre + formats[f](tc) + suf;
    var res = scrub(input);
    if (res.text !== pre + '[kimlik no]' + suf || res.removed.tc !== 1) bad.push([input, res.text]);
  }
  check('300 generated valid TCs in written formats are removed', bad.slice(0, 5), []);
})();

// generated: spoken in digit groups (only groupings that are unambiguous when heard)
(function () {
  var patterns = [[3, 3, 3, 2], [3, 2, 2, 2, 2], [2, 3, 3, 3], [2, 2, 2, 2, 3]];
  var bad = [], tried = 0;
  for (var n = 0; tried < 200 && n < 5000; n++) {
    var tc = randomTc(), groups = groupsOf(tc, pick(patterns));
    if (!sayableGroups(groups)) continue;
    tried++;
    var spoken = groups.map(sayGroup).join(' ');
    var res = scrub('kimlik numaram ' + spoken + ' olarak kayıtlı');
    if (res.text !== 'kimlik numaram [kimlik no] olarak kayıtlı' || res.removed.tc !== 1) bad.push([tc, spoken, res.text]);
  }
  check('200 generated valid TCs spoken in groups are removed', bad.slice(0, 5), []);
  ok('enough spoken TCs generated', tried === 200, tried);
})();

// bad checksum: never removed (and an 11-digit number that does not start with 0 is never a phone)
[
  '12345678951', '12345678940', '10000000147', '10000000136', '11111111111', '99999999999',
  '123 456 789 51', '123.456.789.40', 'bir iki üç dört beş altı yedi sekiz dokuz beş bir',
  'Sicil numaram 12345678901', 'Kayıt no 98765432109'
].forEach(function (t) {
  check('bad checksum survives: ' + show(t), scrub(t), { text: t, found: { phone: '', email: '' }, removed: ZERO });
});
(function () {
  var bad = [];
  for (var n = 0; n < 300; n++) {
    var x = badTc(randomTc());
    var input = n % 2 ? x : groupsOf(x, [3, 3, 3, 2]).join(' ');
    var res = scrub('numara ' + input);
    if (res.text !== 'numara ' + input) bad.push([input, res.text]);
  }
  check('300 generated 11-digit numbers with a bad checksum survive', bad.slice(0, 5), []);
  var bad10 = [];
  for (var k = 0; k < 300; k++) {
    var y = badTc10(randomTc());
    var inp = k % 2 ? y : groupsOf(y, [3, 3, 3, 2]).join(' ');
    var r2 = scrub('numara ' + inp);
    if (r2.text !== 'numara ' + inp) bad10.push([inp, r2.text]);
  }
  check('300 generated numbers with only a bad 10th digit survive', bad10.slice(0, 5), []);
})();
check('bad 10th digit, consistent 11th: 12345678949', scrub('12345678949').text, '12345678949');
// a valid TC must be one whole number: not a slice of a longer digit run
check('valid TC inside 12 digits survives', scrub('123456789501').text, '123456789501');
check('valid TC glued to more digits survives', scrub('912345678950').text, '912345678950');
check('starts with 0 is not a TC', scrub('01234567890').removed.tc, 0);

// ---------------------------------------------------------------------------------------------
// scrub: phone numbers
// ---------------------------------------------------------------------------------------------
var MOBILE = '0532 123 45 67', MOBILE_INTL = '+90 532 123 45 67';
[
  ['0532 123 45 67', MOBILE],
  ['05321234567', MOBILE],
  ['0532-123-45-67', MOBILE],
  ['0532.123.45.67', MOBILE],
  ['0532 123 4567', MOBILE],
  ['0532 1234567', MOBILE],
  ['0 532 123 45 67', MOBILE],
  ['(0532) 123 45 67', MOBILE],
  ['0 (532) 123 45 67', MOBILE],
  ['0(532)1234567', MOBILE],
  ['532 123 45 67', MOBILE],
  ['5321234567', MOBILE],
  ['532-123-4567', MOBILE],
  ['+90 532 123 45 67', MOBILE_INTL],
  ['+90 532 123 4567', MOBILE_INTL],
  ['+905321234567', MOBILE_INTL],
  ['+90 (532) 123-45-67', MOBILE_INTL],
  ['+90-532-123-45-67', MOBILE_INTL],
  ['90 532 123 45 67', MOBILE_INTL],
  ['0090 532 123 45 67', MOBILE_INTL],
  // spoken
  ['sıfır beş yüz otuz iki yüz yirmi üç kırk beş altmış yedi', MOBILE],
  ['beş yüz otuz iki yüz yirmi üç kırk beş altmış yedi', MOBILE],
  ['sıfır beş üç iki bir iki üç dört beş altı yedi', MOBILE],
  ['sıfır beş otuz iki yüz yirmi üç kırk beş altmış yedi', MOBILE],
  ['artı doksan beş yüz otuz iki yüz yirmi üç kırk beş altmış yedi', MOBILE_INTL],
  ['doksan beş yüz otuz iki yüz yirmi üç kırk beş altmış yedi', MOBILE_INTL],
  ['ARTI DOKSAN BEŞ YÜZ OTUZ İKİ YÜZ YİRMİ ÜÇ KIRK BEŞ ALTMIŞ YEDİ', MOBILE_INTL],
  // mixed
  ['0532 yüz yirmi üç 45 67', MOBILE],
  ['sıfır 532 123 kırk beş 67', MOBILE],
  ['0532 123 kırk beş altmış yedi', MOBILE]
].forEach(function (r) {
  var res = scrub(r[0]);
  check('phone removed: ' + show(r[0]), res.text, '[telefon]');
  check('phone found: ' + show(r[0]), res.found.phone, r[1]);
  check('phone counted: ' + show(r[0]), res.removed, removed(0, 1));
});
[
  ['Telefonum 0532 123 45 67, arayabilirsiniz.', 'Telefonum [telefon], arayabilirsiniz.'],
  ['Beni 0532 123 45 67\'den arayın', 'Beni [telefon]\'den arayın'],
  ['cep: 05321234567.', 'cep: [telefon].'],
  ['numaram (0532 123 45 67) dir', 'numaram ([telefon]) dir'],
  ['telefonum sıfır beş yüz otuz iki yüz yirmi üç kırk beş altmış yedi bir de e-postam var',
    'telefonum [telefon] bir de e-postam var'],
  ['iki numaram var 0532 123 45 67 ve 0533 765 43 21', 'iki numaram var [telefon] ve [telefon]'],
  ['0532 123 45 67 0533 765 43 21', '[telefon] [telefon]'],
  ['2019\'dan beri 0532 123 45 67 numarasını kullanıyorum', '2019\'dan beri [telefon] numarasını kullanıyorum']
].forEach(function (r) {
  check('phone in a sentence: ' + show(r[0]), scrub(r[0]).text, r[1]);
});
check('first mobile is reported', scrub('0532 123 45 67 ve 0533 765 43 21').found.phone, MOBILE);
check('two phones counted', scrub('0532 123 45 67 ve 0533 765 43 21').removed, removed(0, 2));
// landlines and other countries: removed, but never reported as the person's phone
[
  ['0212 123 45 67', '[telefon]'],
  ['(0232) 444 55 66', '[telefon]'],
  ['0850 222 33 44', '[telefon]'],
  ['+90 212 123 45 67', '[telefon]'],
  ['+49 151 12345678', '[telefon]'],
  ['+44 20 7946 0958', '[telefon]'],
  ['artı kırk dokuz yüz elli bir 12345678', '[telefon]']
].forEach(function (r) {
  var res = scrub(r[0]);
  check('other phone removed: ' + show(r[0]), res.text, r[1]);
  check('other phone not reported: ' + show(r[0]), res.found.phone, '');
});
check('mobile reported after a landline', scrub('işyeri 0212 123 45 67, cep 0532 123 45 67').found.phone, MOBILE);
// generated mobiles
(function () {
  var formats = [
    function (d) { return d; },
    function (d) { return groupsOf(d, [4, 3, 2, 2]).join(' '); },
    function (d) { return groupsOf(d, [4, 3, 4]).join(' '); },
    function (d) { return '+90 ' + groupsOf(d.slice(1), [3, 3, 2, 2]).join(' '); },
    function (d) { return groupsOf(d.slice(1), [3, 3, 2, 2]).join(' '); },
    function (d) { return '(' + d.slice(0, 4) + ') ' + groupsOf(d.slice(4), [3, 2, 2]).join(' '); },
    function (d) { return sayDigits(d); },
    function (d) { return groupsOf(d, [4, 3, 2, 2]).join('-'); }
  ];
  var bad = [];
  for (var n = 0; n < 240; n++) {
    var d = '05' + pick(['0', '3', '4', '5', '6']) + rint(0, 9);
    for (var i = 0; i < 7; i++) d += rint(0, 9);
    var input = 'Telefon: ' + formats[n % formats.length](d) + ' ile ulaşabilirsiniz';
    var res = scrub(input);
    var want = (n % formats.length === 3 ? '+90 ' + d.slice(1, 4) : d.slice(0, 4)) + ' ' + d.slice(4, 7) + ' ' + d.slice(7, 9) + ' ' + d.slice(9);
    if (res.text !== 'Telefon: [telefon] ile ulaşabilirsiniz' || res.found.phone !== want) bad.push([input, res.text, res.found.phone]);
  }
  check('240 generated mobile numbers are removed and reported', bad.slice(0, 5), []);
})();
(function () {
  var bad = [], tried = 0;
  for (var n = 0; tried < 150 && n < 5000; n++) {
    var d = '05' + pick(['0', '3', '4', '5']) + rint(1, 9);
    for (var i = 0; i < 7; i++) d += rint(0, 9);
    var groups = [d.slice(1, 4), d.slice(4, 7), d.slice(7, 9), d.slice(9)];
    if (!sayableGroups(groups)) continue;
    tried++;
    var spoken = 'sıfır ' + groups.map(sayGroup).join(' ');
    var res = scrub('telefonum ' + spoken);
    var want = d.slice(0, 4) + ' ' + d.slice(4, 7) + ' ' + d.slice(7, 9) + ' ' + d.slice(9);
    if (res.text !== 'telefonum [telefon]' || res.found.phone !== want) bad.push([spoken, res.text, res.found.phone]);
  }
  check('150 generated mobile numbers spoken in groups are removed', bad.slice(0, 5), []);
})();

// ---------------------------------------------------------------------------------------------
// scrub: e-mail
// ---------------------------------------------------------------------------------------------
[
  ['ayse.yilmaz@gmail.com', '[e-posta]', 'ayse.yilmaz@gmail.com'],
  ['Mail: Ayse.Yilmaz@Gmail.COM', 'Mail: [e-posta]', 'ayse.yilmaz@gmail.com'],
  ['ali_veli-85@firma.com.tr adresine yazın', '[e-posta] adresine yazın', 'ali_veli-85@firma.com.tr'],
  ['ayşe@gmail.com', '[e-posta]', 'ayse@gmail.com'],
  ['(ali@ornek.io)', '([e-posta])', 'ali@ornek.io'],
  ['ali@ornek.io\'ya yazın', '[e-posta]\'ya yazın', 'ali@ornek.io'],
  ['e-posta:ali@ornek.io, teşekkürler', 'e-posta:[e-posta], teşekkürler', 'ali@ornek.io'],
  ['ayse @ gmail.com', '[e-posta]', 'ayse@gmail.com'],
  ['ayse@gmail nokta com', '[e-posta]', 'ayse@gmail.com'],
  ['ahmet.at@gmail.com', '[e-posta]', 'ahmet.at@gmail.com'],
  ['ali@sirket.xyz', '[e-posta]', 'ali@sirket.xyz'],
  ['05321234567@gmail.com', '[e-posta]', '05321234567@gmail.com'],
  ['mail@firma.com', '[e-posta]', 'mail@firma.com'],
  // dictated
  ['ayşe nokta yılmaz et gmail nokta com', '[e-posta]', 'ayse.yilmaz@gmail.com'],
  ['e-posta adresim ayşe nokta yılmaz et gmail nokta com olarak geçiyor', 'e-posta adresim [e-posta] olarak geçiyor', 'ayse.yilmaz@gmail.com'],
  ['AYŞE NOKTA YILMAZ ET GMAIL NOKTA COM', '[e-posta]', 'ayse.yilmaz@gmail.com'],
  ['ali alt çizgi veli at outlook dot com', '[e-posta]', 'ali_veli@outlook.com'],
  ['mehmet tire kaya et yandex nokta com nokta tr', '[e-posta]', 'mehmet-kaya@yandex.com.tr'],
  ['ahmet et işareti gmail nokta com', '[e-posta]', 'ahmet@gmail.com'],
  ['ayşe seksen beş et hotmail nokta com', '[e-posta]', 'ayse85@hotmail.com'],
  ['ayşe et gmail com', '[e-posta]', 'ayse@gmail.com'],
  ['ali et firma nokta com', '[e-posta]', 'ali@firma.com'],
  ['adresim zeynep et icloud nokta com.', 'adresim [e-posta].', 'zeynep@icloud.com'],
  ['ali (at) gmail.com', '[e-posta]', 'ali@gmail.com']
].forEach(function (r) {
  var res = scrub(r[0]);
  check('e-mail removed: ' + show(r[0]), res.text, r[1]);
  check('e-mail found: ' + show(r[0]), res.found.email, r[2]);
  check('e-mail counted: ' + show(r[0]), res.removed, removed(0, 0, 1));
});
// a name said in front: without the name only the last word is taken; with it the whole address
check('dictated name without opts', scrub('ayşe yılmaz seksen beş et hotmail nokta com').text, 'ayşe [e-posta]');
check('dictated name with opts.name', scrub('ayşe yılmaz seksen beş et hotmail nokta com', { name: 'Ayşe Yılmaz' }),
  { text: '[e-posta]', found: { phone: '', email: 'ayseyilmaz85@hotmail.com' }, removed: removed(0, 0, 1) });
check('opts.name does not eat other words', scrub('benim adresim ayşe yılmaz et gmail nokta com', { name: 'Ayşe Yılmaz' }).text, 'benim adresim [e-posta]');
check('a lead-in word is not the local part', scrub('e-posta adresim et gmail nokta com').found.email, '');
check('a lead-in word is not the local part (mail)', scrub('mailim et gmail nokta com').found.email, '');
check('first e-mail is reported', scrub('ali@a.com ve veli@b.com').found.email, 'ali@a.com');
check('typed addresses with lead-in words as local part', scrub('Bize info@sirket.com.tr ya da iletisim@firma.com adresinden'),
  { text: 'Bize [e-posta] ya da [e-posta] adresinden', found: { phone: '', email: 'info@sirket.com.tr' }, removed: removed(0, 0, 2) });
check('two e-mails counted', scrub('ali@a.com ve veli@b.com').removed, removed(0, 0, 2));
// a lead-in word ("mailim", "e-postam", "adresim") marks where a dictated address starts, name or not
check('lead-in: the words after "mailim" are the local part', scrub('adım ayşe kaya mailim ayşe kaya et gmail nokta com'),
  { text: 'adım ayşe kaya mailim [e-posta]', found: { phone: '', email: 'aysekaya@gmail.com' }, removed: removed(0, 0, 1) });
check('lead-in: up to three words before the last one', scrub('e-postam ayşe nur kaya yılmaz et gmail nokta com').found.email, 'aysenurkayayilmaz@gmail.com');
check('lead-in: farther away it is not one', scrub('e-postam ali ayşe nur kaya yılmaz et gmail nokta com').text, 'e-postam ali ayşe nur kaya [e-posta]');
check('lead-in: numbers still join', scrub('mail adresim süper kral otuz dört et hotmail nokta com').found.email, 'superkral34@hotmail.com');
check('lead-in: no lead-in, only the last word', scrub('İzmirde oturuyorum ayşe et gmail nokta com').found.email, 'ayse@gmail.com');
check('lead-in: never for a typed address', scrub('mailim ali veli@firma.com').text, 'mailim ali [e-posta]');
// opts.whole: the text is only an address (the contact card), so the start of the text is the lead-in
check('whole: every word before "et"', scrub('ayşe kaya seksen beş et gmail nokta com', { whole: true }),
  { text: '[e-posta]', found: { phone: '', email: 'aysekaya85@gmail.com' }, removed: removed(0, 0, 1) });
check('whole: a lead-in still counts', scrub('e-postam ayşe kaya et gmail nokta com', { whole: true }).found.email, 'aysekaya@gmail.com');
check('without whole: the last word only', scrub('ayşe kaya seksen beş et gmail nokta com').found.email, 'kaya85@gmail.com');
// each word of the name is used once ("adım ayşe kaya, ayşe kaya et …")
check('name words once', scrub('adım ayşe kaya ayşe kaya seksen beş et hotmail nokta com', { name: 'Ayşe Kaya' }),
  { text: 'adım ayşe kaya [e-posta]', found: { phone: '', email: 'aysekaya85@hotmail.com' }, removed: removed(0, 0, 1) });
// typed addresses may have long top-level domains; dictated ones are read with the short list only
check('long TLD: .istanbul', scrub('ali@firma.istanbul adresime yazın'),
  { text: '[e-posta] adresime yazın', found: { phone: '', email: 'ali@firma.istanbul' }, removed: removed(0, 0, 1) });
check('long TLD: .software', scrub('ali@kaya.software').found.email, 'ali@kaya.software');
check('long TLD: .photography', scrub('foto@studyo.photography').text, '[e-posta]');
check('dictated long TLD is not read', scrub('ali et firma nokta istanbul').text, 'ali et firma nokta istanbul');
// "kuyruklu a" is how @ is said in Turkish
check('kuyruklu a', scrub('mailim ayşe kaya kuyruklu a gmail nokta com'),
  { text: 'mailim [e-posta]', found: { phone: '', email: 'aysekaya@gmail.com' }, removed: removed(0, 0, 1) });
check('kuyruklu a (no lead-in)', scrub('ali kuyruklu a hotmail nokta com').found.email, 'ali@hotmail.com');
check('kuyruklu yıldız is not an address', scrub('kuyruklu yıldız gördüm').text, 'kuyruklu yıldız gördüm');
// English "at": a mail provider, a lead-in, or a local part that looks like one
check('English at: provider', scrub('ali at gmail dot com').found.email, 'ali@gmail.com');
check('English at: lead-in', scrub('my email is john at acme dot com'),
  { text: 'my email is [e-posta]', found: { phone: '', email: 'john@acme.com' }, removed: removed(0, 0, 1) });
check('English at: dotted local part', scrub('john dot smith at acme dot com').found.email, 'john.smith@acme.com');
check('English at: digits in the local part', scrub('john85 at acme dot com').found.email, 'john85@acme.com');
check('English at: an employer stays', scrub('I worked at Amazon dot com for three years'),
  { text: 'I worked at Amazon dot com for three years', found: { phone: '', email: '' }, removed: ZERO });
check('English at: "is at" stays', scrub('He is at Amazon dot com now').text, 'He is at Amazon dot com now');
// never an address
[
  'yardım et', 'Ahmet ile çalıştım', 'bir at aldım', 'et ve süt ürünleri', 'kariyer nokta net',
  'ali et veli nokta xyz', 'Excel ve Outlook kullandım', 'nokta atışı yaptım', '@ayseyilmaz hesabım',
  'ali@localhost', 'kontrol et gmail hesabını', 'Gmail ve Outlook', 'www.firma.com.tr', 'firma.com.tr sitesi',
  'Satış et ürünleri nokta', 'at nokta com'
].forEach(function (t) {
  check('not an e-mail: ' + show(t), scrub(t), { text: t, found: { phone: '', email: '' }, removed: ZERO });
});

// ---------------------------------------------------------------------------------------------
// scrub: IBAN
// ---------------------------------------------------------------------------------------------
[
  ['TR33 0006 1005 1978 6457 8413 26', '[IBAN]'],
  ['TR330006100519786457841326', '[IBAN]'],
  ['tr 33 0006 1005 1978 6457 8413 26', '[IBAN]'],
  ['IBAN: TR33-0006-1005-1978-6457-8413-26', 'IBAN: [IBAN]'],
  ['IBAN numaram TR33 0006 1005 1978 6457 8413 26, maaş oraya yatsın', 'IBAN numaram [IBAN], maaş oraya yatsın'],
  ['IBAN numaram 33 0006 1005 1978 6457 8413 26', 'IBAN numaram [IBAN]'],
  ['TR otuz üç sıfır sıfır sıfır altı bir sıfır sıfır beş bir dokuz yedi sekiz altı dört beş yedi sekiz dört bir üç iki altı', '[IBAN]'],
  ['te re 33 0006 1005 1978 6457 8413 26', '[IBAN]']
].forEach(function (r) {
  var res = scrub(r[0]);
  check('IBAN removed: ' + show(r[0]), res.text, r[1]);
  check('IBAN counted: ' + show(r[0]), res.removed, removed(0, 0, 0, 1));
});
[
  'TR 2019', 'TR yerine EN sürümü', 'IBAN bilgimi sonra vereceğim', 'TR 33 0006 1005', 'Proje kodu TR-2019-15'
].forEach(function (t) {
  check('not an IBAN: ' + show(t), scrub(t).text, t);
});

// ---------------------------------------------------------------------------------------------
// scrub: ordinary CV text must survive unchanged
// ---------------------------------------------------------------------------------------------
var SURVIVE = [
  '2019', '2019-2021', '2019 - 2021', '2015–2019 yılları arasında çalıştım', 'Mart 2019 – Haziran 2021',
  '01.03.2019 - 15.06.2021', '1.03.2019 – 15.06.2021', '5.3.2019-12.6.2021', '2019-03-01 ile 2021-06-15 arası',
  '03/2019 - 06/2021', '12/05/2021', '2018 2019 2020 2021', '2015 2016 2017 2018 2019 2020',
  'Günde 120 palet yükledim.', 'yüzde 40 artış', '%40 daha hızlı', 'satışlar yüzde yirmi beş arttı',
  'GNO 3,41', 'Not ortalamam 3,41/4,00', 'GNO: 3.41 / 4.00', 'Diploma notu 85,5',
  '1.500.000 TL ciro', '25.000 TL maaş', '2.500 TL', '12.500.000.000 TL bütçe', '10.000.000.000 TL',
  '1234', 'Saatte 1500 parça', '4 yıl 6 ay', '15 kişilik ekip', '3 vardiya, 12 saat',
  'ISO 9001:2015', 'ISO 9001 2015 ve 14001', 'B2 seviyesinde İngilizce', 'IELTS 6.5 (2024)', 'YDS 85',
  'iki bin on dokuz yılında başladım', 'on beş yıl', 'yüz yirmi palet', 'bin iki yüz parça',
  'beş yıl boyunca yirmi kişilik ekip', 'otuz iki yaşındayım', 'yüzde on iki', 'saat 08:30 - 17:30',
  'C++ 11 ve 14', '+5 yıl tecrübe', 'TCDD\'de 5 yıl çalıştım', 'Sicil No: 4567', 'Posta kodu 34000',
  'Ankara 06 plaka', '34 ABC 123 plakalı araç', 'Ehliyet sınıfı B, 2010\'dan beri',
  'Tel. bilgisi yok', 'telefonumu yazmayacağım', 'e-posta adresimi sonra ekleyeceğim',
  '12345678901', '1234567890', '2345678901', '123456789012', '4543 1234 5678 9012',
  '10 numaralı hat', '7/24 destek', '3 4 5 6 bant', 'Excel\'de 1000 satır', '2 x 4 saat',
  'Q1 2023 ve Q2 2023', 'v2.3.1 sürümü', 'React 18, Node.js 20', '1990 doğumluyum',
  'Askerlik: Yapıldı (2021)', 'Tecilli (Haziran 2027\'ye kadar)', '0 hata ile', '100% doğruluk',
  // dates whose digits look like a 050x mobile or pass the TC checksum, and amounts with thousand dots
  '05.02.2000 - 12.8.1990', '05.12.2005 - 11.8.2020', '02.5.2009 - 18.10.2023', '05.02.20 - 12.08.21',
  '5/3/21 - 12/6/23', '2019-03-01 - 2021-6-15', '5.000.000.000 TL ciro', '53.000.000.000 TL',
  '5.321.234.567 TL', '1.234.567.890 adet', '50.000.000.000',
  // commas never join digit groups: a list of decimals is not a phone number
  'Ölçümler: 5,32, 1,23, 4,56, 7,8', 'Dönem ortalamalarım 3,41, 3,62, 3,15, 3,70 ve 3,05'
];
SURVIVE.forEach(function (t) {
  check('survives: ' + show(t), scrub(t), { text: t, found: { phone: '', email: '' }, removed: ZERO });
});
// generated CV sentences with years, date ranges, amounts and percentages
(function () {
  var months = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
  var dd = function () { var d = rint(1, 28); return rnd() < 0.5 && d < 10 ? '0' + d : String(d); };
  var mm = function () { var m = rint(1, 12); return rnd() < 0.5 && m < 10 ? '0' + m : String(m); };
  var yy = function () { return String(rint(1985, 2026)); };
  var templates = [
    function () { return yy() + '-' + yy() + ' yılları arasında ' + rint(2, 400) + ' kişilik ekipte çalıştım.'; },
    function () { return dd() + '.' + mm() + '.' + yy() + ' - ' + dd() + '.' + mm() + '.' + yy(); },
    function () { return dd() + '/' + mm() + '/' + yy() + ' – ' + dd() + '/' + mm() + '/' + yy(); },
    function () { return yy() + '-' + mm() + '-' + dd() + ' ile ' + yy() + '-' + mm() + '-' + dd() + ' arası'; },
    function () { return pick(months) + ' ' + yy() + ' – ' + pick(months) + ' ' + yy(); },
    function () { return 'Günde ' + rint(10, 5000) + ' palet, ayda ' + rint(1, 999) + '.' + rint(100, 999) + ' TL ciro'; },
    function () { return 'yüzde ' + rint(1, 100) + ' artış, GNO ' + rint(1, 3) + ',' + rint(10, 99); },
    function () { return yy() + ' ' + yy() + ' ' + yy(); },
    function () { return rint(1, 30) + ' yıl ' + rint(1, 11) + ' ay, ' + rint(1, 9999) + ' adet'; },
    function () { return rint(1, 99) + '.' + rint(100, 999) + '.' + rint(100, 999) + ' TL'; },
    function () { return rint(1, 99) + '.' + rint(100, 999) + '.' + rint(100, 999) + '.' + rint(100, 999) + ' TL bütçe'; },
    function () { return dd() + '.' + mm() + '.' + String(rint(0, 99)).replace(/^(\d)$/, '0$1') + ' - ' + dd() + '.' + mm() + '.' + yy(); }
  ];
  var bad = [];
  for (var n = 0; n < 3000; n++) {
    var t = templates[n % templates.length]();
    var res = scrub(t);
    if (res.text !== t) bad.push([t, res.text]);
  }
  check('3000 generated CV sentences survive', bad.slice(0, 5), []);
})();

// ---------------------------------------------------------------------------------------------
// scrub: everything at once, idempotence, the original stays untouched
// ---------------------------------------------------------------------------------------------
(function () {
  var input = 'Adım Ayşe Yılmaz. TC 12345678950, tel 0532 123 45 67, mail ayse@gmail.com, ' +
    'IBAN TR33 0006 1005 1978 6457 8413 26. 2019-2021 arasında Ekol\'de günde 120 palet, yüzde 40 artış, GNO 3,41.';
  var res = scrub(input);
  check('mixed answer text', res.text, 'Adım Ayşe Yılmaz. TC [kimlik no], tel [telefon], mail [e-posta], ' +
    'IBAN [IBAN]. 2019-2021 arasında Ekol\'de günde 120 palet, yüzde 40 artış, GNO 3,41.');
  check('mixed answer found', res.found, { phone: MOBILE, email: 'ayse@gmail.com' });
  check('mixed answer removed', res.removed, removed(1, 1, 1, 1));
  var again = scrub(res.text);
  check('idempotent text', again.text, res.text);
  check('idempotent counts', again.removed, ZERO);
  check('input string untouched', input.indexOf('0532 123 45 67') > 0, true);
})();
(function () {
  var spoken = 'telefonum sıfır beş yüz otuz iki yüz yirmi üç kırk beş altmış yedi e-postam ayşe nokta kaya et gmail nokta com ' +
    'kimlik numaram bir iki üç dört beş altı yedi sekiz dokuz beş sıfır iki bin on dokuzda başladım';
  var res = scrub(spoken);
  check('spoken mixed answer', res.text, 'telefonum [telefon] e-postam [e-posta] kimlik numaram [kimlik no] iki bin on dokuzda başladım');
  check('spoken mixed found', res.found, { phone: MOBILE, email: 'ayse.kaya@gmail.com' });
})();
// no digit of a removed number may be left in the text
(function () {
  var leaks = [];
  for (var n = 0; n < 200; n++) {
    var tc = randomTc();
    var phone = '05' + pick(['3', '4', '5']) + rint(0, 9) + String(rint(1000000, 9999999));
    var t = 'TC ' + groupsOf(tc, [3, 3, 3, 2]).join(' ') + ' tel ' + groupsOf(phone, [4, 3, 2, 2]).join(' ');
    var out = scrub(t).text;
    if (/\d/.test(out)) leaks.push([t, out]);
  }
  check('no digits leak from removed numbers', leaks.slice(0, 5), []);
})();
// robustness: long and odd input
(function () {
  var long = '';
  for (var i = 0; i < 400; i++) long += 'Depoda ' + i + ' palet taşıdım, yüzde ' + (i % 100) + ' arttı. ';
  var t0 = Date.now();
  var res = scrub(long + ' 0532 123 45 67');
  ok('long text is fast (<1500 ms)', Date.now() - t0 < 1500, Date.now() - t0);
  check('long text ends scrubbed', res.text.slice(-9), '[telefon]');
  check('long text keeps the rest', res.text.slice(0, 40), long.slice(0, 40));
  check('surrogates and emoji survive', scrub('Merhaba 😀 \ud800 2019').text, 'Merhaba 😀 \ud800 2019');
  check('only separators', scrub(' . - / ( ) ').text, ' . - / ( ) ');
  check('newline breaks a number', scrub('0532 123\n45 67').text, '0532 123\n45 67');
})();

// ---------------------------------------------------------------------------------------------
// toAI: data minimisation
// ---------------------------------------------------------------------------------------------
var FULL = {
  name: 'Ayşe Kaya', title: 'Depo Sorumlusu', phone: '0532 123 45 67', email: 'ayse@gmail.com', city: 'İzmir',
  web: 'ayse.dev', github: 'github.com/ayse', photo: 'data:image/jpeg;base64,AAAA', summary: 'On yıllık deneyim.',
  jobs: [{ id: 'j1', role: 'Depo Sorumlusu', company: 'Ekol Lojistik', city: 'İzmir', start: 'Mart 2019', end: 'Devam ediyor', desc: '• Günde 120 palet\nEkip yönetimi' }],
  edu: [{ id: 'e1', school: 'Ege Üniversitesi', program: 'İşletme', degree: 'Lisans', start: '2010', end: '2014', note: 'GNO 3,41' }],
  projects: [{ id: 'p1', name: 'Stok', tech: 'Excel', link: 'x.com', desc: 'Sayım' }],
  skills: 'Forklift, SAP ve Excel', langs: 'İngilizce ileri, Almanca başlangıç', certs: 'Forklift belgesi\nİSG',
  hobbies: 'Satranç, yüzme', refs: 'Ali Veli – 0533 000 00 00', birth: '1990', military: 'Yapıldı (2012)',
  license: 'B', marital: 'Evli'
};
(function () {
  var a = AI.toAI(FULL);
  check('toAI phone blank', a.phone, '');
  check('toAI email blank', a.email, '');
  check('toAI refs empty', a.refs, []);
  check('toAI birth blank', a.birth, '');
  check('toAI military blank', a.military, '');
  check('toAI marital blank', a.marital, '');
  check('toAI keeps license', a.license, 'B');
  check('toAI keeps identity', [a.name, a.title, a.city, a.web, a.github, a.summary], ['Ayşe Kaya', 'Depo Sorumlusu', 'İzmir', 'ayse.dev', 'github.com/ayse', 'On yıllık deneyim.']);
  check('toAI has no photo', Object.prototype.hasOwnProperty.call(a, 'photo'), false);
  check('toAI keys', Object.keys(a).sort(), ['birth', 'certs', 'city', 'edu', 'email', 'github', 'hobbies', 'jobs', 'langs', 'license', 'marital',
    'military', 'name', 'phone', 'projects', 'refs', 'skillGroups', 'skills', 'summary', 'title', 'web'].sort());
  check('toAI jobs', a.jobs, [{ company: 'Ekol Lojistik', role: 'Depo Sorumlusu', city: 'İzmir', start: 'Mart 2019', end: 'Devam ediyor', bullets: ['Günde 120 palet', 'Ekip yönetimi'] }]);
  check('toAI edu', a.edu, [{ school: 'Ege Üniversitesi', program: 'İşletme', degree: 'Lisans', start: '2010', end: '2014', note: 'GNO 3,41' }]);
  check('toAI projects', a.projects, [{ name: 'Stok', tech: 'Excel', link: 'x.com', bullets: ['Sayım'] }]);
  check('toAI flat skills', [a.skills, a.skillGroups], [['Forklift', 'SAP', 'Excel'], []]);
  check('toAI certs/hobbies', [a.certs, a.hobbies], [['Forklift belgesi', 'İSG'], ['Satranç', 'yüzme']]);
  var json = JSON.stringify(a);
  ['0532', '0533', 'ayse@gmail.com', 'Ali Veli', '1990', 'Yapıldı', 'Evli', 'base64'].forEach(function (x) {
    check('toAI never sends ' + show(x), json.indexOf(x), -1);
  });
  check('toAI does not change its input', FULL.phone, '0532 123 45 67');
})();
check('toAI(null) is a blank AICV', AI.toAI(null).jobs, []);
check('toAI({}) langs/skills', [AI.toAI({}).langs, AI.toAI({}).skills, AI.toAI({}).skillGroups], [[], [], []]);
check('toAI skips empty entries', AI.toAI({ jobs: [{ role: '' }, null, { company: 'X' }] }).jobs.length, 1);
check('toAI ignores non-string fields', AI.toAI({ name: 5, skills: ['a'], langs: { x: 1 } }).name, '5');

// ---- skills: grouped lines
check('toAI grouped skills', (function () {
  var a = AI.toAI({ skills: 'Diller: Go, C#\nFramework: .NET, React\nDocker, Git' });
  return [a.skillGroups, a.skills];
})(), [[{ name: 'Diller', items: ['Go', 'C#'] }, { name: 'Framework', items: ['.NET', 'React'] }, { name: '', items: ['Docker', 'Git'] }],
  ['Go', 'C#', '.NET', 'React', 'Docker', 'Git']]);
check('toAI grouped: union de-duplicated', AI.toAI({ skills: 'Diller: Go, Python\nAraçlar: python, Docker' }).skills, ['Go', 'Python', 'Docker']);
check('toAI grouped: bullets and blank lines', AI.toAI({ skills: '• Diller: Go\n\n- Bulut: AWS' }).skillGroups,
  [{ name: 'Diller', items: ['Go'] }, { name: 'Bulut', items: ['AWS'] }]);
check('toAI: a URL line is not a group', AI.toAI({ skills: 'https: //x.com' }).skillGroups, []);
check('toAI: one-line flat list with colon-free items', AI.toAI({ skills: 'Excel; Word • PowerPoint' }).skills, ['Excel', 'Word', 'PowerPoint']);

// ---- languages
[
  ['İngilizce ileri, Almanca başlangıç', [{ name: 'İngilizce', level: 4, cefr: '', exam: '' }, { name: 'Almanca', level: 1, cefr: '', exam: '' }]],
  ['İngilizce ileri (C1) · IELTS 7.0 (2024), Almanca orta', [{ name: 'İngilizce', level: 4, cefr: 'C1', exam: 'IELTS 7.0 (2024)' }, { name: 'Almanca', level: 2, cefr: '', exam: '' }]],
  ['İngilizce - B2 - IELTS 6,5', [{ name: 'İngilizce', level: 3, cefr: 'B2', exam: 'IELTS 6.5' }]],
  ['İngilizce C1, IELTS 7.0', [{ name: 'İngilizce', level: 4, cefr: 'C1', exam: 'IELTS 7.0' }]],
  ['İngilizce, ileri', [{ name: 'İngilizce', level: 4, cefr: '', exam: '' }]],
  ['ingilizce ileri seviye almanca başlangıç', [{ name: 'İngilizce', level: 4, cefr: '', exam: '' }, { name: 'Almanca', level: 1, cefr: '', exam: '' }]],
  ['Almanca Goethe B1', [{ name: 'Almanca', level: 0, cefr: '', exam: 'Goethe B1' }]],
  ['İngilizce TOEFL iBT 105', [{ name: 'İngilizce', level: 0, cefr: '', exam: 'TOEFL iBT 105' }]],
  ['İngilizce YDS 85 (2025)', [{ name: 'İngilizce', level: 0, cefr: '', exam: 'YDS 85 (2025)' }]],
  ['İngilizce e-YDS 70', [{ name: 'İngilizce', level: 0, cefr: '', exam: 'e-YDS 70' }]],
  ['İngilizce YÖKDİL 82,5', [{ name: 'İngilizce', level: 0, cefr: '', exam: 'YÖKDİL 82.5' }]],
  ['İngilizce yokdil 82.5', [{ name: 'İngilizce', level: 0, cefr: '', exam: 'YÖKDİL 82.5' }]],
  ['Fransızca DELF A2, İspanyolca DELE B2 (2023)', [{ name: 'Fransızca', level: 0, cefr: '', exam: 'DELF A2' }, { name: 'İspanyolca', level: 0, cefr: '', exam: 'DELE B2 (2023)' }]],
  ['Almanca TestDaF, İngilizce PTE Academic 65', [{ name: 'Almanca', level: 0, cefr: '', exam: 'TestDaF' }, { name: 'İngilizce', level: 0, cefr: '', exam: 'PTE Academic 65' }]],
  ['İngilizce TOEIC 850', [{ name: 'İngilizce', level: 0, cefr: '', exam: 'TOEIC 850' }]],
  ['İngilizce IELTS (2024)', [{ name: 'İngilizce', level: 0, cefr: '', exam: 'IELTS (2024)' }]],
  ['ingilizce ileri ielts 7 almanca orta', [{ name: 'İngilizce', level: 4, cefr: '', exam: 'IELTS 7' }, { name: 'Almanca', level: 2, cefr: '', exam: '' }]],
  ['İngilizce ileri, İngilizce C1', [{ name: 'İngilizce', level: 4, cefr: 'C1', exam: '' }]],
  ['Türkçe ana dil', [{ name: 'Türkçe', level: 5, cefr: '', exam: '' }]],
  ['Kürtçe', [{ name: 'Kürtçe', level: 0, cefr: '', exam: '' }]],
  ['English advanced (C1) · IELTS 7.5', [{ name: 'English', level: 4, cefr: 'C1', exam: 'IELTS 7.5' }]],
  ['Japonca başlangıç · JLPT N4', [{ name: 'Japonca', level: 1, cefr: '', exam: 'JLPT N4' }]],
  ['İngilizce · ileri', [{ name: 'İngilizce', level: 4, cefr: '', exam: '' }]],
  ['', []]
].forEach(function (r) {
  var got;
  try { got = AI.toAI({ langs: r[0] }).langs; } catch (e) { got = 'THREW ' + e; }
  check('toAI langs ' + show(r[0]), got, r[1]);
});

// ---------------------------------------------------------------------------------------------
// fromAI
// ---------------------------------------------------------------------------------------------
var AICV = {
  name: 'Ayşe Kaya', title: 'Depo Sorumlusu', phone: '', email: '', city: 'İzmir', web: 'https://www.ayse.dev/', github: 'http://github.com/ayse',
  summary: 'Deneyimli.', jobs: [{ company: 'Ekol', role: 'Sorumlu', city: '', start: '2019', end: '', bullets: ['A', 'B'] }],
  edu: [], projects: [], skills: ['Go', 'C#', '.NET', 'React', 'Docker'],
  skillGroups: [{ name: 'Diller', items: ['Go', 'C#'] }, { name: 'Framework', items: ['.NET', 'React'] }],
  langs: [{ name: 'İngilizce', level: 4, cefr: 'C1', exam: 'IELTS 7.0 (2024)' }, { name: 'Almanca', level: 2, cefr: '', exam: '' }],
  certs: ['ISG'], hobbies: ['Satranç'], refs: [], birth: '', military: '', license: 'B', marital: ''
};
(function () {
  var prev = { phone: '0532 123 45 67', email: 'ayse@gmail.com', refs: 'Ali Veli – 0533', birth: '1990', military: 'Yapıldı (2012)', marital: 'Evli', photo: 'data:image/jpeg;base64,AAAA' };
  var c = AI.fromAI(AICV, prev, 'tr');
  check('fromAI keeps device fields from prev', [c.phone, c.email, c.refs, c.birth, c.military, c.marital],
    ['0532 123 45 67', 'ayse@gmail.com', 'Ali Veli – 0533', '1990', 'Yapıldı (2012)', 'Evli']);
  check('fromAI photo from prev', c.photo, 'data:image/jpeg;base64,AAAA');
  check('fromAI links lose protocol', [c.web, c.github], ['ayse.dev', 'github.com/ayse']);
  check('fromAI grouped skills', c.skills, 'Diller: Go, C#\nFramework: .NET, React\nDocker');
  check('fromAI langs', c.langs, 'İngilizce ileri (C1) · IELTS 7.0 (2024), Almanca orta');
  check('fromAI license from AI', c.license, 'B');
  check('fromAI jobs', [c.jobs.length, c.jobs[0].desc, typeof c.jobs[0].id], [1, 'A\nB', 'string']);
  // prev field empty → the AI's value (a number said in an answer that the scrubber missed)
  var ai2 = Object.assign({}, AICV, { phone: '0532 999 88 77', email: 'Ayse@Gmail.com', refs: ['Veli Bey'], birth: '1991', military: 'Muaf', marital: 'Bekar' });
  var c2 = AI.fromAI(ai2, { phone: '', email: '   ', photo: 5 }, 'tr');
  check('fromAI takes AI values when prev is empty', [c2.phone, c2.email, c2.refs, c2.birth, c2.military],
    ['0532 999 88 77', 'ayse@gmail.com', 'Veli Bey', '1991', 'Muaf']);
  // Medeni durum yalnızca Kişisel bilgiler kartından gelir (canlıda model 'MISSING_PLACEHOLDER_FIX' yazdı).
  check('fromAI never takes marital from the AI', [c2.marital, AI.fromAI(ai2, { marital: 'Evli' }).marital], ['', 'Evli']);
  check('fromAI photo must be a string', c2.photo, '');
  check('fromAI prev wins over AI', AI.fromAI(ai2, { phone: '0500 000 00 00' }).phone, '0500 000 00 00');
})();
check('fromAI flat skills', AI.fromAI({ skills: ['Excel', 'Word'] }, {}).skills, 'Excel, Word');
check('fromAI skills: leftover joins an unlabeled group', AI.fromAI({ skills: ['Go', 'Git'], skillGroups: [{ name: 'Diller', items: ['Go'] }, { name: '', items: ['Linux'] }] }, {}).skills,
  'Diller: Go\nLinux, Git');
check('fromAI skills: separators inside an item', AI.fromAI({ skills: ['Office (Word, Excel)', 'Python: ileri'] }, {}).skills, 'Office (Word / Excel), Python - ileri');
check('fromAI skills: bad labels', AI.fromAI({ skillGroups: [{ name: 'A', items: ['x'] }, { name: 'Diller, Araçlar:', items: ['y'] }, { name: 'https', items: ['z'] }] }, {}).skills,
  'x\nDiller Araçlar: y\nz');
check('fromAI skills: garbage groups ignored', AI.fromAI({ skills: ['a'], skillGroups: [null, 5, { name: 'X', items: null }, { name: 'Y', items: [] }] }, {}).skills, 'a');
check('fromAI langs: English level words', AI.fromAI({ langs: [{ name: 'English', level: 3, cefr: 'B2', exam: '' }, { name: 'Turkish', level: 5 }] }, {}, 'en').langs,
  'English upper-intermediate (B2), Turkish native');
check('fromAI langs: level 0 + CEFR', AI.fromAI({ langs: [{ name: 'Kürtçe', level: 0, cefr: 'B1', exam: '' }] }, {}).langs, 'Kürtçe orta (B1)');
check('fromAI langs: bad CEFR dropped', AI.fromAI({ langs: [{ name: 'Rusça', level: 2, cefr: 'D9', exam: '' }] }, {}).langs, 'Rusça orta');
check('fromAI langs: lower-case CEFR', AI.fromAI({ langs: [{ name: 'Rusça', level: 2, cefr: 'b1', exam: '' }] }, {}).langs, 'Rusça orta (B1)');
check('fromAI langs: name only', AI.fromAI({ langs: [{ name: 'Lazca' }] }, {}).langs, 'Lazca');
check('fromAI langs: no comma inside an item', AI.fromAI({ langs: [{ name: 'Arapça, Mısır', level: 2, cefr: '', exam: 'YÖKDİL 62,5' }, { name: 'Farsça', level: 1, exam: 'Sınav: 3, 4' }] }, {}).langs,
  'Arapça Mısır orta · YÖKDİL 62.5, Farsça başlangıç · Sınav: 3 4');
check('fromAI langs: level clamped', AI.fromAI({ langs: [{ name: 'Rusça', level: 9 }, { name: 'Çince', level: -2 }, { name: 'Korece', level: '3' }] }, {}).langs, 'Rusça ana dil, Çince, Korece iyi');
check('fromAI langs: garbage ignored', AI.fromAI({ langs: [null, 5, 'x', { name: '' }, { name: 'Lehçe', level: 1 }] }, {}).langs, 'Lehçe başlangıç');
check('fromAI(null, null) does not throw', typeof AI.fromAI(null, null).skills, 'string');
check('fromAI(string) does not throw', AI.fromAI('cv', {}).jobs, []);
// the model may copy a scrub placeholder from a scrubbed answer: it never reaches the CV
(function () {
  var c = AI.fromAI({ phone: '[telefon]', email: '[e-posta]', refs: ['Ali Veli [telefon]', '[telefon]'], summary: 'Bana [telefon] numarasından ulaşın.',
    jobs: [{ company: 'Ekol', role: 'Şoför', bullets: ['[kimlik no]', 'Günde 120 palet [IBAN] taşıdım'] }], skills: ['[telefon]', 'SAP'],
    langs: [{ name: 'İngilizce', level: 2, cefr: '', exam: '[kimlik no]' }] }, {}, 'tr');
  check('placeholder: phone', c.phone, '');
  check('placeholder: email', c.email, '');
  check('placeholder: refs', c.refs, 'Ali Veli');
  check('placeholder: summary', c.summary, 'Bana numarasından ulaşın.');
  check('placeholder: bullets', c.jobs[0].desc, 'Günde 120 palet taşıdım');
  check('placeholder: skills', c.skills, 'SAP');
  check('placeholder: exam', c.langs, 'İngilizce orta');
  check('placeholder: prev phone kept', AI.fromAI({ phone: '[telefon]' }, { phone: '0532 123 45 67' }).phone, '0532 123 45 67');
  check('placeholder: a lone "[" is kept', AI.fromAI({ summary: 'Proje [beta] sürümü' }, {}).summary, 'Proje [beta] sürümü');
})();
check('fromAI non-array fields', AI.fromAI({ jobs: 'x', langs: 'y', skills: 5, skillGroups: 'z' }, {}).jobs, []);

// ---- round trip: toAI(fromAI(x)) keeps names, levels, CEFR, exams and skill groups
(function () {
  var langs = [
    { name: 'İngilizce', level: 4, cefr: 'C1', exam: 'IELTS 7.0 (2024)' },
    { name: 'Almanca', level: 2, cefr: '', exam: '' },
    { name: 'Türkçe', level: 5, cefr: '', exam: '' },
    { name: 'Fransızca', level: 1, cefr: 'A2', exam: 'DELF A2' },
    { name: 'İspanyolca', level: 3, cefr: 'B2', exam: 'DELE B2 (2023)' },
    { name: 'Arapça', level: 2, cefr: '', exam: 'YÖKDİL 62.5' },
    { name: 'Japonca', level: 1, cefr: '', exam: 'JLPT N4' },
    { name: 'Rusça', level: 3, cefr: 'B2', exam: 'TOEFL iBT 95' },
    { name: 'Kürtçe', level: 0, cefr: '', exam: '' },
    { name: 'İtalyanca', level: 4, cefr: 'C2', exam: '' },
    { name: 'Korece', level: 1, cefr: 'B1', exam: '' },
    { name: 'Felemenkçe', level: 2, cefr: '', exam: 'Taal 3 (2022)' }
  ];
  var groups = [{ name: 'Diller', items: ['Go', 'C#', 'Python'] }, { name: 'Framework', items: ['.NET', 'React', 'Node.js'] },
    { name: 'Veritabanı ve Bulut', items: ['PostgreSQL', 'AWS'] }];
  var x = { name: 'X', langs: langs, skillGroups: groups, skills: ['Go', 'C#', 'Python', '.NET', 'React', 'Node.js', 'PostgreSQL', 'AWS'] };
  var back = AI.toAI(AI.fromAI(x, {}, 'tr'));
  check('round trip (tr) langs', back.langs, langs);
  check('round trip (tr) skillGroups', back.skillGroups, groups);
  check('round trip (tr) skills', back.skills, x.skills);
  var en = langs.map(function (l) { return { name: P.languageName(l.name, 'en'), level: l.level, cefr: l.cefr, exam: l.exam }; });
  var backEn = AI.toAI(AI.fromAI({ langs: en, skillGroups: groups, skills: x.skills }, {}, 'en'));
  check('round trip (en) langs', backEn.langs, en);
  check('round trip (en) skillGroups', backEn.skillGroups, groups);
  // and the other way: app text → AICV → app text is stable after one pass
  var text = AI.fromAI(x, {}, 'tr');
  var again = AI.fromAI(AI.toAI(text), {}, 'tr');
  check('fromAI(toAI(fromAI(x))) langs text is stable', again.langs, text.langs);
  check('fromAI(toAI(fromAI(x))) skills text is stable', again.skills, text.skills);
  // flat skills round trip
  var flat = AI.toAI(AI.fromAI({ skills: ['Excel', 'SAP', 'Forklift'], skillGroups: [] }, {}));
  check('round trip flat skills', [flat.skills, flat.skillGroups], [['Excel', 'SAP', 'Forklift'], []]);
})();
// generated round trips
(function () {
  var names = ['İngilizce', 'Almanca', 'Fransızca', 'İspanyolca', 'İtalyanca', 'Rusça', 'Arapça', 'Japonca', 'Çince', 'Korece', 'Yunanca', 'Lehçe'];
  var exams = ['', '', 'IELTS 6.5', 'IELTS 7.0 (2024)', 'TOEFL iBT 100', 'YDS 82.5 (2025)', 'e-YDS 70', 'YÖKDİL 60', 'TOEIC 900', 'Goethe B2', 'DELF B1 (2021)', 'PTE 58'];
  var cefrs = ['', '', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  var bad = [];
  for (var n = 0; n < 300; n++) {
    var count = rint(1, 4), used = {}, langs = [];
    for (var i = 0; i < count; i++) {
      var nm = pick(names);
      if (used[nm]) continue;
      used[nm] = 1;
      var lv = rint(0, 5), cefr = pick(cefrs);
      if (!lv && cefr) lv = { A1: 1, A2: 1, B1: 2, B2: 3, C1: 4, C2: 4 }[cefr];
      langs.push({ name: nm, level: lv, cefr: cefr, exam: pick(exams) });
    }
    var back = AI.toAI(AI.fromAI({ langs: langs }, {}, n % 2 ? 'en' : 'tr')).langs;
    if (show(back) !== show(langs)) bad.push([langs, back]);
  }
  check('300 generated language lists round-trip', bad.slice(0, 3), []);
})();

// ---- parse.js changing underneath: ai.js keeps working without it
(function () {
  var saved = globalThis.CVParse;
  globalThis.CVParse = {};
  var a, r, f;
  try {
    a = AI.toAI(FULL);
    r = AI.scrub('0532 123 45 67 ayse@gmail.com 12345678950');
    f = AI.fromAI(AICV, {}, 'tr');
  } catch (e) { a = 'THREW ' + e; }
  globalThis.CVParse = saved;
  ok('toAI without CVParse', a && a.phone === '' && Array.isArray(a.skills) && a.skills.length === 3, a);
  check('scrub without CVParse', r && r.text, '[telefon] [e-posta] [kimlik no]');
  check('scrub without CVParse formats the phone', r && r.found.phone, MOBILE);
  ok('fromAI without CVParse', f && typeof f.langs === 'string' && f.langs.indexOf('İngilizce') === 0, f && f.langs);
})();

// ---------------------------------------------------------------------------------------------
// access code from the invite link (read once at load)
// ---------------------------------------------------------------------------------------------
check('code read from #k=', AI.getCode(), 'DAVET-42');
check('code removed from the address bar', replacedUrls, ['/app/?x=1']);
AI.setCode('  YENI  ');
check('setCode trims', AI.getCode(), 'YENI');
check('setCode stores under sesli-cv:code', store['sesli-cv:code'], 'YENI');

// ---------------------------------------------------------------------------------------------
// call(): request and error mapping
// ---------------------------------------------------------------------------------------------
var lastReq = null;
function stubFetch(status, body, headers) {
  globalThis.fetch = function (url, init) {
    lastReq = { url: url, init: init };
    if (status === 'network') return Promise.reject(new TypeError('Failed to fetch'));
    if (status === 'abort') { var e = new Error('aborted'); e.name = 'AbortError'; return Promise.reject(e); }
    return Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: status, headers: headers || {} }));
  };
}
function callWith(status, body, headers) {
  stubFetch(status, body, headers);
  var r = settle(AI.call('extract', { answer: 'x' }));
  globalThis.fetch = fakeFetch;
  return r;
}
(function () {
  var r = callWith(200, { cv: {}, heard: 'ok' });
  check('call success value', r.value, { cv: {}, heard: 'ok' });
  check('call URL', lastReq.url, '/api/cv');
  check('call method', lastReq.init.method, 'POST');
  check('call body has op', JSON.parse(lastReq.init.body), { op: 'extract', answer: 'x' });
  check('call sends the access code', lastReq.init.headers['X-Access-Code'], 'YENI');
  check('call content type', lastReq.init.headers['Content-Type'], 'application/json');
  AI.setCode('');
  callWith(200, {});
  check('call without a code sends no header', Object.prototype.hasOwnProperty.call(lastReq.init.headers, 'X-Access-Code'), false);
  AI.setCode('YENI');
  check('call 200 with empty body', callWith(200, '').value, {});
})();
[
  // [status, body, code, retryable]
  [429, { error: 'rate_limited', message: 'Çok fazla istek.', retryAfter: 30 }, 'rate_limited', true],
  [502, { error: 'upstream', message: 'Ulaşılamıyor.' }, 'upstream', true],
  [500, { error: 'internal', message: 'Hata.' }, 'internal', true],
  [504, 'Gateway Timeout', 'http_504', true],
  [503, { error: 'not_configured', message: 'Ayarlanmamış.' }, 'not_configured', false],
  [500, { error: 'bad_request', message: 'x' }, 'bad_request', false],
  [400, { error: 'bad_request', message: 'Geçersiz.' }, 'bad_request', false],
  [401, { error: 'access_code', message: 'Kod.' }, 'access_code', false],
  [413, { error: 'too_large', message: 'Büyük.' }, 'too_large', false],
  [415, { error: 'unsupported_media_type', message: 'x' }, 'unsupported_media_type', false],
  [404, 'Not found', 'unavailable', false],
  [418, '', 'http_418', false]
].forEach(function (r) {
  var res = callWith(r[0], r[1]);
  var e = res.error || {};
  check('call ' + r[0] + ' ' + show(r[1]).slice(0, 30) + ' → code', e.code, r[2]);
  check('call ' + r[0] + ' ' + r[2] + ' → retryable', e.retryable, r[3]);
  check('call ' + r[0] + ' → status', e.status, r[0]);
  ok('call ' + r[0] + ' → message', typeof e.message === 'string' && e.message.length > 0, e);
});
check('call 429 retryAfter from body', callWith(429, { error: 'rate_limited', message: 'x', retryAfter: 30 }).error.retryAfter, 30);
check('call 429 retryAfter from header', callWith(429, { error: 'rate_limited', message: 'x' }, { 'Retry-After': '12' }).error.retryAfter, 12);
check('call message from server', callWith(400, { error: 'bad_request', message: 'Cevap boş görünüyor.' }).error.message, 'Cevap boş görünüyor.');
check('call 404 message', callWith(404, '').error.message, 'Yapay zekâ hizmeti bu adreste çalışmıyor.');
(function () {
  var e = callWith('network').error;
  check('network error', [e.code, e.retryable, e.status], ['network', true, 0]);
  ok('network message is Turkish', /İnternet/.test(e.message), e.message);
  var a = callWith('abort').error;
  check('aborted call', [a.code, a.retryable], ['cancelled', false]);
})();

// ---------------------------------------------------------------------------------------------
// tests/fake-ai.js through CVAI.call (what dev.html runs)
// ---------------------------------------------------------------------------------------------
var F = globalThis.fakeAI;
F.delay = 0;
function fake(op, payload) { return settle(AI.call(op, payload)); }
(function () {
  F.reset();
  check('fake ping', fake('ping', {}).value, { ok: true, configured: true });

  var cv = AI.toAI(FULL);
  var ex = fake('extract', { cv: cv, lang: 'tr', topic: 'experience', question: 'Nerede çalıştınız?', answer: 'Ekol Lojistik\'te depo sorumlusuydum.' }).value;
  check('fake extract experience: missing', ex.missing.length, 1);
  check('fake extract experience: confirm', ex.confirm, ['Örnek A.Ş.']);
  check('fake extract experience: job added', ex.cv.jobs.length, 2);
  ok('fake extract heard', /experience/.test(ex.heard), ex.heard);
  var about = fake('extract', { cv: cv, topic: 'about', answer: 'Ben Ayşe.' }).value;
  check('fake extract about: no confirm', about.confirm, []);
  check('fake extract about: one missing question', about.missing.length, 1);
  check('fake extract followup: no missing', fake('extract', { cv: cv, topic: 'followup', answer: 'Mart 2019.' }).value.missing, []);
  check('fake extract empty answer → 400', fake('extract', { cv: cv, topic: 'about', answer: '' }).error.code, 'bad_request');
  var sk = fake('extract', { cv: cv, topic: 'skills', profile: 'yazilim', answer: 'Python ve SQL' }).value;
  check('fake extract skills (yazilim) groups', sk.cv.skillGroups.map(function (g) { return g.name; }), ['Diller', 'Veritabanı']);
  var lang = fake('extract', { cv: cv, topic: 'extras', answer: 'İngilizce biliyorum' }).value;
  check('fake extract extras adds a language', lang.cv.langs[lang.cv.langs.length - 1], { name: 'İngilizce', level: 3, cefr: 'B2', exam: '' });

  var hints = ['Soru 1?', 'Soru 2?', 'soru 2?', 'Soru 3?', 'Soru 4?', 'Soru 5?', 'Soru 6?', 'Soru 7?'];
  check('fake review echoes hints (max 5, de-duplicated)', fake('review', { cv: cv, hints: hints }).value.followups, ['Soru 1?', 'Soru 2?', 'Soru 3?', 'Soru 4?', 'Soru 5?']);
  check('fake review without hints', fake('review', { cv: cv }).value.followups.length, 2);

  check('fake tailor short ad → 400', fake('tailor', { cv: cv, ad: 'kısa ilan' }).error.code, 'bad_request');
  var ad = 'Firma: Kuzey Lojistik\nPozisyon: Depo Şefi\nAranan nitelikler: SAP ve Excel bilgisi, forklift ehliyeti, vardiyalı çalışma.';
  var t = fake('tailor', { cv: cv, ad: ad, lang: 'tr', profile: 'saha', style: 'kisisel' }).value;
  check('fake tailor company/role', [t.company, t.role], ['Kuzey Lojistik', 'Depo Şefi']);
  check('fake tailor keeps the same skills, ad terms first', t.cv.skills, ['Forklift', 'SAP', 'Excel']);
  check('fake tailor matched', t.matched.map(function (m) { return m.term; }), ['Forklift', 'SAP', 'Excel']);
  ok('fake tailor missing has questions', t.missing.length >= 1 && t.missing.every(function (m) { return m.term && m.question; }), t.missing);
  ok('fake tailor changes', t.changes.length >= 2, t.changes);
  check('fake tailor keeps facts', [t.cv.jobs.length, t.cv.jobs[0].company], [1, 'Ekol Lojistik']);
  check('fake tailor reverses bullets', t.cv.jobs[0].bullets, ['Ekip yönetimi', 'Günde 120 palet']);

  var c0 = fake('cover', { cv: cv, target: 'Depo Sorumlusu' }).value;
  check('fake cover without an ad: 3 paragraphs', c0.letter.paragraphs.length, 3);
  check('fake cover without an ad: subject', c0.letter.subject, 'Depo Sorumlusu pozisyonu başvurusu');
  check('fake cover letter keys', Object.keys(c0.letter).sort(), ['closing', 'greeting', 'paragraphs', 'recipient', 'subject']);
  var c1 = fake('cover', { cv: cv, ad: ad }).value;
  check('fake cover with an ad: 4 paragraphs', c1.letter.paragraphs.length, 4);
  check('fake cover with an ad: company', [c1.company, c1.letter.recipient[0]], ['Kuzey Lojistik', 'Kuzey Lojistik']);
  var c2 = fake('cover', { cv: cv, ad: ad, letter: c1.letter, instruction: 'daha kısa yaz' }).value;
  check('fake cover revision keeps paragraphs', c2.letter.paragraphs.length, 4);
  ok('fake cover revision changes text', c2.letter.paragraphs[3] !== c1.letter.paragraphs[3] && /daha kısa yaz/.test(c2.letter.paragraphs[3]), c2.letter.paragraphs[3]);
  ok('fake cover revision reply', /güncellendi/.test(c2.reply), c2.reply);
  check('fake cover letter without instruction → new letter', fake('cover', { cv: cv, ad: ad, letter: c1.letter }).value.letter.paragraphs, c1.letter.paragraphs);

  check('fake finalize resmi', /resmi/.test(fake('finalize', { cv: cv, style: 'resmi' }).value.cv.summary), true);
  check('fake unknown op', fake('nope', {}).error.code, 'bad_request');

  // failure modes
  F.failOps = { tailor: 'upstream' };
  var ft = fake('tailor', { cv: cv, ad: ad }).error;
  check('fake failOps tailor', [ft.code, ft.retryable, ft.status], ['upstream', true, 502]);
  check('fake failOps leaves other ops alone', fake('ping', {}).value.ok, true);
  F.failOps = {};
  F.fail = 'network';
  check('fake fail network', fake('ping', {}).error.code, 'network');
  F.fail = 'rate_limited';
  var rl = fake('extract', { cv: cv, topic: 'about', answer: 'x' }).error;
  check('fake fail rate_limited', [rl.code, rl.retryable, rl.retryAfter], ['rate_limited', true, 30]);
  F.fail = 'not_configured';
  check('fake fail not_configured', [fake('ping', {}).error.code, fake('ping', {}).error.retryable], ['not_configured', false]);
  F.fail = 'access_code';
  check('fake fail access_code', fake('ping', {}).error.code, 'access_code');
  F.fail = null;
  F.failOps = { cover: 'bad_request' };
  check('fake failOps bad_request', fake('cover', { cv: cv }).error.retryable, false);
  F.failOps = {};

  // helpers
  check('fake calls recorded', F.count() > 10, true);
  check('fake last(op)', F.last('tailor').ad, ad);
  check('fake last(missing op)', F.last('translate'), null);
  check('fake count(op)', F.count('cover'), 5);
  check('fake sent()', F.sent('Kuzey Lojistik'), true);
  check('fake headers carry the code', F.headers[F.headers.length - 1]['X-Access-Code'], 'YENI');
  F.reset();
  check('fake reset', [F.count(), F.fail, F.failOps], [0, null, {}]);
  // an aborted request (the app cancels its calls when the data is wiped) rejects as 'cancelled'
  var gone = settle(AI.call('extract', { cv: {}, topic: 'about', question: 'q', answer: 'a' }, { signal: { aborted: true, addEventListener: function () {} } }));
  check('fake abort → cancelled', [gone.error && gone.error.code, gone.error && gone.error.retryable, F.aborted], ['cancelled', false, 1]);
  var later = null;
  var sig = { aborted: false, addEventListener: function (t, f) { later = f; } };
  var kept = settle(AI.call('ping', {}, { signal: sig }));
  if (later) later(); // aborting after the answer arrived changes nothing
  check('fake abort after the answer', [kept.value && kept.value.ok, F.aborted], [true, 1]);
  F.reset();
})();

// ---- end to end: nothing private reaches the (fake) server when the app scrubs and minimises
(function () {
  F.reset();
  var answer = 'Telefonum 0532 123 45 67, e-postam ayşe nokta kaya et gmail nokta com, TC 12345678950. 2019-2021 arasında Ekol\'de 120 palet.';
  var s = AI.scrub(answer, { name: FULL.name });
  fake('extract', { cv: AI.toAI(FULL), lang: 'tr', topic: 'experience', question: 'q', answer: s.text });
  ['0532', '123 45 67', 'ayse@gmail.com', 'ayşe nokta kaya', '12345678950', '0533', 'Ali Veli', 'Yapıldı', 'Evli', 'base64'].forEach(function (x) {
    check('server never sees ' + show(x), F.sent(x), false);
  });
  check('server still gets the content', F.sent('2019-2021 arasında Ekol\'de 120 palet'), true);
  check('found phone for the contact card', s.found.phone, MOBILE);
  check('found e-mail for the contact card', s.found.email, 'ayse.kaya@gmail.com');
})();

// ---------------------------------------------------------------------------------------------
print('ai: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) throw new Error(failed + ' ai test(s) failed');
