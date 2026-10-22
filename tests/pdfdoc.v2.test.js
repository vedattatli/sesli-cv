/*
 * pdfdoc.js + parse.js v2 testleri (brief §4: profiller, CEFR/sınav, gruplu yetenekler, sayısal tarih,
 * referans satırı, dosya adı, ön yazı, Modern akış sırası). jsc ile çalışır (bkz. tests/run-pdfdoc.sh):
 *   jsc public/parse.js public/pdfdoc.js tests/pdfdoc.v2.test.js
 * Son satır: "pdfdoc-v2: N passed, M failed". Başarısızlık varsa istisna fırlatır.
 * Gerçek pdfmake düzeni ve metin çıkarma testleri: tests/run-pdf-qa.sh.
 */
(function () {
  'use strict';

  var G = globalThis;
  var passed = 0, failed = 0, shown = 0;
  function ok(cond, msg) {
    if (cond) { passed++; return true; }
    failed++;
    if (shown++ < 80) print('  FAIL: ' + msg);
    return false;
  }
  function eq(a, b, msg) { return ok(a === b, msg + ' — beklenen ' + JSON.stringify(b) + ', gelen ' + JSON.stringify(a)); }
  function same(a, b, msg) { return ok(JSON.stringify(a) === JSON.stringify(b), msg + ' — beklenen ' + JSON.stringify(b) + ', gelen ' + JSON.stringify(a)); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  var CVPdf = G.CVPdf, P = G.CVParse;
  if (!CVPdf || !P) { print('pdfdoc-v2: 0 passed, 1 failed'); throw new Error('CVPdf/CVParse yüklenmemiş'); }
  var INK = '#1d232a', MUTED = '#5b6670';
  var JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z';
  var TPLS = ['klasik', 'sade', 'modern'];
  var PROFILES = ['deneyimli', 'ogrenci', 'saha', 'yazilim'];

  function walk(x, visit, anc) {
    anc = anc || [];
    visit(x, anc);
    if (x && typeof x === 'object') {
      var next = anc.concat([x]);
      if (Array.isArray(x)) x.forEach(function (v) { walk(v, visit, next); });
      else for (var k in x) walk(x[k], visit, next);
    }
  }
  function nodeText(n) {
    if (typeof n === 'string') return n;
    if (!n || typeof n !== 'object') return '';
    if (Array.isArray(n)) return n.map(nodeText).join('');
    if (n.text !== undefined) return nodeText(n.text);
    return '';
  }
  // Görünen metin satırları, belge (akış) sırasıyla.
  function lines(node) {
    var out = [];
    walk(node, function (v) { if (v && typeof v === 'object' && !Array.isArray(v) && v.text !== undefined) out.push(nodeText(v)); });
    return out;
  }
  function find(node, pred) {
    var out = [];
    walk(node, function (v, anc) { if (v && typeof v === 'object' && !Array.isArray(v) && pred(v)) out.push({ node: v, anc: anc }); });
    return out;
  }
  function U(s) { return s.replace(/i/g, 'İ').replace(/ı/g, 'I').toUpperCase(); }
  function headingOrder(dd, lang, profile) {
    var L = CVPdf.labels(lang, profile), keys = ['profile', 'experience', 'projects', 'education', 'skills', 'languages', 'certs', 'personal', 'hobbies', 'refs'];
    var map = {};
    keys.forEach(function (k) { map[lang === 'en' ? L[k].toUpperCase() : U(L[k])] = k; });
    return lines(dd.content).filter(function (l) { return map[l]; }).map(function (l) { return map[l]; });
  }
  function modernCols(dd) {
    for (var i = 0; i < dd.content.length; i++) if (Array.isArray(dd.content[i].columns) && dd.content[i].columns[0].width === 310) return dd.content[i].columns;
    return null;
  }

  /* =================================================================== parse.js */
  print('# parse.js v2');

  // formatDate / formatRange: sayısal seçenek (sade), varsayılan değişmez
  same([P.formatDate('Mart 2021', 'tr', { numeric: true }), P.formatDate('mart 2021', 'en', { numeric: true }), P.formatDate('11/2019', 'tr', { numeric: true }),
    P.formatDate('2021', 'tr', { numeric: true }), P.formatDate('Devam ediyor', 'tr', { numeric: true }), P.formatDate('şu an', 'en', { numeric: true }),
    P.formatDate('Yaz 2019', 'tr', { numeric: true }), P.formatDate('Mart', 'tr', { numeric: true })],
  ['03/2021', '03/2021', '11/2019', '2021', 'Günümüz', 'Present', 'Yaz 2019', 'Mart'], 'formatDate numeric');
  eq(P.formatRange('Mart 2021', 'Devam ediyor', 'tr', { numeric: true }), '03/2021 – Günümüz', 'formatRange numeric (brief §4.3)');
  eq(P.formatRange('Eylül 2018', 'Haziran 2022', 'tr', { numeric: true }), '09/2018 – 06/2022', 'formatRange numeric iki uç');
  eq(P.formatRange('Mart 2021', 'Devam ediyor', 'tr'), 'Mart 2021 – Günümüz', 'formatRange varsayılan ay adıyla (değişmedi)');
  eq(P.formatRange('Mart 2021', 'Devam ediyor', 'tr', {}), 'Mart 2021 – Günümüz', 'formatRange boş seçenek');
  eq(P.formatDate(P.formatDate('Ekim 2015', 'tr', { numeric: true }), 'tr', { numeric: true }), '10/2015', 'formatDate numeric idempotent');

  // fileName: isteğe bağlı tire
  eq(P.fileName('Ayşe Kaya', 'CV', 'pdf', { sep: '-' }), 'Ayse-Kaya-CV.pdf', 'parse.fileName sep -');
  eq(P.fileName('Ayşe-Nur  Şahin', 'Ön Yazı', 'pdf', { sep: '-' }), 'Ayse-Nur-Sahin-On-Yazi.pdf', 'parse.fileName sep - Türkçe ek');
  eq(P.fileName('Ayşe Kaya'), 'Ayse_Kaya_CV.pdf', 'parse.fileName varsayılan alt çizgi (değişmedi)');

  // CEFR etiketleri
  same(['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'c1', 'X'].map(function (c) { return P.cefrLabel(c, 'tr'); }),
    ['Başlangıç', 'Temel', 'Orta', 'Orta-üst', 'İleri', 'Yetkin', 'İleri', ''], 'cefrLabel tr');
  same(['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map(function (c) { return P.cefrLabel(c, 'en'); }),
    ['Beginner', 'Elementary', 'Intermediate', 'Upper-intermediate', 'Advanced', 'Proficient'], 'cefrLabel en');

  // parseLanguageDetails
  function det(name, level, cefr, exam) { return { name: name, level: level, cefr: cefr, exam: exam }; }
  function pick(list) { return list.map(function (d) { return det(d.name, d.level, d.cefr, d.exam); }); }
  [
    ['İngilizce ileri (C1) · IELTS 6.5 (2024)', [det('İngilizce', 4, 'C1', 'IELTS 6.5 (2024)')]],
    ['Almanca B1', [det('Almanca', 2, 'B1', '')]],
    ['İngilizce iyi', [det('İngilizce', 3, '', '')]],
    ['Türkçe ana dil', [det('Türkçe', 5, '', '')]],
    ['İngilizce YDS 85 (2025)', [det('İngilizce', 0, '', 'YDS 85 (2025)')]],
    ['İngilizce YÖKDİL 82,5', [det('İngilizce', 0, '', 'YÖKDİL 82,5')]],
    ['İngilizce e-YDS 77.5 2024', [det('İngilizce', 0, '', 'e-YDS 77.5 (2024)')]],
    ['İngilizce C1 · TOEFL iBT 102 (2022)', [det('İngilizce', 4, 'C1', 'TOEFL iBT 102 (2022)')]],
    ['Fransızca DELF B2 (2021)', [det('Fransızca', 0, '', 'DELF B2 (2021)')]],
    ['Almanca Goethe-Zertifikat B1', [det('Almanca', 0, '', 'Goethe-Zertifikat B1')]],
    ['İngilizce TOEIC 850, İspanyolca DELE A2', [det('İngilizce', 0, '', 'TOEIC 850'), det('İspanyolca', 0, '', 'DELE A2')]],
    ['English C1, IELTS 7.5', [det('English', 4, 'C1', 'IELTS 7.5')]],
    ['Türkçe ana dil, İngilizce ileri (C1) · IELTS 7.0 (2023), Almanca başlangıç (A2)',
      [det('Türkçe', 5, '', ''), det('İngilizce', 4, 'C1', 'IELTS 7.0 (2023)'), det('Almanca', 1, 'A2', '')]],
    ['ingilizce b2 toefl 95 almanca a1', [det('İngilizce', 3, 'B2', 'TOEFL 95'), det('Almanca', 1, 'A1', '')]],
    ['İngilizce, B2', [det('İngilizce', 3, 'B2', '')]],
    ['İngilizce B2; İngilizce IELTS 6', [det('İngilizce', 3, 'B2', 'IELTS 6')]],
    ['İngilizce ileri ve Almanca orta', [det('İngilizce', 4, '', ''), det('Almanca', 2, '', '')]],
    ['IELTS 7.0', []],
    ['', []]
  ].forEach(function (c) { same(pick(P.parseLanguageDetails(c[0])), c[1], 'parseLanguageDetails(' + JSON.stringify(c[0]) + ')'); });
  ok(P.parseLanguageDetails('İngilizce ileri (C1) · IELTS 6.5 (2024)')[0].raw === 'İngilizce ileri (C1) · IELTS 6.5 (2024)', 'parseLanguageDetails raw');

  // parseLanguages: geriye uyum; sınav dil adına karışmaz, yalnızca sınav olan öğe atlanır
  same(P.parseLanguages('İngilizce YDS 85 (2025)').map(function (l) { return [l.name, l.level]; }), [['İngilizce', 0]], 'parseLanguages: sınav adda değil');
  same(P.parseLanguages('Türkçe ana dil, İngilizce ileri (C1) · IELTS 7.0 (2023)').map(function (l) { return [l.name, l.level]; }),
    [['Türkçe', 5], ['İngilizce', 4]], 'parseLanguages: "· IELTS" ayrı dil sayılmaz');
  same(P.parseLanguages('İngilizce (C1), Almanca (A2)'), [{ name: 'İngilizce', level: 4, raw: 'İngilizce (C1)' }, { name: 'Almanca', level: 1, raw: 'Almanca (A2)' }], 'parseLanguages: sınavsız girdi aynen');

  // languageDetailText: çubuk/nokta yok; CEFR → "B2 (Orta-üst)", yoksa seviye sözcüğü; ana dil; sınav
  function txt(s, lang) { return P.parseLanguageDetails(s).map(function (d) { return P.languageDetailText(d, lang); }); }
  same(txt('İngilizce B2 · IELTS 6.5 (2024), Almanca başlangıç, Türkçe ana dil, İtalyanca, Rusça YDS 70', 'tr'),
    ['B2 (Orta-üst) · IELTS 6.5 (2024)', 'Başlangıç', 'Ana dil', '', 'YDS 70'], 'languageDetailText tr');
  same(txt('İngilizce B2 · IELTS 6.5 (2024), Almanca başlangıç, Türkçe ana dil', 'en'),
    ['B2 (Upper-intermediate) · IELTS 6.5 (2024)', 'Beginner', 'Native'], 'languageDetailText en');
  eq(P.languageDetailText(null, 'tr'), '', 'languageDetailText(null)');
  eq(P.languageDetailText({ name: 'Türkçe', level: 5, cefr: 'C2', exam: '' }, 'tr'), 'Ana dil', 'ana dil CEFR\'den önce gelir');

  /* =================================================================== skillGroups */
  print('# skillGroups');
  same(CVPdf.skillGroups('Excel, SAP, Logo Tiger'), [{ label: '', items: ['Excel', 'SAP', 'Logo Tiger'] }], 'düz liste');
  same(CVPdf.skillGroups('Diller: Python, Go\nFramework: React, Django\nVeritabanı: PostgreSQL'),
    [{ label: 'Diller', items: ['Python', 'Go'] }, { label: 'Framework', items: ['React', 'Django'] }, { label: 'Veritabanı', items: ['PostgreSQL'] }], 'gruplu');
  same(CVPdf.skillGroups('Docker, Git\nDiller: Go\nLinux'), [{ label: '', items: ['Docker', 'Git', 'Linux'] }, { label: 'Diller', items: ['Go'] }],
    'gruplu metinde etiketsiz satırlar tek etiketsiz grupta (ilk geçtiği yerde)');
  same(CVPdf.skillGroups('• Diller: Go, Rust\n- Araçlar: Docker'), [{ label: 'Diller', items: ['Go', 'Rust'] }, { label: 'Araçlar', items: ['Docker'] }], 'madde işaretli satırlar');
  same(CVPdf.skillGroups('Excel (pivot tablo, makro), SQL'), [{ label: '', items: ['Excel (pivot tablo, makro)', 'SQL'] }], 'parantez içindeki virgül öğeyi bölmez');
  same(CVPdf.skillGroups('Framework: React (Next ve Remix), Vue'), [{ label: 'Framework', items: ['React (Next ve Remix)', 'Vue'] }], 'parantez içindeki "ve" öğeyi bölmez');
  same(CVPdf.skillGroups('https://ali.dev, Go'), [{ label: '', items: ['https://ali.dev', 'Go'] }], 'adres "https:" etiket sayılmaz');
  same(CVPdf.skillGroups('A: x'), [{ label: '', items: ['A: x'] }], 'tek harfli etiket grup değil (2–30 karakter)');
  same(CVPdf.skillGroups('Diller:\nGo'), [{ label: '', items: ['Diller:', 'Go'] }], 'öğesiz "Etiket:" satırı grup değil, kaybolmaz');
  same(CVPdf.skillGroups(''), [], 'boş');
  same(CVPdf.skillGroups(null), [], 'null');
  same(CVPdf.skillGroups('Excel, excel, EXCEL'), [{ label: '', items: ['Excel'] }], 'tekrarlar atılır');

  // Şablonlarda gruplu yetenek: her grup bir satır, etiket kalın; modern kenar çubuğunda etiket sonra öğeler
  TPLS.forEach(function (tpl) {
    var cv = { name: 'Y', skills: 'Diller: Python, Go\nFramework: React, Django' };
    var dd = CVPdf.build(cv, { template: tpl, profile: 'yazilim' });
    var all = lines(dd.content);
    if (tpl === 'modern') {
      var side = modernCols(dd)[1];
      ok(find(side, function (n) { return n.text === 'Diller' && n.bold; }).length === 1 && lines(side).indexOf('Python, Go') >= 0, tpl + ': kenar çubuğunda "Diller" sonra "Python, Go"');
    } else {
      ok(all.indexOf('Diller: Python, Go') >= 0 && all.indexOf('Framework: React, Django') >= 0, tpl + ': grup başına bir satır');
      ok(find(dd.content, function (n) { return n.text === 'Diller: ' && n.bold === true; }).length === 1, tpl + ': grup etiketi kalın');
    }
    var flat = CVPdf.build({ name: 'Y', skills: 'Excel, SAP, Logo Tiger' }, { template: tpl });
    var fl = lines(flat.content);
    if (tpl === 'klasik') ok(fl.indexOf('Excel  ·  SAP  ·  Logo Tiger') >= 0, 'klasik: düz liste " · "');
    if (tpl === 'sade') ok(fl.indexOf('Excel, SAP, Logo Tiger') >= 0, 'sade: düz liste virgülle tek satır');
    if (tpl === 'modern') ok(['Excel', 'SAP', 'Logo Tiger'].every(function (x) { return lines(modernCols(flat)[1]).indexOf(x) >= 0; }), 'modern: düz liste kenar çubuğunda satır satır');
    // öğeler satır sonunda bölünmez (noWrap), çok uzun öğe bölünebilir
    var long = CVPdf.build({ name: 'Y', skills: 'GitHub Actions, ' + new Array(40).join('çokuzunbiröğe') }, { template: tpl });
    var parts = find(long.content, function (n) { return n.text === 'GitHub Actions'; });
    // modern düz listede her öğe kendi satırında (satır içi bölünme yok); diğerlerinde satır içi noWrap
    ok(parts.length === 1 && (tpl === 'modern' || parts[0].node.noWrap === true), tpl + ': kısa öğe bölünmez');
    ok(find(long.content, function (n) { return typeof n.text === 'string' && n.text.length > 300 && n.noWrap; }).length === 0, tpl + ': satırdan uzun öğe noWrap değil');
  });

  /* =================================================================== diller (şablonlarda) */
  print('# diller');
  TPLS.forEach(function (tpl) {
    ['tr', 'en'].forEach(function (lang) {
      var dd = CVPdf.build({ name: 'D', langs: 'Türkçe ana dil, İngilizce ileri (C1) · IELTS 6.5 (2024), Almanca başlangıç' }, { template: tpl, lang: lang });
      var t = lines(dd.content).join('\n');
      var en = lang === 'en';
      var want = en ? ['Turkish', 'Native', 'English', 'C1 (Advanced) · IELTS 6.5 (2024)', 'German', 'Beginner'] : ['Türkçe', 'Ana dil', 'İngilizce', 'C1 (İleri) · IELTS 6.5 (2024)', 'Almanca', 'Başlangıç'];
      ok(want.every(function (w) { return t.indexOf(w) >= 0; }), tpl + '/' + lang + ': dil adı + CEFR + sınav metni');
      if (tpl !== 'modern') ok(t.indexOf(en ? 'English — C1 (Advanced) · IELTS 6.5 (2024)' : 'İngilizce — C1 (İleri) · IELTS 6.5 (2024)') >= 0, tpl + '/' + lang + ': "Ad — seviye · sınav" tek satır');
      var bars = find(dd.content, function (n) { return Array.isArray(n.canvas) && n.canvas.some(function (v) { return v.type === 'rect' && v.r; }); });
      eq(bars.length, 0, tpl + '/' + lang + ': seviye çubuğu/nokta yok');
      ok(!/[●○■□★☆%]/.test(t), tpl + '/' + lang + ': nokta, yıldız, yüzde yok');
    });
  });
  ok(lines(CVPdf.build({ name: 'D', langs: 'İngilizce B2, Almanca A1' }, { template: 'sade' }).content).indexOf('İngilizce — B2 (Orta-üst)  ·  Almanca — A1 (Başlangıç)') >= 0, 'sade: diller tek satır, "  ·  " ile');

  /* =================================================================== tarih biçimi */
  print('# tarihler');
  (function () {
    var cv = { name: 'T', jobs: [{ id: 'j', role: 'Uzman', company: 'Şirket', city: 'Bursa', start: 'Mart 2021', end: 'Devam ediyor', desc: '' }],
      edu: [{ id: 'e', school: 'Okul', program: 'Bölüm', degree: 'Lisans', start: '2014', end: '2018', note: '' }] };
    var s = lines(CVPdf.build(cv, { template: 'sade' }).content);
    ok(s.indexOf('Şirket, Bursa | 03/2021 – Günümüz') >= 0 && s.indexOf('Okul | 2014 – 2018') >= 0, 'sade: sayısal tarih, yalnız yıl yıl olarak');
    ['klasik', 'modern'].forEach(function (tpl) {
      var l = lines(CVPdf.build(cv, { template: tpl }).content);
      ok(l.indexOf('Mart 2021 – Günümüz') >= 0 && l.indexOf('2014 – 2018') >= 0, tpl + ': ay adıyla tarih');
      ok(lines(CVPdf.build(cv, { template: tpl, lang: 'en' }).content).indexOf('Mar 2021 – Present') >= 0, tpl + '/en: "Present"');
    });
    ok(lines(CVPdf.build(cv, { template: 'sade', lang: 'en' }).content).indexOf('Şirket, Bursa | 03/2021 – Present') >= 0, 'sade/en: "Present"');
  })();

  /* =================================================================== profil sıraları */
  print('# profil sıraları (brief §4.2)');
  var EXPECT = {
    deneyimli: ['profile', 'experience', 'projects', 'education', 'skills', 'languages', 'certs', 'personal', 'hobbies', 'refs'],
    ogrenci: ['profile', 'education', 'projects', 'experience', 'skills', 'languages', 'certs', 'personal', 'hobbies', 'refs'],
    saha: ['profile', 'certs', 'experience', 'projects', 'education', 'skills', 'languages', 'personal', 'hobbies', 'refs'],
    yazilim: ['profile', 'experience', 'projects', 'education', 'skills', 'languages', 'certs', 'personal', 'hobbies', 'refs']
  };
  var FULL = clone(CVPdf.SAMPLE); // her bölüm dolu (referanslar dahil)
  PROFILES.forEach(function (pr) {
    same(CVPdf.sectionOrder(pr, FULL), EXPECT[pr], 'sectionOrder(' + pr + ')');
    TPLS.forEach(function (tpl) {
      var dd = CVPdf.build(FULL, { template: tpl, profile: pr });
      var got = headingOrder(dd, 'tr', pr);
      if (tpl === 'modern') {
        var main = EXPECT[pr].filter(function (k) { return ['profile', 'experience', 'projects', 'education', 'refs'].indexOf(k) >= 0; });
        var side = EXPECT[pr].filter(function (k) { return main.indexOf(k) < 0; });
        same(headingOrder({ content: modernCols(dd)[0] }, 'tr', pr), main, 'modern/' + pr + ': ana sütun sırası');
        same(headingOrder({ content: modernCols(dd)[1] }, 'tr', pr), side, 'modern/' + pr + ': kenar çubuğu sırası');
        same(got, main.concat(side), 'modern/' + pr + ': akış: başlık → ana sütun → kenar çubuğu');
      } else {
        same(got, EXPECT[pr], tpl + '/' + pr + ': bölüm sırası');
      }
    });
  });
  eq(CVPdf.sectionOrder('bilinmeyen').join(','), EXPECT.deneyimli.join(','), 'bilinmeyen profil → deneyimli');
  // Yazılım: yeni başlayan (24 aydan az deneyim) → Projeler önce; açık seçenek her zaman kazanır
  (function () {
    var junior = { jobs: [{ role: 'Stajyer', company: 'X', start: 'Haziran 2025', end: 'Eylül 2025' }] };
    var senior = { jobs: [{ role: 'Geliştirici', company: 'X', start: '2015', end: 'Devam ediyor' }] };
    var idx = function (o) { return [o.indexOf('projects'), o.indexOf('experience')]; };
    var j = idx(CVPdf.sectionOrder('yazilim', junior)), s = idx(CVPdf.sectionOrder('yazilim', senior));
    ok(j[0] < j[1], 'yazılım: 3 aylık deneyim → Projeler İş Deneyimi\'nden önce');
    ok(s[0] > s[1], 'yazılım: 10 yıl → İş Deneyimi önce');
    ok(idx(CVPdf.sectionOrder('yazilim', {}))[0] < idx(CVPdf.sectionOrder('yazilim', {}))[1], 'yazılım: deneyimsiz → Projeler önce');
    ok(idx(CVPdf.sectionOrder('yazilim', junior, { projectsFirst: false }))[0] > idx(CVPdf.sectionOrder('yazilim', junior, { projectsFirst: false }))[1], 'projectsFirst:false');
    ok(idx(CVPdf.sectionOrder('yazilim', senior, { projectsFirst: true }))[0] < idx(CVPdf.sectionOrder('yazilim', senior, { projectsFirst: true }))[1], 'projectsFirst:true');
    ok(idx(CVPdf.sectionOrder('deneyimli', junior))[0] > idx(CVPdf.sectionOrder('deneyimli', junior))[1], 'deneyimli profilde kural yok');
    var vague = { jobs: [{ role: 'X', company: 'Y', start: 'üniversitede', end: '' }] };
    ok(idx(CVPdf.sectionOrder('yazilim', vague))[0] > idx(CVPdf.sectionOrder('yazilim', vague))[1], 'okunamayan tarih → varsayılan sıra');
    var cv = clone(CVPdf.SAMPLES.yazilim); cv.jobs = junior.jobs;
    same(headingOrder(CVPdf.build(cv, { template: 'sade', profile: 'yazilim' }), 'tr', 'yazilim').slice(0, 3), ['profile', 'projects', 'experience'], 'build: yazılım yeni başlayan sırası');
  })();

  // Profil etiketleri
  eq(CVPdf.labels('tr', 'ogrenci').experience, 'Deneyim', 'öğrenci: "Deneyim"');
  eq(CVPdf.labels('tr', 'saha').certs, 'Belgeler ve Sertifikalar', 'saha: "Belgeler ve Sertifikalar"');
  eq(CVPdf.labels('en', 'saha').certs, 'Licences and Certificates', 'saha/en');
  eq(CVPdf.labels('tr', 'deneyimli').experience, 'İş Deneyimi', 'deneyimli: "İş Deneyimi"');
  eq(CVPdf.labels('tr', 'ogrenci').jobs, 'Deneyim', 'takma ad profil etiketini izler');
  ok(lines(CVPdf.build(FULL, { template: 'sade', profile: 'saha' }).content).indexOf('BELGELER VE SERTİFİKALAR') >= 0, 'saha: başlık CV\'de');
  ok(lines(CVPdf.build(FULL, { template: 'klasik', profile: 'ogrenci' }).content).indexOf('DENEYİM') >= 0, 'öğrenci: başlık CV\'de');

  // Saha: ehliyet ve belgeler önce
  (function () {
    var cv = { name: 'S', certs: 'İSG Eğitimi (2023)\nPsikoteknik Belgesi (2024)\nForklift Operatör Belgesi — MEB onaylı kurs, 2022\nB Sınıfı Sürücü Belgesi\nSRC 4 Belgesi' };
    var l = lines(CVPdf.build(cv, { template: 'sade', profile: 'saha' }).content);
    var order = ['Psikoteknik Belgesi (2024)', 'Forklift Operatör Belgesi — MEB onaylı kurs, 2022', 'B Sınıfı Sürücü Belgesi', 'SRC 4 Belgesi', 'İSG Eğitimi (2023)'].map(function (x) { return l.indexOf(x); });
    ok(order.every(function (i, k) { return i >= 0 && (k === 0 || i > order[k - 1]); }), 'saha: belgeler önce, kendi sırasıyla; diğer sertifikalar sonra');
    var d = lines(CVPdf.build(cv, { template: 'sade', profile: 'deneyimli' }).content);
    ok(d.indexOf('İSG Eğitimi (2023)') < d.indexOf('SRC 4 Belgesi'), 'deneyimli: girilen sıra korunur');
  })();

  // Saha Kısa CV başlığı (klasik): telefon adın altında Medium 12, e-posta ve şehir 9.5
  (function () {
    var cv = CVPdf.SAMPLES.saha;
    var dd = CVPdf.build(cv, { template: 'klasik', profile: 'saha' });
    var ph = find(dd.content, function (n) { return n.text === cv.phone; });
    ok(ph.length === 1 && ph[0].node.bold === true && ph[0].node.fontSize === 12 && ph[0].node.color === INK, 'klasik/saha: telefon kendi satırında Medium 12 INK');
    var contact = find(dd.content, function (n) { return Array.isArray(n.text) && n.text.some(function (x) { return /^mailto:/.test(x.link || ''); }); })[0];
    ok(contact && contact.node.fontSize === 9.5 && nodeText(contact.node).indexOf(cv.phone) < 0 && nodeText(contact.node).indexOf(cv.email) === 0, 'klasik/saha: e-posta ve şehir 9.5pt, telefon tekrar edilmez');
    var l = lines(dd.content);
    ok(l.indexOf(cv.name) < l.indexOf(cv.phone) && l.indexOf(cv.phone) < l.indexOf(nodeText(contact.node)), 'klasik/saha: ad → telefon → e-posta');
    ['sade', 'modern'].forEach(function (tpl) {
      eq(find(CVPdf.build(cv, { template: tpl, profile: 'saha' }).content, function (n) { return n.text === cv.phone && n.fontSize === 12; }).length, 0, tpl + '/saha: büyük telefon yalnızca klasikte');
    });
    eq(find(CVPdf.build(cv, { template: 'klasik', profile: 'deneyimli' }).content, function (n) { return n.text === cv.phone && n.fontSize === 12; }).length, 0, 'klasik/deneyimli: Kısa CV başlığı yok');
  })();

  /* =================================================================== referans satırı */
  print('# referans satırı');
  (function () {
    var noRefs = clone(CVPdf.SAMPLE); noRefs.refs = '';
    var LINE_TR = 'Referanslar talep üzerine iletilir.', LINE_EN = 'References available upon request.';
    TPLS.forEach(function (tpl) {
      var tr = CVPdf.build(noRefs, { template: tpl });
      var hit = find(tr.content, function (n) { return n.text === LINE_TR; });
      ok(hit.length === 1 && hit[0].node.fontSize === 9 && hit[0].node.color === MUTED, tpl + ': tr varsayılan: kapanış satırı 9pt MUTED');
      ok(lines(tr.content).indexOf('REFERANSLAR') < 0, tpl + ': satırın başlığı yok');
      var l = lines(tpl === 'modern' ? modernCols(tr)[0] : tr.content);
      eq(l[l.length - 1], LINE_TR, tpl + ': satır en sonda (modern: ana sütunun sonunda)');
      eq(find(CVPdf.build(noRefs, { template: tpl, lang: 'en' }).content, function (n) { return n.text === LINE_EN || n.text === LINE_TR; }).length, 0, tpl + ': en varsayılan: satır yok');
      eq(find(CVPdf.build(noRefs, { template: tpl, lang: 'en', refsLine: true }).content, function (n) { return n.text === LINE_EN; }).length, 1, tpl + ': en refsLine:true → İngilizce satır');
      eq(find(CVPdf.build(noRefs, { template: tpl, refsLine: false }).content, function (n) { return n.text === LINE_TR; }).length, 0, tpl + ': refsLine:false → satır yok');
      var withRefs = CVPdf.build(CVPdf.SAMPLE, { template: tpl });
      ok(lines(withRefs.content).indexOf('REFERANSLAR') >= 0 && find(withRefs.content, function (n) { return n.text === LINE_TR; }).length === 0, tpl + ': referans varsa bölüm basılır, satır basılmaz');
      eq(find(CVPdf.build({ name: 'Yalnız Ad' }, { template: tpl }).content, function (n) { return n.text === LINE_TR; }).length, 0, tpl + ': bölüm yoksa satır da yok');
      // satır son bölümün son bölünmez bloğunda: sayfa sonunda tek başına yeni sayfaya düşmez
      var blk = null;
      hit[0].anc.forEach(function (x) { if (x && x.unbreakable === true) blk = x; });
      ok(blk && lines(blk).filter(function (t) { return t !== LINE_TR && t.trim(); }).length > 0, tpl + ': kapanış satırı önceki blokla birlikte (bölünmez)');
    });
  })();

  /* =================================================================== kişisel bilgiler */
  (function () {
    var cv = { name: 'K', birth: '14 Mayıs 1991', military: 'Yapıldı (2015)', license: 'B' };
    ok(lines(CVPdf.build(cv, { template: 'klasik' }).content).indexOf('Doğum Yılı: 1991') >= 0, 'doğum tarihi → yalnızca yıl (brief K2)');
    ok(lines(CVPdf.build(cv, { template: 'sade' }).content).indexOf('Doğum Yılı: 1991 · Askerlik Durumu: Yapıldı (2015) · Sürücü Belgesi: B') >= 0, 'sade: kişisel bilgiler tek satır');
    ok(lines(CVPdf.build({ name: 'K', birth: 'belirtmek istemiyorum' }, { template: 'klasik' }).content).indexOf('Doğum Yılı: belirtmek istemiyorum') >= 0, 'yıl yoksa olduğu gibi');
    TPLS.forEach(function (tpl) {
      var en = lines(CVPdf.build(cv, { template: tpl, lang: 'en' }).content).join('\n');
      ok(en.indexOf('Yapıldı') < 0 && en.indexOf('Military') < 0 && en.indexOf('1991') >= 0, tpl + '/en: askerlik İngilizce CV\'de yok (brief §3.2), doğum yılı var');
    });
    eq(lines(CVPdf.build({ name: 'K', military: 'Muaf' }, { template: 'sade', lang: 'en' }).content).join('|').indexOf('PERSONAL'), -1, 'en: yalnızca askerlik varsa Kişisel Bilgiler bölümü yok');
  })();

  /* =================================================================== dosya adı ve meta veri */
  print('# fileName / info');
  eq(CVPdf.fileName({ name: 'Ayşe Kaya' }), 'Ayse-Kaya-CV.pdf', 'fileName tire');
  eq(CVPdf.fileName({ name: 'Ayşe Kaya' }, { suffix: 'Kuzey Lojistik' }), 'Ayse-Kaya-CV-Kuzey-Lojistik.pdf', 'fileName uyarlanmış sürüm');
  eq(CVPdf.fileName({ name: 'Ayşe Kaya' }, { kind: 'letter' }), 'Ayse-Kaya-On-Yazi.pdf', 'fileName ön yazı');
  eq(CVPdf.fileName({ name: 'Ayşe Kaya' }, { kind: 'letter', suffix: 'Kuzey A.Ş.' }), 'Ayse-Kaya-On-Yazi-Kuzey-A-S.pdf', 'fileName ön yazı + firma');
  eq(CVPdf.fileName({ name: 'Ayşe Kaya' }, { kind: 'letter', lang: 'en' }), 'Ayse-Kaya-Cover-Letter.pdf', 'fileName ön yazı en');
  eq(CVPdf.fileName({ name: '' }), 'CV.pdf', 'fileName boş ad');
  eq(CVPdf.fileName(null, { suffix: 'X' }), 'CV-X.pdf', 'fileName null cv + ek');
  eq(CVPdf.fileName({ name: "José O'Neil-Çakır" }), 'Jose-ONeil-Cakir-CV.pdf', 'fileName aksan/kesme');
  eq(CVPdf.build({ name: 'Ayşe Kaya', title: 'Muhasebe Uzmanı' }).info.title, 'Ayşe Kaya — Muhasebe Uzmanı — CV', 'info.title "Ad Soyad — Unvan — CV"');
  eq(CVPdf.build({ name: 'Ayşe Kaya' }).info.title, 'Ayşe Kaya — CV', 'info.title ünvansız');
  eq(CVPdf.build({}).info.title, 'CV', 'info.title boş');

  /* =================================================================== varsayılan şablon */
  print('# defaultTemplate / TEMPLATES');
  eq(CVPdf.defaultTemplate('yazilim'), 'sade', 'yazılım → sade');
  eq(CVPdf.defaultTemplate('deneyimli', { lang: 'en' }), 'sade', 'İngilizce → sade');
  eq(CVPdf.defaultTemplate('ogrenci'), 'klasik', 'öğrenci → klasik');
  eq(CVPdf.defaultTemplate('saha'), 'klasik', 'saha → klasik');
  eq(CVPdf.defaultTemplate('deneyimli'), 'klasik', 'deneyimli → klasik');
  eq(CVPdf.defaultTemplate(), 'klasik', 'profil yok → klasik');
  eq(CVPdf.defaultTemplate('deneyimli', { upload: true }), 'sade', '"İlan sitesine yükleyeceğim" → sade');
  eq(CVPdf.TEMPLATES[0].id, 'klasik', 'klasik ilk');
  eq(CVPdf.TEMPLATES[CVPdf.TEMPLATES.length - 1].id, 'modern', 'modern son, hiçbir zaman varsayılan değil');
  same(CVPdf.PROFILES, PROFILES, 'PROFILES');

  /* =================================================================== modern akış sırası ve kenar çubuğu */
  print('# modern');
  (function () {
    var cv = clone(CVPdf.SAMPLE); cv.photo = JPG;
    var dd = CVPdf.build(cv, { template: 'modern' });
    var l = lines(dd.content);
    var firstHead = l.indexOf('PROFİL');
    ok([cv.name, cv.phone, cv.email].every(function (v) { var i = l.join('\n').indexOf(v); return i >= 0 && i < l.join('\n').indexOf('PROFİL'); }), 'modern: ad, telefon, e-posta ilk bölümden önce');
    ok(l.indexOf(cv.name) === 0 && firstHead > 0, 'modern: akışta ilk metin ad (tam genişlik başlık önce)');
    var cols = modernCols(dd);
    var mainLast = lines(cols[0]).length, all = l;
    ok(all.indexOf('İŞ DENEYİMİ') < all.indexOf('YETENEKLER') && all.indexOf('EĞİTİM') < all.indexOf('YETENEKLER'), 'modern: ana sütun kenar çubuğundan önce akar');
    ok(mainLast > 0 && lines(cols[1]).indexOf('YETENEKLER') === 0, 'modern: kenar çubuğu Yetenekler ile başlar (iletişim yok)');
    eq(find(cols[1], function (n) { return typeof n.link === 'string'; }).length, 0, 'modern: kenar çubuğunda iletişim/bağlantı yok');
    var hdr = dd.content[0];
    ok(hdr.columns && hdr.columns[1].width === 84 && typeof hdr.columns[1].svg === 'string', 'modern: başlıkta sağda 84pt yuvarlak foto');
    // koyu kenar çubuğu
    var dark = CVPdf.build(CVPdf.SAMPLE, { template: 'modern', sidebar: 'dark', accent: '#23395B' });
    eq(dark.background(2, { height: 841.89 }).canvas[0].color, '#23395B', 'modern dark: zemin vurgu rengi');
    ok(find(modernCols(dark)[1], function (n) { return n.text === 'Proje planlama'; })[0].node.color === '#ffffff', 'modern dark: beyaz metin');
    eq(CVPdf.build(CVPdf.SAMPLE, { template: 'modern', sidebar: 'x' }).background(2, { height: 841.89 }).canvas[0].color, CVPdf.mix('#1F5C4A', '#ffffff', 0.9), 'modern: bilinmeyen sidebar → açık');
    // yazı boyutları (§8 C8: 10 / 9.5 / 9)
    var light = CVPdf.build(CVPdf.SAMPLE, { template: 'modern' });
    eq(light.defaultStyle.fontSize, 10, 'modern: ana sütun 10pt');
    ok(find(modernCols(light)[1], function (n) { return n.text === 'Proje planlama'; })[0].node.fontSize === 9.5, 'modern: kenar çubuğu 9.5pt');
    ok(find(modernCols(light)[0], function (n) { return n.text === 'Mart 2021 – Günümüz'; })[0].node.fontSize === 9, 'modern: tarih 9pt');
  })();

  // Klasik fotoğraf 3:4, sade asla
  (function () {
    var cv = clone(CVPdf.SAMPLE); cv.photo = JPG;
    var k = find(CVPdf.build(cv, { template: 'klasik' }).content, function (n) { return n.image !== undefined; });
    ok(k.length === 1 && k[0].node.fit[0] === 68 && k[0].node.fit[1] === 91, 'klasik: fit [68, 91]');
    eq(find(CVPdf.build(cv, { template: 'sade', showPhoto: true }).content, function (n) { return n.image !== undefined || n.svg !== undefined; }).length, 0, 'sade: fotoğraf yok');
  })();

  // Şablon başlık stilleri ve tipografi (brief §4.1, §4.3–4.5)
  (function () {
    var s = CVPdf.build(CVPdf.SAMPLE, { template: 'sade' }), k = CVPdf.build(CVPdf.SAMPLE, { template: 'klasik' });
    var sh = find(s.content, function (n) { return n.text === 'İŞ DENEYİMİ'; })[0].node;
    ok(sh.fontSize === 10.5 && sh.bold && sh.characterSpacing === 0, 'sade: başlık 10.5 Medium, aralık 0');
    var kh = find(k.content, function (n) { return n.text === 'İŞ DENEYİMİ'; })[0].node;
    ok(kh.fontSize === 8.5 && kh.bold && kh.characterSpacing === 0.6, 'klasik: oluk başlığı 8.5 Medium, aralık 0.6');
    var role = find(k.content, function (n) { return n.text === 'Kıdemli Proje Yöneticisi' && n.bold; })[0].node;
    eq(role.fontSize, 10.5, 'klasik: ünvan 10.5');
    ok(find(k.content, function (n) { return n.text === 'Mart 2021 – Günümüz' && n.noWrap && n.fontSize === 9 && n.color === MUTED; }).length === 1, 'klasik: tarih sağda 9pt MUTED noWrap');
    var spacings = [];
    TPLS.forEach(function (tpl) { walk(CVPdf.build(CVPdf.SAMPLE, { template: tpl }).content, function (v) { if (v && typeof v.characterSpacing === 'number' && v.fontSize) spacings.push(v.characterSpacing / v.fontSize); }); });
    ok(spacings.every(function (x) { return x <= 0.08 + 1e-9; }), 'harf aralığı ≤ 0.08 em (brief §4.1)');
    TPLS.forEach(function (tpl) {
      var dd = CVPdf.build(CVPdf.SAMPLE, { template: tpl });
      same(dd.defaultStyle.fontFeatures, { liga: false }, tpl + ': bitişik harf (fi) kapalı');
      eq(dd.defaultStyle.lineHeight, 1.15, tpl + ': satır aralığı 1.15');
      var small = [];
      walk(dd.content, function (v) { if (v && typeof v.fontSize === 'number' && v.text !== undefined && v.fontSize < 8.5) small.push(v.fontSize); });
      eq(small.length, 0, tpl + ': 8.5pt altında metin yok (altbilgi hariç)');
      var serif = [];
      walk(dd.content, function (v) { if (v && v.font === 'DMSerif') serif.push(v.fontSize); });
      ok(serif.every(function (f) { return f >= 13; }), tpl + ': DM Serif yalnızca ≥13pt');
      eq(JSON.stringify(dd).indexOf('"header"'), -1, tpl + ': pdfmake header kullanılmaz');
    });
  })();

  /* =================================================================== örnek CV'ler */
  print('# SAMPLES');
  same(Object.keys(CVPdf.SAMPLES), PROFILES, 'SAMPLES anahtarları');
  eq(CVPdf.SAMPLES.deneyimli, CVPdf.SAMPLE, 'SAMPLES.deneyimli = SAMPLE (Emre Aksoy)');
  eq(CVPdf.SAMPLE.name, 'Emre Aksoy', 'SAMPLE Emre Aksoy');
  PROFILES.forEach(function (pr) {
    var cv = CVPdf.SAMPLES[pr];
    ok(CVPdf.hasContent(cv), pr + ': içerik var');
    ['name', 'title', 'phone', 'email', 'city', 'summary', 'skills', 'langs'].forEach(function (f) { ok(typeof cv[f] === 'string' && cv[f].trim() !== '', pr + '.' + f + ' dolu'); });
    ok(/@example\.com$/.test(cv.email), pr + ': e-posta example.com');
    ok(Array.isArray(cv.jobs) && cv.jobs.length >= 1 && Array.isArray(cv.edu) && cv.edu.length >= 1 && Array.isArray(cv.projects), pr + ': iş/eğitim/proje dizileri');
    var ld = P.parseLanguageDetails(cv.langs);
    ok(ld.some(function (d) { return d.cefr; }), pr + ': CEFR örneği var');
    if (pr !== 'saha') ok(ld.some(function (d) { return d.exam; }), pr + ': dil sınavı örneği var');
    ok(cv.jobs.every(function (j) { return j.id && j.role && j.company && j.start && j.end; }), pr + ': işler eksiksiz');
    ['klasik', 'sade', 'modern'].forEach(function (tpl) {
      var dd = CVPdf.build(cv, { template: tpl, profile: pr });
      ok(lines(dd.content).length > 10, pr + '/' + tpl + ': build');
    });
  });
  (function () {
    var s = CVPdf.SAMPLES.saha, o = CVPdf.SAMPLES.ogrenci, y = CVPdf.SAMPLES.yazilim;
    ok(/forklift/i.test(s.title), 'saha: forklift operatörü');
    ['B Sınıfı Sürücü Belgesi', 'Forklift Operatör Belgesi', 'SRC', 'Psikoteknik'].forEach(function (x) { ok(s.certs.indexOf(x) >= 0, 'saha: ' + x); });
    ok(o.edu.some(function (e) { return e.note.indexOf('3,41 / 4,00') >= 0; }), 'öğrenci: GNO 3,41 / 4,00');
    ok(/4\. sınıf|öğrenci/i.test(o.summary + o.title), 'öğrenci: son sınıf öğrencisi');
    ok(o.jobs.some(function (j) { return /stajyer/i.test(j.role); }) && o.projects.length >= 1, 'öğrenci: staj ve projeler');
    ok(CVPdf.skillGroups(y.skills).length >= 3 && CVPdf.skillGroups(y.skills).every(function (g) { return g.label; }), 'yazılım: gruplu yetenekler');
    ok(y.projects.length >= 2 && y.projects.every(function (p) { return /^github\.com\//.test(p.link); }), 'yazılım: GitHub projeleri');
    ok(/^github\.com\//.test(y.github), 'yazılım: GitHub profili');
  })();

  /* =================================================================== ön yazı */
  print('# ön yazı');
  (function () {
    var LS = CVPdf.LETTER_SAMPLE;
    ok(Array.isArray(LS.recipient) && LS.recipient.length === 3 && LS.paragraphs.length >= 3 && LS.paragraphs.length <= 4, 'LETTER_SAMPLE biçimi');
    var words = LS.paragraphs.join(' ').split(/\s+/).length;
    ok(words >= 200 && words <= 300, 'LETTER_SAMPLE 200–300 sözcük (' + words + ')');
    ok(/^Konu: .* pozisyonu başvurusu$/.test(LS.subject) && LS.greeting === 'Sayın İlgili,' && LS.closing === 'Saygılarımla,', 'LETTER_SAMPLE konu, hitap, kapanış');
    var letter = clone(LS); letter.date = '21 Ekim 2026';
    TPLS.forEach(function (tpl) {
      var dd = CVPdf.buildLetter(letter, CVPdf.SAMPLE, { template: tpl });
      var l = lines(dd.content);
      same(dd.pageMargins, [71, 64, 71, 57], tpl + ': ön yazı kenar boşlukları');
      eq(dd.footer, undefined, tpl + ': ön yazıda altbilgi yok');
      eq(dd.info.title, 'Emre Aksoy — Kıdemli Proje Yöneticisi — Ön Yazı', tpl + ': ön yazı info.title');
      var order = ['Emre Aksoy', '21 Ekim 2026', 'Kuzey Lojistik A.Ş.', 'İnsan Kaynakları', 'İzmir', LS.subject, 'Sayın İlgili,'].concat(LS.paragraphs).concat(['Saygılarımla,', 'Emre Aksoy']);
      var pos = -1, inOrder = true;
      order.forEach(function (t, i) { var at = l.indexOf(t, i === order.length - 1 ? pos + 1 : Math.max(0, pos)); if (at <= pos && !(i === 0 && at === 0)) inOrder = false; pos = at; });
      ok(inOrder, tpl + ': öğe sırası (başlık, tarih, alıcı, konu, hitap, paragraflar, kapanış, ad)');
      var date = find(dd.content, function (n) { return n.text === '21 Ekim 2026'; })[0].node;
      eq(date.alignment, 'right', tpl + ': tarih sağda');
      var subj = find(dd.content, function (n) { return n.text === LS.subject; })[0].node;
      ok(subj.bold && subj.fontSize === 10.5, tpl + ': konu Medium 10.5');
      var body = find(dd.content, function (n) { return Array.isArray(n.stack) && n.stack.some(function (x) { return x.text === LS.paragraphs[0]; }); })[0].node;
      ok(body.fontSize === 11 && body.lineHeight === 1.2, tpl + ': gövde 11pt, satır aralığı ≈1.4×');
      ok(body.stack.slice(2).every(function (p) { return p.margin[1] === 8; }), tpl + ': paragraflar arası 8pt');
      var name = find(dd.content, function (n) { return n.text === 'Emre Aksoy' && n.bold && n.fontSize === undefined && !n.font; });
      ok(name.length === 1, tpl + ': imza adı Medium (gövde puntosunda)');
      eq(find(dd.content, function (n) { return n.image !== undefined || n.svg !== undefined; }).length, 0, tpl + ': ön yazıda fotoğraf yok');
      ok(lines(dd.content).indexOf('PROFİL') < 0, tpl + ': CV bölümü yok');
      var fit = CVPdf.letterLayout(letter, CVPdf.SAMPLE, { template: tpl });
      ok(fit.fits && fit.fontSize === 11 && fit.paraGap === 8, tpl + ': örnek ön yazı küçültmeden sığar');
      if (tpl === 'klasik') ok(find(dd.content, function (n) { return Array.isArray(n.canvas) && n.canvas[0].lineWidth === 1.2; }).length === 1, 'klasik ön yazı: 1.2pt çizgi');
      if (tpl === 'modern') {
        ok(find(dd.content, function (n) { return n.characterSpacing === 0.7 && n.text === 'KIDEMLİ PROJE YÖNETİCİSİ'; }).length === 1, 'modern ön yazı: modern başlık');
        eq(dd.background, undefined, 'modern ön yazı: kenar çubuğu yok');
      }
      if (tpl === 'sade') ok(find(dd.content, function (n) { return n.text === 'Emre Aksoy' && n.fontSize === 22; }).length === 1, 'sade ön yazı: sade başlık');
    });
    // Tek sayfa: önce paragraf aralığı, sonra punto (taban 10), en son satır aralığı ve sabit boşluklar.
    var MORE = 'Depo dönüşümünde ekip, bütçe ve takvim hedeflerini birlikte izledik ve her ay yönetime raporladık.';
    function longer(n) {
      var L = clone(letter);
      for (var i = 0; i < n; i++) L.paragraphs[i % 3 + 1] += ' ' + MORE;
      return L;
    }
    var ORDER = ['11/8', '11/6', '11/4', '10.5/4', '10/4', '10/3c'];
    var states = [], seen = [];
    for (var n = 0; n <= 40; n++) {
      var f = CVPdf.letterLayout(longer(n), CVPdf.SAMPLE, { template: 'klasik' });
      seen.push(f);
      var st = f.fontSize + '/' + f.paraGap + (f.compact ? 'c' : '');
      if (states[states.length - 1] !== st) states.push(st);
      if (n % 8 === 0) {
        var dd2 = CVPdf.buildLetter(longer(n), CVPdf.SAMPLE, { template: 'klasik' });
        var body2 = find(dd2.content, function (x) { return Array.isArray(x.stack) && x.stack.some(function (y) { return y.text === letter.paragraphs[0]; }); })[0].node;
        ok(body2.fontSize === f.fontSize && body2.lineHeight === f.lineHeight && body2.stack[2].margin[1] === f.paraGap, 'ön yazı +' + n + ' cümle: docDefinition seçilen ölçüleri kullanır');
      }
    }
    ok(seen.every(function (f) { return f.fontSize >= 10; }), 'ön yazı: punto hiçbir zaman 10\'un altına inmez');
    ok(states.every(function (s, i) { return ORDER.indexOf(s) >= 0 && (i === 0 || ORDER.indexOf(s) > ORDER.indexOf(states[i - 1])); }), 'ön yazı adımları sırayla: ' + states.join(' → '));
    // 6 kısa paragraf (5 aralık): aralığı daraltmak bir satırlık taşmayı karşılar → punto 11'de kalır.
    var six = clone(letter), sixStates = [];
    six.paragraphs = [MORE, MORE, MORE, MORE, MORE, MORE];
    for (var w = 0; w < 400; w += 3) {
      var g = CVPdf.letterLayout(six, CVPdf.SAMPLE, { template: 'klasik' });
      var gs = g.fontSize + '/' + g.paraGap + (g.compact ? 'c' : '');
      if (sixStates[sixStates.length - 1] !== gs) sixStates.push(gs);
      six.paragraphs[w % 6] += ' kelime ve cümle';
    }
    ok(sixStates.indexOf('11/6') >= 0 || sixStates.indexOf('11/4') >= 0, 'önce paragraf aralığı daralır, punto 11 kalır: ' + sixStates.join(' → '));
    ok(sixStates.every(function (s, i) { return ORDER.indexOf(s) >= 0 && (i === 0 || ORDER.indexOf(s) > ORDER.indexOf(sixStates[i - 1])); }), 'adımlar sırayla (6 paragraf)');
    ok(states.indexOf('10.5/4') >= 0 || states.indexOf('10/4') >= 0, 'sonra punto küçülür (aralık 4pt)');
    ok(seen[0].fits && !seen[40].fits && seen[40].fontSize === 10 && seen[40].compact, 'çok uzun metin: fits:false, punto tabanda (10), sıkışık düzen');
    // varsayılanlar
    var bare = CVPdf.buildLetter({ paragraphs: ['Merhaba.'] }, { name: 'Ali Veli' }, {});
    var bl = lines(bare.content);
    ok(/^\d{1,2} (Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık) \d{4}$/.test(bl[1]), 'tarih verilmezse bugün, "21 Ekim 2026" biçimi (' + bl[1] + ')');
    ok(bl.indexOf('Sayın İlgili,') >= 0 && bl.indexOf('Saygılarımla,') >= 0 && bl.indexOf('Ali Veli') >= 0, 'varsayılan hitap/kapanış, ad cv.name\'den');
    eq(bl.filter(function (x) { return /^Konu:/.test(x); }).length, 0, 'konu boşsa satır yok');
    var en = lines(CVPdf.buildLetter({ paragraphs: ['Hello.'], subject: 'Data Analyst application' }, { name: 'Ali Veli' }, { lang: 'en' }).content);
    ok(/^\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/.test(en[1]), 'en tarih "21 October 2026" biçimi');
    ok(en.indexOf('Subject: Data Analyst application') >= 0 && en.indexOf('Dear Hiring Manager,') >= 0 && en.indexOf('Kind regards,') >= 0, 'en: önek ve varsayılanlar');
    ok(lines(CVPdf.buildLetter({ subject: 'Muhasebe Uzmanı pozisyonu başvurusu', paragraphs: ['x'] }, {}, {}).content).indexOf('Konu: Muhasebe Uzmanı pozisyonu başvurusu') >= 0, '"Konu:" öneki eklenir');
    ok(lines(CVPdf.buildLetter({ name: 'Başka Ad', paragraphs: ['x'] }, { name: 'Ali Veli' }, {}).content).indexOf('Başka Ad') >= 0, 'letter.name cv.name\'i ezer');
    ok(lines(CVPdf.buildLetter({ recipient: ['A', 'B', 'C', 'D', ''], paragraphs: ['x'] }, {}, {}).content).indexOf('D') < 0, 'alıcı en çok 3 satır');
    [null, undefined, 'x', {}].forEach(function (junk) {
      var r; try { r = CVPdf.buildLetter(junk, junk, junk); } catch (e) { r = null; }
      ok(r && Array.isArray(r.content), 'buildLetter çöp girdi atmaz (' + JSON.stringify(junk) + ')');
    });
  })();

  // Sürücü belgesi bir kez basılır: sertifikalarda geçiyorsa Kişisel Bilgiler satırı düşer.
  (function () {
    var base = { name: 'Kerem Demir', title: 'Backend Geliştirici', license: 'B', military: 'Yapıldı (2015)' };
    var withCert = Object.assign({}, base, { certs: 'AWS Certified Developer – Associate, 2024\nB Sınıfı Sürücü Belgesi' });
    ['klasik', 'sade', 'modern'].forEach(function (t) {
      var txt = JSON.stringify(CVPdf.build(withCert, { template: t }).content);
      eq((txt.match(/Sürücü Belgesi/g) || []).length, 1, t + ': sertifikada geçen ehliyet kişisel bilgilerde tekrar edilmez');
      ok(/Yapıldı \(2015\)/.test(txt), t + ': diğer kişisel bilgiler kalır');
      var only = JSON.stringify(CVPdf.build(base, { template: t }).content);
      ok(/Sürücü Belgesi/.test(only) && /"B"|B\b/.test(only), t + ': sertifikada yoksa kişisel bilgilerde basılır');
    });
  })();

  // Roboto'da olmayan karakterler PDF'e kutu olarak düşmez.
  (function () {
    var cv = { name: 'Kerem Demir', title: 'Backend ★ Geliştirici', summary: 'Hızlı ✓ sonuç 🚀 odaklı.',
      jobs: [{ role: 'Stajyer → Junior Yazılım Mühendisi', company: 'HAVELSAN', start: '2020', end: '2022',
               desc: '► Test kapsamını ‒ artırdım ✔\n● Raporları ⇒ hazırladım' }],
      skills: 'Go ➔ Kafka, ■ Docker', certs: 'AWS ☆ Developer' };
    ['klasik', 'sade', 'modern'].forEach(function (t) {
      var txt = JSON.stringify(CVPdf.build(cv, { template: t }).content);
      ok(!/[\u2012\u2190-\u21FF\u2500-\u27BF\u2605\u2606]|\\ud83d/i.test(txt), t + ': desteklenmeyen glif kalmaz');
      ok(txt.indexOf('Stajyer – Junior Yazılım Mühendisi') >= 0, t + ': ok işareti tireye döner');
      ok(txt.indexOf('Hızlı  sonuç  odaklı.') < 0 && txt.indexOf('Hızlı sonuç odaklı.') >= 0, t + ': atılan işaretler fazla boşluk bırakmaz');
    });
  })();

  print('pdfdoc-v2: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) throw new Error(failed + ' test başarısız');
})();
