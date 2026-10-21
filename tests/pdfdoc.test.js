/*
 * pdfdoc.js testleri. jsc ile çalışır (bkz. tests/run-pdfdoc.sh):
 *   jsc parse.js pdfdoc.js tests/pdfdoc.test.js
 * Son satır: "pdfdoc: N passed, M failed". Başarısızlık varsa istisna fırlatır (jsc çıkış kodu ≠ 0).
 */
(function () {
  'use strict';

  var G = globalThis;
  if (!G.console) G.console = { log: print, error: print };

  var passed = 0, failed = 0, shown = 0;
  function ok(cond, msg) {
    if (cond) { passed++; return true; }
    failed++;
    if (shown++ < 80) print('  FAIL: ' + msg);
    return false;
  }
  function eq(a, b, msg) {
    return ok(a === b, msg + ' — beklenen ' + JSON.stringify(b) + ', gelen ' + JSON.stringify(a));
  }
  function same(a, b, msg) {
    return ok(JSON.stringify(a) === JSON.stringify(b), msg + ' — beklenen ' + JSON.stringify(b) + ', gelen ' + JSON.stringify(a));
  }
  function attempt(fn, msg) {
    var value;
    try { value = fn(); } catch (e) {
      ok(false, msg + ' — istisna: ' + e + (e && e.stack ? '\n' + e.stack : ''));
      return { ok: false, value: null };
    }
    ok(true, msg);
    return { ok: true, value: value };
  }

  var CVPdf = G.CVPdf, CVParse = G.CVParse;
  if (!CVPdf) { print('pdfdoc: 0 passed, 1 failed'); throw new Error('CVPdf yüklenmemiş'); }
  if (!CVParse) { print('pdfdoc: 0 passed, 1 failed'); throw new Error('CVParse (parse.js) yüklenmemiş'); }

  var A4 = { width: 595.28, height: 841.89 };
  var INK = '#1d232a', MUTED = '#5b6670';
  var TEMPLATE_IDS = ['modern', 'klasik', 'sade'];
  var MARGINS = { modern: [0, 34, 0, 34], klasik: [50, 46, 50, 50], sade: [56, 50, 56, 50] };
  var ALLOWED_FN_KEYS = { background: true, footer: true, pageBreakBefore: true, header: true };
  // 1x1 piksellik gerçek PNG ve JPEG (yalnızca data URL biçimi önemli).
  var PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  var JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z';

  function trUpper(s) { return String(s).replace(/i/g, 'İ').replace(/ı/g, 'I').toUpperCase(); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function fnReplacer(k, v) { return typeof v === 'function' ? '[function]' : v; }

  /* ---------------------------------------------------------- ağaç yardımcıları */

  // Her düğümü (nesne/dizi/yaprak) ata zinciriyle ziyaret eder.
  function walk(x, visit, path, ancestors) {
    path = path || '$';
    ancestors = ancestors || [];
    visit(x, path, ancestors);
    if (x && typeof x === 'object') {
      var next = ancestors.concat([x]);
      if (Array.isArray(x)) {
        for (var i = 0; i < x.length; i++) walk(x[i], visit, path + '[' + i + ']', next);
      } else {
        for (var k in x) walk(x[k], visit, path + '.' + k, next);
      }
    }
  }

  // Bir düğümün altındaki tüm görünen metin parçaları.
  function textsOf(x) {
    var out = [];
    walk(x, function (v, path) {
      if (typeof v === 'string' && /\.text$/.test(path)) out.push(v);
    });
    return out;
  }
  // Satır içi dizileri tek metne birleştirerek "görünen satırlar".
  function nodeText(n) {
    if (typeof n === 'string') return n;
    if (!n || typeof n !== 'object') return '';
    if (Array.isArray(n)) return n.map(nodeText).join('');
    if (n.text !== undefined) return nodeText(n.text);
    return '';
  }
  function allLines(dd) {
    var out = [];
    walk(dd.content, function (v) {
      if (v && typeof v === 'object' && !Array.isArray(v) && v.text !== undefined) out.push(nodeText(v));
    });
    return out;
  }
  function findNodes(x, pred) {
    var out = [];
    walk(x, function (v, path, anc) { if (v && typeof v === 'object' && !Array.isArray(v) && pred(v, path, anc)) out.push({ node: v, path: path, anc: anc }); });
    return out;
  }
  function nearestUnbreakable(anc) {
    for (var i = anc.length - 1; i >= 0; i--) if (anc[i] && anc[i].unbreakable === true) return anc[i];
    return null;
  }

  /* --------------------------------------------------------- yapısal doğrulama */

  // docDefinition (veya background/footer dönüşü) için genel geçerlilik denetimi.
  function validateTree(tree, label, topLevel) {
    var problems = [];
    walk(tree, function (v, path, anc) {
      if (v === undefined) problems.push('undefined @ ' + path);
      else if (typeof v === 'number' && !isFinite(v)) problems.push('NaN/Infinity @ ' + path);
      else if (typeof v === 'function') {
        var key = path.replace(/^\$\./, '');
        if (!(topLevel && ALLOWED_FN_KEYS[key])) problems.push('beklenmeyen fonksiyon @ ' + path);
      } else if (typeof v === 'string' && /(^|\W)(undefined|NaN)(\W|$)/.test(v) && /\.(text|link|image|title|author)$/.test(path)) {
        problems.push('"undefined"/"NaN" metni @ ' + path + ': ' + v);
      }
      if (/\.font$/.test(path) && v !== 'Roboto' && v !== 'DMSerif') problems.push('izin verilmeyen font ' + v + ' @ ' + path);
      if (/\.image$/.test(path) && !(typeof v === 'string' && /^data:image\/(png|jpe?g);base64,/.test(v))) problems.push('data URL olmayan image @ ' + path);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (v.canvas !== undefined) {
          if (!Array.isArray(v.canvas)) problems.push('canvas dizi değil @ ' + path);
          else v.canvas.forEach(function (c, i) {
            if (['rect', 'line', 'ellipse', 'polyline'].indexOf(c.type) < 0) problems.push('bilinmeyen vektör @ ' + path + '[' + i + ']');
          });
        }
        if (v.columns !== undefined) {
          if (!Array.isArray(v.columns) || !v.columns.length) problems.push('boş columns @ ' + path);
          else v.columns.forEach(function (c, i) {
            if (c.width !== undefined && !(typeof c.width === 'number' || c.width === '*' || c.width === 'auto')) problems.push('geçersiz sütun genişliği @ ' + path + '[' + i + ']');
          });
        }
        if (v.ul !== undefined && (!Array.isArray(v.ul) || !v.ul.length)) problems.push('boş ul @ ' + path);
        if (v.stack !== undefined && (!Array.isArray(v.stack) || !v.stack.length)) problems.push('boş stack @ ' + path);
        if (v.margin !== undefined && !(Array.isArray(v.margin) && v.margin.length === 4 || typeof v.margin === 'number')) problems.push('geçersiz margin @ ' + path);
        if (v.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(v.color)) problems.push('geçersiz renk ' + v.color + ' @ ' + path);
        if (v.lineColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(v.lineColor)) problems.push('geçersiz çizgi rengi @ ' + path);
        if (v.markerColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(v.markerColor)) problems.push('geçersiz işaret rengi @ ' + path);
        // pdfmake'in tanıdığı bir içerik türü olmalı (stil/ayar nesneleri hariç)
        var isContentArray = anc.length && Array.isArray(anc[anc.length - 1]) && /(\.content|\.stack|\.columns|\.ul)\[\d+\]$/.test(path);
        if (isContentArray && v.text === undefined && !v.stack && !v.columns && !v.ul && !v.ol && !v.canvas && !v.image && !v.table) {
          problems.push('tanınmayan içerik düğümü @ ' + path);
        }
      }
    });
    ok(problems.length === 0, label + ': ağaç geçerli' + (problems.length ? ' — ' + problems.slice(0, 5).join(' | ') : ''));
    return problems.length === 0;
  }

  function jsonOk(dd, label) {
    var r = attempt(function () { return JSON.stringify(dd, fnReplacer); }, label + ': JSON.stringify');
    if (r.ok) ok(typeof r.value === 'string' && r.value.length > 50, label + ': JSON çıktısı dolu');
    if (r.ok) attempt(function () { return JSON.parse(r.value); }, label + ': JSON geri okunur');
    return r.value || '';
  }

  /* ----------------------------------------------------------------- test verisi */

  var SAMPLE = CVPdf.SAMPLE;
  var EMPTY = {
    name: '', title: '', phone: '', email: '', city: '', web: '', photo: '', summary: '',
    jobs: [], edu: [], skills: '', langs: '', certs: '', hobbies: '', refs: '',
    birth: '', military: '', license: '', marital: ''
  };
  var EMPTY_ENTRIES = clone(EMPTY);
  EMPTY_ENTRIES.jobs = [{ id: 'a', role: '', company: ' ', city: '', start: '', end: '', desc: '\n  \n' }];
  EMPTY_ENTRIES.edu = [{ id: 'b', school: '', program: '', degree: '', start: '', end: '', note: '' }];
  EMPTY_ENTRIES.name = '   ';
  var NAME_ONLY = clone(EMPTY);
  NAME_ONLY.name = 'Ayşe Yılmaz';

  function stressCv() {
    var cv = clone(SAMPLE);
    cv.name = 'Gülşen Çağlayan-Öztürkoğlu';
    cv.title = 'Uluslararası Tedarik Zinciri ve Satın Alma Operasyonları Kıdemli Müdürü';
    cv.photo = JPG;
    cv.email = 'gulsen.caglayan.ozturkoglu.uzun.adres@ornek-kurumsal-alan-adi.com.tr';
    cv.web = 'linkedin.com/in/gulsen-caglayan-ozturkoglu-cok-uzun-profil-adresi-1234567890';
    cv.summary = new Array(12).join('Çok uzun özet cümlesi ile sayfa akışını zorlayan bir paragraf yazıyorum. ') +
      '\nİkinci paragraf: Süperkalifragilistikekspiyalidosyusvebenzeriuzunkelimelerdahayokmuacaba.';
    cv.jobs = [];
    for (var i = 0; i < 8; i++) {
      var lines = [];
      for (var b = 0; b < 7; b++) {
        lines.push('Madde ' + (i + 1) + '.' + (b + 1) + ': Şirketlerarasıkoordinasyonsağlamaçalışmaları kapsamında ' +
          'ölçülebilir hedefler doğrultusunda çapraz ekiplerle süreç iyileştirmesi yaptım; ğüşıöç ĞÜŞİÖÇ.');
      }
      cv.jobs.push({
        id: 'j' + i, role: 'Pozisyon ' + (i + 1) + ' — Kıdemli Uzman', company: 'Şirket ' + (i + 1) + ' Danışmanlık ve Ticaret A.Ş.',
        city: i % 2 ? 'İzmir' : 'Eskişehir', start: 'Ocak ' + (2000 + i), end: i === 0 ? 'Devam ediyor' : 'Aralık ' + (2001 + i),
        desc: lines.join('\n')
      });
    }
    var skills = [];
    for (var k = 0; k < 30; k++) skills.push('Yetenek' + (k + 1) + ' çokuzunbirkelimeolarakyazılmışyetenekadı');
    cv.skills = skills.join(', ');
    cv.langs = 'Türkçe ana dil, İngilizce ileri, Almanca orta, Fransızca başlangıç, İspanyolca iyi, Japonca';
    var certs = [];
    for (var c = 0; c < 8; c++) certs.push('Uzun bir sertifika adı ve veren kurum bilgisi ' + (c + 1) + ' (' + (2010 + c) + ')');
    cv.certs = certs.join('\n');
    cv.refs = 'Ad Soyad — Ünvan, Şirket · 0532 000 00 00\nReferanslar talep edildiğinde sunulacaktır.';
    cv.marital = 'Evli';
    return cv;
  }
  var STRESS = stressCv();

  var CVS = { SAMPLE: SAMPLE, EMPTY: EMPTY, EMPTY_ENTRIES: EMPTY_ENTRIES, NAME_ONLY: NAME_ONLY, STRESS: STRESS };

  function headingsFor(tpl, lang) {
    var L = CVPdf.labels(lang);
    var keys = ['profile', 'experience', 'education', 'skills', 'languages', 'certs', 'hobbies', 'refs', 'personal'];
    if (tpl === 'modern') keys.push('contact');
    return keys.map(function (k) { return lang === 'en' ? L[k].toUpperCase() : trUpper(L[k]); });
  }
  function allHeadings(lang) {
    var L = CVPdf.labels(lang);
    return ['contact', 'profile', 'experience', 'education', 'skills', 'languages', 'certs', 'hobbies', 'refs', 'personal']
      .map(function (k) { return lang === 'en' ? L[k].toUpperCase() : trUpper(L[k]); });
  }

  /* ================================================================ API yüzeyi */

  print('# API');
  same(CVPdf.TEMPLATES, [
    { id: 'modern', tr: 'Modern', en: 'Modern', photo: true },
    { id: 'klasik', tr: 'Klasik', en: 'Classic', photo: true },
    { id: 'sade', tr: 'Sade (ATS)', en: 'Plain (ATS)', photo: false }
  ], 'TEMPLATES');
  same(CVPdf.ACCENTS, ['#1F5C4A', '#23395B', '#7A2E3A', '#36404A', '#7A5212'], 'ACCENTS');
  ['labels', 'hasContent', 'registerFonts', 'build', 'fileName', 'mix'].forEach(function (f) {
    eq(typeof CVPdf[f], 'function', 'CVPdf.' + f + ' fonksiyon');
  });

  /* mix */
  eq(CVPdf.mix('#000000', '#ffffff', 0), '#000000', 'mix t=0');
  eq(CVPdf.mix('#000000', '#ffffff', 1), '#ffffff', 'mix t=1');
  eq(CVPdf.mix('#000000', '#ffffff', 0.5), '#808080', 'mix t=0.5');
  eq(CVPdf.mix('#000000', '#ffffff', 0.25), '#404040', 'mix t=0.25');
  eq(CVPdf.mix('#1F5C4A', '#1F5C4A', 0.4), '#1f5c4a', 'mix aynı renk');
  eq(CVPdf.mix('#fff', '#000', 0.5), '#808080', 'mix 3 haneli hex');
  eq(CVPdf.mix('#ff0000', '#0000ff', 2), '#0000ff', 'mix t>1 kırpılır');
  eq(CVPdf.mix('#ff0000', '#0000ff', -1), '#ff0000', 'mix t<0 kırpılır');
  eq(CVPdf.mix('#ff0000', '#0000ff', NaN), '#ff0000', 'mix NaN → 0');
  eq(CVPdf.mix('kırmızı', '#0000ff', 0.5), '#0000ff', 'mix geçersiz a');
  ok(/^#[0-9a-f]{6}$/.test(CVPdf.mix('x', 'y', 0.5)), 'mix ikisi de geçersiz → geçerli hex');

  /* labels */
  same(CVPdf.labels('tr'), (function () {
    var o = {
      contact: 'İletişim', profile: 'Profil', experience: 'İş Deneyimi', education: 'Eğitim', skills: 'Yetenekler',
      languages: 'Diller', certs: 'Sertifikalar ve Kurslar', hobbies: 'Hobiler', refs: 'Referanslar',
      personal: 'Kişisel Bilgiler', birth: 'Doğum Tarihi', military: 'Askerlik Durumu', license: 'Sürücü Belgesi',
      marital: 'Medeni Durum', phone: 'Telefon', email: 'E-posta', city: 'Konum', web: 'Web'
    };
    o.summary = o.profile; o.jobs = o.experience; o.edu = o.education; o.langs = o.languages; o.location = o.city;
    return o;
  })(), 'labels(tr)');
  same(CVPdf.labels('en'), (function () {
    var o = {
      contact: 'Contact', profile: 'Profile', experience: 'Experience', education: 'Education', skills: 'Skills',
      languages: 'Languages', certs: 'Certifications', hobbies: 'Interests', refs: 'References',
      personal: 'Personal Details', birth: 'Date of Birth', military: 'Military Service', license: 'Driving Licence',
      marital: 'Marital Status', phone: 'Phone', email: 'Email', city: 'Location', web: 'Web'
    };
    o.summary = o.profile; o.jobs = o.experience; o.edu = o.education; o.langs = o.languages; o.location = o.city;
    return o;
  })(), 'labels(en)');
  same(CVPdf.labels('de'), CVPdf.labels('tr'), 'labels bilinmeyen dil → tr');
  same(CVPdf.labels(), CVPdf.labels('tr'), 'labels() → tr');
  var lb = CVPdf.labels('tr'); lb.profile = 'X';
  eq(CVPdf.labels('tr').profile, 'Profil', 'labels her çağrıda yeni nesne');

  /* SAMPLE */
  print('# SAMPLE');
  ['name', 'title', 'phone', 'email', 'city', 'web', 'summary', 'skills', 'langs', 'certs', 'hobbies', 'refs', 'birth', 'military', 'license']
    .forEach(function (f) { ok(typeof SAMPLE[f] === 'string' && SAMPLE[f].trim() !== '', 'SAMPLE.' + f + ' dolu'); });
  eq(SAMPLE.photo, '', 'SAMPLE.photo boş');
  ['marital'].forEach(function (f) { eq(typeof SAMPLE[f], 'string', 'SAMPLE.' + f + ' string'); });
  eq(SAMPLE.jobs.length, 3, 'SAMPLE 3 iş');
  SAMPLE.jobs.forEach(function (j, i) {
    ['id', 'role', 'company', 'city', 'start', 'end', 'desc'].forEach(function (f) { ok(typeof j[f] === 'string' && j[f] !== '', 'SAMPLE.jobs[' + i + '].' + f); });
    var n = CVParse.splitLines(j.desc).length;
    ok(n >= 3 && n <= 4, 'SAMPLE.jobs[' + i + '] 3–4 madde (' + n + ')');
  });
  eq(SAMPLE.edu.length, 2, 'SAMPLE 2 eğitim');
  SAMPLE.edu.forEach(function (e, i) {
    ['id', 'school', 'program', 'degree', 'start', 'end'].forEach(function (f) { ok(typeof e[f] === 'string' && e[f] !== '', 'SAMPLE.edu[' + i + '].' + f); });
    eq(typeof e.note, 'string', 'SAMPLE.edu[' + i + '].note string');
  });
  ok(CVParse.splitList(SAMPLE.skills).length >= 6, 'SAMPLE yetenek sayısı');
  ok(CVParse.parseLanguages(SAMPLE.langs).every(function (l) { return l.level > 0 && l.name; }), 'SAMPLE dilleri seviyeli');
  ok(/[çğıöşüİ]/.test(SAMPLE.summary), 'SAMPLE Türkçe karakterli');
  ok(/@example\.com$/.test(SAMPLE.email), 'SAMPLE e-postası ayrılmış alan adında');
  ok(SAMPLE.web.indexOf('http') !== 0, 'SAMPLE web protokolsüz');
  ok(CVPdf.hasContent(SAMPLE), 'hasContent(SAMPLE)');

  /* hasContent */
  print('# hasContent');
  eq(CVPdf.hasContent(EMPTY), false, 'boş cv');
  eq(CVPdf.hasContent(EMPTY_ENTRIES), false, 'yalnızca boş girdiler/boşluk');
  eq(CVPdf.hasContent(null), false, 'null');
  eq(CVPdf.hasContent(undefined), false, 'undefined');
  eq(CVPdf.hasContent({}), false, '{}');
  eq(CVPdf.hasContent('Ayşe'), false, 'string cv');
  eq(CVPdf.hasContent({ jobs: [{ id: 'x' }], edu: [{ id: 'y' }] }), false, 'yalnızca id');
  eq(CVPdf.hasContent({ jobs: [null, 3, 'x'] }), false, 'çöp girdiler');
  eq(CVPdf.hasContent({ summary: ' \n\t ' }), false, 'boşluklu özet');
  eq(CVPdf.hasContent({ name: 'Ali' }), true, 'isim');
  eq(CVPdf.hasContent({ jobs: [{ id: 'x', company: 'Deniz A.Ş.' }] }), true, 'yalnızca şirket');
  eq(CVPdf.hasContent({ edu: [{ id: 'x', note: 'GNO 3,1' }] }), true, 'yalnızca eğitim notu');
  eq(CVPdf.hasContent({ marital: 'Bekar' }), true, 'kişisel bilgi');
  eq(CVPdf.hasContent({ photo: JPG }), true, 'yalnızca fotoğraf');
  eq(CVPdf.hasContent({ phone: 5321234567 }), true, 'sayı değer');

  /* fileName */
  eq(CVPdf.fileName(SAMPLE), 'Emre_Aksoy_CV.pdf', 'fileName(SAMPLE)');
  eq(CVPdf.fileName({ name: 'Ayşe Yılmaz' }), 'Ayse_Yilmaz_CV.pdf', 'fileName Türkçe');
  eq(CVPdf.fileName({ name: '' }), 'CV.pdf', 'fileName boş');
  eq(CVPdf.fileName(null), 'CV.pdf', 'fileName null');

  /* registerFonts */
  print('# registerFonts');
  (function () {
    var saved = G.CV_FONT_VFS, hadOwn = Object.prototype.hasOwnProperty.call(G, 'CV_FONT_VFS');
    var ROBOTO = { normal: 'Roboto-Regular.ttf', bold: 'Roboto-Medium.ttf', italics: 'Roboto-Italic.ttf', bolditalics: 'Roboto-MediumItalic.ttf' };
    try {
      G.CV_FONT_VFS = { 'DMSerifDisplay-Regular.ttf': 'UkVH', 'DMSerifDisplay-Italic.ttf': 'SVRB' };
      var pm = { vfs: { 'Roboto-Regular.ttf': 'Uk9C' }, fonts: { Eski: {} } };
      var r = CVPdf.registerFonts(pm);
      eq(r, pm, 'registerFonts aynı nesneyi döner');
      eq(pm.vfs['Roboto-Regular.ttf'], 'Uk9C', 'mevcut vfs korunur');
      eq(pm.vfs['DMSerifDisplay-Regular.ttf'], 'UkVH', 'DM Serif regular eklendi');
      eq(pm.vfs['DMSerifDisplay-Italic.ttf'], 'SVRB', 'DM Serif italik eklendi');
      same(pm.fonts, {
        Roboto: ROBOTO,
        DMSerif: { normal: 'DMSerifDisplay-Regular.ttf', bold: 'DMSerifDisplay-Regular.ttf', italics: 'DMSerifDisplay-Italic.ttf', bolditalics: 'DMSerifDisplay-Italic.ttf' }
      }, 'fonts tanımı (CV_FONT_VFS var)');
      var before = JSON.stringify(pm);
      CVPdf.registerFonts(pm);
      eq(JSON.stringify(pm), before, 'registerFonts idempotent');

      var pm2 = {};
      CVPdf.registerFonts(pm2);
      eq(pm2.vfs['DMSerifDisplay-Regular.ttf'], 'UkVH', 'vfs yoksa oluşturulur');

      delete G.CV_FONT_VFS;
      var pm3 = { vfs: { 'Roboto-Regular.ttf': 'Uk9C' } };
      CVPdf.registerFonts(pm3);
      same(pm3.fonts, { Roboto: ROBOTO, DMSerif: ROBOTO }, 'CV_FONT_VFS yoksa DMSerif → Roboto dosyaları');
      same(Object.keys(pm3.vfs), ['Roboto-Regular.ttf'], 'CV_FONT_VFS yoksa vfs değişmez');

      G.CV_FONT_VFS = { 'DMSerifDisplay-Regular.ttf': 'UkVH' };
      var pm4 = {};
      CVPdf.registerFonts(pm4);
      eq(pm4.fonts.DMSerif.italics, 'DMSerifDisplay-Regular.ttf', 'italik dosyası yoksa regular kullanılır');

      attempt(function () { CVPdf.registerFonts(null); CVPdf.registerFonts(undefined); }, 'registerFonts(null) atmaz');
    } finally {
      if (hadOwn) G.CV_FONT_VFS = saved; else delete G.CV_FONT_VFS;
    }
  })();

  /* ============================================================ build matrisi */

  print('# build matrisi');
  var built = {}; // anahtar → dd
  var builds = 0;
  Object.keys(CVS).forEach(function (cvName) {
    TEMPLATE_IDS.forEach(function (tpl) {
      ['tr', 'en'].forEach(function (lang) {
        [true, false].forEach(function (showPhoto) {
          var key = cvName + '/' + tpl + '/' + lang + '/' + (showPhoto ? 'foto' : 'fotosuz');
          var cv = CVS[cvName];
          var snapshot = JSON.stringify(cv);
          var accent = CVPdf.ACCENTS[builds % CVPdf.ACCENTS.length];
          var r = attempt(function () {
            return CVPdf.build(cv, { template: tpl, accent: accent, lang: lang, showPhoto: showPhoto, photoRound: showPhoto ? PNG : '' });
          }, key + ': build atmaz');
          builds++;
          if (!r.ok) return;
          var dd = r.value;
          built[key] = dd;
          eq(JSON.stringify(cv), snapshot, key + ': girdi cv değişmedi');
          validateTree(dd, key, true);
          var json = jsonOk(dd, key);

          eq(dd.pageSize, 'A4', key + ': A4');
          eq(dd.pageOrientation, 'portrait', key + ': dikey');
          same(dd.pageMargins, MARGINS[tpl], key + ': sayfa kenar boşlukları');
          same(dd.defaultStyle, { font: 'Roboto', fontSize: 9.5, lineHeight: 1.28, color: INK }, key + ': defaultStyle');
          var nm = typeof cv.name === 'string' ? cv.name.trim() : '';
          same(dd.info, { title: nm ? nm + ' — CV' : 'CV', author: nm, subject: 'CV', creator: 'Sesli CV' }, key + ': info');
          ok(Array.isArray(dd.content) && dd.content.length > 0, key + ': content dizi');

          // background
          if (tpl === 'modern') {
            eq(typeof dd.background, 'function', key + ': background fonksiyon');
            [1, 2].forEach(function (page) {
              var bg = attempt(function () { return dd.background(page, { width: A4.width, height: A4.height }); }, key + ': background(' + page + ') atmaz').value;
              if (!bg) return;
              validateTree(bg, key + ': background(' + page + ')', false);
              same(bg, { canvas: [{ type: 'rect', x: 0, y: 0, w: 188, h: A4.height, color: accent }] }, key + ': kenar çubuğu dikdörtgeni (sayfa ' + page + ')');
            });
            var bg0 = dd.background(1, undefined);
            eq(bg0 && bg0.canvas[0].h, A4.height, key + ': background pageSize yoksa A4 yüksekliği');
          } else {
            ok(dd.background === undefined || typeof dd.background === 'function', key + ': background yok ya da fonksiyon');
            if (typeof dd.background === 'function') {
              var b2 = dd.background(1, { width: A4.width, height: A4.height });
              if (b2) validateTree(b2, key + ': background', false);
            }
          }

          // footer
          eq(typeof dd.footer, 'function', key + ': footer fonksiyon');
          var ft = attempt(function () { return dd.footer(2, 3); }, key + ': footer(2,3) atmaz').value;
          if (ft) {
            validateTree(ft, key + ': footer', false);
            eq(ft.text, (nm ? nm + ' · ' : '') + '2/3', key + ': footer metni');
            eq(ft.fontSize, 7.5, key + ': footer 7.5pt');
            eq(ft.color, MUTED, key + ': footer MUTED');
            eq(ft.alignment, 'right', key + ': footer sağa yaslı');
            ok(Array.isArray(ft.margin) && ft.margin[0] >= (tpl === 'modern' ? 188 : MARGINS[tpl][0]), key + ': footer sol boşluğu kenar çubuğunu/kenarı korur');
            eq(ft.margin[2], tpl === 'modern' ? 34 : MARGINS[tpl][2], key + ': footer sağ kenar hizası');
          } else ok(false, key + ': footer(2,3) düğüm döndürmeli');
          eq(dd.footer(1, 1), null, key + ': tek sayfada footer yok');

          // görseller
          var images = findNodes(dd.content, function (n) { return n.image !== undefined; });
          var expectImage = showPhoto && tpl !== 'sade' && typeof cv.photo === 'string' && cv.photo.indexOf('data:image/') === 0;
          eq(images.length, expectImage ? 1 : 0, key + ': fotoğraf sayısı');
          if (expectImage && images.length) {
            var img = images[0].node;
            if (tpl === 'modern') {
              eq(img.image, PNG, key + ': modern yuvarlak (photoRound) fotoğrafı kullanır');
              same(img.fit, [112, 112], key + ': modern foto 112pt');
              eq(img.alignment, 'center', key + ': modern foto ortalı');
            } else {
              eq(img.image, cv.photo, key + ': klasik kare fotoğrafı kullanır');
              same(img.fit, [76, 76], key + ': klasik foto 76×76');
            }
          }

          // fontlar
          var fonts = {};
          walk(dd, function (v, p) { if (/\.font$/.test(p)) fonts[v] = true; });
          if (tpl === 'sade') ok(!fonts.DMSerif, key + ': sade DMSerif kullanmaz');
          if (tpl !== 'sade' && nm) ok(fonts.DMSerif, key + ': isim DMSerif ile');

          // boş bölümler yok
          var lines = allLines(dd);
          if (cvName === 'EMPTY' || cvName === 'EMPTY_ENTRIES' || cvName === 'NAME_ONLY') {
            var hs = allHeadings(lang).concat(allHeadings(lang === 'en' ? 'tr' : 'en'));
            ok(!hs.some(function (h) { return lines.indexOf(h) >= 0; }), key + ': boş bölüm başlığı yok');
            ok(json.indexOf('mailto:') < 0 && json.indexOf('https://') < 0, key + ': boş iletişim bağlantısı yok');
            ok(findNodes(dd.content, function (n) { return n.ul !== undefined; }).length === 0, key + ': madde listesi yok');
            var nonEmpty = lines.filter(function (l) { return l.trim() !== ''; });
            if (cvName === 'NAME_ONLY') same(nonEmpty, ['Ayşe Yılmaz'], key + ': yalnızca isim görünür');
            else same(nonEmpty, [], key + ': hiç metin yok');
          }

          // Türkçe karakterler
          if (cvName === 'SAMPLE' || cvName === 'STRESS') {
            ok(lines.indexOf(cv.name) >= 0, key + ': isim aynen');
            ok(/[ğüşıöçĞÜŞİÖÇ]/.test(json), key + ': Türkçe karakterler korunur');
            headingsFor(tpl, lang).forEach(function (h) {
              ok(lines.indexOf(h) >= 0, key + ': "' + h + '" bölümü var');
            });
            if (tpl !== 'modern') ok(lines.indexOf(lang === 'en' ? 'CONTACT' : 'İLETİŞİM') < 0, key + ': iletişim başlıkta, bölüm değil');
          }
        });
      });
    });
  });
  ok(builds === Object.keys(CVS).length * 12, 'tüm kombinasyonlar denendi (' + builds + ')');

  /* ======================================================= içerik ayrıntıları */

  print('# içerik');
  function get(key) { return built[key] || CVPdf.build(SAMPLE, {}); }

  // Başlık yetim kalmaz: her bölüm başlığının en yakın bölünmez atası başka metin de içerir.
  TEMPLATE_IDS.forEach(function (tpl) {
    ['tr', 'en'].forEach(function (lang) {
      ['SAMPLE', 'STRESS'].forEach(function (cvName) {
        var key = cvName + '/' + tpl + '/' + lang + '/foto';
        var dd = get(key);
        headingsFor(tpl, lang).forEach(function (h) {
          var hits = findNodes(dd.content, function (n) { return n.text === h; });
          eq(hits.length, 1, key + ': "' + h + '" bir kez');
          if (!hits.length) return;
          var u = nearestUnbreakable(hits[0].anc);
          ok(u && textsOf(u).filter(function (t) { return t !== h && t.trim() !== ''; }).length > 0,
            key + ': "' + h + '" ilk maddesiyle birlikte bölünmez');
        });
      });
    });
  });

  // İş maddeleri: başlık satırları + ilk madde birlikte, kalanlar serbest.
  TEMPLATE_IDS.forEach(function (tpl) {
    var key = 'SAMPLE/' + tpl + '/tr/foto';
    var dd = get(key);
    SAMPLE.jobs.forEach(function (j, idx) {
      var bullets = CVParse.splitLines(j.desc);
      var roleHits = findNodes(dd.content, function (n) { return n.text === j.role && n.bold === true; });
      ok(roleHits.length >= 1, key + ': ' + j.role + ' kalın başlık');
      var good = roleHits.some(function (r) {
        var u = nearestUnbreakable(r.anc);
        if (!u) return false;
        var t = textsOf(u);
        return t.indexOf(bullets[0]) >= 0 && t.indexOf(bullets[1]) < 0;
      });
      ok(good, key + ': ' + j.company + ' — başlık + ilk madde bölünmez, ikinci madde dışarıda');
      ok(textsOf(dd.content).indexOf(bullets[bullets.length - 1]) >= 0, key + ': son madde de var');
      var lines = allLines(dd);
      var range = CVParse.formatRange(j.start, j.end, 'tr');
      ok(lines.some(function (l) { return l.indexOf(range) >= 0; }), key + ': tarih aralığı "' + range + '"');
    });
  });

  // Tarih biçimi (dil)
  (function () {
    var tr = allLines(get('SAMPLE/modern/tr/foto')), en = allLines(get('SAMPLE/modern/en/foto'));
    ok(tr.some(function (l) { return /Günümüz/.test(l); }), 'tr: "Günümüz"');
    ok(en.some(function (l) { return /Present/.test(l); }), 'en: "Present"');
    ok(en.indexOf('English') >= 0 && en.indexOf('Turkish') >= 0, 'en: dil adları çevrildi');
    ok(en.indexOf('Native') >= 0 && en.indexOf('Advanced') >= 0, 'en: seviye etiketleri');
    ok(tr.indexOf('Ana dil') >= 0 && tr.indexOf('İleri') >= 0, 'tr: seviye etiketleri');
  })();

  // Modern: başlık, ünvan, dil çubukları, bağlantılar
  (function () {
    var dd = get('SAMPLE/modern/tr/foto');
    var accent = dd.background(1, A4).canvas[0].color;
    var title = findNodes(dd.content, function (n) { return n.text === 'KIDEMLİ PROJE YÖNETİCİSİ'; });
    ok(title.length === 1 && title[0].node.characterSpacing === 1.6 && title[0].node.color === accent && title[0].node.bold, 'modern: ünvan büyük harf (Türkçe İ), aralıklı, vurgu renginde');
    var name = findNodes(dd.content, function (n) { return n.text === 'Emre Aksoy'; })[0];
    ok(name && name.node.font === 'DMSerif' && name.node.fontSize === 30 && name.node.lineHeight === 1, 'modern: isim DMSerif 30pt');
    var cols = dd.content[0].columns;
    ok(cols && cols.length === 2 && cols[0].width === 188 && cols[1].width === '*' && dd.content[0].columnGap === 0, 'modern: iki sütun 188 + *');
    same(cols[0].margin, [22, 0, 18, 0], 'modern: kenar çubuğu iç boşluğu');
    same(cols[1].margin, [24, 0, 34, 0], 'modern: ana sütun boşluğu');

    var bars = findNodes(cols[0], function (n) { return Array.isArray(n.canvas) && n.canvas.length === 5 && n.canvas[0].type === 'rect'; });
    eq(bars.length, 3, 'modern: 3 dil için seviye çubuğu');
    var fills = bars.map(function (b) { return b.node.canvas.filter(function (r) { return r.color === '#ffffff'; }).length; });
    same(fills, [5, 4, 1], 'modern: dolu dilimler (ana dil 5, ileri 4, başlangıç 1)');
    ok(bars.every(function (b) { return b.node.canvas.every(function (r) { return r.h > 0 && r.w > 0 && r.r > 0 && r.x + r.w <= 148.01; }); }), 'modern: çubuk dilimleri kenar çubuğuna sığar');

    var json = JSON.stringify(dd.content);
    ok(json.indexOf('"link":"mailto:emre.aksoy@example.com"') >= 0, 'modern: e-posta bağlantısı');
    ok(json.indexOf('"link":"https://linkedin.com/in/emre-aksoy-ornek"') >= 0, 'modern: web bağlantısı');
    var skillsUl = findNodes(cols[0], function (n) { return Array.isArray(n.ul); });
    ok(skillsUl.length >= 1 && skillsUl.every(function (u) { return u.node.type === 'square'; }), 'modern: yetenekler kare işaretli');
    var mainUl = findNodes(cols[1], function (n) { return Array.isArray(n.ul); });
    ok(mainUl.length > 0 && mainUl.every(function (u) { return u.node.markerColor === accent && u.node.fontSize === 9.5; }), 'modern: ana sütun maddeleri vurgu renkli işaretli 9.5pt');
    var heads = findNodes(cols[1], function (n) { return n.text === 'İŞ DENEYİMİ'; });
    ok(heads.length && heads[0].node.fontSize === 9 && heads[0].node.bold && heads[0].node.color === accent, 'modern: ana başlık stili');
    var sideHead = findNodes(cols[0], function (n) { return n.text === 'YETENEKLER'; });
    ok(sideHead.length && sideHead[0].node.fontSize === 8 && sideHead[0].node.characterSpacing === 1.4, 'modern: kenar başlığı stili');
    var dates = findNodes(cols[1], function (n) { return n.width === 'auto' && n.fontSize === 8.5 && n.color === MUTED; });
    eq(dates.length, 5, 'modern: 3 iş + 2 eğitim tarihi sağda');
  })();

  // Modern: photoRound yoksa kare foto; showPhoto=false foto yok; fotoğraf yoksa photoRound tek başına kullanılmaz
  (function () {
    var cv = clone(SAMPLE); cv.photo = JPG;
    var a = CVPdf.build(cv, { template: 'modern', showPhoto: true, photoRound: '' });
    var imgs = findNodes(a.content, function (n) { return n.image !== undefined; });
    ok(imgs.length === 1 && imgs[0].node.image === JPG, 'modern: photoRound yoksa kare foto');
    var b = CVPdf.build(cv, { template: 'modern', showPhoto: true, photoRound: 'data:image/gif;base64,R0lG' });
    ok(findNodes(b.content, function (n) { return n.image !== undefined; })[0].node.image === JPG, 'modern: geçersiz photoRound yok sayılır');
    var c = CVPdf.build(SAMPLE, { template: 'modern', showPhoto: true, photoRound: PNG });
    eq(findNodes(c.content, function (n) { return n.image !== undefined; }).length, 0, 'modern: cv.photo boşsa photoRound da yok');
    var bad = clone(SAMPLE); bad.photo = 'https://ornek.com/foto.jpg';
    TEMPLATE_IDS.forEach(function (tpl) {
      eq(findNodes(CVPdf.build(bad, { template: tpl, showPhoto: true }).content, function (n) { return n.image !== undefined; }).length, 0, tpl + ': data URL olmayan foto yok sayılır');
    });
    var def = CVPdf.build(cv, { template: 'klasik' });
    eq(findNodes(def.content, function (n) { return n.image !== undefined; }).length, 1, 'klasik: showPhoto verilmezse varsayılan açık');
  })();

  // Klasik
  (function () {
    var dd = get('STRESS/klasik/tr/foto');
    var accent = CVPdf.ACCENTS.filter(function (a) { return JSON.stringify(dd).indexOf(a) >= 0; })[0];
    var rule = findNodes(dd.content, function (n) { return Array.isArray(n.canvas) && n.canvas[0].lineWidth === 1.2; });
    ok(rule.length === 1 && rule[0].node.canvas[0].lineColor === accent && Math.abs(rule[0].node.canvas[0].x2 - 495.28) < 0.01, 'klasik: başlık altında 1.2pt vurgu çizgisi');
    var title = findNodes(dd.content, function (n) { return n.text === STRESS.title; });
    ok(title.length === 1 && title[0].node.font === 'DMSerif' && title[0].node.italics === true && title[0].node.fontSize === 13, 'klasik: ünvan DMSerif italik 13pt');
    var contact = findNodes(dd.content, function (n) { return Array.isArray(n.text) && n.fontSize === 8.5; });
    ok(contact.length === 1 && nodeText(contact[0].node) === [STRESS.phone, STRESS.email, STRESS.city, STRESS.web].join('  ·  '), 'klasik: iletişim satırı "  ·  " ile');
    var gutters = findNodes(dd.content, function (n) { return Array.isArray(n.columns) && n.columns[0].width === 108; });
    ok(gutters.length >= 9, 'klasik: bölümler 108pt başlık oluğuyla');
    var dd2 = get('SAMPLE/klasik/tr/fotosuz');
    var lines = allLines(dd2);
    ok(lines.indexOf('Türkçe — Ana dil') >= 0, 'klasik: "Türkçe — Ana dil"');
    ok(lines.indexOf('Doğum Tarihi: 14 Mayıs 1991') >= 0, 'klasik: kişisel bilgi "Etiket: değer"');
    ok(lines.some(function (l) { return l.indexOf('Proje planlama  ·  Risk yönetimi') === 0; }), 'klasik: yetenekler "  ·  " ile');
    ok(lines.indexOf(CVParse.splitList(SAMPLE.hobbies).join(', ')) >= 0, 'klasik: hobiler virgülle');
    var certHead = findNodes(dd2.content, function (n) { return n.text === 'SERTİFİKALAR VE KURSLAR'; })[0];
    var certBlock = certHead && nearestUnbreakable(certHead.anc);
    ok(certBlock && textsOf(certBlock).filter(function (t) { return /\(20\d\d\)$/.test(t); }).length >= 2, 'klasik: iki satırlık başlığın yanına en az iki sertifika (boşluk kalmasın)');
    ok(lines.indexOf('Endüstri Mühendisliği (Lisans)') >= 0, 'klasik: program (derece)');
  })();

  // Sade: tek sütun, renk yalnızca başlıklarda, tuval yalnızca başlık çizgileri
  (function () {
    ['SAMPLE', 'STRESS'].forEach(function (cvName) {
      ['tr', 'en'].forEach(function (lang) {
        var key = cvName + '/sade/' + lang + '/foto';
        var dd = get(key);
        var accent = null;
        walk(dd.content, function (v, p) { if (/\.color$/.test(p) && v !== INK && v !== MUTED && !accent) accent = v; });
        eq(findNodes(dd.content, function (n) { return n.columns !== undefined; }).length, 0, key + ': sütun yok');
        eq(findNodes(dd.content, function (n) { return n.image !== undefined; }).length, 0, key + ': görsel yok');
        var canv = findNodes(dd.content, function (n) { return n.canvas !== undefined; });
        var heads = headingsFor('sade', lang);
        eq(canv.length, heads.length, key + ': tuval sayısı = başlık sayısı');
        ok(canv.every(function (c) { return c.node.canvas.length === 1 && c.node.canvas[0].type === 'line' && c.node.canvas[0].lineWidth === 0.5; }), key + ': tuvaller 0.5pt çizgi');
        var colored = findNodes(dd.content, function (n) { return n.color !== undefined && n.color !== INK && n.color !== MUTED; });
        ok(colored.length === heads.length && colored.every(function (c) { return heads.indexOf(c.node.text) >= 0 && c.node.bold && c.node.fontSize === 10; }), key + ': renkli metin yalnızca başlıklar');
        ok(findNodes(dd.content, function (n) { return n.markerColor !== undefined; }).length === 0, key + ': renkli madde işareti yok');
        var nameNode = findNodes(dd.content, function (n) { return n.text === CVS[cvName].name; })[0];
        ok(nameNode && nameNode.node.bold && nameNode.node.fontSize === 20 && !nameNode.node.font, key + ': isim Roboto kalın 20pt');
        var lines = allLines(dd);
        ok(lines.some(function (l) { return l.indexOf(' | ') > 0 && l.indexOf('@') > 0; }), key + ': iletişim satırı');
      });
    });
    var lines = allLines(get('SAMPLE/sade/tr/foto'));
    ok(lines.indexOf('Atlas Lojistik A.Ş., İstanbul | ' + CVParse.formatRange('Mart 2021', 'Devam ediyor', 'tr')) >= 0, 'sade: şirket, şehir | tarih tek satırda');
    ok(lines.indexOf(CVParse.splitList(SAMPLE.skills).join(', ')) >= 0, 'sade: yetenekler virgülle');
  })();

  // Ünvan yalnızca şirket: şirket başlık olur
  (function () {
    var cv = { name: 'Deniz Kara', jobs: [{ id: '1', role: '', company: 'Mavi Deniz Gıda A.Ş.', city: 'Bursa', start: '2019', end: '2020', desc: 'Bölge satışlarını yönettim.' }] };
    TEMPLATE_IDS.forEach(function (tpl) {
      var dd = CVPdf.build(cv, { template: tpl });
      validateTree(dd, 'yalnız şirket/' + tpl, true);
      var h = findNodes(dd.content, function (n) { return n.text === 'Mavi Deniz Gıda A.Ş.' && n.bold === true; });
      eq(h.length, 1, tpl + ': yalnız şirketli iş — şirket kalın başlık');
      var lines = allLines(dd);
      ok(lines.some(function (l) { return /Bursa/.test(l) && !/Mavi Deniz/.test(l); }), tpl + ': şehir alt satırda tek başına');
      ok(lines.indexOf('İŞ DENEYİMİ') >= 0 && lines.indexOf('EĞİTİM') < 0, tpl + ': yalnızca dolu bölümler');
    });
    var edu = { edu: [{ id: 'e', school: 'Ankara Fen Lisesi', program: '', degree: '', start: '2005', end: '2009', note: '' }] };
    var dd2 = CVPdf.build(edu, { template: 'modern' });
    ok(findNodes(dd2.content, function (n) { return n.text === 'Ankara Fen Lisesi' && n.bold; }).length === 1, 'yalnız okul → okul başlık');
  })();

  // Ünvan büyük harf sezgisi
  (function () {
    function titleOf(t, lang) {
      var dd = CVPdf.build({ name: 'X', title: t }, { template: 'modern', lang: lang });
      return findNodes(dd.content, function (n) { return n.characterSpacing === 1.6 && n.fontSize === 10; })[0].node.text;
    }
    eq(titleOf('Kıdemli Muhasebe Uzmanı', 'tr'), 'KIDEMLİ MUHASEBE UZMANI', 'ünvan: Türkçe büyük harf');
    eq(titleOf('Mimar', 'tr'), 'MİMAR', 'ünvan: ASCII Türkçe → İ');
    eq(titleOf('Software Engineer', 'tr'), 'SOFTWARE ENGINEER', 'ünvan: İngilizce ünvan → I');
    eq(titleOf('Diyetisyen', 'en'), 'DIYETISYEN', 'ünvan: en CV → İngilizce kural (Türkçe harf yoksa)');
    eq(titleOf('İç Mimar', 'en'), 'İÇ MİMAR', 'ünvan: Türkçe harf varsa her dilde Türkçe kural');
  })();

  // Seçenek doğrulama
  (function () {
    var dd = CVPdf.build(SAMPLE, { template: 'yok', accent: 'kırmızı', lang: 'de' });
    same(dd.pageMargins, MARGINS.modern, 'bilinmeyen şablon → modern');
    eq(dd.background(1, A4).canvas[0].color, '#1F5C4A', 'geçersiz vurgu → varsayılan');
    ok(allLines(dd).indexOf('İŞ DENEYİMİ') >= 0, 'bilinmeyen dil → tr');
    eq(CVPdf.build(SAMPLE, { accent: '#abc' }).background(1, A4).canvas[0].color, '#aabbcc', '3 haneli vurgu genişletilir');
    eq(CVPdf.build(SAMPLE, { accent: '#23395B' }).background(1, A4).canvas[0].color, '#23395B', 'geçerli vurgu aynen');
    var d0 = attempt(function () { return CVPdf.build(SAMPLE); }, 'build(cv) seçeneksiz');
    if (d0.ok) validateTree(d0.value, 'seçeneksiz', true);
  })();

  // Çöp girdi dayanıklılığı
  (function () {
    var junk = [
      null, undefined, 42, 'Ayşe', [],
      { name: 123, title: null, jobs: 'iş', edu: { a: 1 }, skills: ['a'], langs: 5, photo: 7 },
      { jobs: [null, 5, 'x', {}, { role: 'Şef', desc: 42 }], edu: [null, { school: 'Okul' }], refs: '\n\n', certs: '•\n-\n1.' },
      { name: 'Ali', web: 'https://ali.dev/', email: '  ali @ornek.com ', phone: '0532 111 22 33' },
      { langs: 'ana dil, c1', skills: ',,, ;;', hobbies: ' ve ' }
    ];
    junk.forEach(function (cv, i) {
      TEMPLATE_IDS.forEach(function (tpl) {
        ['tr', 'en'].forEach(function (lang) {
          var r = attempt(function () { return CVPdf.build(cv, { template: tpl, lang: lang, showPhoto: true }); }, 'çöp #' + i + ' ' + tpl + '/' + lang + ' atmaz');
          if (r.ok) { validateTree(r.value, 'çöp #' + i + ' ' + tpl + '/' + lang, true); jsonOk(r.value, 'çöp #' + i + ' ' + tpl); }
        });
      });
    });
    var w = JSON.stringify(CVPdf.build(junk[7], { template: 'klasik' }).content);
    ok(w.indexOf('"link":"https://ali.dev/"') >= 0 && w.indexOf('https://https') < 0, 'protokollü web iki kez önek almaz');
    ok(w.indexOf('"text":"ali.dev"') >= 0, 'web görünümü protokolsüz');
    ok(w.indexOf('"link":"mailto:ali@ornek.com"') >= 0, 'e-posta boşlukları temizlenir');
  })();

  // İki build arasında ortak nesne yok (pdfmake düğümleri değiştirir)
  (function () {
    var a = CVPdf.build(SAMPLE, { template: 'modern' }), b = CVPdf.build(SAMPLE, { template: 'modern' });
    var seen = new Set();
    walk(a, function (v) { if (v && typeof v === 'object') seen.add(v); });
    var shared = 0;
    walk(b, function (v) { if (v && typeof v === 'object' && seen.has(v)) shared++; });
    eq(shared, 0, 'build çağrıları nesne paylaşmaz');
    a.content[0].columns[1].stack[0].text = 'değişti';
    eq(CVPdf.build(SAMPLE, { template: 'modern' }).content[0].columns[1].stack[0].text, 'Emre Aksoy', 'önceki çıktıyı değiştirmek sonrakini etkilemez');
    var labelsBefore = JSON.stringify(CVPdf.labels('tr'));
    walk(a, function (v) { if (v && typeof v === 'object' && !Array.isArray(v)) v._margin = [1, 1, 1, 1]; });
    eq(JSON.stringify(CVPdf.labels('tr')), labelsBefore, 'çıktı değişimi etiketleri bozmaz');
  })();

  // Stres: tüm içerik mevcut
  (function () {
    TEMPLATE_IDS.forEach(function (tpl) {
      var dd = get('STRESS/' + tpl + '/tr/foto');
      var texts = textsOf(dd.content);
      var all = texts.join('\n');
      ok(CVParse.splitList(STRESS.skills).every(function (s) { return all.indexOf(s) >= 0; }), tpl + ': 30 yeteneğin hepsi');
      var bullets = 0;
      STRESS.jobs.forEach(function (j) { CVParse.splitLines(j.desc).forEach(function (b) { if (texts.indexOf(b) >= 0) bullets++; }); });
      eq(bullets, 56, tpl + ': 8 iş × 7 madde');
      ok(all.indexOf('Süperkalifragilistikekspiyalidosyus') >= 0, tpl + ': uzun kelime korunur');
      // bölünmez blok, en geniş sütunda (sade, 483pt) bile sayfanın ~%65'ini geçmemeli
      ok(findNodes(dd.content, function (n) { return n.unbreakable === true; }).every(function (u) { return textsOf(u.node).join('').length <= 3700; }), tpl + ': bölünmez bloklar sayfadan kısa');
      if (tpl === 'modern') {
        ok(findNodes(dd.content[0].columns[0], function (n) { return n.unbreakable === true; }).every(function (u) { return textsOf(u.node).join('').length <= 1200; }), 'modern: kenar çubuğundaki bölünmez bloklar dar sütuna göre kısa');
      }
    });
    var huge = { name: 'Uzun Özet', summary: new Array(800).join('Kelime ') };
    TEMPLATE_IDS.forEach(function (tpl) {
      var dd = CVPdf.build(huge, { template: tpl });
      var head = findNodes(dd.content, function (n) { return n.text === 'PROFİL'; })[0];
      ok(head && !nearestUnbreakable(head.anc), tpl + ': sayfadan uzun paragraf bölünmez blok yapılmaz (metin kaybolmasın)');
      ok(textsOf(dd.content).join('').length > 5000, tpl + ': uzun paragrafın tamamı çıktıda');
    });
  })();

  /* ====================================== pdfmake 0.2.10 uyum denetimi (entegrasyon) */

  /*
   * Aşağıdaki anahtar listeleri pdfmake 0.2.10 kaynağından çıkarıldı (DocPreprocessor/DocMeasure/
   * LayoutBuilder içerik türleri, StyleContextStack.autopush stil özellikleri, TextTools.measure,
   * renderVector). Yanlış yazılmış ya da motorun okumadığı bir anahtar sessizce yok sayılacağından
   * burada hata sayılır.
   */
  print('# pdfmake 0.2.10 uyumu');
  function keySet(list) { var o = {}; list.forEach(function (k) { o[k] = true; }); return o; }
  // DocMeasure columns > stack > ul … sırasıyla, LayoutBuilder ise stack > columns sırasıyla bakar:
  // iki içerik türü taşıyan düğüm ölçülüp başka türlü dizilir. Her düğümde tam olarak bir tür olmalı.
  var CONTENT_KINDS = ['columns', 'stack', 'ul', 'ol', 'table', 'text', 'toc', 'image', 'svg', 'canvas', 'qr'];
  var NODE_KEYS = keySet(CONTENT_KINDS.concat(['width', 'margin', 'unbreakable', 'columnGap', 'fit', 'alignment', 'link',
    'noWrap', 'type', 'markerColor', 'font', 'fontSize', 'bold', 'italics', 'color', 'lineHeight', 'characterSpacing']));
  var INLINE_KEYS = keySet(['text', 'bold', 'italics', 'color', 'link', 'font', 'fontSize', 'characterSpacing', 'noWrap']);
  var VECTOR_KEYS = {
    rect: keySet(['type', 'x', 'y', 'w', 'h', 'r', 'color', 'lineColor', 'lineWidth']),
    line: keySet(['type', 'x1', 'y1', 'x2', 'y2', 'lineWidth', 'lineColor'])
  };
  var DD_KEYS = keySet(['info', 'language', 'pageSize', 'pageOrientation', 'pageMargins', 'defaultStyle', 'content', 'footer', 'background']);
  var ROBOTO_LH = 1.1719; // Roboto (ascender − descender) / em: pdfmake satır yüksekliği = boyut × bu × lineHeight
  function fin(v) { return typeof v === 'number' && isFinite(v); }

  // Bilerek cömert (fazla) Roboto genişlik tahmini; yalnızca yükseklik üst sınırı için.
  function estStr(s, size) {
    var em = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      em += ch === ' ' ? 0.25 : /[iıjlIİtfr.,:;'’!|·\-]/.test(ch) ? 0.3 : /[mwMW]/.test(ch) ? 0.85
        : /[A-ZÇĞÖŞÜ]/.test(ch) ? 0.68 : /[0-9]/.test(ch) ? 0.57 : 0.56;
    }
    return em * size;
  }
  // Düğümün tahmini yüksekliği (pt); box: kullanılabilir genişlik; st: miras alınan yazı boyutu/satır yüksekliği.
  function estHeight(node, box, st) {
    if (typeof node === 'string') node = { text: node };
    var s = { fontSize: node.fontSize || st.fontSize, lineHeight: node.lineHeight || st.lineHeight };
    var m = node.margin || [0, 0, 0, 0];
    var inner = Math.max(10, box - m[0] - m[2]);
    var h = 0;
    if (node.columns) {
      var gap = node.columnGap || 0, fixed = 0, autoW = 0, stars = 0;
      node.columns.forEach(function (c) {
        if (typeof c.width === 'number') fixed += c.width;
        else if (c.width === 'auto') autoW += estStr(nodeText(c), c.fontSize || s.fontSize) + (c.margin ? c.margin[0] + c.margin[2] : 0);
        else stars++;
      });
      var starW = Math.max(10, (inner - fixed - autoW - gap * (node.columns.length - 1)) / Math.max(1, stars));
      node.columns.forEach(function (c) {
        var w = typeof c.width === 'number' ? c.width : c.width === 'auto' ? inner : starW;
        h = Math.max(h, estHeight(c, w, s));
      });
    } else if (node.stack) {
      node.stack.forEach(function (c) { h += estHeight(c, inner, s); });
    } else if (node.ul) {
      node.ul.forEach(function (c) { h += estHeight(c, inner - 1.2 * s.fontSize, s); });
    } else if (node.canvas) {
      node.canvas.forEach(function (v) { h = Math.max(h, v.type === 'rect' ? v.y + v.h : Math.max(v.y1, v.y2)); });
    } else if (node.image) {
      h = node.fit ? node.fit[1] : 100;
    } else if (node.text !== undefined) {
      var lines = 0;
      nodeText(node).split('\n').forEach(function (seg) { lines += Math.max(1, Math.ceil(estStr(seg, s.fontSize) / inner)); });
      h = lines * s.fontSize * ROBOTO_LH * s.lineHeight;
    }
    return h + m[1] + m[3];
  }

  /*
   * Bir içerik ağacını pdfmake 0.2.10 kurallarına göre denetler. box: düğümün genişliği (pt).
   * unbreakables dizisine her bölünmez bloğun tahmini yüksekliğini ekler.
   */
  function audit(node, box, path, ctx, problems, unbreakables) {
    if (typeof node === 'string') return;
    if (!node || typeof node !== 'object' || Array.isArray(node)) { problems.push('düğüm nesne değil @ ' + path); return; }
    var kinds = CONTENT_KINDS.filter(function (k) { return node[k] !== undefined; });
    if (kinds.length !== 1) problems.push('içerik türü sayısı ' + kinds.length + ' (' + kinds.join('+') + ') @ ' + path);
    Object.keys(node).forEach(function (k) { if (!NODE_KEYS[k]) problems.push('pdfmake bu anahtarı okumaz: ' + k + ' @ ' + path); });
    if (node.width !== undefined && !ctx.inColumns) problems.push('sütun dışında width @ ' + path);
    if (node.type !== undefined && !node.ul) problems.push('type yalnızca ul için @ ' + path);
    if (node.ul && node.type !== undefined && ['disc', 'square', 'circle', 'none'].indexOf(node.type) < 0) problems.push('geçersiz ul type @ ' + path);
    if (node.fit !== undefined && !(node.image && Array.isArray(node.fit) && node.fit.length === 2 && node.fit.every(function (v) { return fin(v) && v > 0; }))) problems.push('geçersiz fit @ ' + path);
    if (node.noWrap !== undefined && !(node.noWrap === true && typeof node.text === 'string')) problems.push('noWrap yalnızca düz metinde @ ' + path);
    if (node.unbreakable !== undefined && node.unbreakable !== true) problems.push('unbreakable true olmalı @ ' + path);
    if (node.unbreakable && ctx.unbreakable) problems.push('iç içe unbreakable @ ' + path);
    ['absolutePosition', 'relativePosition', 'pageBreak'].forEach(function (k) { if (node[k] !== undefined) problems.push(k + ' kullanılmamalı @ ' + path); });
    var m = node.margin === undefined ? [0, 0, 0, 0] : node.margin;
    if (!(Array.isArray(m) && m.length === 4 && m.every(function (v) { return fin(v) && v >= 0; }))) { problems.push('margin 4 negatif olmayan sayı olmalı @ ' + path); m = [0, 0, 0, 0]; }
    var st = { fontSize: node.fontSize || ctx.st.fontSize, lineHeight: node.lineHeight || ctx.st.lineHeight };
    if (node.unbreakable) unbreakables.push({ path: path, h: estHeight(node, box, ctx.st), box: box });
    var inner = box - m[0] - m[2];
    var sub = { unbreakable: ctx.unbreakable || node.unbreakable === true, inColumns: false, st: st };
    if (node.columns) {
      if (!Array.isArray(node.columns) || !node.columns.length) { problems.push('boş columns @ ' + path); return; }
      // columnGap bir stil özelliğidir ve iç içe sütunlara miras kalır; her columns'ta açıkça verilmeli.
      if (!fin(node.columnGap)) problems.push('columnGap açıkça verilmeli @ ' + path);
      var gap = node.columnGap || 0, fixed = 0, stars = 0;
      node.columns.forEach(function (c, i) {
        if (typeof c.width === 'number' && c.width > 0) fixed += c.width;
        else if (c.width === '*' || c.width === undefined) stars++;
        else if (c.width !== 'auto') problems.push('geçersiz sütun genişliği @ ' + path + '[' + i + ']');
        // 'auto' sütun sola yer açmak için sıkıştırılınca (ColumnCalculator 3. durum) bölünür.
        if (c.width === 'auto' && c.noWrap !== true) problems.push("'auto' sütun noWrap değil @ " + path + '[' + i + ']');
      });
      if (fixed + gap * (node.columns.length - 1) > inner + 0.01) problems.push('sabit sütunlar sığmıyor @ ' + path);
      var restW = (inner - fixed - gap * (node.columns.length - 1)) / Math.max(1, stars);
      node.columns.forEach(function (c, i) {
        var w = typeof c.width === 'number' ? c.width : c.width === 'auto' ? inner : restW;
        audit(c, w, path + '.columns[' + i + ']', { unbreakable: sub.unbreakable, inColumns: true, st: st }, problems, unbreakables);
      });
    } else if (node.stack) {
      if (!Array.isArray(node.stack) || !node.stack.length) { problems.push('boş stack @ ' + path); return; }
      node.stack.forEach(function (c, i) { audit(c, inner, path + '.stack[' + i + ']', sub, problems, unbreakables); });
    } else if (node.ul) {
      if (!Array.isArray(node.ul) || !node.ul.length) { problems.push('boş ul @ ' + path); return; }
      node.ul.forEach(function (c, i) { audit(c, inner - 1.2 * st.fontSize, path + '.ul[' + i + ']', sub, problems, unbreakables); });
    } else if (node.canvas) {
      // pdfmake tuvalin boyutunu vektörlerden çıkarır (DocMeasure.measureCanvas): her vektörün
      // ölçüsü açık, sonlu ve sütunun içinde olmalı.
      node.canvas.forEach(function (v, i) {
        var vp = path + '.canvas[' + i + ']', keys = VECTOR_KEYS[v && v.type];
        if (!keys) { problems.push('bilinmeyen vektör @ ' + vp); return; }
        Object.keys(v).forEach(function (k) { if (!keys[k]) problems.push('vektör anahtarı okunmaz: ' + k + ' @ ' + vp); });
        if (v.type === 'rect') {
          if (!['x', 'y', 'w', 'h'].every(function (k) { return fin(v[k]); }) || v.w <= 0 || v.h <= 0 || v.x < 0 || v.y < 0) problems.push('rect ölçüsü açık değil @ ' + vp);
          if (v.r !== undefined && !(fin(v.r) && v.r >= 0 && v.r <= Math.min(v.w, v.h) / 2)) problems.push('rect r geçersiz @ ' + vp);
          if (!v.color) problems.push('rect rengi yok @ ' + vp);
          if (v.x + v.w > inner + 0.01) problems.push('rect sütundan taşar (' + (v.x + v.w) + ' > ' + inner + ') @ ' + vp);
        } else {
          if (!['x1', 'y1', 'x2', 'y2', 'lineWidth'].every(function (k) { return fin(v[k]); }) || v.lineWidth <= 0) problems.push('line ölçüsü açık değil @ ' + vp);
          if (!v.lineColor) problems.push('line rengi yok @ ' + vp);
          if (Math.max(v.x1, v.x2) > inner + 0.01 || Math.min(v.x1, v.x2) < 0) problems.push('line sütundan taşar @ ' + vp);
        }
      });
    } else if (node.image) {
      if (!node.fit) problems.push('görselin boyutu (fit) açık değil @ ' + path);
      else if (node.fit[0] > inner + 0.01) problems.push('görsel sütundan geniş @ ' + path);
    } else if (node.text !== undefined) {
      if (Array.isArray(node.text)) {
        node.text.forEach(function (t, i) {
          if (typeof t === 'string') return;
          if (!t || typeof t !== 'object' || typeof t.text !== 'string') { problems.push('satır içi parça düz metin olmalı @ ' + path + '.text[' + i + ']'); return; }
          Object.keys(t).forEach(function (k) { if (!INLINE_KEYS[k]) problems.push('satır içi anahtar okunmaz: ' + k + ' @ ' + path + '.text[' + i + ']'); });
        });
      } else if (typeof node.text !== 'string') problems.push('text string ya da dizi olmalı @ ' + path);
    }
  }

  var PAGE_H = { modern: A4.height - 68, klasik: A4.height - 96, sade: A4.height - 100 };
  var KEEP_SHARE = 0.65; // bölünmez blok sayfa içeriğinin en fazla bu kadarı (tahmini) olabilir

  function auditDoc(dd, tpl, label) {
    var problems = [], unbreakables = [];
    Object.keys(dd).forEach(function (k) { if (!DD_KEYS[k]) problems.push('docDefinition anahtarı okunmaz: ' + k); });
    var pm = dd.pageMargins;
    var st = { fontSize: dd.defaultStyle.fontSize, lineHeight: dd.defaultStyle.lineHeight };
    dd.content.forEach(function (n, i) {
      audit(n, A4.width - pm[0] - pm[2], '$.content[' + i + ']', { unbreakable: false, inColumns: false, st: st }, problems, unbreakables);
    });
    // background/footer: pdfmake bunları sayfa genişliğinde ayrı bloklarda dizer.
    if (typeof dd.background === 'function') {
      for (var p = 1; p <= 4; p++) {
        var bg = dd.background(p, { width: A4.width, height: A4.height, orientation: 'portrait' });
        if (!bg) { problems.push('background(' + p + ') boş'); continue; }
        audit(bg, A4.width, '$.background(' + p + ')', { unbreakable: false, inColumns: false, st: st }, problems, []);
      }
    }
    for (var q = 1; q <= 3; q++) {
      var ft = dd.footer(q, 3, { width: A4.width, height: A4.height });
      if (!ft) { problems.push('footer(' + q + ',3) boş'); continue; }
      audit(ft, A4.width, '$.footer(' + q + ')', { unbreakable: false, inColumns: false, st: st }, problems, []);
      if (ft.text !== (dd.info.author ? dd.info.author + ' · ' : '') + q + '/3') problems.push('footer(' + q + ',3) metni: ' + ft.text);
      // altbilgi alt kenar boşluğuna sığmalı (pdfmake onu pageMargins.bottom yüksekliğinde bir bloğa koyar)
      if (ft.margin[1] + ft.fontSize * ROBOTO_LH * dd.defaultStyle.lineHeight > pm[3]) problems.push('footer alt boşluğa sığmıyor');
    }
    if (dd.footer(1, 1) !== null || dd.footer(1, 0) !== null) problems.push('tek sayfada footer olmamalı');
    ok(problems.length === 0, label + ': pdfmake 0.2.10 denetimi' + (problems.length ? ' — ' + problems.slice(0, 6).join(' | ') : ''));
    var tall = unbreakables.filter(function (u) { return u.h > PAGE_H[tpl] * KEEP_SHARE; });
    ok(tall.length === 0, label + ': bölünmez bloklar sayfanın %' + KEEP_SHARE * 100 + "'inden kısa" +
      (tall.length ? ' — ' + tall.slice(0, 3).map(function (u) { return u.path + ' ≈ ' + Math.round(u.h) + 'pt'; }).join(' | ') : ''));
    return unbreakables;
  }

  // Tüm build matrisi denetimden geçer.
  Object.keys(built).forEach(function (key) { auditDoc(built[key], key.split('/')[1], key); });

  // Uç girdiler: sayfadan uzun olabilecek tek maddeler. Bölünmez blok sayfadan uzunsa pdfmake
  // 0.2.10 onu yeni sayfaya taşır ve oraya da sığmazsa TAMAMEN atar; kısa ama dev bloklar da
  // önceki sayfada yarım sayfalık boşluk bırakır.
  (function () {
    function words(n, w) { var a = []; for (var i = 0; i < n; i++) a.push(w); return a.join(' '); }
    function items(n, w) { var a = []; for (var i = 0; i < n; i++) a.push(w + i); return a.join(', '); }
    var base = { name: 'Uç Durum', title: 'Test', email: 'uc@example.com' };
    function job(desc) { return [{ id: 'a', role: 'Uzman', company: 'Şirket', city: 'Bursa', start: '2019', end: '2020', desc: desc }]; }
    var cases = {
      'ilk madde ≈2550 karakter': { jobs: job(words(425, 'süreç') + '\nikinci madde') },
      'BÜYÜK HARF ilk madde ≈2530': { jobs: job(words(230, 'SÜREÇLERİN') + '\nikinci madde') },
      'BÜYÜK HARF ilk madde ≈1540': { jobs: job(words(140, 'SÜREÇLERİN') + '\nikinci madde') },
      'özet ≈2500': { summary: words(250, 'deneyimli') },
      'ikinci özet paragrafı ≈2500': { summary: 'Kısa giriş.\n' + words(250, 'yönetimde') },
      'BÜYÜK HARF hobiler ≈1080': { hobbies: items(60, 'FOTOĞRAFÇILIK') },
      'hobiler ≈650': { hobbies: items(40, 'Fotoğrafçılık') },
      'sertifika ≈2240': { certs: words(160, 'Sertifikasyon') + '\nİkinci sertifika' },
      'referans ≈2260': { refs: 'Ad Soyad — ' + words(250, 'referans') + '\nİkinci Kişi — Müdür' },
      '60 yetenek': { skills: items(60, 'Yetenek numarası ') },
      'kişisel bilgi ≈1600': { military: words(200, 'tecilli') },
      'eğitim notu ≈2000': { edu: [{ id: 'e', school: 'Okul', program: 'Bölüm', degree: 'Lisans', start: '2010', end: '2014', note: words(250, 'notlar') }] }
    };
    Object.keys(cases).forEach(function (name) {
      var cv = clone(base), extra = cases[name];
      for (var k in extra) cv[k] = extra[k];
      var longest = 0;
      JSON.stringify(extra).split(/\\n|"/).forEach(function (part) { longest = Math.max(longest, part.replace(/, /g, '').length); });
      TEMPLATE_IDS.forEach(function (tpl) {
        var dd = CVPdf.build(cv, { template: tpl, lang: 'tr' });
        auditDoc(dd, tpl, 'uç: ' + name + '/' + tpl);
        ok(textsOf(dd.content).join('').length >= longest, 'uç: ' + name + '/' + tpl + ': uzun metin çıktıda');
      });
    });
  })();

  // Tarih sütunu: noWrap (sıkışıp "Mart 2021 –" / "Günümüz" diye bölünmesin); sığmazsa alt satıra iner.
  function inAutoRow(hit) {
    return hit.anc.some(function (a) { return Array.isArray(a.columns) && a.columns.some(function (c) { return c.width === 'auto'; }); });
  }
  (function () {
    ['modern', 'klasik'].forEach(function (tpl) {
      var dd = get('SAMPLE/' + tpl + '/tr/foto');
      var dates = findNodes(dd.content, function (n) { return n.width === 'auto' && n.fontSize === 8.5; });
      ok(dates.length === 5 && dates.every(function (d) { return d.node.noWrap === true; }), tpl + ': tarih sütunları noWrap');
      // ≈300pt'lik tek kelime: tarih (≈90pt) ile yan yana 349pt'ye sığmaz → pdfmake sütunları taşırırdı
      var longRole = 'Kıdemli Uluslararasıtedarikzinciriyönetimiuzmanlığıkoordinatörlüğü';
      var cv = { name: 'X', jobs: [
        { id: '1', role: longRole, company: 'Şirket', start: 'Mart 2021', end: 'Devam ediyor', desc: 'Madde.' },
        { id: '2', role: 'Uzman', company: 'Şirket', start: 'Üniversite son sınıftayken yarı zamanlı olarak başladım', end: '', desc: '' },
        { id: '3', role: 'Kıdemli Yazılım Geliştirme ve Test Otomasyonu Mühendisi', company: 'Şirket', start: 'Eylül 2015', end: 'Devam ediyor', desc: '' }
      ] };
      var d2 = CVPdf.build(cv, { template: tpl });
      auditDoc(d2, tpl, tpl + ': uzun ünvan/tarih');
      var role = findNodes(d2.content, function (n) { return n.text === longRole; })[0];
      ok(role && !inAutoRow(role), tpl + ': tek kelimesi çok uzun ünvan sütuna konmaz');
      var range1 = CVParse.formatRange('Mart 2021', 'Devam ediyor', 'tr');
      ok(allLines(d2).indexOf(range1) >= 0, tpl + ': tarih ayrı satırda yine görünür');
      var free = findNodes(d2.content, function (n) { return typeof n.text === 'string' && n.text.indexOf('yarı zamanlı') >= 0; })[0];
      ok(free && !inAutoRow(free), tpl + ': serbest metin tarih ünvanı daraltmaz (alt satırda)');
      var normal = findNodes(d2.content, function (n) { return n.text === 'Kıdemli Yazılım Geliştirme ve Test Otomasyonu Mühendisi'; })[0];
      ok(normal && inAutoRow(normal), tpl + ': uzun ama çok kelimeli ünvan tarihle yan yana (ünvan kayar)');
    });
  })();

  // Modern dil satırı: etiket noWrap; ad çok uzunsa etiket alta iner, çubuk yine çizilir.
  (function () {
    var dd = get('SAMPLE/modern/en/foto');
    var labels = findNodes(dd.content[0].columns[0], function (n) { return n.width === 'auto'; });
    ok(labels.length === 3 && labels.every(function (l) { return l.node.noWrap === true && l.node.fontSize === 7.5; }), 'modern: dil seviyesi etiketi noWrap');
    var cv = { langs: 'Brezilyaportekizcesiveyerelağızları ileri, Portekizce iyi, İşaret dili orta' };
    var d2 = CVPdf.build(cv, { template: 'modern', lang: 'en' });
    auditDoc(d2, 'modern', 'modern: uzun dil adı');
    var side = d2.content[0].columns[0];
    var nm = findNodes(side, function (n) { return typeof n.text === 'string' && /^Brezilya/.test(n.text); })[0];
    ok(nm && !inAutoRow(nm), 'modern: uzun dil adı sütuna konmaz');
    ok(allLines(d2).indexOf('Advanced') >= 0, 'modern: alta inen seviye etiketi görünür');
    eq(findNodes(side, function (n) { return Array.isArray(n.canvas) && n.canvas.length === 5; }).length, 3, 'modern: üç dilin de çubuğu var');
    ok(findNodes(side, function (n) { return n.text === 'Upper-intermediate'; }).some(inAutoRow), 'modern: "Upper-intermediate" kısa adla yan yana sığar');
  })();

  // Fotoğraf doğrulama: pdfmake'in büyük/küçük harfe duyarlı data URL regex'i ve pdfkit'in bayt imzası.
  (function () {
    var JPG_DATA = JPG.slice(JPG.indexOf(',') + 1), PNG_DATA = PNG.slice(PNG.indexOf(',') + 1);
    function photoOf(photo, tpl, round) {
      var dd = CVPdf.build({ name: 'Foto', photo: photo }, { template: tpl || 'klasik', showPhoto: true, photoRound: round || '' });
      var im = findNodes(dd.content, function (n) { return n.image !== undefined; });
      return im.length ? im[0].node.image : null;
    }
    eq(photoOf('data:image/JPEG;base64,' + JPG_DATA), 'data:image/jpeg;base64,' + JPG_DATA, 'büyük harfli önek küçültülür (pdfmake regex)');
    eq(photoOf('data:image/jpg;base64,' + JPG_DATA), 'data:image/jpeg;base64,' + JPG_DATA, 'jpg → jpeg');
    eq(photoOf('data:image/png;base64,' + JPG_DATA), 'data:image/jpeg;base64,' + JPG_DATA, 'yanlış etiketli JPEG gerçek türüyle');
    eq(photoOf(PNG), PNG, 'PNG aynen');
    eq(photoOf('data:image/png;base64,UklGRhYAAABXRUJQVlA4'), null, 'png etiketli WebP baytları atlanır (pdfkit atardı)');
    eq(photoOf('data:image/jpeg;base64,R0lGODlhAQABAAAAACw='), null, 'jpeg etiketli GIF baytları atlanır');
    eq(photoOf('data:image/jpeg;base64,'), null, 'boş veri atlanır');
    eq(photoOf(JPG, 'modern', 'data:image/png;base64,' + JPG_DATA), JPG, 'modern: JPEG baytlı photoRound yerine kare foto');
    eq(photoOf(JPG, 'modern', 'data:image/PNG;base64,' + PNG_DATA), PNG, 'modern: büyük harfli PNG photoRound küçültülerek kullanılır');
    eq(CVPdf.hasContent({ photo: 'data:image/png;base64,UklGRhYAAABXRUJQVlA4' }), false, 'hasContent: basılamayacak foto içerik sayılmaz');
    eq(CVPdf.hasContent({ photo: 'https://ornek.com/a.jpg' }), false, 'hasContent: URL foto içerik sayılmaz');
    eq(CVPdf.hasContent({ photo: PNG }), true, 'hasContent: PNG foto içerik');
  })();

  // Bölüm sırası (SPEC): modern kenar çubuğu ve ana sütun; boş bölümler tek tek atlanır.
  (function () {
    function order(node, heads) {
      var seen = [];
      walk(node, function (v) { if (v && typeof v === 'object' && heads.indexOf(v.text) >= 0) seen.push(v.text); });
      return seen;
    }
    ['tr', 'en'].forEach(function (lang) {
      var L = CVPdf.labels(lang), U = function (k) { return lang === 'en' ? L[k].toUpperCase() : trUpper(L[k]); };
      var dd = get('SAMPLE/modern/' + lang + '/foto');
      var sideHeads = ['contact', 'skills', 'languages', 'personal', 'hobbies'].map(U);
      var mainHeads = ['profile', 'experience', 'education', 'certs', 'refs'].map(U);
      same(order(dd.content[0].columns[0], sideHeads.concat(mainHeads)), sideHeads, 'modern/' + lang + ': kenar çubuğu sırası');
      same(order(dd.content[0].columns[1], sideHeads.concat(mainHeads)), mainHeads, 'modern/' + lang + ': ana sütun sırası');
    });
    var only = {
      summary: ['profile', 'Kısa özet.'], skills: ['skills', 'Excel'], langs: ['languages', 'İngilizce ileri'],
      certs: ['certs', 'PMP (2020)'], hobbies: ['hobbies', 'Satranç'], refs: ['refs', 'Ali Veli — Müdür'],
      birth: ['personal', '1990'], phone: ['contact', '0532 111 22 33'],
      jobs: ['experience', [{ id: 'j', role: 'Uzman', company: '', city: '', start: '', end: '', desc: '' }]],
      edu: ['education', [{ id: 'e', school: 'Okul', program: '', degree: '', start: '', end: '', note: '' }]]
    };
    var allKeys = ['contact', 'profile', 'experience', 'education', 'skills', 'languages', 'certs', 'hobbies', 'refs', 'personal'];
    Object.keys(only).forEach(function (field) {
      TEMPLATE_IDS.forEach(function (tpl) {
        var cv = clone(EMPTY); cv[field] = only[field][1];
        var dd = CVPdf.build(cv, { template: tpl });
        var L = CVPdf.labels('tr');
        var shown = allKeys.filter(function (k) { return allLines(dd).indexOf(trUpper(L[k])) >= 0; });
        var expect = (field === 'phone' && tpl !== 'modern') ? [] : [only[field][0]];
        same(shown, expect, tpl + ': yalnızca ' + field + ' → yalnızca o bölüm');
      });
    });
  })();

  // Modern: kenar çubuğu her sayfada; ana sütun ve altbilgi kenar çubuğunun sağında.
  (function () {
    var dd = get('STRESS/modern/tr/foto');
    var ok5 = true;
    for (var p = 1; p <= 6; p++) {
      var bg = dd.background(p, { width: A4.width, height: A4.height });
      ok5 = ok5 && bg && bg.canvas.length === 1 && bg.canvas[0].x === 0 && bg.canvas[0].y === 0 && bg.canvas[0].w === 188 && bg.canvas[0].h === A4.height;
    }
    ok(ok5, 'modern: kenar çubuğu 1–6. sayfaların hepsinde tam yükseklik');
    var cols = dd.content[0].columns;
    ok(cols[0].width === 188 && cols[1].margin[0] === 24 && dd.content[0].columnGap === 0 && dd.pageMargins[0] === 0, 'modern: ana sütun x = 188 + 24 (kenar çubuğuyla örtüşmez)');
    same(dd.footer(2, 3).margin, [188 + 24, 13, 34, 0], 'modern: altbilgi ana sütunun kutusunda');
    // kenar çubuğundaki metin vurgu zemininde okunur olmalı (WCAG kontrastı)
    function lum(hex) {
      var c = [1, 3, 5].map(function (i) { var v = parseInt(hex.substr(i, 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }
    function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
    CVPdf.ACCENTS.forEach(function (accent) {
      var d = CVPdf.build(SAMPLE, { template: 'modern', accent: accent });
      var worst = 99;
      walk(d.content[0].columns[0], function (v) {
        if (v && typeof v === 'object' && typeof v.color === 'string' && (v.text !== undefined || v.ul !== undefined)) {
          var c = contrast(v.color, accent);
          worst = Math.min(worst, c);
        }
      });
      ok(worst >= 3, 'modern ' + accent + ': kenar çubuğu metin kontrastı ≥ 3 (' + worst.toFixed(2) + ')');
      var main = [];
      walk(d.content[0].columns[1], function (v) { if (v && typeof v === 'object' && typeof v.color === 'string' && v.text !== undefined) main.push(contrast(v.color, '#ffffff')); });
      ok(Math.min.apply(null, main) >= 4.5, 'modern ' + accent + ': ana sütun metin kontrastı ≥ 4.5');
    });
  })();

  /* ------------------------------------------------------------------- sonuç */

  print('pdfdoc: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) throw new Error(failed + ' test başarısız');
})();
