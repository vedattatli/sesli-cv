/*
 * tests/pdf-qa/gen.js — builds real PDFs with pdfmake 0.2.10 inside Apple's jsc shell and prints them
 * as base64, one document per line, for tests/pdf-qa/check.py. Not used by the app.
 *
 * Loaded after: shim.js, pdfmake.js (0.2.10), a Roboto vfs (pdfmake's vfs_fonts.js, or any file that
 * defines ROBO_SUB = { 'Roboto-Regular.ttf': base64, … }), public/fonts.js, public/parse.js,
 * public/pdfdoc.js and, optionally, a file defining QA_PHOTO_34 / QA_PHOTO_SQ (JPEG data URLs).
 * Output lines:  DOC <json manifest>  followed by  PDF <base64>.
 */
(function () {
  'use strict';
  var G = globalThis;
  if (typeof G.ROBO_SUB !== 'undefined') {
    for (var k in G.ROBO_SUB) G.CV_FONT_VFS[k] = G.ROBO_SUB[k];
  }
  CVPdf.registerFonts(pdfMake);
  if (!pdfMake.vfs['Roboto-Regular.ttf'] || !pdfMake.vfs['Roboto-Medium.ttf']) {
    print('ERROR Roboto vfs missing (load pdfmake vfs_fonts.js or a ROBO_SUB file)');
    return;
  }

  var P = CVParse;
  var sampleJson = JSON.parse(read('tests/sample-cv.json'));
  var TEMPLATES = ['klasik', 'sade', 'modern'];
  var docs = [];

  function jobsOf(cv, tpl, lang) {
    return (cv.jobs || []).map(function (j) {
      return { title: j.role, company: j.company, range: P.formatRange(j.start, j.end, lang, { numeric: tpl === 'sade' }) };
    });
  }
  function strip(cv) { var c = JSON.parse(JSON.stringify(cv)); c.photo = c.photo ? '[photo]' : ''; return c; }
  function addCv(id, cv, opts) {
    docs.push({
      id: id,
      meta: { id: id, kind: 'cv', template: opts.template, profile: opts.profile || 'deneyimli', lang: opts.lang || 'tr',
        cv: strip(cv), jobs: jobsOf(cv, opts.template, opts.lang || 'tr'), info: null },
      make: function () { return CVPdf.build(cv, opts); }
    });
  }

  ['deneyimli', 'ogrenci', 'saha', 'yazilim'].forEach(function (profile) {
    var cv = CVPdf.SAMPLES[profile];
    TEMPLATES.forEach(function (tpl) {
      addCv(tpl + '-' + profile, cv, { template: tpl, profile: profile, lang: 'tr' });
    });
  });
  TEMPLATES.forEach(function (tpl) {
    addCv(tpl + '-samplejson', sampleJson, { template: tpl, profile: 'deneyimli', lang: 'tr' });
    addCv(tpl + '-deneyimli-en', CVPdf.SAMPLE, { template: tpl, profile: 'deneyimli', lang: 'en' });
  });
  // Photo variants (3:4 and old square photos), Modern dark sidebar.
  if (typeof G.QA_PHOTO_34 === 'string') {
    ['klasik', 'modern'].forEach(function (tpl) {
      var cv = JSON.parse(JSON.stringify(CVPdf.SAMPLE)); cv.photo = G.QA_PHOTO_34;
      addCv(tpl + '-deneyimli-photo34', cv, { template: tpl, profile: 'deneyimli' });
    });
    var sq = JSON.parse(JSON.stringify(CVPdf.SAMPLES.ogrenci)); sq.photo = G.QA_PHOTO_SQ || G.QA_PHOTO_34;
    addCv('modern-ogrenci-photosq', sq, { template: 'modern', profile: 'ogrenci' });
    addCv('klasik-ogrenci-photosq', sq, { template: 'klasik', profile: 'ogrenci' });
  }
  addCv('modern-yazilim-dark', CVPdf.SAMPLES.yazilim, { template: 'modern', profile: 'yazilim', sidebar: 'dark', accent: CVPdf.ACCENTS[1] });

  // Stress: very long unbreakable words, long contact values, many items (only overflow and page checks apply).
  var LW = 'Gerçekzamanlıenvantervesiparişeşleştirmemotoruikincisürümdenemesiçokuzunad';
  var stress = JSON.parse(JSON.stringify(CVPdf.SAMPLE));
  stress.title = LW;
  stress.email = 'cok.uzun.' + LW.toLowerCase().replace(/[^a-z]/g, '') + '@example.com';
  stress.github = 'github.com/' + new Array(8).join('cokuzunkullaniciadi');
  stress.projects[0].name = LW;
  stress.projects[0].link = 'github.com/ali/' + new Array(9).join('envantermotoru');
  stress.skills = 'Diller: ' + LW + ', Go\nAraçlar: ' + new Array(30).join('Araç, ') + 'Son';
  stress.langs = 'Brezilyaportekizcesiveyerelağızları ileri (C1) · TOEFL iBT 110 (2024), Türkçe ana dil';
  if (typeof G.QA_PHOTO_34 === 'string') stress.photo = G.QA_PHOTO_34;
  TEMPLATES.forEach(function (tpl) {
    docs.push({
      id: tpl + '-stress',
      meta: { id: tpl + '-stress', kind: 'stress', template: tpl, profile: 'deneyimli', lang: 'tr', cv: strip(stress), jobs: [] },
      make: function () { return CVPdf.build(stress, { template: tpl }); }
    });
  });

  // Cover letters: one per template header, plus an over-long one that must still fit one page.
  TEMPLATES.forEach(function (tpl) {
    docs.push({
      id: 'letter-' + tpl,
      meta: { id: 'letter-' + tpl, kind: 'letter', template: tpl, profile: 'deneyimli', lang: 'tr', cv: strip(CVPdf.SAMPLE), jobs: [], letter: CVPdf.LETTER_SAMPLE },
      make: function () { return CVPdf.buildLetter(CVPdf.LETTER_SAMPLE, CVPdf.SAMPLE, { template: tpl }); }
    });
  });
  var longLetter = JSON.parse(JSON.stringify(CVPdf.LETTER_SAMPLE));
  longLetter.paragraphs = longLetter.paragraphs.concat(longLetter.paragraphs.slice(1, 3));
  docs.push({
    id: 'letter-long-klasik',
    meta: { id: 'letter-long-klasik', kind: 'letter', template: 'klasik', profile: 'deneyimli', lang: 'tr', cv: strip(CVPdf.SAMPLE), jobs: [], letter: longLetter },
    make: function () { return CVPdf.buildLetter(longLetter, CVPdf.SAMPLE, { template: 'klasik' }); }
  });

  var i = 0;
  function next() {
    if (i >= docs.length) { print('END ' + docs.length); return; }
    var d = docs[i++];
    var dd;
    try { dd = d.make(); } catch (e) { print('ERROR ' + d.id + ' build: ' + e); next(); return; }
    d.meta.info = dd.info;
    if (d.meta.kind === 'letter') d.meta.letterFit = CVPdf.letterLayout(d.id === 'letter-long-klasik' ? longLetter : CVPdf.LETTER_SAMPLE, CVPdf.SAMPLE, { template: d.meta.template });
    print('DOC ' + JSON.stringify(d.meta));
    try {
      pdfMake.createPdf(dd).getBase64(function (b64) { print('PDF ' + b64); next(); });
    } catch (e) { print('ERROR ' + d.id + ' pdf: ' + e); next(); }
  }
  next();
})();
