/* Sesli CV — uygulama: adımlar, sesli asistan, fotoğraf, önizleme ve PDF */
(function () {
  'use strict';

  const P = window.CVParse;
  const PDF = window.CVPdf;
  const SP = window.CVSpeech;
  const D = document;
  const $ = (s, el) => (el || D).querySelector(s);
  const $$ = (s, el) => Array.from((el || D).querySelectorAll(s));

  // Mikrofonlu tam sürümün adresi (Claude içindeki görünümde mikrofon kapalıyken gösterilir).
  const FULL_VOICE_URL = 'https://vedattatli.github.io/sesli-cv/';
  const STORE_KEY = 'sesli-cv:v1';
  const LIBS = {
    pdfmake: 'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/pdfmake.min.js',
    vfs: 'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/vfs_fonts.min.js',
    pdfjs: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfjsWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    fonts: 'fonts.js',
  };
  const ACCENT_NAMES = ['Koyu yeşil', 'Lacivert', 'Bordo', 'Antrasit', 'Koyu hardal'];

  // ---------------------------------------------------------------- environment
  const HAS_CLAUDE = !!(window.claude && typeof window.claude.use === 'function');
  const FRAMED = (() => { try { return window.top !== window; } catch (_) { return true; } })();
  // Claude görüntüleyicisinin içinde mi? (mikrofon, indirme bağlantıları ve geçmiş kısıtlı)
  const IN_VIEWER = HAS_CLAUDE && FRAMED;
  const UA = navigator.userAgent || '';
  const env = {
    touch: window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false,
    isMac: /Macintosh|Mac OS X/.test(UA) && !SP.IS_IOS,
    isWin: /Windows/.test(UA),
    mic: 'unknown', // unknown | ok | denied | service | blocked | unsupported
    ttsVoice: null, // true / false / null (bilinmiyor)
    sample: null,
    dl: undefined, // indirme yeteneği: undefined = bekleniyor, null = yok
    downloadsP: HAS_CLAUDE ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null),
    sampleP: HAS_CLAUDE ? window.claude.use('sample').catch(() => null) : Promise.resolve(null),
    canShareFiles: false,
    storeOk: true,
    reduceMotion: window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false,
  };
  // Android'de sesli yanıt güvenilir biçimde yalnızca Chrome'da çalışır. Xiaomi/Redmi'nin Mi Tarayıcı'sı
  // ve uygulama içi tarayıcılar (WhatsApp, Instagram, Facebook…) için kullanıcıyı Chrome'a yönlendiririz.
  env.android = SP.IS_ANDROID;
  env.miBrowser = /MiuiBrowser|XiaoMi\/|Mint Browser/i.test(UA);
  env.inApp = /(FBAN|FBAV|Instagram|WhatsApp|Telegram|Line\/|Snapchat|TikTok|musical_ly|; wv\))/i.test(UA);
  env.otherAndroidBrowser = /(SamsungBrowser|OPR\/|Opera|YaBrowser|HeyTapBrowser|VivoBrowser|UCBrowser|Firefox|EdgA)/i.test(UA);
  env.chromeAndroid = env.android && /Chrome\/\d+/.test(UA) && !env.miBrowser && !env.inApp && !env.otherAndroidBrowser;
  env.needsChrome = env.android && !env.chromeAndroid && !IN_VIEWER;
  env.iosInApp = SP.IS_IOS && env.inApp;
  env.noDownload = !IN_VIEWER && env.inApp; // uygulama içi tarayıcılar dosya indiremez
  if (!SP.isRecognitionSupported()) env.mic = 'unsupported';
  else if (SP.micPolicyAllowed() === false) env.mic = 'blocked';
  try {
    env.canShareFiles = !IN_VIEWER && !env.inApp && !!navigator.canShare &&
      navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] });
  } catch (_) { env.canShareFiles = false; }
  const scrollBehavior = () => (env.reduceMotion ? 'auto' : 'smooth');

  // ---------------------------------------------------------------- data
  let uidN = 0;
  const uid = () => 'i' + Date.now().toString(36) + (uidN++).toString(36);
  const blankJob = () => ({ id: uid(), role: '', company: '', city: '', start: '', end: '', desc: '' });
  const blankEdu = () => ({ id: uid(), school: '', program: '', degree: '', start: '', end: '', note: '' });
  const blankCv = () => ({
    name: '', title: '', phone: '', email: '', city: '', web: '', photo: '', summary: '',
    jobs: [], edu: [], skills: '', langs: '', certs: '', hobbies: '', refs: '',
    birth: '', military: '', license: '', marital: '',
  });
  const DEFAULTS = {
    template: 'modern', accent: (PDF.ACCENTS && PDF.ACCENTS[0]) || '#1F5C4A', lang: 'tr', showPhoto: true,
    tts: true, autoNext: true, speechLang: 'tr-TR',
  };

  let cv = blankCv();
  let settings = Object.assign({}, DEFAULTS);
  const ui = {
    step: 0, active: null, resumeStep: 0, confirmDelete: null, suggestions: {}, applied: {},
    gateOpen: {}, story: '', focusKey: null, popping: false, convoBeforePhoto: false,
  };

  function pickStrings(src, keys) {
    const out = {};
    if (!src || typeof src !== 'object') return out;
    keys.forEach((k) => { if (typeof src[k] === 'string') out[k] = src[k].slice(0, 5000); });
    return out;
  }
  function sanitizeCv(raw) {
    const out = blankCv();
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(out).forEach((k) => {
      if (k === 'jobs' || k === 'edu' || k === 'photo') return;
      if (typeof raw[k] === 'string') out[k] = raw[k].slice(0, 8000);
    });
    if (typeof raw.photo === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(raw.photo) && raw.photo.length < 1.5e6) out.photo = raw.photo;
    if (Array.isArray(raw.jobs)) out.jobs = raw.jobs.slice(0, 30).map((j) => Object.assign(blankJob(), pickStrings(j, ['role', 'company', 'city', 'start', 'end', 'desc'])));
    if (Array.isArray(raw.edu)) out.edu = raw.edu.slice(0, 20).map((e) => Object.assign(blankEdu(), pickStrings(e, ['school', 'program', 'degree', 'start', 'end', 'note'])));
    return out;
  }
  function sanitizeSettings(raw) {
    const s = Object.assign({}, DEFAULTS);
    if (!raw || typeof raw !== 'object') return s;
    if (PDF.TEMPLATES.some((t) => t.id === raw.template)) s.template = raw.template;
    if (typeof raw.accent === 'string' && /^#[0-9a-f]{6}$/i.test(raw.accent)) s.accent = raw.accent;
    if (raw.lang === 'tr' || raw.lang === 'en') s.lang = raw.lang;
    if (raw.speechLang === 'tr-TR' || raw.speechLang === 'en-US') s.speechLang = raw.speechLang;
    ['showPhoto', 'tts', 'autoNext'].forEach((k) => { if (typeof raw[k] === 'boolean') s[k] = raw[k]; });
    return s;
  }

  // ---------------------------------------------------------------- steps & questions
  // hintNoMic: the hint shown/read when voice commands cannot be used (microphone unavailable).
  const LONG_TYPES = { sentences: 1, lines: 1, list: 1 };
  const YESNO_HINT_NOMIC = 'Aşağıdaki düğmelerden birine dokunun.';
  const STEPS = [
    { id: 'start', kind: 'intro', title: 'Başlangıç' },
    {
      id: 'kimlik', kind: 'fields', title: 'Ad ve meslek',
      fields: [
        { key: 'name', type: 'name', label: 'Ad Soyad', q: 'Adınız ve soyadınız nedir?', ph: 'Örn. Ayşe Yılmaz', ac: 'name' },
        { key: 'title', type: 'title', label: 'Meslek / unvan', q: 'Mesleğiniz ya da başvurduğunuz pozisyon nedir?', hint: 'Örneğin: muhasebe uzmanı, satış temsilcisi, aşçı, yazılım geliştirici.', ph: 'Örn. Muhasebe Uzmanı', ac: 'organization-title' },
      ],
    },
    {
      id: 'iletisim', kind: 'fields', title: 'İletişim',
      fields: [
        { key: 'phone', type: 'phone', label: 'Telefon', q: 'Telefon numaranız nedir?', hint: 'Rakamları gruplar hâlinde söyleyebilirsiniz.', hintNoMic: null, ph: '0532 123 45 67', im: 'tel', ac: 'tel' },
        { key: 'email', type: 'email', label: 'E-posta', q: 'E-posta adresiniz nedir?', hint: '@ için “et”, nokta için “nokta” deyin. Örnek: ayşe nokta yılmaz et gmail nokta com.', hintNoMic: 'Örnek: ayse.yilmaz@gmail.com', ph: 'ayse.yilmaz@gmail.com', im: 'email', ac: 'email' },
        { key: 'city', type: 'city', label: 'Şehir', q: 'Hangi şehirde yaşıyorsunuz?', ph: 'Örn. İzmir', ac: 'address-level2' },
        { key: 'web', type: 'url', label: 'LinkedIn ya da web sitesi', q: 'LinkedIn ya da web sitenizin adresi nedir?', hint: 'Yoksa “atla” deyin.', hintNoMic: 'Yoksa boş bırakın.', ph: 'linkedin.com/in/ayseyilmaz', im: 'url', optional: true },
      ],
    },
    { id: 'foto', kind: 'photo', title: 'Fotoğraf', q: 'Bir fotoğraf ekleyelim mi?', hint: 'Yüzünüzün net göründüğü, sade arka planlı bir fotoğraf en iyisi. İstemiyorsanız “atla” deyin.', hintNoMic: 'Yüzünüzün net göründüğü, sade arka planlı bir fotoğraf en iyisi. İstemiyorsanız İleri’ye dokunun.' },
    {
      id: 'profil', kind: 'fields', title: 'Profil',
      fields: [
        { key: 'summary', type: 'sentences', label: 'Kısa özet', q: 'Kendinizi kısaca anlatır mısınız?', hint: 'Kaç yıllık deneyiminiz var, nelerde iyisiniz, nasıl bir iş arıyorsunuz? İki üç cümle yeterli.', ph: 'Örn. Altı yıllık deneyime sahip bir muhasebe uzmanıyım…', long: true, ai: 'summary' },
      ],
    },
    {
      id: 'deneyim', kind: 'list', title: 'İş deneyimi', listKey: 'jobs', itemLabel: 'deneyim', blank: blankJob,
      gate: { q: 'Daha önce çalıştığınız bir iş var mı?', hint: '“Evet” ya da “hayır” deyin. En son işinizle başlayalım.', hintNoMic: 'En son işinizle başlayalım. ' + YESNO_HINT_NOMIC },
      more: { q: 'Başka bir iş eklemek ister misiniz?', hint: '“Evet” ya da “hayır” deyin.', hintNoMic: 'Eklemek için “Başka bir iş ekle”ye, bitirmek için İleri’ye dokunun.' },
      addLabel: 'Başka bir iş ekle', yes: 'Evet, ekleyelim', no: 'Hayır, deneyimim yok',
      fields: [
        { key: 'role', type: 'title', label: 'Pozisyon', q: 'Bu işteki pozisyonunuz neydi?', ph: 'Örn. Satış Temsilcisi' },
        { key: 'company', type: 'org', label: 'Şirket / kurum', q: 'Hangi şirkette çalıştınız?', ph: 'Örn. Kuzey Lojistik A.Ş.' },
        { key: 'start', type: 'date', label: 'Başlangıç', q: 'Ne zaman başladınız?', hint: 'Ay ve yıl söyleyin, örneğin: mart 2019.', hintNoMic: 'Ay ve yıl yazın, örneğin: Mart 2019.', ph: 'Mart 2019' },
        { key: 'end', type: 'date', label: 'Bitiş', q: 'Ne zaman ayrıldınız?', hint: 'Hâlâ çalışıyorsanız “devam ediyor” deyin.', hintNoMic: 'Hâlâ çalışıyorsanız “Devam ediyor”u seçin.', ph: 'Devam ediyor', chips: ['Devam ediyor'] },
        { key: 'city', type: 'city', label: 'Şehir', q: 'Hangi şehirdeydi?', hint: 'İsterseniz “atla” deyin.', hintNoMic: 'İsterseniz boş bırakın.', ph: 'Örn. Bursa', optional: true },
        { key: 'desc', type: 'lines', label: 'Neler yaptınız?', q: 'Bu işte neler yaptınız?', hint: 'Görevlerinizi ve başarılarınızı tek tek söyleyin. Her duraklama yeni bir madde olur.', hintNoMic: 'Her görevi ya da başarıyı ayrı bir satıra yazın.', ph: 'Her satır bir madde olur', long: true, wide: true, ai: 'bullets' },
      ],
    },
    {
      id: 'egitim', kind: 'list', title: 'Eğitim', listKey: 'edu', itemLabel: 'okul', blank: blankEdu,
      gate: { q: 'Eğitim bilgilerinizi ekleyelim mi?', hint: '“Evet” deyin; en son okuduğunuz okulla başlayalım.', hintNoMic: 'En son okuduğunuz okulla başlayalım. ' + YESNO_HINT_NOMIC },
      more: { q: 'Başka bir okul eklemek ister misiniz?', hint: '“Evet” ya da “hayır” deyin.', hintNoMic: 'Eklemek için “Başka bir okul ekle”ye, bitirmek için İleri’ye dokunun.' },
      addLabel: 'Başka bir okul ekle', yes: 'Evet, ekleyelim', no: 'Hayır, geç',
      fields: [
        { key: 'school', type: 'org', label: 'Okul', q: 'Hangi okuldan mezun oldunuz?', hint: 'En son okuduğunuz okulu söyleyin.', hintNoMic: 'En son okuduğunuz okulu yazın.', ph: 'Örn. Ege Üniversitesi' },
        { key: 'program', type: 'title', label: 'Bölüm', q: 'Hangi bölümü okudunuz?', hint: 'Lise ise “atla” diyebilirsiniz.', hintNoMic: 'Lise ise boş bırakabilirsiniz.', ph: 'Örn. İşletme', optional: true },
        { key: 'degree', type: 'degree', label: 'Derece', q: 'Derecesi nedir?', hint: 'Lise, ön lisans, lisans, yüksek lisans ya da doktora.', ph: 'Örn. Lisans', chips: ['Lise', 'Ön lisans', 'Lisans', 'Yüksek lisans', 'Doktora'] },
        { key: 'start', type: 'date', label: 'Başlangıç yılı', q: 'Hangi yıl başladınız?', ph: '2014' },
        { key: 'end', type: 'date', label: 'Mezuniyet yılı', q: 'Hangi yıl mezun oldunuz?', hint: 'Hâlâ okuyorsanız “devam ediyor” deyin.', hintNoMic: 'Hâlâ okuyorsanız “Devam ediyor”u seçin.', ph: '2018', chips: ['Devam ediyor'] },
        { key: 'note', type: 'gpa', label: 'Not ortalaması', q: 'Not ortalamanız kaçtı?', hint: 'Örneğin: 3,2 / 4. Belirtmek istemiyorsanız “atla” deyin.', hintNoMic: 'Örneğin: 3,2 / 4. İstemiyorsanız boş bırakın.', ph: 'Örn. 3,20 / 4,00', optional: true },
      ],
    },
    {
      id: 'yetenek', kind: 'fields', title: 'Yetenekler ve diller',
      fields: [
        { key: 'skills', type: 'list', label: 'Yetenekler', q: 'Hangi yeteneklere sahipsiniz?', hint: 'Kullandığınız programları, araçları ve güçlü yönlerinizi sayın. Her birinden sonra kısa bir duraklama yapın.', hintNoMic: 'Kullandığınız programları, araçları ve güçlü yönlerinizi virgülle ayırarak yazın.', ph: 'Örn. Excel, Logo Tiger, Müşteri ilişkileri', long: true, preview: 'chips' },
        { key: 'langs', type: 'list', label: 'Yabancı diller', q: 'Hangi dilleri biliyorsunuz?', hint: 'Seviyesiyle birlikte söyleyin: İngilizce ileri, Almanca başlangıç.', hintNoMic: 'Seviyesiyle birlikte yazın: İngilizce ileri, Almanca başlangıç.', ph: 'Örn. İngilizce ileri, Almanca başlangıç', preview: 'langs', optional: true },
      ],
    },
    {
      id: 'ek', kind: 'fields', title: 'Ek bilgiler',
      fields: [
        { key: 'certs', type: 'lines', label: 'Sertifikalar ve kurslar', q: 'Hangi sertifika ya da kursları aldınız?', hint: 'Her birini ayrı söyleyin. Yoksa “atla” deyin.', hintNoMic: 'Her birini ayrı satıra yazın. Yoksa boş bırakın.', ph: 'Her satır bir sertifika', long: true, optional: true },
        { key: 'hobbies', type: 'list', label: 'Hobiler', q: 'Hobileriniz nelerdir?', hint: 'İsterseniz “atla” deyin.', hintNoMic: 'İsterseniz boş bırakın.', ph: 'Örn. Yüzme, fotoğrafçılık', optional: true, preview: 'chips' },
        { key: 'refs', type: 'lines', label: 'Referanslar', q: 'Referans olarak kimi yazalım?', hint: 'Kişinin adını, çalıştığı yeri ve telefonunu söyleyin. Yoksa “atla” deyin.', hintNoMic: 'Kişinin adını, çalıştığı yeri ve telefonunu yazın. Yoksa boş bırakın.', ph: 'Örn. Mehmet Kaya – Kuzey Lojistik – 0532 000 00 00', long: true, optional: true },
      ],
    },
    {
      id: 'kisisel', kind: 'fields', title: 'Kişisel bilgiler',
      gate: { q: 'Kişisel bilgiler eklemek ister misiniz?', hint: 'Doğum tarihi, askerlik durumu, sürücü belgesi ve medeni durum. “Evet” ya da “hayır” deyin.', hintNoMic: 'Doğum tarihi, askerlik durumu, sürücü belgesi ve medeni durum. ' + YESNO_HINT_NOMIC },
      yes: 'Evet, ekleyelim', no: 'Hayır, geç',
      intro: 'Türkiye’deki CV’lerde sık istenen bilgiler. Hepsi isteğe bağlı; boş bıraktıklarınız CV’de görünmez.',
      fields: [
        { key: 'birth', type: 'birth', label: 'Doğum tarihi', q: 'Doğum tarihiniz nedir?', hint: 'Örneğin: 12 mart 1995.', ph: '12 Mart 1995', optional: true },
        { key: 'military', type: 'choice', label: 'Askerlik durumu', q: 'Askerlik durumunuz nedir?', hint: 'Yapıldı, tecilli ya da muaf.', ph: 'Örn. Yapıldı', chips: ['Yapıldı', 'Tecilli', 'Muaf'], optional: true },
        { key: 'license', type: 'license', label: 'Sürücü belgesi', q: 'Sürücü belgenizin sınıfı nedir?', hint: 'Örneğin: B sınıfı. Yoksa “atla” deyin.', hintNoMic: 'Örneğin: B sınıfı. Yoksa boş bırakın.', ph: 'Örn. B sınıfı', chips: ['B sınıfı', 'A2 ve B sınıfı'], optional: true },
        { key: 'marital', type: 'choice', label: 'Medeni durum', q: 'Medeni durumunuz nedir?', ph: 'Örn. Bekâr', chips: ['Bekâr', 'Evli'], optional: true },
      ],
    },
    { id: 'onizleme', kind: 'preview', title: 'Önizleme ve PDF', q: 'CV’niz hazır.', hint: 'Şablonu ve rengi seçin, sonra PDF olarak indirin.' },
  ];
  const LAST = STEPS.length - 1;
  const REVIEW_Q = { q: 'Bu bölüm tamam.', hint: 'Değiştirmek için bir alana dokunun ya da “devam” deyin.', hintNoMic: 'Değiştirmek için bir alana dokunun ya da İleri’ye geçin.' };

  // ---------------------------------------------------------------- spoken-answer helpers
  const fk = (s) => P.foldAscii(P.trLower(String(s || ''))).replace(/[^a-z0-9]+/g, ' ').trim();

  const CHOICE_MAP = {
    degree: [
      [/^(meslek |anadolu |fen |imam hatip )?lise/, 'Lise'],
      [/^(on ?lisans|meslek yuksek ?okulu|myo|iki yillik)/, 'Ön lisans'],
      [/^(yuksek ?lisans|master|mba|tezli|tezsiz)/, 'Yüksek lisans'],
      [/^(doktora|phd|doktor)/, 'Doktora'],
      [/^(lisans|universite|dort yillik|fakulte)/, 'Lisans'],
    ],
    military: [
      [/(yapilmadi|yapmadim|yapilmamis)/, 'Yapılmadı'],
      [/(yapildi|yaptim|tamamlandi|tamamladim|yapilmis|terhis)/, 'Yapıldı'],
      [/tecil/, 'Tecilli'],
      [/muaf/, 'Muaf'],
    ],
    marital: [[/bekar/, 'Bekâr'], [/evli/, 'Evli'], [/bosanmis/, 'Boşanmış'], [/dul/, 'Dul']],
  };
  const LICENSE_RE = /(^|[^\p{L}\p{N}])(c1e|d1e|a1|a2|b1|be|c1|ce|d1|de|a|b|c|d|f|g|m)(?=$|[^\p{L}\p{N}])/gu;
  const LICENSE_WORDS = /^(ve|sinif|sinifi|siniflari|ehliyet|ehliyetim|ehliyeti|surucu|belgesi|belgem|belge|var|evet)$/;

  function fixOrg(v) {
    return String(v || '')
      .replace(/(^|\s)a\.?\s?ş\.?(?=\s|$)/giu, '$1A.Ş.')
      .replace(/(^|\s)ltd\.?(?=\s|$)/giu, '$1Ltd.')
      .replace(/(^|\s)şti\.?(?=\s|$)/giu, '$1Şti.')
      .replace(/(^|\s)inc\.?(?=\s|$)/giu, '$1Inc.')
      .replace(/(^|\s)gmbh(?=\s|$)/giu, '$1GmbH');
  }
  // "üç virgül iki" → "3,2"; "4 üzerinden 3,2" → "3,2 / 4"
  function gpa(text) {
    let s = P.wordsToNumbers(String(text || '').trim());
    s = s.replace(/(\d)\s*(?:virgül|nokta|[.,])\s*(\d+)/giu, '$1,$2')
      .replace(/(\d+)\s*üzerinden\s*(\d+(?:,\d+)?)/giu, '$2 / $1')
      .replace(/\s*(?:bölü|\/)\s*(\d+)/giu, ' / $1');
    return P.capFirst(s);
  }
  /** Map an answer to a canonical choice. strict: only when the text is essentially just the keyword. */
  function mapChoice(field, text, strict) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    if (field.type === 'license') {
      const low = P.trLower(raw);
      const classes = [];
      low.replace(LICENSE_RE, (all, pre, m) => { const u = P.trUpper(m); if (!classes.includes(u)) classes.push(u); return all; });
      if (!classes.length) return null;
      if (strict) {
        const rest = fk(raw).split(' ').filter((t) => t && !/^(c1e|d1e|a1|a2|b1|be|c1|ce|d1|de|a|b|c|d|f|g|m)$/.test(t));
        if (rest.some((t) => !LICENSE_WORDS.test(t))) return null;
      }
      return classes.length === 1 ? classes[0] + ' sınıfı' : classes.slice(0, -1).join(', ') + ' ve ' + classes[classes.length - 1] + ' sınıfı';
    }
    const table = CHOICE_MAP[field.type === 'degree' ? 'degree' : field.key];
    if (!table) return null;
    const k = fk(raw);
    if (strict && (k.split(' ').length > 2 || /[\d()]/.test(raw))) return null;
    for (const [re, out] of table) if (re.test(k)) return out;
    return null;
  }

  // "Sertifikam yok", "hayır teşekkürler", "web sitem yok" … → the person declined; nothing to write.
  const REFUSAL_WORDS = new Set(['hayir', 'yok', 'yoktur', 'maalesef', 'istemiyorum', 'istemem', 'gerek', 'tesekkurler', 'tesekkur', 'ederim',
    'efendim', 'ya', 'simdilik', 'olmasin', 'atla', 'gec', 'bos', 'kalsin', 'birak', 'pas', 'hic', 'degil', 'yazma', 'yazmayalim',
    'no', 'none', 'nope', 'skip', 'web', 'site', 'sitesi', 'linkedin', 'hesap', 'hesabi', 'bir', 'bi', 'su', 'an', 'anda', 'icin', 'bu', 'bunu',
    'de', 'da', 'ben', 'benim', 'sey', 'herhangi', 'onu', 'thanks']);
  const REFUSAL_CORE = /(^| )(yok|yoktur|hayir|istemiyorum|istemem|atla|gec|olmasin|yazma|yazmayalim|none|no|skip)( |$)/;
  function isRefusal(seg) {
    const k = fk(seg);
    if (!k || !REFUSAL_CORE.test(k)) return false;
    const toks = k.split(' ');
    if (toks.length > 6) return false;
    let nouns = 0;
    for (const t of toks) {
      if (REFUSAL_WORDS.has(t)) continue;
      if (/m$/.test(t) && nouns === 0) { nouns++; continue; } // sertifikam, ehliyetim, hobim, referansim…
      return false;
    }
    return true;
  }
  const stripLeadingYes = (seg) => String(seg).replace(/^(evet var|evet|var|tabii ki|tabii|tabi|olur)[\s,]+(?=\S)/i, '');

  const EN_COMMANDS = {
    next: ['next', 'continue', 'done', "that's it", 'thats it', 'okay', 'ok'], skip: ['skip', 'pass'],
    back: ['back', 'go back', 'previous'], clear: ['clear', 'delete'], undo: ['undo'], stop: ['stop'],
    yes: ['yes', 'yeah', 'yep', 'sure', 'add'], no: ['no', 'nope', 'no thanks', 'none'], repeat: ['repeat', 'say again', 'again'],
  };
  function commandFor(seg) {
    const c = P.detectCommand(seg);
    if (c) return c;
    if (settings.speechLang === 'en-US') {
      const k = String(seg || '').toLowerCase().replace(/[.,!?]/g, '').replace(/\s+/g, ' ').trim();
      for (const cmd of Object.keys(EN_COMMANDS)) if (EN_COMMANDS[cmd].includes(k)) return cmd;
    }
    return null;
  }
  function yesNo(seg) {
    const low = ' ' + fk(seg) + ' ';
    if (/ (evet|olur|tabii|tabi|isterim|ekleyelim|ekle|var|yes|yeah|sure) /.test(low)) return 'yes';
    if (/ (hayir|yok|istemiyorum|gerek yok|gec|atla|no|nope) /.test(low)) return 'no';
    return null;
  }
  /** Answer to a yes/no gate: 'yes' | 'no' | 'ask' (ambiguous on "add another?") | null */
  function gateAnswer(slot, seg, cmd) {
    const k = fk(seg);
    if (/^(tamam|tamamdir|olur|peki|devam|devam et|evet tamam|ok|okay)$/.test(k)) return slot.kind === 'more' ? 'ask' : 'yes';
    if (/^(bitti|bu kadar|yeter|baska yok|hepsi bu|that s it|done)$/.test(k)) return 'no';
    if (cmd === 'yes') return 'yes';
    if (cmd === 'no' || cmd === 'skip' || cmd === 'next') return 'no';
    if (cmd) return null;
    return yesNo(seg);
  }

  function mergeFor(f, cur, seg, append) {
    switch (f.type) {
      case 'org': return fixOrg(P.mergeSegment('title', cur, seg, { append }));
      case 'birth': return P.mergeSegment('title', cur, seg, { append });
      case 'gpa': return gpa(append && cur ? cur + ' ' + seg : seg);
      case 'degree': case 'choice': case 'license':
        return mapChoice(f, append ? cur + ' ' + seg : seg, false) || P.mergeSegment('text', cur, seg, { append });
      default: return P.mergeSegment(f.type, cur, seg, { append });
    }
  }
  function normalizeTyped(f, v) {
    if (!v || !v.trim()) return v;
    try {
      switch (f.type) {
        case 'name': return P.normalizeName(v);
        case 'title': return P.normalizeTitle(v);
        case 'city': return P.normalizeCity(v);
        case 'email': return P.normalizeEmail(v);
        case 'url': return P.normalizeUrl(v);
        case 'phone': return P.normalizePhone(v);
        case 'date': return P.normalizeDate(v);
        case 'org': return fixOrg(P.normalizeTitle(v));
        case 'gpa': return gpa(v);
        case 'degree': case 'choice': case 'license': return mapChoice(f, v, true) || P.capFirst(v.trim());
        default: return v;
      }
    } catch (_) { return v; }
  }

  // ---------------------------------------------------------------- paths
  function parsePath(path) {
    const p = String(path).split('.');
    return p.length === 3 ? { list: p[0], id: p[1], key: p[2] } : { key: p[0] };
  }
  function getItem(list, id) { return (cv[list] || []).find((x) => x.id === id) || null; }
  function pathExists(path) { const p = parsePath(path); return !p.list || !!getItem(p.list, p.id); }
  function getVal(path) {
    const p = parsePath(path);
    if (!p.list) return typeof cv[p.key] === 'string' ? cv[p.key] : '';
    const it = getItem(p.list, p.id);
    return it && typeof it[p.key] === 'string' ? it[p.key] : '';
  }
  function stepOfPath(path) {
    const p = parsePath(path);
    return STEPS.findIndex((s) => (p.list ? s.listKey === p.list : s.kind === 'fields' && s.fields.some((f) => f.key === p.key)));
  }
  function fieldDef(path) {
    const p = parsePath(path);
    const s = STEPS[stepOfPath(path)];
    return s ? s.fields.find((f) => f.key === p.key) : null;
  }
  const domId = (path) => 'f-' + String(path).replace(/\./g, '-');

  function setVal(path, v, opts) {
    const o = opts || {};
    const p = parsePath(path);
    if (p.list) { const it = getItem(p.list, p.id); if (!it) return; it[p.key] = v; }
    else cv[p.key] = v;
    if (o.from !== 'input') {
      const el = D.getElementById(domId(path));
      if (el && el.value !== v) el.value = v;
    }
    refreshExtras(path);
    if (p.list) refreshItemTitles();
    afterChange();
  }
  function afterChange() { save(); refreshRail(); schedulePreview(); }

  const undoStacks = new Map();
  function pushUndo(path, prev) {
    const st = undoStacks.get(path) || [];
    st.push(prev); if (st.length > 25) st.shift();
    undoStacks.set(path, st);
  }
  function undo(path) {
    const st = undoStacks.get(path);
    if (!st || !st.length) { toast('Geri alınacak bir şey yok.'); return; }
    setVal(path, st.pop());
    toast('Son söylediğiniz geri alındı.');
  }

  // ---------------------------------------------------------------- storage
  let saveTimer = 0;
  let saveWarned = false;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const payload = { cv, settings, step: ui.step > 0 ? ui.step : ui.resumeStep, t: Date.now() };
      try { localStorage.setItem(STORE_KEY, JSON.stringify(payload)); setSaved(true); }
      catch (_) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(Object.assign({}, payload, { cv: Object.assign({}, cv, { photo: '' }) }))); setSaved(true); }
        catch (__) { setSaved(false); }
      }
    }, 350);
  }
  function load() {
    try { const raw = localStorage.getItem(STORE_KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  function setSaved(ok) {
    const el = $('#saved');
    if (!ok) {
      if (el) el.textContent = 'Taslak bu tarayıcıda kaydedilemiyor. Bitirince PDF’i indirin.';
      if (!saveWarned) { saveWarned = true; toast('Bu tarayıcı taslağı saklayamıyor; sayfayı kapatmadan önce PDF’i indirin.', 6000); }
      return;
    }
    if (!el) return;
    const d = new Date();
    el.textContent = 'Taslak bu cihazda kaydedildi · ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ---------------------------------------------------------------- DOM helpers
  function h(tag, attrs) {
    const el = D.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = v;
        else if (k === 'style' && typeof v === 'object') {
          for (const p of Object.keys(v)) { if (p.slice(0, 2) === '--') el.style.setProperty(p, v[p]); else el.style[p] = v[p]; }
        } else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach((k) => append(el, k)); return; }
    el.append(kid.nodeType ? kid : D.createTextNode(String(kid)));
  }
  function icon(name, cls) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = D.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ico' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    const use = D.createElementNS(NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }
  let toastTimer = 0;
  function toast(msg, ms) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 3400);
  }
  const say = (txt) => h('span', { class: 'say' }, '“' + txt + '”');
  /** Rebuild part of the page without losing keyboard focus (elements carry data-fkey). */
  function keepFocus(fn) {
    const a = D.activeElement;
    const key = ui.focusKey || (a && a.dataset && a.dataset.fkey) || null;
    ui.focusKey = null;
    fn();
    if (key) {
      const el = $('[data-fkey="' + CSS.escape(key) + '"]');
      if (el && el !== D.activeElement) el.focus({ preventScroll: true });
    }
  }

  function dictationHelp() {
    if (env.touch) return 'Klavyedeki mikrofon tuşuna dokunarak konuşabilirsiniz.';
    if (env.isMac) return 'Dikte için Fn (🌐) tuşuna iki kez basın ve konuşun.';
    if (env.isWin) return 'Dikte için Windows + H tuşlarına basın ve konuşun.';
    return 'İşletim sisteminizin dikte özelliğiyle konuşarak yazabilirsiniz.';
  }
  const micUsable = () => env.mic === 'ok' || env.mic === 'unknown' || env.mic === 'denied';
  const ttsOn = () => settings.tts && env.ttsVoice !== false && SP.isSynthesisSupported();
  const hintFor = (q) => (q && !micUsable() && q.hintNoMic !== undefined ? q.hintNoMic : q && q.hint) || '';

  // ---------------------------------------------------------------- wake lock
  let wakeLock = null;
  async function keepAwake() {
    try {
      if (!wakeLock && navigator.wakeLock && !D.hidden) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (_) { wakeLock = null; }
  }
  function releaseAwake() { try { if (wakeLock) wakeLock.release(); } catch (_) { /* ignore */ } wakeLock = null; }

  // ---------------------------------------------------------------- speech engine
  // Every result arrives with the slot object that was being asked when its audio was captured, so
  // late results after "İleri" or "Dur" stay in their own field and never trigger navigation.
  const conv = { on: false, mode: 'convo', slot: null, token: 0, speaking: false, adv: null, advTimer: 0 };
  const rec = SP.createRecognizer({
    lang: settings.speechLang,
    onInterim: (t, tag) => onInterim(t, tag),
    onFinal: (seg, tag) => onFinal(seg, tag),
    onState: (st) => { if (st === 'listening' && micUsable()) env.mic = 'ok'; refreshMicUi(); },
    onError: (code) => onRecError(code),
  });

  function onRecError(code) {
    if (code === 'blocked') {
      env.mic = IN_VIEWER ? 'blocked' : 'denied';
      stopConvo();
      toast(IN_VIEWER ? 'Bu görünümde mikrofon kullanılamıyor. ' + dictationHelp()
        : env.android ? 'Mikrofon izni verilmedi. Adres çubuğundaki simgeye dokunup İzinler’den mikrofona izin verin, sonra tekrar deneyin.'
          : SP.IS_IOS ? 'Mikrofon izni verilmedi. Adres çubuğundaki “aA” › Web Sitesi Ayarları › Mikrofon’dan izin verin.'
            : 'Mikrofon izni verilmedi. Adres çubuğundaki simgeden mikrofona izin verip tekrar deneyin.', 7000);
      rerenderSoft();
    } else if (code === 'service') {
      env.mic = 'service';
      stopConvo();
      toast(SP.IS_IOS ? 'Sesli yanıt için iPhone’da Dikte açık olmalı: Ayarlar › Genel › Klavye › Dikte’yi Etkinleştir. Sonra sayfayı yenileyin.'
        : env.isMac ? 'Sistem Ayarları › Klavye › Dikte’yi açın, sonra sayfayı yenileyin.'
          : 'Bu cihazda ses tanıma hizmeti kapalı. ' + dictationHelp(), 8000);
      rerenderSoft();
    } else if (code === 'no-mic') { stopConvo(); toast('Mikrofon bulunamadı. Bir mikrofon bağlayın ya da yazarak devam edin.', 5000); }
    else if (code === 'network') { stopConvo(); toast('Ses tanıma için internet bağlantısı gerekiyor. Bağlantınızı kontrol edin.', 5000); }
    else if (code === 'language') { stopConvo(); toast('Bu tarayıcı seçili konuşma dilini tanımıyor. Ayarlardan dili değiştirin.', 5000); }
    else if (code === 'unsupported') { env.mic = 'unsupported'; stopConvo(); rerenderSoft(); }
    else if (code === 'unstable') { stopConvo(); toast('Mikrofon açık kalmıyor. Sayfayı yenileyip tekrar deneyin.', 5000); }
    else if (code === 'silence') { stopConvo(); toast('Bir süredir ses gelmedi, mikrofonu kapattım. Devam etmek için mikrofona dokunun.', 6000); }
  }

  function onInterim(t, tag) {
    if (tag !== conv.slot || !rec.wanted) { if (!t) showLive(''); return; }
    if (t) bumpAdv();
    showLive(t);
  }
  function showLive(t) {
    const cap = $('#caption');
    if (cap) cap.textContent = t || '';
    $$('.live').forEach((el) => { el.textContent = ''; });
    const slot = conv.slot;
    if (t && slot && slot.path) { const el = D.getElementById(domId(slot.path) + '-live'); if (el) el.textContent = t; }
  }

  function refreshMicUi() {
    const btn = $('#btn-mic');
    if (!btn) return;
    let st = 'idle';
    if (conv.speaking) st = 'speaking';
    else if (rec.wanted) st = 'listening';
    else if (!micUsable()) st = 'blocked';
    btn.dataset.state = st;
    $('#mic-use').setAttribute('href', st === 'blocked' ? '#i-mic-off' : (st === 'listening' || st === 'speaking') ? '#i-pause' : '#i-mic');
    btn.setAttribute('aria-label', st === 'listening' || st === 'speaking' ? 'Durdur'
      : st === 'blocked' ? (ttsOn() ? 'Soruyu sesli oku (mikrofon kapalı)' : 'Sesle yazma yardımı')
        : 'Soruları sesli sor ve dinle');
    const kind = STEPS[ui.step].kind;
    const sk = conv.slot && conv.slot.kind;
    let status = '';
    if (st === 'speaking') status = 'Soru okunuyor…';
    else if (st === 'listening') {
      if (sk === 'gate' || sk === 'more') status = 'Dinliyorum… “Evet” ya da “hayır” deyin.';
      else if (sk === 'review') status = 'Dinliyorum… Devam etmek için “devam” deyin.';
      else if (sk === 'photo') status = 'Dinliyorum… Fotoğraf seçin ya da “atla” deyin.';
      else if (sk === 'test' || sk === 'story') status = 'Dinliyorum… Bitirince mikrofona dokunun.';
      else if (conv.mode === 'single') status = 'Dinliyorum… Sustuğunuzda mikrofon kapanır.';
      else if (settings.autoNext) status = 'Dinliyorum… Susunca sonraki soruya geçerim.';
      else status = 'Dinliyorum… Bitince “devam” deyin.';
    } else if (st === 'blocked') status = env.mic === 'unsupported' ? 'Bu tarayıcı sesli yanıtı desteklemiyor. ' + dictationHelp() : 'Mikrofon kapalı. ' + dictationHelp();
    else if (kind === 'photo') status = 'Fotoğraf seçin ya da İleri’ye dokunun.';
    else if (kind === 'preview') status = '';
    else status = 'Mikrofona dokunun; soruları sırayla soralım.';
    const ds = $('#dock-status');
    ds.setAttribute('aria-live', st === 'listening' || st === 'speaking' ? 'off' : 'polite');
    if (ds.textContent !== status) ds.textContent = status;
    $$('.field').forEach((el) => el.classList.toggle('is-listening', !!(rec.wanted && conv.slot && conv.slot.path === el.dataset.path)));
    $$('.mic-sm').forEach((b) => {
      const on = !!(rec.wanted && conv.slot && conv.slot.path === b.dataset.path);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      const use = b.querySelector('use'); if (use) use.setAttribute('href', on ? '#i-pause' : '#i-mic');
    });
  }

  // Auto-advance: after the person stops talking, move on. Any new speech restarts the countdown.
  function cancelAdv() {
    conv.adv = null;
    clearTimeout(conv.advTimer);
    conv.advTimer = 0;
    const bar = $('#dock-adv'); if (bar) bar.replaceChildren();
  }
  function scheduleAdv(f) {
    cancelAdv();
    const long = !!(f && (f.long || LONG_TYPES[f.type]));
    let action = null;
    if (conv.mode === 'convo' && conv.on && settings.autoNext) action = 'next';
    else if (conv.mode === 'single') action = 'stop';
    if (!action) return;
    conv.adv = { action, ms: long ? 4500 : 2300, token: conv.token };
    runAdv();
  }
  function runAdv() {
    const a = conv.adv;
    if (!a) return;
    clearTimeout(conv.advTimer);
    const bar = $('#dock-adv');
    if (bar) bar.replaceChildren(h('i', { style: { '--dur': a.ms + 'ms' } }));
    conv.advTimer = setTimeout(() => {
      conv.advTimer = 0;
      if (bar) bar.replaceChildren();
      const cur = conv.adv;
      conv.adv = null;
      if (!cur || cur.token !== conv.token) return;
      if (cur.action === 'next') { if (conv.mode === 'convo' && conv.on && conv.slot) advance(conv.slot); }
      else stopConvo();
    }, a.ms);
  }
  function bumpAdv() { if (conv.adv) runAdv(); }

  function slotsFor(stepIdx) {
    const s = STEPS[stepIdx];
    const out = [];
    if (!s) return out;
    if (s.kind === 'fields') {
      if (s.gate && !ui.gateOpen[s.id] && s.fields.every((f) => !cv[f.key])) out.push({ kind: 'gate', step: stepIdx });
      s.fields.forEach((f) => out.push({ kind: 'field', step: stepIdx, path: f.key }));
    } else if (s.kind === 'list') {
      const items = cv[s.listKey];
      if (!items.length) out.push({ kind: 'gate', step: stepIdx });
      items.forEach((it) => s.fields.forEach((f) => out.push({ kind: 'field', step: stepIdx, path: s.listKey + '.' + it.id + '.' + f.key })));
      if (items.length) out.push({ kind: 'more', step: stepIdx });
    } else if (s.kind === 'photo') out.push({ kind: 'photo', step: stepIdx });
    else if (s.kind === 'preview') out.push({ kind: 'done', step: stepIdx });
    return out;
  }
  const slotKey = (s) => (s ? s.kind + ':' + s.step + ':' + (s.path || '') : '');
  const isOpen = (s) => (s.kind === 'photo' ? !cv.photo : s.kind !== 'field' || !getVal(s.path).trim());
  /** Where the assistant starts on a step: the first unanswered question, else a short review prompt. */
  function startSlotFor(stepIdx) {
    const own = slotsFor(stepIdx);
    return own.find(isOpen) || (own.length ? { kind: 'review', step: stepIdx } : null);
  }
  function firstOpenSlot(stepIdx) {
    for (let st = stepIdx; st < STEPS.length; st++) {
      const s = slotsFor(st).find(isOpen);
      if (s) return s;
    }
    return null;
  }
  function nextSlot(from) {
    const list = slotsFor(from.step);
    const i = list.findIndex((s) => slotKey(s) === slotKey(from));
    if (from.kind !== 'review') for (let j = i + 1; j < list.length; j++) if (isOpen(list[j])) return list[j];
    return firstOpenSlot(from.step + 1);
  }
  function prevSlot(from) {
    const list = slotsFor(from.step);
    const i = list.findIndex((s) => slotKey(s) === slotKey(from));
    if (i > 0) return list[i - 1];
    for (let st = from.step - 1; st >= 1; st--) { const l = slotsFor(st); if (l.length) return l[l.length - 1]; }
    return null;
  }
  function slotQuestion(slot) {
    const s = STEPS[slot.step];
    if (slot.kind === 'field') return fieldDef(slot.path) || {};
    if (slot.kind === 'gate') return s.gate || {};
    if (slot.kind === 'more') return s.more || {};
    if (slot.kind === 'review') return REVIEW_Q;
    return s;
  }
  function spokenText(slot) {
    const q = slotQuestion(slot);
    return [q.q, hintFor(q)].filter(Boolean).join(' ').replace(/[“”"]/g, '');
  }

  async function askSlot(slot, opts) {
    const o = opts || {};
    const my = ++conv.token;
    cancelAdv();
    conv.slot = slot;
    if (slot.step !== ui.step) { setStep(slot.step); renderAll(); }
    setActive(slot.kind === 'field' ? slot.path : null, { scroll: true });
    updateQuestion();
    refreshMicUi();
    // Close the previous listening session first; anything it still delivers is kept in its own field.
    await rec.stop();
    if (my !== conv.token) return;
    if (slot.kind === 'done') {
      conv.on = false;
      releaseAwake();
      if (ttsOn() && o.speak !== false) await speakNow(spokenText(slot), my);
      refreshMicUi();
      return;
    }
    if (ttsOn() && o.speak !== false) {
      await speakNow(spokenText(slot), my);
      if (my !== conv.token) return;
    }
    if (micUsable()) rec.start(slot);
    else focusActive();
    refreshMicUi();
  }
  async function speakNow(text, my) {
    conv.speaking = true; refreshMicUi();
    try { await SP.speak(text, { lang: 'tr-TR' }); } finally { if (my === conv.token) { conv.speaking = false; refreshMicUi(); } }
  }

  function startConvo(fromSlot) {
    checkTts();
    if (!micUsable() && !ttsOn()) { focusActive(); toast(dictationHelp(), 5000); return; }
    conv.on = true;
    conv.mode = 'convo';
    keepAwake();
    let slot = fromSlot || null;
    if (!slot && ui.active && stepOfPath(ui.active) === ui.step && pathExists(ui.active)) slot = { kind: 'field', step: ui.step, path: ui.active };
    if (!slot) slot = startSlotFor(ui.step) || firstOpenSlot(ui.step + 1);
    if (!slot) { goStep(LAST); return; }
    askSlot(slot);
  }
  function stopConvo() {
    conv.on = false;
    conv.token++;
    conv.speaking = false;
    cancelAdv();
    SP.cancelSpeech();
    rec.stop();
    showLive('');
    releaseAwake();
    refreshMicUi();
    updateQuestion();
  }
  function advance(from) {
    if (conv.mode === 'convo' && !conv.on) return;
    const n = nextSlot(from);
    if (!n) { stopConvo(); goStep(LAST); return; }
    if (conv.mode === 'single') {
      // tek alan modunda yalnızca bir sonraki alana geç, dinlemeye devam et
      if (n.kind === 'field') { listenSingle(n.path, n.step); return; }
      stopConvo(); if (n.step !== ui.step) goStep(n.step); return;
    }
    askSlot(n);
  }
  function listenSingle(path, stepIdx) {
    if (!micUsable()) { setActive(path, { scroll: true }); focusActive(); toast(dictationHelp(), 5000); return; }
    conv.on = false;
    conv.mode = 'single';
    conv.token++;
    SP.cancelSpeech();
    conv.speaking = false;
    cancelAdv();
    conv.slot = { kind: 'field', step: stepIdx == null ? ui.step : stepIdx, path };
    if (conv.slot.step !== ui.step) { setStep(conv.slot.step); renderAll(); }
    setActive(path, { scroll: true });
    updateQuestion();
    rec.start(conv.slot);
    refreshMicUi();
  }

  function onFinal(seg, tag) {
    const slot = tag;
    if (!slot) return;
    if (slot.kind === 'test') {
      const el = $('#heard'); if (el) el.textContent = '“' + seg + '”';
      return;
    }
    if (slot.kind === 'story') {
      ui.story = (ui.story ? ui.story.trim() + ' ' : '') + seg;
      const ta = $('#story'); if (ta) ta.value = ui.story;
      return;
    }
    const cmd = commandFor(seg);
    const current = rec.wanted && slot === conv.slot;
    if (!current) {
      // Late result from a session we already left (İleri, Dur, another field): keep the words only.
      if (slot.kind === 'field' && !cmd && pathExists(slot.path)) writeAnswer(slot, seg, true);
      return;
    }
    cancelAdv();
    if (slot.kind === 'field') {
      if (!pathExists(slot.path)) return;
      if (cmd && fieldCommand(cmd, slot)) { showLive(''); return; }
      const f = fieldDef(slot.path);
      if (!f) return;
      if (f.optional && !(f.type === 'license' || f.type === 'choice') && isRefusal(seg)) { showLive(''); advance(slot); return; }
      if (f.optional && (f.type === 'license' || f.type === 'choice') && !mapChoice(f, seg, false) && isRefusal(seg)) { showLive(''); advance(slot); return; }
      writeAnswer(slot, seg, false);
      scheduleAdv(f);
      return;
    }
    if (cmd === 'back') { goBack(slot); return; }
    if (cmd === 'stop') { stopConvo(); return; }
    if (cmd === 'repeat') { askSlot(slot); return; }
    if (slot.kind === 'photo') {
      const a = gateAnswer(slot, seg, cmd);
      if (a === 'no' || (a === 'yes' && cv.photo)) advance(slot);
      else toast('Fotoğraf seçmek için düğmeye dokunun ya da “atla” deyin.');
      return;
    }
    if (slot.kind === 'review') {
      const a = gateAnswer(slot, seg, cmd);
      if (a) advance(slot); else toast('Devam etmek için “devam” deyin.');
      return;
    }
    if (slot.kind === 'gate' || slot.kind === 'more') {
      const a = gateAnswer(slot, seg, cmd);
      if (a === 'yes' || a === 'no') answerGate(slot, a === 'yes');
      else if (a === 'ask') toast('Başka eklemek için “evet”, bitirmek için “hayır” deyin.', 4500);
      else toast('“Evet” ya da “hayır” deyin.');
    }
  }
  function writeAnswer(slot, seg, late) {
    const f = fieldDef(slot.path);
    if (!f) return;
    const text = f.optional ? stripLeadingYes(seg) : seg;
    const cur = getVal(slot.path);
    pushUndo(slot.path, cur);
    setVal(slot.path, mergeFor(f, cur, text, !!slot.heard));
    slot.heard = true;
    if (!late) flashField(slot.path);
  }

  function fieldCommand(cmd, slot) {
    const path = slot.path;
    switch (cmd) {
      case 'next': case 'skip': case 'no': advance(slot); return true;
      case 'back': goBack(slot); return true;
      case 'clear': pushUndo(path, getVal(path)); setVal(path, ''); slot.heard = false; toast('Alan temizlendi.'); return true;
      case 'undo': undo(path); return true;
      case 'stop': stopConvo(); return true;
      case 'repeat': if (conv.mode === 'convo') askSlot(slot); else updateQuestion(); return true;
      case 'yes': toast('Bu soruya yanıtınızı söyleyin ya da “atla” deyin.'); return true;
      default: return false;
    }
  }
  function goBack(slot) {
    const p = prevSlot(slot);
    if (!p) return;
    if (conv.mode === 'single' && p.kind === 'field') listenSingle(p.path, p.step);
    else if (conv.mode === 'single') { stopConvo(); if (p.step !== ui.step) goStep(p.step); }
    else askSlot(p);
  }
  function answerGate(slot, yes) {
    const s = STEPS[slot.step];
    if (yes) {
      let first;
      if (s.kind === 'list') {
        const it = s.blank();
        cv[s.listKey].push(it);
        afterChange();
        first = { kind: 'field', step: slot.step, path: s.listKey + '.' + it.id + '.' + s.fields[0].key };
      } else {
        ui.gateOpen[s.id] = true;
        first = { kind: 'field', step: slot.step, path: s.fields[0].key };
      }
      if (slot.step === ui.step) renderAll();
      if (conv.on) askSlot(first);
      else if (rec.wanted && conv.mode === 'single') listenSingle(first.path, first.step);
      else {
        if (first.step !== ui.step) goStep(first.step);
        setActive(first.path, { scroll: true });
        focusActive();
      }
      return;
    }
    const n = firstOpenSlot(slot.step + 1);
    if (conv.on && n) askSlot(n);
    else { if (rec.wanted) stopConvo(); goStep(Math.min(LAST, slot.step + 1)); }
  }

  // ---------------------------------------------------------------- navigation & render
  function setStep(idx) {
    if (ui.step !== idx && !IN_VIEWER && !ui.popping) {
      try { history.pushState({ step: idx }, ''); } catch (_) { /* ignore */ }
    }
    ui.step = idx;
    if (idx > 0) ui.resumeStep = idx;
  }
  function goStep(i, opts) {
    const o = opts || {};
    const idx = Math.max(0, Math.min(LAST, i));
    const wasOn = conv.on;
    if (rec.wanted || conv.speaking) { conv.token++; cancelAdv(); SP.cancelSpeech(); conv.speaking = false; rec.stop(); }
    conv.slot = null;
    setStep(idx);
    ui.active = null;
    renderAll();
    save();
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
    const stage = $('#stage');
    if (stage && !o.noFocus) stage.focus({ preventScroll: true });
    if (wasOn && STEPS[idx].kind !== 'intro') {
      conv.on = true;
      const s = startSlotFor(idx);
      if (s) askSlot(s); else { conv.on = false; releaseAwake(); }
    } else {
      conv.on = false;
      releaseAwake();
    }
    refreshMicUi();
  }

  function renderAll() {
    const s = STEPS[ui.step];
    D.body.dataset.kind = s.kind;
    D.body.dataset.step = s.id;
    const root = $('#step');
    let view;
    if (s.kind === 'intro') view = renderIntro();
    else if (s.kind === 'fields') view = renderFieldsStep(s);
    else if (s.kind === 'list') view = renderListStep(s);
    else if (s.kind === 'photo') view = renderPhotoStep(s);
    else view = renderPreviewStep(s);
    keepFocus(() => root.replaceChildren(view));
    refreshRail();
    refreshProgress();
    refreshDock();
    updateQuestion();
    refreshMicUi();
    schedulePreview(120);
  }
  // Re-render while keeping the active field (used after environment changes).
  function rerenderSoft() { const a = ui.active; renderAll(); if (a && pathExists(a)) setActive(a); }

  function stepHasContent(i) {
    const s = STEPS[i];
    if (s.kind === 'fields') return s.fields.some((f) => (cv[f.key] || '').trim());
    if (s.kind === 'list') return cv[s.listKey].some((it) => s.fields.some((f) => (it[f.key] || '').trim()));
    if (s.kind === 'photo') return !!cv.photo;
    return false;
  }
  function refreshRail() {
    const ol = $('#rail-list');
    if (!ol) return;
    ol.replaceChildren(...STEPS.map((s, i) => h('li', { class: (i === ui.step ? 'current ' : '') + (stepHasContent(i) ? 'done' : '') },
      h('button', { type: 'button', 'aria-current': i === ui.step ? 'step' : null, onclick: () => goStep(i) }, s.title))));
  }
  function refreshProgress() {
    const s = STEPS[ui.step];
    const pt = $('#progress-text');
    if (ui.step === 0) pt.textContent = '';
    else pt.replaceChildren(ui.step + ' / ' + LAST, h('span', { class: 'long' }, ' · ' + s.title));
    $('#progress-bar').style.width = Math.round((ui.step / LAST) * 100) + '%';
  }
  function refreshDock() {
    const s = STEPS[ui.step];
    const back = $('#btn-back');
    const next = $('#btn-next');
    back.disabled = ui.step <= 1;
    next.disabled = false;
    if (s.kind === 'preview') {
      next.replaceChildren(icon('download'), 'PDF indir');
      next.disabled = env.noDownload || (IN_VIEWER && env.dl === null);
    } else if (ui.step === LAST - 1) {
      next.replaceChildren('Önizle', icon('right'));
    } else {
      next.replaceChildren('İleri', icon('right'));
    }
  }

  function questionHead(q, extra) {
    const s = STEPS[ui.step];
    const eyebrow = ui.step === 0 ? '' : 'Adım ' + ui.step + ' / ' + LAST + ' · ' + s.title;
    const hint = hintFor(q);
    return h('div', { class: 'q-wrap' },
      h('p', { class: 'eyebrow', id: 'q-eyebrow' }, eyebrow),
      h('h1', { class: 'question', id: 'question' }, (q && q.q) || s.title),
      h('p', { class: 'hint', id: 'q-hint', hidden: !hint }, hint),
      extra || null);
  }
  function updateQuestion() {
    const qEl = $('#question');
    if (!qEl) return;
    const s = STEPS[ui.step];
    const liveTurn = rec.wanted || conv.speaking || conv.on;
    let q = null;
    if (conv.slot && conv.slot.step === ui.step && liveTurn && (conv.slot.kind !== 'field' || pathExists(conv.slot.path))) q = slotQuestion(conv.slot);
    else if (ui.active && stepOfPath(ui.active) === ui.step && pathExists(ui.active)) q = fieldDef(ui.active);
    else if (s.kind === 'list') q = cv[s.listKey].length ? s.fields[0] : s.gate;
    else if (s.kind === 'fields') q = (s.gate && !ui.gateOpen[s.id] && s.fields.every((f) => !cv[f.key])) ? s.gate : s.fields[0];
    else q = s;
    if (!q) return;
    qEl.textContent = q.q || s.title;
    const hint = $('#q-hint');
    const ht = hintFor(q);
    hint.textContent = ht;
    hint.hidden = !ht;
    const eb = $('#q-eyebrow');
    if (eb && ui.step > 0) {
      let txt = 'Adım ' + ui.step + ' / ' + LAST + ' · ' + s.title;
      if (s.kind === 'list' && ui.active && parsePath(ui.active).list && pathExists(ui.active)) {
        const idx = cv[s.listKey].findIndex((x) => x.id === parsePath(ui.active).id);
        txt += ' · ' + (idx + 1) + '. ' + s.itemLabel;
      }
      eb.textContent = txt;
    }
  }
  function setActive(path, opts) {
    ui.active = path;
    $$('.field').forEach((el) => el.classList.toggle('is-active', el.dataset.path === path));
    updateQuestion();
    if (path && opts && opts.scroll) {
      const el = $('.field[data-path="' + CSS.escape(path) + '"]');
      if (el) el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    }
  }
  function focusActive() {
    if (!ui.active) return;
    const el = D.getElementById(domId(ui.active));
    if (el) el.focus({ preventScroll: true });
  }
  function flashField(path) {
    if (env.reduceMotion) return;
    const el = $('.field[data-path="' + CSS.escape(path) + '"]');
    if (el && el.animate) el.animate([{ backgroundColor: 'var(--accent-soft)' }, { backgroundColor: 'var(--surface)' }], { duration: 600 });
  }

  // ---------------------------------------------------------------- field view
  function fieldView(f, path) {
    const id = domId(path);
    const val = getVal(path);
    const isLong = !!f.long;
    const type = f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : f.type === 'url' ? 'url' : 'text';
    const noCaps = f.type === 'email' || f.type === 'url';
    const input = isLong
      ? h('textarea', { id, class: 'input', rows: 3, placeholder: f.ph || '', spellcheck: 'true', autocapitalize: 'sentences' })
      : h('input', {
        id, class: 'input', type, placeholder: f.ph || '', inputmode: f.im || null, autocomplete: f.ac || 'off',
        autocapitalize: noCaps ? 'none' : (f.type === 'name' || f.type === 'city' || f.type === 'title' || f.type === 'org') ? 'words' : 'sentences',
        spellcheck: noCaps ? 'false' : 'true', enterkeyhint: 'next',
      });
    input.value = val;
    input.addEventListener('input', () => {
      if (conv.slot && conv.slot.path === path) cancelAdv();
      setVal(path, input.value, { from: 'input' });
    });
    input.addEventListener('change', () => {
      const n = normalizeTyped(f, input.value);
      if (n !== input.value) setVal(path, n);
    });
    input.addEventListener('focus', () => {
      const cs = conv.slot;
      if (cs && cs.step === ui.step && cs.path !== path && (cs.kind === 'field' || cs.kind === 'gate' || cs.kind === 'more' || cs.kind === 'review')) {
        // Kullanıcı başka alana geçti: bundan sonra söylenenler bu alana yazılsın.
        const ns = { kind: 'field', step: ui.step, path };
        conv.slot = ns;
        cancelAdv();
        if (rec.wanted) rec.retag(ns);
      }
      setActive(path);
      refreshMicUi();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (!isLong ? !(e.ctrlKey || e.metaKey) : (e.ctrlKey || e.metaKey)) && !e.isComposing) {
        e.preventDefault();
        const n = normalizeTyped(f, input.value);
        if (n !== input.value) setVal(path, n);
        const nx = nextSlot({ kind: 'field', step: ui.step, path });
        if (conv.on && nx) {
          askSlot(nx);
          if (nx.kind === 'field') { const el = D.getElementById(domId(nx.path)); if (el) el.focus({ preventScroll: true }); }
          else input.blur();
          return;
        }
        if (nx && nx.kind === 'field' && nx.step === ui.step) {
          setActive(nx.path, { scroll: true });
          const el = D.getElementById(domId(nx.path)); if (el) el.focus();
        } else goStep(ui.step + 1);
      }
    });
    const mic = micUsable()
      ? h('button', {
        type: 'button', class: 'mic-sm', dataset: { path, fkey: 'mic-' + path }, 'aria-pressed': 'false',
        'aria-label': f.label + ' alanını konuşarak doldur', title: 'Bu alanı konuşarak doldur',
        onclick: () => {
          if (rec.wanted && conv.slot && conv.slot.path === path) { stopConvo(); return; }
          listenSingle(path);
        },
      }, icon('mic'))
      : null;
    const wrap = h('div', { class: 'field' + (f.wide ? ' wide' : '') + (ui.active === path ? ' is-active' : ''), dataset: { path } },
      h('label', { class: 'field-label', for: id }, f.label, f.optional ? h('span', { class: 'opt' }, 'isteğe bağlı') : null),
      h('div', { class: 'field-row' }, input, mic),
      h('div', { class: 'live', id: id + '-live' }),
      h('div', { class: 'extras', id: id + '-extras' }));
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) setActive(path); });
    fillExtras(wrap.lastChild, f, path);
    return wrap;
  }

  function refreshExtras(path) {
    const box = D.getElementById(domId(path) + '-extras');
    const f = fieldDef(path);
    if (box && f) keepFocus(() => fillExtras(box, f, path));
  }
  function fillExtras(box, f, path) {
    const val = getVal(path);
    const parts = [];
    if (f.chips) {
      parts.push(h('div', { class: 'chips', role: 'group', 'aria-label': f.label + ' seçenekleri' }, f.chips.map((c) => h('button', {
        type: 'button', class: 'chip', 'aria-pressed': val === c ? 'true' : 'false', dataset: { fkey: 'chip-' + path + '-' + c },
        onclick: () => { setVal(path, val === c ? '' : c); },
      }, c))));
    }
    if (f.preview === 'chips' && val.trim()) {
      const items = P.splitList(val);
      parts.push(h('div', { class: 'chips', role: 'group', 'aria-label': 'Algılanan maddeler' }, items.map((it, i) => h('span', { class: 'chip' }, it,
        h('button', {
          type: 'button', class: 'x', 'aria-label': it + ' maddesini kaldır', dataset: { fkey: 'x-' + path + '-' + i },
          onclick: () => setVal(path, P.splitList(getVal(path)).filter((x) => x !== it).join(', ')),
        }, '×')))));
    }
    if (f.preview === 'langs' && val.trim()) {
      const langs = P.parseLanguages(val);
      parts.push(h('div', { class: 'chips', role: 'group', 'aria-label': 'Algılanan diller' }, langs.map((l) => h('span', { class: 'chip' }, l.name,
        l.level ? h('span', { class: 'lvl' }, P.levelLabel(l.level, 'tr')) : h('span', { class: 'lvl' }, 'seviye?'),
        l.level ? h('span', { class: 'dots', 'aria-hidden': 'true' }, [1, 2, 3, 4, 5].map((n) => h('i', { class: n <= l.level ? 'on' : '' }))) : null))));
      if (langs.some((l) => !l.level)) parts.push(h('p', { class: 'mini-note' }, 'Seviyesi anlaşılamayan dillerin yanına “başlangıç, orta, iyi, ileri” ya da “ana dil” ekleyin.'));
    }
    if (f.type === 'lines' && f.key === 'desc' && val.trim()) {
      const n = P.splitLines(val).length;
      parts.push(h('p', { class: 'mini-note' }, n + ' madde olarak CV’ye yazılacak.'));
    }
    if (f.ai && env.sample) parts.push(aiRow(f, path));
    else if (ui.applied[path] !== undefined) parts.push(appliedRow(path));
    box.replaceChildren(...parts);
  }

  // ---------------------------------------------------------------- step views
  function chromeIntentUrl() {
    const u = location.href.replace(/^https?:\/\//, '').replace(/#.*$/, '');
    return 'intent://' + u + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(location.href) + ';end';
  }
  async function copyLink(btn) {
    try { await navigator.clipboard.writeText(location.href); btn.textContent = 'Kopyalandı'; toast('Link kopyalandı. Chrome’u açıp adres çubuğuna yapıştırın.', 5000); }
    catch (_) { toast('Kopyalanamadı. Adres: ' + location.href, 8000); }
  }
  function chromeBanner() {
    if (env.iosInApp) {
      return h('div', { class: 'banner', role: 'note' }, icon('info'),
        h('div', null, h('b', null, 'Bu sayfayı Safari’de açın.'), ' Uygulamanın içindeki tarayıcıda sesli yanıt ve PDF indirme çalışmayabilir. Sağ alttaki ya da üstteki menüden “Safari’de Aç”ı seçin.'));
    }
    if (!env.needsChrome) return null;
    const who = env.miBrowser ? 'Mi Tarayıcı’da' : env.inApp ? 'uygulamanın içindeki tarayıcıda' : 'bu tarayıcıda';
    const has = PDF.hasContent(cv);
    return h('div', { class: 'banner', role: 'note' }, icon('info'),
      h('div', { style: { display: 'grid', gap: '10px' } },
        h('div', null, h('b', null, 'Sesli yanıt için linki Chrome’da açın.'), ' Sesli yazma ve PDF indirme ' + who + ' çalışmayabilir; Chrome’da sorunsuz çalışır.'),
        has ? h('div', null, 'Buraya yazdıklarınız Chrome’a kendiliğinden taşınmaz. Önce yedek alın, Chrome’da “Yedekten yükle” ile açın.') : null,
        h('div', { class: 'btn-row' },
          has && !env.noDownload ? h('button', { type: 'button', class: 'btn small', onclick: exportJson }, icon('file'), 'Yedek dosyası indir') : null,
          h('a', { class: 'btn small primary', href: chromeIntentUrl() }, 'Chrome’da aç'),
          h('button', { type: 'button', class: 'btn small', onclick: (e) => copyLink(e.currentTarget) }, 'Linki kopyala'))));
  }
  function voiceBanner() {
    if (env.needsChrome || env.iosInApp) return chromeBanner();
    if (micUsable()) return null;
    const msg = env.mic === 'unsupported'
      ? 'Bu tarayıcı sesli yanıtı desteklemiyor. Android’de Chrome, iPhone’da Safari kullanın.'
      : env.mic === 'service' ? 'Bu cihazda ses tanıma kapalı.'
        : 'Bu sayfada tarayıcı mikrofonu kapalı.';
    return h('div', { class: 'banner', role: 'note' }, icon('info'),
      h('div', null, h('b', null, msg), ' ', dictationHelp(),
        FULL_VOICE_URL && IN_VIEWER ? [' ', h('a', { href: FULL_VOICE_URL, target: '_blank', rel: 'noopener' }, 'Mikrofonlu sürümü açın.')] : null));
  }
  function gateBlock(s, slot) {
    return h('div', { class: 'gate' },
      h('button', { type: 'button', class: 'btn primary', dataset: { fkey: 'gate-yes' }, onclick: () => answerGate(slot, true) }, icon('plus'), s.yes || 'Evet'),
      h('button', { type: 'button', class: 'btn', dataset: { fkey: 'gate-no' }, onclick: () => answerGate(slot, false) }, s.no || 'Hayır'));
  }

  function renderFieldsStep(s) {
    const gated = s.gate && !ui.gateOpen[s.id] && s.fields.every((f) => !cv[f.key]);
    if (gated) {
      return h('section', { class: 'step', 'aria-labelledby': 'question' },
        questionHead(s.gate),
        s.intro ? h('p', { class: 'fine' }, s.intro) : null,
        voiceBanner(),
        gateBlock(s, { kind: 'gate', step: ui.step }));
    }
    return h('section', { class: 'step', 'aria-labelledby': 'question' },
      questionHead(s.fields[0]),
      s.intro ? h('p', { class: 'fine' }, s.intro) : null,
      voiceBanner(),
      h('div', { class: 'fields' }, s.fields.map((f) => fieldView(f, f.key))));
  }

  function itemTitle(s, it, i) {
    const main = s.listKey === 'jobs' ? (it.role || it.company) : (it.school || it.program);
    return [String(i + 1) + '. ' + s.itemLabel, main ? h('span', null, ' · ' + main) : null];
  }
  function refreshItemTitles() {
    const s = STEPS[ui.step];
    if (!s || s.kind !== 'list') return;
    cv[s.listKey].forEach((it, i) => {
      const el = D.getElementById('it-' + it.id);
      if (el) el.replaceChildren(...itemTitle(s, it, i).filter(Boolean));
    });
  }
  function renderListStep(s) {
    const items = cv[s.listKey];
    if (!items.length) {
      return h('section', { class: 'step', 'aria-labelledby': 'question' },
        questionHead(s.gate),
        voiceBanner(),
        gateBlock(s, { kind: 'gate', step: ui.step }));
    }
    const cards = items.map((it, i) => {
      const confirming = ui.confirmDelete === it.id;
      const label = (i + 1) + '. ' + s.itemLabel;
      return h('div', { class: 'item' },
        h('div', { class: 'item-head' },
          h('div', { class: 'item-title', id: 'it-' + it.id }, itemTitle(s, it, i)),
          confirming
            ? h('div', { class: 'confirm', role: 'group', 'aria-label': label + ' silinsin mi?' }, 'Silinsin mi?',
              h('button', { type: 'button', class: 'btn small danger', dataset: { fkey: 'delok-' + it.id }, onclick: () => { removeItem(s, it.id); } }, 'Sil'),
              h('button', { type: 'button', class: 'btn small', dataset: { fkey: 'delno-' + it.id }, onclick: () => { ui.confirmDelete = null; ui.focusKey = 'del-' + it.id; renderAll(); } }, 'Vazgeç'))
            : h('button', { type: 'button', class: 'text-btn', dataset: { fkey: 'del-' + it.id }, 'aria-label': label + ' sil', onclick: () => { ui.confirmDelete = it.id; ui.focusKey = 'delok-' + it.id; renderAll(); } }, icon('trash'), 'Sil')),
        h('div', { class: 'fields' }, s.fields.map((f) => fieldView(f, s.listKey + '.' + it.id + '.' + f.key))));
    });
    return h('section', { class: 'step', 'aria-labelledby': 'question' },
      questionHead(s.fields[0]),
      voiceBanner(),
      h('div', { class: 'items' }, cards),
      h('button', {
        type: 'button', class: 'add-btn', dataset: { fkey: 'add-' + s.listKey }, onclick: () => {
          const it = s.blank();
          cv[s.listKey].push(it);
          afterChange();
          renderAll();
          const path = s.listKey + '.' + it.id + '.' + s.fields[0].key;
          if (conv.on) askSlot({ kind: 'field', step: ui.step, path });
          else { setActive(path, { scroll: true }); focusActive(); }
        },
      }, icon('plus'), s.addLabel));
  }
  function removeItem(s, id) {
    const hit = (p) => { if (!p) return false; const q = parsePath(p); return q.list === s.listKey && q.id === id; };
    cv[s.listKey] = cv[s.listKey].filter((x) => x.id !== id);
    ui.confirmDelete = null;
    if (conv.slot && hit(conv.slot.path)) { stopConvo(); conv.slot = null; }
    if (hit(ui.active)) ui.active = null;
    Object.keys(ui.suggestions).forEach((k) => { if (hit(k)) delete ui.suggestions[k]; });
    afterChange();
    ui.focusKey = cv[s.listKey].length ? 'add-' + s.listKey : 'gate-yes';
    renderAll();
    toast('Silindi.');
  }

  // ---------------------------------------------------------------- intro
  function renderIntro() {
    const hasDraft = PDF.hasContent(cv);
    const micBlock = (() => {
      if (env.mic === 'unsupported') {
        return h('div', { class: 'check' },
          h('div', { class: 'check-head' }, h('span', { class: 'status-dot warn' }), 'Bu tarayıcı sesli yanıtı desteklemiyor'),
          h('p', null, 'Android’de Chrome, iPhone’da Safari, bilgisayarda Chrome ya da Edge ile açın. ' + dictationHelp()));
      }
      if (env.mic === 'blocked' || env.mic === 'service') {
        return h('div', { class: 'check' },
          h('div', { class: 'check-head' }, h('span', { class: 'status-dot warn' }), env.mic === 'service' ? 'Bu cihazda ses tanıma kapalı' : 'Bu sayfada tarayıcı mikrofonu kapalı'),
          h('p', null, (ttsOn() ? 'Sorular yine sesli okunur. ' : '') + 'Yanıt verirken: ' + dictationHelp()),
          FULL_VOICE_URL && IN_VIEWER ? h('p', null, h('a', { href: FULL_VOICE_URL, target: '_blank', rel: 'noopener' }, 'Mikrofonlu sürümü açın')) : null);
      }
      const testing = rec.wanted && conv.slot && conv.slot.kind === 'test';
      return h('div', { class: 'check' },
        h('div', { class: 'check-head' }, h('span', { class: 'status-dot ok' }), env.mic === 'ok' ? 'Mikrofon çalışıyor' : 'Sesli yanıt bu tarayıcıda kullanılabilir'),
        h('p', null, env.mic === 'denied' ? 'Mikrofon izni kapalı. Adres çubuğundaki simgeden izin verip yeniden deneyin.' : 'İlk seferde tarayıcı mikrofon izni ister; açılan pencerede izin verin.'),
        h('div', { class: 'btn-row' },
          h('button', {
            type: 'button', class: 'btn small', id: 'btn-test', dataset: { fkey: 'btn-test' }, onclick: () => {
              if (rec.wanted && conv.slot && conv.slot.kind === 'test') { stopConvo(); rerenderSoft(); return; }
              conv.on = false; conv.mode = 'single'; conv.token++; conv.slot = { kind: 'test', step: 0 };
              rec.start(conv.slot); refreshMicUi(); rerenderSoft();
            },
          }, icon(testing ? 'pause' : 'mic'), testing ? 'Durdur' : 'Mikrofonu dene'),
          h('span', { class: 'heard', id: 'heard' }, testing ? 'Bir şey söyleyin…' : '')));
    })();

    const optRows = h('div', { class: 'opts' },
      switchRow('opt-tts', 'Soruları sesli oku', env.ttsVoice === false ? 'Bu cihazda Türkçe ses bulunamadı; sorular yalnızca yazılı görünür.' : 'Her soru ekranda yazar ve sesli okunur.', ttsOn(), (v) => { settings.tts = v; save(); refreshTtsBtn(); }, env.ttsVoice === false),
      micUsable() ? switchRow('opt-auto', 'Susunca sonraki soruya geç', 'Kapalıysa “devam” deyin ya da İleri’ye dokunun.', settings.autoNext, (v) => { settings.autoNext = v; save(); }) : null);

    const story = env.sample ? h('div', { class: 'ai-card' },
      h('h3', null, 'İsterseniz hepsini tek seferde anlatın'),
      h('p', null, 'Kendinizi baştan sona anlatın: adınız, iletişim bilgileriniz, çalıştığınız yerler, okulunuz, yetenekleriniz. Yapay zekâ alanları doldursun, siz kontrol edin.'),
      h('textarea', { id: 'story', class: 'input', rows: 5, value: ui.story, oninput: (e) => { ui.story = e.target.value; }, 'aria-label': 'Kendinizi anlatın', placeholder: 'Örn. Adım Ayşe Yılmaz, İzmir’de yaşıyorum. 2019’dan beri Kuzey Lojistik’te muhasebe uzmanı olarak çalışıyorum…' }),
      h('div', { class: 'btn-row' },
        micUsable() ? h('button', {
          type: 'button', class: 'btn small', dataset: { fkey: 'btn-story-mic' }, onclick: () => {
            if (rec.wanted && conv.slot && conv.slot.kind === 'story') { stopConvo(); return; }
            conv.on = false; conv.mode = 'single'; conv.token++; conv.slot = { kind: 'story', step: 0 }; rec.start(conv.slot); refreshMicUi();
          },
        }, icon('mic'), 'Konuşarak anlat') : null,
        h('button', { type: 'button', class: 'btn small primary', id: 'btn-story', onclick: fillFromStory }, icon('wand'), 'Alanları doldur')),
      h('p', { class: 'mini-note', id: 'story-status' })) : null;

    return h('section', { class: 'intro', 'aria-labelledby': 'hero' },
      h('div', { class: 'q-wrap' },
        h('p', { class: 'eyebrow' }, 'Konuşarak CV hazırlayın'),
        h('h1', { class: 'hero', id: 'hero' }, 'Sorular gelsin, ', h('em', null, 'siz anlatın.')),
        h('p', { class: 'lead' }, 'Size sırayla sorular soracağız. Yanıtları sesli verin, yazıya biz çevirelim. Sonunda CV’niz PDF olarak hazır.')),
      chromeBanner(),
      hasDraft ? h('div', { class: 'resume' },
        h('p', null, h('b', null, 'Kayıtlı taslağınız var'), cv.name ? ' · ' + cv.name : ''),
        h('button', { type: 'button', class: 'btn small primary', dataset: { fkey: 'resume' }, onclick: onResume }, 'Kaldığım yerden devam et'),
        h('button', { type: 'button', class: 'btn small', onclick: () => openSettings(true) }, 'Yeni CV başlat')) : null,
      h('ol', { class: 'how' },
        h('li', null, h('b', null, 'Soruyu dinleyin'), h('span', null, 'Her soru ekranda yazılı görünür ve sesli okunur.')),
        h('li', null, h('b', null, 'Konuşarak yanıtlayın'), h('span', null, 'Mikrofona dokunun ve söyleyin. İsterseniz yazarak da doldurabilirsiniz.')),
        h('li', null, h('b', null, 'PDF’inizi alın'), h('span', null, 'Şablonu ve rengi seçin; indirin ya da paylaşın.'))),
      micBlock,
      optRows,
      hasDraft ? null : h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn primary', id: 'btn-start', style: { minHeight: '56px', padding: '0 28px', fontSize: '17px' }, onclick: onStart }, 'Başlayalım', icon('right'))),
      story,
      micUsable() ? h('details', { class: 'more' },
        h('summary', null, 'Sesli komutlar'),
        h('p', { class: 'fine' }, 'Yanıt verirken şunları da söyleyebilirsiniz: ', say('devam'), ' sonraki soru, ', say('atla'), ' boş geç, ', say('geri'), ' önceki soru, ', say('sil'), ' alanı temizle, ', say('geri al'), ' son söyleneni kaldır, ', say('tekrar oku'), ' soruyu yeniden oku, ', say('dur'), ' mikrofonu kapat.')) : null,
      h('div', { class: 'btn-row' },
        h('label', { class: 'btn small' }, icon('upload'), 'Yedekten yükle',
          h('input', { type: 'file', class: 'sr', accept: 'application/json,.json', onchange: importJson }))),
      h('p', { class: 'fine' }, env.storeOk
        ? 'Bilgileriniz yalnızca bu cihazda, bu tarayıcıda saklanır. Ses tanıma tarayıcınızın konuşma hizmetiyle yapılır (Chrome’da Google).'
        : 'Bu tarayıcı taslağı saklayamıyor; bitirince PDF’i indirmeyi unutmayın. Ses tanıma tarayıcınızın konuşma hizmetiyle yapılır.'));
  }
  function switchRow(id, label, sub, checked, onChange, disabled) {
    return h('div', { class: 'opt-row' },
      h('label', { for: id }, label, sub ? h('small', null, sub) : null),
      h('span', { class: 'switch' },
        h('input', { type: 'checkbox', id, role: 'switch', checked: !!checked, disabled: !!disabled, onchange: (e) => onChange(e.target.checked) }),
        h('span', null)));
  }
  function onStart() {
    if (rec.wanted) stopConvo();
    goStep(1, { noFocus: true });
    if (micUsable() || ttsOn()) startConvo();
    else focusActive();
  }
  function onResume() {
    if (rec.wanted) stopConvo();
    goStep(ui.resumeStep > 0 ? ui.resumeStep : 1);
  }

  // ---------------------------------------------------------------- photo
  let crop = null;
  function renderPhotoStep(s) {
    const pick = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) openCrop(f); };
    const camLabel = env.touch ? h('label', { class: 'btn primary' }, icon('camera'), 'Selfie çek',
      h('input', { type: 'file', accept: 'image/*', capture: 'user', class: 'sr', onchange: pick })) : null;
    const fileLabel = h('label', { class: 'btn' + (env.touch ? '' : ' primary') }, icon('upload'), env.touch ? 'Galeriden seç' : 'Fotoğraf seç',
      h('input', { type: 'file', accept: 'image/*', class: 'sr', onchange: pick }));
    const pickers = h('div', { class: 'btn-row' }, camLabel, fileLabel);
    let body;
    if (crop) {
      body = h('div', { class: 'crop', id: 'crop' },
        h('canvas', { id: 'crop-canvas', width: 600, height: 600, tabindex: '0', role: 'img', 'aria-label': 'Fotoğraf konumu: sürükleyin ya da ok tuşlarını kullanın' }),
        h('label', { class: 'mini-note', for: 'crop-zoom' }, 'Yakınlaştır'),
        h('input', { type: 'range', id: 'crop-zoom', min: 1, max: 3, step: 0.01, value: crop.zoom, oninput: (e) => { crop.zoom = Number(e.target.value); clampCrop(); drawCrop(); } }),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn primary', onclick: saveCrop }, 'Fotoğrafı kullan'),
          h('button', { type: 'button', class: 'btn', onclick: () => { crop = null; renderAll(); } }, 'Vazgeç')));
    } else if (cv.photo) {
      body = h('div', { class: 'photo-now' },
        h('img', { src: cv.photo, alt: 'Seçilen fotoğraf' }),
        h('div', { class: 'btn-row' }, pickers,
          h('button', { type: 'button', class: 'btn', onclick: () => { cv.photo = ''; afterChange(); renderAll(); toast('Fotoğraf kaldırıldı.'); } }, icon('trash'), 'Kaldır')));
    } else {
      body = h('div', { class: 'drop', id: 'drop' },
        icon('camera'),
        h('div', null, env.touch ? 'Bir selfie çekin ya da galeriden seçin.' : 'Fotoğrafı buraya sürükleyin ya da seçin.'),
        pickers);
    }
    const sec = h('section', { class: 'step', 'aria-labelledby': 'question' },
      questionHead(s), voiceBanner(), h('div', { class: 'photo-box' }, body),
      h('p', { class: 'fine' }, 'Fotoğraf yalnızca bu cihazda işlenir. Sade şablonda fotoğraf kullanılmaz.'));
    setTimeout(() => {
      const drop = $('#drop');
      if (drop) {
        ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
        ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
        drop.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) openCrop(f); });
      }
      if (crop) bindCrop();
    }, 0);
    return sec;
  }
  function openCrop(file) {
    if (!/^image\//.test(file.type || 'image/')) { toast('Lütfen bir fotoğraf dosyası seçin.'); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      crop = { img, url, zoom: 1, x: 0, y: 0 };
      ui.convoBeforePhoto = conv.on;
      if (rec.wanted || conv.speaking || conv.on) stopConvo();
      renderAll();
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('Bu fotoğraf açılamadı. JPEG ya da PNG bir fotoğraf deneyin.'); };
    img.src = url;
  }
  function cropScale() { const S = 600; return Math.max(S / crop.img.naturalWidth, S / crop.img.naturalHeight) * crop.zoom; }
  function clampCrop() {
    const S = 600; const sc = cropScale();
    const w = crop.img.naturalWidth * sc; const hgt = crop.img.naturalHeight * sc;
    const mx = Math.max(0, (w - S) / 2); const my = Math.max(0, (hgt - S) / 2);
    crop.x = Math.max(-mx, Math.min(mx, crop.x));
    crop.y = Math.max(-my, Math.min(my, crop.y));
  }
  function paintCrop(ctx, guide) {
    const S = 600; const sc = cropScale();
    const w = crop.img.naturalWidth * sc; const hgt = crop.img.naturalHeight * sc;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, S, S);
    ctx.drawImage(crop.img, (S - w) / 2 + crop.x, (S - hgt) / 2 + crop.y, w, hgt);
    if (guide) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.rect(0, 0, S, S); ctx.arc(S / 2, S / 2, S / 2 - 4, 0, Math.PI * 2, true); ctx.fill('evenodd');
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 3; ctx.setLineDash([10, 8]);
      ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 4, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }
  function drawCrop() { const c = $('#crop-canvas'); if (c && crop) paintCrop(c.getContext('2d'), true); }
  function bindCrop() {
    const c = $('#crop-canvas');
    if (!c) return;
    clampCrop(); drawCrop();
    let drag = null;
    c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, ox: crop.x, oy: crop.y }; c.setPointerCapture(e.pointerId); c.style.cursor = 'grabbing'; });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const k = 600 / c.getBoundingClientRect().width;
      crop.x = drag.ox + (e.clientX - drag.x) * k;
      crop.y = drag.oy + (e.clientY - drag.y) * k;
      clampCrop(); drawCrop();
    });
    const end = () => { drag = null; c.style.cursor = 'grab'; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => { e.preventDefault(); crop.zoom = Math.max(1, Math.min(3, crop.zoom - e.deltaY * 0.0015)); const z = $('#crop-zoom'); if (z) z.value = crop.zoom; clampCrop(); drawCrop(); }, { passive: false });
    c.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 40 : 10;
      const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[e.key]) { e.preventDefault(); crop.x += moves[e.key][0]; crop.y += moves[e.key][1]; }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); crop.zoom = Math.min(3, crop.zoom + 0.1); }
      else if (e.key === '-') { e.preventDefault(); crop.zoom = Math.max(1, crop.zoom - 0.1); }
      else return;
      const z = $('#crop-zoom'); if (z) z.value = crop.zoom;
      clampCrop(); drawCrop();
    });
  }
  function saveCrop() {
    const c = D.createElement('canvas');
    c.width = 600; c.height = 600;
    paintCrop(c.getContext('2d'), false);
    cv.photo = c.toDataURL('image/jpeg', 0.86);
    try { URL.revokeObjectURL(crop.url); } catch (_) { /* ignore */ }
    crop = null;
    afterChange();
    renderAll();
    toast('Fotoğraf eklendi.');
    if (ui.convoBeforePhoto) {
      ui.convoBeforePhoto = false;
      const n = firstOpenSlot(ui.step + 1);
      if (n) startConvo(n);
    }
  }

  // ---------------------------------------------------------------- final step
  function tplThumb(id, accent) {
    const box = h('span', { class: 'tpl-thumb', 'aria-hidden': 'true' });
    const add = (st) => box.append(h('i', { style: st }));
    if (id === 'modern') {
      add({ left: '0', top: '0', bottom: '0', width: '32%', background: accent, borderRadius: '0' });
      add({ left: '8%', top: '6%', width: '16%', height: '11%', background: 'rgba(255,255,255,.75)', borderRadius: '50%' });
      add({ left: '40%', top: '7%', width: '45%', height: '5%', background: '#333' });
      add({ left: '40%', top: '14%', width: '30%', height: '2.5%', background: accent });
      for (let i = 0; i < 6; i++) add({ left: '40%', top: (24 + i * 9) + '%', width: (i % 2 ? '42%' : '52%'), height: '2.5%' });
    } else if (id === 'klasik') {
      add({ left: '10%', top: '7%', width: '48%', height: '6%', background: '#333' });
      add({ left: '10%', top: '15%', width: '30%', height: '2.5%', background: accent });
      add({ right: '10%', top: '6%', width: '15%', height: '11%', background: '#c9cfcb' });
      add({ left: '10%', right: '10%', top: '21%', height: '0.8%', background: accent });
      for (let i = 0; i < 6; i++) { add({ left: '10%', top: (27 + i * 10) + '%', width: '16%', height: '2.2%', background: accent }); add({ left: '32%', top: (27 + i * 10) + '%', width: (i % 2 ? '46%' : '58%'), height: '2.2%' }); }
    } else {
      add({ left: '12%', top: '7%', width: '44%', height: '5%', background: '#333' });
      add({ left: '12%', top: '14%', width: '60%', height: '2.2%' });
      for (let i = 0; i < 7; i++) add({ left: '12%', top: (22 + i * 9) + '%', width: (i % 3 === 0 ? '30%' : '72%'), height: '2.2%', background: i % 3 === 0 ? '#555' : '#d7dcd9' });
    }
    return box;
  }
  function missingList() {
    const out = [];
    const need = [['name', 'Ad Soyad', 1], ['title', 'Meslek', 1], ['phone', 'Telefon', 2], ['email', 'E-posta', 2], ['summary', 'Kısa özet', 4]];
    need.forEach(([k, label, st]) => { if (!(cv[k] || '').trim()) out.push([label, st]); });
    if (!cv.jobs.some((j) => j.role || j.company)) out.push(['İş deneyimi', 5]);
    if (!cv.edu.some((e) => e.school || e.program)) out.push(['Eğitim', 6]);
    if (!cv.skills.trim()) out.push(['Yetenekler', 7]);
    return out;
  }
  function downloadNotice() {
    if (env.noDownload && env.android) return h('div', { class: 'banner', role: 'note' }, icon('info'), h('div', { style: { display: 'grid', gap: '10px' } },
      h('div', null, h('b', null, 'Bu uygulamanın tarayıcısı dosya indiremiyor.'), ' PDF’i almak için sayfayı Chrome’da açın.'),
      h('div', { class: 'btn-row' }, h('a', { class: 'btn small primary', href: chromeIntentUrl() }, 'Chrome’da aç'))));
    if (env.noDownload) return h('div', { class: 'banner', role: 'note' }, icon('info'),
      h('div', null, h('b', null, 'Bu uygulamanın tarayıcısı dosya indiremiyor.'), ' Menüden sayfayı Safari’de ya da Chrome’da açın, PDF’i oradan indirin.'));
    if (IN_VIEWER && env.dl === null) return h('div', { class: 'banner', role: 'note' }, icon('info'),
      h('div', null, h('b', null, 'Bu görünümde dosya indirilemiyor.'), ' Sayfayı Claude’da açtığınızda PDF’i indirebilirsiniz.'));
    return null;
  }
  function renderPreviewStep(s) {
    const tpl = PDF.TEMPLATES.find((t) => t.id === settings.template) || PDF.TEMPLATES[0];
    const missing = PDF.hasContent(cv) ? missingList() : [];
    const notice = downloadNotice();
    const controls = h('div', { class: 'final-controls' },
      h('div', { class: 'ctl' }, h('h3', null, 'Şablon'),
        h('div', { class: 'tpls' }, PDF.TEMPLATES.map((t) => h('button', {
          type: 'button', class: 'tpl', 'aria-pressed': t.id === settings.template ? 'true' : 'false', dataset: { fkey: 'tpl-' + t.id },
          onclick: () => { settings.template = t.id; save(); renderAll(); },
        }, tplThumb(t.id, settings.accent), t.tr)))),
      h('div', { class: 'ctl' }, h('h3', null, 'Renk'),
        h('div', { class: 'swatches', role: 'group', 'aria-label': 'Renk' }, PDF.ACCENTS.map((c, i) => h('button', {
          type: 'button', class: 'swatch', style: { background: c }, 'aria-label': ACCENT_NAMES[i] || 'Renk ' + (i + 1), title: ACCENT_NAMES[i] || '',
          'aria-pressed': c.toLowerCase() === settings.accent.toLowerCase() ? 'true' : 'false', dataset: { fkey: 'sw-' + i },
          onclick: () => { settings.accent = c; save(); renderAll(); },
        })))),
      h('div', { class: 'ctl' }, h('h3', null, 'Başlık dili'),
        h('div', { class: 'seg', role: 'group', 'aria-label': 'CV başlık dili' },
          h('button', { type: 'button', 'aria-pressed': settings.lang === 'tr' ? 'true' : 'false', dataset: { fkey: 'lang-tr' }, onclick: () => { settings.lang = 'tr'; save(); renderAll(); } }, 'Türkçe'),
          h('button', { type: 'button', 'aria-pressed': settings.lang === 'en' ? 'true' : 'false', dataset: { fkey: 'lang-en' }, onclick: () => { settings.lang = 'en'; save(); renderAll(); } }, 'English')),
        settings.lang === 'en' ? h('p', { class: 'mini-note' }, 'Bölüm başlıkları ve tarihler İngilizce yazılır; sizin yazdıklarınız olduğu gibi kalır.') : null),
      tpl.photo && cv.photo ? switchRow('opt-photo', 'Fotoğrafı göster', '', settings.showPhoto, (v) => { settings.showPhoto = v; save(); schedulePreview(50); }) : null,
      missing.length ? h('div', { class: 'ctl' }, h('h3', null, 'Eksik görünenler'),
        h('div', { class: 'chips', role: 'group', 'aria-label': 'Eksik görünenler' }, missing.map(([label, st]) => h('button', { type: 'button', class: 'chip', onclick: () => goStep(st) }, label)))) : null,
      notice,
      notice ? null : h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn primary', id: 'btn-pdf', onclick: downloadPdf }, icon('download'), 'PDF olarak indir'),
        env.canShareFiles ? h('button', { type: 'button', class: 'btn', onclick: sharePdf }, icon('share'), 'Paylaş') : null),
      h('p', { class: 'mini-note', id: 'pdf-status' }, PDF.hasContent(cv) ? 'Dosya adı: ' + PDF.fileName(cv) : 'Henüz bilgi girilmedi; önizlemedeki CV bir örnektir.'),
      h('details', { class: 'more' },
        h('summary', null, 'Yedekle ve yükle'),
        h('p', { class: 'fine' }, 'Bilgilerinizi bir dosyaya kaydedip başka bir cihazda ya da daha sonra yükleyebilirsiniz.'),
        h('div', { class: 'btn-row', style: { marginTop: '10px' } },
          env.noDownload ? null : h('button', { type: 'button', class: 'btn small', onclick: exportJson }, icon('file'), 'Yedek dosyası indir'),
          h('label', { class: 'btn small' }, icon('upload'), 'Yedekten yükle',
            h('input', { type: 'file', class: 'sr', accept: 'application/json,.json', onchange: importJson })))));
    return h('section', { class: 'final', 'aria-labelledby': 'question' },
      questionHead(s),
      h('div', { class: 'final-grid' }, controls,
        h('div', { class: 'big-pages' }, h('div', { class: 'pv-head' }, h('span', null, 'Önizleme'), h('span', { class: 'badge', id: 'pv-big-badge', hidden: PDF.hasContent(cv) }, 'Örnek CV')),
          h('div', { class: 'pages', id: 'pv-big' }, h('div', { class: 'pv-empty' }, 'Önizleme hazırlanıyor…')))));
  }

  // ---------------------------------------------------------------- libraries & preview
  const loaded = {};
  function loadScript(src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise((resolve, reject) => {
      const s = D.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = () => resolve();
      s.onerror = () => { delete loaded[src]; s.remove(); reject(new Error('Yüklenemedi: ' + src)); };
      D.head.append(s);
    });
    return loaded[src];
  }
  let pdfmakeP = null;
  function ensurePdfmake() {
    if (!pdfmakeP) {
      pdfmakeP = (async () => {
        await loadScript(LIBS.pdfmake);
        await loadScript(LIBS.vfs);
        try { await loadScript(LIBS.fonts); } catch (_) { /* başlık fontu olmadan da çalışır */ }
        PDF.registerFonts(window.pdfMake);
      })();
      pdfmakeP.catch(() => { pdfmakeP = null; });
    }
    return pdfmakeP;
  }
  let pdfjsP = null;
  function ensurePdfjs() {
    if (!pdfjsP) {
      pdfjsP = (async () => {
        await loadScript(LIBS.pdfjs);
        // Worker kodunu ana iş parçacığında yükle: pdf.js gerçek Worker açmadan bunu kullanır.
        await loadScript(LIBS.pdfjsWorker);
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfjsWorker;
      })();
      pdfjsP.catch(() => { pdfjsP = null; });
    }
    return pdfjsP;
  }
  let roundCache = { src: '', out: '' };
  function roundPhoto(src) {
    if (!src) return Promise.resolve('');
    if (roundCache.src === src) return Promise.resolve(roundCache.out);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const S = 480; const c = D.createElement('canvas'); c.width = S; c.height = S;
        const x = c.getContext('2d');
        x.beginPath(); x.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); x.closePath(); x.clip();
        x.drawImage(img, 0, 0, S, S);
        const out = c.toDataURL('image/png');
        roundCache = { src, out };
        resolve(out);
      };
      img.onerror = () => resolve('');
      img.src = src;
    });
  }
  async function pdfOpts(data) {
    return {
      template: settings.template, accent: settings.accent, lang: settings.lang, showPhoto: settings.showPhoto,
      photoRound: settings.showPhoto && data.photo ? await roundPhoto(data.photo) : '',
    };
  }
  function withTimeout(p, ms, msg) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg || 'zaman aşımı')), ms))]);
  }
  function pdfBuffer(dd) {
    return withTimeout(new Promise((resolve, reject) => {
      try { window.pdfMake.createPdf(dd).getBuffer((b) => resolve(b)); } catch (e) { reject(e); }
    }), 30000, 'PDF oluşturma zaman aşımı');
  }
  function pdfBlob(dd) {
    return withTimeout(new Promise((resolve, reject) => {
      try { window.pdfMake.createPdf(dd).getBlob((b) => resolve(b)); } catch (e) { reject(e); }
    }), 30000, 'PDF oluşturma zaman aşımı');
  }

  const pv = { timer: 0, gen: 0 };
  function schedulePreview(ms) { clearTimeout(pv.timer); pv.timer = setTimeout(renderPreviews, ms == null ? 700 : ms); }
  function previewTargets() {
    const out = [];
    const side = $('#pv-side');
    if (side && side.offsetParent !== null) out.push(side);
    const big = $('#pv-big');
    if (big) out.push(big);
    const sheet = $('#sheet-preview');
    if (sheet && !sheet.hidden) out.push($('#pv-sheet'));
    return out;
  }
  async function renderPreviews() {
    const targets = previewTargets();
    if (!targets.length) return;
    const my = ++pv.gen;
    targets.forEach((t) => t.classList.add('pv-busy'));
    try {
      await Promise.all([ensurePdfmake(), ensurePdfjs()]);
      const sample = !PDF.hasContent(cv);
      const data = sample ? PDF.SAMPLE : cv;
      const dd = PDF.build(data, await pdfOpts(data));
      const buf = await pdfBuffer(dd);
      if (my !== pv.gen) return;
      const pdf = await window.pdfjsLib.getDocument({ data: buf, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
      for (const t of targets) { if (my !== pv.gen) break; await drawPdf(pdf, t, my); }
      try { pdf.destroy(); } catch (_) { /* ignore */ }
      const badge = $('#pv-badge'); if (badge) badge.hidden = !sample;
      const big = $('#pv-big-badge'); if (big) big.hidden = !sample;
      const note = $('#sheet-preview-note'); if (note) note.textContent = sample ? 'Henüz bilgi girmediniz; bu bir örnek CV. Yanıt verdikçe kendi CV’niz görünür.' : '';
    } catch (e) {
      if (my !== pv.gen) return;
      console.error(e);
      targets.forEach((t) => t.replaceChildren(h('div', { class: 'pv-empty' }, 'Önizleme oluşturulamadı. İnternet bağlantınızı kontrol edip sayfayı yenileyin.')));
    } finally {
      targets.forEach((t) => t.classList.remove('pv-busy'));
    }
  }
  async function drawPdf(pdf, target, my) {
    const width = Math.max(180, Math.floor(target.clientWidth || 320));
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (width / base.width) * dpr });
      const c = D.createElement('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      c.setAttribute('role', 'img');
      c.setAttribute('aria-label', 'CV sayfa ' + i + ' / ' + pdf.numPages);
      await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
      if (my !== pv.gen) return;
      pages.push(h('div', { class: 'page' }, c)); // çok sayfalı CV'de sayfa numarası PDF'in kendi altbilgisinde
    }
    target.replaceChildren(...pages);
  }

  // ---------------------------------------------------------------- export
  let exportBusy = false;
  function downloadsError(e) {
    const code = e && e.code;
    if (code === 'declined') toast('İndirme iptal edildi.');
    else if (code === 'rate_limited') toast('Bir indirme penceresi zaten açık.');
    else toast('Bu görünümde dosya indirilemiyor.');
  }
  async function buildCurrentPdf() {
    await ensurePdfmake();
    const dd = PDF.build(cv, await pdfOpts(cv));
    return { dd, name: PDF.fileName(cv) };
  }
  async function downloadPdf() {
    if (!PDF.hasContent(cv)) { toast('CV’niz henüz boş. Önce birkaç soruyu yanıtlayın.'); return; }
    if (env.noDownload) { toast(env.android ? 'Bu uygulamanın tarayıcısı dosya indiremiyor. Sayfayı Chrome’da açın.' : 'Bu uygulamanın tarayıcısı dosya indiremiyor. Sayfayı Safari’de açın.', 6000); return; }
    if (exportBusy) return;
    exportBusy = true;
    const setBusy = (b) => { const a = $('#btn-pdf'); if (a) a.disabled = b; const n = $('#btn-next'); if (n && STEPS[ui.step].kind === 'preview') n.disabled = b; };
    setBusy(true);
    const status = $('#pdf-status');
    if (status) status.textContent = 'PDF hazırlanıyor…';
    try {
      const { dd, name } = await buildCurrentPdf();
      const dl = await env.downloadsP;
      if (dl) {
        const blob = await pdfBlob(dd);
        try { await dl.save({ filename: name, data: blob }); toast('PDF kaydedildi: ' + name); }
        catch (err) { downloadsError(err); }
      } else if (IN_VIEWER) {
        toast('Bu görünümde dosya indirilemiyor.');
      } else {
        const blob = await pdfBlob(dd);
        saveBlob(blob, name);
        toast('İndirme başlatıldı: ' + name);
      }
      const st = $('#pdf-status'); if (st) st.textContent = 'Dosya adı: ' + name;
    } catch (e) {
      console.error(e);
      toast('PDF oluşturulamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.', 5000);
      const st = $('#pdf-status'); if (st) st.textContent = 'PDF oluşturulamadı.';
    } finally {
      exportBusy = false;
      setBusy(false);
      refreshDock();
    }
  }
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name, style: { display: 'none' } });
    D.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  }
  async function sharePdf() {
    if (!PDF.hasContent(cv)) { toast('CV’niz henüz boş.'); return; }
    if (exportBusy) return;
    exportBusy = true;
    try {
      const { dd, name } = await buildCurrentPdf();
      const blob = await pdfBlob(dd);
      const file = new File([blob], name, { type: 'application/pdf' });
      await navigator.share({ files: [file], title: (cv.name ? cv.name + ' — ' : '') + 'CV' });
    } catch (e) {
      if (!(e && e.name === 'AbortError')) toast('Paylaşım açılamadı. “PDF olarak indir” ile kaydedip öyle gönderin.', 5000);
    } finally {
      exportBusy = false;
    }
  }
  async function exportJson() {
    const data = JSON.stringify({ app: 'sesli-cv', version: 1, cv, settings }, null, 2);
    const name = P.fileName(cv.name, 'CV_yedek', 'json');
    const dl = await env.downloadsP;
    if (dl) { try { await dl.save({ filename: name, data }); toast('Yedek kaydedildi.'); } catch (e) { downloadsError(e); } return; }
    if (IN_VIEWER) { toast('Bu görünümde dosya indirilemiyor.'); return; }
    if (env.noDownload) { toast('Bu uygulamanın tarayıcısı dosya indiremiyor.'); return; }
    saveBlob(new Blob([data], { type: 'application/json' }), name);
    toast('Yedek dosyası indirildi.');
  }
  function importJson(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(String(r.result));
        if (!data || data.app !== 'sesli-cv' || !data.cv) throw new Error('format');
        cv = sanitizeCv(data.cv);
        settings = Object.assign(sanitizeSettings(data.settings), { tts: settings.tts, autoNext: settings.autoNext, speechLang: settings.speechLang });
        ui.gateOpen = {};
        afterChange();
        if (ui.step === 0) goStep(1); else renderAll();
        toast('Yedek yüklendi.');
      } catch (_) { toast('Bu dosya bir Sesli CV yedeği değil.'); }
    };
    r.readAsText(f);
  }

  // ---------------------------------------------------------------- AI (Claude içinde açıldığında)
  function aiError(e, statusEl) {
    const code = e && e.code;
    if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)) {
      env.sample = null;
      D.body.classList.remove('has-ai');
      rerenderSoft();
      toast('Yapay zekâ düzenlemesi bu görünümde kapalı.');
      return;
    }
    if (code === 'cancelled') { if (statusEl) statusEl.textContent = ''; return; }
    const msg = code === 'rate_limited' ? 'Çok sık istek gönderildi; biraz sonra tekrar deneyin.'
      : code === 'session_expired' ? 'Oturumunuzun süresi dolmuş; yeniden giriş yapın.'
        : code === 'invalid_json' ? 'Yanıt anlaşılamadı; tekrar deneyin.'
          : 'Şu an yanıt alınamadı; tekrar deneyin.';
    if (statusEl) statusEl.textContent = msg; else toast(msg);
  }
  function appliedRow(path) {
    return h('div', { class: 'ai-row' },
      h('button', {
        type: 'button', class: 'btn small', dataset: { fkey: 'revert-' + path }, onclick: () => {
          const prev = ui.applied[path];
          delete ui.applied[path];
          setVal(path, prev);
          toast('Önceki metin geri getirildi.');
        },
      }, icon('refresh'), 'Önceki metne dön'));
  }
  function aiRow(f, path) {
    const sug = ui.suggestions[path];
    const row = h('div', { class: 'ai-row' });
    const status = h('span', { class: 'mini-note' });
    const btn = h('button', {
      type: 'button', class: 'ai-btn', dataset: { fkey: 'ai-' + path }, onclick: async () => {
        const val = getVal(path).trim();
        if (val.length < 8) { toast('Önce birkaç cümle söyleyin ya da yazın.'); return; }
        btn.disabled = true; status.textContent = 'Düzenleniyor…';
        try {
          if (f.ai === 'summary') {
            const { text } = await env.sample(summaryPrompt(val), { modelTier: 'quick', cache: false });
            ui.suggestions[path] = text.trim().replace(/^["“]|["”]$/g, '');
          } else {
            const ctx = parsePath(path); const it = getItem(ctx.list, ctx.id) || {};
            const arr = await env.sample.json(bulletsPrompt(val, it), { modelTier: 'quick', cache: false });
            if (!Array.isArray(arr) || !arr.length) throw { code: 'invalid_json' };
            ui.suggestions[path] = arr.map((x) => String(x).trim()).filter(Boolean).join('\n');
          }
          ui.focusKey = 'apply-' + path;
          refreshExtras(path);
        } catch (e) { aiError(e, status); btn.disabled = false; }
      },
    }, icon('wand'), f.ai === 'summary' ? 'Yapay zekâ ile düzenle' : 'Maddeleri düzenle');
    row.append(btn, status);
    const parts = [row];
    if (ui.applied[path] !== undefined && !sug) parts.push(appliedRow(path));
    if (sug) {
      parts.push(h('div', { class: 'suggest' }, sug,
        h('div', { class: 'row' },
          h('button', {
            type: 'button', class: 'btn small primary', dataset: { fkey: 'apply-' + path }, onclick: () => {
              ui.applied[path] = getVal(path);
              const v = ui.suggestions[path];
              delete ui.suggestions[path];
              ui.focusKey = 'revert-' + path;
              setVal(path, v);
              toast('Öneri uygulandı.');
            },
          }, 'Uygula'),
          h('button', { type: 'button', class: 'btn small', onclick: () => { delete ui.suggestions[path]; ui.focusKey = 'ai-' + path; refreshExtras(path); } }, 'Vazgeç'))));
    }
    return h('div', { class: 'ai-wrap' }, parts);
  }
  function summaryPrompt(text) {
    return 'Bir CV hazırlama uygulamasındasın. Kişi “Kendinizi kısaca anlatır mısınız?” sorusunu sesli yanıtladı; konuşma yazıya çevrildiği için yazım ve noktalama hataları olabilir.\n' +
      'Görev: Bu yanıtı CV’nin Profil bölümü için 2–4 cümlelik, akıcı ve profesyonel bir metne dönüştür.\n' +
      'Kurallar:\n- Yalnızca yanıttaki bilgileri kullan; yeni bilgi, rakam, şirket ya da beceri ekleme.\n- Yanıt hangi dildeyse o dilde yaz.\n' +
      '- Birinci tekil şahıs kullan, abartılı sıfatlardan kaçın, doğal ve sade yaz.\n- Yalnızca metni yaz; başlık, tırnak ya da açıklama ekleme.\n\n' +
      'Kişinin mesleği: ' + (cv.title || 'belirtilmedi') + '\nYanıt:\n"""' + text.slice(0, 4000) + '"""';
  }
  function bulletsPrompt(text, it) {
    return 'Bir CV hazırlama uygulamasındasın. Kişi bir iş deneyimi için “Bu işte neler yaptınız?” sorusunu sesli yanıtladı; konuşma yazıya çevrildiği için yazım hataları olabilir.\n' +
      'Pozisyon: ' + (it.role || 'belirtilmedi') + '. Şirket: ' + (it.company || 'belirtilmedi') + '.\n' +
      'Görev: Yanıtı 2–6 kısa CV maddesine dönüştür. Her madde tek cümle olsun ve fiille bitsin (örn. “Aylık bütçe raporlarını hazırladım.”).\n' +
      'Kurallar: yalnızca verilen bilgileri kullan, rakam ya da başarı uydurma; tekrarları birleştir; yanıt hangi dildeyse o dilde yaz.\n' +
      'Yalnızca bir JSON dizi döndür, örnek: ["Birinci madde.", "İkinci madde."]\n\nYanıt:\n"""' + text.slice(0, 4000) + '"""';
  }
  async function fillFromStory() {
    const status = $('#story-status');
    const text = (ui.story || '').trim();
    if (text.length < 30) { toast('Biraz daha anlatın: en az birkaç cümle.'); return; }
    if (rec.wanted) stopConvo();
    const btn = $('#btn-story');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Anlattıklarınız alanlara yerleştiriliyor… Bu birkaç saniye sürebilir.';
    try {
      const prompt = 'Bir CV hazırlama uygulamasındasın. Kişi kendini serbestçe anlattı (sesli dikteden yazıya çevrildi; yazım hataları olabilir). Bu anlatımdan CV alanlarını çıkar.\n' +
        'Yalnızca şu biçimde TEK bir JSON nesnesi döndür:\n' +
        '{"name":"","title":"","phone":"","email":"","city":"","web":"","summary":"","jobs":[{"role":"","company":"","city":"","start":"","end":"","desc":""}],"edu":[{"school":"","program":"","degree":"","start":"","end":"","note":""}],"skills":"","langs":"","certs":"","hobbies":"","refs":"","birth":"","military":"","license":"","marital":""}\n' +
        'Kurallar:\n- Söylenmeyen alanı boş bırak (""); tahmin etme, uydurma.\n- Tarihler: "Mart 2019", "2019" ya da hâlâ sürüyorsa "Devam ediyor".\n' +
        '- desc: her görev ayrı satırda (\\n ile), kısa CV maddeleri.\n- skills ve hobbies: virgülle ayrılmış liste. langs: "İngilizce ileri, Almanca başlangıç" gibi.\n' +
        '- certs ve refs: her biri ayrı satırda.\n- summary: anlatılanlara dayanan 2–3 cümlelik profesyonel özet.\n- İşleri ve okulları en yeniden eskiye sırala.\n\n' +
        'Anlatım:\n"""' + text.slice(0, 12000) + '"""';
      const data = await env.sample.json(prompt, { cache: false });
      const n = mergeStory(data);
      if (status) status.textContent = '';
      toast(n ? n + ' alan dolduruldu. Lütfen kontrol edin.' : 'Anlatımdan alan çıkarılamadı. Daha ayrıntılı anlatmayı deneyin.', 5000);
      if (n) { ui.story = ''; goStep(1); }
    } catch (e) {
      aiError(e, status);
    } finally {
      const b = $('#btn-story'); if (b) b.disabled = false;
    }
  }
  function mergeStory(data) {
    if (!data || typeof data !== 'object') return 0;
    const clean = sanitizeCv(data);
    let n = 0;
    Object.keys(clean).forEach((k) => {
      if (k === 'jobs' || k === 'edu' || k === 'photo') return;
      const v = (clean[k] || '').trim();
      if (v && !(cv[k] || '').trim()) { cv[k] = v; n++; }
    });
    const keyOf = { jobs: ['company', 'role'], edu: ['school', 'program'] };
    const nonEmpty = (it) => Object.keys(it).some((x) => x !== 'id' && (it[x] || '').trim());
    ['jobs', 'edu'].forEach((k) => {
      const [a, b] = keyOf[k];
      cv[k] = cv[k].filter(nonEmpty);
      clean[k].filter(nonEmpty).forEach((inc) => {
        const match = cv[k].find((ex) => fk(ex[a]) && fk(ex[a]) === fk(inc[a]) && (!fk(ex[b]) || !fk(inc[b]) || fk(ex[b]) === fk(inc[b])));
        if (match) {
          Object.keys(inc).forEach((x) => { if (x !== 'id' && !(match[x] || '').trim() && (inc[x] || '').trim()) { match[x] = inc[x]; n++; } });
        } else { cv[k].push(inc); n++; }
      });
    });
    afterChange();
    return n;
  }

  // ---------------------------------------------------------------- sheets & settings
  let lastFocus = null;
  function setBackgroundInert(on) {
    ['#shell', '.topbar'].forEach((sel) => { const el = $(sel); if (el) el.inert = on; });
  }
  function openSheet(id) {
    const el = D.getElementById(id);
    if (!el.hidden) return;
    lastFocus = D.activeElement;
    setBackgroundInert(true);
    el.hidden = false;
    if (!IN_VIEWER) { try { history.pushState({ step: ui.step, sheet: id }, ''); } catch (_) { /* ignore */ } }
    const btn = el.querySelector('[data-close].icon-btn');
    if (btn) btn.focus();
    if (id === 'sheet-preview') schedulePreview(30);
  }
  function hideSheet(el) {
    if (el.hidden) return;
    el.hidden = true;
    if (!$$('.sheet').some((s) => !s.hidden)) setBackgroundInert(false);
    if (lastFocus && lastFocus.isConnected && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }
  function closeSheet(el) {
    if (!IN_VIEWER && history.state && history.state.sheet) { try { history.back(); return; } catch (_) { /* fall through */ } }
    hideSheet(el);
  }
  function openSettings(confirmReset) {
    const body = $('#settings-body');
    const resetBox = h('div', { class: 'btn-row', id: 'reset-box' });
    const showReset = (ask) => {
      resetBox.replaceChildren(...(ask
        ? [h('span', null, 'Tüm bilgiler silinsin mi?'),
          h('button', { type: 'button', class: 'btn small danger', dataset: { fkey: 'reset-yes' }, onclick: resetAll }, 'Evet, sil'),
          h('button', { type: 'button', class: 'btn small', dataset: { fkey: 'reset-no' }, onclick: () => { showReset(false); const b = $('[data-fkey="reset-ask"]'); if (b) b.focus(); } }, 'Vazgeç')]
        : [h('button', { type: 'button', class: 'btn small', dataset: { fkey: 'reset-ask' }, onclick: () => { showReset(true); const b = $('[data-fkey="reset-yes"]'); if (b) b.focus(); } }, icon('refresh'), 'Yeni CV başlat')]));
    };
    showReset(!!confirmReset);
    keepFocus(() => body.replaceChildren(
      h('div', { class: 'opts' },
        switchRow('set-tts', 'Soruları sesli oku', env.ttsVoice === false ? 'Bu cihazda Türkçe ses bulunamadı.' : '', ttsOn(), (v) => { settings.tts = v; save(); refreshTtsBtn(); }, env.ttsVoice === false),
        switchRow('set-auto', 'Susunca sonraki soruya geç', 'Kapalıysa “devam” deyin ya da İleri’ye dokunun.', settings.autoNext, (v) => { settings.autoNext = v; save(); refreshMicUi(); }),
        h('div', { class: 'opt-row' },
          h('span', null, 'Konuşacağınız dil', h('small', null, 'Yanıtları hangi dilde söyleyeceksiniz?')),
          h('div', { class: 'seg', role: 'group', 'aria-label': 'Konuşma dili' },
            h('button', { type: 'button', 'aria-pressed': settings.speechLang === 'tr-TR' ? 'true' : 'false', dataset: { fkey: 'sl-tr' }, onclick: () => { setSpeechLang('tr-TR'); openSettings(); } }, 'Türkçe'),
            h('button', { type: 'button', 'aria-pressed': settings.speechLang === 'en-US' ? 'true' : 'false', dataset: { fkey: 'sl-en' }, onclick: () => { setSpeechLang('en-US'); openSettings(); } }, 'English')))),
      settings.speechLang === 'en-US' ? h('p', { class: 'mini-note' }, 'İngilizce konuşurken komutlar: next, skip, back, yes, no, undo, repeat, stop. Sorular yine Türkçe okunur.') : null,
      h('details', { class: 'more', style: { marginTop: '12px' } },
        h('summary', null, 'Sesli komutlar'),
        h('p', { class: 'fine' }, say('devam'), ' sonraki soru · ', say('atla'), ' boş geç · ', say('geri'), ' önceki soru · ', say('sil'), ' alanı temizle · ', say('geri al'), ' son söyleneni kaldır · ', say('tekrar oku'), ' soruyu yeniden oku · ', say('dur'), ' mikrofonu kapat')),
      h('div', { style: { marginTop: '18px' } }, resetBox),
      h('p', { class: 'fine', style: { marginTop: '14px' } }, env.storeOk ? 'Bilgileriniz yalnızca bu cihazda saklanır.' : 'Bu tarayıcı taslağı saklayamıyor; bitirince PDF’i indirin.')));
    openSheet('sheet-settings');
    if (confirmReset) { const b = $('[data-fkey="reset-yes"]'); if (b) b.focus(); }
  }
  function setSpeechLang(l) {
    settings.speechLang = l;
    rec.setLang(l);
    save();
  }
  function resetAll() {
    stopConvo();
    cv = blankCv();
    ui.suggestions = {};
    ui.applied = {};
    ui.gateOpen = {};
    ui.story = '';
    ui.resumeStep = 0;
    undoStacks.clear();
    try { localStorage.removeItem(STORE_KEY); } catch (_) { /* ignore */ }
    hideSheet($('#sheet-settings'));
    goStep(0);
    ui.resumeStep = 0;
    toast('Yeni bir CV’ye başladınız.');
  }
  function refreshTtsBtn() {
    const b = $('#btn-tts');
    const on = ttsOn();
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    $('#tts-use').setAttribute('href', on ? '#i-speaker-on' : '#i-speaker-off');
    b.title = env.ttsVoice === false ? 'Bu cihazda Türkçe ses yok' : on ? 'Sesli okuma açık' : 'Sesli okuma kapalı';
    b.disabled = env.ttsVoice === false;
    const opt = D.getElementById('opt-tts'); if (opt) opt.checked = on;
  }
  function checkTts() {
    SP.voiceStatus('tr-TR').then((s) => {
      if (s === env.ttsVoice) return;
      env.ttsVoice = s;
      refreshTtsBtn();
      if (STEPS[ui.step].kind === 'intro') rerenderSoft();
    });
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    $('#btn-mic').addEventListener('click', () => {
      if (rec.wanted || conv.speaking || conv.on) { stopConvo(); return; }
      if (!micUsable()) {
        if (ttsOn()) startConvo();
        else { focusActive(); toast(dictationHelp(), 5000); }
        return;
      }
      startConvo();
    });
    $('#btn-next').addEventListener('click', () => {
      if (STEPS[ui.step].kind === 'preview') { downloadPdf(); return; }
      const s = conv.slot;
      if (conv.on && s && s.step === ui.step) {
        if (s.kind === 'gate' || s.kind === 'more') { answerGate(s, false); return; }
        if (s.kind === 'field' || s.kind === 'photo' || s.kind === 'review') { advance(s); return; }
      }
      goStep(ui.step + 1);
    });
    $('#btn-back').addEventListener('click', () => goStep(ui.step - 1));
    $('#brand').addEventListener('click', (e) => { e.preventDefault(); goStep(0); });
    $('#btn-preview').addEventListener('click', () => openSheet('sheet-preview'));
    $('#btn-settings').addEventListener('click', () => openSettings());
    $('#btn-tts').addEventListener('click', () => {
      settings.tts = !settings.tts;
      if (!settings.tts) SP.cancelSpeech();
      save(); refreshTtsBtn();
      toast(settings.tts ? 'Sorular sesli okunacak.' : 'Sorular sesli okunmayacak.');
    });
    $$('.sheet').forEach((sh) => sh.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(sh); }));
    D.addEventListener('keydown', (e) => {
      const openSh = $$('.sheet').find((s) => !s.hidden);
      if (e.key === 'Escape') {
        if (openSh) { closeSheet(openSh); return; }
        if (rec.wanted || conv.speaking || conv.on) stopConvo();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.defaultPrevented && !openSh && STEPS[ui.step].kind !== 'preview' && !e.target.closest('textarea')) {
        e.preventDefault(); goStep(ui.step + 1);
      }
    });
    D.addEventListener('visibilitychange', () => { if (D.hidden && (rec.wanted || conv.speaking || conv.on)) stopConvo(); });
    if (!IN_VIEWER) {
      window.addEventListener('popstate', (e) => {
        const openSh = $$('.sheet').find((s) => !s.hidden);
        if (openSh) { hideSheet(openSh); return; }
        const st = e.state && typeof e.state.step === 'number' ? e.state.step : 0;
        ui.popping = true;
        try { goStep(st); } finally { ui.popping = false; }
      });
    }
    let lastW = window.innerWidth;
    window.addEventListener('resize', () => {
      if (Math.abs(window.innerWidth - lastW) < 40) return;
      lastW = window.innerWidth;
      schedulePreview(400);
    });
    const dock = $('#dock');
    if (window.ResizeObserver && dock) {
      new ResizeObserver(() => D.documentElement.style.setProperty('--dock-h', dock.offsetHeight + 'px')).observe(dock);
    }
    SP.onVoicesChanged(checkTts);
  }

  function start(hotData) {
    // Türkçe büyük harf dönüşümü (i → İ) ve ekran okuyucular için.
    if (!D.documentElement.lang) D.documentElement.lang = 'tr';
    try { localStorage.setItem(STORE_KEY + ':t', '1'); localStorage.removeItem(STORE_KEY + ':t'); env.storeOk = true; } catch (_) { env.storeOk = false; }
    const stored = hotData && hotData.cv ? hotData : load();
    if (stored) {
      cv = sanitizeCv(stored.cv);
      settings = sanitizeSettings(stored.settings);
      const st = Number(stored.step) || 0;
      ui.resumeStep = Math.max(0, Math.min(LAST, st));
      ui.step = hotData && hotData.cv ? ui.resumeStep : 0;
    }
    rec.setLang(settings.speechLang);
    if (!IN_VIEWER) { try { history.replaceState({ step: ui.step }, ''); } catch (_) { /* ignore */ } }
    wire();
    renderAll();
    refreshTtsBtn();
    if (stored) setSaved(true);

    checkTts();
    env.sampleP.then((s) => {
      if (!s) return;
      env.sample = s;
      D.body.classList.add('has-ai');
      rerenderSoft();
    });
    env.downloadsP.then((d) => {
      env.dl = d || null;
      if (STEPS[ui.step].kind === 'preview') rerenderSoft();
      refreshDock();
    });
    // Önizleme kütüphanelerini ilk çizimden sonra yükle.
    setTimeout(() => { ensurePdfmake().catch(() => {}); ensurePdfjs().catch(() => {}); schedulePreview(0); }, 250);
  }

  // Test ve hata ayıklama için küçük bir kapı.
  window.CVApp = {
    get state() { return { cv, settings, ui, env, conv: { on: conv.on, mode: conv.mode, slot: conv.slot } }; },
    simulateFinal: (s) => onFinal(s, conv.slot),
    goStep, askSlot, startConvo, stopConvo, renderPreviews, slotsFor, nextSlot, isRefusal, mapChoice, gateAnswer,
    load: (data) => { cv = sanitizeCv(data); afterChange(); renderAll(); },
  };

  try { if (window.claude && window.claude.hot && window.claude.hot.snapshot) window.claude.hot.snapshot(() => ({ cv, settings, step: ui.step })); } catch (_) { /* ignore */ }
  const hot = window.claude && window.claude.hot;
  if (hot && typeof hot.ready === 'function') hot.ready(start);
  else start((hot && hot.data) || null);
})();
