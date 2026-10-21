/*
 * Sesli CV — pdfdoc.js  (global: CVPdf)
 *
 * CV verisini (SPEC "Data model") pdfmake 0.2.10 docDefinition nesnesine çevirir.
 * Saf veri üretir: DOM'a ve pdfMake'e yalnızca registerFonts() dokunur.
 * Bağımlılık: CVParse (parse.js). Çağrı anında okunur; yükleme sırası esnektir.
 *
 * pdfmake notu: pdfmake, düzen sırasında docDefinition düğümlerini değiştirir (_margin,
 * _inlines…). Bu yüzden build() her çağrıda tamamen yeni nesneler üretir; sabit stil
 * nesneleri yalnızca ilkel değerler taşır ve düğümlere kopyalanır.
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ sabitler */

  var INK = '#1d232a';
  var MUTED = '#5b6670';
  var RULE = '#d6dce1';
  var WHITE = '#ffffff';
  var PAGE = { width: 595.28, height: 841.89 }; // pdfmake 'A4' ölçüsü (pt)
  var SIDEBAR = 188;

  /*
   * pdfmake 0.2.10'da `unbreakable` blok, yüksekliği NaN olan ayrı bir bağlamda dizilir
   * (ElementWriter.pushContext, `getCurrentPage().height` tanımsız) ve bu yüzden kendi içinde hiç
   * sayfa atlamaz. Commit sırasında blok kalan alana sığmazsa yeni sayfaya taşınır; yeni sayfaya da
   * sığmazsa PageElementWriter.addFragment ikinci denemenin sonucunu yok sayar ve blok TAMAMEN
   * kaybolur. Ayrıca taşınan blok önceki sayfada kendi yüksekliği kadar boşluk bırakır.
   * Bu yüzden birlikte tutulacak blok tahminen bir sayfanın ~%40-45'ini aşarsa (aşırı uzun tek
   * madde/paragraf) bölünebilir bırakılır: yetim başlık, kaybolan metinden ve yarım boş sayfadan iyidir.
   * Hesap: 9.5pt Roboto'da ortalama ~4.75pt/karakter → genişlik × 4.5 karakter ≈ 22-23 satır
   * (≈ 320pt, A4 içeriğinin ~%42'si). Tamamı büyük harf/geniş harfli metinde bile (~×1.4) bir
   * sayfanın ~%60'ında kalır. Sonuç: kenar çubuğu (148pt) ≈ 660, modern ana sütun ≈ 1570,
   * klasik içerik (373pt) ≈ 1680, sade (483pt) ≈ 2170 karakter.
   */
  function keepLimit(width) { return Math.floor(width * 4.5); }

  var TEMPLATES = [
    { id: 'modern', tr: 'Modern', en: 'Modern', photo: true },
    { id: 'klasik', tr: 'Klasik', en: 'Classic', photo: true },
    { id: 'sade', tr: 'Sade (ATS)', en: 'Plain (ATS)', photo: false }
  ];

  var ACCENTS = ['#1F5C4A', '#23395B', '#7A2E3A', '#36404A', '#7A5212'];

  var MARGINS = {
    modern: [0, 34, 0, 34],
    klasik: [50, 46, 50, 50],
    sade: [56, 50, 56, 50]
  };

  var LABELS = {
    tr: {
      contact: 'İletişim', profile: 'Profil', experience: 'İş Deneyimi', education: 'Eğitim',
      skills: 'Yetenekler', languages: 'Diller', certs: 'Sertifikalar ve Kurslar',
      hobbies: 'Hobiler', refs: 'Referanslar', personal: 'Kişisel Bilgiler',
      birth: 'Doğum Tarihi', military: 'Askerlik Durumu', license: 'Sürücü Belgesi',
      marital: 'Medeni Durum', phone: 'Telefon', email: 'E-posta', city: 'Konum', web: 'Web'
    },
    en: {
      contact: 'Contact', profile: 'Profile', experience: 'Experience', education: 'Education',
      skills: 'Skills', languages: 'Languages', certs: 'Certifications',
      hobbies: 'Interests', refs: 'References', personal: 'Personal Details',
      birth: 'Date of Birth', military: 'Military Service', license: 'Driving Licence',
      marital: 'Marital Status', phone: 'Phone', email: 'Email', city: 'Location', web: 'Web'
    }
  };
  // Uygulama tarafı veri modelindeki alan adlarıyla da erişebilsin diye takma adlar.
  var LABEL_ALIASES = { summary: 'profile', jobs: 'experience', edu: 'education', langs: 'languages', location: 'city' };

  /* ------------------------------------------------------------- örnek CV */

  // Kurgusal kişi ve şirketler; e-postalar ayrılmış example.com alan adında.
  var SAMPLE = {
    name: 'Emre Aksoy',
    title: 'Kıdemli Proje Yöneticisi',
    phone: '0532 123 45 67',
    email: 'emre.aksoy@example.com',
    city: 'İstanbul',
    web: 'linkedin.com/in/emre-aksoy-ornek',
    photo: '',
    summary: 'Lojistik ve perakende sektörlerinde 10 yılı aşkın deneyime sahip, PMP sertifikalı bir ' +
      'proje yöneticisiyim. Depo yönetimi, ERP ve mağaza teknolojileri alanlarında çok paydaşlı ' +
      'dönüşüm projelerini bütçe ve takvim hedeflerine sadık kalarak teslim ettim. Ekipleri ortak bir ' +
      'hedef etrafında buluşturmayı, riskleri erkenden görünür kılmayı ve süreçleri ölçülebilir ' +
      'sonuçlarla iyileştirmeyi önemsiyorum.',
    jobs: [
      {
        id: 'ornek-is-1', role: 'Kıdemli Proje Yöneticisi', company: 'Atlas Lojistik A.Ş.', city: 'İstanbul',
        start: 'Mart 2021', end: 'Devam ediyor',
        desc: 'Depo yönetim sistemi dönüşümünü 12 kişilik çapraz fonksiyonlu bir ekiple 9 ayda ve bütçe dahilinde tamamladım.\n' +
          'Sipariş hazırlama süresini %27 kısaltan süreç iyileştirmelerini planlayıp 6 depoda hayata geçirdim.\n' +
          'Yıllık 4,2 milyon TL bütçeli proje portföyünün planlama, risk takibi ve yönetim raporlamasını üstlendim.\n' +
          'Nakliye firmalarıyla sözleşmeleri yeniden müzakere ederek yıllık taşıma maliyetlerini %11 düşürdüm.'
      },
      {
        id: 'ornek-is-2', role: 'Proje Yöneticisi', company: 'Kuzey Perakende Grubu', city: 'İstanbul',
        start: 'Haziran 2018', end: 'Şubat 2021',
        desc: '48 mağazada yeni kasa ve stok sisteminin kurulumunu planlanandan iki hafta önce tamamladım.\n' +
          'Scrum uygulamalarını üç ekibe yaygınlaştırarak sprint hedeflerine ulaşma oranını %68’den %91’e çıkardım.\n' +
          'Haftalık yönetim raporlarını Power BI panolarına taşıyarak raporlamaya harcanan süreyi yarıya indirdim.'
      },
      {
        id: 'ornek-is-3', role: 'İş Analisti', company: 'Ege Yazılım Teknolojileri', city: 'İzmir',
        start: 'Ekim 2015', end: 'Mayıs 2018',
        desc: 'ERP uyarlama projelerinde 30’dan fazla iş sürecini analiz ederek gereksinim dokümanlarını hazırladım.\n' +
          'Kullanıcı kabul testlerini koordine ettim; canlıya geçiş sonrası hata bildirimleri %40 azaldı.\n' +
          'Müşteri ekiplerine toplam 150 saati aşkın kullanıcı eğitimi verdim.'
      }
    ],
    edu: [
      {
        id: 'ornek-egitim-1', school: 'Marmara Üniversitesi', program: 'İşletme', degree: 'Yüksek Lisans',
        start: '2019', end: '2021', note: 'Tezsiz MBA programı'
      },
      {
        id: 'ornek-egitim-2', school: 'Dokuz Eylül Üniversitesi', program: 'Endüstri Mühendisliği', degree: 'Lisans',
        start: '2010', end: '2014', note: 'GNO 3,21 / 4'
      }
    ],
    skills: 'Proje planlama, Risk yönetimi, Agile / Scrum, Paydaş yönetimi, Bütçe takibi, MS Project, Jira, ' +
      'Power BI, SAP MM, İleri düzey Excel',
    langs: 'Türkçe ana dil, İngilizce ileri (C1), Almanca başlangıç (A2)',
    certs: 'PMP – Project Management Professional, PMI (2020)\n' +
      'Professional Scrum Master I (PSM I), Scrum.org (2019)\n' +
      'Power BI ile Veri Analizi ve Raporlama, 32 saat (2022)',
    hobbies: 'Doğa yürüyüşü, Analog fotoğrafçılık, Satranç, Gönüllü kodlama atölyeleri',
    refs: 'Selin Arıkan — Operasyon Direktörü, Atlas Lojistik A.Ş. · selin.arikan@example.com\n' +
      'Murat Tekin — Bilgi Teknolojileri Müdürü, Kuzey Perakende Grubu · murat.tekin@example.com',
    birth: '14 Mayıs 1991',
    military: 'Yapıldı (2015)',
    license: 'B sınıfı',
    marital: ''
  };

  /* ------------------------------------------------------------- yardımcılar */

  function isObj(v) { return v !== null && typeof v === 'object'; }
  function arr(v) { return Array.isArray(v) ? v : []; }

  // Yaprak değerler string olmalı; sayılar kabul edilir, geri kalan her şey '' sayılır.
  function str(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && isFinite(v)) return String(v);
    return '';
  }
  function oneLine(v) { return str(v).replace(/\s+/g, ' ').trim(); }
  function cleanItems(list) { return arr(list).map(oneLine).filter(Boolean); }
  function paragraphs(v) { return str(v).split(/\n+/).map(oneLine).filter(Boolean); }

  /*
   * pdfmake yalnızca JPEG/PNG gömebilir; başka her şey (URL, webp…) yok sayılır. İki tuzak:
   * - pdfmake 0.2.10 data URL'yi büyük/küçük harfe duyarlı bir regex'le tanır
   *   (DocMeasure.convertIfBase64Image: /^data:image\/(jpeg|jpg|png);base64,/); "data:image/JPEG"
   *   tanınmaz ve vfs'te dosya adı olarak aranır → createPdf hata verir. Öneki küçük harfe çeviririz.
   * - pdfkit (PDFImage.open) biçimi etiketten değil baytlardan anlar; JPEG/PNG olmayan bir veri
   *   (webp, gif, bozuk base64) "Unknown image format" hatasıyla tüm PDF'i düşürür. Bu yüzden
   *   base64 verinin başı JPEG (FF D8 FF → "/9j/") ya da PNG (89 50 4E 47 → "iVBORw0KGgo")
   *   imzası taşımalı; etiket gerçek türe göre yeniden yazılır.
   */
  var DATA_URL_RE = /^data:image\/(?:png|jpe?g);base64,/i;
  function imageKind(v) {
    if (typeof v !== 'string') return '';
    var m = DATA_URL_RE.exec(v);
    if (!m) return '';
    var data = v.slice(m[0].length);
    if (/^\/9j\//.test(data)) return 'jpeg';
    if (/^iVBORw0KGgo/.test(data)) return 'png';
    return '';
  }
  // Geçerliyse pdfmake'in tanıyacağı biçimde (küçük harf, gerçek tür) data URL'yi, değilse '' döner.
  function cleanImage(v) {
    var kind = imageKind(v);
    return kind ? 'data:image/' + kind + ';base64,' + v.slice(DATA_URL_RE.exec(v)[0].length) : '';
  }

  // Tanımsız değerleri atlayarak kopyala (docDefinition'da `undefined` istemiyoruz).
  function ext(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) target[k] = src[k];
      }
    }
    return target;
  }

  /* renkler */

  function parseHex(h) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str(h).trim());
    if (!m) return null;
    var x = m[1];
    if (x.length === 3) x = x.charAt(0) + x.charAt(0) + x.charAt(1) + x.charAt(1) + x.charAt(2) + x.charAt(2);
    return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
  }
  function toHex(rgb) {
    var s = '#';
    for (var i = 0; i < 3; i++) {
      var v = Math.max(0, Math.min(255, Math.round(rgb[i])));
      s += (v < 16 ? '0' : '') + v.toString(16);
    }
    return s;
  }
  /**
   * mix(a, b, t) — iki hex rengi doğrusal karıştırır: t=0 → a, t=1 → b (küçük harf hex döner).
   * Saydamlık yerine düz ton kullanıyoruz: baskıda ve PDF görüntüleyicilerde her yerde aynı görünür.
   * Geçersiz renk → diğeri; ikisi de geçersizse INK. t sayı değilse 0, [0,1] dışına taşarsa kırpılır.
   */
  function mix(a, b, t) {
    var A = parseHex(a), B = parseHex(b);
    if (!A && !B) return INK;
    if (!A) return toHex(B);
    if (!B) return toHex(A);
    t = Number(t);
    if (!isFinite(t)) t = 0;
    t = Math.max(0, Math.min(1, t));
    return toHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
  }

  /* büyük harf (Türkçe kuralları elle; bazı motorlarda tr-TR yerel ayarı yok) */

  function trUpper(s) { return str(s).replace(/i/g, 'İ').replace(/ı/g, 'I').toUpperCase(); }
  function upperLabel(s, lang) { return lang === 'en' ? str(s).toUpperCase() : trUpper(s); }

  var TR_LETTERS = /[çğıöşüâîûÇĞİÖŞÜÂÎÛ]/;
  var EN_TITLE_WORDS = new RegExp('\\b(engineer|developer|manager|director|designer|specialist|analyst|scientist|' +
    'consultant|officer|executive|assistant|senior|junior|lead|head|chief|intern|software|data|product|' +
    'marketing|sales|account|business|support|customer|operations|project|architect|administrator|' +
    'coordinator|associate|representative|technician|full[- ]?stack|front[- ]?end|back[- ]?end|devops)\\b', 'i');
  /**
   * Kullanıcı metnini (ör. ünvan) büyük harfe çevirir. Türkçe harf içeriyorsa Türkçe kural;
   * içermiyorsa ve CV İngilizce ya da metin bariz İngilizce bir ünvansa ("Software Engineer")
   * İngilizce kural ("SOFTWARE ENGINEER", "ENGİNEER" değil); aksi halde Türkçe ("Mimar" → "MİMAR").
   */
  function upperText(s, lang) {
    s = str(s);
    if (TR_LETTERS.test(s)) return trUpper(s);
    if (lang === 'en' || EN_TITLE_WORDS.test(s)) return s.toUpperCase();
    return trUpper(s);
  }

  /* web / e-posta */

  function webDisplay(w) { return w.replace(/^https?:\/\//i, '').replace(/\/+$/, ''); }
  function webHref(w) { return /^https?:\/\//i.test(w) ? w : 'https://' + w; }

  /* düğüm yardımcıları */

  function hline(width, lineWidth, color, margin) {
    return {
      canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: lineWidth, lineColor: color }],
      margin: margin
    };
  }

  function textLength(x) {
    if (typeof x === 'string') return x.length;
    if (Array.isArray(x)) {
      var n = 0;
      for (var i = 0; i < x.length; i++) n += textLength(x[i]);
      return n;
    }
    if (isObj(x)) return textLength(x.text) + textLength(x.stack) + textLength(x.columns) + textLength(x.ul);
    return 0;
  }

  /** Düğümleri tek parça tutan yığın (sayfa sonunda bölünmez). */
  function keepTogether(nodes, limit) {
    var n = { stack: nodes };
    if (textLength(nodes) <= limit) n.unbreakable = true;
    return n;
  }

  /**
   * Bölüm akışı: başlık + ilk maddenin "baş"ı birlikte (yetim başlık yok), sonraki her maddenin
   * başı kendi içinde bölünmez, maddelerin "kalan"ı (2. ve sonraki madde imleri) serbest akar.
   * items: [{ head: [düğüm], rest: [düğüm] }]; limit: keepLimit(sütun genişliği).
   */
  function flow(heading, items, gap, limit) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var block = keepTogether(i === 0 ? [heading].concat(it.head) : it.head, limit);
      if (i > 0 && gap) block.margin = [0, gap, 0, 0];
      out.push(block);
      for (var r = 0; r < it.rest.length; r++) out.push(it.rest[r]);
    }
    return out;
  }

  /** Madde işaretli liste; S: şablon stili (yalnızca ilkel değerler). */
  function bulletList(items, S, margin) {
    var n = {
      ul: items.map(function (b) { return { text: b, margin: [0, 0, 0, S.bulletGap] }; }),
      fontSize: S.bulletSize,
      margin: margin
    };
    if (S.bulletColor) n.color = S.bulletColor;
    if (S.markerColor) n.markerColor = S.markerColor;
    if (S.markerType) n.type = S.markerType;
    return n;
  }

  /** Tek madde başı + kalanı ayrı akan madde işaretli liste (sertifikalar, yetenekler). */
  function listItems(list, S) {
    var rest = list.length > 1 ? [bulletList(list.slice(1), S, [0, 0, 0, 0])] : [];
    return [{ head: [bulletList([list[0]], S, [0, 0, 0, 0])], rest: rest, lines: 1 }];
  }

  // Program + derece: "Endüstri Mühendisliği (Lisans)". Parantez zaten varsa iç içe parantez
  // yerine virgül: "İşletme (MBA), Yüksek Lisans".
  function eduHeading(program, degree) {
    if (program && degree) {
      return /[()]/.test(program + degree) ? program + ', ' + degree : program + ' (' + degree + ')';
    }
    return program || degree;
  }

  /**
   * İş/eğitim maddesi. heading boşsa ve tarih varsa tarih ilk satıra geçer.
   * S.dateInSub (sade): tarih ikinci satırda düz metin olarak, sütun kullanılmaz (ATS dostu).
   */
  function entryItem(heading, subParts, range, note, bullets, S) {
    var head = [];
    if (S.dateInSub) {
      if (heading) head.push(ext({ text: heading }, S.role));
      var line2 = [subParts.join(S.subSep), range].filter(Boolean).join(' | ');
      if (line2) head.push(ext({ text: line2, margin: [0, heading ? 1 : 0, 0, 0] }, S.sub));
    } else {
      if (heading && range && sideBySide(heading, S.role, range, S.date, 10, S.width, 0.45)) {
        // noWrap: pdfmake 'auto' sütunu, sol metin uzunsa min/max arası bir genişliğe sıkıştırır
        // (ColumnCalculator, 3. durum) ve tarih "Mart 2021 –" / "Günümüz" diye ikiye bölünür.
        // noWrap ile tarihin min genişliği = tam genişlik; kaydırma yalnızca ünvanda olur.
        head.push({
          columns: [
            ext({ width: '*', text: heading }, S.role),
            ext({ width: 'auto', text: range, noWrap: true, margin: [10, S.dateTop, 0, 0] }, S.date)
          ],
          columnGap: 0
        });
      } else if (heading && range) {
        // Yan yana sığmıyor (çok uzun tek kelimeli ünvan ya da serbest metin tarih): sütunlar
        // sayfa dışına taşmasın diye tarih ünvanın altına, ayrı satıra iner.
        head.push(ext({ text: heading }, S.role));
        head.push(ext({ text: range, margin: [0, 1, 0, 0] }, S.date));
      } else if (heading) {
        head.push(ext({ text: heading }, S.role));
      } else if (range) {
        head.push(ext({ text: range }, S.date));
      }
      var sub = subParts.join(S.subSep);
      if (sub) head.push(ext({ text: sub, margin: [0, head.length ? 1 : 0, 0, 0] }, S.sub));
    }
    if (note) head.push(ext({ text: note, margin: [0, 1, 0, 0] }, S.note));
    var rest = [];
    if (bullets.length) {
      head.push(bulletList([bullets[0]], S, [0, head.length ? S.bulletTop : 0, 0, 0]));
      if (bullets.length > 1) rest.push(bulletList(bullets.slice(1), S, [0, 0, 0, 0]));
    }
    return { head: head, rest: rest, lines: Math.max(2, head.length) };
  }

  function jobItem(j, S) {
    // Ünvan yoksa şirket başlık olur; o zaman alt satırda yalnızca şehir kalır.
    var heading = j.role || j.company;
    var sub = (j.role ? [j.company, j.city] : [j.city]).filter(Boolean);
    return entryItem(heading, sub, j.range, '', j.bullets, S);
  }

  function eduItem(e, S) {
    var heading = eduHeading(e.program, e.degree);
    var sub = [];
    if (!heading) heading = e.school;
    else if (e.school) sub.push(e.school);
    return entryItem(heading, sub, e.range, e.note, [], S);
  }

  // "Ad Soyad — Ünvan, Şirket · iletişim": ad kalın, kalanı ikincil renkte. Ayraç yoksa düz satır.
  function refNode(line, nameStyle, restStyle) {
    var m = /^(.+?)\s+[—–-]\s+(.+)$/.exec(line);
    if (!m) return { text: line };
    return { text: [ext({ text: m[1] }, nameStyle), ext({ text: ' — ' + m[2] }, restStyle)] };
  }

  function contactEntries(m, L) {
    var out = [];
    if (m.phone) out.push({ label: L.phone, value: m.phone });
    if (m.email) out.push({ label: L.email, value: m.email, link: 'mailto:' + m.email });
    if (m.city) out.push({ label: L.city, value: m.city });
    if (m.web && webDisplay(m.web)) out.push({ label: L.web, value: webDisplay(m.web), link: webHref(m.web) });
    return out;
  }

  // Satır içi iletişim: "0532 … · ad@… · İstanbul · linkedin.com/…" (e-posta/web tıklanabilir).
  function contactInline(entries, sep, sepColor) {
    var parts = [];
    entries.forEach(function (e, i) {
      if (i) parts.push(sepColor ? { text: sep, color: sepColor } : { text: sep });
      parts.push(e.link ? { text: e.value, link: e.link } : { text: e.value });
    });
    return parts;
  }

  /*
   * Karışık harfli metin için kaba Roboto genişlik tahmini (pt); bilerek biraz cömert (fazla)
   * tahmin eder. Yalnızca "iki metin yan yana sığar mı" kararında kullanılır.
   */
  function textWidth(s, size, bold) {
    var em = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      em += ch === ' ' ? 0.25
        : /[iıjlIİtfr.,:;'’!|·\-]/.test(ch) ? 0.3
          : /[mwMW]/.test(ch) ? 0.85
            : /[A-ZÇĞÖŞÜÂÎÛ]/.test(ch) ? 0.66
              : /[0-9]/.test(ch) ? 0.57 : 0.55;
    }
    return em * size * (bold ? 1.04 : 1);
  }
  /**
   * ['*', 'auto'] satırı (sol metin + noWrap sağ metin) güvenle kurulabilir mi? Sağ metin sütunun
   * en fazla `share` kadarını alabilir ve solun en uzun kelimesi kalan yere sığmalıdır; aksi halde
   * pdfmake sütunları en küçük genişliklerine göre kurar ve satır sütunun dışına taşar.
   */
  function sideBySide(left, leftStyle, right, rightStyle, gap, width, share) {
    if (!(width > 0)) return true;
    var rw = textWidth(right, rightStyle.fontSize, rightStyle.bold);
    var lw = 0;
    left.split(/\s+/).forEach(function (w) { lw = Math.max(lw, textWidth(w, leftStyle.fontSize, leftStyle.bold)); });
    return rw <= width * share && lw + gap + rw <= width * 0.95;
  }

  // Kaba genişlik tahmini (Roboto Medium büyük harf). Yalnızca klasik şablonda iki satıra
  // taşan başlık için ilk satıra kaç madde alınacağını seçmekte kullanılır.
  function estimateWidth(s, size, spacing) {
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      var em = ch === ' ' ? 0.25 : /[IİJ.,:;'!|]/.test(ch) ? 0.3 : /[MW]/.test(ch) ? 0.85 : 0.64;
      w += size * em + spacing;
    }
    return w;
  }
  function estimateLines(s, size, spacing, width) {
    var words = s.split(' '), lines = 1, cur = 0, space = estimateWidth(' ', size, spacing);
    words.forEach(function (word) {
      var w = estimateWidth(word, size, spacing);
      if (cur > 0 && cur + space + w > width) { lines++; cur = w; } else { cur += (cur > 0 ? space : 0) + w; }
    });
    return lines;
  }

  /* ------------------------------------------------------------- veri modeli */

  function P() {
    var p = root.CVParse;
    if (!p) throw new Error('CVPdf: CVParse bulunamadı — parse.js, pdfdoc.js kullanılmadan önce yüklenmeli.');
    return p;
  }

  function labels(lang) {
    var src = LABELS[lang === 'en' ? 'en' : 'tr'], out = {};
    for (var k in src) out[k] = src[k];
    for (var a in LABEL_ALIASES) out[a] = src[LABEL_ALIASES[a]];
    return out;
  }

  /** Ham CV → temizlenmiş, şablonların doğrudan kullandığı model. Boş girdiler ayıklanır. */
  function readModel(cv, lang) {
    var p = P();
    var L = labels(lang);
    cv = isObj(cv) ? cv : {};

    function range(a, b) {
      a = oneLine(a);
      b = oneLine(b);
      return a || b ? oneLine(p.formatRange(a, b, lang)) : '';
    }

    var jobs = arr(cv.jobs).map(function (j) {
      j = isObj(j) ? j : {};
      return {
        role: oneLine(j.role), company: oneLine(j.company), city: oneLine(j.city),
        range: range(j.start, j.end), bullets: cleanItems(p.splitLines(str(j.desc)))
      };
    }).filter(function (j) { return j.role || j.company || j.city || j.range || j.bullets.length; });

    var edu = arr(cv.edu).map(function (e) {
      e = isObj(e) ? e : {};
      return {
        school: oneLine(e.school), program: oneLine(e.program), degree: oneLine(e.degree),
        note: oneLine(e.note), range: range(e.start, e.end)
      };
    }).filter(function (e) { return e.school || e.program || e.degree || e.note || e.range; });

    var langs = [];
    arr(p.parseLanguages(str(cv.langs))).forEach(function (l) {
      if (!isObj(l)) return;
      var name = oneLine(p.languageName(oneLine(l.name), lang));
      if (!name) return; // yalnızca seviye söylenmiş ("ana dil"): gösterecek dil adı yok
      var level = Math.round(Number(l.level));
      if (!(level >= 0 && level <= 5)) level = 0;
      langs.push({ name: name, level: level, label: level ? oneLine(p.levelLabel(level, lang)) : '' });
    });

    var personal = ['birth', 'military', 'license', 'marital'].map(function (k) {
      return { label: L[k], value: oneLine(cv[k]) };
    }).filter(function (x) { return x.value; });

    return {
      name: oneLine(cv.name),
      title: oneLine(cv.title),
      phone: oneLine(cv.phone),
      email: oneLine(cv.email).replace(/\s+/g, ''),
      city: oneLine(cv.city),
      web: oneLine(cv.web).replace(/\s+/g, ''),
      photo: cleanImage(cv.photo),
      summary: paragraphs(cv.summary),
      jobs: jobs,
      edu: edu,
      skills: cleanItems(p.splitList(str(cv.skills))),
      hobbies: cleanItems(p.splitList(str(cv.hobbies))),
      langs: langs,
      certs: cleanItems(p.splitLines(str(cv.certs))),
      refs: cleanItems(p.splitLines(str(cv.refs))),
      personal: personal
    };
  }

  /* --------------------------------------------------------- şablon: modern */

  function buildModern(m, c) {
    var A = c.accent, L = c.L, lang = c.lang;
    var SB_W = SIDEBAR - 22 - 18;            // kenar çubuğu iç genişliği: 148
    var MAIN_W = PAGE.width - SIDEBAR - 24 - 34; // ana sütun iç genişliği: 349.28
    var C = {
      head: mix(A, WHITE, 0.7),     // kenar çubuğu başlıkları (~%70 beyaz)
      label: mix(A, WHITE, 0.62),   // iletişim etiketleri (~%62 beyaz)
      rule: mix(A, WHITE, 0.32),
      barOff: mix(A, WHITE, 0.25),  // dil çubuğunun boş dilimleri (~%25 beyaz)
      company: mix(A, INK, 0.3)     // vurgu rengi, okunurluk için mürekkebe doğru
    };

    /* kenar çubuğu */
    var side = [];
    if (c.photo) side.push({ image: c.photo, fit: [112, 112], alignment: 'center', margin: [0, 0, 0, 22] });

    function sideHeading(label) {
      return {
        stack: [
          { text: upperLabel(label, lang), bold: true, fontSize: 8, characterSpacing: 1.4, color: C.head },
          hline(SB_W, 1, C.rule, [0, 4, 0, 9])
        ]
      };
    }
    function sideField(e) {
      var value = { text: e.value, fontSize: 9, lineHeight: 1.2, color: WHITE };
      if (e.link) value.link = e.link;
      return {
        head: [{
          stack: [
            { text: upperLabel(e.label, lang), fontSize: 7, characterSpacing: 1, color: C.label, margin: [0, 0, 0, 1.5] },
            value
          ]
        }],
        rest: []
      };
    }
    function langItem(l) {
      var nameNode = { text: l.name, bold: true, fontSize: 9, color: WHITE };
      var head;
      if (l.label && sideBySide(l.name, nameNode, l.label, { fontSize: 7.5 }, 6, SB_W, 0.6)) {
        // Seviye etiketi noWrap: "Upper-intermediate" tireden ikiye bölünmesin, dil adı kaysın.
        nameNode.width = '*';
        head = [{
          columns: [nameNode, { width: 'auto', text: l.label, noWrap: true, fontSize: 7.5, color: C.head, margin: [6, 1.2, 0, 0] }],
          columnGap: 0
        }];
      } else if (l.label) {
        // Çok uzun tek kelimeli dil adı: etiket alta iner, satır kenar çubuğundan taşmaz.
        head = [nameNode, { text: l.label, fontSize: 7.5, color: C.head, margin: [0, 1, 0, 0] }];
      } else {
        head = [nameNode];
      }
      if (l.level > 0) {
        var gap = 3, h = 3.2, w = (SB_W - gap * 4) / 5, rects = [];
        for (var i = 0; i < 5; i++) {
          rects.push({ type: 'rect', x: i * (w + gap), y: 0, w: w, h: h, r: h / 2, color: i < l.level ? WHITE : C.barOff });
        }
        head.push({ canvas: rects, margin: [0, 4, 0, 0] });
      }
      return { head: head, rest: [] };
    }

    var SB_KEEP = keepLimit(SB_W), MAIN_KEEP = keepLimit(MAIN_W);
    var SKILL = { bulletSize: 9, bulletGap: 2.5, bulletColor: WHITE, markerColor: C.head, markerType: 'square' };
    var sideSecs = [];
    var contacts = contactEntries(m, L);
    if (contacts.length) sideSecs.push(flow(sideHeading(L.contact), contacts.map(sideField), 7, SB_KEEP));
    if (m.skills.length) sideSecs.push(flow(sideHeading(L.skills), listItems(m.skills, SKILL), 0, SB_KEEP));
    if (m.langs.length) sideSecs.push(flow(sideHeading(L.languages), m.langs.map(langItem), 8, SB_KEEP));
    if (m.personal.length) sideSecs.push(flow(sideHeading(L.personal), m.personal.map(sideField), 7, SB_KEEP));
    if (m.hobbies.length) {
      sideSecs.push(flow(sideHeading(L.hobbies), [{
        head: [{ text: m.hobbies.join(', '), fontSize: 9, lineHeight: 1.35, color: WHITE }], rest: []
      }], 0, SB_KEEP));
    }
    sideSecs.forEach(function (s, i) { side.push({ stack: s, margin: [0, i ? 20 : 0, 0, 0] }); });

    /* ana sütun */
    var main = [];
    if (m.name) main.push({ text: m.name, font: 'DMSerif', fontSize: 30, lineHeight: 1, color: INK });
    if (m.title) {
      main.push({
        text: upperText(m.title, lang), bold: true, fontSize: 10, characterSpacing: 1.6, color: A,
        margin: [0, m.name ? 6 : 0, 0, 0]
      });
    }
    var hasHeader = main.length > 0;

    function mainHeading(label) {
      return {
        stack: [
          { text: upperLabel(label, lang), bold: true, fontSize: 9, characterSpacing: 1.6, color: A },
          hline(MAIN_W, 0.6, RULE, [0, 4, 0, 8])
        ]
      };
    }
    var S = {
      role: { bold: true, fontSize: 10.5, color: INK },
      date: { fontSize: 8.5, color: MUTED },
      dateTop: 1.8, // 10.5pt ünvan ile 8.5pt tarihin taban çizgileri hizalı
      sub: { fontSize: 9, color: C.company },
      subSep: ' · ',
      note: { fontSize: 9, color: MUTED },
      bulletSize: 9.5, bulletGap: 1.5, bulletTop: 3, markerColor: A,
      width: MAIN_W // ünvan + tarih satırının sığma kontrolü için
    };
    var CERT = { bulletSize: 9.5, bulletGap: 2, markerColor: A };

    var mainSecs = [];
    if (m.summary.length) {
      mainSecs.push(flow(mainHeading(L.profile), m.summary.map(function (p) {
        return { head: [{ text: p }], rest: [] };
      }), 5, MAIN_KEEP));
    }
    if (m.jobs.length) mainSecs.push(flow(mainHeading(L.experience), m.jobs.map(function (j) { return jobItem(j, S); }), 10, MAIN_KEEP));
    if (m.edu.length) mainSecs.push(flow(mainHeading(L.education), m.edu.map(function (e) { return eduItem(e, S); }), 10, MAIN_KEEP));
    if (m.certs.length) mainSecs.push(flow(mainHeading(L.certs), listItems(m.certs, CERT), 0, MAIN_KEEP));
    if (m.refs.length) {
      mainSecs.push(flow(mainHeading(L.refs), m.refs.map(function (r) {
        return { head: [refNode(r, { bold: true, color: INK }, { color: MUTED })], rest: [] };
      }), 4, MAIN_KEEP));
    }
    mainSecs.forEach(function (s, i) {
      main.push({ stack: s, margin: [0, i ? 16 : (hasHeader ? 14 : 0), 0, 0] });
    });

    return {
      content: [{
        columns: [
          { width: SIDEBAR, stack: side.length ? side : [{ text: '' }], margin: [22, 0, 18, 0] },
          { width: '*', stack: main.length ? main : [{ text: '' }], margin: [24, 0, 34, 0] }
        ],
        columnGap: 0
      }],
      // Kenar çubuğu her sayfada (2. sayfa ve sonrası dahil) tam yükseklikte.
      background: function (currentPage, pageSize) {
        var h = pageSize && typeof pageSize.height === 'number' && isFinite(pageSize.height) && pageSize.height > 0
          ? pageSize.height : PAGE.height;
        return { canvas: [{ type: 'rect', x: 0, y: 0, w: SIDEBAR, h: h, color: A }] };
      },
      footerMargin: [SIDEBAR + 24, 13, 34, 0] // kenar çubuğuna taşmaz, ana sütunun sağ kenarına hizalı
    };
  }

  /* --------------------------------------------------------- şablon: klasik */

  function buildKlasik(m, c) {
    var A = c.accent, L = c.L, lang = c.lang;
    var CW = PAGE.width - 100; // 495.28
    var GUT = 108, GAP = 14;
    var KEEP = keepLimit(CW - GUT - GAP);
    var SEP = mix(MUTED, WHITE, 0.45); // ayraç noktaları metinden bir ton açık
    var content = [];

    /* başlık */
    var hstack = [];
    if (m.name) hstack.push({ text: m.name, font: 'DMSerif', fontSize: 28, lineHeight: 1.05, color: INK });
    if (m.title) {
      hstack.push({ text: m.title, font: 'DMSerif', italics: true, fontSize: 13, color: A, margin: [0, m.name ? 2 : 0, 0, 0] });
    }
    var ce = contactEntries(m, L);
    if (ce.length) {
      hstack.push({ text: contactInline(ce, '  ·  ', SEP), fontSize: 8.5, color: MUTED, margin: [0, hstack.length ? 8 : 0, 0, 0] });
    }
    if (c.photo) {
      content.push({
        columns: [
          { width: '*', stack: hstack.length ? hstack : [{ text: '' }] },
          { width: 76, image: c.photo, fit: [76, 76] }
        ],
        columnGap: 18
      });
    } else if (hstack.length) {
      content.push({ stack: hstack });
    }
    var hasHeader = content.length > 0;
    if (hasHeader) content.push(hline(CW, 1.2, A, [0, 12, 0, 14]));

    /* bölümler: [başlık oluğu | içerik] */
    var S = {
      role: { bold: true, fontSize: 10, color: INK },
      date: { fontSize: 8.5, color: MUTED },
      dateTop: 1.4,
      sub: { fontSize: 9, color: mix(A, INK, 0.3) },
      subSep: ' · ',
      note: { fontSize: 9, color: MUTED },
      bulletSize: 9.5, bulletGap: 1.5, bulletTop: 3, markerColor: A,
      width: CW - GUT - GAP
    };

    /*
     * Başlık + ilk madde tek blok (bölünmez). Başlık oluğu dar (108pt): "SERTİFİKALAR VE KURSLAR"
     * iki satıra taşar. İlk satırda tek kısa madde olursa ikinci sütun satırı başlığın altından
     * başlar ve maddeler arasında boşluk kalır; bu yüzden başlık kaç satırsa ilk bloğa en az o
     * kadar satırlık madde alınır (madde imi "kalan"ı olan bir maddeden sonra durulur).
     */
    function section(label, items, gap, withRule) {
      var text = upperLabel(label, lang);
      var hd = { text: text, bold: true, fontSize: 8, characterSpacing: 1.4, lineHeight: 1.25, color: A, margin: [0, 1.4, 0, 0] };
      var need = estimateLines(text, 8, 1.4, GUT);
      var firstCol = [], restCol = [], i = 0, got = 0;
      while (i < items.length) {
        var it = items[i];
        var blk = { stack: it.head };
        if (i > 0) blk.margin = [0, gap, 0, 0];
        firstCol.push(blk);
        got += it.lines;
        i++;
        if (it.rest.length) { restCol = restCol.concat(it.rest); break; }
        if (got >= need) break;
      }
      for (; i < items.length; i++) {
        var k = keepTogether(items[i].head, KEEP);
        if (gap) k.margin = [0, gap, 0, 0];
        restCol.push(k);
        restCol = restCol.concat(items[i].rest);
      }
      var row1 = { columns: [{ width: GUT, stack: [hd] }, { width: '*', stack: firstCol }], columnGap: GAP };
      var out = [keepTogether(withRule ? [hline(CW, 0.6, RULE, [0, 12, 0, 12]), row1] : [row1], KEEP)];
      if (restCol.length) out.push({ columns: [{ width: GUT, text: '' }, { width: '*', stack: restCol }], columnGap: GAP });
      return out;
    }
    function one(node) { return { head: [node], rest: [], lines: 1 }; }

    var secs = [];
    if (m.summary.length) secs.push([L.profile, m.summary.map(function (p) { return one({ text: p }); }), 4]);
    if (m.jobs.length) secs.push([L.experience, m.jobs.map(function (j) { return jobItem(j, S); }), 9]);
    if (m.edu.length) secs.push([L.education, m.edu.map(function (e) { return eduItem(e, S); }), 9]);
    if (m.skills.length) {
      var sk = [];
      m.skills.forEach(function (s, i) {
        if (i) sk.push({ text: '  ·  ', color: SEP });
        sk.push({ text: s });
      });
      secs.push([L.skills, [one({ text: sk })], 0]);
    }
    if (m.langs.length) {
      secs.push([L.languages, m.langs.map(function (l) {
        var parts = [{ text: l.name, bold: true }];
        if (l.label) parts.push({ text: ' — ' + l.label, color: MUTED });
        return one({ text: parts });
      }), 2]);
    }
    if (m.certs.length) secs.push([L.certs, m.certs.map(function (x) { return one({ text: x }); }), 2]);
    if (m.personal.length) {
      secs.push([L.personal, m.personal.map(function (x) {
        return one({ text: [{ text: x.label + ': ', color: MUTED }, { text: x.value }] });
      }), 2]);
    }
    if (m.hobbies.length) secs.push([L.hobbies, [one({ text: m.hobbies.join(', ') })], 0]);
    if (m.refs.length) {
      secs.push([L.refs, m.refs.map(function (r) {
        return one(refNode(r, { bold: true, color: INK }, { color: MUTED }));
      }), 3]);
    }
    secs.forEach(function (s, i) {
      content.push.apply(content, section(s[0], s[1], s[2], i > 0));
    });

    return { content: content.length ? content : [{ text: '' }], footerMargin: [50, 20, 50, 0] };
  }

  /* ------------------------------------------------------------ şablon: sade */

  // ATS dostu: tek sütun, düz metin; sütun/tablo yok. Tek çizim, başlıkların altındaki ince çizgi.
  function buildSade(m, c) {
    var A = c.accent, L = c.L, lang = c.lang;
    var CW = PAGE.width - 112; // 483.28
    var KEEP = keepLimit(CW);
    var RULE_SADE = mix(INK, WHITE, 0.7); // RULE'dan biraz koyu: ince çizgi baskıda kaybolmasın
    var content = [];

    if (m.name) content.push({ text: m.name, bold: true, fontSize: 20, lineHeight: 1.1, color: INK });
    if (m.title) content.push({ text: m.title, fontSize: 11, color: INK, margin: [0, m.name ? 2 : 0, 0, 0] });
    var ce = contactEntries(m, L);
    if (ce.length) content.push({ text: contactInline(ce, '  |  ', ''), fontSize: 9, color: INK, margin: [0, content.length ? 6 : 0, 0, 0] });
    var hasHeader = content.length > 0;

    function heading(label) {
      return {
        stack: [
          { text: upperLabel(label, lang), bold: true, fontSize: 10, characterSpacing: 0.6, color: A },
          hline(CW, 0.5, RULE_SADE, [0, 3, 0, 7])
        ]
      };
    }
    var S = {
      role: { bold: true, fontSize: 10, color: INK },
      sub: { fontSize: 9, color: MUTED },
      subSep: ', ',
      dateInSub: true,
      note: { fontSize: 9, color: MUTED },
      bulletSize: 9.5, bulletGap: 1.5, bulletTop: 3
    };
    var PLAIN = { bulletSize: 9.5, bulletGap: 2 };
    function one(node) { return { head: [node], rest: [] }; }

    var secs = [];
    if (m.summary.length) secs.push(flow(heading(L.profile), m.summary.map(function (p) { return one({ text: p }); }), 4, KEEP));
    if (m.jobs.length) secs.push(flow(heading(L.experience), m.jobs.map(function (j) { return jobItem(j, S); }), 9, KEEP));
    if (m.edu.length) secs.push(flow(heading(L.education), m.edu.map(function (e) { return eduItem(e, S); }), 9, KEEP));
    if (m.skills.length) secs.push(flow(heading(L.skills), [one({ text: m.skills.join(', ') })], 0, KEEP));
    if (m.langs.length) {
      secs.push(flow(heading(L.languages), m.langs.map(function (l) {
        return one({ text: l.label ? l.name + ' — ' + l.label : l.name });
      }), 2, KEEP));
    }
    if (m.certs.length) secs.push(flow(heading(L.certs), listItems(m.certs, PLAIN), 0, KEEP));
    if (m.personal.length) {
      secs.push(flow(heading(L.personal), m.personal.map(function (x) { return one({ text: x.label + ': ' + x.value }); }), 2, KEEP));
    }
    if (m.hobbies.length) secs.push(flow(heading(L.hobbies), [one({ text: m.hobbies.join(', ') })], 0, KEEP));
    if (m.refs.length) secs.push(flow(heading(L.refs), m.refs.map(function (r) { return one({ text: r }); }), 3, KEEP));

    secs.forEach(function (s, i) {
      content.push({ stack: s, margin: [0, i ? 14 : (hasHeader ? 16 : 0), 0, 0] });
    });

    return { content: content.length ? content : [{ text: '' }], footerMargin: [56, 20, 56, 0] };
  }

  /* ------------------------------------------------------------- genel API */

  function templateById(id) {
    for (var i = 0; i < TEMPLATES.length; i++) if (TEMPLATES[i].id === id) return TEMPLATES[i];
    return null;
  }

  // Geçerli 6 haneli hex olduğu gibi kalır; 3 haneli genişletilir; geçersiz → varsayılan vurgu.
  function normalizeAccent(v) {
    var s = str(v).trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s;
    var rgb = parseHex(s);
    return rgb ? toHex(rgb) : ACCENTS[0];
  }

  // Tek sayfalık CV'de altbilgi yok: null döner (pdfmake boş değeri atlar).
  function makeFooter(name, margin) {
    return function (currentPage, pageCount) {
      if (!(pageCount > 1)) return null;
      return {
        text: (name ? name + ' · ' : '') + currentPage + '/' + pageCount,
        fontSize: 7.5, color: MUTED, alignment: 'right', margin: margin.slice()
      };
    };
  }

  /**
   * build(cv, opts) → pdfmake docDefinition.
   * opts.template: 'modern' | 'klasik' | 'sade' (bilinmeyen → 'modern'); opts.accent: hex (geçersiz →
   * ACCENTS[0]); opts.lang: 'tr' | 'en' (diğerleri → 'tr'); opts.showPhoto: varsayılan true;
   * opts.photoRound: yalnızca modern şablonda, baytları gerçekten PNG olan bir data URL ise kare
   * fotoğrafın yerine (köşeleri saydam olmalı; JPEG'de saydamlık yok, o yüzden kabul edilmez).
   */
  function build(cv, opts) {
    opts = isObj(opts) ? opts : {};
    var lang = opts.lang === 'en' ? 'en' : 'tr';
    var tpl = templateById(opts.template) || TEMPLATES[0];
    var m = readModel(cv, lang);

    var photo = '';
    if (tpl.photo && opts.showPhoto !== false && m.photo) {
      var round = tpl.id === 'modern' && imageKind(opts.photoRound) === 'png' ? cleanImage(opts.photoRound) : '';
      photo = round || m.photo;
    }
    var c = { lang: lang, L: labels(lang), accent: normalizeAccent(opts.accent), photo: photo };
    var t = tpl.id === 'klasik' ? buildKlasik(m, c) : tpl.id === 'sade' ? buildSade(m, c) : buildModern(m, c);

    var dd = {
      info: { title: m.name ? m.name + ' — CV' : 'CV', author: m.name, subject: 'CV', creator: 'Sesli CV' },
      language: lang === 'en' ? 'en-GB' : 'tr-TR',
      pageSize: 'A4',
      pageOrientation: 'portrait',
      pageMargins: MARGINS[tpl.id].slice(),
      defaultStyle: { font: 'Roboto', fontSize: 9.5, lineHeight: 1.28, color: INK },
      content: t.content,
      footer: makeFooter(m.name, t.footerMargin)
    };
    if (t.background) dd.background = t.background;
    return dd;
  }

  var TEXT_FIELDS = ['name', 'title', 'phone', 'email', 'city', 'web', 'summary', 'skills', 'langs',
    'certs', 'hobbies', 'refs', 'birth', 'military', 'license', 'marital'];
  var JOB_FIELDS = ['role', 'company', 'city', 'start', 'end', 'desc'];
  var EDU_FIELDS = ['school', 'program', 'degree', 'start', 'end', 'note'];

  function entriesHaveContent(list, fields) {
    return arr(list).some(function (e) {
      return isObj(e) && fields.some(function (f) { return str(e[f]).trim() !== ''; });
    });
  }

  /**
   * Kullanıcının anlamlı bir içeriği var mı? Boşluklar ve tamamen boş iş/eğitim girdileri
   * (yalnızca id) sayılmaz. Yüklenen fotoğraf içerik sayılır (kişi fotoğrafını önizlemede görmeli),
   * ama yalnızca build()'in gerçekten basabileceği bir JPEG/PNG ise: aksi halde önizleme örnek CV
   * yerine boş bir sayfa gösterirdi.
   */
  function hasContent(cv) {
    if (!isObj(cv)) return false;
    if (imageKind(cv.photo)) return true;
    for (var i = 0; i < TEXT_FIELDS.length; i++) {
      if (str(cv[TEXT_FIELDS[i]]).trim() !== '') return true;
    }
    return entriesHaveContent(cv.jobs, JOB_FIELDS) || entriesHaveContent(cv.edu, EDU_FIELDS);
  }

  /** CV_FONT_VFS'i pdfMake.vfs'e ekler ve yazı tipi ailelerini tanımlar. Tekrar çağrılabilir. */
  function registerFonts(pdfMake) {
    if (!pdfMake || (typeof pdfMake !== 'object' && typeof pdfMake !== 'function')) return pdfMake;
    var src = root.CV_FONT_VFS;
    var vfs = isObj(pdfMake.vfs) ? pdfMake.vfs : {};
    if (isObj(src)) {
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k) && typeof src[k] === 'string' && src[k]) vfs[k] = src[k];
      }
    }
    pdfMake.vfs = vfs;

    var REG = 'DMSerifDisplay-Regular.ttf', ITA = 'DMSerifDisplay-Italic.ttf';
    var roboto = {
      normal: 'Roboto-Regular.ttf', bold: 'Roboto-Medium.ttf',
      italics: 'Roboto-Italic.ttf', bolditalics: 'Roboto-MediumItalic.ttf'
    };
    var hasReg = isObj(src) && typeof src[REG] === 'string' && src[REG] !== '';
    var hasIta = hasReg && typeof src[ITA] === 'string' && src[ITA] !== '';
    // DM Serif'in kalın kesimi yok: bold = regular. İtalik dosyası eksikse regular'a düşer.
    var serif = hasReg
      ? { normal: REG, bold: REG, italics: hasIta ? ITA : REG, bolditalics: hasIta ? ITA : REG }
      : { normal: roboto.normal, bold: roboto.bold, italics: roboto.italics, bolditalics: roboto.bolditalics };
    pdfMake.fonts = { Roboto: roboto, DMSerif: serif };
    return pdfMake;
  }

  function fileName(cv) {
    return P().fileName(oneLine(isObj(cv) ? cv.name : ''));
  }

  var API = {
    TEMPLATES: TEMPLATES,
    ACCENTS: ACCENTS,
    SAMPLE: SAMPLE,
    COLORS: { INK: INK, MUTED: MUTED, RULE: RULE },
    labels: labels,
    hasContent: hasContent,
    registerFonts: registerFonts,
    build: build,
    fileName: fileName,
    mix: mix
  };

  root.CVPdf = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
