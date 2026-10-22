/*
 * tests/app.test.js — behaviour tests for public/app.js, run in JavaScriptCore on tests/app-env.js.
 *
 *   jsc tests/app-env.js tests/app.test.js -- <scenario>      (from the project folder; sh tests/run-ai.sh runs all)
 *
 * Scenarios (one jsc process each, because the app starts once per page):
 *   desktop  continuous speech recognition: interview, K1 voice, queue races, wipe, final-screen tools
 *   android  one-shot recognition (a pause ends the utterance) and a touch screen
 *   v1       data saved by version 1 of the app, in a browser without speech recognition
 *
 * The AI is a stub (CVAI.call): G.aiResp[op](payload) answers, G.aiFail[op] fails, G.hold keeps calls in
 * G.held until the test answers them (h.res / h.rej). parse.js, ai.js and github.js are the real ones;
 * pdfdoc.js is stubbed (it is being rewritten separately and is not under test here).
 */
/* global load, readFile, print, G, SCENARIO, advance, settle, say, lateFinal, liveCount, liveRecs, ttsSpeaking, ttsLog, srLog, __store */

// ---------------------------------------------------------------- per-scenario browser
if (SCENARIO === 'android') {
  navigator.userAgent = 'Mozilla/5.0 (Linux; Android 13; Redmi Note 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
  navigator.maxTouchPoints = 5;
  G.matchMedia = function (q) { return { matches: q === '(pointer: coarse)', addEventListener: function () {} }; };
  G.ONE_SHOT = true;
}
if (SCENARIO === 'v1') {
  delete G.SpeechRecognition;
  delete G.webkitSpeechRecognition;
  localStorage.setItem('sesli-cv:v1', JSON.stringify({
    cv: { name: 'Ayşe Kaya', jobs: [{ role: 'Muhasebe Uzmanı', company: 'Kuzey Lojistik' }] },
    settings: { template: 'sade', accent: '#1F5C4A', lang: 'tr', showPhoto: true, tts: true, autoNext: true, speechLang: 'tr-TR' }, step: 11, t: 1,
  }));
}
localStorage.setItem('sesli-cv:primed', '1');

load('public/parse.js');
load('public/speech.js');
// PDF stub with the v2 API (templates, default template, letter, file names)
G.pdfCalls = [];
G.CVPdf = {
  ACCENTS: ['#1F5C4A', '#1F3A5C'],
  TEMPLATES: [{ id: 'klasik', tr: 'Klasik', photo: true, desc: 'Kurumsal başvurular' }, { id: 'sade', tr: 'Sade', photo: false, desc: 'İlan siteleri (ATS)' }, { id: 'modern', tr: 'Modern', photo: true, desc: 'E-posta' }],
  SAMPLE: { name: 'Örnek' },
  SAMPLES: { deneyimli: { name: 'Örnek D' }, ogrenci: { name: 'Örnek Ö' }, saha: { name: 'Örnek S' }, yazilim: { name: 'Örnek Y' } },
  hasContent: function (c) { return !!(c && (c.name || (c.jobs && c.jobs.length))); },
  fileName: function (cv, o) { o = o || {}; var n = String((cv && cv.name) || 'CV').replace(/\s+/g, '-'); return o.kind === 'letter' ? n + '-On-Yazi.pdf' : n + '-CV' + (o.suffix ? '-' + String(o.suffix).replace(/\s+/g, '-') : '') + '.pdf'; },
  labels: function () { return { profile: 'Profil', experience: 'Deneyim', education: 'Eğitim', skills: 'Yetenekler', languages: 'Diller', certs: 'Sertifikalar' }; },
  build: function (cv, opts) { pdfCalls.push({ fn: 'build', cv: JSON.parse(JSON.stringify(cv)), opts: opts }); return { content: [] }; },
  buildLetter: function (letter, cv, opts) { pdfCalls.push({ fn: 'buildLetter', letter: letter, cv: cv, opts: opts }); return { content: [] }; },
  defaultTemplate: function (p, o) { return p === 'yazilim' || (o && o.lang === 'en') ? 'sade' : 'klasik'; },
  registerFonts: function () {},
};
load('public/ai.js');
load('public/github.js');

// AI stub: no network; records calls, answers per op, can fail per op, can hold calls.
G.aiCalls = [];
G.aiFail = {};
G.aiResp = {};
G.hold = false;
G.held = [];
G.ignoreAbort = false; // true: a held call still answers after it was aborted (a reply that was already on its way)
CVAI.call = function (op, payload, opts) {
  var p = JSON.parse(JSON.stringify(payload || {}));
  aiCalls.push({ op: op, payload: p });
  if (op === 'ping') return Promise.resolve({ ok: true, configured: true });
  if (G.hold) {
    return new Promise(function (res, rej) {
      var h = { op: op, payload: p, res: res, rej: rej };
      held.push(h);
      var sig = opts && opts.signal;
      if (sig && sig.addEventListener) sig.addEventListener('abort', function () { if (!G.ignoreAbort) rej({ status: 0, code: 'cancelled', message: '', retryable: false }); });
    });
  }
  if (aiFail[op]) return Promise.reject(aiFail[op]);
  if (aiResp[op]) return Promise.resolve(aiResp[op](p));
  var cv = p.cv || {};
  if (op === 'extract') return Promise.resolve({ cv: cv, heard: '(test) ' + p.topic, missing: [], confirm: [] });
  if (op === 'review') return Promise.resolve({ followups: [] });
  if (op === 'finalize' || op === 'translate') return Promise.resolve({ cv: cv });
  if (op === 'edit') return Promise.resolve({ cv: cv, reply: 'Tamam.' });
  if (op === 'tailor') return Promise.resolve({ cv: cv, company: 'Kuzey Lojistik', role: 'Muhasebe Uzmanı', matched: [], missing: [], changes: [] });
  if (op === 'cover') return Promise.resolve({ letter: p.letter || { paragraphs: ['Birinci.', 'İkinci.', 'Üçüncü.'], subject: 'Başvuru', greeting: 'Sayın İlgili,', closing: 'Saygılarımla,', recipient: [] }, company: '', role: '', reply: 'Tamam.' });
  return Promise.reject({ status: 400, code: 'bad_request', message: 'x', retryable: false });
};
G.callsOf = function (op) { return aiCalls.filter(function (c) { return c.op === op; }); };

