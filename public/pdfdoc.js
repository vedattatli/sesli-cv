/*
 * Sesli CV — pdfdoc.js  (global: CVPdf)
 *
 * CV verisini pdfmake 0.2.10 docDefinition nesnesine çevirir (şablonlar: brief §4, v2).
 * Saf veri üretir: DOM'a ve pdfMake'e yalnızca registerFonts() dokunur.
 * Bağımlılık: CVParse (parse.js). Çağrı anında okunur; yükleme sırası esnektir.
 *
 * pdfmake notu: pdfmake, düzen sırasında docDefinition düğümlerini değiştirir (_margin,
 * _inlines…). Bu yüzden build() her çağrıda tamamen yeni nesneler üretir; sabit stil
 * nesneleri yalnızca ilkel değerler taşır ve düğümlere kopyalanır.
 *
 * pdfmake sürümü 0.2.10'da kalır (uygulama bu sürümü cdnjs'ten yükler; brief §8 C7).
 *
 * Şablonlar (brief §4.3–4.5):
 *  - klasik: başlık (DM Serif ad, ünvan, iletişim) + vurgu çizgisi; bölümler [92pt başlık oluğu | içerik].
 *  - sade:   tek sütun, düz metin (ATS). Fotoğraf yok, sütun yok, dolgu yok.
 *  - modern: tam genişlikte başlık (ilk yazılan), altında [ana sütun | açık tonlu kenar çubuğu].
 * Akış sırası her zaman: ad, iletişim → bölümler (modern: ana sütun, sonra kenar çubuğu).
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ sabitler */

  var INK = '#1d232a';
  var MUTED = '#5b6670';
  var RULE = '#d6dce1';
  var WHITE = '#ffffff';
  var PAGE = { width: 595.28, height: 841.89 }; // pdfmake 'A4' ölçüsü (pt)
  // Roboto (pdfmake'in vfs'indeki 2.x): ascender 1900, descender −500, em 2048. pdfmake satırın taban
  // çizgisini satırın üstünden ascender × boyut kadar aşağıya koyar; satır yüksekliği boyut × 1.1719 × lineHeight.
  var ASC = 1900 / 2048;
  var LINE_EM = 2400 / 2048;
  var LINE_HEIGHT = 1.15; // ≈1.35× punto (brief §4.1)

  /*
   * pdfmake 0.2.10'da `unbreakable` blok, yüksekliği NaN olan ayrı bir bağlamda dizilir
   * (ElementWriter.pushContext, `getCurrentPage().height` tanımsız) ve bu yüzden kendi içinde hiç
   * sayfa atlamaz. Commit sırasında blok kalan alana sığmazsa yeni sayfaya taşınır; yeni sayfaya da
   * sığmazsa PageElementWriter.addFragment ikinci denemenin sonucunu yok sayar ve blok TAMAMEN
   * kaybolur. Ayrıca taşınan blok önceki sayfada kendi yüksekliği kadar boşluk bırakır.
   * Bu yüzden birlikte tutulacak blok tahminen bir sayfanın ~%40-45'ini aşarsa (aşırı uzun tek
   * madde/paragraf) bölünebilir bırakılır: yetim başlık, kaybolan metinden ve yarım boş sayfadan iyidir.
   * Hesap: ~10pt Roboto'da ortalama ~5pt/karakter → genişlik × 4.5 karakter ≈ 20 satır.
   */
  function keepLimit(width) { return Math.floor(width * 4.5); }

  /*
   * TEXT_COL — serbest metin taşıyan sütunlar '*' değil, sayıyla verilen sabit genişliktedir.
   * pdfmake 0.2.10 ColumnCalculator'da (1. durum) '*' sütunun en küçük genişliği (içindeki en uzun
   * bölünmez sözcük: boşluksuz "Python,FastAPI,…" listesi, tek sözcüklük ad, uzun bağlantı) kalan alanı
   * aşarsa sütun o sözcük kadar GENİŞLER ve sütundaki tüm satırlar sayfanın sağından taşar. Sabit
   * genişlikli sütunda ise LayoutBuilder.buildNextLine uzun sözcüğü satır sonunda keser. ('*' yalnızca
   * sideBySide ile korunan ünvan/tarih satırlarında kalır.)
   */

  // Sıra: klasik (varsayılan/yedek), sade, modern. desc: seçicideki dürüst açıklama (brief §4.3–4.5).
  var TEMPLATES = [
    { id: 'klasik', tr: 'Klasik', en: 'Classic', photo: true,
      desc: 'Kurumsal başvurular, e-posta ve çıktı için', descEn: 'For company applications, e-mail and print' },
    { id: 'sade', tr: 'Sade', en: 'Plain', photo: false,
      desc: 'İş ilanı sitelerine yüklemek için en güvenli (ATS)', descEn: 'Safest for uploading to job sites (ATS)' },
    { id: 'modern', tr: 'Modern', en: 'Modern', photo: true,
      desc: 'E-postayla gönderim ve çıktı için; ilan sitelerinde Sade önerilir.', descEn: 'For e-mail and print; use Plain on job sites.' }
  ];

  var ACCENTS = ['#1F5C4A', '#23395B', '#7A2E3A', '#36404A', '#7A5212'];
  // Vurgu verilmezse: sade lacivert (brief §4.3), diğerleri ilk vurgu.
  var DEFAULT_ACCENT = { klasik: ACCENTS[0], modern: ACCENTS[0], sade: '#23395B' };

  var PROFILES = ['deneyimli', 'ogrenci', 'saha', 'yazilim'];

  var MARGINS = {
    modern: [40, 40, 40, 40],
    klasik: [51, 48, 51, 45],
    sade: [57, 48, 57, 45]
  };

  /*
   * Yazı boyutları (pt). Gövde: sade 10.5, klasik 10. Modern (brief §8 C8): ana sütun 10, kenar
   * çubuğu 9.5, tarih ve üst bilgi satırları 9 — §4.1'in "gövde en az 10 pt" kuralıyla çelişmesin
   * diye §4.5'teki 9.5/9/8.5'ten yükseltildi; örnek CV yine en çok 2 sayfa. Hiçbir şablon sığdırmak
   * için küçültmez; taşan içerik 2. sayfaya geçer (tek istisna ön yazı: bkz. buildLetter).
   */
  var BODY_SIZE = { sade: 10.5, klasik: 10, modern: 10 };

  var LABELS = {
    tr: {
      contact: 'İletişim', profile: 'Profil', experience: 'İş Deneyimi', projects: 'Projeler', education: 'Eğitim',
      skills: 'Yetenekler', languages: 'Diller', certs: 'Sertifikalar',
      hobbies: 'İlgi Alanları', refs: 'Referanslar', personal: 'Kişisel Bilgiler',
      birth: 'Doğum Yılı', military: 'Askerlik Durumu', license: 'Sürücü Belgesi',
      marital: 'Medeni Durum', phone: 'Telefon', email: 'E-posta', city: 'Konum', web: 'Web', github: 'GitHub',
      refsLine: 'Referanslar talep üzerine iletilir.'
    },
    en: {
      contact: 'Contact', profile: 'Profile', experience: 'Experience', projects: 'Projects', education: 'Education',
      skills: 'Skills', languages: 'Languages', certs: 'Certifications',
      hobbies: 'Interests', refs: 'References', personal: 'Personal Details',
      birth: 'Year of Birth', military: 'Military Service', license: 'Driving Licence',
      marital: 'Marital Status', phone: 'Phone', email: 'Email', city: 'Location', web: 'Web', github: 'GitHub',
      refsLine: 'References available upon request.'
    }
  };
  // Profile göre başlık farkları (brief §3.2): öğrenci "Deneyim", saha "Belgeler ve Sertifikalar".
  var PROFILE_LABELS = {
    tr: { ogrenci: { experience: 'Deneyim' }, saha: { certs: 'Belgeler ve Sertifikalar' } },
    en: { saha: { certs: 'Licences and Certificates' } }
  };
  // Uygulama tarafı veri modelindeki alan adlarıyla da erişebilsin diye takma adlar.
  var LABEL_ALIASES = { summary: 'profile', jobs: 'experience', edu: 'education', langs: 'languages', location: 'city' };

  /*
   * Bölüm sırası (brief §4.2). Listede olmayan ama dolu bir bölüm (ör. öğrencinin ilgi alanları)
   * atılmaz; profilin sırasındaki doğal yerine (Kişisel Bilgiler'den sonra) konur. Referanslar
   * (ya da "talep üzerine" satırı) her zaman en sonda.
   */
  var ORDER = {
    deneyimli: ['profile', 'experience', 'projects', 'education', 'skills', 'languages', 'certs', 'personal', 'hobbies'],
    ogrenci: ['profile', 'education', 'projects', 'experience', 'skills', 'languages', 'certs', 'personal', 'hobbies'],
    saha: ['profile', 'certs', 'experience', 'projects', 'education', 'skills', 'languages', 'personal', 'hobbies'],
    yazilim: ['profile', 'experience', 'projects', 'education', 'skills', 'languages', 'certs', 'personal', 'hobbies']
  };
  // Modern: ana sütun ve kenar çubuğu (brief §4.5). Başlık, unvan, şirket, tarih asla kenar çubuğunda değil.
  var MODERN_MAIN = { profile: 1, experience: 1, projects: 1, education: 1 };

  /* ------------------------------------------------------------- örnek CV'ler */

  // Kurgusal kişi ve şirketler; e-postalar ayrılmış example.com alan adında.
  var SAMPLE = {
    name: 'Emre Aksoy',
    title: 'Kıdemli Proje Yöneticisi',
    phone: '0532 123 45 67',
    email: 'emre.aksoy@example.com',
    city: 'İstanbul',
    web: 'linkedin.com/in/emre-aksoy-ornek',
    github: 'github.com/emreaksoy-ornek',
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
    // Kısa tutuldu: örnek CV önizlemede mümkün olduğunca az sayfaya sığsın.
    projects: [
      {
        id: 'ornek-proje-1', name: 'Depo Kapasite Planlama Aracı', tech: 'Python, Pandas, Power BI',
        link: 'github.com/emreaksoy-ornek/depo-kapasite-planlama',
        desc: 'Sipariş geçmişinden haftalık depo doluluğunu tahmin eden açık kaynak bir araç geliştirdim.\n' +
          'Tahminleri Power BI panosuna bağlayarak vardiya planlamasında kullanılmasını sağladım.'
      },
      {
        id: 'ornek-proje-2', name: 'Sprint Rapor Otomasyonu', tech: 'Python, Jira REST API, Google Sheets',
        link: 'github.com/emreaksoy-ornek/sprint-rapor',
        desc: 'Jira kayıtlarından haftalık sprint özetini otomatik hazırlayan bir betik yazdım.\n' +
          'Ekip liderlerinin raporlamaya ayırdığı süreyi haftada yaklaşık iki saat azalttım.'
      }
    ],
    edu: [
      {
        id: 'ornek-egitim-1', school: 'Marmara Üniversitesi', program: 'İşletme', degree: 'Yüksek Lisans',
        start: '2019', end: '2021', note: 'Tezsiz MBA programı'
      },
      {
        id: 'ornek-egitim-2', school: 'Dokuz Eylül Üniversitesi', program: 'Endüstri Mühendisliği', degree: 'Lisans',
        start: '2010', end: '2014', note: 'GNO 3,21 / 4,00'
      }
    ],
    skills: 'Proje planlama, Risk yönetimi, Agile / Scrum, Paydaş yönetimi, Bütçe takibi, MS Project, Jira, ' +
      'Power BI, SAP MM, İleri düzey Excel',
    langs: 'Türkçe ana dil, İngilizce ileri (C1) · IELTS 7.0 (2023), Almanca başlangıç (A2)',
    certs: 'PMP – Project Management Professional, PMI (2020)\n' +
      'Professional Scrum Master I (PSM I), Scrum.org (2019)\n' +
      'Power BI ile Veri Analizi ve Raporlama, 32 saat (2022)',
    hobbies: 'Doğa yürüyüşü, Analog fotoğrafçılık, Satranç, Gönüllü kodlama atölyeleri',
    refs: 'Selin Arıkan — Operasyon Direktörü, Atlas Lojistik A.Ş. · selin.arikan@example.com\n' +
      'Murat Tekin — Bilgi Teknolojileri Müdürü, Kuzey Perakende Grubu · murat.tekin@example.com',
    birth: '1991',
    military: 'Yapıldı (2015)',
    license: 'B sınıfı',
    marital: ''
  };

  // Profil önizlemeleri (brief §4.2): gerçekçi, kurgusal Türkçe CV'ler.
  var SAMPLE_OGRENCI = {
    name: 'Zeynep Arslan',
    title: 'Endüstri Mühendisliği Öğrencisi',
    phone: '0541 234 56 78',
    email: 'zeynep.arslan@example.com',
    city: 'Bornova, İzmir',
    web: 'linkedin.com/in/zeynep-arslan-ornek',
    github: '',
    photo: '',
    summary: 'Üretim planlama stajı yapmış, veriyle süreç iyileştirmeye ilgi duyan bir endüstri mühendisliği ' +
      'öğrencisiyim; Haziran 2027’den itibaren tam zamanlı iş arıyorum.',
    edu: [
      {
        id: 'ogr-egitim-1', school: 'Ege Üniversitesi', program: 'Endüstri Mühendisliği', degree: 'Lisans',
        start: 'Eylül 2023', end: 'Haziran 2027', note: 'GNO 3,41 / 4,00 · Erasmus+: Politecnico di Milano (Bahar 2025)'
      }
    ],
    projects: [
      {
        id: 'ogr-proje-1', name: 'Depo Yerleşim Optimizasyonu (Bitirme Projesi)', tech: 'Python, PuLP, Excel', link: '',
        desc: 'Bir beyaz eşya yan sanayi deposunun raf yerleşimini doğrusal programlamayla yeniden tasarladık.\n' +
          'Toplama mesafesini simülasyonda %18 kısalttık; sonuçları firma yönetimine sunduk.'
      },
      {
        id: 'ogr-proje-2', name: 'Kampüs Yemekhanesi Kuyruk Analizi', tech: 'Arena Simulation, Excel', link: '',
        desc: 'Simülasyonla ikinci kasanın beklemeyi 11 dakikadan 6 dakikaya indireceğini gösterdik.'
      }
    ],
    jobs: [
      {
        id: 'ogr-is-1', role: 'Üretim Planlama Stajyeri', company: 'Gediz Beyaz Eşya Yan Sanayi A.Ş.', city: 'Manisa',
        start: 'Temmuz 2025', end: 'Eylül 2025',
        desc: 'Haftalık üretim planlarını hazırlayan ekipte 8 hafta görev aldım.\n' +
          'Sayım farkları için Excel makrosu yazdım; günlük rapor 1 saatten 15 dakikaya indi.'
      },
      {
        id: 'ogr-is-2', role: 'Kurumsal İlişkiler Koordinatörü (Gönüllü)', company: 'Ege Üniversitesi Endüstri Mühendisliği Kulübü',
        city: 'İzmir', start: 'Ekim 2024', end: 'Devam ediyor',
        desc: '12 kişilik ekiple 4 sektör buluşması düzenledim; 450 katılımcıya ulaştık, 6 firmadan sponsorluk aldık.'
      }
    ],
    skills: 'Python (Pandas), Excel (pivot tablo, makro), SQL, Arena Simulation, Minitab, Power BI, AutoCAD',
    langs: 'Türkçe ana dil, İngilizce B2 · IELTS 6.5 (2025), İtalyanca A2',
    certs: 'Lean Six Sigma Yellow Belt — Ege Üniversitesi Sürekli Eğitim Merkezi, 2025',
    hobbies: '',
    refs: '',
    birth: '',
    military: '',
    license: '',
    marital: ''
  };

  var SAMPLE_SAHA = {
    name: 'Mehmet Yıldız',
    title: 'Forklift Operatörü',
    phone: '0532 765 43 21',
    email: 'mehmet.yildiz@example.com',
    city: 'Gebze, Kocaeli',
    web: '',
    github: '',
    photo: '',
    summary: '8 yıllık forklift operatörüyüm; vardiyalı çalışmaya uygunum, hemen başlayabilirim.',
    certs: 'B Sınıfı Sürücü Belgesi (2014)\n' +
      'Forklift Operatör Belgesi — MEB onaylı kurs, 2018\n' +
      'SRC 4 Belgesi (2020)\n' +
      'Psikoteknik Belgesi (2024)\n' +
      'İş Sağlığı ve Güvenliği Temel Eğitimi — 16 saat, 2023',
    jobs: [
      {
        id: 'saha-is-1', role: 'Forklift Operatörü', company: 'Marmara Lojistik Hizmetleri A.Ş.', city: 'Çayırova, Kocaeli',
        start: 'Mart 2021', end: 'Devam ediyor',
        desc: 'Vardiyada ortalama 120 palet yükleme ve boşaltma yapıyorum.\n' +
          'El terminaliyle depo yönetim sistemine stok giriş ve çıkışlarını kaydediyorum.\n' +
          'İki yıldır kazasız çalışıyorum; yeni başlayan 4 operatöre iş başında eğitim verdim.'
      },
      {
        id: 'saha-is-2', role: 'Depo Elemanı ve Forklift Operatörü', company: 'Körfez Gıda Dağıtım Ltd. Şti.', city: 'Dilovası, Kocaeli',
        start: 'Haziran 2018', end: 'Şubat 2021',
        desc: 'Soğuk hava deposunda sevkiyat hazırlığı ve araç yüklemesi yaptım.\n' +
          'Aylık sayımlarda hatasız kasa hedefini 30 ayın 28’inde tutturduk.'
      },
      {
        id: 'saha-is-3', role: 'Depo Elemanı', company: 'Anadolu Market Zinciri', city: 'İzmit, Kocaeli',
        start: 'Ağustos 2016', end: 'Mayıs 2018',
        desc: 'Mal kabul, raf düzeni ve sipariş toplama işlerinde çalıştım.'
      }
    ],
    projects: [],
    edu: [
      {
        id: 'saha-egitim-1', school: 'Gebze Mesleki ve Teknik Anadolu Lisesi', program: 'Motorlu Araçlar Teknolojisi',
        degree: 'Lise', start: '2010', end: '2014', note: ''
      }
    ],
    skills: 'Akülü/dizel forklift (3,5 ton), Reach truck, Transpalet, El terminali (barkod), Depo yönetim sistemi (WMS), ' +
      'Yük bağlama, İstifleme, Fire takibi',
    langs: 'Türkçe ana dil, İngilizce A2',
    hobbies: '',
    refs: '',
    birth: '1996',
    military: 'Yapıldı (2015)',
    license: '',
    marital: ''
  };

  var SAMPLE_YAZILIM = {
    name: 'Can Demir',
    title: 'Backend Geliştirici',
    phone: '0535 111 22 33',
    email: 'can.demir@example.com',
    city: 'Ankara',
    web: 'linkedin.com/in/can-demir-ornek',
    github: 'github.com/candemir-ornek',
    photo: '',
    summary: 'Go ve Python ile yüksek trafikli ödeme ve bildirim servisleri geliştiren backend geliştiriciyim; ' +
      'gözlemlenebilirliğe ve test otomasyonuna önem veriyorum.',
    jobs: [
      {
        id: 'yzl-is-1', role: 'Backend Geliştirici', company: 'Bulut Ödeme Teknolojileri A.Ş.', city: 'Ankara',
        start: 'Şubat 2023', end: 'Devam ediyor',
        desc: 'Günde 2 milyon işlemli ödeme API’sini Go ile yazdım; p95 gecikme %57 düştü.\n' +
          'Kafka tabanlı olay altyapısına geçişte 6 servisin taşınmasını yönettim.\n' +
          'OpenTelemetry ile izleme ve profilleme kurdum; olay çözüm süresi %35 kısaldı.'
      },
      {
        id: 'yzl-is-2', role: 'Yazılım Geliştirici', company: 'Kuzeybatı Yazılım', city: 'Ankara',
        start: 'Temmuz 2021', end: 'Ocak 2023',
        desc: 'Django bildirim servisinde birim test kapsamını %42’den %81’e çıkardım; CI süresini yarıya indirdim.'
      }
    ],
    projects: [
      {
        id: 'yzl-proje-1', name: 'ratelimit-go', tech: 'Go, Redis', link: 'github.com/candemir-ornek/ratelimit-go',
        desc: 'Redis destekli, kayan pencereli bir istek sınırlama kütüphanesi yazdım; 320 GitHub yıldızı aldı.'
      },
      {
        id: 'yzl-proje-2', name: 'pg-snapshot-cli', tech: 'Python, PostgreSQL, Docker', link: 'github.com/candemir-ornek/pg-snapshot-cli',
        desc: 'Test veritabanlarını anlık görüntüden geri yükleyen bir CLI yazdım; kurulum 20 dakikadan 2 dakikaya indi.'
      }
    ],
    edu: [
      {
        id: 'yzl-egitim-1', school: 'Orta Doğu Teknik Üniversitesi', program: 'Bilgisayar Mühendisliği', degree: 'Lisans',
        start: '2017', end: '2021', note: ''
      }
    ],
    skills: 'Diller: Go, Python, SQL, TypeScript\n' +
      'Framework: Django, FastAPI, gRPC\n' +
      'Altyapı: PostgreSQL, Redis, Kafka, Docker, Kubernetes, GitHub Actions, AWS',
    langs: 'Türkçe ana dil, İngilizce C1 · TOEFL iBT 102 (2022)',
    certs: 'AWS Certified Developer – Associate (2024)',
    hobbies: '',
    refs: '',
    birth: '',
    military: '',
    license: '',
    marital: ''
  };

  // Örnek ön yazı (SAMPLE için; önizleme ve testler). Tarih boşsa bugünün tarihi basılır.
  var LETTER_SAMPLE = {
    date: '',
    recipient: ['Kuzey Lojistik A.Ş.', 'İnsan Kaynakları', 'İzmir'],
    subject: 'Konu: Proje Yöneticisi pozisyonu başvurusu',
    greeting: 'Sayın İlgili,',
    paragraphs: [
      'Kuzey Lojistik’in yayımladığı Proje Yöneticisi ilanını ilgiyle okudum. Lojistik ve perakende ' +
        'sektörlerinde on yılı aşkın proje yönetimi deneyimimle depo dönüşümü ve süreç iyileştirme ' +
        'hedeflerinize katkı sağlayabileceğime inanıyorum. İzmir’deki yeni dağıtım merkezinizin kuruluşunda ' +
        'sahada, ekiple birlikte çalışmak beni özellikle heyecanlandırıyor; ilanınız deneyimimle birebir örtüşüyor.',
      'Atlas Lojistik’te 12 kişilik çapraz fonksiyonlu bir ekiple depo yönetim sistemi dönüşümünü 9 ayda ve ' +
        'bütçe dahilinde tamamladım. Depo ekipleri, bilgi teknolojileri ve tedarikçiler arasında haftalık bir ' +
        'karar toplantısı kurarak gecikmeleri erkenden görünür hâle getirdik. Altı depoda hayata geçirdiğimiz ' +
        'süreç iyileştirmeleriyle sipariş hazırlama süresini %27 kısalttık. Nakliye sözleşmelerini yeniden ' +
        'müzakere ederek yıllık taşıma maliyetlerini %11 düşürdüm. Proje boyunca bütçe sapmasını %3’ün altında tuttuk.',
      'İlanınızda öne çıkan çok depolu operasyon ve ERP entegrasyonu, son yıllarda en çok zaman ayırdığım ' +
        'konular. Kuzey Perakende Grubu’nda 48 mağazada yeni kasa ve stok sisteminin kurulumunu planlanandan iki ' +
        'hafta önce bitirdim; Scrum uygulamalarını üç ekibe yayarak sprint hedeflerine ulaşma oranını %68’den ' +
        '%91’e çıkardım. Her projede ölçülebilir hedefler koyar, ilerlemeyi panolarla herkesle paylaşırım. ' +
        'Paydaşları erkenden aynı hedefte buluşturmayı, riskleri görünür kılmayı ve sorunları büyümeden çözmeyi önemsiyorum.',
      'Ekibinizin önümüzdeki dönem hedeflerini dinlemek ve bu hedeflere nasıl katkı sağlayabileceğimi somut ' +
        'örneklerle anlatmak isterim. Size uygun bir zamanda görüşmekten memnuniyet duyarım. Özgeçmişimi ekte ' +
        'bilgilerinize sunarım; zaman ayırdığınız için teşekkür ederim.'
    ],
    closing: 'Saygılarımla,',
    name: ''
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

  // İki kez yapıştırılmış protokol ("https://https://github.com/ali") tek sayılır; bağlantıda sonuncusu kalır.
  function webDisplay(w) { return w.replace(/^(?:https?:\/\/)+/i, '').replace(/\/+$/, ''); }
  function webHref(w) {
    var m = /^(?:https?:\/\/)*(https?:\/\/)/i.exec(w);
    return m ? m[1] + w.slice(m[0].length) : 'https://' + w;
  }
  // Tıklanabilir bağlantı parçası ({ text, link }); görünecek bir şey kalmıyorsa null.
  function linkPart(w) {
    var d = webDisplay(w);
    return d ? { text: d, link: webHref(w) } : null;
  }
  // İki adres aynı yeri mi gösteriyor? Protokol, "www.", sondaki "/" ve harf büyüklüğü yok sayılır.
  function siteKey(w) { return webDisplay(w).replace(/^www\./i, '').toLowerCase(); }
  /*
   * GitHub alanı "github.com/kullanici" biçiminde beklenir. Formdan yalnızca kullanıcı adı
   * ("emreaksoy", "@emreaksoy") girilmişse tamamlanır; yoksa bağlantı "https://emreaksoy" olurdu.
   * GitHub kullanıcı adı: harf/rakam/tire, en çok 39 karakter, tireyle başlamaz.
   * Yalnızca "@" (dikte artığı) boş sayılır.
   */
  function githubValue(v) {
    var m = /^@?([a-z0-9][a-z0-9-]{0,38})$/i.exec(v);
    return m ? 'github.com/' + m[1] : /^@*$/.test(v) ? '' : v;
  }
  // Web/GitHub alanının basılacak (protokolsüz) hâli; build ile hasContent aynı kuralı kullanır.
  function webField(v) { return oneLine(v).replace(/\s+/g, ''); }
  function githubField(v) { return githubValue(webField(v)); }

  /*
   * Teknoloji listesi: "Python,FastAPI" → "Python, FastAPI". Virgülden sonra boşluk yoksa pdfmake
   * (UAX#14) liste içinde satır kıramaz ve satırı sözcük ortasından keser. Ondalık virgül ("Vue 2,7")
   * korunur; boş öğeler ve uçtaki virgüller atılır.
   */
  function techList(v) {
    return oneLine(v).replace(/\s*(?:,\s*)+(?=[^\d\s])/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '');
  }

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

  /*
   * Referans kapanış satırı son bölümün son bölünmez bloğuna eklenir ("öncekiyle birlikte"): sayfa
   * sonunda tek başına yeni bir sayfaya düşüp neredeyse boş bir 2. sayfa açmaz. Son blok bölünebilirse
   * (çok uzun madde) eklenmez; çağıran satırı ayrı basar.
   */
  function keepWithLast(list, node) {
    var last = list[list.length - 1];
    if (last && last.unbreakable === true && Array.isArray(last.stack)) { last.stack.push(node); return true; }
    return false;
  }
  function refsLineNode(L, top) { return { text: L.refsLine, fontSize: 9, color: MUTED, margin: [0, top, 0, 0] }; }

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

  function one(node, lines) { return { head: [node], rest: [], lines: lines || 1 }; }

  // Program + derece: "Endüstri Mühendisliği (Lisans)". Parantez zaten varsa iç içe parantez
  // yerine virgül: "İşletme (MBA), Yüksek Lisans".
  function eduHeading(program, degree) {
    if (program && degree) {
      return /[()]/.test(program + degree) ? program + ', ' + degree : program + ' (' + degree + ')';
    }
    return program || degree;
  }

  /**
   * Alt satır parçalarını ayraçla birleştirir. Parça düz metin ya da tıklanabilir { text, link }
   * olabilir; bağlantı yoksa düz metin, varsa satır içi dizi döner. Boş girdi → ''.
   */
  function inlineText(parts, sep) {
    if (!parts.some(isObj)) return parts.join(sep);
    var out = [];
    parts.forEach(function (p, i) {
      if (i) out.push({ text: sep });
      out.push(isObj(p) ? ext({ text: p.text, link: p.link }, p.noWrap ? { noWrap: true } : null) : { text: p });
    });
    return out;
  }
  function appendText(t, s) {
    if (t === '') return s;
    return typeof t === 'string' ? t + s : t.concat([{ text: s }]);
  }

  /**
   * İş/eğitim/proje maddesi. heading boşsa ve tarih varsa tarih ilk satıra geçer.
   * subParts: düz metin ya da { text, link } (bkz. inlineText).
   * S.dateInSub (sade): tarih ikinci satırda düz metin olarak, sütun kullanılmaz (ATS dostu).
   * Diğerlerinde tarih ünvanla aynı satırda sağa yaslı (noWrap); ünvan, şirket, şehir ve tarih
   * her zaman aynı sütunda ve art arda yazılır (brief §4.1).
   */
  function entryItem(heading, subParts, range, note, bullets, S) {
    var head = [];
    var sub = inlineText(subParts, S.subSep);
    if (S.dateInSub) {
      if (heading) head.push(ext({ text: heading }, S.role));
      if (range) sub = appendText(sub, sub === '' ? range : ' | ' + range);
      if (sub !== '') head.push(ext({ text: sub, margin: [0, heading ? 1 : 0, 0, 0] }, S.sub));
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
      if (sub !== '') head.push(ext({ text: sub, margin: [0, head.length ? 1 : 0, 0, 0] }, S.sub));
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

  /**
   * Proje: başlık = proje adı; alt satır = teknolojiler · bağlantı (her şablonda " · ";
   * teknoloji listesi zaten virgüllü). S.projectSub verilmişse alt satır onun stilinde.
   */
  function projectItem(p, S) {
    var sub = [];
    if (p.tech) sub.push(p.tech);
    // Bağlantı satır sonunda "…/depo-" + "adi" diye bölünmesin: sütuna sığıyorsa noWrap (yoksa bölünebilir, taşmaz).
    if (p.link) sub.push(fits(p.link.text, (S.projectSub || S.sub).fontSize, S.width) ? ext({ noWrap: true }, p.link) : p.link);
    return entryItem(p.name, sub, '', '', p.bullets, ext({}, S, { subSep: ' · ', sub: S.projectSub || S.sub }));
  }

  // "Ad Soyad — Ünvan, Şirket · iletişim": ad kalın, kalanı ikincil renkte. Ayraç yoksa düz satır.
  function refNode(line, nameStyle, restStyle) {
    var m = /^(.+?)\s+[—–-]\s+(.+)$/.exec(line);
    if (!m) return { text: line };
    return { text: [ext({ text: m[1] }, nameStyle), ext({ text: ' — ' + m[2] }, restStyle)] };
  }

  function contactEntries(m, L, skipPhone) {
    var out = [];
    if (m.phone && !skipPhone) out.push({ label: L.phone, value: m.phone });
    if (m.email) out.push({ label: L.email, value: m.email, link: 'mailto:' + m.email });
    if (m.city) out.push({ label: L.city, value: m.city });
    var web = m.web && webDisplay(m.web) ? m.web : '';
    var gh = m.github && webDisplay(m.github) ? m.github : '';
    // Web ile GitHub aynı adresse bir kez yazılır: github.com adresiyse GitHub etiketiyle, değilse
    // (GitHub alanına ör. LinkedIn yazılmışsa) Web etiketiyle.
    if (web && gh && siteKey(web) === siteKey(gh)) {
      if (/^github\.com(\/|$)/.test(siteKey(gh))) web = ''; else gh = '';
    }
    if (web) out.push({ label: L.web, value: webDisplay(web), link: webHref(web), url: true });
    // labelLang: marka adı Türkçe kuralla büyütülmesin ("GİTHUB" değil "GITHUB").
    if (gh) out.push({ label: L.github, labelLang: 'en', value: webDisplay(gh), link: webHref(gh), url: true });
    return out;
  }

  /*
   * İletişim satırı: "0532 … · ad@… · İstanbul · linkedin.com/…" (e-posta/web tıklanabilir), tek
   * metin düğümü. Tek satıra sığmıyorsa bağlantılar (Web, GitHub) ikinci satıra geçer; böylece satır
   * sonunda "·" ya da "github.com/" + "kullanici" diye bölünmüş adres kalmaz. Kısa değerler noWrap
   * (adres ve telefon bölünmez); satırdan uzun bir değer (çok uzun adres) sayfadan taşmasın diye bölünebilir.
   */
  function contactInline(entries, sep, sepColor, size, width) {
    var parts = [];
    var fs = size || 9.5;
    function lineWidth(list) {
      return list.reduce(function (s, e, i) { return s + emWidth(e.value) * fs * 1.04 + (i ? emWidth(sep) * fs : 0); }, 0);
    }
    var lines = [entries];
    if (width > 0 && lineWidth(entries) > width) {
      var basic = entries.filter(function (e) { return !e.url; }), urls = entries.filter(function (e) { return e.url; });
      if (basic.length && urls.length) lines = [basic, urls];
    }
    lines.forEach(function (line, li) {
      if (li) parts.push({ text: '\n' });
      line.forEach(function (e, i) {
        if (i) parts.push(sepColor ? { text: sep, color: sepColor } : { text: sep });
        var p = e.link ? { text: e.value, link: e.link } : { text: e.value };
        if (fits(e.value, fs, width)) p.noWrap = true;
        parts.push(p);
      });
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

  /*
   * Roboto Regular ilerleme genişlikleri (em, yaklaşık). Yalnızca ön yazının tek sayfaya sığıp
   * sığmadığını tahmin etmekte kullanılır (fitLetter); sözcük sözcük satır doldurur.
   */
  var ROBOTO_EM = (function () {
    var t = {}, k;
    var lower = { a: 0.531, b: 0.561, c: 0.523, d: 0.564, e: 0.53, f: 0.347, g: 0.561, h: 0.551, i: 0.243, j: 0.239,
      k: 0.507, l: 0.243, m: 0.876, n: 0.552, o: 0.57, p: 0.561, q: 0.568, r: 0.338, s: 0.516, t: 0.327, u: 0.551,
      v: 0.484, w: 0.751, x: 0.496, y: 0.473, z: 0.496 };
    var upper = { A: 0.652, B: 0.623, C: 0.651, D: 0.656, E: 0.568, F: 0.553, G: 0.681, H: 0.713, I: 0.272, J: 0.552,
      K: 0.627, L: 0.538, M: 0.873, N: 0.713, O: 0.688, P: 0.631, Q: 0.688, R: 0.616, S: 0.594, T: 0.597, U: 0.649,
      V: 0.637, W: 0.887, X: 0.628, Y: 0.601, Z: 0.599 };
    for (k in lower) t[k] = lower[k];
    for (k in upper) t[k] = upper[k];
    var tr = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u',
      'Ç': 'C', 'Ğ': 'G', 'İ': 'I', 'Ö': 'O', 'Ş': 'S', 'Ü': 'U', 'Â': 'A', 'Î': 'I', 'Û': 'U' };
    for (k in tr) t[k] = t[tr[k]];
    '0123456789'.split('').forEach(function (d) { t[d] = 0.561; });
    var punct = { ' ': 0.248, '.': 0.263, ',': 0.196, ':': 0.242, ';': 0.212, '-': 0.276, '–': 0.55, '—': 0.9,
      '(': 0.342, ')': 0.348, '/': 0.411, '%': 0.732, '’': 0.2, '\'': 0.17, '"': 0.32, '&': 0.62, '@': 0.897,
      '+': 0.567, '·': 0.26, '!': 0.258, '?': 0.473 };
    for (k in punct) t[k] = punct[k];
    return t;
  })();
  function emWidth(s) {
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      w += Object.prototype.hasOwnProperty.call(ROBOTO_EM, c) ? ROBOTO_EM[c] : 0.56;
    }
    return w;
  }
  // Metnin `width` genişliğinde kaç satır tutacağı (sözcük sözcük, %4 pay ile).
  function countLines(text, size, width, bold) {
    var factor = size * (bold ? 1.07 : 1.04), space = ROBOTO_EM[' '] * factor;
    var lines = 0;
    String(text).split('\n').forEach(function (seg) {
      var cur = 0, n = 1;
      seg.split(/ +/).forEach(function (word) {
        if (!word) return;
        var w = emWidth(word) * factor;
        if (cur > 0 && cur + space + w > width) { n++; cur = w; } else { cur += (cur > 0 ? space : 0) + w; }
        while (cur > width) { n++; cur -= width; } // satırdan uzun sözcük: pdfmake keser
      });
      lines += n;
    });
    return lines;
  }
  function lineH(size, lh) { return size * LINE_EM * lh; }
  // Bölünmeden (noWrap) yazılabilir mi? Tahmini genişlik sütunun %85'inden azsa.
  function fits(text, size, width) { return width > 0 && emWidth(str(text)) * size * 1.06 < width * 0.85; }
  // Öğe listesi satır içi: öğeler yalnızca aralarından bölünür ("GitHub" / "Actions" değil).
  function listParts(items, sep, size, width, sepStyle) {
    var out = [];
    items.forEach(function (it, i) {
      if (i) out.push(ext({ text: sep }, sepStyle));
      out.push(fits(it, size, width) ? { text: it, noWrap: true } : { text: it });
    });
    return out;
  }

  /* ------------------------------------------------------------- veri modeli */

  function P() {
    var p = root.CVParse;
    if (!p) throw new Error('CVPdf: CVParse bulunamadı — parse.js, pdfdoc.js kullanılmadan önce yüklenmeli.');
    return p;
  }

  function normProfile(p) { return PROFILES.indexOf(p) >= 0 ? p : 'deneyimli'; }

  /**
   * labels(lang, profile) — bölüm ve alan etiketleri. profile 'ogrenci' → "Deneyim";
   * 'saha' → "Belgeler ve Sertifikalar". Her çağrıda yeni nesne.
   */
  function labels(lang, profile) {
    var key = lang === 'en' ? 'en' : 'tr';
    var src = LABELS[key], out = {};
    for (var k in src) out[k] = src[k];
    var ov = PROFILE_LABELS[key][profile];
    if (ov) for (var o in ov) out[o] = ov[o];
    for (var a in LABEL_ALIASES) out[a] = out[LABEL_ALIASES[a]];
    return out;
  }

  /*
   * skillGroups(text) → [{ label, items[] }]. Bir satır "Etiket: a, b, c" biçimindeyse
   * (/^\s*([^:,\n]{2,30}):\s*(.+)$/) bir gruptur. Gruplu metinde etiketsiz satırlar tek, etiketsiz
   * bir grupta toplanır (ilk geçtiği yerde). Hiç grup yoksa düz liste: [{ label: '', items }].
   * Öğeler CVParse.splitList ile ayrılır (virgül, noktalı virgül, "·", "|", "•"; tekrarlar atılır).
   */
  var GROUP_RE = /^\s*([^:,\n]{2,30}):\s*(.+)$/;
  function groupMatch(line) {
    var m = GROUP_RE.exec(line);
    return m && !/^(?:https?|ftp|mailto)$/i.test(m[1].trim()) ? m : null;
  }
  // Parantez içindeki virgül ve "ve" öğeyi bölmez: "Excel (pivot, makro)" tek öğe.
  function splitSkills(s) {
    var depth = 0, t = '';
    s = str(s);
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      t += depth && ch === ',' ? '\u0001' : depth && ch === ';' ? '\u0002' : ch;
    }
    t = t.replace(/\([^()]*\)/g, function (all) { return all.replace(/([\s\u0001])ve(?=\s)/g, '$1\u0003'); });
    return cleanItems(P().splitList(t).map(function (x) {
      return x.replace(/\u0001/g, ',').replace(/\u0002/g, ';').replace(/\u0003/g, 've');
    }));
  }
  function skillGroups(text) {
    var p = P();
    var lines = cleanItems(p.splitLines(str(text)));
    if (!lines.some(groupMatch)) {
      var all = splitSkills(text);
      return all.length ? [{ label: '', items: all }] : [];
    }
    var out = [], loose = null;
    lines.forEach(function (line) {
      var m = groupMatch(line);
      if (m) {
        var items = splitSkills(m[2]);
        if (items.length) out.push({ label: oneLine(m[1]), items: items });
        return;
      }
      var more = splitSkills(line);
      if (!more.length) return;
      if (!loose) { loose = { label: '', items: [] }; out.push(loose); }
      more.forEach(function (it) { if (loose.items.indexOf(it) < 0) loose.items.push(it); });
    });
    return out;
  }

  // Saha: ehliyet ve operatör belgeleri önce (brief §4.2 "licences first"); sıra başka türlü korunur.
  var LICENCE_RE = /(surucu belgesi|ehliyet|(^|[^a-z0-9])src([^a-z]|$)|psikoteknik|operator belgesi|is makinesi|driving licen[cs]e|driver'?s licen[cs]e)/;
  function licencesFirst(list) {
    var p = P();
    function isLic(s) { return LICENCE_RE.test(p.foldAscii(p.trLower(s))); }
    return list.filter(isLic).concat(list.filter(function (s) { return !isLic(s); }));
  }

  // Doğum yılı: "14 Mayıs 1991" → "1991" (brief K2: yalnızca yıl). Yıl yoksa olduğu gibi.
  function birthYear(v) {
    var m = /(^|\D)((?:19|20)\d{2})(?!\d)/.exec(v);
    return m ? m[2] : v;
  }

  /** Ham CV → temizlenmiş, şablonların doğrudan kullandığı model. Boş girdiler ayıklanır. */
  function readModel(cv, lang, o) {
    var p = P();
    var L = labels(lang, o.profile);
    cv = isObj(cv) ? cv : {};

    function range(a, b) {
      a = oneLine(a);
      b = oneLine(b);
      return a || b ? oneLine(p.formatRange(a, b, lang, { numeric: !!o.numericDates })) : '';
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

    // Adı da açıklaması da olmayan proje (yalnızca teknoloji/bağlantı) basılmaz.
    var projects = arr(cv.projects).map(function (pr) {
      pr = isObj(pr) ? pr : {};
      return {
        name: oneLine(pr.name), tech: techList(pr.tech),
        link: linkPart(oneLine(pr.link).replace(/\s+/g, '')),
        bullets: cleanItems(p.splitLines(str(pr.desc)))
      };
    }).filter(function (pr) { return pr.name || pr.bullets.length; });

    // Diller: ad + "B2 (Orta-üst) · IELTS 6.5 (2024)" (çubuk, nokta, yüzde yok — brief §4.1).
    var details = typeof p.parseLanguageDetails === 'function' ? p.parseLanguageDetails(str(cv.langs)) : p.parseLanguages(str(cv.langs));
    var langs = [];
    arr(details).forEach(function (l) {
      if (!isObj(l)) return;
      var name = oneLine(p.languageName(oneLine(l.name), lang));
      if (!name) return; // yalnızca seviye söylenmiş ("ana dil"): gösterecek dil adı yok
      var detail = typeof p.languageDetailText === 'function' ? oneLine(p.languageDetailText(l, lang))
        : (l.level ? oneLine(p.levelLabel(l.level, lang)) : '');
      langs.push({ name: name, detail: detail, full: detail ? name + ' — ' + detail : name });
    });

    // Askerlik İngilizce CV'de basılmaz (brief §3.2).
    var personal = (lang === 'en' ? ['birth', 'license', 'marital'] : ['birth', 'military', 'license', 'marital']).map(function (k) {
      var v = oneLine(cv[k]);
      return { label: L[k], value: k === 'birth' ? birthYear(v) : v };
    }).filter(function (x) { return x.value; });

    var certs = cleanItems(p.splitLines(str(cv.certs)));
    if (o.profile === 'saha') certs = licencesFirst(certs);

    var groups = skillGroups(cv.skills);

    return {
      name: oneLine(cv.name),
      title: oneLine(cv.title),
      phone: oneLine(cv.phone),
      email: oneLine(cv.email).replace(/\s+/g, ''),
      city: oneLine(cv.city),
      web: webField(cv.web),
      github: githubField(cv.github),
      photo: cleanImage(cv.photo),
      summary: paragraphs(cv.summary),
      jobs: jobs,
      projects: projects,
      edu: edu,
      skills: groups,
      skillsGrouped: groups.some(function (g) { return g.label; }),
      hobbies: cleanItems(p.splitList(str(cv.hobbies))),
      langs: langs,
      certs: certs,
      refs: cleanItems(p.splitLines(str(cv.refs))),
      personal: personal
    };
  }

  // Bölümün basılacak içeriği var mı?
  function sectionHas(m, key) {
    switch (key) {
      case 'profile': return m.summary.length > 0;
      case 'experience': return m.jobs.length > 0;
      case 'projects': return m.projects.length > 0;
      case 'education': return m.edu.length > 0;
      case 'skills': return m.skills.length > 0;
      case 'languages': return m.langs.length > 0;
      case 'certs': return m.certs.length > 0;
      case 'personal': return m.personal.length > 0;
      case 'hobbies': return m.hobbies.length > 0;
      case 'refs': return m.refs.length > 0;
    }
    return false;
  }

  /*
   * İş deneyiminin toplam süresi (ay): en erken başlangıçtan en geç bitişe. Yalnızca yıl yazılmışsa
   * başlangıç Ocak, bitiş Aralık sayılır; "Devam ediyor" bugündür. Tarihi okunamayan iş varsa -1.
   */
  function experienceMonths(jobs) {
    var p = P(), now = new Date(), min = Infinity, max = -Infinity, bad = false;
    function ym(v, isEnd) {
      var s = oneLine(p.formatDate(oneLine(v), 'tr', { numeric: true }));
      if (!s) return null;
      if (s === 'Günümüz') return now.getFullYear() * 12 + now.getMonth();
      var m = /^(\d{2})\/(\d{4})$/.exec(s);
      if (m) return +m[2] * 12 + (+m[1] - 1);
      m = /^(\d{4})$/.exec(s);
      if (m) return +m[1] * 12 + (isEnd ? 11 : 0);
      return null;
    }
    arr(jobs).forEach(function (j) {
      if (!isObj(j)) return;
      if (!oneLine(j.role) && !oneLine(j.company) && !oneLine(j.start) && !oneLine(j.end)) return;
      var a = ym(j.start, false), b = ym(j.end, true);
      if (a === null && b === null) { bad = true; return; }
      if (a === null) a = b;
      if (b === null) b = a;
      min = Math.min(min, a);
      max = Math.max(max, b);
    });
    if (bad) return -1;
    return min === Infinity ? 0 : Math.max(0, max - min + 1);
  }

  /**
   * sectionOrder(profile, cv, opts) → bölüm anahtarları sırasıyla (ör. ['profile', 'experience', …, 'refs']).
   * Yazılım profilinde yeni başlayanlar (toplam iş deneyimi 24 aydan az; ya da opts.projectsFirst)
   * Projeler'i İş Deneyimi'nden önce görür (brief §4.2). opts.projectsFirst === false bunu kapatır.
   */
  function sectionOrder(profile, cv, opts) {
    profile = normProfile(profile);
    opts = isObj(opts) ? opts : {};
    var order = ORDER[profile].slice();
    if (profile === 'yazilim') {
      var first = opts.projectsFirst;
      if (typeof first !== 'boolean') {
        var months = experienceMonths(isObj(cv) ? cv.jobs : []);
        first = months >= 0 && months < 24;
      }
      if (first) {
        var pi = order.indexOf('projects');
        order.splice(pi, 1);
        order.splice(order.indexOf('experience'), 0, 'projects');
      }
    }
    order.push('refs');
    return order;
  }

  /* --------------------------------------------------------- şablon: modern */

  var MODERN = {
    MAIN_W: 310, GAP: 22,
    // kenar çubuğu zemini sayfanın sağ kenarına taşar; metin kutusu sağ kenar boşluğunda biter
    TINT_X: 360,
    PHOTO: 84, PHOTO_GAP: 16
  };

  /*
   * Yuvarlak fotoğraf: SVG kırpma yolu (clipPath circle) + preserveAspectRatio "xMidYMid slice".
   * 3:4 (600×800) ve kare (eski) fotoğrafların ikisi de ortadan kırpılır; JPEG olduğu gibi gömülür
   * (yeniden kodlama yok, dosya küçük). pdfmake 0.2.10 SVG düğümlerini svg-to-pdfkit ile çizer.
   */
  function roundPhotoSvg(src, d) {
    return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + d +
      '" height="' + d + '" viewBox="0 0 ' + d + ' ' + d + '"><defs><clipPath id="cvfoto"><circle cx="' + d / 2 +
      '" cy="' + d / 2 + '" r="' + d / 2 + '"/></clipPath></defs><image x="0" y="0" width="' + d + '" height="' + d +
      '" preserveAspectRatio="xMidYMid slice" clip-path="url(#cvfoto)" xlink:href="' + src + '"/></svg>';
  }

  // Modern başlık: ad (DM Serif 30), ünvan (Medium 10, büyük harf), iletişim (9pt " · "), isteğe bağlı yuvarlak foto.
  function modernHeader(m, c, width, photo) {
    var A = c.accent, L = c.L, lang = c.lang;
    var hs = [];
    if (m.name) hs.push({ text: m.name, font: 'DMSerif', fontSize: 30, lineHeight: 1, color: INK });
    if (m.title) {
      hs.push({ text: upperText(m.title, lang), bold: true, fontSize: 10, characterSpacing: 0.7, color: A, margin: [0, hs.length ? 5 : 0, 0, 0] });
    }
    var ce = contactEntries(m, L);
    if (ce.length) {
      hs.push({ text: contactInline(ce, '  ·  ', mix(MUTED, WHITE, 0.35), 9, photo ? width - MODERN.PHOTO - MODERN.PHOTO_GAP : width), fontSize: 9, color: INK, margin: [0, hs.length ? 8 : 0, 0, 0] });
    }
    var out = [];
    if (photo) {
      var tw = width - MODERN.PHOTO - MODERN.PHOTO_GAP;
      out.push({
        columns: [
          { width: tw, stack: hs.length ? hs : [{ text: '' }] }, // TEXT_COL
          { width: MODERN.PHOTO, svg: roundPhotoSvg(photo, MODERN.PHOTO) }
        ],
        columnGap: MODERN.PHOTO_GAP
      });
    } else if (hs.length) {
      out.push({ stack: hs });
    }
    return out;
  }

  function buildModern(m, c) {
    var A = c.accent, L = c.L, lang = c.lang, dark = c.sidebar === 'dark';
    var CW = PAGE.width - MARGINS.modern[0] - MARGINS.modern[2]; // 515.28
    var MAIN_W = MODERN.MAIN_W, SIDE_W = CW - MAIN_W - MODERN.GAP; // 310 + 22 + 183.28
    var tint = dark ? A : mix(A, WHITE, 0.9);
    var C = {
      company: mix(A, INK, 0.3), // vurgu rengi, okunurluk için mürekkebe doğru
      sideText: dark ? WHITE : INK,
      sideMuted: dark ? mix(A, WHITE, 0.82) : MUTED,
      sideHead: dark ? WHITE : A
    };
    var content = modernHeader(m, c, CW, c.photo);
    var hasHeader = content.length > 0;
    if (hasHeader) content.push(hline(CW, 1, A, [0, 12, 0, 0]));

    /* ana sütun */
    var MAIN_KEEP = keepLimit(MAIN_W), SIDE_KEEP = keepLimit(SIDE_W);
    function mainHeading(label) {
      return {
        stack: [
          { text: upperLabel(label, lang), bold: true, fontSize: 9.5, characterSpacing: 0.7, color: A },
          { canvas: [{ type: 'rect', x: 0, y: 0, w: 24, h: 1.5, color: A }], margin: [0, 3, 0, 7] }
        ]
      };
    }
    var S = {
      role: { bold: true, fontSize: 10.5, color: INK },
      date: { fontSize: 9, color: MUTED },
      dateTop: ASC * 1.5, // 10.5pt ünvan ile 9pt tarihin taban çizgileri hizalı
      sub: { fontSize: 9, color: C.company },
      subSep: ' · ',
      note: { fontSize: 9, color: MUTED },
      bulletSize: 10, bulletGap: 1.5, bulletTop: 3, markerColor: A,
      width: MAIN_W // ünvan + tarih satırının sığma kontrolü için
    };
    function mainSection(key) {
      switch (key) {
        case 'profile': return flow(mainHeading(L.profile), m.summary.map(function (p) { return one({ text: p }); }), 5, MAIN_KEEP);
        case 'experience': return flow(mainHeading(L.experience), m.jobs.map(function (j) { return jobItem(j, S); }), 10, MAIN_KEEP);
        case 'projects': return flow(mainHeading(L.projects), m.projects.map(function (p) { return projectItem(p, S); }), 10, MAIN_KEEP);
        case 'education': return flow(mainHeading(L.education), m.edu.map(function (e) { return eduItem(e, S); }), 8, MAIN_KEEP);
        case 'refs':
          return flow(mainHeading(L.refs), m.refs.map(function (r) {
            return one(refNode(r, { bold: true, color: INK }, { color: MUTED }));
          }), 4, MAIN_KEEP);
      }
      return null;
    }

    /* kenar çubuğu: kısa, kendi içinde anlamlı maddeler; başlık/şirket/tarih yok */
    function sideHeading(label) {
      return {
        stack: [
          { text: upperLabel(label, lang), bold: true, fontSize: 9, characterSpacing: 0.7, color: C.sideHead },
          { canvas: [{ type: 'rect', x: 0, y: 0, w: 18, h: 1.2, color: C.sideHead }], margin: [0, 3, 0, 7] }
        ]
      };
    }
    function sideText(text, extra) { return ext({ text: text, fontSize: 9.5, color: C.sideText }, extra); }
    function sideLabel(text) { return { text: text, fontSize: 8.5, color: C.sideMuted, margin: [0, 0, 0, 1] }; }
    function sideSection(key) {
      switch (key) {
        case 'skills':
          if (m.skillsGrouped) {
            return flow(sideHeading(L.skills), m.skills.map(function (g) {
              var nodes = [];
              if (g.label) nodes.push(ext(sideLabel(g.label), { bold: true }));
              nodes.push(sideText(listParts(g.items, ', ', 9.5, SIDE_W)));
              return { head: [{ stack: nodes }], rest: [] };
            }), 6, SIDE_KEEP);
          }
          return flow(sideHeading(L.skills), m.skills[0].items.map(function (s) { return one(sideText(s)); }), 2.5, SIDE_KEEP);
        case 'languages':
          return flow(sideHeading(L.languages), m.langs.map(function (l) {
            var nodes = [sideText(l.name, { bold: true })];
            if (l.detail) nodes.push({ text: l.detail, fontSize: 9, color: C.sideMuted, margin: [0, 1, 0, 0] });
            return { head: [{ stack: nodes }], rest: [] };
          }), 6, SIDE_KEEP);
        case 'certs':
          return flow(sideHeading(L.certs), m.certs.map(function (x) { return one(sideText(x)); }), 5, SIDE_KEEP);
        case 'personal':
          return flow(sideHeading(L.personal), m.personal.map(function (x) {
            return { head: [{ stack: [sideLabel(x.label), sideText(x.value)] }], rest: [] };
          }), 5, SIDE_KEEP);
        case 'hobbies':
          return flow(sideHeading(L.hobbies), [one(sideText(m.hobbies.join(', ')))], 0, SIDE_KEEP);
      }
      return null;
    }

    var main = [], side = [];
    c.order.forEach(function (key) {
      if (key === 'refs') return;
      if (!sectionHas(m, key)) return;
      if (MODERN_MAIN[key]) main.push(mainSection(key)); else side.push(sideSection(key));
    });
    if (m.refs.length) main.push(mainSection('refs'));
    var tail = !m.refs.length && c.refsLine && (main.length || side.length);
    if (tail && main.length && keepWithLast(main[main.length - 1], refsLineNode(L, 16))) tail = false;
    var mainStack = main.map(function (s, i) { return { stack: s, margin: [0, i ? 16 : 0, 0, 0] }; });
    if (tail) mainStack.push(refsLineNode(L, main.length ? 16 : 0));
    var sideStack = side.map(function (s, i) { return { stack: s, margin: [0, i ? 16 : 0, 0, 0] }; });

    if (mainStack.length || sideStack.length) {
      /*
       * Kenar çubuğu zemini, 1. sayfada başlığın altından sayfanın dibine kadar: akışta, sütunlardan
       * hemen önce, yüksekliği 0 olan bir tuval. Dikdörtgen negatif yükseklikle aşağıdan yukarı
       * çizilir (y = H, h = −H): pdfmake tuvalin yüksekliğini max(y + h) = 0 sayar, böylece akışta yer
       * kaplamaz ve sayfa atlatmaz; çizim yine de başlığın altından sayfa sonuna (ve ötesine) uzanır.
       * Başlık yoksa sayfanın üstünden başlar. 2. sayfa ve sonrasında zemini background() çizer.
       */
      var top = hasHeader ? 0 : MARGINS.modern[1];
      var H = PAGE.height;
      content.push({
        canvas: [{ type: 'rect', x: MODERN.TINT_X - MARGINS.modern[0], y: H, w: PAGE.width - MODERN.TINT_X, h: -(H + top), color: tint }]
      });
      content.push({
        columns: [
          { width: MAIN_W, stack: mainStack.length ? mainStack : [{ text: '' }] },
          { width: SIDE_W, stack: sideStack.length ? sideStack : [{ text: '' }] }
        ],
        columnGap: MODERN.GAP,
        margin: [0, hasHeader ? 16 : 0, 0, 0]
      });
    }

    return {
      content: content.length ? content : [{ text: '' }],
      // 2. sayfa ve sonrası: kenar çubuğu zemini tam yükseklikte (1. sayfada akıştaki tuval çizer).
      background: function (currentPage, pageSize) {
        if (!(currentPage > 1) || !(mainStack.length || sideStack.length)) return null;
        var h = pageSize && typeof pageSize.height === 'number' && isFinite(pageSize.height) && pageSize.height > 0
          ? pageSize.height : PAGE.height;
        return { canvas: [{ type: 'rect', x: MODERN.TINT_X, y: 0, w: PAGE.width - MODERN.TINT_X, h: h, color: tint }] };
      },
      // altbilgi ana sütunun kutusunda (kenar çubuğunun zemininde değil)
      footerMargin: [MARGINS.modern[0], 14, PAGE.width - MARGINS.modern[0] - MAIN_W, 0]
    };
  }

  /* --------------------------------------------------------- şablon: klasik */

  var KLASIK = { GUT: 92, GAP: 14, PHOTO_W: 68, PHOTO_H: 91, PHOTO_GAP: 18 };

  // Klasik başlık: ad (DM Serif 28), ünvan (DM Serif 13, vurgu), iletişim (9.5 MUTED, telefon önce, " · ").
  // Kısa CV (saha): telefon adın altında kendi satırında Medium 12; e-posta ve şehir 9.5 ile ardından.
  function klasikHeader(m, c, width, photo) {
    var A = c.accent, L = c.L;
    var SEP = mix(MUTED, WHITE, 0.45);
    var hs = [];
    if (m.name) hs.push({ text: m.name, font: 'DMSerif', fontSize: 28, lineHeight: 1.05, color: INK });
    if (m.title) hs.push({ text: m.title, font: 'DMSerif', italics: true, fontSize: 13, color: A, margin: [0, hs.length ? 1 : 0, 0, 0] });
    var shortCv = c.profile === 'saha' && !!m.phone;
    if (shortCv) hs.push({ text: m.phone, bold: true, fontSize: 12, color: INK, margin: [0, hs.length ? 7 : 0, 0, 0] });
    var ce = contactEntries(m, L, shortCv);
    if (ce.length) {
      hs.push({ text: contactInline(ce, '  ·  ', SEP, 9.5, photo ? width - KLASIK.PHOTO_W - KLASIK.PHOTO_GAP : width), fontSize: 9.5, color: MUTED, margin: [0, hs.length ? (shortCv ? 2 : 8) : 0, 0, 0] });
    }
    var out = [];
    if (photo) {
      out.push({
        columns: [
          { width: width - KLASIK.PHOTO_W - KLASIK.PHOTO_GAP, stack: hs.length ? hs : [{ text: '' }] }, // TEXT_COL
          { width: KLASIK.PHOTO_W, image: photo, fit: [KLASIK.PHOTO_W, KLASIK.PHOTO_H] }
        ],
        columnGap: KLASIK.PHOTO_GAP
      });
    } else if (hs.length) {
      out.push({ stack: hs });
    }
    return out;
  }

  function buildKlasik(m, c) {
    var A = c.accent, L = c.L, lang = c.lang;
    var CW = PAGE.width - MARGINS.klasik[0] - MARGINS.klasik[2]; // 493.28
    var GUT = KLASIK.GUT, GAP = KLASIK.GAP;
    var BODY = CW - GUT - GAP; // bölüm içerik sütunu: 387.28 (TEXT_COL)
    var KEEP = keepLimit(BODY);
    var SEP = mix(MUTED, WHITE, 0.45); // ayraç noktaları metinden bir ton açık
    var content = klasikHeader(m, c, CW, c.photo);
    var hasHeader = content.length > 0;
    if (hasHeader) content.push(hline(CW, 1.2, A, [0, 12, 0, 0]));

    var S = {
      role: { bold: true, fontSize: 10.5, color: INK },
      date: { fontSize: 9, color: MUTED },
      dateTop: ASC * 1.5,
      sub: { fontSize: 9.5, color: mix(A, INK, 0.3) },
      subSep: ' · ',
      projectSub: { fontSize: 9.5, color: MUTED }, // proje teknolojileri/bağlantısı: şirket satırından sakin
      note: { fontSize: 9.5, color: MUTED },
      bulletSize: 10, bulletGap: 1.5, bulletTop: 3, markerColor: A,
      width: BODY
    };

    /*
     * [başlık oluğu | içerik] satırı. Başlık + ilk madde tek blok (bölünmez). Oluk dar (92pt):
     * "KİŞİSEL BİLGİLER" iki satıra taşar; ilk satırda tek kısa madde olursa ikinci madde başlığın
     * altından başlar ve maddeler arasında boşluk kalır. Bu yüzden başlık kaç satırsa ilk bloğa en
     * az o kadar satırlık madde alınır (madde imi "kalan"ı olan bir maddeden sonra durulur).
     * Oluk etiketi içeriğin ilk satırının taban çizgisine hizalanır (firstSize: o satırın puntosu).
     */
    function section(label, items, gap, withRule, firstSize, tail) {
      var text = upperLabel(label, lang);
      var hd = {
        text: text, bold: true, fontSize: 8.5, characterSpacing: 0.6, lineHeight: 1.2, color: A,
        margin: [0, Math.max(0, ASC * (firstSize - 8.5)), 0, 0]
      };
      var need = estimateLines(text, 8.5, 0.6, GUT);
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
      var row1 = { columns: [{ width: GUT, stack: [hd] }, { width: BODY, stack: firstCol }], columnGap: GAP };
      var lead = withRule ? hline(CW, 0.6, RULE, [0, 10, 0, 10]) : null;
      var out = [keepTogether(lead ? [lead, row1] : [row1], KEEP)];
      if (!withRule && hasHeader) out[0].margin = [0, 14, 0, 0];
      if (tail) {
        // kapanış satırı içerik sütununda, son bloğa bağlı (bkz. keepWithLast)
        if (restCol.length) { if (!keepWithLast(restCol, tail)) restCol.push(tail); } else if (out[0].unbreakable) firstCol.push(tail); else restCol.push(tail);
      }
      if (restCol.length) out.push({ columns: [{ width: GUT, text: '' }, { width: BODY, stack: restCol }], columnGap: GAP });
      return out;
    }

    function skillNodes() {
      if (m.skillsGrouped) {
        return m.skills.map(function (g) {
          var parts = g.label ? [{ text: g.label + ': ', bold: true }] : [];
          return one({ text: parts.concat(listParts(g.items, ', ', 10, BODY)) });
        });
      }
      return [one({ text: listParts(m.skills[0].items, '  ·  ', 10, BODY, { color: SEP }) })];
    }

    var secs = [];
    c.order.forEach(function (key) {
      if (!sectionHas(m, key)) return;
      switch (key) {
        case 'profile': secs.push([L.profile, m.summary.map(function (p) { return one({ text: p }); }), 4, 10]); break;
        case 'experience': secs.push([L.experience, m.jobs.map(function (j) { return jobItem(j, S); }), 9, 10.5]); break;
        case 'projects': secs.push([L.projects, m.projects.map(function (p) { return projectItem(p, S); }), 9, 10.5]); break;
        case 'education': secs.push([L.education, m.edu.map(function (e) { return eduItem(e, S); }), 8, 10.5]); break;
        case 'skills': secs.push([L.skills, skillNodes(), 2, 10]); break;
        case 'languages':
          secs.push([L.languages, m.langs.map(function (l) {
            var parts = [{ text: l.name, bold: true }];
            if (l.detail) parts.push({ text: ' — ' + l.detail });
            return one({ text: parts });
          }), 2, 10]);
          break;
        case 'certs': secs.push([L.certs, m.certs.map(function (x) { return one({ text: x }); }), 2, 10]); break;
        case 'personal':
          secs.push([L.personal, m.personal.map(function (x) {
            return one({ text: [{ text: x.label + ': ', color: MUTED }, { text: x.value }] });
          }), 2, 10]);
          break;
        case 'hobbies': secs.push([L.hobbies, [one({ text: m.hobbies.join(', ') })], 0, 10]); break;
        case 'refs':
          secs.push([L.refs, m.refs.map(function (r) {
            return one(refNode(r, { bold: true, color: INK }, { color: MUTED }));
          }), 3, 10]);
          break;
      }
    });
    var refsTail = !m.refs.length && c.refsLine ? refsLineNode(L, 16) : null;
    secs.forEach(function (s, i) {
      content.push.apply(content, section(s[0], s[1], s[2], i > 0, s[3], i === secs.length - 1 ? refsTail : null));
    });

    return { content: content.length ? content : [{ text: '' }], footerMargin: [MARGINS.klasik[0], 18, MARGINS.klasik[2], 0] };
  }

  // Kaba genişlik tahmini (Roboto Medium büyük harf). Yalnızca klasik şablonda iki satıra
  // taşan oluk başlığı için ilk satıra kaç madde alınacağını seçmekte kullanılır.
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

  /* ------------------------------------------------------------ şablon: sade */

  // Sade başlık: ad (Roboto Medium 22), ünvan (11 MUTED), iletişim (9.5 INK, "  |  ").
  function sadeHeader(m, c, width) {
    var out = [];
    if (m.name) out.push({ text: m.name, bold: true, fontSize: 22, lineHeight: 1.05, color: INK });
    if (m.title) out.push({ text: m.title, fontSize: 11, color: MUTED, margin: [0, out.length ? 2 : 0, 0, 0] });
    var ce = contactEntries(m, c.L);
    if (ce.length) out.push({ text: contactInline(ce, '  |  ', '', 9.5, width), fontSize: 9.5, color: INK, margin: [0, out.length ? 6 : 0, 0, 0] });
    return out;
  }

  // ATS dostu: tek sütun, düz metin; sütun/tablo yok. Tek çizim, başlıkların altındaki ince çizgi.
  function buildSade(m, c) {
    var A = c.accent, L = c.L, lang = c.lang;
    var CW = PAGE.width - MARGINS.sade[0] - MARGINS.sade[2]; // 481.28
    var KEEP = keepLimit(CW);
    var RULE_SADE = mix(INK, WHITE, 0.7); // RULE'dan biraz koyu: ince çizgi baskıda kaybolmasın
    var content = sadeHeader(m, c, CW);
    var hasHeader = content.length > 0;

    function heading(label) {
      return {
        stack: [
          { text: upperLabel(label, lang), bold: true, fontSize: 10.5, characterSpacing: 0, color: A },
          hline(CW, 0.5, RULE_SADE, [0, 2, 0, 6])
        ]
      };
    }
    var S = {
      role: { bold: true, fontSize: 10.5, color: INK },
      sub: { fontSize: 9.5, color: MUTED },
      subSep: ', ',
      dateInSub: true,
      note: { fontSize: 9.5, color: MUTED },
      bulletSize: 10.5, bulletGap: 2, bulletTop: 3,
      width: CW
    };

    var secs = [];
    c.order.forEach(function (key) {
      if (!sectionHas(m, key)) return;
      switch (key) {
        case 'profile': secs.push(flow(heading(L.profile), m.summary.map(function (p) { return one({ text: p }); }), 4, KEEP)); break;
        case 'experience': secs.push(flow(heading(L.experience), m.jobs.map(function (j) { return jobItem(j, S); }), 8, KEEP)); break;
        case 'projects': secs.push(flow(heading(L.projects), m.projects.map(function (p) { return projectItem(p, S); }), 8, KEEP)); break;
        case 'education': secs.push(flow(heading(L.education), m.edu.map(function (e) { return eduItem(e, S); }), 8, KEEP)); break;
        case 'skills':
          secs.push(flow(heading(L.skills), m.skillsGrouped ? m.skills.map(function (g) {
            var parts = g.label ? [{ text: g.label + ': ', bold: true }] : [];
            return one({ text: parts.concat(listParts(g.items, ', ', 10.5, CW)) });
          }) : [one({ text: listParts(m.skills[0].items, ', ', 10.5, CW) })], 2, KEEP));
          break;
        case 'languages':
          secs.push(flow(heading(L.languages), [one({ text: m.langs.map(function (l) { return l.full; }).join('  ·  ') })], 0, KEEP));
          break;
        case 'certs': secs.push(flow(heading(L.certs), m.certs.map(function (x) { return one({ text: x }); }), 2, KEEP)); break;
        case 'personal':
          secs.push(flow(heading(L.personal), [one({ text: m.personal.map(function (x) { return x.label + ': ' + x.value; }).join(' · ') })], 0, KEEP));
          break;
        case 'hobbies': secs.push(flow(heading(L.hobbies), [one({ text: m.hobbies.join(', ') })], 0, KEEP)); break;
        case 'refs': secs.push(flow(heading(L.refs), m.refs.map(function (r) { return one({ text: r }); }), 3, KEEP)); break;
      }
    });

    var tail = !m.refs.length && c.refsLine && secs.length > 0;
    if (tail && keepWithLast(secs[secs.length - 1], refsLineNode(L, 14))) tail = false;
    secs.forEach(function (s, i) {
      content.push({ stack: s, margin: [0, i || hasHeader ? 14 : 0, 0, 0] });
    });
    if (tail) content.push(refsLineNode(L, 14));

    return { content: content.length ? content : [{ text: '' }], footerMargin: [MARGINS.sade[0], 18, MARGINS.sade[2], 0] };
  }

  /* ------------------------------------------------------------- genel API */

  function templateById(id) {
    for (var i = 0; i < TEMPLATES.length; i++) if (TEMPLATES[i].id === id) return TEMPLATES[i];
    return null;
  }

  // Geçerli 6 haneli hex olduğu gibi kalır; 3 haneli genişletilir; geçersiz → şablonun varsayılanı.
  function normalizeAccent(v, fallback) {
    var s = str(v).trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s;
    var rgb = parseHex(s);
    return rgb ? toHex(rgb) : fallback;
  }

  // Altbilgi yalnızca 2. sayfa ve sonrasında ("Ad Soyad · 2/2"); 1. sayfada null (brief §4.1).
  function makeFooter(name, margin) {
    return function (currentPage, pageCount) {
      if (!(pageCount > 1) || !(currentPage > 1)) return null;
      return {
        text: (name ? name + ' · ' : '') + currentPage + '/' + pageCount,
        fontSize: 7.5, color: MUTED, alignment: 'right', margin: margin.slice()
      };
    };
  }

  function docInfo(m, kind, lang) {
    var parts = [m.name, m.title, kind].filter(Boolean);
    return { title: parts.join(' — '), author: m.name, subject: kind, creator: 'Sesli CV' };
  }

  // Ortak seçenekler: dil, şablon, profil, vurgu.
  function readOpts(opts) {
    opts = isObj(opts) ? opts : {};
    var lang = opts.lang === 'en' ? 'en' : 'tr';
    var tpl = templateById(opts.template) || TEMPLATES[0];
    var profile = normProfile(opts.profile);
    return {
      lang: lang, tpl: tpl, profile: profile,
      accent: normalizeAccent(opts.accent, DEFAULT_ACCENT[tpl.id]),
      refsLine: typeof opts.refsLine === 'boolean' ? opts.refsLine : lang === 'tr',
      sidebar: opts.sidebar === 'dark' ? 'dark' : 'light',
      raw: opts
    };
  }

  /**
   * build(cv, opts) → pdfmake docDefinition.
   * opts.template: 'klasik' | 'sade' | 'modern' (bilinmeyen → 'klasik'); opts.accent: hex (geçersiz →
   * şablonun varsayılanı); opts.lang: 'tr' | 'en' (diğerleri → 'tr'); opts.showPhoto: varsayılan true
   * (sade hiçbir zaman fotoğraf basmaz); opts.profile: 'deneyimli' (varsayılan) | 'ogrenci' | 'saha' |
   * 'yazilim' — bölüm sırası, saha Kısa CV başlığı (klasik) ve "Belgeler ve Sertifikalar";
   * opts.refsLine: referans yoksa "Referanslar talep üzerine iletilir." (varsayılan: tr'de açık, en'de
   * kapalı); opts.sidebar: modern kenar çubuğu 'light' (varsayılan) | 'dark'; opts.projectsFirst:
   * yazılım profilinde Projeler'i İş Deneyimi'nden önce koy (verilmezse 24 aydan az deneyimde).
   * opts.photoRound: artık kullanılmıyor (modern yuvarlak kırpmayı kendisi yapar); geriye uyum için kabul edilir.
   */
  function build(cv, opts) {
    var o = readOpts(opts);
    var m = readModel(cv, o.lang, { profile: o.profile, numericDates: o.tpl.id === 'sade' });
    var photo = o.tpl.photo && o.raw.showPhoto !== false && m.photo ? m.photo : '';
    var c = {
      lang: o.lang, L: labels(o.lang, o.profile), accent: o.accent, photo: photo, profile: o.profile,
      refsLine: o.refsLine, sidebar: o.sidebar, order: sectionOrder(o.profile, cv, o.raw)
    };
    var t = o.tpl.id === 'sade' ? buildSade(m, c) : o.tpl.id === 'modern' ? buildModern(m, c) : buildKlasik(m, c);

    var dd = {
      info: docInfo(m, 'CV', o.lang),
      language: o.lang === 'en' ? 'en-GB' : 'tr-TR',
      pageSize: 'A4',
      pageOrientation: 'portrait',
      pageMargins: MARGINS[o.tpl.id].slice(),
      defaultStyle: defaultStyle(BODY_SIZE[o.tpl.id], LINE_HEIGHT),
      content: t.content,
      footer: makeFooter(m.name, t.footerMargin)
    };
    if (t.background) dd.background = t.background;
    return dd;
  }

  /*
   * fontFeatures: 'liga' kapalı. Roboto'nun "fi"/"fl" bitişik harfleri tek glif olur; Türkçede bu
   * hem i'nin noktasını gizler ("fı" ile karışır) hem de bazı ayrıştırıcılarda "fi" yerine tek bir
   * karakter çıkarır. Ayrı glifler metin çıkarmada her zaman "f" + "i" verir.
   */
  function defaultStyle(size, lh) {
    return { font: 'Roboto', fontSize: size, lineHeight: lh, color: INK, fontFeatures: { liga: false } };
  }

  /* ------------------------------------------------------------ ön yazı */

  var MONTHS_EN_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
    'October', 'November', 'December'];
  var MONTHS_TR_FULL = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim',
    'Kasım', 'Aralık'];
  // "21 Ekim 2026" / "21 October 2026"
  function longDate(d, lang) {
    return d.getDate() + ' ' + (lang === 'en' ? MONTHS_EN_FULL : MONTHS_TR_FULL)[d.getMonth()] + ' ' + d.getFullYear();
  }

  var LETTER = { MARGINS: [71, 64, 71, 57] };

  function readLetter(letter, m, lang) {
    letter = isObj(letter) ? letter : {};
    var subject = oneLine(letter.subject);
    if (subject && !/^(konu|subject|re)\s*:/i.test(subject)) subject = (lang === 'en' ? 'Subject: ' : 'Konu: ') + subject;
    return {
      date: oneLine(letter.date) || longDate(new Date(), lang),
      recipient: cleanItems(arr(letter.recipient)).slice(0, 3),
      subject: subject,
      greeting: oneLine(letter.greeting) || (lang === 'en' ? 'Dear Hiring Manager,' : 'Sayın İlgili,'),
      paragraphs: arr(letter.paragraphs).map(oneLine).filter(Boolean),
      closing: oneLine(letter.closing) || (lang === 'en' ? 'Kind regards,' : 'Saygılarımla,'),
      name: oneLine(letter.name) || m.name
    };
  }

  // Başlığın tahmini yüksekliği (pt): ad + ünvan + iletişim + çizgi.
  function letterHeaderHeight(m, c, tplId, width) {
    var h = 0, ce = contactEntries(m, c.L, tplId === 'klasik' && c.profile === 'saha' && !!m.phone);
    var contact = ce.map(function (e) { return e.value; }).join('  ·  ');
    if (tplId === 'sade') {
      if (m.name) h += countLines(m.name, 22, width, true) * lineH(22, 1.05);
      if (m.title) h += 2 + countLines(m.title, 11, width) * lineH(11, LINE_HEIGHT);
      if (contact) h += 6 + countLines(contact, 9.5, width) * lineH(9.5, LINE_HEIGHT);
      return h + 10;
    }
    var nameSize = tplId === 'modern' ? 30 : 28;
    if (m.name) h += countLines(m.name, nameSize * 0.9, width) * nameSize * 1.25;
    if (m.title) h += 6 + countLines(m.title, 13, width) * lineH(13, LINE_HEIGHT) * 1.1;
    if (tplId === 'klasik' && c.profile === 'saha' && m.phone) h += 8 + lineH(12, LINE_HEIGHT);
    if (contact) h += 8 + countLines(contact, 9.5, width) * lineH(9.5, LINE_HEIGHT);
    return h + 13; // çizgi
  }

  /*
   * Ön yazının tek sayfaya sığması (brief §4.6). Sırayla denenir, ilk sığan seçilir:
   *  1) paragraf aralığı 8 → 6 → 4 pt (11 pt, satır aralığı ≈1.4×);
   *  2) punto 10.5 → 10 (taban 10 pt; şablonlarda küçültmeye izin verilen tek yer);
   *  3) son çare, yine 10 pt: satır aralığı 1.2 → 1.1 ve sabit boşluklar (tarih, alıcı, konu, imza) daralır.
   * Hesap tahminidir: sözcük sözcük satır doldurma, Roboto genişlikleri + %4 pay. 3. adımda da
   * sığmayan (≈ 400 sözcüğü aşan) metin için fits: false döner; uygulama kısaltmayı önermelidir.
   */
  var LETTER_STEPS = [
    { size: 11, gap: 8, lh: 1.2 }, { size: 11, gap: 6, lh: 1.2 }, { size: 11, gap: 4, lh: 1.2 },
    { size: 10.5, gap: 4, lh: 1.2 }, { size: 10, gap: 4, lh: 1.2 }, { size: 10, gap: 3, lh: 1.1, compact: true }
  ];
  function letterSpace(compact) {
    return compact ? { top: 12, block: 8, sign: 12 } : { top: 22, block: 14, sign: 22 };
  }
  function fitLetter(L, m, c, tplId) {
    var W = PAGE.width - LETTER.MARGINS[0] - LETTER.MARGINS[2];
    var avail = PAGE.height - LETTER.MARGINS[1] - LETTER.MARGINS[3] - 6; // 6pt güvenlik payı
    var head = letterHeaderHeight(m, c, tplId, W);
    var pick = LETTER_STEPS[LETTER_STEPS.length - 1], est = 0;
    for (var i = 0; i < LETTER_STEPS.length; i++) {
      var s = LETTER_STEPS[i], sp = letterSpace(s.compact), lh = lineH(s.size, s.lh);
      var h = head + sp.top + lineH(10.5, LINE_HEIGHT); // tarih
      if (L.recipient.length) h += sp.block + L.recipient.reduce(function (t, r) { return t + countLines(r, 10.5, W) * lineH(10.5, LINE_HEIGHT); }, 0);
      if (L.subject) h += sp.block + countLines(L.subject, 10.5, W, true) * lineH(10.5, LINE_HEIGHT);
      h += sp.block + lh + 10; // hitap
      L.paragraphs.forEach(function (p, k) { h += countLines(p, s.size, W) * lh + (k ? s.gap : 0); });
      h += sp.block + lineH(s.size, LINE_HEIGHT) + (L.name ? sp.sign + lineH(s.size, LINE_HEIGHT) : 0); // kapanış, ad
      est = h;
      pick = s;
      if (est <= avail) break;
    }
    return {
      fontSize: pick.size, paraGap: pick.gap, lineHeight: pick.lh, compact: !!pick.compact,
      estimate: Math.round(est), available: Math.round(avail), fits: est <= avail
    };
  }

  /**
   * buildLetter(letter, cv, opts) → ön yazı docDefinition (brief §4.6).
   * letter: { date?, recipient[] (0–3 satır), subject, greeting, paragraphs[] (3–4), closing, name? }.
   * opts: build() ile aynı (template, accent, lang, profile). Başlık seçilen CV şablonununkiyle aynıdır
   * (fotoğrafsız; modern'de kenar çubuğu yok). Kesinlikle tek sayfa: bkz. fitLetter.
   */
  function buildLetter(letter, cv, opts) {
    var o = readOpts(opts);
    var m = readModel(cv, o.lang, { profile: o.profile, numericDates: false });
    var c = { lang: o.lang, L: labels(o.lang, o.profile), accent: o.accent, photo: '', profile: o.profile };
    var L = readLetter(letter, m, o.lang);
    var W = PAGE.width - LETTER.MARGINS[0] - LETTER.MARGINS[2]; // 453.28
    var fit = fitLetter(L, m, c, o.tpl.id);
    var content = [];

    if (o.tpl.id === 'sade') {
      content = sadeHeader(m, c, W);
      if (content.length) content.push(hline(W, 0.5, mix(INK, WHITE, 0.7), [0, 10, 0, 0]));
    } else if (o.tpl.id === 'modern') {
      content = modernHeader(m, c, W, '');
      if (content.length) content.push(hline(W, 1, o.accent, [0, 12, 0, 0]));
    } else {
      content = klasikHeader(m, c, W, '');
      if (content.length) content.push(hline(W, 1.2, o.accent, [0, 12, 0, 0]));
    }
    var sp = letterSpace(fit.compact);
    content.push({ text: L.date, fontSize: 10.5, color: INK, alignment: 'right', margin: [0, content.length ? sp.top : 0, 0, 0] });
    if (L.recipient.length) {
      content.push({ stack: L.recipient.map(function (r) { return { text: r }; }), fontSize: 10.5, color: INK, margin: [0, sp.block, 0, 0] });
    }
    if (L.subject) content.push({ text: L.subject, bold: true, fontSize: 10.5, color: INK, margin: [0, sp.block, 0, 0] });
    var body = [{ text: L.greeting, margin: [0, 0, 0, 10] }];
    L.paragraphs.forEach(function (p, i) {
      body.push({ text: p, margin: [0, i ? fit.paraGap : 0, 0, 0] });
    });
    content.push({ stack: body, fontSize: fit.fontSize, lineHeight: fit.lineHeight, color: INK, margin: [0, sp.block, 0, 0] });
    var close = [{ text: L.closing }];
    if (L.name) close.push({ text: L.name, bold: true, margin: [0, sp.sign, 0, 0] });
    content.push({ stack: close, fontSize: fit.fontSize, color: INK, margin: [0, sp.block, 0, 0], unbreakable: true });

    var kind = o.lang === 'en' ? 'Cover Letter' : 'Ön Yazı';
    return {
      info: docInfo({ name: L.name || m.name, title: m.title }, kind, o.lang),
      language: o.lang === 'en' ? 'en-GB' : 'tr-TR',
      pageSize: 'A4',
      pageOrientation: 'portrait',
      pageMargins: LETTER.MARGINS.slice(),
      defaultStyle: defaultStyle(fit.fontSize, LINE_HEIGHT),
      content: content
    };
  }

  /** letterLayout(letter, cv, opts) → fitLetter sonucu: { fontSize, paraGap, lineHeight, compact, estimate, available, fits }. */
  function letterLayout(letter, cv, opts) {
    var o = readOpts(opts);
    var m = readModel(cv, o.lang, { profile: o.profile, numericDates: false });
    var c = { lang: o.lang, L: labels(o.lang, o.profile), accent: o.accent, photo: '', profile: o.profile };
    return fitLetter(readLetter(letter, m, o.lang), m, c, o.tpl.id);
  }

  /** defaultTemplate(profile, opts) → 'sade' (yazılım, İngilizce ya da opts.upload) | 'klasik'. Modern hiçbir zaman varsayılan değil. */
  function defaultTemplate(profile, opts) {
    opts = isObj(opts) ? opts : {};
    return profile === 'yazilim' || opts.lang === 'en' || opts.upload === true ? 'sade' : 'klasik';
  }

  // web/github burada değil: yalnızca protokol ("https://") ya da "@" içerik sayılmaz (build onları basmaz).
  var TEXT_FIELDS = ['name', 'title', 'phone', 'email', 'city', 'summary', 'skills', 'langs',
    'certs', 'hobbies', 'refs', 'birth', 'military', 'license', 'marital'];
  var JOB_FIELDS = ['role', 'company', 'city', 'start', 'end', 'desc'];
  var EDU_FIELDS = ['school', 'program', 'degree', 'start', 'end', 'note'];
  // build() yalnızca adı ya da açıklaması olan projeyi basar; yalnızca teknoloji/bağlantı içerik sayılmaz.
  var PROJECT_FIELDS = ['name', 'desc'];

  function entriesHaveContent(list, fields) {
    return arr(list).some(function (e) {
      return isObj(e) && fields.some(function (f) { return str(e[f]).trim() !== ''; });
    });
  }

  /**
   * Kullanıcının anlamlı bir içeriği var mı? Boşluklar ve tamamen boş iş/eğitim/proje girdileri
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
    if (webDisplay(webField(cv.web)) || webDisplay(githubField(cv.github))) return true;
    return entriesHaveContent(cv.jobs, JOB_FIELDS) || entriesHaveContent(cv.edu, EDU_FIELDS) ||
      entriesHaveContent(cv.projects, PROJECT_FIELDS);
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

  /**
   * fileName(cv, opts) → "Ayse-Kaya-CV.pdf" (tireli, ASCII'ye katlanmış).
   * opts.suffix: uyarlanmış sürüm, ör. 'Kuzey Lojistik' → "Ayse-Kaya-CV-Kuzey-Lojistik.pdf".
   * opts.kind: 'letter' → "Ayse-Kaya-On-Yazi.pdf" (opts.lang 'en' → "…-Cover-Letter.pdf").
   * Eski çağrı biçimi fileName(cv) aynen çalışır.
   */
  function fileName(cv, opts) {
    opts = isObj(opts) ? opts : {};
    var kind = opts.kind === 'letter' ? (opts.lang === 'en' ? 'Cover Letter' : 'On Yazi') : 'CV';
    var suffix = oneLine(opts.suffix);
    return P().fileName(oneLine(isObj(cv) ? cv.name : ''), suffix ? kind + ' ' + suffix : kind, 'pdf', { sep: '-' });
  }

  var API = {
    TEMPLATES: TEMPLATES,
    ACCENTS: ACCENTS,
    PROFILES: PROFILES.slice(),
    SAMPLE: SAMPLE,
    SAMPLES: { deneyimli: SAMPLE, ogrenci: SAMPLE_OGRENCI, saha: SAMPLE_SAHA, yazilim: SAMPLE_YAZILIM },
    LETTER_SAMPLE: LETTER_SAMPLE,
    COLORS: { INK: INK, MUTED: MUTED, RULE: RULE },
    labels: labels,
    hasContent: hasContent,
    registerFonts: registerFonts,
    build: build,
    buildLetter: buildLetter,
    letterLayout: letterLayout,
    defaultTemplate: defaultTemplate,
    sectionOrder: sectionOrder,
    skillGroups: skillGroups,
    fileName: fileName,
    mix: mix
  };

  root.CVPdf = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
