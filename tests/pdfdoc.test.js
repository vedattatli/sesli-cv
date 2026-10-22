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
  var TEMPLATE_IDS = ['klasik', 'sade', 'modern'];
  // v2 (brief §4.7): yeni kenar boşlukları ve şablona göre gövde puntosu (modern: §8 C8 ile 10).
  var MARGINS = { modern: [40, 40, 40, 40], klasik: [51, 48, 51, 45], sade: [57, 48, 57, 45] };
  var BODY = { modern: 10, klasik: 10, sade: 10.5 };
  var MODERN_TINT_X = 360, MODERN_MAIN_W = 310, MODERN_SIDE_W = 515.28 - 310 - 22;
  // Modern v2: içerik [başlık, vurgu çizgisi, zemin tuvali, sütunlar]; sütunlar [ana, kenar çubuğu].
  function modernCols(dd) {
    for (var i = 0; i < dd.content.length; i++) if (Array.isArray(dd.content[i].columns) && dd.content[i].columns.length === 2 && dd.content[i].columns[0].width === MODERN_MAIN_W) return dd.content[i].columns;
    return null;
  }
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
        if (isContentArray && v.text === undefined && !v.stack && !v.columns && !v.ul && !v.ol && !v.canvas && !v.image && !v.svg && !v.table) {
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
    cv.projects = [];
    for (var pi = 0; pi < 6; pi++) {
      var pl = [];
      for (var pb = 0; pb < 4; pb++) {
        pl.push('Proje ' + (pi + 1) + '.' + (pb + 1) + ': Dağıtıksistemlerdeölçeklenebilirlikçalışmaları kapsamında ' +
          'kuyruk tabanlı mimariyi tasarlayıp canlıya aldım; ğüşıöç ĞÜŞİÖÇ.');
      }
      cv.projects.push({
        id: 'p' + pi, name: 'Çok Uzun Adlı Açık Kaynak Proje ' + (pi + 1) + ' — Gerçek Zamanlı Envanter ve Sipariş Eşleştirme Motoru',
        tech: 'Python, FastAPI, PostgreSQL, Redis, Kafka, Docker, Kubernetes, Terraform, GitHub Actions, Grafana',
        link: 'github.com/gulsen-caglayan-ozturkoglu/cok-uzun-depo-adi-gercek-zamanli-envanter-motoru-' + pi,
        desc: pl.join('\n')
      });
    }
    return cv;
  }
  var STRESS = stressCv();

  var CVS = { SAMPLE: SAMPLE, EMPTY: EMPTY, EMPTY_ENTRIES: EMPTY_ENTRIES, NAME_ONLY: NAME_ONLY, STRESS: STRESS };

  // v2: iletişim her şablonda başlıkta (modern'de de "İletişim" bölümü yok — brief §4.5).
  function headingsFor(tpl, lang) {
    var L = CVPdf.labels(lang);
    var keys = ['profile', 'experience', 'projects', 'education', 'skills', 'languages', 'certs', 'hobbies', 'refs', 'personal'];
    return keys.map(function (k) { return lang === 'en' ? L[k].toUpperCase() : trUpper(L[k]); });
  }
  function allHeadings(lang) {
    var L = CVPdf.labels(lang);
    return ['contact', 'profile', 'experience', 'projects', 'education', 'skills', 'languages', 'certs', 'hobbies', 'refs', 'personal']
      .map(function (k) { return lang === 'en' ? L[k].toUpperCase() : trUpper(L[k]); });
  }

  /* ================================================================ API yüzeyi */

  print('# API');
  // v2: klasik önce (varsayılan/yedek), modern en sonda; her şablonda seçici açıklaması (desc).
  same(CVPdf.TEMPLATES.map(function (t) { return [t.id, t.tr, t.en, t.photo]; }), [
    ['klasik', 'Klasik', 'Classic', true], ['sade', 'Sade', 'Plain', false], ['modern', 'Modern', 'Modern', true]
  ], 'TEMPLATES');
  same(CVPdf.TEMPLATES.map(function (t) { return t.desc; }), [
    'Kurumsal başvurular, e-posta ve çıktı için',
    'İş ilanı sitelerine yüklemek için en güvenli (ATS)',
    'E-postayla gönderim ve çıktı için; ilan sitelerinde Sade önerilir.'
  ], 'TEMPLATES desc (brief §4.3–4.5)');
  same(CVPdf.ACCENTS, ['#1F5C4A', '#23395B', '#7A2E3A', '#36404A', '#7A5212'], 'ACCENTS');
  ['labels', 'hasContent', 'registerFonts', 'build', 'fileName', 'mix', 'buildLetter', 'letterLayout', 'defaultTemplate', 'sectionOrder', 'skillGroups'].forEach(function (f) {
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
      contact: 'İletişim', profile: 'Profil', experience: 'İş Deneyimi', projects: 'Projeler', education: 'Eğitim', skills: 'Yetenekler',
      languages: 'Diller', certs: 'Sertifikalar', hobbies: 'İlgi Alanları', refs: 'Referanslar',
      personal: 'Kişisel Bilgiler', birth: 'Doğum Yılı', military: 'Askerlik Durumu', license: 'Sürücü Belgesi',
      marital: 'Medeni Durum', phone: 'Telefon', email: 'E-posta', city: 'Konum', web: 'Web', github: 'GitHub',
      refsLine: 'Referanslar talep üzerine iletilir.'
    };
    o.summary = o.profile; o.jobs = o.experience; o.edu = o.education; o.langs = o.languages; o.location = o.city;
    return o;
  })(), 'labels(tr)');
  same(CVPdf.labels('en'), (function () {
    var o = {
      contact: 'Contact', profile: 'Profile', experience: 'Experience', projects: 'Projects', education: 'Education', skills: 'Skills',
      languages: 'Languages', certs: 'Certifications', hobbies: 'Interests', refs: 'References',
      personal: 'Personal Details', birth: 'Year of Birth', military: 'Military Service', license: 'Driving Licence',
      marital: 'Marital Status', phone: 'Phone', email: 'Email', city: 'Location', web: 'Web', github: 'GitHub',
      refsLine: 'References available upon request.'
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
  ['name', 'title', 'phone', 'email', 'city', 'web', 'github', 'summary', 'skills', 'langs', 'certs', 'hobbies', 'refs', 'birth', 'military', 'license']
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
  eq(SAMPLE.github, 'github.com/emreaksoy-ornek', 'SAMPLE.github (SPEC)');
  ok(Array.isArray(SAMPLE.projects), 'SAMPLE.projects dizi');
  eq(SAMPLE.projects.length, 2, 'SAMPLE 2 proje');
  SAMPLE.projects.forEach(function (pr, i) {
    ['id', 'name', 'tech', 'link', 'desc'].forEach(function (f) { ok(typeof pr[f] === 'string' && pr[f].trim() !== '', 'SAMPLE.projects[' + i + '].' + f); });
    ok(/^github\.com\/emreaksoy-ornek\/[a-z0-9-]+$/.test(pr.link), 'SAMPLE.projects[' + i + '] bağlantısı protokolsüz, örnek hesapta');
    var n = CVParse.splitLines(pr.desc).length;
    ok(n >= 2 && n <= 3, 'SAMPLE.projects[' + i + '] 2–3 madde (' + n + ')');
    ok(CVParse.splitList(pr.tech).length >= 2, 'SAMPLE.projects[' + i + '] teknolojiler virgüllü');
  });
  eq(SAMPLE.projects[0].id === SAMPLE.projects[1].id, false, 'SAMPLE proje kimlikleri benzersiz');
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
  eq(CVPdf.hasContent({ github: 'github.com/ali' }), true, 'yalnızca github');
  eq(CVPdf.hasContent({ github: '  ' }), false, 'boşluklu github');
  eq(CVPdf.hasContent({ projects: [{ id: 'p', name: 'Stok Takip' }] }), true, 'yalnızca proje adı');
  eq(CVPdf.hasContent({ projects: [{ id: 'p', desc: 'Bir API yazdım.' }] }), true, 'yalnızca proje açıklaması');
  eq(CVPdf.hasContent({ projects: [{ id: 'p', tech: 'Python', link: 'github.com/a/b' }] }), false, 'adsız/açıklamasız proje (build basmaz) içerik değil');
  eq(CVPdf.hasContent({ projects: [{ id: 'p', name: ' ', desc: '\n \n' }] }), false, 'boşluklu proje');
  eq(CVPdf.hasContent({ projects: [null, 4, 'Proje', []] }), false, 'çöp proje girdileri');
  eq(CVPdf.hasContent({ projects: 'Proje' }), false, 'dizi olmayan projects');

  /* fileName */
  // v2 (brief §4.1 File): tire ile "Ayse-Kaya-CV.pdf".
  eq(CVPdf.fileName(SAMPLE), 'Emre-Aksoy-CV.pdf', 'fileName(SAMPLE)');
  eq(CVPdf.fileName({ name: 'Ayşe Yılmaz' }), 'Ayse-Yilmaz-CV.pdf', 'fileName Türkçe');
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
          same(dd.defaultStyle, { font: 'Roboto', fontSize: BODY[tpl], lineHeight: 1.15, color: INK, fontFeatures: { liga: false } }, key + ': defaultStyle');
          var nm = typeof cv.name === 'string' ? cv.name.trim() : '';
          var tt = typeof cv.title === 'string' ? cv.title.trim() : '';
          same(dd.info, { title: [nm, tt, 'CV'].filter(Boolean).join(' — '), author: nm, subject: 'CV', creator: 'Sesli CV' }, key + ': info ("Ad Soyad — Unvan — CV")');
          ok(Array.isArray(dd.content) && dd.content.length > 0, key + ': content dizi');

          // background: modern kenar çubuğu zemini 1. sayfada akıştaki tuvalde, 2. sayfa ve sonrasında background()'da.
          if (tpl === 'modern') {
            eq(typeof dd.background, 'function', key + ': background fonksiyon');
            eq(dd.background(1, { width: A4.width, height: A4.height }), null, key + ': background(1) yok (1. sayfada zemin başlığın altından başlar)');
            var hasSections = !!modernCols(dd);
            var bg = attempt(function () { return dd.background(2, { width: A4.width, height: A4.height }); }, key + ': background(2) atmaz').value;
            if (hasSections) {
              if (bg) validateTree(bg, key + ': background(2)', false);
              same(bg, { canvas: [{ type: 'rect', x: MODERN_TINT_X, y: 0, w: A4.width - MODERN_TINT_X, h: A4.height, color: CVPdf.mix(accent, '#ffffff', 0.9) }] }, key + ': kenar çubuğu zemini (sayfa 2, açık ton)');
              var bg0 = dd.background(3, undefined);
              eq(bg0 && bg0.canvas[0].h, A4.height, key + ': background pageSize yoksa A4 yüksekliği');
            } else eq(bg, null, key + ': bölüm yoksa zemin yok');
          } else {
            eq(dd.background, undefined, key + ': background yok');
          }

          // footer: yalnızca 2. sayfa ve sonrası (brief §4.1)
          eq(typeof dd.footer, 'function', key + ': footer fonksiyon');
          var ft = attempt(function () { return dd.footer(2, 3); }, key + ': footer(2,3) atmaz').value;
          if (ft) {
            validateTree(ft, key + ': footer', false);
            eq(ft.text, (nm ? nm + ' · ' : '') + '2/3', key + ': footer metni');
            eq(ft.fontSize, 7.5, key + ': footer 7.5pt');
            eq(ft.color, MUTED, key + ': footer MUTED');
            eq(ft.alignment, 'right', key + ': footer sağa yaslı');
            ok(Array.isArray(ft.margin) && ft.margin[0] >= MARGINS[tpl][0], key + ': footer sol boşluğu kenarı korur');
            eq(ft.margin[2], tpl === 'modern' ? A4.width - 40 - MODERN_MAIN_W : MARGINS[tpl][2], key + ': footer sağ kenar hizası (modern: ana sütunun sağ kenarı)');
          } else ok(false, key + ': footer(2,3) düğüm döndürmeli');
          eq(dd.footer(1, 1), null, key + ': tek sayfada footer yok');
          eq(dd.footer(1, 2), null, key + ': 1. sayfada footer yok');

          // görseller: klasik 3:4 vesikalık (fit 68×91), modern SVG ile yuvarlak kırpma, sade hiç
          var images = findNodes(dd.content, function (n) { return n.image !== undefined; });
          var svgs = findNodes(dd.content, function (n) { return n.svg !== undefined; });
          var expectImage = showPhoto && tpl !== 'sade' && typeof cv.photo === 'string' && cv.photo.indexOf('data:image/') === 0;
          eq(images.length + svgs.length, expectImage ? 1 : 0, key + ': fotoğraf sayısı');
          if (expectImage && tpl === 'modern') {
            eq(images.length, 0, key + ': modern bitmap yerine SVG kırpma');
            ok(svgs.length === 1 && svgs[0].node.svg.indexOf(cv.photo) >= 0 && /<clipPath[^>]*><circle cx="42" cy="42" r="42"\/>/.test(svgs[0].node.svg) &&
              /preserveAspectRatio="xMidYMid slice"/.test(svgs[0].node.svg), key + ': modern 84pt yuvarlak, ortadan kırpılmış (cv.photo; photoRound kullanılmaz)');
          } else if (expectImage) {
            eq(images[0].node.image, cv.photo, key + ': klasik fotoğrafı kullanır');
            same(images[0].node.fit, [68, 91], key + ': klasik foto 3:4 (68×91)');
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
            ok(lines.indexOf(lang === 'en' ? 'CONTACT' : 'İLETİŞİM') < 0, key + ': iletişim başlıkta, bölüm değil');
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
      // v2: sade sayısal tarih ("03/2021 – Günümüz"), klasik/modern ay adı (brief §3.2)
      var range = CVParse.formatRange(j.start, j.end, 'tr', { numeric: tpl === 'sade' });
      ok(lines.some(function (l) { return l.indexOf(range) >= 0; }), key + ': tarih aralığı "' + range + '"');
    });
  });

  // Tarih biçimi (dil)
  (function () {
    var tr = allLines(get('SAMPLE/modern/tr/foto')), en = allLines(get('SAMPLE/modern/en/foto'));
    ok(tr.some(function (l) { return /Günümüz/.test(l); }), 'tr: "Günümüz"');
    ok(en.some(function (l) { return /Present/.test(l); }), 'en: "Present"');
    ok(en.indexOf('English') >= 0 && en.indexOf('Turkish') >= 0, 'en: dil adları çevrildi');
    // v2: CEFR + sınav, çubuk yok ("C1 (Advanced) · IELTS 7.0 (2023)")
    ok(en.indexOf('Native') >= 0 && en.indexOf('C1 (Advanced) · IELTS 7.0 (2023)') >= 0 && en.indexOf('A2 (Elementary)') >= 0, 'en: seviye etiketleri');
    ok(tr.indexOf('Ana dil') >= 0 && tr.indexOf('C1 (İleri) · IELTS 7.0 (2023)') >= 0 && tr.indexOf('A2 (Temel)') >= 0, 'tr: seviye etiketleri');
  })();

  // Modern v2 (brief §4.5): tam genişlik başlık önce; altında [ana 310 | kenar çubuğu 183.28]; çubuk yok.
  (function () {
    var dd = get('SAMPLE/modern/tr/foto');
    var accent = CVPdf.ACCENTS.filter(function (a) { return JSON.stringify(dd.content[1]).indexOf(a) >= 0; })[0];
    var title = findNodes(dd.content, function (n) { return n.text === 'KIDEMLİ PROJE YÖNETİCİSİ'; });
    ok(title.length === 1 && title[0].node.characterSpacing === 0.7 && title[0].node.color === accent && title[0].node.bold && title[0].node.fontSize === 10, 'modern: ünvan büyük harf (Türkçe İ), 0.7 aralık, vurgu renginde');
    var name = findNodes(dd.content, function (n) { return n.text === 'Emre Aksoy'; })[0];
    ok(name && name.node.font === 'DMSerif' && name.node.fontSize === 30 && name.node.lineHeight === 1, 'modern: isim DMSerif 30pt');
    ok(textsOf(dd.content[0]).indexOf('Emre Aksoy') >= 0 && textsOf(dd.content[0]).indexOf('emre.aksoy@example.com') >= 0, 'modern: ilk düğüm başlık (ad + iletişim)');
    ok(Array.isArray(dd.content[1].canvas) && dd.content[1].canvas[0].lineWidth === 1 && Math.abs(dd.content[1].canvas[0].x2 - 515.28) < 0.01, 'modern: başlık altında tam genişlik 1pt çizgi');
    var cols = modernCols(dd);
    ok(cols && cols[0].width === MODERN_MAIN_W && Math.abs(cols[1].width - MODERN_SIDE_W) < 0.01, 'modern: iki sütun 310 + 183.28 (sabit genişlik)');
    var colRow = dd.content.filter(function (n) { return n.columns === cols; })[0];
    eq(colRow.columnGap, 22, 'modern: sütun arası 22pt');
    eq(findNodes(dd.content, function (n) { return Array.isArray(n.canvas) && n.canvas.length === 5; }).length, 0, 'modern: dil seviye çubuğu yok');
    eq(JSON.stringify(cols[1]).indexOf('"r":'), -1, 'modern: kenar çubuğunda yuvarlatılmış çubuk (seviye göstergesi) yok');
    var json = JSON.stringify(dd.content);
    ok(json.indexOf('"link":"mailto:emre.aksoy@example.com"') >= 0, 'modern: e-posta bağlantısı');
    ok(json.indexOf('"link":"https://linkedin.com/in/emre-aksoy-ornek"') >= 0, 'modern: web bağlantısı');
    eq(findNodes(cols[1], function (n) { return Array.isArray(n.ul); }).length, 0, 'modern: kenar çubuğunda madde imi yok (düz satırlar)');
    var mainUl = findNodes(cols[0], function (n) { return Array.isArray(n.ul); });
    ok(mainUl.length > 0 && mainUl.every(function (u) { return u.node.markerColor === accent && u.node.fontSize === 10; }), 'modern: ana sütun maddeleri vurgu renkli işaretli 10pt (§8 C8)');
    var heads = findNodes(cols[0], function (n) { return n.text === 'İŞ DENEYİMİ'; });
    ok(heads.length && heads[0].node.fontSize === 9.5 && heads[0].node.bold && heads[0].node.color === accent && heads[0].node.characterSpacing === 0.7, 'modern: ana başlık stili (9.5, 0.7)');
    var sideHead = findNodes(cols[1], function (n) { return n.text === 'YETENEKLER'; });
    ok(sideHead.length && sideHead[0].node.fontSize === 9 && sideHead[0].node.characterSpacing === 0.7, 'modern: kenar başlığı stili (9, 0.7)');
    var dates = findNodes(cols[0], function (n) { return n.width === 'auto' && n.fontSize === 9 && n.color === MUTED; });
    eq(dates.length, 5, 'modern: 3 iş + 2 eğitim tarihi sağda (9pt, §8 C8)');
    eq(findNodes(cols[1], function (n) { return /Mart 2021|Atlas Lojistik/.test(typeof n.text === 'string' ? n.text : ''); }).length, 0, 'modern: kenar çubuğunda unvan/şirket/tarih yok');
    var tint = dd.content.filter(function (n) { return Array.isArray(n.canvas) && n.canvas.length === 1 && n.canvas[0].h < 0; })[0];
    ok(tint && tint.canvas[0].color === CVPdf.mix(accent, '#ffffff', 0.9) && tint.canvas[0].x === MODERN_TINT_X - 40 &&
      Math.abs(tint.canvas[0].x + 40 + tint.canvas[0].w - A4.width) < 0.01 && tint.canvas[0].y + tint.canvas[0].h <= 0,
      'modern: 1. sayfa zemini başlığın altından sayfa sonuna (akışta yükseklik 0)');
    ok(dd.content.indexOf(tint) < dd.content.indexOf(colRow), 'modern: zemin sütunlardan önce çizilir');
  })();

  // Modern fotoğraf: cv.photo SVG ile yuvarlak kırpılır (photoRound artık kullanılmaz); showPhoto=false foto yok.
  (function () {
    var cv = clone(SAMPLE); cv.photo = JPG;
    function svgOf(dd) { return findNodes(dd.content, function (n) { return n.svg !== undefined; }); }
    var a = CVPdf.build(cv, { template: 'modern', showPhoto: true, photoRound: '' });
    ok(svgOf(a).length === 1 && svgOf(a)[0].node.svg.indexOf(JPG) >= 0 && svgOf(a)[0].node.width === 84, 'modern: photoRound yoksa da yuvarlak (SVG, 84pt)');
    var b = CVPdf.build(cv, { template: 'modern', showPhoto: true, photoRound: PNG });
    ok(svgOf(b).length === 1 && svgOf(b)[0].node.svg.indexOf(JPG) >= 0 && JSON.stringify(b).indexOf(PNG) < 0, 'modern: photoRound verilse de asıl fotoğraf kırpılır');
    eq(svgOf(CVPdf.build(cv, { template: 'modern', showPhoto: false })).length, 0, 'modern: showPhoto=false foto yok');
    var c = CVPdf.build(SAMPLE, { template: 'modern', showPhoto: true, photoRound: PNG });
    eq(findNodes(c.content, function (n) { return n.image !== undefined || n.svg !== undefined; }).length, 0, 'modern: cv.photo boşsa photoRound da yok');
    var bad = clone(SAMPLE); bad.photo = 'https://ornek.com/foto.jpg';
    TEMPLATE_IDS.forEach(function (tpl) {
      eq(findNodes(CVPdf.build(bad, { template: tpl, showPhoto: true }).content, function (n) { return n.image !== undefined || n.svg !== undefined; }).length, 0, tpl + ': data URL olmayan foto yok sayılır');
    });
    var def = CVPdf.build(cv, { template: 'klasik' });
    eq(findNodes(def.content, function (n) { return n.image !== undefined; }).length, 1, 'klasik: showPhoto verilmezse varsayılan açık');
    eq(findNodes(CVPdf.build(cv, { template: 'sade' }).content, function (n) { return n.image !== undefined || n.svg !== undefined; }).length, 0, 'sade: hiçbir zaman fotoğraf yok');
  })();

  // Klasik
  (function () {
    var dd = get('STRESS/klasik/tr/foto');
    var accent = CVPdf.ACCENTS.filter(function (a) { return JSON.stringify(dd).indexOf(a) >= 0; })[0];
    var rule = findNodes(dd.content, function (n) { return Array.isArray(n.canvas) && n.canvas[0].lineWidth === 1.2; });
    ok(rule.length === 1 && rule[0].node.canvas[0].lineColor === accent && Math.abs(rule[0].node.canvas[0].x2 - 493.28) < 0.01, 'klasik: başlık altında 1.2pt vurgu çizgisi (v2 genişlik 493.28)');
    var title = findNodes(dd.content, function (n) { return n.text === STRESS.title; });
    ok(title.length === 1 && title[0].node.font === 'DMSerif' && title[0].node.italics === true && title[0].node.fontSize === 13, 'klasik: ünvan DMSerif italik 13pt');
    // v2: iletişim 9.5pt; tek satıra sığmayınca bağlantılar (Web, GitHub) ikinci satırda.
    var contact = findNodes(dd.content, function (n) { return Array.isArray(n.text) && n.text.some(function (x) { return /^mailto:/.test(x.link || ''); }); });
    ok(contact.length === 1 && contact[0].node.fontSize === 9.5 && nodeText(contact[0].node) === [STRESS.phone, STRESS.email, STRESS.city].join('  ·  ') + '\n' + [STRESS.web, STRESS.github].join('  ·  '),
      'klasik: iletişim "  ·  " ile, uzunsa bağlantılar ikinci satırda (GitHub en sonda)');
    var gutters = findNodes(dd.content, function (n) { return Array.isArray(n.columns) && n.columns[0].width === 92; });
    ok(gutters.length >= 9, 'klasik: bölümler 92pt başlık oluğuyla (v2)');
    var dd2 = get('SAMPLE/klasik/tr/fotosuz');
    var lines = allLines(dd2);
    ok(lines.indexOf('Türkçe — Ana dil') >= 0, 'klasik: "Türkçe — Ana dil"');
    ok(lines.indexOf('Doğum Yılı: 1991') >= 0, 'klasik: kişisel bilgi "Etiket: değer" (v2: Doğum Yılı)');
    ok(lines.some(function (l) { return l.indexOf('Proje planlama  ·  Risk yönetimi') === 0; }), 'klasik: yetenekler "  ·  " ile');
    ok(lines.indexOf(CVParse.splitList(SAMPLE.hobbies).join(', ')) >= 0, 'klasik: hobiler virgülle');
    // v2: "Sertifikalar" tek satır; iki satırlık oluk başlığı saha profilindeki "Belgeler ve Sertifikalar".
    var dd3 = CVPdf.build(SAMPLE, { template: 'klasik', profile: 'saha' });
    var certHead = findNodes(dd3.content, function (n) { return n.text === 'BELGELER VE SERTİFİKALAR'; })[0];
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
        ok(colored.length === heads.length && colored.every(function (c) { return heads.indexOf(c.node.text) >= 0 && c.node.bold && c.node.fontSize === 10.5 && c.node.characterSpacing === 0; }), key + ': renkli metin yalnızca başlıklar (10.5pt, aralık 0)');
        ok(findNodes(dd.content, function (n) { return n.markerColor !== undefined; }).length === 0, key + ': renkli madde işareti yok');
        var nameNode = findNodes(dd.content, function (n) { return n.text === CVS[cvName].name; })[0];
        ok(nameNode && nameNode.node.bold && nameNode.node.fontSize === 22 && !nameNode.node.font, key + ': isim Roboto kalın 22pt (v2)');
        var lines = allLines(dd);
        ok(lines.some(function (l) { return l.indexOf(' | ') > 0 && l.indexOf('@') > 0; }), key + ': iletişim satırı');
      });
    });
    var lines = allLines(get('SAMPLE/sade/tr/foto'));
    ok(lines.indexOf('Atlas Lojistik A.Ş., İstanbul | 03/2021 – Günümüz') >= 0, 'sade: şirket, şehir | sayısal tarih tek satırda (v2)');
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
      return findNodes(dd.content, function (n) { return n.characterSpacing === 0.7 && n.fontSize === 10; })[0].node.text; // v2: aralık 0.7
    }
    eq(titleOf('Kıdemli Muhasebe Uzmanı', 'tr'), 'KIDEMLİ MUHASEBE UZMANI', 'ünvan: Türkçe büyük harf');
    eq(titleOf('Mimar', 'tr'), 'MİMAR', 'ünvan: ASCII Türkçe → İ');
    eq(titleOf('Software Engineer', 'tr'), 'SOFTWARE ENGINEER', 'ünvan: İngilizce ünvan → I');
    eq(titleOf('Diyetisyen', 'en'), 'DIYETISYEN', 'ünvan: en CV → İngilizce kural (Türkçe harf yoksa)');
    eq(titleOf('İç Mimar', 'en'), 'İÇ MİMAR', 'ünvan: Türkçe harf varsa her dilde Türkçe kural');
  })();

  // Seçenek doğrulama
  (function () {
    // v2: bilinmeyen şablon → klasik (varsayılan ve yedek); vurgu, klasik başlık çizgisinin renginden okunur.
    function ruleColor(d) { return findNodes(d.content, function (n) { return Array.isArray(n.canvas) && n.canvas[0].lineWidth === 1.2; })[0].node.canvas[0].lineColor; }
    var dd = CVPdf.build(SAMPLE, { template: 'yok', accent: 'kırmızı', lang: 'de' });
    same(dd.pageMargins, MARGINS.klasik, 'bilinmeyen şablon → klasik');
    eq(ruleColor(dd), '#1F5C4A', 'geçersiz vurgu → varsayılan');
    ok(allLines(dd).indexOf('İŞ DENEYİMİ') >= 0, 'bilinmeyen dil → tr');
    eq(ruleColor(CVPdf.build(SAMPLE, { accent: '#abc' })), '#aabbcc', '3 haneli vurgu genişletilir');
    eq(ruleColor(CVPdf.build(SAMPLE, { accent: '#23395B' })), '#23395B', 'geçerli vurgu aynen');
    same(CVPdf.build(SAMPLE).pageMargins, MARGINS.klasik, 'şablon verilmezse klasik');
    eq(CVPdf.build(SAMPLE, { template: 'modern', accent: '#abc' }).background(2, A4).canvas[0].color, CVPdf.mix('#aabbcc', '#ffffff', 0.9), 'modern: zemin vurgunun %10 tonu');
    var sadeHead = findNodes(CVPdf.build(SAMPLE, { template: 'sade' }).content, function (n) { return n.text === 'PROFİL'; })[0];
    eq(sadeHead.node.color, '#23395B', 'sade: vurgu verilmezse lacivert (brief §4.3)');
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
      { langs: 'ana dil, c1', skills: ',,, ;;', hobbies: ' ve ' },
      { projects: 'proje', github: 42 },
      { projects: [null, 7, 'x', [], {}, { name: 5, desc: ['a'], tech: null, link: { a: 1 } }, { link: 'https://', tech: 'Go' }], github: '   ' },
      { github: 'https://', projects: [{ name: 'Ad', link: 'http://' }, { desc: '•\n-\n1.' }] }
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
    a.content[0].stack[0].text = 'değişti';
    eq(CVPdf.build(SAMPLE, { template: 'modern' }).content[0].stack[0].text, 'Emre Aksoy', 'önceki çıktıyı değiştirmek sonrakini etkilemez');
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
        ok(findNodes(modernCols(dd)[1], function (n) { return n.unbreakable === true; }).every(function (u) { return textsOf(u.node).join('').length <= 1200; }), 'modern: kenar çubuğundaki bölünmez bloklar dar sütuna göre kısa');
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
  /*
   * pdfmake DocMeasure'ın _minWidth'inin cömert tahmini: en uzun bölünmez sözcük + yatay boşluklar.
   * Sözcükler yalnızca boşluktan bölünür (pdfmake/UAX#14 "Python,FastAPI" gibi virgüllü dizileri de
   * bölmez); satır içi parçalar birleşik tek metin sayılır (aralarında boşluk yoksa sözcük birleşir).
   */
  function minWidthOf(node, st) {
    if (typeof node === 'string') node = { text: node };
    if (!node || typeof node !== 'object') return 0;
    var fs = node.fontSize || st.fontSize;
    var s = { fontSize: fs, lineHeight: st.lineHeight, bold: node.bold !== undefined ? node.bold : st.bold };
    var m = Array.isArray(node.margin) ? node.margin : [0, 0, 0, 0];
    var w = 0;
    if (node.columns) {
      node.columns.forEach(function (c) { w += typeof c.width === 'number' ? c.width : minWidthOf(c, s); });
      w += (node.columnGap || 0) * (node.columns.length - 1);
    } else if (node.stack) {
      node.stack.forEach(function (c) { w = Math.max(w, minWidthOf(c, s)); });
    } else if (node.ul) {
      node.ul.forEach(function (c) { w = Math.max(w, minWidthOf(c, s) + 1.2 * fs); });
    } else if (node.canvas) {
      node.canvas.forEach(function (v) { w = Math.max(w, v.type === 'rect' ? v.x + v.w : Math.max(v.x1, v.x2)); });
    } else if (node.image) {
      w = node.fit ? node.fit[0] : 0;
    } else if (node.text !== undefined) {
      var full = nodeText(node);
      if (node.noWrap) w = estStr(full, fs);
      else full.split(/\s+/).forEach(function (t) { w = Math.max(w, estStr(t, fs) * (s.bold ? 1.04 : 1)); });
    }
    return w + m[0] + m[2];
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
      // ColumnCalculator 1. durum: '*'/'auto' sütunların en küçük genişlikleri (en uzun bölünmez sözcük)
      // kalan alana sığmazsa '*' sütun o sözcük kadar genişler ve sütundaki TÜM satırlar sayfadan taşar.
      // Sabit genişlikli sütunda pdfmake uzun sözcüğü satır sonunda keser; taşma olmaz.
      var starMaxMin = 0, autoMin = 0;
      node.columns.forEach(function (c) {
        if (c.width === '*' || c.width === undefined) starMaxMin = Math.max(starMaxMin, minWidthOf(c, st));
        else if (c.width === 'auto') autoMin += minWidthOf(c, st);
      });
      if (autoMin + starMaxMin * stars > inner - fixed - gap * (node.columns.length - 1) + 0.01) {
        problems.push("'*'/'auto' sütunların en küçük genişliği sığmıyor (" + Math.round(autoMin + starMaxMin * stars) + ' > ' +
          Math.round(inner - fixed - gap * (node.columns.length - 1)) + '): pdfmake sütunu sayfadan taşırır @ ' + path);
      }
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
        if (v.type === 'rect' && fin(v.h) && v.h < 0) {
          // v2 modern: 1. sayfanın kenar çubuğu zemini — akışta yüksekliği 0 olan bant (y + h ≤ 0: pdfmake
          // tuvali 0 yükseklikte ölçer, sayfa atlatmaz); sağ kenara kadar taşması tasarım gereği (sol kenar 40pt).
          if (!['x', 'y', 'w'].every(function (k) { return fin(v[k]); }) || v.w <= 0 || v.x < 0 || v.y + v.h > 0) problems.push('zemin bandı ölçüsü geçersiz @ ' + vp);
          if (!v.color) problems.push('zemin bandı rengi yok @ ' + vp);
          if (v.x + v.w > A4.width - 40 + 0.01) problems.push('zemin bandı sayfadan taşar @ ' + vp);
        } else if (v.type === 'rect') {
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

  var PAGE_H = { modern: A4.height - 80, klasik: A4.height - 93, sade: A4.height - 93 };
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
        // v2 modern: 1. sayfada zemin akışta (background yok); bölümsüz CV'de hiç zemin yok.
        if (!bg) { if (p > 1 && modernCols(dd)) problems.push('background(' + p + ') boş'); continue; }
        audit(bg, A4.width, '$.background(' + p + ')', { unbreakable: false, inColumns: false, st: st }, problems, []);
      }
    }
    if (dd.footer(1, 3) !== null) problems.push('1. sayfada footer olmamalı (v2)');
    for (var q = 2; q <= 3; q++) {
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
      'eğitim notu ≈2000': { edu: [{ id: 'e', school: 'Okul', program: 'Bölüm', degree: 'Lisans', start: '2010', end: '2014', note: words(250, 'notlar') }] },
      'proje ilk maddesi ≈2550': { projects: [{ id: 'p', name: 'Proje', tech: 'Python', link: 'github.com/a/b', desc: words(425, 'süreç') + '\nikinci madde' }] },
      'proje teknolojileri ≈1100': { projects: [{ id: 'p', name: 'Proje', tech: items(100, 'Teknoloji'), link: 'github.com/a/b', desc: 'Kısa madde.' }] },
      'proje adı ≈1300': { projects: [{ id: 'p', name: words(130, 'Envanter'), tech: '', link: '', desc: 'Kısa madde.\nİkinci madde.' }] },
      '12 proje': { projects: (function () {
        var a = [];
        for (var i = 0; i < 12; i++) a.push({ id: 'p' + i, name: 'Proje ' + i, tech: 'Go, gRPC', link: 'github.com/ali/proje-' + i, desc: words(30, 'geliştirdim') + '\n' + words(30, 'yazdım') + '\n' + words(30, 'test') });
        return a;
      })() }
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
      var dates = findNodes(dd.content, function (n) { return n.width === 'auto' && n.fontSize === 9; }); // v2: tarih 9pt
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

  // Modern dil satırı (v2): çubuk yok; ad Medium, altında seviye metni. Çok uzun tek kelimeli dil adı sütundan taşmaz.
  (function () {
    var dd = get('SAMPLE/modern/en/foto');
    var side = modernCols(dd)[1];
    ok(findNodes(side, function (n) { return n.text === 'English' && n.bold; }).length === 1 &&
      findNodes(side, function (n) { return n.text === 'C1 (Advanced) · IELTS 7.0 (2023)'; }).length === 1, 'modern: dil adı ve altında CEFR + sınav');
    eq(findNodes(side, function (n) { return n.width === 'auto'; }).length, 0, 'modern: dil satırında sütun yok');
    var cv = { langs: 'Brezilyaportekizcesiveyerelağızları ileri, Portekizce iyi, İşaret dili orta' };
    var d2 = CVPdf.build(cv, { template: 'modern', lang: 'en' });
    auditDoc(d2, 'modern', 'modern: uzun dil adı');
    ok(allLines(d2).indexOf('Advanced') >= 0 && allLines(d2).indexOf('Upper-intermediate') >= 0, 'modern: seviye metinleri görünür');
    eq(findNodes(d2.content, function (n) { return Array.isArray(n.canvas) && n.canvas.length === 5; }).length, 0, 'modern: seviye çubuğu yok');
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
    // v2: modern, photoRound yerine cv.photo'yu SVG ile yuvarlak kırpar (3:4 ve kare fotoğrafın ikisinde de ortadan).
    function modernSvg(photo, round) {
      var dd = CVPdf.build({ name: 'Foto', photo: photo }, { template: 'modern', showPhoto: true, photoRound: round || '' });
      var sv = findNodes(dd.content, function (n) { return n.svg !== undefined; });
      return sv.length ? sv[0].node.svg : '';
    }
    ok(modernSvg(JPG, 'data:image/png;base64,' + JPG_DATA).indexOf('xlink:href="' + JPG + '"') >= 0, 'modern: JPEG baytlı photoRound yok sayılır, asıl foto kırpılır');
    ok(modernSvg('data:image/JPEG;base64,' + JPG_DATA, PNG).indexOf('xlink:href="data:image/jpeg;base64,' + JPG_DATA + '"') >= 0, 'modern: büyük harfli önek SVG içinde de küçültülür');
    eq(modernSvg('data:image/png;base64,UklGRhYAAABXRUJQVlA4', PNG), '', 'modern: basılamayan foto → SVG yok (photoRound tek başına kullanılmaz)');
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
      // v2 (brief §4.5): sütunlar [ana, kenar çubuğu]; Sertifikalar kenar çubuğunda; İletişim bölümü yok (başlıkta).
      var sideHeads = ['skills', 'languages', 'certs', 'personal', 'hobbies'].map(U);
      var mainHeads = ['profile', 'experience', 'projects', 'education', 'refs'].map(U);
      same(order(modernCols(dd)[1], sideHeads.concat(mainHeads)), sideHeads, 'modern/' + lang + ': kenar çubuğu sırası');
      same(order(modernCols(dd)[0], sideHeads.concat(mainHeads)), mainHeads, 'modern/' + lang + ': ana sütun sırası');
    });
    var only = {
      summary: ['profile', 'Kısa özet.'], skills: ['skills', 'Excel'], langs: ['languages', 'İngilizce ileri'],
      certs: ['certs', 'PMP (2020)'], hobbies: ['hobbies', 'Satranç'], refs: ['refs', 'Ali Veli — Müdür'],
      birth: ['personal', '1990'], phone: ['contact', '0532 111 22 33'],
      jobs: ['experience', [{ id: 'j', role: 'Uzman', company: '', city: '', start: '', end: '', desc: '' }]],
      edu: ['education', [{ id: 'e', school: 'Okul', program: '', degree: '', start: '', end: '', note: '' }]],
      projects: ['projects', [{ id: 'p', name: 'Stok Takip', tech: '', link: '', desc: '' }]],
      github: ['contact', 'github.com/ali']
    };
    var allKeys = ['contact', 'profile', 'experience', 'projects', 'education', 'skills', 'languages', 'certs', 'hobbies', 'refs', 'personal'];
    Object.keys(only).forEach(function (field) {
      TEMPLATE_IDS.forEach(function (tpl) {
        var cv = clone(EMPTY); cv[field] = only[field][1];
        var dd = CVPdf.build(cv, { template: tpl });
        var L = CVPdf.labels('tr');
        var shown = allKeys.filter(function (k) { return allLines(dd).indexOf(trUpper(L[k])) >= 0; });
        var expect = (field === 'phone' || field === 'github') ? [] : [only[field][0]]; // v2: iletişim her şablonda başlıkta
        same(shown, expect, tpl + ': yalnızca ' + field + ' → yalnızca o bölüm');
      });
    });
  })();

  // Modern: kenar çubuğu her sayfada; ana sütun ve altbilgi kenar çubuğunun sağında.
  (function () {
    // v2: 1. sayfada zemin akışta (başlığın altından), 2.–6. sayfalarda background() tam yükseklikte.
    var dd = get('STRESS/modern/tr/foto');
    var ok5 = dd.background(1, A4) === null;
    for (var p = 2; p <= 6; p++) {
      var bg = dd.background(p, { width: A4.width, height: A4.height });
      ok5 = ok5 && bg && bg.canvas.length === 1 && bg.canvas[0].x === MODERN_TINT_X && bg.canvas[0].y === 0 && Math.abs(bg.canvas[0].x + bg.canvas[0].w - A4.width) < 0.01 && bg.canvas[0].h === A4.height;
    }
    ok(ok5, 'modern: kenar çubuğu zemini 2–6. sayfalarda tam yükseklik, sağ kenara kadar');
    var cols = modernCols(dd);
    ok(cols[0].width === MODERN_MAIN_W && 40 + MODERN_MAIN_W + 22 > MODERN_TINT_X && 40 + MODERN_MAIN_W < MODERN_TINT_X, 'modern: ana sütun zeminin solunda biter, kenar çubuğu metni zeminin içinde başlar');
    same(dd.footer(2, 3).margin, [40, 14, A4.width - 40 - MODERN_MAIN_W, 0], 'modern: altbilgi ana sütunun kutusunda');
    // kenar çubuğundaki metin zeminin üzerinde okunur olmalı (WCAG AA 4.5:1), açık ve koyu kenar çubuğu
    function lum(hex) {
      var c = [1, 3, 5].map(function (i) { var v = parseInt(hex.substr(i, 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }
    function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
    CVPdf.ACCENTS.forEach(function (accent) {
      ['light', 'dark'].forEach(function (mode) {
        var d = CVPdf.build(CVPdf.SAMPLES.yazilim, { template: 'modern', accent: accent, sidebar: mode });
        var tint = d.background(2, A4) ? d.background(2, A4).canvas[0].color : '';
        eq(tint.toLowerCase(), mode === 'dark' ? accent.toLowerCase() : CVPdf.mix(accent, '#ffffff', 0.9), 'modern ' + accent + '/' + mode + ': zemin rengi');
        var worst = 99;
        walk(modernCols(d)[1], function (v) {
          if (v && typeof v === 'object' && typeof v.color === 'string' && (v.text !== undefined || v.ul !== undefined)) worst = Math.min(worst, contrast(v.color, tint));
        });
        ok(worst >= 4.5, 'modern ' + accent + '/' + mode + ': kenar çubuğu metin kontrastı ≥ 4.5 (' + worst.toFixed(2) + ')');
      });
      var main = [];
      walk(modernCols(CVPdf.build(SAMPLE, { template: 'modern', accent: accent }))[0], function (v) { if (v && typeof v === 'object' && typeof v.color === 'string' && v.text !== undefined) main.push(contrast(v.color, '#ffffff')); });
      ok(Math.min.apply(null, main) >= 4.5, 'modern ' + accent + ': ana sütun metin kontrastı ≥ 4.5');
    });
  })();

  /* ============================================ projeler ve GitHub (SPEC v2 §5) */

  print('# projeler ve GitHub');
  (function () {
    var ACC = '#7A2E3A';
    function U(lang, k) { var L = CVPdf.labels(lang); return lang === 'en' ? L[k].toUpperCase() : trUpper(L[k]); }
    function linksOf(x) {
      var out = [];
      walk(x, function (v) { if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.link === 'string') out.push(v); });
      return out;
    }
    function headsIn(dd, keys, lang) {
      var hs = keys.map(function (k) { return U(lang, k); }), seen = [];
      walk(dd.content, function (v) { if (v && typeof v === 'object' && hs.indexOf(v.text) >= 0) seen.push(v.text); });
      return seen;
    }

    // Örnek CV: her şablon × dil
    TEMPLATE_IDS.forEach(function (tpl) {
      ['tr', 'en'].forEach(function (lang) {
        var key = 'proje/' + tpl + '/' + lang;
        var dd = CVPdf.build(SAMPLE, { template: tpl, lang: lang, accent: ACC });
        same(headsIn(dd, ['experience', 'projects', 'education'], lang), [U(lang, 'experience'), U(lang, 'projects'), U(lang, 'education')],
          key + ': Projeler bir kez, İş Deneyimi ile Eğitim arasında');
        var ph = findNodes(dd.content, function (n) { return n.text === U(lang, 'projects'); });
        if (ph.length) {
          var styleRef = findNodes(dd.content, function (n) { return n.text === U(lang, 'experience'); })[0].node;
          ok(ph[0].node.fontSize === styleRef.fontSize && ph[0].node.color === styleRef.color && ph[0].node.bold === styleRef.bold &&
            ph[0].node.characterSpacing === styleRef.characterSpacing, key + ': Projeler başlığı İş Deneyimi başlığıyla aynı stilde');
        }

        SAMPLE.projects.forEach(function (pr) {
          var bullets = CVParse.splitLines(pr.desc);
          var names = findNodes(dd.content, function (n) { return n.text === pr.name; });
          eq(names.length, 1, key + ': "' + pr.name + '" bir kez');
          if (!names.length) return;
          var nm = names[0].node;
          ok(nm.bold === true && nm.color === INK && nm.fontSize === 10.5, key + ': proje adı iş ünvanı stilinde (kalın, INK, v2: 10.5)');
          var u = nearestUnbreakable(names[0].anc), t = u ? textsOf(u) : [];
          ok(t.indexOf(bullets[0]) >= 0 && t.indexOf(bullets[1]) < 0, key + ': ' + pr.name + ' — ad + alt satır + ilk madde bölünmez, ikinci madde dışarıda');
          ok(t.indexOf(pr.link) >= 0 && t.indexOf(pr.tech) >= 0, key + ': alt satır adla aynı bölünmez blokta');
          var all = textsOf(dd.content);
          ok(bullets.every(function (b) { return all.indexOf(b) >= 0; }), key + ': tüm proje maddeleri var');

          var subs = findNodes(dd.content, function (n) { return Array.isArray(n.text) && nodeText(n) === pr.tech + ' · ' + pr.link; });
          eq(subs.length, 1, key + ': alt satır "teknolojiler · bağlantı"');
          if (!subs.length) return;
          var sn = subs[0].node;
          eq(sn.color, tpl === 'modern' ? CVPdf.mix(ACC, INK, 0.3) : MUTED, key + ': alt satır rengi (modern vurgu tonu, diğerleri MUTED)');
          eq(sn.fontSize, tpl === 'modern' ? 9 : 9.5, key + ': alt satır 9pt (modern) / 9.5pt (v2 klasik, sade)');
          same(sn.text.map(function (x) { return x.text; }), [pr.tech, ' · ', pr.link], key + ': alt satır parçaları');
          eq(sn.text[2].link, 'https://' + pr.link, key + ': bağlantı https:// ile tıklanabilir, protokolsüz görünür');
          ok(sn.text[0].link === undefined && sn.text[1].link === undefined, key + ': yalnızca bağlantı parçası tıklanabilir');
          ok(sn.text.every(function (x) { return x.color === undefined; }), key + ': parçalar satır rengini miras alır');
          ok(nearestUnbreakable(names[0].anc) === nearestUnbreakable(subs[0].anc), key + ': alt satır ve ad aynı blokta');
        });
        // Bölüm madde işaretleri iş deneyimiyle aynı
        var pBul = findNodes(dd.content, function (n) { return Array.isArray(n.ul) && n.ul.some(function (b) { return b.text === CVParse.splitLines(SAMPLE.projects[0].desc)[0]; }); });
        var jBul = findNodes(dd.content, function (n) { return Array.isArray(n.ul) && n.ul.some(function (b) { return b.text === CVParse.splitLines(SAMPLE.jobs[0].desc)[0]; }); });
        ok(pBul.length === 1 && jBul.length === 1 && pBul[0].node.fontSize === jBul[0].node.fontSize && pBul[0].node.markerColor === jBul[0].node.markerColor,
          key + ': proje maddeleri iş maddeleriyle aynı stilde');

        // GitHub iletişim girdisi: Web'den hemen sonra, https:// bağlantılı, protokolsüz görünür
        var links = linksOf(dd.content).map(function (n) { return n.link; });
        var wi = links.indexOf('https://linkedin.com/in/emre-aksoy-ornek'), gi = links.indexOf('https://github.com/emreaksoy-ornek');
        ok(wi >= 0 && gi === wi + 1, key + ": GitHub bağlantısı Web'den hemen sonra");
        var gh = linksOf(dd.content).filter(function (n) { return n.link === 'https://github.com/emreaksoy-ornek'; });
        ok(gh.length === 1 && gh[0].text === 'github.com/emreaksoy-ornek', key + ': GitHub değeri protokolsüz görünür');
        ok(JSON.stringify(dd).indexOf('GİTHUB') < 0, key + ': "GİTHUB" (Türkçe büyük harf) yok');
        // v2: her şablonda (modern dahil) iletişim başlıkta; GitHub iletişim satırının sonunda.
        var line = findNodes(dd.content, function (n) { return Array.isArray(n.text) && n.text.some(function (x) { return x.link === 'mailto:emre.aksoy@example.com'; }); });
        ok(line.length === 1 && line[0].node.text[line[0].node.text.length - 1].link === 'https://github.com/emreaksoy-ornek', key + ': GitHub başlıktaki iletişim satırının sonunda');
        if (tpl === 'modern') eq(findNodes(modernCols(dd)[1], function (n) { return typeof n.link === 'string'; }).length, 0, key + ': kenar çubuğunda iletişim yok');
        auditDoc(dd, tpl, key);
      });
    });

    // Boş projeler atlanır; bölüm yalnızca basılacak proje varsa
    var EMPTY_PROJ = { name: 'Boş Proje', projects: [
      { id: 'a', name: '', tech: 'Python', link: 'github.com/bos/depo', desc: '' },
      { id: 'b', name: '  ', tech: '', link: '', desc: ' \n • \n' },
      { id: 'c' }, null, 'Proje', 42, []
    ] };
    TEMPLATE_IDS.forEach(function (tpl) {
      ['tr', 'en'].forEach(function (lang) {
        var key = 'boş proje/' + tpl + '/' + lang;
        var dd = CVPdf.build(EMPTY_PROJ, { template: tpl, lang: lang });
        validateTree(dd, key, true);
        auditDoc(dd, tpl, key);
        var lines = allLines(dd);
        ok(lines.indexOf(U('tr', 'projects')) < 0 && lines.indexOf(U('en', 'projects')) < 0, key + ': Projeler başlığı yok');
        ok(JSON.stringify(dd).indexOf('github.com/bos') < 0, key + ': adsız/açıklamasız projenin bağlantısı basılmaz');
        same(lines.filter(function (l) { return l.trim() !== ''; }), ['Boş Proje'], key + ': yalnızca isim görünür');
      });
    });
    // hasContent, iş/eğitimde olduğu gibi CVParse'a bağlı değil: yalnızca "•" içeren açıklama (id 'b') ham metin
    // olarak dolu sayılır; build bunu basmaz. Bu küçük fark bilerek kabul edildi.
    eq(CVPdf.hasContent({ projects: EMPTY_PROJ.projects.filter(function (x) { return !(x && x.id === 'b'); }) }), false, 'hasContent: yalnızca boş projeler içerik değil');

    // Karışık: geçerli projeler sırasıyla kalır, boşlar düşer
    (function () {
      var cv = { projects: [
        { id: '1', name: 'Birinci', tech: '', link: '', desc: '' },
        { id: '2', name: '', tech: 'Rust', link: '', desc: '' },
        { id: '3', name: '', tech: 'Go', link: 'github.com/ali/cli', desc: '• Komut satırı aracı yazdım.\n- Testlerini yazdım.' },
        { id: '4', name: 'Dördüncü', tech: 'Swift', link: '', desc: '' }
      ] };
      TEMPLATE_IDS.forEach(function (tpl) {
        var dd = CVPdf.build(cv, { template: tpl });
        auditDoc(dd, tpl, 'karışık proje/' + tpl);
        var lines = allLines(dd).filter(function (l) { return l.trim() !== ''; });
        ok(lines.indexOf('Birinci') >= 0 && lines.indexOf('Dördüncü') >= 0 && lines.indexOf('Birinci') < lines.indexOf('Dördüncü'), tpl + ': projeler veri sırasında');
        ok(lines.indexOf('Rust') < 0, tpl + ': yalnızca teknolojisi olan proje atlanır');
        ok(lines.indexOf('Go · github.com/ali/cli') >= 0, tpl + ': adsız proje alt satırla başlar');
        var texts = textsOf(dd.content);
        ok(texts.indexOf('Komut satırı aracı yazdım.') >= 0 && texts.indexOf('Testlerini yazdım.') >= 0, tpl + ': madde işaretleri temizlenir');
        ok(lines.indexOf('Swift') >= 0, tpl + ': yalnızca teknoloji alt satırı düz metin');
        eq(findNodes(dd.content, function (n) { return n.text === 'Swift'; })[0].node.link, undefined, tpl + ': bağlantısız alt satır tıklanamaz');
        var head = findNodes(dd.content, function (n) { return n.text === 'PROJELER'; })[0];
        var u = head && nearestUnbreakable(head.anc);
        ok(u && textsOf(u).indexOf('Birinci') >= 0, tpl + ': başlık ilk projeyle bölünmez');
        // adsız proje: alt satır + ilk madde birlikte, ikinci madde dışarıda
        var sub = findNodes(dd.content, function (n) { return Array.isArray(n.text) && nodeText(n) === 'Go · github.com/ali/cli'; })[0];
        var su = sub && nearestUnbreakable(sub.anc);
        ok(su && textsOf(su).indexOf('Komut satırı aracı yazdım.') >= 0 && textsOf(su).indexOf('Testlerini yazdım.') < 0, tpl + ': adsız projenin alt satırı ilk maddesiyle bölünmez');
        eq(findNodes(dd.content, function (n) { return n.text === 'Dördüncü'; })[0].node.bold, true, tpl + ': yalnız adlı proje kalın başlık');
      });
    })();

    // Bağlantı biçimleri: protokol tekrarlanmaz, boşluklar silinir, yalnızca bağlantı da olur
    (function () {
      function sub(link, tpl) {
        var dd = CVPdf.build({ projects: [{ id: 'p', name: 'P', tech: '', link: link, desc: '' }] }, { template: tpl || 'modern' });
        var n = linksOf(dd.content);
        return n.length ? { text: n[0].text, link: n[0].link, count: n.length } : null;
      }
      same(sub('https://github.com/ali/repo/'), { text: 'github.com/ali/repo', link: 'https://github.com/ali/repo/', count: 1 }, 'proje: https:// iki kez önek almaz, görünümde yok');
      same(sub('HTTP://Ornek.com/x'), { text: 'Ornek.com/x', link: 'HTTP://Ornek.com/x', count: 1 }, 'proje: büyük harfli protokol');
      same(sub('github.com/ ali / repo'), { text: 'github.com/ali/repo', link: 'https://github.com/ali/repo', count: 1 }, 'proje: dikte boşlukları silinir');
      eq(sub('https://'), null, 'proje: yalnızca protokol → bağlantı yok');
      eq(sub('   '), null, 'proje: boş bağlantı yok');
      TEMPLATE_IDS.forEach(function (tpl) {
        var dd = CVPdf.build({ projects: [{ id: 'p', name: 'P', tech: '', link: 'ornek.dev', desc: '' }] }, { template: tpl });
        var s = findNodes(dd.content, function (n) { return Array.isArray(n.text) && nodeText(n) === 'ornek.dev'; });
        ok(s.length === 1 && s[0].node.text.length === 1 && s[0].node.text[0].link === 'https://ornek.dev', tpl + ': yalnızca bağlantı → ayraçsız tek parça');
      });
      var sade = CVPdf.build(SAMPLE, { template: 'sade' });
      ok(allLines(sade).indexOf(SAMPLE.projects[0].tech + ' · ' + SAMPLE.projects[0].link) >= 0, 'sade: proje alt satırında " · " (tarih ayracı " | " yok)');
    })();

    // GitHub alanı biçimleri
    (function () {
      function gh(v, tpl, lang) {
        var dd = CVPdf.build({ name: 'G', github: v }, { template: tpl || 'modern', lang: lang || 'tr' });
        var n = linksOf(dd.content);
        return n.length ? { text: n[0].text, link: n[0].link } : null;
      }
      same(gh('emreaksoy'), { text: 'github.com/emreaksoy', link: 'https://github.com/emreaksoy' }, 'github: yalnızca kullanıcı adı tamamlanır');
      same(gh('@emre-aksoy'), { text: 'github.com/emre-aksoy', link: 'https://github.com/emre-aksoy' }, 'github: @kullanıcı tamamlanır');
      same(gh('https://github.com/ali/'), { text: 'github.com/ali', link: 'https://github.com/ali/' }, 'github: protokollü değer iki kez önek almaz');
      same(gh('github.com / ali'), { text: 'github.com/ali', link: 'https://github.com/ali' }, 'github: dikte boşlukları silinir');
      same(gh('gitlab.com/ali'), { text: 'gitlab.com/ali', link: 'https://gitlab.com/ali' }, 'github: alan adlı değer olduğu gibi');
      eq(gh('https://'), null, 'github: yalnızca protokol → girdi yok');
      TEMPLATE_IDS.forEach(function (tpl) {
        ['tr', 'en'].forEach(function (lang) {
          var dd = CVPdf.build({ github: 'github.com/ali' }, { template: tpl, lang: lang });
          auditDoc(dd, tpl, 'yalnız github/' + tpl + '/' + lang);
          eq(linksOf(dd.content).length, 1, tpl + '/' + lang + ': yalnızca GitHub → tek bağlantı');
          ok(allLines(dd).indexOf('github.com/ali') >= 0 && allLines(dd).indexOf(U(lang, 'contact')) < 0, tpl + '/' + lang + ': GitHub başlıkta, İletişim bölümü yok');
        });
      });
      var none = CVPdf.build({ name: 'G', github: 'https://' }, { template: 'modern' });
      ok(allLines(none).indexOf('GITHUB') < 0 && allLines(none).indexOf('İLETİŞİM') < 0, 'modern: boş GitHub → etiket ve İletişim bölümü yok');
    })();

    // Stres: tüm proje maddeleri, bloklar sınırda
    TEMPLATE_IDS.forEach(function (tpl) {
      var dd = get('STRESS/' + tpl + '/tr/foto');
      var texts = textsOf(dd.content), n = 0;
      STRESS.projects.forEach(function (pr) { CVParse.splitLines(pr.desc).forEach(function (b) { if (texts.indexOf(b) >= 0) n++; }); });
      eq(n, 24, tpl + ': stres 6 proje × 4 madde');
      ok(STRESS.projects.every(function (pr) { return texts.indexOf(pr.name) >= 0; }), tpl + ': stres proje adlarının hepsi');
    });
  })();

  /* ================================ projeler ve GitHub: çekişmeli inceleme (regresyonlar) */

  print('# projeler ve GitHub — inceleme');
  (function () {
    function U(lang, k) { var L = CVPdf.labels(lang); return lang === 'en' ? L[k].toUpperCase() : trUpper(L[k]); }
    function linksOf(x) {
      var out = [];
      walk(x, function (v) { if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.link === 'string') out.push(v); });
      return out;
    }
    function withProjects(projects, extra) {
      var cv = clone(SAMPLE);
      cv.projects = projects;
      for (var k in extra || {}) cv[k] = extra[k];
      return cv;
    }
    function each(fn) { TEMPLATE_IDS.forEach(function (tpl) { ['tr', 'en'].forEach(function (lang) { fn(tpl, lang, tpl + '/' + lang); }); }); }
    var SPACED = ['Python', 'Pandas', 'PowerBI', 'FastAPI', 'PostgreSQL', 'Redis', 'Kafka', 'Docker', 'Kubernetes', 'Terraform', 'GitHubActions'];
    var LONG_WORD = 'Gerçekzamanlıenvantervesiparişeşleştirmemotoruikincisürümdenemesiçokuzunad';
    var LONG_SEG = 'github.com/ali/' + new Array(9).join('envantermotoru');

    // HATA 1 — pdfmake ColumnCalculator 1. durum: '*' sütundaki tek bir uzun bölünmez sözcük (boşluksuz
    // virgüllü teknoloji listesi, tek sözcüklük ad, uzun bağlantı) sütunu o sözcük kadar genişletiyor ve
    // modern ana sütunun / klasik bölüm satırının TÜM satırları sayfanın sağından taşıyordu (gerçek
    // pdfmake 0.2.10 düzeninde ölçüldü: modern 23 satır, sağ kenar ≈627pt > 561pt). Sabit genişlikli sütunda
    // pdfmake sözcüğü satır sonunda keser.
    each(function (tpl, lang, key) {
      var cases = {
        'boşluksuz teknoloji listesi': withProjects([{ id: 'p', name: 'Depo Aracı', tech: SPACED.join(','), link: 'github.com/ali/depo', desc: 'Madde.' }]),
        'tek sözcük proje adı': withProjects([{ id: 'p', name: LONG_WORD, tech: 'Go', link: '', desc: 'Madde.' }]),
        'uzun bağlantı parçası': withProjects([{ id: 'p', name: 'Bağlantı', tech: '', link: LONG_SEG, desc: 'Madde.' }]),
        'tek sözcük teknoloji': withProjects([{ id: 'p', name: 'P', tech: LONG_WORD.toLowerCase(), link: '', desc: '' }]),
        // klasik: fotoğraflı başlıkta iletişim satırı (GitHub en sonda) '*' sütundaydı
        'uzun GitHub adresi + foto': withProjects([], { photo: JPG, github: 'github.com/' + new Array(8).join('cokuzunkullaniciadi') })
      };
      Object.keys(cases).forEach(function (name) {
        var dd = CVPdf.build(cases[name], { template: tpl, lang: lang });
        auditDoc(dd, tpl, 'uzun sözcük: ' + name + '/' + key);
        validateTree(dd, 'uzun sözcük: ' + name + '/' + key, true);
      });
    });
    // Metin sütunları sabit genişlikli; toplamları kullanılabilir genişliğe eşit (görünüm değişmez).
    (function () {
      var m = modernCols(CVPdf.build(SAMPLE, { template: 'modern' }));
      ok(typeof m[0].width === 'number' && typeof m[1].width === 'number' && Math.abs(m[0].width + m[1].width + 22 - (A4.width - 80)) < 0.01, 'modern: iki sütun da sabit genişlikli (v2: 310 + 22 + 183.28)');
      var mp = clone(SAMPLE); mp.photo = JPG;
      var mh = CVPdf.build(mp, { template: 'modern' }).content[0];
      ok(mh.columns && mh.columns.every(function (c) { return typeof c.width === 'number'; }) && Math.abs(mh.columns[0].width + mh.columns[1].width + mh.columnGap - (A4.width - 80)) < 0.01, 'modern: fotoğraflı başlık sabit genişlikli');
      var k = CVPdf.build(clone(SAMPLE), { template: 'klasik', showPhoto: true });
      var rows = findNodes(k.content, function (n) { return Array.isArray(n.columns); });
      ok(rows.length > 0 && rows.every(function (r) {
        return r.node.columns.every(function (c) { return typeof c.width === 'number'; }) ||
          r.node.columns.some(function (c) { return c.width === 'auto'; }); // ünvan/tarih satırı: sideBySide korumalı
      }), "klasik: bölüm satırlarında '*' sütun yok (yalnızca korumalı ünvan/tarih satırı)");
      var kp = CVPdf.build(withProjects([], { photo: JPG }), { template: 'klasik' }).content[0];
      ok(kp.columns && kp.columns.every(function (c) { return typeof c.width === 'number'; }) &&
        Math.abs(kp.columns[0].width + kp.columns[1].width + kp.columnGap - (A4.width - 102)) < 0.01, 'klasik: fotoğraflı başlık sabit genişlikli (v2 kenar 51)');
    })();

    // HATA 2 — boşluksuz virgüllü teknoloji listesi ("Python,FastAPI") satır sonunda sözcük ortasından
    // kesiliyordu (UAX#14 virgül+harf arasında kırmaz). Virgülden sonra tek boşluk; ondalık "2,7" korunur.
    (function () {
      function techLine(tech, tpl) {
        var dd = CVPdf.build({ projects: [{ id: 'p', name: 'P', tech: tech, link: '', desc: '' }] }, { template: tpl || 'modern' });
        // v2: Türkçedeki "Referanslar talep üzerine iletilir." kapanış satırı alt satır sayılmaz.
        var l = allLines(dd).filter(function (x) { return x !== 'P' && x.trim() !== '' && x !== 'PROJELER' && x !== CVPdf.labels('tr').refsLine; });
        return l.length ? l[0] : null;
      }
      eq(techLine(SPACED.join(',')), SPACED.join(', '), 'teknoloji: virgülden sonra boşluk eklenir');
      eq(techLine('Python ,FastAPI ,  PostgreSQL'), 'Python, FastAPI, PostgreSQL', 'teknoloji: virgül çevresi düzenlenir');
      eq(techLine('Vue 2,7, Nuxt'), 'Vue 2,7, Nuxt', 'teknoloji: ondalık virgül korunur');
      eq(techLine(',Go,,Rust,'), 'Go, Rust', 'teknoloji: boş öğeler ve uçtaki virgüller atılır');
      eq(techLine(' , ,'), null, 'teknoloji: yalnızca virgül → alt satır yok');
      eq(techLine('C#,.NET,C++'), 'C#, .NET, C++', 'teknoloji: noktalı/simgeli adlar');
      TEMPLATE_IDS.forEach(function (tpl) {
        eq(techLine('Go,gRPC', tpl), 'Go, gRPC', tpl + ': teknoloji düzeni her şablonda');
      });
      // SAMPLE ve zaten düzgün listeler aynen kalır
      SAMPLE.projects.forEach(function (pr) { eq(techLine(pr.tech), pr.tech, 'teknoloji: düzgün liste değişmez (' + pr.tech + ')'); });
    })();

    // HATA 3 — Web ve GitHub aynı adresse iletişimde iki kez görünüyordu. GitHub girdisi kalır (etiketi daha
    // açıklayıcı), Web düşer. Karşılaştırma protokol, "www.", sondaki "/" ve büyük/küçük harften bağımsız.
    each(function (tpl, lang, key) {
      [
        { web: 'https://www.github.com/ali/', github: 'github.com/ali' },
        { web: 'GitHub.com/Ali', github: 'ali' },
        { web: 'http://github.com/ali', github: '@ali' }
      ].forEach(function (c, i) {
        var dd = CVPdf.build({ name: 'A', web: c.web, github: c.github }, { template: tpl, lang: lang });
        var links = linksOf(dd.content).map(function (n) { return n.link; });
        same(links, ['https://github.com/ali'], key + ': aynı Web/GitHub tek girdi (' + i + ')');
      });
      var both = CVPdf.build({ name: 'A', web: 'ali.dev', github: 'github.com/ali' }, { template: tpl, lang: lang });
      same(linksOf(both.content).map(function (n) { return n.link; }), ['https://ali.dev', 'https://github.com/ali'], key + ': farklı Web ve GitHub ikisi de, Web önce');
      var other = CVPdf.build({ name: 'A', web: 'github.com/ali/proje', github: 'github.com/ali' }, { template: tpl, lang: lang });
      eq(linksOf(other.content).length, 2, key + ': depo bağlantısı profil adresiyle aynı sayılmaz');
      // GitHub alanına GitHub dışı bir adres (ör. LinkedIn) yazılmış ve Web ile aynıysa "GITHUB" etiketi yanlış
      // olurdu: bu durumda Web girdisi kalır.
      var li = CVPdf.build({ name: 'A', web: 'linkedin.com/in/ali', github: 'https://www.linkedin.com/in/ali/' }, { template: tpl, lang: lang });
      same(linksOf(li.content).map(function (n) { return n.link; }), ['https://linkedin.com/in/ali'], key + ': GitHub dışı yinelenen adres Web olarak bir kez');
      ok(linksOf(li.content)[0].text === 'linkedin.com/in/ali', key + ': GitHub dışı adres Web değeriyle görünür');
    });

    // HATA 4 — hasContent, build'in hiçbir şey basmayacağı bağlantı değerlerini ("https://", "@") içerik
    // sayıyordu: önizleme örnek CV yerine boş sayfa gösterirdi.
    eq(CVPdf.hasContent({ github: 'https://' }), false, 'hasContent: yalnızca protokollü GitHub içerik değil');
    eq(CVPdf.hasContent({ github: ' HTTP:// ' }), false, 'hasContent: büyük harfli protokol + boşluk');
    eq(CVPdf.hasContent({ web: 'https:///' }), false, 'hasContent: yalnızca protokollü Web içerik değil');
    eq(CVPdf.hasContent({ github: '@' }), false, 'hasContent: yalnızca "@" içerik değil');
    eq(CVPdf.hasContent({ github: '@ali' }), true, 'hasContent: @kullanıcı içerik');
    eq(CVPdf.hasContent({ github: 'https://github.com/ali' }), true, 'hasContent: protokollü GitHub içerik');
    eq(CVPdf.hasContent({ web: 'ali.dev' }), true, 'hasContent: Web içerik');
    each(function (tpl, lang, key) {
      ['https://', '@', ' @ '].forEach(function (v) {
        var dd = CVPdf.build({ github: v }, { template: tpl, lang: lang });
        eq(linksOf(dd.content).length, 0, key + ': GitHub ' + JSON.stringify(v) + ' → bağlantı yok');
        same(allLines(dd).filter(function (l) { return l.trim() !== ''; }), [], key + ': GitHub ' + JSON.stringify(v) + ' → boş sayfa (hasContent ile tutarlı)');
      });
    });

    // HATA 5 — iki kez yapıştırılmış protokol ("https://https://github.com/ali"): bağlantı "https://https://…"
    // (ana makine adı "https") olarak bozuk, görünen metin "https://github.com/ali" idi.
    each(function (tpl, lang, key) {
      var dd = CVPdf.build(withProjects([{ id: 'p', name: 'Çift', tech: '', link: 'HTTPS://https://github.com/ali/cift/', desc: '' }],
        { web: 'http://https://ali.dev', github: 'https://https://github.com/ali' }), { template: tpl, lang: lang });
      var l = linksOf(dd.content).map(function (n) { return n.text + ' → ' + n.link; });
      ok(l.indexOf('github.com/ali/cift → https://github.com/ali/cift/') >= 0, key + ': proje bağlantısında çift protokol tekilleşir');
      ok(l.indexOf('github.com/ali → https://github.com/ali') >= 0, key + ': GitHub çift protokol tekilleşir');
      ok(l.indexOf('ali.dev → https://ali.dev') >= 0, key + ': Web çift protokol: sonuncusu geçerli');
      ok(JSON.stringify(dd).search(/https?:\/\/https?:/i) < 0, key + ': hiçbir yerde çift protokol yok');
    });

    // "www." bağlantılar: protokol gizlenir, "www." kişinin yazdığı gibi kalır; bağlantı tıklanabilir.
    each(function (tpl, lang, key) {
      var dd = CVPdf.build(withProjects([{ id: 'p', name: 'W', tech: 'JS', link: 'https://www.ornek.com/proje/', desc: 'Madde.' }],
        { github: 'https://www.github.com/ali/' }), { template: tpl, lang: lang });
      var l = linksOf(dd.content);
      ok(l.some(function (n) { return n.text === 'www.ornek.com/proje' && n.link === 'https://www.ornek.com/proje/'; }), key + ': https://www. proje bağlantısı');
      ok(l.some(function (n) { return n.text === 'www.github.com/ali' && n.link === 'https://www.github.com/ali/'; }), key + ': https://www. GitHub');
      ok(JSON.stringify(dd).indexOf('https://https://') < 0 && JSON.stringify(dd).indexOf('"https://www.github.com/ali/"') >= 0, key + ': protokol iki kez eklenmez');
      auditDoc(dd, tpl, 'www/' + key);
    });

    // Yalnızca adı olan proje, 8 uzun maddeli proje, 6 iş + projeler: her şablon × dil
    each(function (tpl, lang, key) {
      var dd = CVPdf.build({ name: 'A', projects: [{ id: 'p', name: 'Yalnız Ad', tech: '', link: '', desc: '' }] }, { template: tpl, lang: lang });
      auditDoc(dd, tpl, 'yalnız ad/' + key);
      // v2: Türkçede referans yoksa kapanış satırı "Referanslar talep üzerine iletilir." (İngilizcede yok).
      same(allLines(dd).filter(function (l) { return l.trim() !== ''; }), ['A', U(lang, 'projects'), 'Yalnız Ad'].concat(lang === 'tr' ? ['Referanslar talep üzerine iletilir.'] : []), key + ': yalnızca adlı proje → başlık + ad');
      eq(findNodes(dd.content, function (n) { return n.ul !== undefined; }).length, 0, key + ': yalnızca adlı projede madde listesi yok');

      var bullets = [];
      for (var i = 0; i < 8; i++) bullets.push('Madde ' + (i + 1) + ': ' + new Array(15).join('gerçekzamanlı ') + 'sistemini tasarlayıp canlıya aldım.');
      var d8 = CVPdf.build(withProjects([{ id: 'p', name: 'Sekiz Maddeli', tech: 'Go, Kafka', link: 'github.com/ali/sekiz', desc: bullets.join('\n') }]), { template: tpl, lang: lang });
      auditDoc(d8, tpl, '8 madde/' + key);
      var t8 = textsOf(d8.content);
      ok(bullets.every(function (b) { return t8.indexOf(b) >= 0; }), key + ': 8 maddenin hepsi');
      var nm = findNodes(d8.content, function (n) { return n.text === 'Sekiz Maddeli'; })[0];
      var u = nm && nearestUnbreakable(nm.anc);
      ok(u && textsOf(u).indexOf(bullets[0]) >= 0 && bullets.slice(1).every(function (b) { return textsOf(u).indexOf(b) < 0; }), key + ': 8 maddeden yalnızca ilki adla bölünmez blokta');

      var jobs = [];
      for (var j = 0; j < 6; j++) jobs.push({ id: 'j' + j, role: 'Geliştirici ' + j, company: 'Şirket ' + j, city: 'Ankara', start: '20' + (10 + j), end: '20' + (11 + j), desc: 'Bir.\nİki.\nÜç.' });
      var d6 = CVPdf.build(withProjects(SAMPLE.projects, { jobs: jobs }), { template: tpl, lang: lang });
      auditDoc(d6, tpl, '6 iş + projeler/' + key);
      var heads = allLines(d6).filter(function (x) { return [U(lang, 'experience'), U(lang, 'projects'), U(lang, 'education')].indexOf(x) >= 0; });
      same(heads, [U(lang, 'experience'), U(lang, 'projects'), U(lang, 'education')], key + ': 6 iş + projeler bölüm sırası');
    });
  })();

  /* ------------------------------------------------------------------- sonuç */

  print('pdfdoc: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) throw new Error(failed + ' test başarısız');
})();