load('public/app.js');

// ---------------------------------------------------------------- helpers
var passed = 0, failed = 0;
var A = CVApp;
Object.defineProperty(G, 'S', { get: function () { return A.state; } });
var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return (r || document).querySelectorAll(s); };
function show(v) { return v === undefined ? 'undefined' : JSON.stringify(v); }
function eq(a, b, name) { if (show(a) === show(b)) passed++; else { failed++; print('FAIL ' + name + '\n     expected: ' + show(b) + '\n     actual:   ' + show(a)); } }
function ok(c, name, info) { if (c) passed++; else { failed++; print('FAIL ' + name + (info === undefined ? '' : '\n     ' + show(info))); } }
function btn(txt, root) {
  var all = $$('button', root);
  for (var i = 0; i < all.length; i++) if (all[i].textContent.trim() === txt) return all[i];
  for (var j = 0; j < all.length; j++) if (all[j].textContent.indexOf(txt) >= 0) return all[j];
  throw new Error('button not found: ' + txt);
}
function input(el, v) { el.value = v; el.dispatchEvent(new Event('input')); }
function change(el, v) { if (v !== undefined) el.value = v; el.dispatchEvent(new Event('change')); }
function words(n) { var w = []; for (var i = 0; i < n; i++) w.push('kelime' + i); return w.join(' '); }
function long(s) { return s + ' ' + words(20); }
function topicId() { var t = A.topics[A.iv.idx]; return A.iv.phase === 'followups' ? 'followup' : t && t.id; }
function topicIndex(id) { return A.topics.findIndex(function (t) { return t.id === id; }); }
function text(sel) { var el = $(sel); return el ? el.textContent : ''; }
function storedKeys() { return Object.keys(__store()).filter(function (k) { return k.indexOf('sesli-cv:') === 0 && k !== 'sesli-cv:primed'; }); }
function lastTts() { var l = ttsLog.filter(function (e) { return e.ev === 'tts-start'; }); return l.length ? l[l.length - 1].text : ''; }
/** A clean device: everything wiped, AI stub reset, nothing held, the page visible. */
function fresh() {
  G.hold = false; G.ignoreAbort = false; G.held = []; G.aiFail = {}; G.aiResp = {};
  document.hidden = false;
  A.wipeData();
  settle();
  localStorage.setItem('sesli-cv:primed', '1');
  S.ui.micPrimed = true;
  S.settings.tts = false;
}
/** Intro → profile → consent → first question. */
function startInterview(profile, tts) {
  A.goStep(0); settle();
  S.settings.tts = !!tts;
  $('#btn-start').click(); settle();
  btn(profile || 'İş deneyimim var').click(); settle();
  if (!A.hasConsent()) { btn('Kabul ediyorum, başlayalım').click(); settle(); }
  var prime = $('[data-fkey="prime-yes"]'); if (prime) { prime.click(); settle(); }
}
function answer(t) { input($('#answer'), t); $('#btn-next').click(); settle(); }
var ABOUT = long('Adım Ayşe Kaya. Altı yıldır İzmir Bornova’da muhasebe uzmanı olarak çalışıyorum.');
var CV1 = {
  name: 'Ayşe Kaya', title: 'Muhasebe Uzmanı', phone: '0532 123 45 67', email: 'ayse.kaya@gmail.com', city: 'İzmir', summary: 'Altı yıllık muhasebe uzmanı.',
  skills: 'Excel, SAP', refs: 'Mehmet Demir, Kuzey Lojistik, 0533 777 66 55', birth: '1990', military: 'Yapıldı (2012)', marital: 'Evli',
  jobs: [{ company: 'Kuzey Lojistik', role: 'Muhasebe Uzmanı', start: 'Mart 2019', end: 'Devam ediyor', desc: 'Beyannameleri hazırladım.' }], edu: [], projects: [],
};
/** The final screen with a filled CV and consent given. */
function finalScreen(cvData) {
  A.giveConsent();
  A.load(JSON.parse(JSON.stringify(cvData || CV1)));
  A.goStep(99); settle();
}
function section(name) { G.SECTION = name; }

// =================================================================================================
if (SCENARIO === 'desktop') {
  settle();

  // ---- an AI reply never overwrites what was typed while it was out (K1 links, K2 licence)
  section('race');
  fresh(); startInterview();
  G.hold = true;
  answer(ABOUT);
  eq(topicId(), 'contact', 'race: on the contact card while the first answer is processed');
  eq(held.length, 1, 'race: the about extract is in flight');
  input($('#k-web'), 'linkedin.com/in/aysekaya');
  input($('#k-github'), 'github.com/aysekaya');
  input($('#k-phone'), '0532 123 45 67');
  var h0 = held.shift();
  var r0 = JSON.parse(JSON.stringify(h0.payload.cv)); r0.name = 'Ayşe Kaya'; r0.title = 'Muhasebe Uzmanı'; r0.city = 'İzmir';
  h0.res({ cv: r0, heard: 'ok', missing: [], confirm: [] }); settle();
  eq([S.cv.web, S.cv.github, S.cv.phone], ['linkedin.com/in/aysekaya', 'github.com/aysekaya', '0532 123 45 67'], 'race: K1 fields typed during the call survive');
  eq([S.cv.name, S.cv.title, S.cv.city], ['Ayşe Kaya', 'Muhasebe Uzmanı', 'İzmir'], 'race: the reply itself is applied');
  // K2: the licence chip tapped while the goal answer is out
  A.talkGoto(topicIndex('goal')); settle();
  answer(long('Muhasebe ya da finans tarafında İzmir’de bir iş arıyorum, bir ay içinde başlayabilirim.'));
  eq(topicId(), 'personal', 'race: on the personal card');
  var sw = $('#k2-license-sw'); sw.checked = true; sw.dispatchEvent(new Event('change')); settle();
  btn('B sınıfı').click(); settle();
  var h1 = held.shift();
  h1.res({ cv: JSON.parse(JSON.stringify(h1.payload.cv)), heard: 'ok', missing: [], confirm: [] }); settle();
  eq(S.cv.license, 'B sınıfı', 'race: licence set on K2 during the call survives');
  // a field nobody touched takes the AI's value
  A.talkGoto(topicIndex('extras')); settle();
  answer('B sınıfı ehliyetim var.');
  var h2 = held.shift();
  var r2 = JSON.parse(JSON.stringify(h2.payload.cv)); r2.license = 'B sınıfı'; r2.certs = ['SRC belgesi'];
  h2.res({ cv: r2, heard: 'ok', missing: [], confirm: [] }); settle();
  eq(S.cv.certs, 'SRC belgesi', 'race: untouched fields still come from the reply');

  // ---- a job edited here while an experience answer is out: the answer is asked again with today's CV
  section('conflict');
  fresh(); startInterview();
  S.cv.jobs.push({ id: 'j1', company: 'Kuzey Lojistik', role: 'Muhasebe Uzmanı', city: '', start: 'Mart 2019', end: 'Devam ediyor', desc: '' });
  G.hold = true;
  A.talkGoto(topicIndex('experience')); settle();
  var nEx = callsOf('extract').length;
  answer(long('Ondan önce 2015 ile 2019 arasında Mavi Market’te kasiyerdim.'));
  S.cv.jobs[0].end = '2023';
  var c0 = held.shift();
  var rc = JSON.parse(JSON.stringify(c0.payload.cv)); rc.jobs.push({ company: 'Mavi Market', role: 'Kasiyer', start: '2015', end: '2019', bullets: ['Kasa'] });
  c0.res({ cv: rc, heard: 'ok', missing: [], confirm: [] }); settle();
  eq(callsOf('extract').length - nEx, 2, 'conflict: the answer is sent again');
  eq(held.length ? held[0].payload.cv.jobs[0].end : '', '2023', 'conflict: the second call carries the local edit');
  var c1 = held.shift();
  var rc1 = JSON.parse(JSON.stringify(c1.payload.cv)); rc1.jobs.push({ company: 'Mavi Market', role: 'Kasiyer', start: '2015', end: '2019', bullets: ['Kasa'] });
  c1.res({ cv: rc1, heard: 'ok', missing: [], confirm: [] }); settle();
  eq(S.cv.jobs.map(function (j) { return j.company + ':' + j.end; }), ['Kuzey Lojistik:2023', 'Mavi Market:2019'], 'conflict: both the edit and the answer are in the CV');
  eq(A.iv.pending.length, 0, 'conflict: queue empty');

  // ---- K1 by voice
  section('contact');
  fresh(); startInterview();
  answer(ABOUT);
  eq(topicId(), 'contact', 'contact: on K1');
  ok(liveCount() > 0, 'contact: listening on K1');
  input($('#k-phone'), '0532 123 45 67'); change($('#k-phone'));
  say('bir dakika'); settle();
  eq(S.cv.phone, '0532 123 45 67', 'contact: “bir dakika” does not touch the phone');
  eq(text('#rb-phone'), '', 'contact: and is not taken for the start of a number');
  say('ayşe kaya seksen beş et gmail nokta com'); settle();
  eq([S.cv.phone, S.cv.email], ['0532 123 45 67', 'aysekaya85@gmail.com'], 'contact: a dictated e-mail with digits goes to the e-mail, not the phone');
  ok(text('#rb-email').indexOf('aysekaya85@gmail.com') >= 0, 'contact: the e-mail is read back');
  say('Evet doğru yazdınız'); settle();
  eq(text('#rb-email'), '', 'contact: a confirmation with more words closes the read-back');
  // a number said in two breaths
  input($('#k-phone'), '');
  say('sıfır beş yüz otuz iki'); settle();
  eq(S.cv.phone, '', 'contact: half a number is not written into the field');
  ok(text('#rb-phone').indexOf('Duyduğum') >= 0, 'contact: the half is shown', text('#rb-phone'));
  ok(liveCount() > 0, 'contact: still listening for the rest');
  say('yüz yirmi üç kırk beş altmış yedi'); settle();
  eq(S.cv.phone, '0532 123 45 67', 'contact: the two halves are joined');
  ok(text('#rb-phone').indexOf('olarak yazdım') >= 0, 'contact: the whole number is read back');
  say('Hayır, sıfır beş yüz kırk iki yüz yirmi üç kırk beş altmış yedi'); settle();
  eq(S.cv.phone, '0542 123 45 67', 'contact: “hayır” with the correction in the same breath');
  say('Doğru, teşekkürler'); settle();
  eq(text('#rb-phone'), '', 'contact: “Doğru, teşekkürler” confirms');
  say('iki e-postam var'); settle();
  eq([S.cv.phone, text('#rb-phone')], ['0542 123 45 67', ''], 'contact: a sentence with a number is not a phone');
  ok(A.isPhoneSpeech('telefonum sıfır beş yüz otuz iki') && !A.isPhoneSpeech('bir dakika') && !A.isPhoneSpeech('iki yıl çalıştım'), 'contact: what counts as a spoken number');
  // C6: the K1 mic tapped while the question is still being read
  S.settings.tts = true;
  A.talkGoto(A.iv.idx); advance(300);
  ok(ttsSpeaking(), 'C6: the contact question is being read');
  $('.k-mic').click(); advance(100);
  ok(!(ttsSpeaking() && liveCount() > 0), 'C6: the mic never opens over the app’s own voice');
  settle();
  eq($('#btn-mic').dataset.state, 'listening', 'C6: the dock does not stay in “Soru okunuyor…”');
  S.settings.tts = false;

  // ---- an e-mail heard in the first answer is written in, then confirmed on K1
  section('email-check');
  fresh(); startInterview();
  answer(long('Adım Ayşe Kaya, muhasebeciyim. Mailim ayşe kaya et gmail nokta com.'));
  eq(S.cv.email, 'aysekaya@gmail.com', 'email-check: the lead-in word marks where the address starts');
  ok(callsOf('extract').every(function (c) { return JSON.stringify(c.payload).indexOf('gmail') < 0; }), 'email-check: the address never reaches the AI');
  fresh(); startInterview();
  answer(long('Adım Ayşe Kaya, muhasebeciyim, ayşe kaya et gmail nokta com.'));
  eq(S.cv.email, 'kaya@gmail.com', 'email-check: without a lead-in only the last word is taken');
  eq(topicId(), 'contact', 'email-check: on K1');
  ok(text('#rb-email').indexOf('Cevabınızdan e-postanızı') >= 0, 'email-check: K1 asks to confirm it', text('#rb-email'));
  say('hayır'); settle();
  eq(S.cv.email, '', 'email-check: “hayır” clears the wrong address');
  eq(A.iv.emailCheck, '', 'email-check: nothing left to confirm');

  // ---- short answers are real answers; contact-only answers stay on the device
  section('short');
  fresh();
  G.aiResp.review = function () { return { followups: ['Kaç kişilik bir ekibi yönettiniz?', 'Not ortalamanız kaçtı?', 'Sürücü belgenizin sınıfı nedir?', 'Telefonunuz nedir?'] }; };
  startInterview();
  A.talkGoto(A.topics.length - 1); settle();
  $('#btn-next').click(); settle();
  eq(A.iv.phase, 'followups', 'short: follow-ups started');
  var nShort = callsOf('extract').length;
  answer('5'); answer('3,2'); answer('B'); answer('0532 123 45 67');
  eq(callsOf('extract').slice(nShort).map(function (c) { return c.payload.answer; }), ['5', '3,2', 'B'], 'short: short answers are sent, a bare phone number is not');
  eq(S.cv.phone, '0532 123 45 67', 'short: the phone number filled the contact field here');

  // ---- “Verilerimi sil” / “Yeni CV başlat” while a call is out
  section('wipe');
  fresh(); startInterview();
  G.hold = true; G.ignoreAbort = true;
  answer(ABOUT);
  eq(held.length, 1, 'wipe: extract in flight');
  $('#btn-settings').click(); settle();
  btn('Verilerimi sil').click(); settle();
  btn('Evet, hepsini sil').click(); settle();
  eq(storedKeys(), [], 'wipe: storage empty');
  var w0 = held.shift();
  var rw = JSON.parse(JSON.stringify(w0.payload.cv)); rw.name = 'Ayşe Kaya'; rw.summary = 'Özet.';
  w0.res({ cv: rw, heard: 'ok', missing: [], confirm: [] }); settle();
  eq(S.cv.name, '', 'wipe: a late reply is not applied');
  eq(storedKeys(), [], 'wipe: a late reply is not saved');
  eq(A.ai.running, false, 'wipe: the queue is free again');
  // reset, then a new person answers before the old reply lands
  fresh(); startInterview();
  G.hold = true; G.ignoreAbort = true;
  answer(ABOUT);
  var old = held.shift();
  A.resetAll(); settle();
  G.hold = true;
  startInterview();
  answer(long('Adım Mehmet Yılmaz, on yıldır forklift operatörüyüm, Gebze’de oturuyorum.'));
  var rOld = JSON.parse(JSON.stringify(old.payload.cv)); rOld.name = 'Ayşe Kaya';
  old.res({ cv: rOld, heard: 'old', missing: [], confirm: [] }); settle();
  eq(S.cv.name, '', 'reset: the old person’s reply does not land in the new CV');
  eq(held.length, 1, 'reset: the new answer is sent');
  var nw = held.shift();
  var rNew = JSON.parse(JSON.stringify(nw.payload.cv)); rNew.name = 'Mehmet Yılmaz';
  nw.res({ cv: rNew, heard: 'new', missing: [], confirm: [] }); settle();
  eq([S.cv.name, A.iv.pending.length], ['Mehmet Yılmaz', 0], 'reset: the new answer is applied and the queue is empty');
  // abort: a call still out is cancelled quietly
  fresh(); finalScreen();
  G.hold = true;
  S.ui.adDraft = 'Kuzey Lojistik muhasebe uzmanı arıyor. Excel ve SAP bilen, beyanname hazırlayabilen adaylar.';
  A.doTailor(); settle();
  eq(held.length, 1, 'wipe: tailor in flight');
  A.wipeData(); settle();
  eq([S.ui.tailored, storedKeys()], [null, []], 'wipe: an aborted tailor call leaves nothing behind');
  eq(text('#toast').indexOf('alınamadı') < 0, true, 'wipe: no error toast for the cancelled call');

  // ---- the experience loop keeps an earlier job said together with “evet”
  section('loop');
  fresh(); startInterview();
  A.talkGoto(topicIndex('experience')); settle();
  answer(long('2019’dan beri Kuzey Lojistik’te muhasebe uzmanıyım.'));
  eq(A.iv.expLoop, 'ask', 'loop: asks about an earlier job');
  say('Evet, 2015ten 2018e kadar Mavi Markette kasiyerdim'); settle();
  eq([A.iv.expLoop, A.iv.draft], ['more', '2015ten 2018e kadar Mavi Markette kasiyerdim'], 'loop: the description stays in the draft');
  ok(text('#step').indexOf('Hiç çalışmadıysanız') < 0 && text('#step').indexOf('Başka yoksa') >= 0, 'loop: “Önceki işiniz” has its own skip line');
  say('bitti'); settle();
  ok(callsOf('extract').some(function (c) { return c.payload.answer.indexOf('Mavi Markette') >= 0; }), 'loop: the earlier job is sent');
  eq(A.iv.expLoop, 'ask', 'loop: asks again');
  say('Sanırım yok'); settle();
  eq([topicId(), A.iv.expLoop], ['education', ''], 'loop: “Sanırım yok” moves on');
  A.talkGoto(topicIndex('experience')); settle();
  answer(long('Bir başka iş daha anlatayım, Gebze’de depoda çalıştım.'));
  say('Evet'); settle();
  eq([A.iv.expLoop, A.iv.draft], ['more', ''], 'loop: a bare “evet” opens an empty answer');
  eq(A.topicsFor('ogrenci').find(function (t) { return t.id === 'experience'; }).moreLabel, 'Önceki staj ya da göreviniz', 'loop: students get their own eyebrow');

  // ---- end words with acknowledgements around them
  section('end-words');
  fresh(); startInterview();
  ['Tamam, bitti.', 'bitti tamam', 'evet bu kadar', 'okey bitti', 'Cevabım bu kadar', 'bitti bitti', 'tamam sonraki soru'].forEach(function (w) {
    A.talkGoto(topicIndex('skills')); settle();
    say('Excel ve SAP biliyorum'); settle();
    say(w); settle();
    ok(topicId() === 'extras' && A.iv.draft === '', 'end-words: ' + show(w) + ' ends the answer', [topicId(), A.iv.draft]);
  });
  A.talkGoto(topicIndex('skills')); settle();
  say('tamam'); settle();
  eq([topicId(), A.iv.draft], ['skills', ''], 'end-words: a lone “tamam” neither ends nor is written');

  // ---- follow-ups: a late final keeps its question; a bare “Evet” is an answer
  section('followups');
  fresh();
  G.aiResp.review = function () { return { followups: ['Kuzey Lojistik’te hangi yıllar arasında çalıştınız?', 'B sınıfı ehliyetiniz var mı?'] }; };
  startInterview();
  A.talkGoto(A.topics.length - 1); settle();
  say('geç'); settle();
  eq(A.iv.phase, 'followups', 'followups: started');
  var nFu = callsOf('extract').length;
  var rec1 = liveRecs()[0];
  $('#btn-next').click();
  lateFinal(rec1, '2019 ile 2023 arasında');
  settle();
  eq([A.iv.fIdx, A.iv.draft], [1, ''], 'followups: the late words do not land in the next question');
  var lateCall = callsOf('extract').slice(nFu).filter(function (c) { return c.payload.answer === '2019 ile 2023 arasında'; })[0];
  eq(lateCall && lateCall.payload.question, 'Kuzey Lojistik’te hangi yıllar arasında çalıştınız?', 'followups: they are sent with their own question');
  say('Evet var'); settle();
  eq(A.iv.draft, 'Evet var', 'followups: “Evet var” is the answer');
  say('bitti'); settle();
  ok(callsOf('extract').some(function (c) { return c.payload.answer === 'Evet var' && c.payload.question === 'B sınıfı ehliyetiniz var mı?'; }), 'followups: and it is sent');

  // ---- going back never carries a draft into the previous question
  section('back');
  fresh(); startInterview();
  A.talkGoto(topicIndex('education')); settle();
  input($('#answer'), 'Dokuz Eylül Üniversitesi İşletme bölümünden 2018de mezun oldum');
  var nB = callsOf('extract').length;
  $('#btn-back').click(); settle();
  eq([topicId(), A.iv.draft], ['experience', ''], 'back: the previous question opens empty');
  var bc = callsOf('extract').slice(nB)[0];
  eq(bc && bc.payload.topic, 'education', 'back: the draft is sent with its own topic');

  // ---- a hidden tab neither speaks nor listens
  section('hidden');
  fresh();
  G.aiResp.review = function () { return new Promise(function (res) { setTimeout(function () { res({ followups: ['Kuzey Lojistik’te hangi yıllar arasında çalıştınız?'] }); }, 5000); }); };
  startInterview(null, true);
  A.talkGoto(A.topics.length - 1); settle();
  $('#btn-next').click(); advance(500);
  eq(A.iv.phase, 'waiting', 'hidden: waiting for the review');
  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  var t0 = ttsLog.length, s0 = srLog.length;
  settle(); settle();
  eq(A.iv.phase, 'followups', 'hidden: the follow-ups are ready');
  eq(ttsLog.slice(t0).filter(function (e) { return e.ev === 'tts-start'; }).length, 0, 'hidden: nothing is spoken');
  eq(srLog.slice(s0).filter(function (e) { return e.ev === 'sr-start'; }).length, 0, 'hidden: the mic is not opened');
  document.hidden = false;

  // ---- English PDF: today's phone, e-mail and referees on top of the translation
  section('english');
  fresh(); finalScreen();
  S.settings.lang = 'en';
  G.aiResp.translate = function (p) { var c = JSON.parse(JSON.stringify(p.cv)); c.summary = 'Accountant with six years of experience.'; return { cv: c }; };
  A.doTranslate(); settle();
  eq(A.pdfCv().summary, 'Accountant with six years of experience.', 'english: the translation is used');
  S.cv.phone = '0555 000 11 22'; S.cv.email = 'yeni@ornek.com'; S.cv.refs = '';
  var en = A.pdfCv();
  eq([en.phone, en.email, en.refs, en.birth, en.summary], ['0555 000 11 22', 'yeni@ornek.com', '', '', 'Accountant with six years of experience.'], 'english: device fields follow the master');
  S.settings.lang = 'tr';

  // ---- “Geri al” after a restyle keeps today's contact details
  section('restyle-undo');
  fresh(); finalScreen();
  S.settings.bulletStyle = 'resmi'; S.ui.styleDirty = true;
  G.aiResp.finalize = function (p) { var c = JSON.parse(JSON.stringify(p.cv)); c.jobs[0].bullets = ['Beyannamelerin hazırlanması.']; return { cv: c }; };
  A.doRestyle(); settle();
  eq(S.cv.jobs[0].desc, 'Beyannamelerin hazırlanması.', 'restyle-undo: rewritten');
  S.cv.phone = '0532 999 88 77'; S.cv.refs = '';
  A.undoRestyle(); settle();
  eq([S.cv.jobs[0].desc, S.cv.phone, S.cv.refs], ['Beyannameleri hazırladım.', '0532 999 88 77', ''], 'restyle-undo: bullets back, contact details kept');

  // ---- “Değişiklik iste”: a new phone number is applied here, never sent
  section('edit');
  fresh(); finalScreen();
  S.cv.phone = '0532 111 22 33';
  var nEd = callsOf('edit').length;
  S.ui.editDraft = 'Telefonumu 0532 123 45 67 olarak değiştir';
  $('#btn-edit').click(); settle();
  eq([S.cv.phone, callsOf('edit').length - nEd], ['0532 123 45 67', 0], 'edit: changed on the device, no AI call');
  ok(text('#toast').indexOf('yapay zekâya gönderilmedi') >= 0, 'edit: and the person is told so', text('#toast'));
  S.ui.editDraft = 'Telefonumu 0532 222 33 44 yap ve özeti kısalt'; A.renderFinalTools();
  $('#btn-edit').click(); settle();
  var edc = callsOf('edit').slice(-1)[0];
  eq([S.cv.phone, edc.payload.instruction], ['0532 222 33 44', 'Telefonumu [telefon] yap ve özeti kısalt'], 'edit: the rest of the request still goes to the AI');
  S.ui.editDraft = 'Referansım Ali Veli 0533 777 66 55 olsun'; A.renderFinalTools();
  $('#btn-edit').click(); settle();
  eq(S.cv.phone, '0532 222 33 44', 'edit: a referee’s number never replaces the person’s phone');

  // ---- cover letter revision: the letter goes out scrubbed, details come back filled in
  section('cover');
  fresh(); finalScreen();
  S.ui.letter = A.sanitizeLetter({
    recipient: ['Kuzey Lojistik'], subject: 'Başvuru', greeting: 'Sayın İlgili,', closing: 'Saygılarımla,',
    paragraphs: ['Muhasebe uzmanıyım.', 'Bana 0532 123 45 67 numaralı telefondan ya da ayse.kaya@gmail.com adresinden ulaşabilirsiniz. TC 10000000146.'],
  });
  G.aiResp.cover = function () {
    return { letter: { recipient: ['Kuzey Lojistik'], subject: 'Başvuru', greeting: 'Sayın İlgili,', closing: 'Saygılarımla,',
      paragraphs: ['Muhasebe uzmanıyım.', 'Bana [telefon] numaralı telefondan ulaşabilirsiniz.', 'Kimlik numaram [kimlik no].'] }, reply: 'Telefonunuzu [telefon] olarak ekledim.' };
  };
  A.drafts.coverReq = 'ikinci paragrafı kısalt';
  A.doCoverRevise(); settle();
  var cvc = JSON.stringify(callsOf('cover').slice(-1)[0].payload);
  ok(cvc.indexOf('0532') < 0 && cvc.indexOf('ayse.kaya@gmail.com') < 0 && cvc.indexOf('10000000146') < 0, 'cover: phone, e-mail and TC never leave the device', cvc);
  eq(S.ui.letter.paragraphs, ['Muhasebe uzmanıyım.', 'Bana 0532 123 45 67 numaralı telefondan ulaşabilirsiniz.'], 'cover: placeholders filled; a TC sentence is dropped');
  eq(S.ui.coverReply, 'Telefonunuzu 0532 123 45 67 olarak ekledim.', 'cover: the reply is filled too');
  A.drafts.coverReq = 'son paragrafa telefonumu ekle 0532 999 88 77';
  A.doCoverRevise(); settle();
  eq(callsOf('cover').slice(-1)[0].payload.instruction, 'son paragrafa telefonumu ekle [telefon]', 'cover: the instruction is scrubbed');
  eq(S.ui.letter.paragraphs[1], 'Bana 0532 999 88 77 numaralı telefondan ulaşabilirsiniz.', 'cover: the number from the request goes in');
  eq(A.fillMarks('Ulaşın: [e-posta]. Teşekkürler.', { phone: '', email: '' }), 'Teşekkürler.', 'cover: an unknown detail drops its sentence');

  // ---- tailor: baseHash from before the call; a failed “missing” answer says so
  section('tailor');
  fresh(); finalScreen();
  G.hold = true;
  S.ui.adDraft = 'Kuzey Lojistik muhasebe uzmanı arıyor. Excel ve SAP bilen, beyanname hazırlayabilen adaylar.';
  A.doTailor(); settle();
  S.cv.jobs[0].role = 'Kıdemli Muhasebe Uzmanı';
  var tz = held.shift();
  tz.res({ cv: tz.payload.cv, company: 'Kuzey Lojistik', role: 'Muhasebe', matched: [], missing: [{ term: 'SAP', question: 'SAP kullandınız mı?' }], changes: [] }); settle();
  G.hold = false;
  ok(text('#final-controls').indexOf('CV’niz bu uyarlamadan sonra değişti') >= 0, 'tailor: a change during the call shows the stale notice');
  eq(text('#btn-next').indexOf('Uyarlanmışı indir') >= 0, true, 'tailor: the dock says it downloads the tailored copy');
  G.aiFail.extract = { status: 400, code: 'bad_request', message: 'Geçersiz istek.', retryable: false };
  A.drafts['miss:sap'] = 'SAP’yi iki yıl kullandım';
  A.renderFinalTools();
  btn('Gönder', $('.miss-list')).click(); settle();
  ok(text('.miss-list').indexOf('işlenemedi') >= 0, 'tailor: a failed answer shows “işlenemedi”', text('.miss-list'));
  G.aiFail = {};
  btn('Tekrar dene', $('.miss-list')).click(); settle();
  ok(text('.miss-list').indexOf('işlendi') >= 0, 'tailor: after a retry it is “işlendi”', text('.miss-list'));
  // “Kullanmadım” stops the item's mic and a late “devam” sends nothing
  S.ui.tailored = A.sanitizeTailored({ cv: { name: 'Ayşe Kaya' }, company: 'Kuzey', role: 'Muhasebe', missing: [{ term: 'Logo', question: 'Logo kullandınız mı?' }], matched: [], changes: [] });
  S.ui.open.tailor = true; A.renderFinalTools(); settle();
  $('[data-fkey="mic-miss:logo"]').click(); settle();
  eq(liveCount(), 1, 'tailor: listening for the item');
  btn('Kullanmadım').click(); settle();
  eq(liveCount(), 0, 'tailor: “Kullanmadım” stops its mic');
  var nMiss = callsOf('extract').length;
  say('devam'); settle();
  eq([S.ui.tailored.answered.logo, callsOf('extract').length - nMiss], ['no', 0], 'tailor: nothing is sent after “Kullanmadım”');

  // ---- final-screen “Söyle” follows the real mic state
  section('edit-mic');
  var em = $('[data-fkey="edit-mic"]');
  em.click(); settle();
  eq([liveCount(), em.textContent.trim()], [1, 'Durdur'], 'edit-mic: listening');
  $('#btn-mic').click(); settle();
  em = $('[data-fkey="edit-mic"]');
  eq([liveCount(), em.textContent.trim()], [0, 'Söyle'], 'edit-mic: stopped from the dock, label follows');
  em.click(); settle();
  eq(liveCount(), 1, 'edit-mic: one tap starts it again');
  $('#btn-mic').click(); settle();

  // ---- GitHub READMEs are scrubbed like answers
  section('github');
  fresh(); startInterview('Yazılım ve teknoloji');
  var realReadmes = CVGitHub.withReadmes;
  CVGitHub.withReadmes = function (u, repos) { return Promise.resolve(repos); };
  A.iv.ghUser = 'aliveli';
  A.iv.repos = [{ name: 'depo', description: 'İletişim: ali.veli@gmail.com', readme: 'Bana 0532 123 45 67 numarasından ulaşın.', selected: true, sent: false, topics: [] }];
  A.talkGoto(topicIndex('projects')); settle();
  answer(long('Depo takip sistemi yaptım.'));
  var gh = callsOf('extract').slice(-1)[0].payload.github[0];
  eq([gh.description, gh.readme], ['İletişim: [e-posta]', 'Bana [telefon] numarasından ulaşın.'], 'github: README and description are scrubbed');
  CVGitHub.withReadmes = realReadmes;

  // ---- consent for final-screen tools; privacy copy; K1/K2 notes; settings in the interview
  section('copy');
  fresh();
  A.load(JSON.parse(JSON.stringify(CV1))); A.goStep(99); settle();
  S.ui.adDraft = 'Kuzey Lojistik muhasebe uzmanı arıyor. Excel ve SAP bilen, beyanname hazırlayabilen adaylar.';
  A.doTailor(); settle();
  ok(!$('#sheet-consent').hidden && text('#consent-body').indexOf('CV’nizin metni') >= 0, 'copy: tool consent says the CV text is sent');
  ok(!!btn('Vazgeç', $('#consent-body')), 'copy: and offers “Vazgeç”');
  btn('Vazgeç', $('#consent-body')).click(); settle();
  A.goStep(0); settle();
  ok(text('#step').indexOf('son ekrandaki yapay zekâ araçlarını') >= 0, 'copy: the privacy line names the final-screen tools');
  ok(text('#step').indexOf('Elle doldururken') >= 0, 'copy: the auto-next switch is for manual filling');
  fresh(); startInterview();
  answer(ABOUT);
  ok(text('#step').indexOf('LinkedIn ve GitHub adresleriniz CV’nizle birlikte gönderilir') >= 0, 'copy: K1 says what is sent');
  A.talkGoto(topicIndex('personal')); settle();
  ok(text('#step').indexOf('Sürücü belgesi CV’nizle birlikte gönderilir') >= 0, 'copy: K2 says the licence is sent');
  $('#btn-settings').click(); settle();
  ok(!$('#set-auto') && text('#settings-body').indexOf('susmak cevabı bitirmez') >= 0, 'copy: settings in the interview explain how an answer ends');
  $('[data-close].icon-btn', $('#sheet-settings')).click(); settle();
  var sahaEdu = A.topicsFor('saha').find(function (t) { return t.id === 'education'; });
  eq(sahaEdu.lead, 'En son bitirdiğiniz okul ve varsa belgeleriniz yeterli.', 'copy: the saha education card has its own lead');
  var css = readFile('public/index.html');
  ok(/\.btn\.small \{ min-height: 44px/.test(css) && /\.text-btn \{[^}]*min-height: 44px/.test(css) && /details\.more summary \{[^}]*min-height: 44px/.test(css), 'copy: tap targets are 44 px');

  // ---- the invite code goes along to Chrome
  section('invite');
  CVAI.setCode('DAVET-42');
  ok(A.chromeIntentUrl().indexOf('intent://sesli-cv.example/app/?k=DAVET-42#Intent;') === 0, 'invite: the intent URL carries the code', A.chromeIntentUrl());
  ok(A.chromeIntentUrl().indexOf(encodeURIComponent('#k=DAVET-42')) > 0, 'invite: so does its fallback');
  eq(A.shareUrl(), 'https://sesli-cv.example/app/#k=DAVET-42', 'invite: the copied link carries it');
  CVAI.setCode('');
  eq(A.shareUrl(), 'https://sesli-cv.example/app/', 'invite: no code, plain link');

  // ---- a version 1 backup replaces everything that belonged to the old CV
  section('import');
  fresh(); finalScreen();
  S.ui.tailored = A.sanitizeTailored({ cv: CV1, company: 'Kuzey Lojistik', role: 'Muhasebe', ad: 'x'.repeat(50) });
  S.ui.letter = A.sanitizeLetter({ paragraphs: ['Bir.'], subject: 'Başvuru' });
  A.importJson({ target: { value: 'x', files: [{ _text: JSON.stringify({ app: 'sesli-cv', version: 1, cv: { name: 'Mehmet Yılmaz', jobs: [{ company: 'Gebze Depo' }] }, settings: {} }) }] } });
  settle();
  eq([S.cv.name, S.ui.tailored, S.ui.letter], ['Mehmet Yılmaz', null, null], 'import: v1 drops the old variant and letter');
  eq(A.variantCv().jobs.map(function (j) { return j.company; }), ['Gebze Depo'], 'import: the PDF holds only the new CV');
}

// =================================================================================================
if (SCENARIO === 'android') {
  settle();
  section('android');
  fresh(); startInterview();
  answer(ABOUT);
  eq(topicId(), 'contact', 'android: on K1');
  say('sıfır beş yüz otuz iki'); settle();
  eq(S.cv.phone, '', 'android: half a number is not written');
  ok(liveCount() > 0, 'android: the mic reopens for the rest');
  say('yüz yirmi üç kırk beş altmış yedi'); settle();
  eq(S.cv.phone, '0532 123 45 67', 'android: a number said in two breaths is whole');
  A.talkGoto(topicIndex('photo')); settle();
  ok(text('#step').indexOf('Fotoğraf çek') >= 0 && text('#step').indexOf('Selfie çek') < 0, 'android: the camera button no longer says selfie');
}

// =================================================================================================
if (SCENARIO === 'v1') {
  settle();
  section('v1');
  eq(S.settings.template, 'sade', 'v1: stored template read');
  eq(A.tplId(), 'sade', 'v1: a v1 user who picked Sade keeps it');
  eq(A.sanitizeSettings({ template: 'modern' }).templateChosen, false, 'v1: the old default is not a pick');
  eq(A.sanitizeSettings({ template: 'klasik', templateChosen: false }).templateChosen, false, 'v1: v2 data is read as stored');
  // no speech recognition: the answer box does not ask to say “bitti”
  A.giveConsent();
  A.resetAll(true); settle();
  A.goStep(0); settle();
  S.settings.tts = false;
  $('#btn-start').click(); settle();
  btn('İş deneyimim var').click(); settle();
  ok(text('#step').indexOf('Bitince Sıradaki’ye dokunun.') >= 0 && text('#step').indexOf('“bitti” deyin') < 0, 'v1: typing-only users are not told to say “bitti”', text('.answer-meta'));
}

if (G.__timerErrors) { failed++; print('FAIL timer errors: ' + G.__timerErrors); }
print('app-' + SCENARIO + ': ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) throw new Error(failed + ' app test(s) failed');
