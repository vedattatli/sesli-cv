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
  const TEMPLATE_HELP = {
    sade: 'Online başvurular ve CV tarama sistemleri (ATS) için en güvenli seçenek. Tek sütun, fotoğrafsız.',
    klasik: 'Kurumsal başvurular için ciddi ve düzenli bir görünüm. Okunması kolay, fotoğraf isteğe bağlı.',
    modern: 'Elden ya da e-postayla gönderim için renkli, dikkat çekici bir tasarım. Online formlarda Sade’yi tercih edin.',
  };

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
  env.inApp = /(FBAN|FBAV|Instagram|WhatsApp|Telegram|Line\/|Snapchat|TikTok|musical_ly|LinkedInApp|Twitter|Pinterest|; wv\))/i.test(UA);
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
  const blankProject = () => ({ id: uid(), name: '', tech: '', link: '', desc: '' });
  const blankCv = () => ({
    name: '', title: '', phone: '', email: '', city: '', web: '', github: '', photo: '', summary: '',
    jobs: [], edu: [], projects: [], skills: '', langs: '', certs: '', hobbies: '', refs: '',
    birth: '', military: '', license: '', marital: '',
  });
  // template is only used once templateChosen is true; until then the profile's default applies (tplId()).
  // sendTo: the answer to “CV’yi nereye göndereceksiniz?” ('' = not asked yet). showPhotoEn: photo in the English CV.
  const DEFAULTS = {
    template: 'klasik', accent: (PDF.ACCENTS && PDF.ACCENTS[0]) || '#1F5C4A', lang: 'tr', showPhoto: true,
    tts: true, autoNext: true, speechLang: 'tr-TR', bulletStyle: 'kisisel',
    templateChosen: false, sendTo: '', showPhotoEn: false,
  };

  let cv = blankCv();
  let settings = Object.assign({}, DEFAULTS);
  const ui = {
    step: 0, active: null, resumeStep: 0, confirmDelete: null, suggestions: {}, applied: {},
    gateOpen: {}, story: '', focusKey: null, popping: false, convoBeforePhoto: false,
    mode: 'steps', editDraft: '', lastReply: '', cvEn: null, cvEnFor: '', micPrimed: false,
    // interview v2 (transient): profile picker open, short-answer nudge, contact read-back, name fix form,
    // personal-card toggles, contact-skip warning, job count when “Önceki işiniz” started, the spoken
    // groups of a phone number still coming in
    pickProfile: false, nudge: null, readback: null, fixing: null, k2: {}, contactWarned: false, loopBase: 0, feedDirty: false, phoneDraft: '',
    // final-screen variants (persisted): tailored copy for one job ad and the cover letter
    tailored: null, letter: null,
    // final screen (persisted): dismissed CV Kontrolü items, the pasted job ad
    dismissed: [], adDraft: '',
    // final screen (transient): previewed variant, page counts per variant, open <details>, tool errors,
    // the check whose follow-up box is open ({id, question}), bullet-style change, restyle undo, cover target,
    // in-page confirmations (remove variant, rewrite letter, delete letter)
    view: 'master', pages: {}, open: {}, toolErr: {}, chkAsk: null, styleDirty: false, restyleUndo: null,
    coverTarget: null, coverReply: '', tailorConfirm: false, coverConfirm: false, letterConfirm: false,
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
      if (k === 'jobs' || k === 'edu' || k === 'projects' || k === 'photo') return;
      if (typeof raw[k] === 'string') out[k] = raw[k].slice(0, 8000);
    });
    if (typeof raw.photo === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(raw.photo) && raw.photo.length < 1.5e6) out.photo = raw.photo;
    if (Array.isArray(raw.jobs)) out.jobs = raw.jobs.slice(0, 30).map((j) => Object.assign(blankJob(), pickStrings(j, ['role', 'company', 'city', 'start', 'end', 'desc'])));
    if (Array.isArray(raw.edu)) out.edu = raw.edu.slice(0, 20).map((e) => Object.assign(blankEdu(), pickStrings(e, ['school', 'program', 'degree', 'start', 'end', 'note'])));
    if (Array.isArray(raw.projects)) out.projects = raw.projects.slice(0, 20).map((q) => Object.assign(blankProject(), pickStrings(q, ['name', 'tech', 'link', 'desc'])));
    return out;
  }
  function sanitizeSettings(raw) {
    const s = Object.assign({}, DEFAULTS);
    if (!raw || typeof raw !== 'object') return s;
    if (PDF.TEMPLATES.some((t) => t.id === raw.template)) s.template = raw.template;
    if (typeof raw.accent === 'string' && /^#[0-9a-f]{6}$/i.test(raw.accent)) s.accent = raw.accent;
    if (raw.lang === 'tr' || raw.lang === 'en') s.lang = raw.lang;
    if (raw.speechLang === 'tr-TR' || raw.speechLang === 'en-US') s.speechLang = raw.speechLang;
    ['showPhoto', 'tts', 'autoNext', 'showPhotoEn'].forEach((k) => { if (typeof raw[k] === 'boolean') s[k] = raw[k]; });
    if (raw.bulletStyle === 'kisisel' || raw.bulletStyle === 'resmi') s.bulletStyle = raw.bulletStyle;
    s.templateChosen = raw.templateChosen === true && s.template === raw.template;
    // v1 data has no templateChosen and its default was 'modern', so any other stored template was a pick.
    if (raw.templateChosen === undefined && s.template === raw.template && raw.template !== 'modern') s.templateChosen = true;
    if (raw.sendTo === 'upload' || raw.sendTo === 'email') s.sendTo = raw.sendTo;
    return s;
  }
  const strOf = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const strsOf = (v, max, n) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).slice(0, max).map((x) => x.slice(0, n)) : []);
  const pairsOf = (v, keys, max) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object').slice(0, max)
    .map((x) => { const o = {}; keys.forEach((k) => { o[k] = strOf(x[k], 300); }); return o; }).filter((o) => o[keys[0]]) : []);
  /** ui.tailored: a copy of the CV retargeted to one job ad (the master `cv` is never changed by it). */
  function sanitizeTailored(raw) {
    if (!raw || typeof raw !== 'object' || !raw.cv || typeof raw.cv !== 'object') return null;
    // answered: folded missing term → 'yes' (answered into the master CV) | 'no' (“Kullanmadım”)
    const answered = {};
    if (raw.answered && typeof raw.answered === 'object' && !Array.isArray(raw.answered)) {
      Object.keys(raw.answered).slice(0, 40).forEach((k) => { const v = raw.answered[k]; if (k.length <= 120 && (v === 'yes' || v === 'no')) answered[k] = v; });
    }
    // jobs: folded missing term → id of the extract job that carries the answer (to show “işlenemedi”)
    const jobs = {};
    if (raw.jobs && typeof raw.jobs === 'object' && !Array.isArray(raw.jobs)) {
      Object.keys(raw.jobs).forEach((k) => { if (answered[k] === 'yes' && typeof raw.jobs[k] === 'string') jobs[k] = raw.jobs[k].slice(0, 40); });
    }
    return {
      cv: sanitizeCv(raw.cv), company: strOf(raw.company, 200), role: strOf(raw.role, 200), adHash: strOf(raw.adHash, 100),
      at: Number(raw.at) || 0, ad: strOf(raw.ad, 10000),
      matched: pairsOf(raw.matched, ['term', 'where'], 30), missing: pairsOf(raw.missing, ['term', 'question'], 30), changes: strsOf(raw.changes, 30, 300),
      lang: raw.lang === 'en' ? 'en' : 'tr', baseHash: strOf(raw.baseHash, 100), answered, jobs,
    };
  }
  /** Dismissed CV Kontrolü items: ids only. */
  const sanitizeDismissed = (raw) => strsOf(raw, 200, 200);
  /** ui.letter: the cover letter as shown and edited on the final screen. */
  function sanitizeLetter(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {
      date: strOf(raw.date, 60), recipient: strsOf(raw.recipient, 6, 200), subject: strOf(raw.subject, 300), greeting: strOf(raw.greeting, 200),
      paragraphs: strsOf(raw.paragraphs, 8, 3000), closing: strOf(raw.closing, 300), name: strOf(raw.name, 200),
      company: strOf(raw.company, 200), role: strOf(raw.role, 200), target: strOf(raw.target, 200), ad: strOf(raw.ad, 10000),
      generic: !!raw.generic, at: Number(raw.at) || 0, lang: raw.lang === 'en' ? 'en' : 'tr',
    };
    return out.paragraphs.length || out.subject ? out : null;
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
        { key: 'github', type: 'url', label: 'GitHub', q: 'GitHub adresiniz nedir?', hint: 'Yazılımcıysanız ekleyin; yoksa “atla” deyin.', hintNoMic: 'Yazılımcıysanız ekleyin; yoksa boş bırakın.', ph: 'github.com/kullaniciadi', im: 'url', optional: true },
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
      id: 'projeler', kind: 'list', title: 'Projeler', listKey: 'projects', itemLabel: 'proje', blank: blankProject,
      gate: { q: 'Eklemek istediğiniz bir proje var mı?', hint: 'Okul, iş ya da kişisel projeler olabilir. “Evet” ya da “hayır” deyin.', hintNoMic: 'Okul, iş ya da kişisel projeler olabilir. ' + YESNO_HINT_NOMIC },
      more: { q: 'Başka bir proje eklemek ister misiniz?', hint: '“Evet” ya da “hayır” deyin.', hintNoMic: 'Eklemek için “Başka bir proje ekle”ye, bitirmek için İleri’ye dokunun.' },
      addLabel: 'Başka bir proje ekle', yes: 'Evet, ekleyelim', no: 'Hayır, geç',
      fields: [
        { key: 'name', type: 'title', label: 'Proje adı', q: 'Projenin adı ne?', ph: 'Örn. Depo Takip Sistemi' },
        { key: 'tech', type: 'list', label: 'Teknolojiler', q: 'Hangi teknolojileri kullandınız?', hint: 'Örneğin: Python, FastAPI, PostgreSQL.', ph: 'Örn. Python, FastAPI, PostgreSQL' },
        { key: 'link', type: 'url', label: 'Bağlantı', q: 'Projenin bir bağlantısı var mı?', hint: 'GitHub ya da web adresi. Yoksa “atla” deyin.', hintNoMic: 'GitHub ya da web adresi. Yoksa boş bırakın.', ph: 'github.com/kullanici/proje', im: 'url', optional: true },
        { key: 'desc', type: 'lines', label: 'Ne işe yarıyor, siz ne yaptınız?', q: 'Bu proje ne işe yarıyor ve siz neler yaptınız?', hint: 'Her duraklama yeni bir madde olur.', hintNoMic: 'Her maddeyi ayrı satıra yazın.', ph: 'Her satır bir madde olur', long: true, wide: true },
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
      const payload = {
        cv, settings, step: ui.step > 0 ? ui.step : ui.resumeStep, t: Date.now(), interview: iv, cvEn: ui.cvEn, cvEnFor: ui.cvEnFor,
        consent, tailored: ui.tailored, letter: ui.letter, dismissed: ui.dismissed, adDraft: ui.adDraft,
      };
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
    else if (code === 'silence') {
      stopConvo();
      if (ui.mode === 'talk') { const ds = $('#dock-status'); if (ds) ds.textContent = 'Mikrofon bekliyor. Devam etmek için mikrofona dokunun.'; }
      else toast('Bir süredir ses gelmedi, mikrofonu kapattım. Devam etmek için mikrofona dokunun.', 6000);
    }
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
    if (t && slot && slot.kind === 'answer') { const el = $('#answer-live'); if (el) el.textContent = t; }
    if (t && slot && slot.kind === 'contact') { const el = $('#k-phone-live'); if (el) el.textContent = t; }
    if (t && slot && slot.kind === 'draft') { const el = $$('.live[data-live]').find((x) => x.dataset.live === slot.key); if (el) el.textContent = t; }
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
    const kind = ui.mode === 'talk' ? 'talk' : STEPS[ui.step].kind;
    const sk = conv.slot && conv.slot.kind;
    let status = '';
    if (st === 'speaking') status = 'Soru okunuyor…';
    else if (st === 'listening') {
      if (sk === 'gate' || sk === 'more') status = 'Dinliyorum… “Evet” ya da “hayır” deyin.';
      else if (sk === 'review') status = 'Dinliyorum… Devam etmek için “devam” deyin.';
      else if (sk === 'photo') status = 'Dinliyorum… Fotoğraf seçin ya da “atla” deyin.';
      else if (sk === 'answer') status = 'Dinliyorum… Düşünmek için durabilirsiniz, acele yok. Bitince “bitti” deyin ya da Sıradaki’ye dokunun.';
      else if (sk === 'photo-talk') status = 'Dinliyorum… Fotoğraf seçin ya da “geç” deyin.';
      else if (sk === 'loop') status = 'Dinliyorum… “Evet” ya da “hayır” deyin.';
      else if (sk === 'contact') {
        status = activeReadback() ? 'Dinliyorum… “Doğru” ya da “düzelt” deyin.'
          : ui.phoneDraft ? 'Dinliyorum… Numaranın devamını söyleyin.' : 'Dinliyorum… Telefon numaranızı söyleyin; bitince “sonraki” deyin.';
      }
      else if (sk === 'personal') status = 'Dinliyorum… Eklemek istediklerinize dokunun ya da “sonraki” deyin.';
      else if (sk === 'edit') status = 'Dinliyorum… Ne değişsin söyleyin; bitince “bitti” deyin.';
      else if (sk === 'draft') status = 'Dinliyorum… Bitince “bitti” deyin ya da mikrofona dokunun.';
      else if (sk === 'test' || sk === 'story') status = 'Dinliyorum… Bitirince mikrofona dokunun.';
      else if (conv.mode === 'single') status = 'Dinliyorum… Sustuğunuzda mikrofon kapanır.';
      else if (settings.autoNext) status = 'Dinliyorum… Susunca sonraki soruya geçerim.';
      else status = 'Dinliyorum… Bitince “devam” deyin.';
    } else if (st === 'blocked') status = env.mic === 'unsupported' ? 'Bu tarayıcı sesli yanıtı desteklemiyor. ' + dictationHelp() : 'Mikrofon kapalı. ' + dictationHelp();
    else if (kind === 'photo') status = 'Fotoğraf seçin ya da İleri’ye dokunun.';
    else if (kind === 'preview') status = '';
    else if (kind === 'talk') status = talkGate() ? 'Ekrandaki seçeneklerden birine dokunun.' : 'Mikrofona dokunun ve anlatın. İsterseniz yazabilirsiniz de.';
    else status = 'Mikrofona dokunun; soruları sırayla soralım.';
    const ds = $('#dock-status');
    ds.setAttribute('aria-live', st === 'listening' || st === 'speaking' ? 'off' : 'polite');
    if (ds.textContent !== status) ds.textContent = status;
    $$('.field').forEach((el) => el.classList.toggle('is-listening', el.dataset.path
      ? !!(rec.wanted && conv.slot && conv.slot.path === el.dataset.path)
      : !!(rec.wanted && sk === 'contact' && el.dataset.kfield === 'phone')));
    const aw = $('.answer-wrap'); if (aw) aw.classList.toggle('is-listening', !!(rec.wanted && sk === 'answer'));
    $$('[data-fkey="edit-mic"]').forEach((b) => {
      const on = !!(rec.wanted && sk === 'edit');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      const use = b.querySelector('use'); if (use) use.setAttribute('href', on ? '#i-pause' : '#i-mic');
      const lbl = b.querySelector('.lbl'); if (lbl) lbl.textContent = on ? 'Durdur' : 'Söyle';
    });
    $$('.mic-sm').forEach((b) => {
      const on = b.classList.contains('k-mic') ? !!(rec.wanted && sk === 'contact')
        : b.dataset.draft ? !!(rec.wanted && sk === 'draft' && conv.slot.key === b.dataset.draft)
          : !!(rec.wanted && conv.slot && b.dataset.path && conv.slot.path === b.dataset.path);
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
  // `speaking` belongs to the newest speakNow: an older one that ends (or is cut off) never clears a newer
  // one's flag, and never leaves the flag set once nothing is speaking (critic C6: no stuck “Soru okunuyor…”).
  let speakSeq = 0;
  async function speakNow(text, my) {
    const sid = ++speakSeq;
    conv.speaking = true; refreshMicUi();
    try { await SP.speak(text, { lang: 'tr-TR' }); } finally { if (sid === speakSeq && conv.speaking) { conv.speaking = false; refreshMicUi(); } }
    return my === undefined || my === conv.token;
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
  /** Listen for a free-text slot (mic test, story, edit). Any question being read aloud is cut first (critic C6). */
  function listenFor(slot) {
    conv.on = false;
    conv.mode = 'single';
    conv.token++;
    SP.cancelSpeech();
    conv.speaking = false;
    cancelAdv();
    conv.slot = slot;
    rec.start(slot);
    refreshMicUi();
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
    if (slot.kind === 'draft') { onDraftFinal(seg, slot); return; }
    if (TALK_SLOTS[slot.kind]) { onTalkFinal(seg, slot, rec.wanted && slot === conv.slot); return; }
    if (slot.kind === 'edit') {
      const c = commandFor(seg);
      const live = rec.wanted && slot === conv.slot;
      const k = fk(seg);
      if (live && TALK_FILLER.test(k)) return; // “tamam” alone is thinking aloud, not “apply”
      if (live && (c === 'next' || isEndWord(k))) { stopConvo(); doEdit(); return; }
      if (live && c === 'stop') { stopConvo(); renderAll(); return; }
      if (live && c === 'clear') { ui.editDraft = ''; const t0 = $('#edit-req'); if (t0) t0.value = ''; return; }
      ui.editDraft = (ui.editDraft ? ui.editDraft.trim() + ' ' : '') + seg;
      const ta = $('#edit-req'); if (ta) ta.value = ui.editDraft;
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
    if (ui.mode === 'talk') leaveTalk();
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

  function renderTalkAll() {
    const working = iv.phase === 'waiting' || iv.phase === 'finalizing' || aiState.status === 'code';
    D.body.dataset.kind = 'talk';
    D.body.dataset.step = 'talk';
    D.body.dataset.working = working ? '1' : '';
    D.body.dataset.gate = talkGate() ? '1' : '';
    keepFocus(() => $('#step').replaceChildren(renderTalk()));
    renderFeed();
    refreshRail();
    refreshProgress();
    refreshDock();
    refreshMicUi();
    schedulePreview(120);
  }
  function renderAll() {
    if (ui.mode === 'talk') { renderTalkAll(); return; }
    D.body.dataset.working = '';
    D.body.dataset.gate = '';
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
    dropOrphanDraftMic();
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
    if (ui.mode === 'talk') {
      ol.replaceChildren(...TOPICS.map((t, i) => h('li', { class: (iv.phase === 'topics' && i === iv.idx ? 'current ' : '') + (topicDone(t) ? 'done' : '') },
        h('button', { type: 'button', 'aria-current': iv.phase === 'topics' && i === iv.idx ? 'step' : null, onclick: () => talkGoto(i) }, t.label))));
      return;
    }
    ol.replaceChildren(...STEPS.map((s, i) => h('li', { class: (i === ui.step ? 'current ' : '') + (stepHasContent(i) ? 'done' : '') },
      h('button', { type: 'button', 'aria-current': i === ui.step ? 'step' : null, onclick: () => goStep(i) }, s.title))));
  }
  function refreshProgress() {
    const pt = $('#progress-text');
    if (ui.mode === 'talk') {
      // Counts spoken questions only (“Soru 3 / 7”); the tap cards show their name.
      const bar = $('#progress-bar');
      if (talkGate()) { pt.textContent = 'Başlangıç'; bar.style.width = '0%'; return; }
      if (iv.phase === 'followups') {
        pt.replaceChildren('Eksik bilgi ' + Math.min(iv.fIdx + 1, iv.followups.length) + ' / ' + iv.followups.length);
        bar.style.width = '100%';
        return;
      }
      if (iv.phase !== 'topics') { pt.textContent = 'Son düzenleme'; bar.style.width = '100%'; return; }
      const t = TOPICS[iv.idx];
      if (!t) return;
      if (t.kind) pt.replaceChildren(t.label);
      else pt.replaceChildren('Soru ' + spokenPos(iv.idx) + ' / ' + spokenTotal(), h('span', { class: 'long' }, ' · ' + t.label));
      bar.style.width = Math.round((iv.idx / TOPICS.length) * 100) + '%';
      return;
    }
    const s = STEPS[ui.step];
    if (ui.step === 0) pt.textContent = '';
    else pt.replaceChildren(ui.step + ' / ' + LAST, h('span', { class: 'long' }, ' · ' + s.title));
    $('#progress-bar').style.width = Math.round((ui.step / LAST) * 100) + '%';
  }
  function refreshDock() {
    const s = STEPS[ui.step];
    const back = $('#btn-back');
    const next = $('#btn-next');
    if (ui.mode === 'talk') {
      const working = iv.phase === 'waiting' || iv.phase === 'finalizing' || aiState.status === 'code';
      back.disabled = working;
      next.disabled = working || !!talkGate();
      const lastQ = iv.phase === 'followups' ? iv.fIdx >= iv.followups.length - 1 : iv.idx >= TOPICS.length - 1;
      next.replaceChildren(lastQ ? 'Bitir' : 'Sıradaki', icon('right'));
      return;
    }
    back.disabled = ui.step <= 1;
    next.disabled = false;
    if (s.kind === 'preview') {
      // the dock downloads whatever is previewed: say so when that is the tailored copy
      next.replaceChildren(icon('download'), previewView() === 'tailored' ? 'Uyarlanmışı indir' : 'PDF indir');
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
    if (ui.mode === 'talk') return; // the interview renders its own question
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
  // The invite code (#k=…) was saved and taken out of the address bar on arrival (ai.js), so a link to
  // Chrome carries it again; otherwise a closed-test invitee would land in Chrome without a code.
  const inviteCode = () => { try { return String((window.CVAI && window.CVAI.getCode && window.CVAI.getCode()) || '').trim(); } catch (_) { return ''; } };
  /** This page's address for another browser: the hash form (#k=) keeps the code out of server logs. */
  function shareUrl() {
    const base = location.href.replace(/#.*$/, '');
    const code = inviteCode();
    return code ? base + '#k=' + encodeURIComponent(code) : base;
  }
  function chromeIntentUrl() {
    // An intent URL's fragment holds the intent itself, so the code rides in the query (?k=), which
    // ai.js also reads and removes from the address bar.
    const code = inviteCode();
    let u = location.href.replace(/^https?:\/\//, '').replace(/#.*$/, '');
    if (code) u += (u.indexOf('?') >= 0 ? '&' : '?') + 'k=' + encodeURIComponent(code);
    return 'intent://' + u + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(shareUrl()) + ';end';
  }
  async function copyLink(btn) {
    const url = shareUrl();
    try { await navigator.clipboard.writeText(url); btn.textContent = 'Kopyalandı'; toast('Link kopyalandı. Chrome’u açıp adres çubuğuna yapıştırın.', 5000); }
    catch (_) { toast('Kopyalanamadı. Adres: ' + url, 8000); }
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
    const main = s.listKey === 'jobs' ? (it.role || it.company) : s.listKey === 'projects' ? it.name : (it.school || it.program);
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
              listenFor({ kind: 'test', step: 0 }); rerenderSoft();
            },
          }, icon(testing ? 'pause' : 'mic'), testing ? 'Durdur' : 'Mikrofonu dene'),
          h('span', { class: 'heard', id: 'heard' }, testing ? 'Bir şey söyleyin…' : '')));
    })();

    const optRows = h('div', { class: 'opts' },
      switchRow('opt-tts', 'Soruları sesli oku', env.ttsVoice === false ? 'Bu cihazda Türkçe ses bulunamadı; sorular yalnızca yazılı görünür.' : 'Her soru ekranda yazar ve sesli okunur.', ttsOn(), (v) => { settings.tts = v; save(); refreshTtsBtn(); }, env.ttsVoice === false),
      micUsable() ? autoNextRow('opt-auto') : null);

    const story = env.sample ? h('div', { class: 'ai-card' },
      h('h3', null, 'İsterseniz hepsini tek seferde anlatın'),
      h('p', null, 'Kendinizi baştan sona anlatın: adınız, iletişim bilgileriniz, çalıştığınız yerler, okulunuz, yetenekleriniz. Yapay zekâ alanları doldursun, siz kontrol edin.'),
      h('textarea', { id: 'story', class: 'input', rows: 5, value: ui.story, oninput: (e) => { ui.story = e.target.value; }, 'aria-label': 'Kendinizi anlatın', placeholder: 'Örn. Adım Ayşe Yılmaz, İzmir’de yaşıyorum. 2019’dan beri Kuzey Lojistik’te muhasebe uzmanı olarak çalışıyorum…' }),
      h('div', { class: 'btn-row' },
        micUsable() ? h('button', {
          type: 'button', class: 'btn small', dataset: { fkey: 'btn-story-mic' }, onclick: () => {
            if (rec.wanted && conv.slot && conv.slot.kind === 'story') { stopConvo(); return; }
            listenFor({ kind: 'story', step: 0 });
          },
        }, icon('mic'), 'Konuşarak anlat') : null,
        h('button', { type: 'button', class: 'btn small primary', id: 'btn-story', onclick: fillFromStory }, icon('wand'), 'Alanları doldur')),
      h('p', { class: 'mini-note', id: 'story-status' })) : null;

    return h('section', { class: 'intro', 'aria-labelledby': 'hero' },
      // In-app and Mi browsers first (critic C11): switching later would lose the answers given here.
      chromeBanner(),
      h('div', { class: 'q-wrap' },
        h('p', { class: 'eyebrow' }, 'Konuşarak CV hazırlayın'),
        h('h1', { class: 'hero', id: 'hero' }, 'Sorular gelsin, ', h('em', null, 'siz anlatın.')),
        h('p', { class: 'lead' }, aiOk()
          ? 'Birkaç soru soracağız; her birini konuşur gibi, tek seferde anlatın. Yapay zekâ söylediklerinizden profesyonel bir CV yazar, siz de PDF olarak indirirsiniz.'
          : 'Size sırayla sorular soracağız. Yanıtları sesli verin, yazıya biz çevirelim. Sonunda CV’niz PDF olarak hazır.')),
      aiState.status === 'code' ? accessCard() : null,
      (hasDraft || iv.started) ? h('div', { class: 'resume' },
        h('p', null, h('b', null, iv.started && !iv.finalized ? 'Yarım kalan görüşmeniz var' : 'Kayıtlı CV’niz var'), cv.name ? ' · ' + cv.name : ''),
        iv.started && !iv.finalized && aiOk()
          ? h('button', { type: 'button', class: 'btn small primary', dataset: { fkey: 'resume' }, onclick: () => startTalk(true) }, 'Görüşmeye devam et')
          : h('button', { type: 'button', class: 'btn small primary', dataset: { fkey: 'resume' }, onclick: () => goStep(iv.finalized ? LAST : (ui.resumeStep > 0 ? ui.resumeStep : 1)) }, iv.finalized ? 'CV’mi aç' : 'Kaldığım yerden devam et'),
        h('button', { type: 'button', class: 'btn small', onclick: () => openSettings(true) }, 'Yeni CV başlat')) : null,
      (hasDraft || iv.started) ? null : h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn primary', id: 'btn-start', style: { minHeight: '56px', padding: '0 28px', fontSize: '17px' }, onclick: onStart }, aiOk() ? 'Konuşarak başla' : 'Başlayalım', icon('right')),
        aiOk() ? h('button', { type: 'button', class: 'btn', onclick: () => goStep(1) }, 'Elle doldur') : null),
      aiOk() ? h('ol', { class: 'how' },
        h('li', null, h('b', null, 'Soruyu dinleyin'), h('span', null, 'Her soruda neleri anlatabileceğiniz ekranda yazar.')),
        h('li', null, h('b', null, 'Konuşur gibi anlatın'), h('span', null, 'Tek tek alan doldurmazsınız. Şirketi, tarihleri, yaptıklarınızı aynı cümlede söyleyebilirsiniz.')),
        h('li', null, h('b', null, 'CV’niz yazılır'), h('span', null, 'Yapay zekâ anlattıklarınızı düzenler. Siz kontrol eder, PDF’i indirirsiniz.')))
        : h('ol', { class: 'how' },
          h('li', null, h('b', null, 'Soruyu dinleyin'), h('span', null, 'Her soru ekranda yazılı görünür ve sesli okunur.')),
          h('li', null, h('b', null, 'Konuşarak yanıtlayın'), h('span', null, 'Mikrofona dokunun ve söyleyin. İsterseniz yazarak da doldurabilirsiniz.')),
          h('li', null, h('b', null, 'PDF’inizi alın'), h('span', null, 'Şablonu ve rengi seçin; indirin ya da paylaşın.'))),
      micBlock,
      optRows,
      aiState.status === 'off' && !IN_VIEWER ? h('p', { class: 'fine' }, 'Yapay zekâ şu an kullanılamıyor (' + (aiState.msg || 'bağlantı yok') + '). Soruları tek tek yanıtlayarak doldurabilirsiniz.') : null,
      story,
      micUsable() ? h('details', { class: 'more' },
        h('summary', null, 'Sesli komutlar'),
        voiceHelp()) : null,
      h('div', { class: 'btn-row' },
        h('label', { class: 'btn small' }, icon('upload'), 'Yedekten yükle',
          h('input', { type: 'file', class: 'sr', accept: 'application/json,.json', onchange: importJson }))),
      h('p', { class: 'fine' }, privacyLine()));
  }
  // "e-posta" must not wrap at its hyphen in the large serif headings (U+2011 is a non-breaking hyphen).
  const noBreakHyphen = (text) => String(text || '').replace(/(\S)-(?=\S)/g, '$1\u2011');
  /** What leaves the device and what does not (brief §6.3). Keep it exactly this narrow. */
  function privacyLine() {
    return (env.storeOk
      ? 'Taslağınız yalnızca bu cihazda, bu tarayıcıda saklanır. '
      : 'Bu tarayıcı taslağı saklayamıyor; bitirince PDF’i indirmeyi unutmayın. ') +
      'Konuşmanız tarayıcınızın ses tanıma hizmetiyle yazıya çevrilir (Chrome’da Google, iPhone’da Apple).' +
      (aiOk() && !IN_VIEWER
        ? ' Konuşarak doldurursanız yazıya dönen cevaplarınız, CV’nizi yazmak için yurt dışındaki bir yapay zekâ hizmetine (Anthropic Claude) gönderilir; ' +
          'telefonunuz, e-postanız ve fotoğrafınız gönderilmez ve sunucumuzda hiçbir şey saklanmaz. ' +
          'Elle doldurursanız, son ekrandaki yapay zekâ araçlarını (çeviri, değişiklik, ilana uyarlama, ön yazı) kullanmadıkça hiçbir şey gönderilmez; ' +
          'kullanırsanız CV’nizin metni gönderilir.'
        : '');
  }
  /**
   * “Susunca sonraki soruya geç” only steers the step-by-step questions. In the talk interview silence never
   * ends an answer (brief §6.2.2), so there the row explains the real rule instead of offering a switch.
   */
  function autoNextRow(id) {
    const talkRule = 'Konuşarak görüşmede susmak cevabı bitirmez: “bitti” deyin ya da Sıradaki’ye dokunun.';
    if (ui.mode === 'talk') {
      return h('div', { class: 'opt-row' }, h('span', null, 'Cevap ne zaman biter?', h('small', null, talkRule)));
    }
    const ai = aiOk() && !IN_VIEWER;
    return switchRow(id, ai ? 'Elle doldururken susunca sonraki soruya geç' : 'Susunca sonraki soruya geç',
      'Kapalıysa “devam” deyin ya da İleri’ye dokunun.' + (ai ? ' Konuşarak görüşmede ise susmak cevabı bitirmez.' : ''),
      settings.autoNext, (v) => { settings.autoNext = v; save(); refreshMicUi(); });
  }
  function voiceHelp() {
    return h('div', { class: 'fine voice-help' },
      h('p', null, 'Konuşarak görüşmede: ', say('bitti'), ' ya da ', say('sonraki'), ' cevabı bitirir. ', say('Tamam'), ' demek cevabı bitirmez; düşünürken rahatça söyleyebilirsiniz. ',
        say('geç'), ' soruyu atlar, ', say('geri'), ' önceki soruya döner, ', say('geri al'), ' son söylediğinizi siler, ', say('tekrar oku'), ' soruyu yeniden okur, ', say('dur'), ' mikrofonu kapatır.'),
      h('p', null, 'Soruları tek tek yanıtlarken: ', say('devam'), ' sonraki soru, ', say('atla'), ' boş geç, ', say('sil'), ' alanı temizle.'));
  }
  function switchRow(id, label, sub, checked, onChange, disabled) {
    return h('div', { class: 'opt-row' },
      h('label', { for: id }, label, sub ? h('small', null, sub) : null),
      h('span', { class: 'switch' },
        h('input', { type: 'checkbox', id, role: 'switch', checked: !!checked, disabled: !!disabled, dataset: { fkey: id }, onchange: (e) => onChange(e.target.checked) }),
        h('span', null)));
  }
  function onStart() {
    if (rec.wanted) stopConvo();
    if (aiOk() && !IN_VIEWER) { if (!iv.started) setIv(blankInterview()); startTalk(); return; }
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
    return h('section', { class: 'step', 'aria-labelledby': 'question' },
      questionHead(s), voiceBanner(), photoPanel());
  }
  function photoPanel() {
    const pick = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) openCrop(f); };
    const camLabel = env.touch ? h('label', { class: 'btn primary' }, icon('camera'), 'Fotoğraf çek',
      h('input', { type: 'file', accept: 'image/*', capture: 'user', class: 'sr', onchange: pick })) : null;
    const fileLabel = h('label', { class: 'btn' + (env.touch ? '' : ' primary') }, icon('upload'), env.touch ? 'Galeriden seç' : 'Fotoğraf seç',
      h('input', { type: 'file', accept: 'image/*', class: 'sr', onchange: pick }));
    const pickers = h('div', { class: 'btn-row' }, camLabel, fileLabel);
    let body;
    if (crop) {
      body = h('div', { class: 'crop', id: 'crop' },
        h('canvas', { id: 'crop-canvas', width: CROP_W, height: CROP_H, tabindex: '0', role: 'img', 'aria-label': 'Fotoğraf konumu: sürükleyin ya da ok tuşlarını kullanın' }),
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
        h('div', null, env.touch ? 'Bir fotoğraf çekin ya da galeriden seçin. En iyisi birinden çekmesini istemek.' : 'Fotoğrafı buraya sürükleyin ya da seçin.'),
        pickers);
    }
    const sec = h('div', { class: 'photo-wrap' }, h('div', { class: 'photo-box' }, body),
      h('p', { class: 'fine' }, 'Fotoğraf yalnızca bu cihazda işlenir; yapay zekâya gönderilmez. Sade şablonda fotoğraf kullanılmaz.'));
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
  // Vesikalık frame (brief §2.3 K3, critic C2): 3:4, saved as 600×800 JPEG. Modern derives its round crop from the centre.
  const CROP_W = 600;
  const CROP_H = 800;
  function cropScale() { return Math.max(CROP_W / crop.img.naturalWidth, CROP_H / crop.img.naturalHeight) * crop.zoom; }
  function clampCrop() {
    const sc = cropScale();
    const w = crop.img.naturalWidth * sc; const hgt = crop.img.naturalHeight * sc;
    const mx = Math.max(0, (w - CROP_W) / 2); const my = Math.max(0, (hgt - CROP_H) / 2);
    crop.x = Math.max(-mx, Math.min(mx, crop.x));
    crop.y = Math.max(-my, Math.min(my, crop.y));
  }
  function paintCrop(ctx, guide) {
    const sc = cropScale();
    const w = crop.img.naturalWidth * sc; const hgt = crop.img.naturalHeight * sc;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CROP_W, CROP_H);
    ctx.drawImage(crop.img, (CROP_W - w) / 2 + crop.x, (CROP_H - hgt) / 2 + crop.y, w, hgt);
    if (guide) {
      // Where the face should sit in a passport-style photo: a dashed oval in the upper middle.
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 3; ctx.setLineDash([10, 8]);
      ctx.beginPath(); ctx.ellipse(CROP_W / 2, CROP_H * 0.4, CROP_W * 0.3, CROP_H * 0.27, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath(); ctx.ellipse(CROP_W / 2, CROP_H * 0.4, CROP_W * 0.3 + 2.5, CROP_H * 0.27 + 2.5, 0, 0, Math.PI * 2); ctx.stroke();
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
      const k = CROP_W / c.getBoundingClientRect().width;
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
    c.width = CROP_W; c.height = CROP_H;
    paintCrop(c.getContext('2d'), false);
    cv.photo = c.toDataURL('image/jpeg', 0.85);
    try { URL.revokeObjectURL(crop.url); } catch (_) { /* ignore */ }
    crop = null;
    afterChange();
    renderAll();
    toast('Fotoğraf eklendi.');
    if (ui.mode === 'talk') {
      if (ui.convoBeforePhoto) { ui.convoBeforePhoto = false; conv.on = true; conv.mode = 'talk'; }
      return;
    }
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
  // The final screen: download first, then CV Kontrolü, then look (template, colour, language), then the AI
  // tools (edit, bullet style) and the application tools (tailor to an ad, cover letter), then the rest.
  function renderPreviewStep(s) {
    const tl = previewView() === 'tailored';
    return h('section', { class: 'final', 'aria-labelledby': 'question' },
      questionHead(s),
      h('div', { class: 'final-grid' },
        h('div', { class: 'final-controls', id: 'final-controls' }, finalControlKids()),
        h('div', { class: 'big-pages' },
          h('div', { class: 'pv-head' }, h('span', null, tl ? 'Önizleme · ' + tailoredLabel(ui.tailored) : 'Önizleme'),
            h('span', { class: 'badge', id: 'pv-big-badge', hidden: PDF.hasContent(cv) }, 'Örnek CV')),
          viewToggle(),
          h('div', { class: 'pages', id: 'pv-big' }, h('div', { class: 'pv-empty' }, 'Önizleme hazırlanıyor…')))));
  }
  /** Rebuilds only the controls column (keeps the rendered PDF preview; no new preview is drawn). */
  function renderFinalTools() {
    const box = $('#final-controls');
    if (!box || ui.mode === 'talk' || STEPS[ui.step].kind !== 'preview') return;
    keepFocus(() => box.replaceChildren(...finalControlKids()));
    refreshDock();
    dropOrphanDraftMic();
    refreshMicUi();
  }
  /** A text box's mic stops once its box is gone (answered, “Kullanmadım”, closed, variant removed). */
  function dropOrphanDraftMic() {
    const sl = conv.slot;
    if (!rec.wanted || !sl || sl.kind !== 'draft') return;
    if (!$$('textarea[data-draft]').some((x) => x.dataset.draft === sl.key)) stopConvo();
  }
  function finalControlKids() {
    return [
      downloadBlock(),
      h('div', { id: 'final-queue', class: 'final-queue', 'aria-live': 'polite' }, queueNoteKids()),
      checkCard(),
      lookGroup(),
      aiGroup(),
      applyGroup(),
      moreGroup(),
    ].filter(Boolean);
  }
  function downloadBlock() {
    const notice = downloadNotice();
    const has = PDF.hasContent(cv);
    const tl = previewView() === 'tailored';
    return h('div', { class: 'ctl dl-block' },
      notice,
      notice ? null : h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn primary big', id: 'btn-pdf', onclick: () => downloadPdf() }, icon('download'), tl ? 'Uyarlanmış CV’yi indir' : 'PDF olarak indir'),
        env.canShareFiles ? h('button', { type: 'button', class: 'btn', onclick: () => sharePdf() }, icon('share'), 'Paylaş') : null),
      h('p', { class: 'mini-note', id: 'pdf-status' }, has ? 'Dosya adı: ' + (tl ? tailoredFileName() : PDF.fileName(cv)) : 'Henüz bilgi girilmedi; önizlemedeki CV bir örnektir.'));
  }
  /** “Asıl CV | Kuzey Lojistik için”: which variant is previewed and downloaded. */
  function viewToggle() {
    if (!ui.tailored || !PDF.hasContent(cv)) return null;
    const tl = previewView() === 'tailored';
    const pick = (v) => { if (ui.view === v) return; ui.view = v; renderAll(); };
    return h('div', { class: 'seg two view-seg', role: 'group', 'aria-label': 'Önizlenen CV' },
      h('button', { type: 'button', 'aria-pressed': tl ? 'false' : 'true', dataset: { fkey: 'view-master' }, onclick: () => pick('master') }, 'Asıl CV'),
      h('button', { type: 'button', 'aria-pressed': tl ? 'true' : 'false', dataset: { fkey: 'view-tailored' }, onclick: () => pick('tailored') }, tailoredLabel(ui.tailored) + ' için'));
  }
  function lookGroup() {
    const id = tplId();
    const tpl = PDF.TEMPLATES.find((t) => t.id === id) || PDF.TEMPLATES[0];
    const en = settings.lang === 'en';
    const setLang = (l) => { if (settings.lang === l) return; settings.lang = l; save(); renderAll(); };
    return h('div', { class: 'tool-group' },
      h('h2', { class: 'group-title' }, 'Görünüm'),
      sendToAsk(),
      h('div', { class: 'ctl' }, h('h3', null, 'Şablon'),
        h('div', { class: 'tpls' }, PDF.TEMPLATES.map((t) => h('button', {
          type: 'button', class: 'tpl', 'aria-pressed': t.id === id ? 'true' : 'false', dataset: { fkey: 'tpl-' + t.id },
          onclick: () => { settings.template = t.id; settings.templateChosen = true; save(); renderAll(); },
        }, tplThumb(t.id, settings.accent), t.tr))),
        h('p', { class: 'tpl-desc' }, tplDesc(tpl)),
        settings.templateChosen ? null : h('p', { class: 'mini-note' }, en ? 'İngilizce CV için önerilen şablon.' : 'Profilinize göre önerilen şablon. Başka birine dokunarak değiştirebilirsiniz.')),
      h('div', { class: 'ctl' }, h('h3', null, 'Renk'),
        h('div', { class: 'swatches', role: 'group', 'aria-label': 'Renk' }, PDF.ACCENTS.map((c, i) => h('button', {
          type: 'button', class: 'swatch', style: { background: c }, 'aria-label': ACCENT_NAMES[i] || 'Renk ' + (i + 1), title: ACCENT_NAMES[i] || '',
          'aria-pressed': c.toLowerCase() === settings.accent.toLowerCase() ? 'true' : 'false', dataset: { fkey: 'sw-' + i },
          onclick: () => { settings.accent = c; save(); renderAll(); },
        })))),
      tpl && tpl.photo && cv.photo ? switchRow('opt-photo', 'Fotoğrafı göster', en ? 'İngilizce CV’lerde genelde fotoğraf olmaz; bu yüzden kapalı başlar.' : '', photoOn(), (v) => {
        if (settings.lang === 'en') settings.showPhotoEn = v; else settings.showPhoto = v;
        save(); schedulePreview(50);
      }) : null,
      h('div', { class: 'ctl' }, h('h3', null, 'CV dili'),
        h('div', { class: 'seg', role: 'group', 'aria-label': 'CV dili' },
          h('button', { type: 'button', 'aria-pressed': en ? 'false' : 'true', dataset: { fkey: 'lang-tr' }, onclick: () => setLang('tr') }, 'Türkçe'),
          h('button', { type: 'button', 'aria-pressed': en ? 'true' : 'false', dataset: { fkey: 'lang-en' }, onclick: () => setLang('en') }, 'English')),
        en ? h('p', { class: 'mini-note' }, 'Bölüm başlıkları ve tarihler İngilizce yazılır. İngilizce CV’de doğum yılı, askerlik ve medeni durum yer almaz; fotoğraf kapalı başlar.') : null,
        en && id !== 'sade' && PDF.TEMPLATES.some((t) => t.id === 'sade') ? h('div', { class: 'soft-row' },
          h('span', { class: 'mini-note' }, 'İngilizce başvurularda Sade şablonu önerilir.'),
          h('button', { type: 'button', class: 'btn small', onclick: () => { settings.template = 'sade'; settings.templateChosen = true; save(); renderAll(); } }, 'Sade’yi kullan')) : null),
      englishCard());
  }
  /** Asked once (brief §4.3): the answer picks the template. */
  function sendToAsk() {
    if (settings.sendTo || settings.templateChosen || !PDF.hasContent(cv)) return null;
    return h('div', { class: 'ctl ask-once' }, h('h3', null, 'CV’yi nereye göndereceksiniz?'),
      h('div', { class: 'chips', role: 'group', 'aria-label': 'CV’yi nereye göndereceksiniz?' },
        h('button', { type: 'button', class: 'chip big', dataset: { fkey: 'send-upload' }, onclick: () => chooseSendTo('upload') }, 'İlan sitesine yükleyeceğim'),
        h('button', { type: 'button', class: 'chip big', dataset: { fkey: 'send-email' }, onclick: () => chooseSendTo('email') }, 'E-postayla ya da elden')),
      h('p', { class: 'mini-note' }, 'Şablonu buna göre seçerim; sonra değiştirebilirsiniz.'));
  }
  function chooseSendTo(v) {
    const id = v === 'upload' ? 'sade' : 'klasik';
    settings.sendTo = v;
    if (PDF.TEMPLATES.some((t) => t.id === id)) { settings.template = id; settings.templateChosen = true; }
    save();
    renderAll();
    toast(v === 'upload' ? 'Sade şablonu seçtim: ilan sitelerindeki CV tarama sistemleri en kolay bunu okur.' : 'Klasik şablonu seçtim: e-posta ve çıktı için ciddi bir görünüm.', 5000);
  }
  function aiGroup() {
    if (IN_VIEWER || aiState.status === 'off') return null;
    if (aiState.status === 'code') return h('div', { class: 'tool-group' }, h('h2', { class: 'group-title' }, 'Yapay zekâ ile düzenleyin'), h('div', { class: 'ctl ai-edit' }, accessCard()));
    return h('div', { class: 'tool-group' },
      h('h2', { class: 'group-title' }, 'Yapay zekâ ile düzenleyin'),
      aiEditCard(),
      PDF.hasContent(cv) ? styleCard() : null);
  }
  function applyGroup() {
    if (!PDF.hasContent(cv)) return null;
    const avail = aiAvail() && aiState.status !== 'code';
    if (!avail && !ui.tailored && !ui.letter) return null;
    return h('div', { class: 'tool-group' },
      h('h2', { class: 'group-title' }, 'Başvuru'),
      h('p', { class: 'mini-note' }, 'Bir ilana başvururken CV’nizi o ilana göre sıralayın ve bir ön yazı hazırlayın. Asıl CV’niz değişmez.'),
      avail || ui.tailored ? tailorCard() : null,
      avail || ui.letter ? coverCard() : null);
  }
  function moreGroup() {
    return h('div', { class: 'tool-group' },
      h('div', { class: 'btn-row' },
        iv.started && aiOk() ? h('button', { type: 'button', class: 'btn small', onclick: () => { iv.phase = 'topics'; startTalk(true); } }, icon('mic'), 'Görüşmeye dön') : null,
        h('button', { type: 'button', class: 'btn small', onclick: () => goStep(1) }, icon('file'), 'Elle düzenle'),
        PDF.hasContent(cv) ? h('button', { type: 'button', class: 'btn small', onclick: openCopySheet }, icon('doc'), 'Metin olarak kopyala') : null),
      h('details', { class: 'more' },
        h('summary', null, 'Yedekle ve yükle'),
        h('p', { class: 'fine' }, 'Bilgilerinizi bir dosyaya kaydedip başka bir cihazda ya da daha sonra yükleyebilirsiniz.'),
        h('div', { class: 'btn-row', style: { marginTop: '10px' } },
          env.noDownload ? null : h('button', { type: 'button', class: 'btn small', onclick: exportJson }, icon('file'), 'Yedek dosyası indir'),
          h('label', { class: 'btn small' }, icon('upload'), 'Yedekten yükle',
            h('input', { type: 'file', class: 'sr', accept: 'application/json,.json', onchange: importJson })))));
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
        // Centre-crop a square (3:4 vesikalık or older square photos alike) instead of stretching.
        const iw = img.naturalWidth || img.width; const ih = img.naturalHeight || img.height;
        const side = Math.min(iw, ih);
        x.beginPath(); x.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); x.closePath(); x.clip();
        x.drawImage(img, (iw - side) / 2, (ih - side) / 2, side, side, 0, 0, S, S);
        const out = c.toDataURL('image/png');
        roundCache = { src, out };
        resolve(out);
      };
      img.onerror = () => resolve('');
      img.src = src;
    });
  }
  async function pdfOpts(data) {
    const show = photoOn();
    return {
      template: tplId(), accent: settings.accent, lang: settings.lang, showPhoto: show,
      photoRound: show && data.photo ? await roundPhoto(data.photo) : '',
      profile: iv.profile || 'deneyimli', refsLine: settings.lang === 'tr', sidebar: 'light',
    };
  }
  /** The template in use: the person's pick, or the profile's default until they pick one (brief §4). */
  function tplId() {
    const ids = PDF.TEMPLATES.map((t) => t.id);
    if (settings.templateChosen && ids.includes(settings.template)) return settings.template;
    let d = 'klasik';
    if (typeof PDF.defaultTemplate === 'function') {
      try { d = PDF.defaultTemplate(iv.profile || 'deneyimli', { lang: settings.lang }) || d; } catch (_) { d = 'klasik'; }
    }
    return ids.includes(d) ? d : ids.includes('klasik') ? 'klasik' : ids[0];
  }
  const tplDesc = (t) => (t && typeof t.desc === 'string' && t.desc) || (t && TEMPLATE_HELP[t.id]) || '';
  /** English CVs start without a photo (brief §5.2 #5); each language keeps its own switch. */
  const photoOn = () => (settings.lang === 'en' ? settings.showPhotoEn : settings.showPhoto);
  const sampleCv = () => (PDF.SAMPLES && PDF.SAMPLES[iv.profile]) || PDF.SAMPLE;
  /** Which variant the final screen previews and downloads. Elsewhere it is always the master CV. */
  const previewView = () => (ui.view === 'tailored' && ui.tailored && ui.mode !== 'talk' && STEPS[ui.step].kind === 'preview' ? 'tailored' : 'master');
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
      const view = previewView();
      const data = sample ? sampleCv() : view === 'tailored' ? variantCv() : pdfCv();
      const dd = PDF.build(data, await pdfOpts(data));
      const buf = await pdfBuffer(dd);
      if (my !== pv.gen) return;
      const pdf = await window.pdfjsLib.getDocument({ data: buf, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
      if (!sample) notePages(view, pdf.numPages);
      for (const t of targets) { if (my !== pv.gen) break; await drawPdf(pdf, t, my); }
      try { pdf.destroy(); } catch (_) { /* ignore */ }
      const badge = $('#pv-badge'); if (badge) { badge.textContent = 'Örnek CV'; badge.hidden = !sample; }
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
  /** which: 'master' | 'tailored'; by default the variant the final screen shows. */
  async function buildCurrentPdf(which) {
    await ensurePdfmake();
    const tl = (which || previewView()) === 'tailored' && !!ui.tailored;
    const data = tl ? variantCv() : pdfCv();
    const dd = PDF.build(data, await pdfOpts(data));
    return { dd, name: tl ? tailoredFileName() : PDF.fileName(cv) };
  }
  const noDownloadMsg = () => (env.android ? 'Bu uygulamanın tarayıcısı dosya indiremiyor. Sayfayı Chrome’da açın.' : 'Bu uygulamanın tarayıcısı dosya indiremiyor. Sayfayı Safari’de açın.');
  /** Hands a finished PDF to the viewer's download capability or the browser. */
  async function saveDoc(dd, name) {
    const dl = await env.downloadsP;
    if (dl) {
      const blob = await pdfBlob(dd);
      try { await dl.save({ filename: name, data: blob }); toast('PDF kaydedildi: ' + name); } catch (err) { downloadsError(err); }
      return;
    }
    if (IN_VIEWER) { toast('Bu görünümde dosya indirilemiyor.'); return; }
    const blob = await pdfBlob(dd);
    saveBlob(blob, name);
    toast('İndirme başlatıldı: ' + name);
  }
  async function downloadPdf(which) {
    if (!PDF.hasContent(cv)) { toast('CV’niz henüz boş. Önce birkaç soruyu yanıtlayın.'); return; }
    if (env.noDownload) { toast(noDownloadMsg(), 6000); return; }
    if (exportBusy) return;
    exportBusy = true;
    const setBusy = (b) => { const a = $('#btn-pdf'); if (a) a.disabled = b; const n = $('#btn-next'); if (n && STEPS[ui.step].kind === 'preview') n.disabled = b; };
    setBusy(true);
    const status = $('#pdf-status');
    if (status) status.textContent = 'PDF hazırlanıyor…';
    try {
      const { dd, name } = await buildCurrentPdf(which);
      await saveDoc(dd, name);
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
  /** The interview for a backup, minus what is only screen state or a cache (feed, README excerpts, retry counts). */
  function ivForBackup() {
    const o = sanitizeInterview(JSON.parse(JSON.stringify(iv)));
    o.feed = [];
    if (Array.isArray(o.repos)) o.repos.forEach((r) => { r.readme = ''; });
    o.pending = o.pending.concat(o.failed).map((j) => { const c = Object.assign({}, j); delete c.tries; return c; });
    o.failed = [];
    return o;
  }
  async function exportJson() {
    const data = JSON.stringify({
      app: 'sesli-cv', version: 2, cv, settings, interview: ivForBackup(), tailored: ui.tailored || null, letter: ui.letter || null,
      dismissed: ui.dismissed,
    }, null, 2);
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
        if (!data || data.app !== 'sesli-cv' || !data.cv || typeof data.cv !== 'object') throw new Error('format');
        if (data.version !== 1 && data.version !== 2) { toast('Bu yedek uygulamanın daha yeni bir sürümüyle alınmış; sayfayı yenileyip tekrar deneyin.', 6000); return; }
        if (rec.wanted || conv.speaking || conv.on) stopConvo();
        newDataGen(); // replies to calls made for the CV being replaced are dropped
        cv = sanitizeCv(data.cv);
        settings = Object.assign(sanitizeSettings(data.settings), { tts: settings.tts, autoNext: settings.autoNext, speechLang: settings.speechLang });
        // Consent is not part of a backup: it is given on each device. A version 1 backup has no
        // interview, variant or letter, so nothing of the CV it replaces may stay attached to it.
        const v2 = data.version === 2;
        setIv(v2 && data.interview ? sanitizeInterview(data.interview) : blankInterview());
        ui.tailored = v2 ? sanitizeTailored(data.tailored) : null;
        ui.letter = v2 ? sanitizeLetter(data.letter) : null;
        ui.dismissed = v2 ? sanitizeDismissed(data.dismissed) : [];
        ui.adDraft = (ui.tailored && ui.tailored.ad) || (ui.letter && ui.letter.ad) || '';
        ui.coverTarget = null; ui.coverReply = ''; ui.lastReply = ''; ui.editDraft = '';
        ui.tailorConfirm = false; ui.coverConfirm = false; ui.letterConfirm = false; ui.styleDirty = false;
        Object.keys(drafts).forEach((k) => { delete drafts[k]; });
        undoStacks.clear();
        ui.view = 'master'; ui.pages = {}; ui.restyleUndo = null; ui.chkAsk = null; ui.toolErr = {};
        ui.cvEn = null; ui.cvEnFor = '';
        resetTopicUi();
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

  // ---------------------------------------------------------------- AI interview (talk mode)
  // One profile tap, then a few spoken topics and three tap-only cards (brief §2). The person talks freely
  // and Claude (via /api/cv) turns each answer into the CV. Answers are processed in the background, one
  // at a time, so the interview never waits for the AI. Contact details, personal details and the photo
  // stay on this device.
  const AI = window.CVAI;
  const GH = window.CVGitHub;
  const CONSENT_KEY = 'sesli-cv:consent';
  const CONSENT_V = 'v1';
  const CONSENT_TITLE = 'Yapay zekâ kullanımı hakkında';
  const CONSENT_BODY = 'Cevaplarınız CV’nizi yazmak için yurt dışındaki bir yapay zekâ hizmetine (Anthropic, ABD) gönderilir. ' +
    'Verileriniz orada Türkiye’deki kadar korunmayabilir. Telefonunuz, e-postanız ve fotoğrafınız gönderilmez; ' +
    'TC kimlik, telefon ve IBAN numaraları gönderilmeden silinir. Bizim sunucumuz cevaplarınızı saklamaz.';
  const PROFILE_TTS = 'Başlamadan önce: sizi en iyi hangisi anlatıyor?';
  const PROFILES = [
    { id: 'ogrenci', label: 'Öğrenciyim ya da yeni mezunum', short: 'Öğrenci / yeni mezun', icon: 'cap' },
    { id: 'deneyimli', label: 'İş deneyimim var', short: 'Deneyimli', icon: 'briefcase' },
    { id: 'saha', label: 'Saha, üretim, şoförlük ya da ustalık', short: 'Saha / usta', icon: 'helmet' },
    { id: 'yazilim', label: 'Yazılım ve teknoloji', short: 'Yazılım', icon: 'code' },
  ];
  const PROFILE_IDS = PROFILES.map((p) => p.id);
  const BACKEND_TOPICS = ['about', 'goal', 'experience', 'education', 'projects', 'skills', 'extras', 'followup', 'free'];
  const NUDGE_TOPICS = { about: 1, experience: 1, education: 1, projects: 1, goal: 1 };
  const NUDGE_MIN_WORDS = 20;
  const MAX_HINTS = 15;
  // Talk-mode words (critic C5). A stand-alone “tamam” is how people think aloud in Turkish: it never ends an answer.
  const TALK_FILLER = /^(tamam|tamamdir|tamam tamam|ok|okay|okey)$/;
  const TALK_END = /^(bitti|cevabim bitti|cevap bitti|sonraki|sonraki soru|gecelim|devam|devam et|done|next)$/;
  const DONT_KNOW = /^(hatirlamiyorum|bilmiyorum|hatirlamiyorum maalesef|emin degilim)$/;

  // Topic cards (brief §2.3). say: [checklist text, CHECKS key or null]. v: per-profile variants.
  // Spoken topics (no `kind`) use their id as the backend extract topic.
  const TOPIC_DEFS = {
    about: {
      id: 'about', label: 'Tanışma',
      q: 'Önce sizi tanıyalım. Adınız ne, ne iş yapıyorsunuz ve hangi şehirde yaşıyorsunuz?',
      lead: 'Rahat konuşun; cümleleriniz düzgün olmasa da olur.',
      say: [['Adınız ve soyadınız', 'name'], ['Mesleğiniz ya da aradığınız iş', 'title'], ['Kaç yıldır bu işi yaptığınız', 'years'], ['Yaşadığınız il ve ilçe', 'city']],
      example: 'Adım Ayşe Kaya. Altı yıldır muhasebe yapıyorum. İzmir Bornova’da oturuyorum.',
      more: 'kaç yıldır bu işi yaptığınızı ve hangi şehirde yaşadığınızı',
      v: {
        ogrenci: {
          q: 'Önce sizi tanıyalım. Adınız ne, hangi okulda ve bölümde okuyorsunuz, nasıl bir iş ya da staj arıyorsunuz?',
          say: [['Ad soyad', 'name'], ['Okul ve bölüm', 'school'], ['Kaçıncı sınıf ya da mezuniyet yılı', 'eduEnd'], ['Aradığınız iş ya da staj', 'title'], ['Yaşadığınız il', 'city']],
          example: 'Adım Elif Demir. Ege Üniversitesi Bilgisayar Mühendisliği’nde son sınıftayım, Haziran 2027’de mezun oluyorum. İzmir’de yaşıyorum, yazılım alanında staj arıyorum.',
          more: 'hangi bölümde okuduğunuzu ve nasıl bir iş ya da staj aradığınızı',
        },
        saha: { example: 'Adım Mehmet Yılmaz. On yıldır forklift operatörüyüm. Kocaeli Gebze’de oturuyorum.' },
      },
    },
    contact: {
      id: 'contact', label: 'İletişim', kind: 'contact',
      q: 'Telefonunuzu ve e-postanızı ekleyelim.',
      lead: 'Yazabilir ya da telefonunuzu söyleyebilirsiniz; size geri okurum.',
      tts: 'Telefonunuzu ve e-postanızı ekleyelim. Yazabilir ya da telefonunuzu söyleyebilirsiniz; size geri okurum.',
    },
    experience: {
      id: 'experience', label: 'Deneyim',
      q: 'Şimdi işlerinizi konuşalım. En son çalıştığınız yerden başlayın: neredeydi, ne iş yapıyordunuz?',
      qMore: 'Önceki işinizi anlatın: neredeydi, ne zaman, ne iş yapıyordunuz?',
      loopQ: 'Bundan önce çalıştığınız bir yer var mı?',
      moreLabel: 'Önceki işiniz',
      lead: 'Her işi ayrı anlatın. Rakamlar çok işe yarar; örneğin “günde 200 sipariş”, “5 kişilik ekip”.',
      say: [['İş yerinin adı ve şehri', 'company'], ['Pozisyonunuz', 'role'], ['Başlangıç ve bitiş (ay ve yıl)', 'jobDates'], ['Her gün neler yapıyordunuz', 'duties'], ['Bir başarı ya da rakam', 'number'], ['Kullandığınız program ya da araç', 'tools']],
      example: '2021’den beri İzmir’de Kuzey Lojistik’te muhasebe uzmanıyım. Aylık beyannameleri hazırlıyorum, bordroyu yönetiyorum. Ay sonu kapanışını beş günden üç güne indirdik.',
      skip: 'Hiç çalışmadıysanız “geç” deyin; staj, gönüllülük ya da aile işinde yardım da sayılır.',
      more: 'her gün ne yaptığınızı ve bir başarınızı',
      v: {
        saha: {
          say: [['İş yeri ve şehir', 'company'], ['Göreviniz', 'role'], ['Ne zaman başladınız, ne zaman ayrıldınız', 'jobDates'], ['Kullandığınız makine ya da araç', 'tools'], ['Vardiyada ne kadar iş (palet, parça, sefer, müşteri)', 'number'], ['Kazasız çalışma, hatasız kasa gibi bir başarı', null]],
          example: '2019’dan beri Gebze’de bir depoda forklift operatörüyüm. Vardiyada yüz yirmi palet kadar yükleme boşaltma yapıyorum. İki yıldır hiç kaza yapmadım.',
          loopQ: 'Bundan önce çalıştığınız başka bir iş yeri var mı?',
          more: 'vardiyada ne kadar iş çıkardığınızı ve kullandığınız makineyi',
        },
        ogrenci: {
          label: 'Staj', optional: true, moreLabel: 'Önceki staj ya da göreviniz',
          q: 'Staj, yarı zamanlı iş, gönüllülük ya da kulüp görevi yaptınız mı? Kısa süreli işler de sayılır.',
          qMore: 'Onu da anlatın: nerede, ne zaman ve neler yaptınız?',
          loopQ: 'Başka bir staj, iş ya da gönüllü çalışmanız var mı?',
          say: [['Nerede ve ne zaman', 'whereWhen'], ['Staj mı, yarı zamanlı mı, gönüllü mü', 'role'], ['Neler yaptınız', 'duties'], ['Ortaya ne çıktı (etkinlik, rapor, katılımcı sayısı)', 'number'], ['Kaç kişilik ekipteydiniz', null]],
          example: 'Geçen yaz iki ay Arçelik’te üretim planlama stajı yaptım; arıza kayıtlarını Excel’de raporladım. Üniversitede bilişim kulübünün başkan yardımcısıydım, yüz kişilik bir etkinlik düzenledik.',
          skip: 'Hiçbiri yoksa “geç” deyin; sonra da ekleyebilirsiniz.',
          more: 'neler yaptığınızı ve ortaya ne çıktığını',
        },
      },
    },
    education: {
      id: 'education', label: 'Eğitim',
      q: 'Eğitiminizi anlatır mısınız? En son okuduğunuz okuldan başlayın.',
      lead: 'Üniversiteyi bitirdiyseniz liseyi söylemenize gerek yok.',
      say: [['Okulun adı', 'school'], ['Bölüm ve derece', 'program'], ['Mezuniyet yılı ya da beklenen mezuniyet', 'eduEnd'], ['Not ortalaması ve ölçeği (3,00 / 4 ve üstüyse)', 'gpa'], ['Erasmus, çift anadal, yandal, burs, onur', null]],
      example: 'Dokuz Eylül Üniversitesi İşletme bölümünden 2018’de mezun oldum, ortalamam üç virgül iki. Bir dönem Erasmus’la Polonya’daydım.',
      more: 'bölümünüzü, mezuniyet yılınızı ve varsa not ortalamanızı',
      v: {
        saha: {
          q: 'Hangi okulu bitirdiniz? Meslek lisesi, ustalık ya da kalfalık belgeniz varsa onu da söyleyin.',
          lead: 'En son bitirdiğiniz okul ve varsa belgeleriniz yeterli.',
          say: [['Okul ve bölüm', 'school'], ['Mezuniyet yılı', 'eduEnd'], ['Ustalık ya da kalfalık belgesi', 'mastery'], ['Meslek kursları', null]],
          example: 'Gebze Mesleki ve Teknik Anadolu Lisesi elektrik bölümünden 2012’de mezun oldum. Kalfalık belgem de var.',
          more: 'hangi bölümü bitirdiğinizi ve varsa ustalık belgenizi',
        },
      },
    },
    projects: {
      id: 'projects', label: 'Projeler', optional: true,
      q: 'Üzerinde çalıştığınız bir projeden bahseder misiniz? Okul, iş ya da kişisel bir proje olabilir.',
      lead: 'Proje adını, sizin ne yaptığınızı ve sonucunu anlatın. Bağlantıyı yazarak ekleyebilirsiniz.',
      say: [['Projenin adı ve ne işe yaradığı', 'projName'], ['Kimin için yaptınız', null], ['Sizin göreviniz', 'projDesc'], ['Kullandığınız teknolojiler', 'projTech'], ['Sonuç: kaç kişi kullandı, canlıda mı', 'projResult'], ['Bağlantı', 'projLink']],
      example: 'Depo takip sistemi diye bir proje yaptım; Python ve FastAPI ile, küçük bir firmanın stoklarını takip ediyor. Arayüzü ve raporları ben yazdım, şu an üç kişi her gün kullanıyor.',
      skip: 'Projeniz yoksa “geç” deyin.',
      more: 'projede sizin ne yaptığınızı ve sonucunu',
      v: { yazilim: { github: true } },
    },
    skills: {
      id: 'skills', label: 'Beceriler',
      q: 'Hangi programları, araçları ya da makineleri kullanabiliyorsunuz? Bildiğiniz yabancı dilleri de seviyesiyle söyleyin.',
      lead: 'Sayıp geçmeniz yeterli; sırası önemli değil.',
      say: [['Programlar (Excel, Logo, SAP…)', 'skills'], ['Teknik bilgiler ya da yöntemler', null], ['Makine ve ekipman', null], ['Yabancı diller ve seviyesi', 'langs'], ['Dil sınavı puanı (YDS, YÖKDİL, IELTS, TOEFL)', 'langExam']],
      example: 'Excel’i çok iyi kullanırım, Logo Tiger ve SAP biliyorum. İngilizcem B2 seviyesinde, YDS’den yetmiş beş aldım.',
      v: {
        yazilim: {
          say: [['Programlama dilleri', 'skills'], ['Framework ve kütüphaneler', 'framework'], ['Veritabanları', 'db'], ['Bulut ve araçlar (Docker, AWS, CI/CD)', 'cloud'], ['Yabancı dil ve seviyesi', 'langs']],
          example: 'C# ve TypeScript ile çalışıyorum; .NET, React ve PostgreSQL kullanıyorum. Docker ve GitHub Actions biliyorum. İngilizcem B2 seviyesinde.',
        },
        saha: { example: 'Forklift ve transpalet kullanırım, el terminaliyle sayım yaparım. Biraz Excel de bilirim.' },
      },
    },
    extras: {
      id: 'extras', label: 'Belgeler', optional: true,
      q: 'Ehliyetiniz, sertifikanız ya da kurs belgeniz var mı? Varsa hepsini sayın.',
      lead: 'Ehliyet sınıfı, SRC, psikoteknik ve operatör belgeleri işverenlerin aradığı şeylerdir; atlamayın.',
      say: [['Sürücü belgesi ve sınıfı', 'license'], ['SRC, psikoteknik, forklift ya da operatör belgesi', 'opCert'], ['MYK mesleki yeterlilik belgesi', 'myk'], ['Kurs ve sertifikalar (kurum, yıl)', 'certs'], ['Gönüllülük ya da ödül', null], ['Düzenli yaptığınız bir hobi (somut olarak)', 'hobbies']],
      example: 'B sınıfı ehliyetim ve forklift operatör belgem var. 2022’de MYK’dan depo operatörü belgesi aldım. Hafta sonları amatör bir futbol takımında oynuyorum.',
      skip: 'Yoksa “geç” deyin.',
    },
    goal: {
      id: 'goal', label: 'Hedef',
      q: 'Son soru: nasıl bir iş arıyorsunuz ve sizi bu işte iyi yapan ne?',
      lead: 'Bir iki cümle yeter; özetinizi biz yazarız.',
      say: [['Aradığınız pozisyon', 'title'], ['Çalışmak istediğiniz şehir ya da uzaktan', null], ['En güçlü yönünüz ve bir örneği', null], ['Ne zaman başlayabileceğiniz', null]],
      example: 'Muhasebe ya da finans tarafında, İzmir’de bir iş arıyorum. En güçlü yanım düzen: ay sonu kapanışını beş günden üç güne indirdim. Bir ay içinde başlayabilirim.',
      more: 'nasıl bir iş aradığınızı ve sizi bu işte iyi yapan bir örneği',
      v: {
        saha: {
          sayAdd: [['Vardiyalı ya da hafta sonu çalışabilir misiniz?', null], ['Bu işi neden istiyorsunuz?', null]],
          example: 'Depo ya da lojistikte forklift operatörü olarak çalışmak istiyorum. Vardiyalı ve hafta sonu çalışabilirim, hemen başlayabilirim.',
        },
        ogrenci: {
          sayAdd: [['Staj mı, tam zamanlı iş mi arıyorsunuz; ne zaman başlayabilirsiniz?', null]],
          example: 'Yazılım alanında yaz stajı arıyorum, İzmir’de ya da uzaktan. Takım çalışmasında iyiyim; bitirme projemizde dört kişilik ekibi ben koordine ettim. Haziran’dan itibaren başlayabilirim.',
        },
      },
    },
    personal: {
      id: 'personal', label: 'Kişisel', kind: 'personal', optional: true,
      q: 'Doğum yılı ya da askerlik durumu gibi bilgileri eklemek ister misiniz?',
      lead: 'Hepsi isteğe bağlı. Eklemediğiniz bilgi CV’de görünmez.',
      tts: 'Doğum yılı ya da askerlik durumu gibi bilgileri eklemek ister misiniz? Hepsi isteğe bağlı.',
    },
    photo: {
      id: 'photo', label: 'Fotoğraf', kind: 'photo', optional: true,
      q: 'Fotoğraf eklemek ister misiniz?',
      lead: 'Türkiye’de yaygın ama zorunlu değil.',
      tts: 'Fotoğraf eklemek ister misiniz? Türkiye’de yaygın ama zorunlu değil.',
      sayTitle: 'Şunlara dikkat edin:',
      say: [['Düz, açık renkli arka plan', null], ['Net ve güncel', null], ['Kameraya bakın, yüzünüz açık olsun', null], ['Selfie, filtre, şapka ya da güneş gözlüğü yok', null], ['Sade bir gömlek ya da ceket', null]],
      v: { yazilim: { note: 'Yazılım ve yurt dışı başvurularında genelde eklenmez.' } },
    },
  };
  // Order per profile (brief §2.1). Saha has no projects; Yazılım picks GitHub repos inside projects.
  const TOPIC_ORDER = {
    ogrenci: ['about', 'contact', 'education', 'projects', 'experience', 'skills', 'extras', 'goal', 'personal', 'photo'],
    deneyimli: ['about', 'contact', 'experience', 'education', 'projects', 'skills', 'extras', 'goal', 'personal', 'photo'],
    saha: ['about', 'contact', 'experience', 'extras', 'education', 'skills', 'goal', 'personal', 'photo'],
    yazilim: ['about', 'contact', 'experience', 'projects', 'education', 'skills', 'extras', 'goal', 'personal', 'photo'],
  };
  function topicsFor(profile) {
    const p = TOPIC_ORDER[profile] ? profile : 'deneyimli';
    return TOPIC_ORDER[p].map((id) => {
      const base = TOPIC_DEFS[id];
      const v = (base.v && base.v[p]) || {};
      const t = Object.assign({}, base, v);
      delete t.v;
      delete t.sayAdd;
      if (v.sayAdd) t.say = base.say.concat(v.sayAdd);
      return t;
    });
  }
  const isSpoken = (t) => !t.kind;
  const spokenTotal = () => TOPICS.filter(isSpoken).length;
  const spokenPos = (i) => TOPICS.slice(0, i + 1).filter(isSpoken).length;
  const wordCount = (s) => (String(s || '').trim().match(/\S+/g) || []).length;

  // Checklist ticks: a chip is ticked only when the CV clearly holds that item (simple local checks).
  const filled = (v) => !!String(v || '').trim();
  const firstOf = (list) => (Array.isArray(list) && list[0]) || {};
  const fkHas = (text, re) => re.test(' ' + fk(text) + ' ');
  const CHECKS = {
    name: (c) => filled(c.name),
    title: (c) => filled(c.title),
    city: (c) => filled(c.city),
    years: (c) => fkHas(c.summary, / (\d+|bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on|yirmi) ?(yil|yillik|yildir|sene|senelik|senedir) /) || c.jobs.some((j) => filled(j.start)),
    company: (c, j) => filled(j.company),
    role: (c, j) => filled(j.role),
    jobDates: (c, j) => filled(j.start),
    whereWhen: (c, j) => filled(j.company) && filled(j.start),
    duties: (c, j) => filled(j.desc),
    number: (c, j) => /\d/.test(j.desc || ''),
    tools: (c) => filled(c.skills),
    school: (c) => filled(firstOf(c.edu).school),
    program: (c) => filled(firstOf(c.edu).program) || filled(firstOf(c.edu).degree),
    eduEnd: (c) => filled(firstOf(c.edu).end),
    gpa: (c) => /\d/.test(firstOf(c.edu).note || ''),
    mastery: (c) => fkHas([c.certs].concat(c.edu.map((e) => [e.program, e.degree, e.note].join(' '))).join(' '), / (ustalik|kalfalik)/),
    projName: (c) => filled(firstOf(c.projects).name),
    projDesc: (c) => filled(firstOf(c.projects).desc),
    projTech: (c) => filled(firstOf(c.projects).tech),
    projResult: (c) => /\d/.test(firstOf(c.projects).desc || ''),
    projLink: (c) => filled(firstOf(c.projects).link),
    skills: (c) => filled(c.skills),
    framework: (c) => fkHas(c.skills, / (react|angular|vue|net|spring|django|flask|fastapi|node|nodejs|express|laravel|next|nextjs|flutter|rails) /),
    db: (c) => fkHas(c.skills, / (sql|mysql|postgresql|postgres|mongodb|redis|sqlite|oracle|mssql|elasticsearch) /),
    cloud: (c) => fkHas(c.skills, / (docker|aws|azure|gcp|kubernetes|k8s|ci|cd|jenkins|terraform|github actions) /),
    langs: (c) => filled(c.langs),
    langExam: (c) => fkHas(c.langs, / (yds|yokdil|ielts|toefl|toeic|pte|a1|a2|b1|b2|c1|c2) /),
    license: (c) => filled(c.license) || fkHas(c.certs, / (ehliyet|ehliyetim|surucu belgesi) /),
    opCert: (c) => fkHas(c.certs, / (src|psikoteknik|forklift|operator|operatoru|operatorluk) /),
    myk: (c) => fkHas(c.certs, / (myk|mesleki yeterlilik) /),
    certs: (c) => filled(c.certs),
    hobbies: (c) => filled(c.hobbies),
  };
  /** The job the experience checklist talks about: the newest one, or the one added since “Önceki işiniz”. */
  function targetJob() {
    const jobs = cv.jobs || [];
    if (iv.expLoop === 'more') return jobs.length > (ui.loopBase || 0) ? jobs[jobs.length - 1] : {};
    return jobs[0] || {};
  }
  function tickOk(key) {
    const fn = key && CHECKS[key];
    if (!fn) return false;
    try { return !!fn(cv, targetJob()); } catch (_) { return false; }
  }
  function refreshTicks() {
    $$('#say-list li').forEach((li) => {
      const ok = tickOk(li.dataset.ck);
      li.classList.toggle('ok', ok);
      const s = li.querySelector('.sr'); if (s) s.textContent = ok ? ' (CV’de var)' : '';
    });
  }

  const blankInterview = () => ({
    started: false, profile: '', idx: 0, phase: 'topics', answers: {}, draft: '', followups: [], fIdx: 0,
    feed: [], pending: [], failed: [], finalized: false, ghUser: '', repos: null,
    hints: [], nudged: {}, expLoop: '', okNames: [],
    // an e-mail heard inside an answer and written into the CV, until the person confirms it on K1
    emailCheck: '',
  });
  let iv = blankInterview();
  let TOPICS = topicsFor('');
  let consent = '';
  const aiState = { status: IN_VIEWER ? 'off' : 'unknown', msg: IN_VIEWER ? 'Claude görünümünde yapay zekâ sunucusuna bağlanılamıyor.' : '', running: false, busy: '', waiters: [] };
  let segStack = [];

  const aiOk = () => aiState.status === 'ok' || aiState.status === 'unknown';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Replace the interview state; the topic list follows its profile. */
  function setIv(next) { iv = next; TOPICS = topicsFor(iv.profile); }

  const cleanStr = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const cleanStrList = (v, max, n) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, n)).slice(0, max) : []);
  function cleanJob(j) {
    if (!j || typeof j.answer !== 'string' || !BACKEND_TOPICS.includes(j.topic)) return null;
    return {
      id: cleanStr(j.id, 40) || uid(), topic: j.topic, question: cleanStr(j.question, 400), answer: j.answer.slice(0, 20000),
      repoNames: Array.isArray(j.repoNames) ? cleanStrList(j.repoNames, 12, 100) : null, ghUser: cleanStr(j.ghUser, 60), tries: 0,
    };
  }
  function cleanFeed(f) {
    if (!f || typeof f.text !== 'string') return null;
    const out = { id: cleanStr(f.id, 40) || uid(), topic: cleanStr(f.topic, 20), text: f.text.slice(0, 600), kind: f.kind === 'err' ? 'err' : 'ok' };
    if (typeof f.job === 'string') out.job = f.job.slice(0, 40);
    const names = cleanStrList(f.confirm, 5, 80);
    if (names.length) { out.confirm = names; out.cdone = !!f.cdone; }
    return out;
  }
  function cleanRepo(r) {
    if (!r || typeof r.name !== 'string' || !r.name) return null;
    return {
      name: r.name.slice(0, 100), description: cleanStr(r.description, 400), language: cleanStr(r.language, 40), stars: Number(r.stars) || 0,
      url: cleanStr(r.url, 300), homepage: cleanStr(r.homepage, 300), topics: cleanStrList(r.topics, 8, 60), updated: cleanStr(r.updated, 10),
      pushed: cleanStr(r.pushed, 30), size: Number(r.size) || 0, readme: cleanStr(r.readme, 2600), selected: !!r.selected, sent: !!r.sent,
    };
  }
  function sanitizeInterview(raw) {
    const out = blankInterview();
    if (!raw || typeof raw !== 'object') return out;
    out.profile = PROFILE_IDS.includes(raw.profile) ? raw.profile : '';
    const topics = topicsFor(out.profile);
    out.started = !!raw.started;
    out.finalized = !!raw.finalized;
    out.idx = Math.max(0, Math.min(topics.length - 1, Number(raw.idx) || 0));
    out.phase = ['topics', 'waiting', 'followups', 'finalizing', 'done'].includes(raw.phase) ? raw.phase : 'topics';
    if (out.phase === 'waiting' || out.phase === 'finalizing') out.phase = out.finalized ? 'done' : 'topics';
    if (raw.answers && typeof raw.answers === 'object') {
      Object.keys(TOPIC_DEFS).concat('followup').forEach((k) => { if (typeof raw.answers[k] === 'string') out.answers[k] = raw.answers[k].slice(0, 20000); });
    }
    out.draft = cleanStr(raw.draft, 8000);
    out.followups = cleanStrList(raw.followups, 5, 400);
    out.fIdx = Math.max(0, Math.min(out.followups.length, Number(raw.fIdx) || 0));
    if (out.phase === 'followups' && !out.followups.length) out.phase = 'topics';
    out.feed = Array.isArray(raw.feed) ? raw.feed.map(cleanFeed).filter(Boolean).slice(0, 30) : [];
    out.pending = Array.isArray(raw.pending) ? raw.pending.map(cleanJob).filter(Boolean).slice(0, 20) : [];
    out.failed = Array.isArray(raw.failed) ? raw.failed.map(cleanJob).filter(Boolean).slice(0, 20) : [];
    out.ghUser = cleanStr(raw.ghUser, 60);
    out.repos = Array.isArray(raw.repos) ? raw.repos.map(cleanRepo).filter(Boolean).slice(0, 60) : null;
    out.hints = cleanStrList(raw.hints, MAX_HINTS * 2, 300).slice(-MAX_HINTS);
    if (raw.nudged && typeof raw.nudged === 'object') Object.keys(NUDGE_TOPICS).forEach((k) => { if (raw.nudged[k]) out.nudged[k] = true; });
    out.expLoop = (raw.expLoop === 'ask' || raw.expLoop === 'more') && out.phase === 'topics' && (topics[out.idx] || {}).id === 'experience' ? raw.expLoop : '';
    out.okNames = cleanStrList(raw.okNames, 80, 80);
    out.emailCheck = cleanStr(raw.emailCheck, 200);
    return out;
  }

  function curTopic() {
    if (iv.phase === 'followups') {
      const f = iv.followups[iv.fIdx];
      return f ? { id: 'followup', label: 'Eksik bilgi', q: f, lead: 'Kısaca yanıtlayın. Hatırlamıyorsanız aşağıdan seçin ya da “hatırlamıyorum” deyin.', optional: true } : null;
    }
    return TOPICS[iv.idx] || null;
  }
  const topicLabel = (id) => { const t = TOPICS.find((x) => x.id === id) || TOPIC_DEFS[id]; return t ? t.label : 'Eksik bilgi'; };

  // ---- consent (critic C1): nothing personal goes to /api/cv before this.
  const hasConsent = () => consent === CONSENT_V;
  function giveConsent() {
    consent = CONSENT_V;
    try { localStorage.setItem(CONSENT_KEY, CONSENT_V); } catch (_) { /* ignore */ }
    save();
  }
  function consentCard(on, yesLabel, asPage, opts) {
    const o = opts || {};
    return h('div', { class: 'consent' },
      h(asPage ? 'h1' : 'h3', { class: asPage ? 'question' : 'consent-title', id: asPage ? 'question' : null }, CONSENT_TITLE),
      h('p', null, o.body || CONSENT_BODY),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn primary', dataset: { fkey: 'consent-yes' }, onclick: on.yes }, yesLabel || 'Kabul ediyorum, başlayalım'),
        h('button', { type: 'button', class: 'btn', dataset: { fkey: 'consent-no' }, onclick: on.no }, o.noLabel || 'Yapay zekâ olmadan doldur')));
  }
  // Final-screen tools send the CV text itself, not only answers: say so (and “Vazgeç”, since nothing is filled here).
  const CONSENT_TOOL_BODY = 'Bu işlem için CV’nizin metni (adınız, deneyimleriniz, eğitiminiz, becerileriniz), isteğiniz ve varsa yapıştırdığınız ilan ' +
    'yurt dışındaki bir yapay zekâ hizmetine (Anthropic, ABD) gönderilir. Verileriniz orada Türkiye’deki kadar korunmayabilir. ' +
    'Telefonunuz, e-postanız ve fotoğrafınız gönderilmez; TC kimlik, telefon ve IBAN numaraları gönderilmeden silinir. Bizim sunucumuz bunları saklamaz.';
  /**
   * Consent gate for final-screen AI tools: returns true when consent exists (the caller just goes on).
   * Otherwise it opens the consent sheet, returns false, and runs `then` once the person accepts.
   */
  function askConsent(then) {
    if (hasConsent()) return true;
    const sheet = D.getElementById('sheet-consent');
    if (!sheet) { toast('Önce yapay zekâ kullanımını onaylamanız gerekiyor.'); return false; }
    $('#consent-body').replaceChildren(consentCard({
      yes: () => { giveConsent(); closeSheet(sheet); runQueue(); if (then) then(); },
      no: () => { closeSheet(sheet); toast('Yapay zekâ kullanılmadı. CV’nizi elle düzenleyebilirsiniz.', 4500); },
    }, 'Kabul ediyorum', false, { body: CONSENT_TOOL_BODY, noLabel: 'Vazgeç' }));
    openSheet('sheet-consent');
    return false;
  }

  // ---- data generations. “Verilerimi sil”, “Yeni CV başlat” and loading a backup start a new one: calls still
  // out are aborted, and a reply that arrives anyway belongs to data that is gone, so it is dropped (never
  // applied, never saved). Every async AI path captures `dataGen` before it awaits and checks it after.
  let dataGen = 0;
  const inflight = new Set(); // AbortControllers of the /api/cv calls in progress
  function newDataGen() {
    dataGen++;
    inflight.forEach((c) => { try { c.abort(); } catch (_) { /* ignore */ } });
    inflight.clear();
    aiState.running = false;
    aiState.busy = '';
    Object.keys(toolBusy).forEach((k) => { toolBusy[k] = false; });
    wakeWaiters(); // whoever waited for the old queue sees the new generation and stops
  }
  /** Every /api/cv call goes through here: consent gate plus profile and bullet style for writing ops. */
  function aiCall(op, payload) {
    if (op !== 'ping' && !hasConsent()) {
      return Promise.reject({ status: 0, code: 'consent', message: 'Önce yapay zekâ kullanımını onaylamanız gerekiyor.', retryable: false });
    }
    const body = Object.assign({ lang: 'tr', profile: iv.profile || 'deneyimli', style: settings.bulletStyle || 'kisisel' }, payload || {});
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    if (!ctl) return AI.call(op, body);
    inflight.add(ctl);
    const done = () => { inflight.delete(ctl); };
    return Promise.resolve(AI.call(op, body, { signal: ctl.signal })).then((r) => { done(); return r; }, (e) => { done(); throw e; });
  }

  // ---- an AI reply meets a CV that may have changed while the call was out
  const CV_KEYS = Object.keys(blankCv());
  const sameVal = (a, b) => JSON.stringify(a == null ? '' : a) === JSON.stringify(b == null ? '' : b);
  const snapCv = (c) => JSON.parse(JSON.stringify(c));
  const aiForm = (k, c) => JSON.stringify(AI.toAI({ [k]: c[k] })[k]);
  /**
   * The reply laid over the CV it was made from (`base`, a snapshot taken right before the call). A field
   * that changed here since then (typed on K1/K2, a quick edit, another reply) keeps today's value: the
   * reply was written without it. `lists`: the jobs/edu/projects lists that changed here AND that the
   * reply changed too, i.e. whose AI update could not be applied.
   */
  function mergeReply(aicv, base) {
    const next = AI.fromAI(aicv, cv, 'tr');
    if (!base) return { cv: next, lists: [] };
    const out = {};
    const lists = [];
    CV_KEYS.forEach((k) => {
      if (sameVal(cv[k], base[k])) { out[k] = next[k]; return; }
      out[k] = cv[k];
      if (Array.isArray(cv[k]) && aiForm(k, next) !== aiForm(k, base)) lists.push(k);
    });
    return { cv: out, lists };
  }
  /**
   * Applies an AI reply to the master CV (see mergeReply). With `retry`, a reply whose list update collides
   * with a change made meanwhile is not applied at all (returns false) so the caller can ask again.
   */
  function applyAiCv(aicv, base, retry) {
    if (!aicv || typeof aicv !== 'object') return true;
    const m = mergeReply(aicv, base);
    if (retry && m.lists.length) return false;
    cv = m.cv;
    ui.cvEn = null;
    afterChange();
    if (ui.mode !== 'talk') renderAll();
    else { refreshTicks(); refreshContactFields(); }
    return true;
  }

  /** Removes TC, phone, e-mail and IBAN numbers on the device before a transcript leaves it (critic C3). */
  function scrubText(text, opts) {
    const src = String(text || '');
    if (AI && typeof AI.scrub === 'function') {
      try {
        // the name helps it read a dictated e-mail as one address
        const r = AI.scrub(src, Object.assign({ name: cv.name || '' }, opts || {}));
        if (r && typeof r.text === 'string') return { text: r.text, found: (r.found && typeof r.found === 'object') ? r.found : {} };
      } catch (e) { console.error(e); }
    }
    return { text: src, found: {} };
  }
  const PLACEHOLDER_RE = /\[(telefon|e-posta|kimlik no|IBAN)\]/gi;
  const meaningful = (s) => String(s || '').replace(PLACEHOLDER_RE, ' ').replace(/[^\p{L}\p{N}]+/gu, '').length >= 3;
  /**
   * Nothing worth sending is left: the scrubber took something out (only contact details were said) and
   * what remains is just the placeholders. A short answer the scrubber did not touch (“5”, “3,2”, “B”) is
   * a real answer and is always sent.
   */
  const onlyContact = (sc, src) => sc.text !== String(src || '') && !meaningful(sc.text);
  /**
   * The model only ever sees placeholders. Where it echoes one back into text the person will use
   * (a letter, a reply), the person's own detail goes back in; a sentence whose detail is unknown, or is a
   * TC kimlik no or IBAN, is dropped.
   */
  function fillMarks(text, vals) {
    const src = String(text == null ? '' : text);
    if (src.indexOf('[') < 0) return src;
    const v = vals || {};
    const by = { telefon: String(v.phone || '').trim(), 'e-posta': String(v.email || '').trim() };
    let out = src.replace(/\[(telefon|e-posta)\]/gi, (m, kind) => by[kind.toLowerCase()] || m);
    out = out.replace(/[^.!?…\n]*\[(?:telefon|e-posta|kimlik no|IBAN)\][^.!?…\n]*[.!?…]*[^\S\n]*/gi, '');
    return out.split('\n').map((l) => l.replace(/[^\S\n]{2,}/g, ' ').trim()).join('\n').trim();
  }
  /** A phone number or e-mail said inside an answer fills the empty contact field locally. */
  function fillFound(found) {
    const f = found || {};
    const got = [];
    let mail = false;
    if (typeof f.phone === 'string' && f.phone.trim() && !filled(cv.phone)) { cv.phone = f.phone.trim(); got.push('telefonunuzu'); }
    if (typeof f.email === 'string' && f.email.trim() && !filled(cv.email)) {
      mail = true;
      // An address heard inside a sentence may be cut short (“… kaya et gmail” without the first name):
      // it is written in, and the contact card asks “Doğru mu?” before it is trusted.
      cv.email = f.email.trim().toLowerCase();
      iv.emailCheck = cv.email;
      got.push('e-postanızı (' + cv.email + ')');
    }
    if (!got.length) return '';
    afterChange();
    refreshContactFields();
    return P.capFirst(got.join(' ve ')) + ' iletişim bilgilerine ekledim; yapay zekâya gönderilmedi.' + (mail ? ' Doğru yazdım mı, kontrol edin.' : '');
  }
  function addHints(list) {
    if (!Array.isArray(list)) return;
    list.forEach((q) => {
      const s = typeof q === 'string' ? q.trim().slice(0, 300) : '';
      if (!s) return;
      const k = fk(s);
      iv.hints = iv.hints.filter((x) => fk(x) !== k);
      iv.hints.push(s);
    });
    iv.hints = iv.hints.slice(-MAX_HINTS);
  }

  async function pingAI() {
    if (IN_VIEWER) return;
    try {
      const r = await AI.call('ping', {});
      if (r && r.configured === false) { aiState.status = 'off'; aiState.msg = 'Yapay zekâ henüz ayarlanmadı.'; }
      else aiState.status = 'ok';
    } catch (e) {
      if (e.code === 'access_code') aiState.status = 'code';
      else if (e.code === 'network') aiState.status = 'unknown';
      else { aiState.status = 'off'; aiState.msg = e.message || 'Yapay zekâ hizmetine ulaşılamadı.'; }
    }
    if (aiState.status === 'ok' && iv.pending.length) runQueue();
    rerenderSoft();
  }

  // ---- queue
  /** Adds an answer to the queue; returns its job id (a retried job keeps the id it had). */
  function enqueue(job) {
    job.id = job.id || uid();
    job.tries = 0;
    iv.pending.push(job);
    save();
    renderFeed();
    runQueue();
    return job.id;
  }
  function wakeWaiters() { aiState.waiters.splice(0).forEach((f) => f()); }
  function queueIdle() {
    if (!iv.pending.length || !hasConsent()) return Promise.resolve();
    runQueue();
    return new Promise((resolve) => aiState.waiters.push(resolve));
  }
  /** Jobs leave the queue by id: something may have been added (or the queue replaced) while one was out. */
  function dropJob(id) {
    const i = iv.pending.findIndex((j) => j.id === id);
    if (i >= 0) iv.pending.splice(i, 1);
  }
  async function runQueue() {
    if (aiState.running || aiState.status === 'code' || aiState.status === 'off' || !hasConsent()) return;
    const gen = dataGen;
    aiState.running = true;
    renderFeed();
    while (gen === dataGen && iv.pending.length && aiState.status !== 'code' && aiState.status !== 'off' && hasConsent()) {
      const job = iv.pending[0];
      try {
        let github;
        if (job.repoNames && job.repoNames.length && Array.isArray(iv.repos)) {
          const chosen = iv.repos.filter((r) => job.repoNames.includes(r.name));
          try { await GH.withReadmes(job.ghUser || iv.ghUser, chosen, 6); } catch (_) { /* README'siz devam */ }
          if (gen !== dataGen) break;
          // READMEs and descriptions often end with “İletişim: …”: they are scrubbed like an answer.
          github = GH.forAI(chosen).map((r) => Object.assign({}, r, {
            readme: r.readme ? scrubText(r.readme).text : r.readme, description: r.description ? scrubText(r.description).text : r.description,
          }));
        }
        // Scrub right before the call: the saved draft and answers keep the person's own words.
        const sc = scrubText(job.answer);
        const note = fillFound(sc.found);
        if (note) iv.feed.unshift({ id: uid(), topic: 'contact', text: note, kind: 'ok' });
        if (!github && onlyContact(sc, job.answer)) {
          dropJob(job.id); // only contact details were said; nothing left to send
        } else {
          // The reply is laid over this snapshot, so what is typed meanwhile (K1, K2, a quick edit) survives.
          const base = snapCv(cv);
          const res = await aiCall('extract', { cv: AI.toAI(base), topic: job.topic, question: job.question, answer: sc.text, github });
          if (gen !== dataGen) break;
          aiState.status = 'ok';
          if (!applyAiCv(res && res.cv, base, (job.conflicts || 0) < 2)) {
            // A job, school or project was edited here while this answer was out: ask again with today's CV.
            job.conflicts = (job.conflicts || 0) + 1;
            continue;
          }
          addHints(res.missing);
          const item = { id: uid(), topic: job.topic, text: String(res.heard || 'Söyledikleriniz CV’ye eklendi.'), kind: 'ok' };
          const names = cleanStrList(res.confirm, 5, 80).filter((n) => !nameSettled(n));
          if (names.length) { item.confirm = names; item.cdone = false; }
          iv.feed.unshift(item);
          dropJob(job.id);
        }
      } catch (e) {
        if (gen !== dataGen || e.code === 'cancelled') break;
        if (e.code === 'consent') break;
        if (e.code === 'access_code') { aiState.status = 'code'; break; }
        if (e.code === 'not_configured' || e.code === 'unavailable') { aiState.status = 'off'; aiState.msg = e.message; break; }
        job.tries = (job.tries || 0) + 1;
        if (e.retryable && job.tries < 4) { await sleep(job.tries * (e.code === 'rate_limited' ? 15000 : 4000)); continue; }
        dropJob(job.id);
        iv.failed.push(job);
        iv.feed.unshift({ id: uid(), topic: job.topic, text: (e.message || 'Bu yanıt işlenemedi.') + ' Yanıtınız kaybolmadı; tekrar deneyebilirsiniz.', kind: 'err', job: job.id });
      }
      iv.feed = iv.feed.slice(0, 30);
      save();
      renderFeed();
    }
    if (gen !== dataGen) return; // the data was wiped or replaced: newDataGen() already released the queue
    aiState.running = false;
    if (!iv.pending.length || !hasConsent()) wakeWaiters();
    renderFeed();
    if (aiState.status === 'code' || aiState.status === 'off') rerenderSoft();
    // On the final screen the items that wait for an answer (“işleniyor” / “işlenemedi”) follow the queue.
    else if (ui.mode !== 'talk' && STEPS[ui.step].kind === 'preview') renderFinalTools();
  }
  function retryFailed(jobId) {
    const i = iv.failed.findIndex((j) => j.id === jobId);
    if (i < 0) return;
    const job = iv.failed.splice(i, 1)[0];
    iv.feed = iv.feed.filter((f) => f.job !== jobId);
    enqueue(job);
  }

  // ---- interview flow
  /** Which card blocks the interview before the first question: '' | 'profile' | 'consent'. */
  function talkGate() {
    if (!iv.profile || ui.pickProfile) return 'profile';
    if (!hasConsent()) return 'consent';
    return '';
  }
  function startTalk(resume) {
    if (!resume || !iv.started) { iv.started = true; iv.phase = iv.finalized ? 'topics' : iv.phase; }
    ui.mode = 'talk';
    if (rec.wanted || conv.speaking) { conv.token++; cancelAdv(); SP.cancelSpeech(); conv.speaking = false; rec.stop(); }
    conv.slot = null;
    talkProceed();
  }
  /** Shows whatever comes next (profile card, consent, mic primer or the question) and starts talking. */
  function talkProceed() {
    ui.pickProfile = false;
    renderAll();
    save();
    const gate = talkGate();
    if (gate === 'profile') { speakOnly(PROFILE_TTS); return; }
    if (gate === 'consent') { speakOnly(CONSENT_TITLE + '. ' + CONSENT_BODY); return; }
    if (iv.phase !== 'topics' && iv.phase !== 'followups') return;
    if (needMicPrime()) return; // the card in the view asks first; its button starts listening
    if (micUsable() || ttsOn()) { conv.on = true; conv.mode = 'talk'; keepAwake(); askTopic(); }
    else focusAnswer();
  }
  function focusAnswer() { const ta = $('#answer'); if (ta) ta.focus({ preventScroll: true }); }
  function setProfile(p) {
    if (!PROFILE_IDS.includes(p)) return;
    const cur = iv.phase === 'topics' ? curTopic() : null;
    const curId = cur ? cur.id : null;
    iv.profile = p;
    TOPICS = topicsFor(p);
    const i = curId ? TOPICS.findIndex((t) => t.id === curId) : -1;
    iv.idx = i >= 0 ? i : Math.max(0, Math.min(iv.idx, TOPICS.length - 1));
    if (curId !== 'experience' || i < 0) iv.expLoop = '';
    save();
  }
  function chooseProfile(p) {
    SP.cancelSpeech(); conv.token++; conv.speaking = false;
    setProfile(p);
    talkProceed();
  }
  // Explain the browser's microphone dialog before it appears (people block what they don't expect).
  function needMicPrime() { return micUsable() && env.mic !== 'ok' && !ui.micPrimed && env.micPerm !== 'granted'; }
  function micPrimeCard() {
    return h('div', { class: 'check prime' },
      h('div', { class: 'check-head' }, icon('mic'), 'Cevaplarınızı konuşarak verin'),
      h('p', null, 'Bunun için mikrofon izni gerekiyor. Birazdan çıkan pencerede “İzin ver”e dokunun.'),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn primary', dataset: { fkey: 'prime-yes' }, onclick: () => {
          ui.micPrimed = true; try { localStorage.setItem('sesli-cv:primed', '1'); } catch (_) { /* ignore */ }
          renderAll(); conv.on = true; conv.mode = 'talk'; keepAwake(); askTopic();
        } }, icon('mic'), 'Mikrofonu aç'),
        h('button', { type: 'button', class: 'btn', onclick: () => {
          ui.micPrimed = true; renderAll(); focusAnswer();
        } }, 'Yazarak devam et')));
  }
  function leaveTalk() {
    if (rec.wanted || conv.speaking || conv.on) stopConvo();
    ui.mode = 'steps';
  }
  /**
   * Speak `text`, then listen with `slot` (critic C6): the microphone is closed for the whole time the
   * question is read, and only reopens after speech has ended. Returns false if something newer took over.
   */
  async function talkSay(text, slot) {
    const my = ++conv.token;
    cancelAdv();
    // Whatever is being read aloud stops first, also when we only listen (text ''): the mic never opens
    // over the app's own voice, and the “speaking” state cannot stick.
    SP.cancelSpeech();
    conv.speaking = false;
    conv.slot = slot || null;
    if (D.hidden) { conv.on = false; releaseAwake(); refreshMicUi(); return false; } // never talk or listen in a hidden tab
    refreshMicUi();
    await rec.stop();
    if (my !== conv.token) return false;
    if (text && ttsOn()) {
      await speakNow(String(text).replace(/[“”"]/g, ''), my);
      if (my !== conv.token) return false;
      await sleep(120); // let the speaker fall silent before the mic opens
      if (my !== conv.token) return false;
    }
    if (D.hidden) { conv.on = false; releaseAwake(); refreshMicUi(); return false; }
    if (slot && conv.on && micUsable()) rec.start(slot);
    else if (slot && slot.kind === 'answer' && !micUsable()) focusAnswer();
    refreshMicUi();
    return true;
  }
  /** Speak without listening afterwards (profile and consent cards). */
  async function speakOnly(text) {
    if (!ttsOn() || !text || D.hidden) return;
    const my = ++conv.token;
    await rec.stop();
    if (my !== conv.token) return;
    await speakNow(String(text).replace(/[“”"]/g, ''), my);
  }
  const topicQ = (t) => (t.id === 'experience' && iv.expLoop === 'more' && t.qMore ? t.qMore : t.q);
  const contactSlot = () => ({ kind: 'contact', topic: 'contact', question: '' });
  function topicSlot(t) {
    if (iv.phase === 'topics' && t.id === 'experience' && iv.expLoop === 'ask') return { kind: 'loop', topic: 'experience', question: t.loopQ };
    if (t.kind === 'contact') return contactSlot();
    const kind = t.kind === 'photo' ? 'photo-talk' : t.kind === 'personal' ? 'personal' : 'answer';
    return { kind, topic: t.id, question: topicQ(t) };
  }
  function topicSpeech(t) {
    if (iv.phase === 'topics' && t.id === 'experience' && iv.expLoop === 'ask') return t.loopQ;
    if (t.id === 'experience' && iv.expLoop === 'more') return topicQ(t);
    return t.tts || t.q;
  }
  async function askTopic(opts) {
    const o = opts || {};
    const t = curTopic();
    if (!t || talkGate()) return;
    segStack = [];
    let text = o.speak === false ? '' : topicSpeech(t);
    // K1 also asks about an e-mail that was heard inside an earlier answer (it may have been cut short)
    const rb = t.kind === 'contact' ? activeReadback('email') : null;
    if (text && rb && rb.check) text += ' Cevabınızdan e-postanızı ' + rb.value + ' olarak yazdım. Doğru mu?';
    await talkSay(text, topicSlot(t));
  }
  /** Clears per-question UI state when the interview moves to another question. */
  function resetTopicUi() {
    iv.expLoop = '';
    ui.nudge = null;
    ui.readback = null;
    ui.phoneDraft = '';
    ui.contactWarned = false;
    ui.fixing = null;
  }
  function talkGoto(idx) {
    if (talkGate()) return;
    if (iv.draft.trim()) submitAnswer({ stay: true });
    iv.phase = 'topics';
    iv.idx = Math.max(0, Math.min(TOPICS.length - 1, idx));
    resetTopicUi();
    renderAll();
    save();
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
    if (conv.on) askTopic();
  }
  function selectedRepos() {
    return Array.isArray(iv.repos) ? iv.repos.filter((r) => r.selected) : [];
  }
  /** Sends the current answer to the AI queue and moves on (or nudges / asks about an earlier job). */
  function submitAnswer(opts) {
    const o = opts || {};
    const t = curTopic();
    if (!t || talkGate()) return;
    if (t.kind) { if (!o.stay) cardNext(t); return; }
    if (iv.phase === 'topics' && t.id === 'experience' && iv.expLoop === 'ask') { if (!o.stay) loopAnswer(false); return; }
    const text = iv.draft.trim();
    const repos = t.github || t.id === 'projects' ? selectedRepos() : [];
    const sentRepos = repos.filter((r) => !r.sent);
    if (text || sentRepos.length) {
      recordAnswer(t.id, t.q, text);
      enqueue({
        topic: t.id, question: topicQ(t),
        answer: text || 'GitHub’dan seçtiğim projeleri ekle.',
        repoNames: sentRepos.length ? sentRepos.map((r) => r.name) : null, ghUser: iv.ghUser,
      });
      sentRepos.forEach((r) => { r.sent = true; });
    }
    const nudgedNow = !!(ui.nudge && ui.nudge.topic === t.id);
    iv.draft = '';
    segStack = [];
    if (o.stay) return;
    if (shouldNudge(t, text)) { startNudge(t); return; }
    if (iv.phase === 'topics' && t.id === 'experience' && (text || nudgedNow)) { askLoop(); return; }
    nextTopic();
  }
  /** Contact, personal and photo cards have no AI step. Contact is required but can be skipped on a second tap. */
  function cardNext(t) {
    if (t.kind === 'contact' && !filled(cv.phone) && !filled(cv.email) && !ui.contactWarned) {
      ui.contactWarned = true;
      renderAll();
      if (conv.on) talkSay(CONTACT_WARN, contactSlot());
      else toast(CONTACT_WARN, 5000);
      return;
    }
    nextTopic();
  }
  const CONTACT_WARN = 'Telefon ya da e-posta olmadan işverenler size ulaşamaz. Yine de geçmek için Sıradaki’ye tekrar dokunun ya da “sonraki” deyin.';
  // Short-answer nudge (brief §2.4.8): once per topic, the short answer itself is still sent.
  function shouldNudge(t, text) {
    return iv.phase === 'topics' && !!text && !!NUDGE_TOPICS[t.id] && !iv.nudged[t.id] && wordCount(iv.answers[t.id] || text) < NUDGE_MIN_WORDS;
  }
  const nudgeText = (t) => 'Güzel başlangıç. Biraz daha anlatır mısınız? Örneğin ' + (t.more || 'her gün ne yaptığınızı ve bir başarınızı') + '.';
  function startNudge(t) {
    iv.nudged[t.id] = true;
    ui.nudge = { topic: t.id, text: nudgeText(t) };
    save();
    renderAll();
    if (conv.on) talkSay(ui.nudge.text, topicSlot(t));
    else focusAnswer();
  }
  // Experience loop (brief §2.3 T2): one job per take, then “was there one before that?”.
  function askLoop() {
    iv.expLoop = 'ask';
    ui.nudge = null;
    save();
    renderAll();
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
    if (conv.on) askTopic();
  }
  function loopAnswer(yes, seg) {
    if (!yes) { iv.expLoop = ''; nextTopic(); return; }
    iv.expLoop = 'more';
    ui.loopBase = cv.jobs.length;
    iv.draft = seg ? String(seg).trim() : '';
    save();
    renderAll();
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
    if (conv.on) askTopic({ speak: !seg });
    else focusAnswer();
  }
  function nextTopic() {
    cancelAdv();
    resetTopicUi();
    if (iv.phase === 'followups') {
      iv.fIdx++;
      if (iv.fIdx >= iv.followups.length) { finalizeCv(); return; }
    } else {
      if (iv.idx >= TOPICS.length - 1) { startFollowups(); return; }
      iv.idx++;
    }
    renderAll();
    save();
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
    if (conv.on) askTopic();
  }
  function prevTopic() {
    cancelAdv();
    if (talkGate()) {
      if (ui.pickProfile && iv.profile) { ui.pickProfile = false; renderAll(); return; }
      leaveTalk(); goStep(0); return;
    }
    // What was said here belongs to this question: it is sent with it (as the topic chips do), never
    // carried into the previous question's box.
    if (iv.draft.trim()) submitAnswer({ stay: true });
    if (iv.phase === 'topics' && iv.expLoop) {
      iv.expLoop = ''; ui.nudge = null;
      renderAll(); save();
      if (conv.on) askTopic();
      return;
    }
    resetTopicUi();
    if (iv.phase === 'followups') {
      if (iv.fIdx > 0) { iv.fIdx--; renderAll(); if (conv.on) askTopic(); return; }
      iv.phase = 'topics';
      iv.idx = TOPICS.length - 1;
    } else if (iv.idx > 0) iv.idx--;
    else { leaveTalk(); goStep(0); return; }
    renderAll();
    save();
    if (conv.on) askTopic();
  }
  /** Follow-up chips: “Hatırlamıyorum” and “Geç” both move on; nothing is sent. */
  function skipFollowup(dontKnow) {
    const t = curTopic();
    if (dontKnow && t) iv.answers.followup = (iv.answers.followup ? iv.answers.followup + '\n' : '') + t.q + ' → (hatırlamıyorum)';
    iv.draft = '';
    segStack = [];
    nextTopic();
  }
  async function startFollowups() {
    if (conv.on || rec.wanted || conv.speaking) stopConvo();
    const gen = dataGen;
    iv.phase = 'waiting';
    renderAll();
    save();
    await queueIdle();
    if (gen !== dataGen || iv.phase !== 'waiting') return;
    let qs = [];
    try {
      aiState.busy = 'review';
      renderAll();
      const r = await aiCall('review', { cv: AI.toAI(cv), hints: iv.hints.slice(-MAX_HINTS) });
      if (gen !== dataGen) return;
      qs = Array.isArray(r.followups) ? r.followups.filter((x) => typeof x === 'string' && x.trim()).slice(0, 5) : [];
    } catch (e) {
      if (gen !== dataGen) return;
      if (e.code === 'access_code') { aiState.status = 'code'; aiState.busy = ''; renderAll(); return; }
      qs = [];
    } finally { if (gen === dataGen) aiState.busy = ''; }
    if (iv.phase !== 'waiting') return;
    if (!qs.length) { finalizeCv(); return; }
    iv.followups = qs;
    iv.fIdx = 0;
    iv.phase = 'followups';
    renderAll();
    save();
    // The tab may be in the background by now (the person switched apps while we waited): then the
    // questions wait on screen and nothing is spoken or recorded until they tap the mic.
    if ((micUsable() || ttsOn()) && !D.hidden) {
      conv.on = true; conv.mode = 'talk'; keepAwake();
      if (!(await talkSay('Birkaç eksik kaldı. ' + qs.length + ' kısa soru soracağım.', null))) return;
      askTopic();
    }
  }
  async function finalizeCv() {
    if (conv.on || rec.wanted || conv.speaking) stopConvo();
    const gen = dataGen;
    iv.phase = 'finalizing';
    renderAll();
    save();
    await queueIdle();
    if (gen !== dataGen || iv.phase !== 'finalizing') return;
    try {
      aiState.busy = 'finalize';
      renderAll();
      const base = snapCv(cv);
      const r = await aiCall('finalize', { cv: AI.toAI(base) });
      if (gen !== dataGen) return;
      applyAiCv(r.cv, base);
    } catch (e) {
      if (gen !== dataGen) return;
      if (e.code === 'access_code') { aiState.status = 'code'; aiState.busy = ''; renderAll(); return; }
      if (e.code !== 'consent') toast('Son düzenleme yapılamadı; CV şimdiki hâliyle hazır. ' + (e.message || ''), 6000);
    } finally { if (gen === dataGen) aiState.busy = ''; }
    iv.phase = 'done';
    iv.finalized = true;
    save();
    leaveTalk();
    goStep(LAST);
    toast('CV’niz hazır. Şablonu seçip PDF olarak indirebilirsiniz.', 5000);
    if (ttsOn() && !D.hidden) speakNow('CV’niz hazır. İsterseniz söyleyerek değişiklik yapabilir ya da PDF olarak indirebilirsiniz.', conv.token);
  }

  // ---- speech in talk mode
  const TALK_SLOTS = { answer: 1, 'photo-talk': 1, contact: 1, personal: 1, loop: 1 };
  // Acknowledgements around an end word (“Tamam, bitti.”, “bitti tamam”, “evet bu kadar”) are not content.
  const ACK_HEAD = /^((tamam|tamamdir|ok|okay|okey|peki|evet|hah) )+/;
  const ACK_TAIL = /( (tamam|tamamdir|ok|okay|okey|peki))+$/;
  const TALK_END_MORE = /^(bu kadar|hepsi bu|cevabim bu kadar|benim cevabim bu kadar|bu kadar bitti|bitti bu kadar|hepsi bu kadar)$/;
  /** Does this folded segment end the answer? A lone “tamam” never does (TALK_FILLER, critic C5). */
  function isEndWord(k) {
    const c = String(k || '').replace(ACK_HEAD, '').replace(ACK_TAIL, '').replace(/^(bitti|devam|sonraki)( \1)+$/, '$1');
    return TALK_END.test(c) || TALK_END_MORE.test(c);
  }
  /** Keeps what was said for a topic in iv.answers (follow-ups with their question). */
  function recordAnswer(topic, question, text) {
    iv.answers[topic] = (iv.answers[topic] ? iv.answers[topic] + '\n' : '') + (topic === 'followup' ? question + ' → ' : '') + text;
  }
  function onTalkFinal(seg, slot, current) {
    const k = fk(seg);
    const filler = TALK_FILLER.test(k);
    if (!current) {
      // Late words for a question we already left: keep them with that question (never commands or fillers).
      if (slot.kind === 'answer' && !filler && !isEndWord(k) && !DONT_KNOW.test(k) && !commandFor(seg) && seg.trim().length > 2) {
        const t = curTopic();
        // Back into the box only if that very question is still on screen: every follow-up shares the id
        // 'followup' and “Önceki işiniz” asks its own question, so the question text must match too.
        const same = t && ui.mode === 'talk' && (iv.phase === 'topics' || iv.phase === 'followups') && iv.expLoop !== 'ask' &&
          slot.topic === t.id && slot.question === topicQ(t);
        if (same) { appendDraft(seg); return; }
        recordAnswer(slot.topic, slot.question || '', seg);
        enqueue({ topic: slot.topic, question: slot.question || '', answer: seg });
      }
      return;
    }
    if (filler) return; // critic C5: “tamam” alone neither ends the answer nor goes into it
    cancelAdv();
    if (slot.kind === 'photo-talk') { onPhotoWord(seg, k); return; }
    if (slot.kind === 'contact') { onContactWord(seg, k); return; }
    if (slot.kind === 'personal') { onPersonalWord(seg, k); return; }
    if (slot.kind === 'loop') { onLoopWord(seg, k); return; }
    if (isEndWord(k)) { submitAnswer(); return; }
    if (iv.phase === 'followups' && DONT_KNOW.test(k)) { skipFollowup(true); return; }
    const cmd = commandFor(seg);
    if (cmd) {
      if (cmd === 'next') { submitAnswer(); return; }
      if (cmd === 'skip' || cmd === 'no') { if (!iv.draft.trim() || cmd === 'skip') { submitAnswer(); return; } }
      else if (cmd === 'back') { prevTopic(); return; }
      else if (cmd === 'clear') { iv.draft = ''; segStack = []; syncAnswerBox(); save(); toast('Yanıt temizlendi.'); return; }
      else if (cmd === 'undo') { const n = segStack.pop(); if (n != null) { iv.draft = iv.draft.slice(0, n).trimEnd(); syncAnswerBox(); save(); toast('Son söylediğiniz silindi.'); } return; }
      else if (cmd === 'repeat') { askTopic(); return; }
      else if (cmd === 'stop') { stopConvo(); return; }
      else if (cmd === 'yes') {
        // A follow-up is often a yes/no question (“B sınıfı ehliyetiniz var mı?”): there “Evet” is the answer.
        if (iv.phase === 'followups') appendDraft(seg);
        return;
      }
    }
    // Pauses to think never end an answer: the person says “bitti” or taps Sıradaki when done.
    appendDraft(seg);
  }
  /** Shared navigation words for the tap cards. Returns true when handled. */
  function cardCommand(cmd, k) {
    if (cmd === 'back') { prevTopic(); return true; }
    if (cmd === 'stop') { stopConvo(); return true; }
    if (cmd === 'repeat') { askTopic(); return true; }
    if (isEndWord(k) || cmd === 'next' || cmd === 'skip') { submitAnswer(); return true; }
    return false;
  }
  function onPhotoWord(seg, k) {
    const cmd = commandFor(seg);
    if (cmd === 'back' || cmd === 'stop' || cmd === 'repeat') { cardCommand(cmd, k); return; }
    const a = gateAnswer({ kind: 'gate' }, seg, cmd);
    if (isEndWord(k) || a === 'no' || cmd === 'next' || (a === 'yes' && cv.photo)) nextTopic();
    else toast('Fotoğraf seçmek için düğmeye dokunun ya da “geç” deyin.');
  }
  function onPersonalWord(seg, k) {
    const cmd = commandFor(seg);
    if (cardCommand(cmd, k)) return;
    if (cmd === 'no') { submitAnswer(); return; }
    toast('Eklemek istediklerinize dokunun ya da “sonraki” deyin.');
  }
  // “Bundan önce çalıştığınız bir yer var mı?” — people often answer with the job itself, in one breath.
  const LOOP_NO = /^(hayir|yok|yoktur|baska yok|bu kadar|hepsi bu)( |$)/;
  const LOOP_YES_HEAD = /^[\s,.!]*((evet|var|tabii ki|tabii|tabi|olur|tamam|anlatayım|anlatayim|söyleyeyim|soyleyeyim)(?=[\s,.!]|$)[\s,.!]*)+/i;
  // words of a plain “yes, there is one more” (folded): no job in them yet
  const LOOP_BARE = new Set(['bir', 'iki', 'tane', 'yer', 'is', 'yeri', 'daha', 'baska', 'var', 'vardi', 'onceki', 'evet', 'sey', 'de', 'da',
    'hmm', 'sanirim', 'galiba', 'tabii', 'tabi', 'olur', 'anlatayim', 'soyleyeyim', 'tamam', 'mi', 'ki']);
  function onLoopWord(seg, k) {
    const cmd = commandFor(seg);
    if (cmd === 'back' || cmd === 'stop' || cmd === 'repeat') { cardCommand(cmd, k); return; }
    // a no near the start (“Hayır”, “Sanırım yok”); a “yok” deep in a description is part of the job
    if (LOOP_NO.test(k) || isEndWord(k) || k.split(' ').slice(0, 2).some((w) => w === 'hayir' || w === 'yok')) { loopAnswer(false); return; }
    // “Evet, 2015’ten 2018’e kadar Mavi Market’te kasiyerdim”: the yes comes with the earlier job — keep it.
    const rest = String(seg).replace(LOOP_YES_HEAD, '').trim();
    const words = fk(rest).split(' ').filter(Boolean);
    if (words.length >= 2 && words.some((w) => !LOOP_BARE.has(w))) { loopAnswer(true, rest); return; }
    const saidYes = rest !== String(seg).trim() || words.includes('var') || words.includes('vardi');
    const a = gateAnswer({ kind: 'more' }, seg, cmd);
    if (a === 'yes' || saidYes) { loopAnswer(true); return; }
    if (a === 'no') { loopAnswer(false); return; }
    toast('“Evet” ya da “hayır” deyin.');
  }

  // K1: a phone number by voice (read back before it counts), a dictated e-mail (read back too).
  const RB_LEAD = /^((tamam|peki|hmm|sey) )+/;
  const RB_YES = /^(evet|dogru|aynen|oyle|yes|correct|right)( |$)/;
  const RB_NO = /^(hayir|yanlis|duzelt|degil|no|wrong)( |$)/;
  const RB_NO_HEAD = /^[\s,.!]*(hayır|hayir|yanlış|yanlis|düzelt|duzelt|değil|degil)(?=[\s,.!]|$)[\s,.!]*/i;
  // words that may come with a spoken number and are not part of it (folded)
  const PHONE_WORDS = new Set(['telefon', 'telefonum', 'telefonumu', 'telefonu', 'numara', 'numaram', 'numarami', 'numarasi', 'numarasini',
    'cep', 'cebim', 'cepim', 'benim', 'evet', 've', 'yaz', 'yazin', 'olarak', 'arti', 'plus', 'alan', 'kodu', 'basinda', 'devami', 'devaminda',
    'sonra', 'sonu', 'su', 'iste', 'phone', 'number', 'my', 'is']);
  /** An e-mail said on the contact card; the whole segment is the address (“ayşe kaya seksen beş et gmail nokta com”). */
  function dictatedEmail(seg) {
    const sc = scrubText(seg, { whole: true });
    if (sc.found && typeof sc.found.email === 'string' && isEmail(sc.found.email)) return sc.found.email.toLowerCase();
    if (String(seg).indexOf('@') >= 0) { const em = normalizeContact('email', seg); if (isEmail(em)) return em; }
    return '';
  }
  /** Only number words, digits and words like “telefonum”: (part of) a phone number. “Bir dakika” is not. */
  function isPhoneSpeech(seg) {
    const n = String(normalizeContact('phone', seg) || '');
    if (!/\d/.test(n)) return false;
    return fk(n.replace(/[\d+]/g, ' ')).split(' ').every((w) => !w || PHONE_WORDS.has(w));
  }
  /** The read-back being answered: a phone/e-mail just read back, or an e-mail heard in an answer, not yet confirmed. */
  const emailNeedsCheck = () => !!iv.emailCheck && iv.emailCheck === cv.email && filled(cv.email);
  function activeReadback(key) {
    if (ui.readback && (!key || ui.readback.key === key)) return ui.readback;
    if ((!key || key === 'email') && emailNeedsCheck()) return { key: 'email', value: cv.email, check: true };
    return null;
  }
  function onContactWord(seg, k) {
    const cmd = commandFor(seg);
    const rb = activeReadback();
    if (rb) {
      const c = k.replace(RB_LEAD, '');
      if (RB_YES.test(c) || cmd === 'yes') { confirmReadback(true, false, rb.key); return; }
      if (RB_NO.test(c) || cmd === 'no') {
        // “Hayır, sıfır beş yüz otuz iki …”: the correction may come with the no
        const rest = String(seg).replace(RB_NO_HEAD, '').trim();
        const fix = rb.key === 'phone' && rest && isPhoneSpeech(rest);
        confirmReadback(false, false, rb.key, fix);
        if (fix) dictatePhone(rest);
        return;
      }
    }
    if (cardCommand(cmd, k)) return;
    // An e-mail first: “ayşe seksen beş et gmail nokta com” has digits but is no phone number.
    if (/(^| )(et|at|nokta|dot|kuyruklu)( |$)/.test(k) || String(seg).indexOf('@') >= 0) {
      const em = dictatedEmail(seg);
      if (em) { setContact('email', em); iv.emailCheck = ''; readBack('email', em); return; }
    }
    if (isPhoneSpeech(seg)) { dictatePhone(seg); return; }
    toast(rb ? '“Doğru” ya da “düzelt” deyin.' : 'Telefon numaranızı rakamlarla söyleyin ya da yazın.');
  }
  const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(v || ''));
  /** A Turkish mobile or landline in the app's format ("0532 123 45 67" / "+90 532 123 45 67"). */
  const isTrPhone = (v) => /^(0|\+90 )(5\d{2}|[2-4]\d{2}|850) \d{3} \d{2} \d{2}$/.test(String(v || '').trim());
  function normalizeContact(key, v) {
    if (!v || !String(v).trim()) return v;
    try { return key === 'phone' ? P.normalizePhone(v) : key === 'email' ? P.normalizeEmail(v) : P.normalizeUrl(v); } catch (_) { return v; }
  }
  function setContact(key, v) {
    cv[key] = v;
    afterChange();
    const el = D.getElementById('k-' + key);
    if (el && el.value !== v) el.value = v;
  }
  /**
   * Phone by voice. On phones every pause ends an utterance, so a number said in groups arrives in pieces:
   * they are joined (ui.phoneDraft) and shown, the mic stays open, and only a whole Turkish number goes into
   * the field and is read back. A piece, or anything that is not a number, never replaces the phone.
   */
  function dictatePhone(seg) {
    let v = normalizeContact('phone', ui.phoneDraft ? ui.phoneDraft + ' ' + seg : seg);
    if (!isTrPhone(v) && ui.phoneDraft && isTrPhone(normalizeContact('phone', seg))) v = normalizeContact('phone', seg); // said again, whole
    if (isTrPhone(v)) {
      ui.phoneDraft = '';
      setContact('phone', v);
      readBack('phone', v);
      return;
    }
    const digits = String(v).replace(/\D/g, '');
    const room = digits.length < 11 || (digits.length === 11 && /^90/.test(digits)); // +90 numbers have 12 digits
    if (room) {
      ui.phoneDraft = ui.phoneDraft ? ui.phoneDraft + ' ' + seg : seg;
      ui.readback = null;
      refreshContactFields();
      refreshMicUi();
      return; // keep listening for the rest of the number
    }
    ui.phoneDraft = '';
    ui.readback = null;
    refreshContactFields();
    talkSay('Numarayı tam anlayamadım. Numaranızı yeniden söyleyin ya da yazın.', contactSlot());
  }
  function readBack(key, v) {
    ui.readback = { key, value: v };
    renderAll();
    talkSay((key === 'phone' ? 'Telefonunuzu ' : 'E-postanızı ') + v + ' olarak yazdım. Doğru mu?', contactSlot());
  }
  /** Doğru / Düzelt for a read-back (`key` picks which one; `quiet`: a spoken correction follows at once). */
  function confirmReadback(ok, byTap, key, quiet) {
    const rb = activeReadback(key);
    if (!rb) return;
    if (ui.readback === rb) ui.readback = null;
    if (rb.key === 'email') iv.emailCheck = '';
    if (ok) { save(); renderAll(); toast(rb.key === 'phone' ? 'Telefon numaranız kaydedildi.' : 'E-postanız kaydedildi.'); return; }
    if (!byTap) setContact(rb.key, '');
    save();
    renderAll();
    if (byTap) { const el = D.getElementById('k-' + rb.key); if (el) { el.focus(); try { el.select(); } catch (_) { /* ignore */ } } }
    else if (conv.on && !quiet) talkSay(rb.key === 'phone' ? 'Numarayı yeniden söyleyin ya da yazın.' : 'E-postanızı yazarak düzeltin.', contactSlot());
  }
  /** Updates the K1 fields and read-back rows in place (an answer may fill them while the card is open). */
  function refreshContactFields() {
    ['phone', 'email'].forEach((key) => {
      const el = D.getElementById('k-' + key);
      if (el && el !== D.activeElement && el.value !== (cv[key] || '')) el.value = cv[key] || '';
      const box = D.getElementById('rb-' + key);
      if (box) box.replaceChildren(...[readbackRow(key)].filter(Boolean));
    });
    const hint = $('#email-hint'); if (hint) hint.hidden = emailMatchesName();
  }
  /** Does the e-mail's local part contain part of the person's name? (soft hint, never a block) */
  function emailMatchesName(email, name) {
    const em = String(email == null ? cv.email : email).trim();
    const nm = fk(name == null ? cv.name : name);
    if (!em || !nm || em.indexOf('@') < 1) return true;
    const local = fk(em.split('@')[0]).replace(/ /g, '');
    return nm.split(' ').filter((w) => w.length >= 3).some((w) => local.indexOf(w.slice(0, 4)) >= 0);
  }
  function appendDraft(seg) {
    segStack.push(iv.draft.length);
    iv.draft = (iv.draft.trim() ? iv.draft.trimEnd() + ' ' : '') + String(seg).trim();
    syncAnswerBox();
    saveDraftSoon();
  }
  let draftTimer = 0;
  function saveDraftSoon() { clearTimeout(draftTimer); draftTimer = setTimeout(save, 800); }
  function syncAnswerBox() {
    const ta = $('#answer');
    if (ta && ta.value !== iv.draft) { ta.value = iv.draft; ta.scrollTop = ta.scrollHeight; }
    const hint = $('#answer-count');
    if (hint) hint.textContent = iv.draft.trim() ? wordCount(iv.draft) + ' kelime' : '';
  }


  // ---- talk view
  function renderTalk() {
    if (aiState.status === 'code') return h('section', { class: 'step talk' }, accessCard());
    const gate = talkGate();
    if (gate === 'profile') return profileView();
    if (gate === 'consent') return consentView();
    if (iv.phase === 'waiting' || iv.phase === 'finalizing') return renderWorking();
    const t = curTopic();
    if (!t) return renderWorking();
    const fu = iv.phase === 'followups';
    const loopAsk = !fu && t.id === 'experience' && iv.expLoop === 'ask';
    return h('section', { class: 'step talk', 'aria-labelledby': 'question' },
      fu ? null : h('div', { class: 'talk-top' }, topicChips(), profileChip()),
      h('div', { class: 'q-wrap' },
        h('p', { class: 'eyebrow', id: 'q-eyebrow' }, topicEyebrow(t)),
        h('h1', { class: 'question', id: 'question' }, noBreakHyphen(loopAsk ? t.loopQ : topicQ(t))),
        !loopAsk && t.lead ? h('p', { class: 'hint', id: 'q-hint' }, t.lead) : null),
      aiState.status === 'off' ? aiOffBanner() : null,
      voiceBanner(),
      needMicPrime() && !rec.wanted ? micPrimeCard() : null,
      loopAsk ? loopBlock(t) : topicBody(t),
      h('div', { class: 'feed', id: 'feed', 'aria-live': 'polite' }));
  }
  function topicEyebrow(t) {
    if (iv.phase === 'followups') return 'Eksik bilgi · ' + (iv.fIdx + 1) + ' / ' + iv.followups.length;
    const label = t.id === 'experience' && iv.expLoop === 'more' ? (t.moreLabel || 'Önceki işiniz') : t.label;
    if (t.kind) return label + (t.optional ? ' · isteğe bağlı' : '');
    return label + ' · Soru ' + spokenPos(iv.idx) + ' / ' + spokenTotal();
  }
  function topicBody(t) {
    if (t.kind === 'contact') return contactCard();
    if (t.kind === 'personal') return personalCard();
    if (t.kind === 'photo') return [t.note ? h('p', { class: 'nudge' }, t.note) : null, sayCard(t), photoPanel()];
    const prev = iv.answers[t.id];
    const ghOn = t.github || (t.id === 'projects' && !!cv.github);
    return [
      ui.nudge && ui.nudge.topic === t.id ? h('p', { class: 'nudge', role: 'status' }, ui.nudge.text) : null,
      sayCard(t),
      answerBox(t),
      iv.phase === 'followups' ? followupChips() : null,
      ghOn ? githubCard() : null,
      t.example ? h('details', { class: 'more example' }, h('summary', null, 'Örnek cevap göster'), h('p', { class: 'fine' }, '“' + t.example + '”')) : null,
      // “Önceki işiniz”: they already told one job and said there was another, so “never worked” no longer fits
      t.id === 'experience' && iv.expLoop === 'more'
        ? h('p', { class: 'fine' }, micUsable() ? 'Başka yoksa “bitti” deyin ya da Sıradaki’ye dokunun.' : 'Başka yoksa Sıradaki’ye dokunun.')
        : t.skip ? h('p', { class: 'fine' }, t.skip) : null,
      prev ? h('details', { class: 'more' }, h('summary', null, 'Bu soruya daha önce söyledikleriniz'),
        h('p', { class: 'fine prev-answer' }, prev), h('p', { class: 'mini-note' }, 'Yeni söyledikleriniz bunlara eklenir; düzeltme de söyleyebilirsiniz.')) : null,
    ];
  }
  function profileView() {
    return h('section', { class: 'step talk', 'aria-labelledby': 'question' },
      h('div', { class: 'q-wrap' },
        h('p', { class: 'eyebrow' }, 'Başlamadan önce'),
        h('h1', { class: 'question', id: 'question' }, 'Sizi en iyi hangisi anlatıyor?'),
        h('p', { class: 'hint' }, 'Sorular buna göre değişir. Sonra değiştirebilirsiniz.')),
      h('div', { class: 'profile-grid', role: 'group', 'aria-label': 'Profiliniz' }, PROFILES.map((p) => h('button', {
        type: 'button', class: 'profile-btn', 'aria-pressed': iv.profile === p.id ? 'true' : 'false', dataset: { fkey: 'profile-' + p.id },
        onclick: () => chooseProfile(p.id),
      }, icon(p.icon), h('span', null, p.label)))),
      iv.profile ? h('div', { class: 'btn-row' }, h('button', {
        type: 'button', class: 'btn small', onclick: () => { ui.pickProfile = false; renderAll(); },
      }, 'Vazgeç')) : null);
  }
  function consentView() {
    return h('section', { class: 'step talk', 'aria-labelledby': 'question' },
      h('p', { class: 'eyebrow' }, 'Başlamadan önce'),
      consentCard({
        yes: () => { SP.cancelSpeech(); giveConsent(); runQueue(); talkProceed(); },
        no: () => {
          SP.cancelSpeech();
          if (!Object.keys(iv.answers).length && !iv.pending.length) iv.started = false;
          leaveTalk();
          goStep(1);
          toast('Yapay zekâ kullanılmayacak. Soruları tek tek yanıtlayarak doldurabilirsiniz.', 5000);
        },
      }, '', true));
  }
  function profileChip() {
    const p = PROFILES.find((x) => x.id === iv.profile);
    if (!p) return null;
    return h('p', { class: 'profile-chip' }, 'Profil: ', h('b', null, p.short), ' · ',
      h('button', {
        type: 'button', class: 'link-btn', dataset: { fkey: 'profile-change' }, 'aria-label': 'Profili değiştir', onclick: () => {
          if (rec.wanted || conv.speaking || conv.on) stopConvo();
          ui.pickProfile = true;
          renderAll();
          window.scrollTo({ top: 0, behavior: scrollBehavior() });
        },
      }, 'Değiştir'));
  }
  function topicDone(t) {
    if (t.kind === 'photo') return !!cv.photo;
    if (t.kind === 'contact') return filled(cv.phone) || filled(cv.email);
    if (t.kind === 'personal') return filled(cv.birth) || filled(cv.military) || filled(cv.marital);
    return !!iv.answers[t.id];
  }
  function topicChips() {
    return h('nav', { class: 'topic-chips', 'aria-label': 'Görüşme konuları' }, TOPICS.map((tp, i) => h('button', {
      type: 'button', class: 'tchip' + (i === iv.idx ? ' on' : '') + (topicDone(tp) ? ' done' : ''),
      'aria-current': i === iv.idx ? 'step' : null, dataset: { fkey: 'tchip-' + tp.id }, onclick: () => talkGoto(i),
    }, tp.label)));
  }
  function sayCard(t) {
    if (!t.say || !t.say.length) return null;
    return h('div', { class: 'say-card' },
      h('p', { class: 'say-title' }, t.sayTitle || 'Şunlardan bahsedebilirsiniz:'),
      h('ul', { class: 'say-list', id: 'say-list' }, t.say.map(([txt, ck]) => {
        const ok = tickOk(ck);
        return h('li', { class: ok ? 'ok' : null, dataset: { ck: ck || '' } }, txt, h('span', { class: 'sr' }, ok ? ' (CV’de var)' : ''));
      })));
  }
  function answerBox(t) {
    const ta = h('textarea', {
      id: 'answer', class: 'answer-box', rows: 6, value: iv.draft, 'aria-label': 'Yanıtınız',
      placeholder: micUsable() ? 'Mikrofona dokunun ve konuşun; söyledikleriniz burada yazıya dönüşür. İsterseniz yazabilirsiniz de.' : 'Yanıtınızı yazın ya da klavyedeki mikrofonla söyleyin.',
      oninput: (e) => { iv.draft = e.target.value; cancelAdv(); saveDraftSoon(); const c = $('#answer-count'); if (c) c.textContent = iv.draft.trim() ? wordCount(iv.draft) + ' kelime' : ''; },
    });
    return h('div', { class: 'answer-wrap' + (rec.wanted && conv.slot && conv.slot.kind === 'answer' ? ' is-listening' : '') },
      ta,
      h('div', { class: 'live', id: 'answer-live' }),
      h('div', { class: 'answer-meta' },
        h('span', { class: 'mini-note', id: 'answer-count' }, iv.draft.trim() ? wordCount(iv.draft) + ' kelime' : ''),
        h('span', { class: 'mini-note' }, (t.len ? t.len + ' ' : '') + (micUsable() ? 'Bitince “bitti” deyin ya da Sıradaki’ye dokunun.' : 'Bitince Sıradaki’ye dokunun.'))),
      micUsable() ? null : h('p', { class: 'mini-note' }, 'İpucu: Klavyenizdeki mikrofon tuşuna dokunarak konuşup yazdırabilirsiniz.'));
  }
  function loopBlock(t) {
    return h('div', { class: 'gate loop' },
      h('button', { type: 'button', class: 'btn primary', dataset: { fkey: 'loop-yes' }, onclick: () => loopAnswer(true) }, icon('plus'), 'Evet, anlatayım'),
      h('button', { type: 'button', class: 'btn', dataset: { fkey: 'loop-no' }, onclick: () => loopAnswer(false) }, 'Hayır, bu kadar'));
  }
  function followupChips() {
    return h('div', { class: 'chips fu-chips', role: 'group', 'aria-label': 'Hızlı cevaplar' },
      h('button', { type: 'button', class: 'chip big', dataset: { fkey: 'fu-dk' }, onclick: () => skipFollowup(true) }, 'Hatırlamıyorum'),
      h('button', { type: 'button', class: 'chip big', dataset: { fkey: 'fu-skip' }, onclick: () => skipFollowup(false) }, 'Geç'));
  }

  // K1 İletişim: typed (autofill works), phone by voice with read-back. Phone and e-mail never go to the AI;
  // LinkedIn and GitHub are part of the CV text the AI writes from.
  function contactCard() {
    const yz = iv.profile === 'yazilim';
    const listening = !!(rec.wanted && conv.slot && conv.slot.kind === 'contact');
    const phoneMic = micUsable() ? h('button', {
      type: 'button', class: 'mic-sm k-mic', 'aria-pressed': listening ? 'true' : 'false', dataset: { fkey: 'k-phone-mic' },
      'aria-label': listening ? 'Dinlemeyi durdur' : 'Telefon numaranızı söyleyin', title: 'Telefon numaranızı söyleyin',
      onclick: () => {
        if (rec.wanted && conv.slot && conv.slot.kind === 'contact') { stopConvo(); return; }
        conv.on = true; conv.mode = 'talk'; keepAwake();
        talkSay('', contactSlot());
      },
    }, icon(listening ? 'pause' : 'mic')) : null;
    const gh = kField('github', 'GitHub', { type: 'url', inputmode: 'url', autocomplete: 'url', autocapitalize: 'none', spellcheck: 'false', placeholder: 'github.com/kullaniciadi' }, null, true);
    return h('div', { class: 'k-card' },
      h('div', { class: 'fields' },
        kField('phone', 'Telefon', { type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '0532 123 45 67' }, phoneMic),
        kField('email', 'E-posta', { type: 'email', inputmode: 'email', autocomplete: 'email', autocapitalize: 'none', spellcheck: 'false', placeholder: 'ayse.kaya@gmail.com' }),
        h('p', { class: 'mini-note soft-hint', id: 'email-hint', hidden: emailMatchesName() }, 'İşverenler adınızla oluşturulmuş bir e-postayı daha ciddi bulur.'),
        kField('web', 'LinkedIn', { type: 'url', inputmode: 'url', autocapitalize: 'none', spellcheck: 'false', placeholder: 'linkedin.com/in/aysekaya' }, null, true),
        yz ? gh : null),
      yz ? null : h('details', { class: 'more', open: filled(cv.github) }, h('summary', null, 'Diğer'), h('div', { class: 'fields' }, gh)),
      ui.contactWarned && !filled(cv.phone) && !filled(cv.email) ? h('p', { class: 'nudge', role: 'status' }, CONTACT_WARN) : null,
      h('p', { class: 'fine' }, 'Telefonunuz ve e-postanız yalnızca bu cihazda kalır; yapay zekâya gönderilmez. LinkedIn ve GitHub adresleriniz CV’nizle birlikte gönderilir.'));
  }
  function kField(key, label, attrs, extra, optional) {
    const id = 'k-' + key;
    const input = h('input', Object.assign({ id, class: 'input', dataset: { fkey: id } }, attrs));
    input.value = cv[key] || '';
    input.addEventListener('input', () => {
      cv[key] = input.value;
      // typing takes over from a read-back, a half-said number or an e-mail heard in an answer
      const was = !!(activeReadback(key) || (key === 'phone' && ui.phoneDraft));
      if (ui.readback && ui.readback.key === key) ui.readback = null;
      if (key === 'phone') ui.phoneDraft = '';
      if (key === 'email') iv.emailCheck = '';
      if (was) { const rb = D.getElementById('rb-' + key); if (rb) rb.replaceChildren(); }
      afterChange();
      if (key === 'email') refreshEmailHint();
    });
    input.addEventListener('change', () => {
      const n = normalizeContact(key, input.value);
      if (n !== input.value) { input.value = n; cv[key] = n; afterChange(); }
      if (key === 'email') refreshEmailHint();
    });
    return h('div', { class: 'field', dataset: { kfield: key } },
      h('label', { class: 'field-label', for: id }, label, optional ? h('span', { class: 'opt' }, 'isteğe bağlı') : null),
      h('div', { class: 'field-row' }, input, extra || null),
      h('div', { class: 'live', id: id + '-live' }),
      h('div', { id: 'rb-' + key }, readbackRow(key)));
  }
  function refreshEmailHint() { const el = $('#email-hint'); if (el) el.hidden = emailMatchesName(); }
  function readbackRow(key) {
    const rb = activeReadback(key);
    if (!rb) {
      // a number said in groups, still coming in: shown, not yet written into the field
      if (key === 'phone' && ui.phoneDraft) {
        return h('p', { class: 'mini-note readback-partial', role: 'status' }, 'Duyduğum: ', h('b', null, normalizeContact('phone', ui.phoneDraft)), ' … Devamını söyleyin.');
      }
      return null;
    }
    return h('div', { class: 'readback', role: 'status' },
      h('p', null, rb.check ? 'Cevabınızdan e-postanızı ' : key === 'phone' ? 'Telefonunuzu ' : 'E-postanızı ', h('b', null, rb.value), ' olarak yazdım. Doğru mu?'),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn small primary', dataset: { fkey: 'rb-yes-' + key }, onclick: () => confirmReadback(true, true, key) }, 'Doğru'),
        h('button', { type: 'button', class: 'btn small', dataset: { fkey: 'rb-no-' + key }, onclick: () => confirmReadback(false, true, key) }, 'Düzelt')));
  }

  // K2 Kişisel: tap only, everything off by default. Never TC kimlik, kan grubu, din or sağlık.
  const MONTH_DATIVE = { ocak: 'a', subat: 'a', mart: 'a', nisan: 'a', mayis: 'a', haziran: 'a', temmuz: 'a', agustos: 'a', eylul: 'e', ekim: 'e', kasim: 'a', aralik: 'a' };
  /** Dative suffix for a year as it is read aloud: 2027 → "ye" (yirmi yedi'ye), 2030 → "a" (otuz'a). */
  function yearDative(y) {
    const n = Number(y) || 0;
    const ones = ['', 'e', 'ye', 'e', 'e', 'e', 'ya', 'ye', 'e', 'a'];
    const tens = ['', 'a', 'ye', 'a', 'a', 'ye', 'a', 'e', 'e', 'a'];
    if (n % 10) return ones[n % 10];
    if (Math.floor(n / 10) % 10) return tens[Math.floor(n / 10) % 10];
    return 'e'; // "bin" / "yüz"
  }
  /** "Haziran 2027" → "Haziran 2027'ye kadar"; anything else → "… tarihine kadar". */
  function untilPhrase(d) {
    const s = String(d || '').trim();
    const y = /(\d{4})$/.exec(s);
    if (y) return s + '\'' + yearDative(y[1]) + ' kadar';
    const last = fk(s).split(' ').pop();
    if (MONTH_DATIVE[last]) return s + '\'' + MONTH_DATIVE[last] + ' kadar';
    return s + ' tarihine kadar';
  }
  function parseMilitary(s) {
    const v = String(s || '').trim();
    const k = fk(v);
    if (/^yapildi/.test(k)) { const y = /(\d{4})/.exec(v); return { kind: 'Yapıldı', detail: y ? y[1] : '' }; }
    if (/^tecil/.test(k)) {
      const m = /\((.*)\)/.exec(v);
      const d = m ? m[1].replace(/\s+tarihine\s+kadar$/i, '').replace(/['’][a-zçğıöşü]{1,3}\s+kadar$/i, '').trim() : '';
      return { kind: 'Tecilli', detail: d };
    }
    if (/^muaf/.test(k)) return { kind: 'Muaf', detail: '' };
    return { kind: v ? 'other' : '', detail: v };
  }
  /** "Yapıldı (2021)" · "Tecilli (Haziran 2027'ye kadar)" · "Muaf" */
  function composeMilitary(kind, detail) {
    const d = String(detail || '').trim();
    if (kind === 'Yapıldı') { const y = /(\d{4})/.exec(d); return y ? 'Yapıldı (' + y[1] + ')' : 'Yapıldı'; }
    if (kind === 'Tecilli') return d ? 'Tecilli (' + untilPhrase(d) + ')' : 'Tecilli';
    if (kind === 'Muaf') return 'Muaf';
    return d;
  }
  function personalCard() {
    const k2 = ui.k2 || (ui.k2 = {});
    const on = (key) => filled(cv[key]) || !!k2[key];
    const flip = (key) => (v) => {
      k2[key] = v;
      if (!v && filled(cv[key])) { cv[key] = ''; afterChange(); }
      renderAll();
      if (v) { const el = D.getElementById('k2-' + key); if (el) el.focus({ preventScroll: true }); }
    };
    const rows = [
      switchRow('k2-birth-sw', 'Doğum yılı', 'Yalnızca yıl yazılır.', on('birth'), flip('birth')),
      on('birth') ? birthInput() : null,
      switchRow('k2-military-sw', 'Askerlik durumu', 'Yapıldı, tecilli ya da muaf.', on('military'), flip('military')),
      on('military') ? militaryBlock() : null,
      switchRow('k2-license-sw', 'Sürücü belgesi', filled(cv.license) ? 'Belgeler sorusundan geldi; kontrol edin.' : 'Örneğin B sınıfı.', on('license'), flip('license')),
      on('license') ? licenseBlock() : null,
    ];
    return h('div', { class: 'k-card' },
      h('div', { class: 'opts k2' }, rows),
      h('details', { class: 'more', open: filled(cv.marital) }, h('summary', null, 'Diğer'),
        h('div', { class: 'k2-sub' },
          h('p', { class: 'field-label' }, 'Medeni durum'),
          h('div', { class: 'chips', role: 'group', 'aria-label': 'Medeni durum' }, ['Bekâr', 'Evli'].map((c) => h('button', {
            type: 'button', class: 'chip big', 'aria-pressed': cv.marital === c ? 'true' : 'false', dataset: { fkey: 'k2-marital-' + c },
            onclick: () => { cv.marital = cv.marital === c ? '' : c; afterChange(); renderAll(); },
          }, c))),
          h('p', { class: 'mini-note' }, 'Çoğu işveren sormaz; eklemeniz önerilmez.'))),
      h('p', { class: 'fine' }, 'Doğum yılı, askerlik ve medeni durum yalnızca bu cihazda kalır; yapay zekâya gönderilmez. Sürücü belgesi CV’nizle birlikte gönderilir.'));
  }
  function birthInput() {
    const y = /(19|20)\d{2}/.exec(cv.birth || '');
    const input = h('input', {
      id: 'k2-birth', class: 'input', type: 'text', inputmode: 'numeric', maxlength: '4', autocomplete: 'bday-year', placeholder: '1990',
      'aria-label': 'Doğum yılı', dataset: { fkey: 'k2-birth' },
      value: y ? y[0] : (cv.birth || ''),
    });
    const note = h('p', { class: 'mini-note' });
    input.addEventListener('input', () => {
      const d = input.value.replace(/\D/g, '').slice(0, 4);
      if (d !== input.value) input.value = d;
      cv.birth = d;
      afterChange();
      const n = Number(d);
      note.textContent = d.length === 4 && (n < 1940 || n > new Date().getFullYear() - 14) ? 'Bu yıl doğru mu? Dört haneli doğum yılınızı yazın.' : '';
    });
    return h('div', { class: 'k2-sub' }, input, note);
  }
  function militaryBlock() {
    const m = parseMilitary(cv.military);
    const preview = h('p', { class: 'mini-note' }, filled(cv.military) ? 'CV’de: ' + cv.military : '');
    const set = (kind, detail) => { cv.military = composeMilitary(kind, detail); afterChange(); preview.textContent = cv.military ? 'CV’de: ' + cv.military : ''; };
    const detailInput = (ph, label, digits) => {
      const el = h('input', {
        id: 'k2-military-detail', class: 'input', type: 'text', inputmode: digits ? 'numeric' : 'text', placeholder: ph, 'aria-label': label,
        dataset: { fkey: 'k2-military-detail' }, value: m.detail,
      });
      el.addEventListener('input', () => set(m.kind, digits ? el.value.replace(/\D/g, '').slice(0, 4) : el.value));
      el.addEventListener('change', () => { if (!digits) { const n = P.normalizeDate(el.value); if (n && n !== el.value) { el.value = n; set(m.kind, n); } } });
      return h('label', { class: 'k2-detail' }, h('span', { class: 'mini-note' }, label), el);
    };
    return h('div', { class: 'k2-sub', id: 'k2-military' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Askerlik durumu' }, ['Yapıldı', 'Tecilli', 'Muaf'].map((x) => h('button', {
        type: 'button', 'aria-pressed': m.kind === x ? 'true' : 'false', dataset: { fkey: 'k2-mil-' + x },
        onclick: () => { set(x, m.kind === x ? m.detail : ''); renderAll(); },
      }, x))),
      m.kind === 'Yapıldı' ? detailInput('2021', 'Hangi yıl? (isteğe bağlı)', true) : null,
      m.kind === 'Tecilli' ? detailInput('Haziran 2027', 'Ne zamana kadar?', false) : null,
      preview);
  }
  function licenseBlock() {
    const input = h('input', {
      id: 'k2-license', class: 'input', type: 'text', placeholder: 'Örn. B sınıfı', 'aria-label': 'Sürücü belgesi sınıfı',
      dataset: { fkey: 'k2-license' }, value: cv.license || '',
    });
    input.addEventListener('input', () => { cv.license = input.value; afterChange(); });
    input.addEventListener('change', () => {
      const n = mapChoice({ type: 'license' }, input.value, false);
      if (n && n !== input.value) { input.value = n; cv.license = n; afterChange(); }
    });
    return h('div', { class: 'k2-sub' }, input,
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Sık kullanılan sınıflar' }, ['B sınıfı', 'C sınıfı', 'CE sınıfı', 'A2 ve B sınıfı'].map((c) => h('button', {
        type: 'button', class: 'chip big', 'aria-pressed': cv.license === c ? 'true' : 'false', dataset: { fkey: 'k2-lic-' + c },
        onclick: () => { cv.license = cv.license === c ? '' : c; afterChange(); renderAll(); },
      }, c))));
  }

  // ---- feed: what the AI understood, with “Doğru yazdım mı?” for names it was unsure of
  function renderFeed(force) {
    const box = $('#feed');
    if (!box) { refreshTalkStatus(); refreshFinalQueue(); return; }
    const a = D.activeElement;
    if (!force && a && box.contains(a) && a.tagName === 'INPUT') { ui.feedDirty = true; refreshTalkStatus(); return; } // typing a fix
    ui.feedDirty = false;
    const items = [];
    if (iv.pending.length) {
      items.push(h('div', { class: 'feed-item busy' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        h('span', null, !hasConsent() ? 'Yanıtlarınız kaydedildi; onay verdiğinizde işlenecek.' : iv.pending.length === 1 ? 'Son yanıtınız işleniyor…' : iv.pending.length + ' yanıt işleniyor…')));
    }
    const t = ui.mode === 'talk' && iv.phase === 'topics' ? curTopic() : null;
    if (t && t.id === 'contact' && iv.feed.some((f) => f.topic === 'about' && f.kind === 'ok')) items.push(contactCheck());
    iv.feed.slice(0, 4).forEach((f) => {
      items.push(h('div', { class: 'feed-item ' + (f.kind === 'err' ? 'err' : 'ok') },
        h('span', { class: 'feed-ico', 'aria-hidden': 'true' }, f.kind === 'err' ? '!' : '✓'),
        h('div', null, h('span', { class: 'feed-topic' }, topicLabel(f.topic)), ' ', f.text,
          f.kind === 'err' && f.job ? [' ', h('button', { type: 'button', class: 'text-btn', onclick: () => retryFailed(f.job) }, 'Tekrar dene')] : null,
          confirmRow(f))));
    });
    keepFocus(() => box.replaceChildren(...items));
    refreshTalkStatus();
  }
  function confirmRow(f) {
    if (!f.confirm || !f.confirm.length || f.cdone) return null;
    if (ui.fixing === f.id) return fixForm(f);
    return h('div', { class: 'confirm-row' },
      h('span', null, 'Doğru yazdım mı? ', h('b', null, f.confirm.join(' · '))),
      h('span', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn small', dataset: { fkey: 'fix-' + f.id }, onclick: () => {
          ui.fixing = f.id; ui.focusKey = 'fixin-' + f.id + '-0'; renderFeed(true);
        } }, 'Düzelt'),
        h('button', { type: 'button', class: 'text-btn', onclick: () => { settleNames(f.confirm); save(); renderFeed(); } }, 'Doğru')));
  }
  function fixForm(f) {
    const inputs = f.confirm.map((name, i) => h('input', {
      class: 'input', type: 'text', value: name, autocomplete: 'off', 'aria-label': '“' + name + '” adının doğru yazımı', dataset: { fkey: 'fixin-' + f.id + '-' + i },
    }));
    const close = () => { ui.fixing = null; renderFeed(true); };
    const form = h('form', {
      class: 'fix-form', onsubmit: (e) => { e.preventDefault(); submitFix(f, inputs.map((x) => x.value)); },
    },
    f.confirm.map((name, i) => h('label', { class: 'fix-row' }, h('span', { class: 'mini-note' }, (f.confirm.length > 1 ? '“' + name + '” · ' : '') + 'Doğru yazımı:'), inputs[i])),
    h('div', { class: 'btn-row' },
      h('button', { type: 'submit', class: 'btn small primary' }, 'Kaydet'),
      h('button', { type: 'button', class: 'btn small', onclick: close }, 'Vazgeç')));
    // Re-render the feed once focus has really left the form (the queue may have updated meanwhile).
    form.addEventListener('focusout', () => setTimeout(() => { if (ui.feedDirty && !form.contains(D.activeElement)) renderFeed(); }, 300));
    return form;
  }
  const nameSettled = (n) => iv.okNames.some((x) => fk(x) === fk(n));
  /** Names the person confirmed or corrected are never asked about again, in any card. */
  function settleNames(names) {
    (names || []).forEach((n) => { if (!nameSettled(n)) iv.okNames.push(n); });
    iv.okNames = iv.okNames.slice(-80);
    iv.feed.forEach((x) => {
      if (!x.confirm || x.cdone) return;
      x.confirm = x.confirm.filter((n) => !nameSettled(n));
      if (!x.confirm.length) x.cdone = true;
    });
  }
  function submitFix(f, vals) {
    let n = 0;
    f.confirm.forEach((name, i) => {
      const v = String(vals[i] || '').trim();
      if (!v || v === name) return;
      enqueue({ topic: 'followup', question: '‘' + name + '’ adının doğru yazımı nedir?', answer: v });
      n++;
    });
    settleNames(f.confirm);
    ui.fixing = null;
    save();
    renderFeed(true);
    toast(n ? 'Düzeltme işleniyor.' : 'Değişiklik yapılmadı.');
  }
  // T1 heard back on the contact card: name, title and city as the AI understood them.
  const ABOUT_FIELDS = [['name', 'Ad Soyad'], ['title', 'Meslek'], ['city', 'Şehir']];
  function contactCheck() {
    const rows = [];
    ABOUT_FIELDS.forEach(([k, label]) => {
      const v = (cv[k] || '').trim();
      rows.push(h('dt', null, label), h('dd', { class: v ? '' : 'missing' }, v || 'eksik'));
    });
    return h('div', { class: 'check-card' },
      h('h3', null, 'Anladıklarım · kontrol edin'),
      h('dl', { class: 'kv' }, rows),
      h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn small', onclick: () => openQuickEdit('Ad, meslek ve şehir', ABOUT_FIELDS.map((x) => x[0])) }, 'Düzelt')));
  }
  function cvAsTextSections(c) {
    const L = PDF.labels(settings.lang);
    const out = [];
    const range = (a, b) => P.formatRange(a, b, settings.lang);
    if (c.summary) out.push([L.profile, c.summary.trim()]);
    if (c.jobs.length) out.push([L.experience, c.jobs.map((j) => [[j.role, j.company].filter(Boolean).join(' — '), [j.city, range(j.start, j.end)].filter(Boolean).join(' · ')].filter(Boolean).join('\n') + (j.desc ? '\n' + P.splitLines(j.desc).map((b) => '• ' + b).join('\n') : '')).join('\n\n')]);
    if ((c.projects || []).length) out.push([L.projects || 'Projeler', c.projects.map((q) => [q.name, q.tech, q.link].filter(Boolean).join(' · ') + (q.desc ? '\n' + P.splitLines(q.desc).map((b) => '• ' + b).join('\n') : '')).join('\n\n')]);
    if (c.edu.length) out.push([L.education, c.edu.map((e) => [[e.program, e.degree].filter(Boolean).join(', '), e.school, range(e.start, e.end), e.note].filter(Boolean).join(' · ')).join('\n')]);
    if (c.skills) out.push([L.skills, c.skills.trim()]);
    if (c.langs) {
      const detailed = typeof P.parseLanguageDetails === 'function' && typeof P.languageDetailText === 'function';
      const items = detailed ? P.parseLanguageDetails(c.langs) : P.parseLanguages(c.langs);
      out.push([L.languages, items.filter((l) => l && l.name).map((l) => {
        const level = detailed ? P.languageDetailText(l, settings.lang) : (l.level ? P.levelLabel(l.level, settings.lang) : '');
        return P.languageName(l.name, settings.lang) + (level ? ' — ' + level : '');
      }).join('\n')]);
    }
    if (c.certs) out.push([L.certs, P.splitLines(c.certs).join('\n')]);
    return out;
  }
  function openCopySheet() {
    const body = $('#copy-body');
    body.replaceChildren(...cvAsTextSections(pdfCv()).map(([title, text]) => {
      const pre = h('pre', null, text);
      return h('div', { class: 'copy-sec' }, h('h3', null, title, h('button', {
        type: 'button', class: 'btn small', onclick: async (e) => {
          const b = e.currentTarget;
          try { await navigator.clipboard.writeText(text); b.textContent = 'Kopyalandı'; }
          catch (_) { const r = D.createRange(); r.selectNodeContents(pre); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Metni seçtim; kopyalamak için basılı tutun.'); }
        },
      }, 'Kopyala')), pre);
    }));
    openSheet('sheet-copy');
  }
  function openQuickEdit(title, paths) {
    if (rec.wanted || conv.speaking) stopConvo();
    $('#sheet-edit-title').textContent = title;
    $('#edit-body').replaceChildren(...paths.map((p) => { const f = fieldDef(p); return f ? fieldView(f, p) : null; }).filter(Boolean));
    openSheet('sheet-edit');
  }
  function refreshTalkStatus() {
    const b = $('#pv-badge');
    if (b && ui.mode === 'talk' && iv.pending.length) { b.hidden = false; b.textContent = 'Güncelleniyor…'; }
  }
  function renderWorking() {
    const finalizing = iv.phase === 'finalizing';
    const left = iv.pending.length;
    return h('section', { class: 'step talk working', 'aria-live': 'polite' },
      h('div', { class: 'q-wrap' },
        h('p', { class: 'eyebrow' }, finalizing ? 'Son dokunuşlar' : 'Neredeyse bitti'),
        h('h1', { class: 'question' }, finalizing ? 'CV’niz yazılıyor…' : 'Anlattıklarınız işleniyor…'),
        h('p', { class: 'hint' }, finalizing
          ? 'Özetinizi ve maddeleri son kez düzenliyoruz. Bu bir dakika kadar sürebilir.'
          : left ? left + ' yanıt kaldı. Ardından eksik kalan birkaç şeyi soracağız.' : (aiState.busy === 'review' ? 'Eksik kalan bir şey var mı diye bakıyoruz…' : 'Hazırlanıyor…'))),
      h('div', { class: 'working-bar', 'aria-hidden': 'true' }, h('i')),
      aiState.status === 'off' ? aiOffBanner() : null,
      h('div', { class: 'feed', id: 'feed' }),
      finalizing ? null : h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn', onclick: () => { iv.followups = []; finalizeCv(); } }, 'Soruları atla, CV’yi oluştur')));
  }
  function aiOffBanner() {
    return h('div', { class: 'banner', role: 'note' }, icon('info'),
      h('div', { style: { display: 'grid', gap: '10px' } },
        h('div', null, h('b', null, 'Yapay zekâ şu an kullanılamıyor.'), ' ', aiState.msg || '', ' Yanıtlarınız kaydedildi; bağlantı gelince işlenir. İsterseniz CV’yi elle de doldurabilirsiniz.'),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn small', onclick: () => { aiState.status = 'unknown'; pingAI(); } }, icon('refresh'), 'Tekrar dene'),
          h('button', { type: 'button', class: 'btn small', onclick: () => { leaveTalk(); goStep(1); } }, 'Elle doldur'))));
  }
  function accessCard() {
    const input = h('input', { id: 'access-code', class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'Davet kodu', value: AI.getCode() });
    return h('div', { class: 'check' },
      h('div', { class: 'check-head' }, h('span', { class: 'status-dot warn' }), 'Davet kodu gerekiyor'),
      h('p', null, 'Bu uygulamayı size linki gönderen kişi bir davet kodu vermiş olmalı. Kodu girin; bir kez yeterli.'),
      input,
      h('div', { class: 'btn-row' }, h('button', {
        type: 'button', class: 'btn primary small', onclick: async () => {
          AI.setCode(input.value);
          aiState.status = 'unknown';
          await pingAI();
          if (aiState.status === 'code') toast('Kod kabul edilmedi. Linki gönderen kişiye sorun.', 5000);
          else { toast('Teşekkürler, devam edebilirsiniz.'); renderAll(); runQueue(); }
        },
      }, 'Kaydet')));
  }
  function githubCard() {
    const user = iv.ghUser || (cv.github ? GH.parseUser(cv.github) : '');
    const input = h('input', { id: 'gh-user', class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'github.com/kullaniciadi', value: user, 'aria-label': 'GitHub kullanıcı adınız' });
    const status = h('p', { class: 'mini-note', id: 'gh-status' });
    const load = async () => {
      const u = GH.parseUser(input.value);
      if (!u) { status.textContent = 'Kullanıcı adı anlaşılamadı. Örnek: github.com/kullaniciadi'; return; }
      status.textContent = 'Depolar getiriliyor…';
      try {
        const { repos } = await GH.listRepos(u);
        iv.ghUser = u;
        iv.repos = repos.map((r, i) => Object.assign(r, { selected: i < 4 && !!(r.description || r.stars || r.homepage) }));
        if (!cv.github) { cv.github = 'github.com/' + u; afterChange(); }
        save();
        renderGithubList();
        status.textContent = repos.length ? repos.length + ' depo bulundu. CV’ye eklenecek 3–4 tanesini seçin; Sıradaki’ye dokununca anlattıklarınızla birlikte işlenir.' : 'Herkese açık depo bulunamadı.';
      } catch (e) { status.textContent = e.message || 'Depolar getirilemedi.'; }
    };
    return h('div', { class: 'gh-card' },
      h('div', { class: 'gh-head' }, h('b', null, 'GitHub’dan projelerimi getir'), h('span', { class: 'mini-note' }, 'İsteğe bağlı')),
      h('p', { class: 'mini-note' }, 'GitHub kullanıcı adınızı yazın; herkese açık projelerinizi getireyim.'),
      h('div', { class: 'field-row' }, input, h('button', { type: 'button', class: 'btn small', onclick: load }, 'Getir')),
      status,
      h('div', { id: 'gh-list', class: 'gh-list' }, Array.isArray(iv.repos) ? repoItems() : null));
  }
  function repoItems() {
    return iv.repos.slice(0, 20).map((r) => h('label', { class: 'gh-item' + (r.sent ? ' sent' : '') },
      h('input', { type: 'checkbox', checked: !!r.selected, disabled: !!r.sent, onchange: (e) => { r.selected = e.target.checked; save(); } }),
      h('span', { class: 'gh-name' }, r.name, r.sent ? h('span', { class: 'mini-note' }, ' · eklendi') : null),
      h('span', { class: 'gh-meta' }, [r.language, r.stars ? '★ ' + r.stars : '', r.updated ? r.updated.slice(0, 4) : ''].filter(Boolean).join(' · ')),
      r.description ? h('span', { class: 'gh-desc' }, r.description) : null));
  }
  function renderGithubList() { const box = $('#gh-list'); if (box && Array.isArray(iv.repos)) box.replaceChildren(...repoItems()); }

  // ---- final-step AI tools: edit by voice, English version
  function aiEditCard() {
    if (IN_VIEWER || aiState.status === 'off') return null;
    if (aiState.status === 'code') return h('div', { class: 'ctl ai-edit' }, accessCard());
    const listening = rec.wanted && conv.slot && conv.slot.kind === 'edit';
    return h('div', { class: 'ctl ai-edit' },
      h('h3', null, 'Değişiklik iste'),
      h('p', { class: 'mini-note' }, 'Ne değişsin, söyleyin ya da yazın. Örnek: “Kuzey Lojistik’teki bitiş tarihini 2023 yap”, “özeti daha kısa yaz”, “İngilizceyi ileri seviye yap”.'),
      h('textarea', { id: 'edit-req', class: 'answer-box small', rows: 3, value: ui.editDraft || '', 'aria-label': 'İstediğiniz değişiklik', oninput: (e) => { ui.editDraft = e.target.value; } }),
      h('div', { class: 'btn-row' },
        micUsable() ? h('button', {
          type: 'button', class: 'btn small', dataset: { fkey: 'edit-mic' }, 'aria-pressed': listening ? 'true' : 'false', onclick: () => {
            // Read the state at tap time: listening may have stopped elsewhere (dock mic, Esc, silence).
            if (rec.wanted && conv.slot && conv.slot.kind === 'edit') { stopConvo(); renderAll(); return; }
            listenFor({ kind: 'edit' }); renderAll();
          },
        }, icon(listening ? 'pause' : 'mic'), h('span', { class: 'lbl' }, listening ? 'Durdur' : 'Söyle')) : null,
        h('button', { type: 'button', class: 'btn small primary', id: 'btn-edit', disabled: aiState.busy === 'edit', onclick: doEdit }, icon('wand'), aiState.busy === 'edit' ? 'Uygulanıyor…' : 'Uygula')),
      ui.lastReply ? h('p', { class: 'mini-note reply' }, ui.lastReply) : null);
  }
  // “Telefonumu 0532 … olarak değiştir”: the number is scrubbed before the AI sees the request, so the AI can
  // never make this change. It is made here instead (never for a referee's number).
  const CONTACT_EDIT_WORDS = new Set(('telefon telefonum telefonumu telefonu telefonun numara numaram numarami numarasi numarasini numarayi ' +
    'cep cebim e posta eposta epostam epostami epostamin mail maili mailim mailimi adres adresim adresimi olarak ile ve de da yerine eski yeni ' +
    'degistir degistirin degistirir degistirsene misin misiniz mi yap yapin guncelle guncelleyin duzelt duzeltin yaz yazin ekle ekleyin ' +
    'benim bu su lutfen olsun kaydet istiyorum').split(' '));
  function contactEdit(text, sc) {
    const k = ' ' + fk(text) + ' ';
    if (/ referans/.test(k)) return null;
    const out = {};
    if (sc.found.phone && / (telefon|numara|cep)/.test(k)) out.phone = String(sc.found.phone).trim();
    if (sc.found.email && / (e ?posta|mail|adres)/.test(k)) out.email = String(sc.found.email).trim().toLowerCase();
    return out.phone || out.email ? out : null;
  }
  /** Is anything left of a request once the contact change is taken out? */
  const editRest = (scText) => fk(String(scText).replace(PLACEHOLDER_RE, ' ')).split(' ').some((w) => w && !CONTACT_EDIT_WORDS.has(w));
  async function doEdit() {
    const text = (ui.editDraft || '').trim();
    if (text.length < 3) { toast('Ne değişsin, kısaca söyleyin ya da yazın.'); return; }
    if (aiState.busy === 'edit') return;
    if (rec.wanted) stopConvo();
    if (!askConsent(doEdit)) return;
    // Scrubbed copy for the AI; the box keeps the person's own words until the edit succeeds.
    const sc = scrubText(text);
    const ce = contactEdit(text, sc);
    let note;
    if (ce) {
      if (ce.phone) cv.phone = ce.phone;
      if (ce.email) { cv.email = ce.email; iv.emailCheck = ''; }
      afterChange();
      note = P.capFirst([ce.phone ? 'telefonunuzu ' + ce.phone : '', ce.email ? 'e-postanızı ' + ce.email : ''].filter(Boolean).join(', ') +
        ' olarak güncelledim (yapay zekâya gönderilmedi).');
    } else note = fillFound(sc.found);
    if (onlyContact(sc, text) || (ce && !editRest(sc.text))) {
      ui.editDraft = '';
      ui.lastReply = note || 'Bu istekte değiştirilecek bir şey bulamadım.';
      renderAll();
      toast(ui.lastReply, 5000);
      return;
    }
    const gen = dataGen;
    aiState.busy = 'edit';
    renderAll();
    try {
      await waitQueue(); // answers still in the queue reach the CV first
      if (gen !== dataGen) return;
      const base = snapCv(cv);
      const r = await aiCall('edit', { cv: AI.toAI(base), instruction: sc.text });
      if (gen !== dataGen) return;
      applyAiCv(r.cv, base);
      const reply = fillMarks(String(r.reply || 'Değişiklik uygulandı.'), { phone: cv.phone, email: cv.email });
      ui.lastReply = [note, reply].filter(Boolean).join(' ');
      ui.editDraft = '';
      toast(ui.lastReply, 5000);
    } catch (e) {
      if (gen !== dataGen) return;
      if (e.code === 'access_code') aiState.status = 'code';
      if (e.code !== 'cancelled') toast((e.message || 'Değişiklik uygulanamadı.') + ' İsteğiniz duruyor; tekrar deneyebilirsiniz.', 5000);
    } finally { if (gen === dataGen) { aiState.busy = ''; renderAll(); } }
  }
  function cvHash(c) {
    const str = JSON.stringify(AI.toAI(c));
    let x = 0;
    for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) | 0;
    return String(x) + ':' + str.length;
  }
  function englishCard() {
    if (settings.lang !== 'en' || IN_VIEWER || aiState.status === 'off' || !PDF.hasContent(cv)) return null;
    const fresh = ui.cvEn && ui.cvEnFor === cvHash(cv);
    return h('div', { class: 'ctl' },
      h('p', { class: 'mini-note' }, fresh ? 'CV’nizin İngilizce çevirisi kullanılıyor.' : 'Başlıklar İngilizce. İçeriği de İngilizceye çevirelim mi?'),
      h('button', { type: 'button', class: 'btn small' + (fresh ? '' : ' primary'), disabled: aiState.busy === 'translate', onclick: doTranslate },
        icon('wand'), aiState.busy === 'translate' ? 'Çevriliyor…' : fresh ? 'Çeviriyi yenile' : 'İçeriği İngilizceye çevir'));
  }
  async function doTranslate() {
    if (aiState.busy === 'translate') return;
    if (!askConsent(doTranslate)) return;
    const gen = dataGen;
    aiState.busy = 'translate';
    renderAll();
    try {
      await waitQueue(); // answers still in the queue reach the CV first
      if (gen !== dataGen) return;
      const base = snapCv(cv);
      const r = await aiCall('translate', { cv: AI.toAI(base), lang: 'en' });
      if (gen !== dataGen) return;
      ui.cvEn = AI.fromAI(r.cv, base, 'en');
      // Tied to the CV it was made from: a change made during the call shows as “İçeriği İngilizceye çevir” again.
      ui.cvEnFor = cvHash(base);
      save();
      toast(enFresh() ? 'İngilizce sürüm hazır.' : 'Çeviri hazır, ama bu sırada CV’niz değişti; yeniden çevirin.', 5000);
    } catch (e) {
      if (gen !== dataGen) return;
      if (e.code === 'access_code') aiState.status = 'code';
      if (e.code !== 'cancelled') toast((e.message || 'Çeviri yapılamadı.') + ' Tekrar deneyebilirsiniz.', 5000);
    } finally { if (gen === dataGen) { aiState.busy = ''; renderAll(); } }
  }
  /** English CVs leave out birth year, military service and marital status (brief §5.2 #5). */
  const noPersonalEn = (c) => (settings.lang === 'en' ? Object.assign({}, c, { birth: '', military: '', marital: '' }) : c);
  const enFresh = () => settings.lang === 'en' && !!ui.cvEn && ui.cvEnFor === cvHash(cv);
  // Phone, e-mail, referees and personal details are never sent, so they are not part of cvHash and never
  // translated: a copy made from the master (translation, restyle undo) always takes today's values.
  const DEVICE_KEYS = () => (Array.isArray(AI.DEVICE_FIELDS) && AI.DEVICE_FIELDS.length ? AI.DEVICE_FIELDS : ['phone', 'email', 'refs', 'birth', 'military', 'marital']);
  function deviceFields() {
    const keep = { photo: cv.photo };
    DEVICE_KEYS().forEach((k) => { keep[k] = cv[k]; });
    return keep;
  }
  /** What goes into the PDF: the English translation when English is chosen and the translation is current. */
  function pdfCv() {
    if (enFresh()) return noPersonalEn(Object.assign({}, ui.cvEn, deviceFields()));
    return noPersonalEn(cv);
  }

  // ---------------------------------------------------------------- final screen v2 (brief §5.3)
  // Application tools (tailor to an ad, cover letter), bullet style and CV Kontrolü. The master `cv` is only
  // ever changed by the person's own answers (extract queue) or an explicit rewrite they asked for.
  const AD_MIN = 40;
  const AD_MAX = 10000;
  const toolBusy = {}; // tailor ('queue' | 'call') · cover · coverRev
  const drafts = {}; // final-screen text boxes: 'coverReq', 'miss:<term>', 'chk:<id>'
  /** The CV text the application tools start from: the current English translation, else the master CV. */
  const contentCv = () => (enFresh() ? Object.assign({}, ui.cvEn, deviceFields()) : cv);
  const contentLang = () => (enFresh() ? 'en' : 'tr');
  const aiAvail = () => !IN_VIEWER && aiState.status !== 'off';
  const aiUsable = () => !IN_VIEWER && (aiState.status === 'ok' || aiState.status === 'unknown');
  function hashStr(s) {
    const str = String(s || '');
    let x = 0;
    for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) | 0;
    return String(x) + ':' + str.length;
  }
  /** The tailored copy for the PDF: its reordered content with today's contact and personal details from the master. */
  function variantCv() {
    const t = ui.tailored;
    if (!t) return pdfCv();
    const keep = {};
    ['name', 'phone', 'email', 'web', 'github', 'photo', 'birth', 'military', 'license', 'marital', 'refs'].forEach((k) => { keep[k] = cv[k]; });
    if (!filled(keep.name)) keep.name = t.cv.name;
    return noPersonalEn(Object.assign({}, t.cv, keep));
  }
  const tailoredLabel = (t) => (t && (t.company || t.role)) || 'İlan';
  const tailoredFileName = () => { const t = ui.tailored || {}; return PDF.fileName(cv, { suffix: t.company || t.role || 'Ilan' }); };
  /** Waits (at most 90 s) until answers still in the queue have reached the master CV. */
  function waitQueue() {
    if (!iv.pending.length || aiState.status === 'code' || aiState.status === 'off' || !hasConsent()) return Promise.resolve();
    return Promise.race([queueIdle(), sleep(90000)]);
  }
  function focusEl(sel) {
    const el = $(sel);
    if (el) { el.focus(); if (el.scrollIntoView) el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' }); }
  }

  // ---- tool errors, queue note and page count
  function errNote(op, retry) {
    const msg = ui.toolErr[op];
    if (!msg) return null;
    return h('div', { class: 'err-note', role: 'alert' }, h('p', null, msg),
      h('button', { type: 'button', class: 'btn small', onclick: () => { ui.toolErr[op] = null; retry(); } }, icon('refresh'), 'Tekrar dene'));
  }
  /** Turkish error with retry; an invite-code error shows the access card instead. */
  function toolFail(op, e) {
    const code = e && e.code;
    if (code === 'cancelled') { ui.toolErr[op] = null; return; }
    if (code === 'access_code') { aiState.status = 'code'; ui.toolErr[op] = null; toast('Devam etmek için davet kodunu girin.', 5000); return; }
    const msg = ((e && e.message) || 'Şu an yanıt alınamadı.').trim();
    if (code === 'not_configured' || code === 'unavailable') { aiState.status = 'off'; aiState.msg = msg; toast(msg, 6000); }
    ui.toolErr[op] = msg + ' Bilgileriniz kaybolmadı; tekrar deneyebilirsiniz.';
  }
  function queueNoteKids() {
    if (ui.mode === 'talk') return [];
    const out = [];
    if (iv.pending.length) {
      out.push(h('p', { class: 'mini-note busy-note' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        !hasConsent() ? 'Cevaplarınız kaydedildi; onay verdiğinizde işlenecek.'
          : aiState.status === 'code' ? 'Cevaplarınız davet kodu girildiğinde işlenecek.' : 'Cevaplarınız CV’nize işleniyor…'));
    }
    iv.failed.slice(-3).forEach((j) => out.push(h('p', { class: 'mini-note err-line' }, 'Bir cevabınız işlenemedi; kaybolmadı. ',
      h('button', { type: 'button', class: 'text-btn', onclick: () => retryFailed(j.id) }, 'Tekrar dene'))));
    return out;
  }
  function refreshFinalQueue() { const el = $('#final-queue'); if (el) el.replaceChildren(...queueNoteKids()); }
  /** Page counts per variant (for “more than 2 pages”); the check list follows when the master's count changes. */
  function notePages(view, n) {
    if (ui.pages[view] === n) return;
    ui.pages[view] = n;
    if (view === 'master') renderFinalTools();
  }

  // ---- text boxes with a microphone (“tamam” is ignored, “bitti” sends; critic C5)
  function setDraft(key, v) {
    drafts[key] = v;
    const ta = $$('textarea[data-draft]').find((x) => x.dataset.draft === key);
    if (ta && ta.value !== v) ta.value = v;
  }
  function draftMic(key, label, done) {
    if (!micUsable()) return null;
    const on = !!(rec.wanted && conv.slot && conv.slot.kind === 'draft' && conv.slot.key === key);
    return h('button', {
      type: 'button', class: 'mic-sm', 'aria-pressed': on ? 'true' : 'false', 'aria-label': label, title: label, dataset: { draft: key, fkey: 'mic-' + key },
      onclick: () => {
        if (rec.wanted && conv.slot && conv.slot.kind === 'draft' && conv.slot.key === key) { stopConvo(); return; }
        listenFor({ kind: 'draft', key, done });
      },
    }, icon(on ? 'pause' : 'mic'));
  }
  function draftBox(key, o) {
    const ta = h('textarea', {
      class: 'answer-box small', rows: o.rows || 2, value: drafts[key] || '', placeholder: o.ph || '', 'aria-label': o.label,
      dataset: { draft: key, fkey: 'dr-' + key }, oninput: (e) => { drafts[key] = e.target.value; },
    });
    return h('div', { class: 'draft' },
      h('div', { class: 'field-row' }, ta, draftMic(key, 'Konuşarak yazın', o.done)),
      h('div', { class: 'live', dataset: { live: key } }));
  }
  function onDraftFinal(seg, slot) {
    const live = rec.wanted && slot === conv.slot;
    const k = fk(seg);
    if (live && TALK_FILLER.test(k)) return;
    const c = commandFor(seg);
    if (live && (c === 'next' || isEndWord(k))) { stopConvo(); if (slot.done) slot.done(); else renderFinalTools(); return; }
    if (live && c === 'stop') { stopConvo(); return; }
    if (live && c === 'clear') { setDraft(slot.key, ''); return; }
    const cur = drafts[slot.key] || '';
    setDraft(slot.key, (cur.trim() ? cur.trim() + ' ' : '') + String(seg).trim());
  }
  /** A <details> card whose open state survives re-renders. */
  function toolCard(key, title, sub, body) {
    return h('details', { class: 'tool', open: !!ui.open[key], dataset: { tool: key }, ontoggle: (e) => { ui.open[key] = !!e.target.open; } },
      h('summary', null, h('span', { class: 'tool-title' }, title), sub ? h('span', { class: 'tool-sub' }, sub) : null),
      h('div', { class: 'tool-body' }, body));
  }
  function confirmBar(text, yesLabel, onYes, onNo) {
    return h('div', { class: 'confirm-bar', role: 'group', 'aria-label': text }, h('span', null, text),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn small danger', onclick: onYes }, yesLabel),
        h('button', { type: 'button', class: 'btn small', onclick: onNo }, 'Vazgeç')));
  }
  async function copyText(text, title) {
    try { await navigator.clipboard.writeText(text); toast('Metin kopyalandı.'); }
    catch (_) {
      const pre = h('pre', null, text);
      $('#copy-body').replaceChildren(h('div', { class: 'copy-sec' }, h('h3', null, title), pre));
      openSheet('sheet-copy');
      try { const r = D.createRange(); r.selectNodeContents(pre); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); } catch (__) { /* ignore */ }
      toast('Metni seçtim; kopyalamak için basılı tutun.', 5000);
    }
  }

  // ---- bullet style (“Madde dili”)
  const STYLE_OPTS = [
    ['kisisel', 'Kişisel (…yaptım)', 'Örnek: “Aylık raporları hazırladım.”'],
    ['resmi', 'Resmi (…yapılması)', 'Örnek: “Aylık raporların hazırlanması.”'],
  ];
  function styleCard() {
    const cur = settings.bulletStyle === 'resmi' ? 'resmi' : 'kisisel';
    const hasBullets = cv.jobs.some((j) => filled(j.desc)) || cv.projects.some((q) => filled(q.desc));
    const undo = ui.restyleUndo && ui.restyleUndo.after === cvHash(cv) ? ui.restyleUndo : null;
    return h('div', { class: 'ctl' }, h('h3', null, 'Madde dili'),
      h('div', { class: 'seg two', role: 'group', 'aria-label': 'Madde dili' }, STYLE_OPTS.map(([id, label]) => h('button', {
        type: 'button', 'aria-pressed': cur === id ? 'true' : 'false', dataset: { fkey: 'style-' + id }, onclick: () => setBulletStyle(id),
      }, label))),
      h('p', { class: 'mini-note' }, STYLE_OPTS.find((x) => x[0] === cur)[2] + ' Yapay zekâ bundan sonraki maddeleri bu dilde yazar.'),
      ui.styleDirty && hasBullets ? h('div', { class: 'btn-row' }, h('button', {
        type: 'button', class: 'btn small primary', id: 'btn-restyle', disabled: !!aiState.busy, onclick: () => doRestyle(),
      }, icon('wand'), aiState.busy === 'restyle' ? 'Yeniden yazılıyor…' : 'Maddeleri bu dilde yeniden yaz')) : null,
      errNote('restyle', doRestyle),
      undo ? h('div', { class: 'soft-row' }, h('span', { class: 'mini-note' }, 'Maddeler yeniden yazıldı.'),
        h('button', { type: 'button', class: 'btn small', onclick: undoRestyle }, icon('refresh'), 'Geri al')) : null);
  }
  function setBulletStyle(id) {
    if (settings.bulletStyle === id) return;
    settings.bulletStyle = id;
    ui.styleDirty = true;
    save();
    renderFinalTools();
  }
  /** Rewrites the bullets in the chosen style (finalize op); the previous CV can be restored. */
  async function doRestyle() {
    if (aiState.busy) return;
    if (rec.wanted) stopConvo();
    if (!askConsent(doRestyle)) return;
    const gen = dataGen;
    aiState.busy = 'restyle';
    ui.toolErr.restyle = null;
    renderFinalTools();
    try {
      await waitQueue();
      if (gen !== dataGen) return;
      const before = snapCv(cv);
      const r = await aiCall('finalize', { cv: AI.toAI(before), style: settings.bulletStyle });
      if (gen !== dataGen) return;
      if (!r || !r.cv || typeof r.cv !== 'object') throw { code: 'upstream', message: 'Maddeler yeniden yazılamadı.' };
      aiState.busy = '';
      applyAiCv(r.cv, before);
      ui.restyleUndo = { cv: before, after: cvHash(cv) };
      ui.styleDirty = false;
      toast('Maddeler ' + (settings.bulletStyle === 'resmi' ? 'resmi' : 'kişisel') + ' dilde yeniden yazıldı.', 4500);
    } catch (e) { if (gen === dataGen) toolFail('restyle', e); }
    finally { if (gen === dataGen) { aiState.busy = ''; renderAll(); } }
  }
  function undoRestyle() {
    const u = ui.restyleUndo;
    if (!u) return;
    // Only what the rewrite wrote comes back; phone, e-mail, referees, personal details and the photo
    // changed since then stay as they are now (they are not part of cvHash, so the undo was still offered).
    cv = Object.assign(sanitizeCv(u.cv), deviceFields());
    ui.restyleUndo = null;
    ui.cvEn = null;
    afterChange();
    renderAll();
    toast('Önceki maddeler geri getirildi.');
  }

  // ---- İlana uyarla (brief §5.3.1): honest matched / missing lists, no score; the master never changes
  function adCountText(n) {
    if (!n) return 'İlanı kopyalayıp buraya yapıştırın (en az 40 karakter).';
    if (n < AD_MIN) return n + ' karakter · ilanın tamamını yapıştırın (en az 40 karakter).';
    if (n > AD_MAX) return n + ' karakter · çok uzun; yalnızca ilanın kendisini yapıştırın.';
    return n + ' karakter';
  }
  function tailorCard() {
    const t = ui.tailored;
    const avail = aiAvail() && aiState.status !== 'code';
    const busy = toolBusy.tailor;
    const ad = ui.adDraft || '';
    const body = [];
    if (avail) {
      const count = h('p', { class: 'mini-note', id: 'ad-count' }, adCountText(ad.trim().length));
      body.push(
        h('p', { class: 'mini-note' }, 'İlanı yapıştırın. Gerçeklerinize dokunmadan CV’nizi bu ilana göre sıralarım ve ilanda olup CV’nizde görünmeyenleri sorarım. Puan vermem, bir şey uydurmam.'),
        h('label', { class: 'field-label', for: 'ad-text' }, 'İlan metni'),
        h('textarea', {
          id: 'ad-text', class: 'answer-box small', rows: 5, value: ad, placeholder: 'İlanın tamamını buraya yapıştırın', dataset: { fkey: 'ad-text' },
          oninput: (e) => { ui.adDraft = e.target.value; count.textContent = adCountText(ui.adDraft.trim().length); saveDraftSoon(); },
        }),
        count,
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn small primary', id: 'btn-tailor', disabled: !!busy, onclick: () => doTailor() },
          icon('wand'), busy === 'queue' ? 'Önce cevaplarınız işleniyor…' : busy ? 'Uyarlanıyor…' : t ? 'Yeniden uyarla' : 'İlana uyarla')),
        errNote('tailor', () => doTailor()));
    }
    if (t) body.push(tailorResult(t, avail));
    return toolCard('tailor', 'Bir ilana uyarla', t ? tailoredLabel(t) + ' için hazır' : '', body);
  }
  function tailorResult(t, avail) {
    const langStale = t.lang !== contentLang();
    const stale = langStale || t.baseHash !== cvHash(cv);
    const answeredYes = Object.keys(t.answered).some((k) => t.answered[k] === 'yes');
    return h('div', { class: 'tailor-res' },
      h('p', { class: 'res-head' }, h('b', null, [t.company, t.role].filter(Boolean).join(' · ') || 'İlana göre uyarlanmış CV')),
      stale ? h('p', { class: 'nudge' }, langStale
        ? 'Bu uyarlama ' + (t.lang === 'en' ? 'İngilizce' : 'Türkçe') + ' CV’nizden yapıldı. Şimdiki dil için yenileyin.'
        : 'CV’niz bu uyarlamadan sonra değişti. Değişikliklerin uyarlanmış CV’ye de geçmesi için yenileyin.') : null,
      (stale || answeredYes) && avail ? h('div', { class: 'btn-row' }, h('button', {
        type: 'button', class: 'btn small primary', disabled: !!toolBusy.tailor, onclick: () => doTailor(t.ad),
      }, icon('refresh'), 'Uyarlamayı yenile')) : null,
      h('h3', { class: 'res-title' }, 'İlanla eşleşenler'),
      t.matched.length ? h('ul', { class: 'term-list' }, t.matched.map((m) => h('li', { class: 'chip' }, h('b', null, m.term), m.where ? h('span', { class: 'lvl' }, ' · ' + m.where) : null)))
        : h('p', { class: 'mini-note' }, 'İlanla açıkça eşleşen bir şey bulamadım.'),
      h('h3', { class: 'res-title' }, 'İlanda var, CV’nizde yok'),
      t.missing.length ? [
        h('p', { class: 'mini-note' }, 'Yalnızca gerçekten yaptıklarınızı anlatın; cevabınız asıl CV’nize eklenir. “Kullanmadım” derseniz hiçbir şey eklenmez.'),
        h('ul', { class: 'miss-list' }, t.missing.map((m) => missItem(t, m, avail)))]
        : h('p', { class: 'mini-note' }, 'İlanın istediği her şey CV’nizde görünüyor.'),
      t.changes.length ? [h('h3', { class: 'res-title' }, 'Yaptığım değişiklikler'), h('ul', { class: 'changes' }, t.changes.map((c) => h('li', null, c)))] : null,
      ui.tailorConfirm
        ? confirmBar('Uyarlanmış CV kaldırılsın mı? Asıl CV’niz değişmez.', 'Kaldır', removeTailored, () => { ui.tailorConfirm = false; renderFinalTools(); })
        : h('div', { class: 'btn-row' },
          env.noDownload ? null : h('button', { type: 'button', class: 'btn small primary', onclick: () => downloadPdf('tailored') }, icon('download'), 'Uyarlanmış CV’yi indir'),
          previewView() === 'tailored' ? null : h('button', { type: 'button', class: 'btn small', onclick: () => { ui.view = 'tailored'; renderAll(); focusEl('#pv-big'); } }, icon('doc'), 'Önizlemede göster'),
          h('button', { type: 'button', class: 'btn small', onclick: () => { ui.tailorConfirm = true; renderFinalTools(); } }, icon('trash'), 'Kaldır')),
      h('p', { class: 'mini-note' }, 'Dosya adı: ' + tailoredFileName()));
  }
  const missQuestion = (m) => m.question || 'İlanda “' + m.term + '” geçiyor. Kullandınız mı? Nerede?';
  function missItem(t, m, avail) {
    const k = fk(m.term);
    const st = t.answered[k];
    if (st === 'no') {
      return h('li', { class: 'miss done' }, h('b', null, m.term), h('span', { class: 'mini-note' }, ' · Kullanmadım; CV’ye eklenmedi. '),
        h('button', { type: 'button', class: 'text-btn', onclick: () => markMissing(m, null) }, 'Geri al'));
    }
    if (st === 'yes') {
      // The item follows its own job: still out, failed (with a retry), or in the master CV.
      const jid = t.jobs && t.jobs[k];
      if (jid && iv.failed.some((j) => j.id === jid)) {
        return h('li', { class: 'miss done err' }, h('b', null, m.term), h('span', { class: 'mini-note' }, ' · Cevabınız işlenemedi; kaybolmadı. '),
          h('button', { type: 'button', class: 'text-btn', onclick: () => { retryFailed(jid); renderFinalTools(); } }, 'Tekrar dene'));
      }
      const busy = jid ? iv.pending.some((j) => j.id === jid) : iv.pending.length > 0;
      return h('li', { class: 'miss done' }, h('b', null, m.term),
        h('span', { class: 'mini-note' }, busy ? ' · Cevabınız asıl CV’nize işleniyor…' : ' · Cevabınız asıl CV’nize işlendi. Uyarlamayı yenileyin.'));
    }
    return h('li', { class: 'miss' },
      h('p', { class: 'miss-q' }, h('b', null, m.term), ' · ', missQuestion(m)),
      avail ? [
        draftBox('miss:' + k, { label: m.term + ' hakkındaki cevabınız', ph: 'Kısaca anlatın: nerede, ne zaman, ne yaptınız?', done: () => sendMissing(m) }),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn small primary', onclick: () => sendMissing(m) }, 'Gönder'),
          h('button', { type: 'button', class: 'btn small', onclick: () => markMissing(m, 'no') }, 'Kullanmadım'))] : null);
  }
  function markMissing(m, v) {
    const t = ui.tailored;
    if (!t) return;
    const k = fk(m.term);
    if (v) t.answered[k] = v; else { delete t.answered[k]; if (t.jobs) delete t.jobs[k]; }
    save();
    renderFinalTools(); // its box is gone now, so a mic still listening for it stops (dropOrphanDraftMic)
  }
  /** The answer goes to the MASTER CV through the extract queue; the AI adds a skill only with evidence. */
  function sendMissing(m) {
    const t = ui.tailored;
    if (!t) return;
    const k = fk(m.term);
    if (t.answered[k]) return; // “Kullanmadım” (or already sent) wins over a late “bitti” from its mic
    const key = 'miss:' + k;
    const text = (drafts[key] || '').trim();
    if (rec.wanted) stopConvo();
    if (text.length < 3) { toast('Nerede ve nasıl kullandığınızı kısaca anlatın ya da “Kullanmadım”a dokunun.', 4500); return; }
    if (!askConsent(() => sendMissing(m))) return;
    const q = missQuestion(m);
    const jid = enqueue({ topic: 'followup', question: (fk(q).indexOf(k) >= 0 ? q : 'İlanda “' + m.term + '” geçiyor. ' + q).slice(0, 400), answer: text });
    t.answered[k] = 'yes';
    t.jobs = t.jobs || {};
    t.jobs[k] = jid;
    drafts[key] = '';
    save();
    renderFinalTools();
    toast('Cevabınız asıl CV’nize işleniyor. Bitince “Uyarlamayı yenile”ye dokunun.', 5000);
  }
  async function doTailor(adArg) {
    const ad = String(typeof adArg === 'string' ? adArg : ui.adDraft || '').trim();
    if (ad.length < AD_MIN) { toast('İlanın tamamını yapıştırın; en az 40 karakter olmalı.', 4500); focusEl('#ad-text'); return; }
    if (ad.length > AD_MAX) { toast('İlan metni çok uzun. Yalnızca ilanın kendisini yapıştırın.', 4500); return; }
    if (toolBusy.tailor) return;
    if (rec.wanted) stopConvo();
    if (!askConsent(() => doTailor(ad))) return;
    const gen = dataGen;
    toolBusy.tailor = 'queue';
    ui.toolErr.tailor = null;
    ui.tailorConfirm = false;
    renderFinalTools();
    let done = false;
    try {
      await waitQueue(); // answers to earlier “missing” questions reach the master first
      if (gen !== dataGen) return;
      toolBusy.tailor = 'call';
      renderFinalTools();
      const base = snapCv(contentCv());
      // The master as it is when the call goes out: a change made while it runs shows “CV’niz değişti”.
      const baseHash = cvHash(cv);
      const lang = contentLang();
      const r = await aiCall('tailor', { cv: AI.toAI(base), ad, lang });
      if (gen !== dataGen) return;
      if (!r || !r.cv || typeof r.cv !== 'object') throw { code: 'upstream', message: 'Uyarlanmış CV alınamadı.' };
      const prev = ui.tailored;
      const adHash = hashStr(ad);
      const answered = {};
      // “Kullanmadım” stays for the same ad; anything answered with a yes is asked again only if still missing.
      if (prev && prev.adHash === adHash) Object.keys(prev.answered).forEach((k) => { if (prev.answered[k] === 'no') answered[k] = 'no'; });
      ui.tailored = sanitizeTailored({
        cv: AI.fromAI(r.cv, base, lang), company: r.company, role: r.role, adHash, at: Date.now(), ad,
        matched: r.matched, missing: r.missing, changes: r.changes, lang, baseHash, answered,
      });
      ui.adDraft = ad;
      ui.view = 'tailored';
      ui.open.tailor = true;
      save();
      done = true;
      toast((ui.tailored.company ? ui.tailored.company + ' ilanına' : 'İlana') + ' göre uyarlanmış CV hazır. Asıl CV’niz değişmedi.', 5000);
    } catch (e) { if (gen === dataGen) toolFail('tailor', e); }
    finally { if (gen === dataGen) toolBusy.tailor = false; }
    if (gen !== dataGen) return;
    if (done) renderAll(); else renderFinalTools();
  }
  function removeTailored() {
    ui.tailored = null;
    ui.tailorConfirm = false;
    ui.view = 'master';
    delete ui.pages.tailored;
    save();
    renderAll();
    toast('Uyarlanmış CV kaldırıldı. Asıl CV’niz duruyor.');
  }

  // ---- Ön yazı (brief §5.3.2)
  function coverCard() {
    const L = ui.letter;
    const avail = aiAvail() && aiState.status !== 'code';
    const busy = !!toolBusy.cover;
    const ad = (ui.adDraft || '').trim();
    const hasAd = ad.length >= AD_MIN && ad.length <= AD_MAX;
    const body = [];
    if (avail) {
      if (hasAd) body.push(h('p', { class: 'mini-note' }, 'Yapıştırdığınız ilana göre yazarım: pozisyon, neden siz ve CV’nizden iki somut örnek.'));
      else {
        body.push(
          h('p', { class: 'mini-note' }, 'İlan yapıştırmadınız; hedeflediğiniz pozisyona göre genel bir yazı hazırlarım. ',
            h('button', { type: 'button', class: 'link-btn', onclick: openAdBox }, 'İlan ekle')),
          h('label', { class: 'field-label', for: 'cover-target' }, 'Hedef pozisyon'),
          h('input', {
            id: 'cover-target', class: 'input', type: 'text', value: ui.coverTarget != null ? ui.coverTarget : (cv.title || ''), placeholder: 'Örn. Muhasebe Uzmanı',
            autocomplete: 'off', dataset: { fkey: 'cover-target' }, oninput: (e) => { ui.coverTarget = e.target.value; },
          }));
      }
      body.push(ui.coverConfirm
        ? confirmBar('Yeni bir ön yazı yazılsın mı? Şimdikinde yaptığınız düzenlemeler kaybolur.', 'Evet, yeniden yaz', () => doCover(true), () => { ui.coverConfirm = false; renderFinalTools(); })
        : h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn small primary', id: 'btn-cover', disabled: busy, onclick: () => doCover() },
          icon('wand'), busy ? 'Yazılıyor…' : L ? 'Yeniden yaz' : 'Ön yazı hazırla')),
      errNote('cover', () => doCover(true)));
    }
    if (L) body.push(letterView(L, avail));
    return toolCard('cover', 'Ön yazı hazırla', L ? 'Hazır' + (L.company ? ' · ' + L.company : '') : '', body);
  }
  function openAdBox() {
    ui.open.tailor = true;
    renderFinalTools();
    focusEl('#ad-text');
  }
  function letterView(L, avail) {
    const set = (fn) => (e) => { fn(e.target.value); saveDraftSoon(); };
    const row = (label, id, input) => h('div', { class: 'letter-f' }, h('label', { class: 'field-label', for: id }, label), input);
    const busyRev = !!toolBusy.coverRev;
    return h('div', { class: 'letter' },
      L.generic ? h('p', { class: 'nudge' }, 'İlan olmadan genel bir yazı oluşturdum; ilanı eklerseniz daha güçlü olur.') : null,
      ui.coverReply ? h('p', { class: 'mini-note reply' }, ui.coverReply) : null,
      row('Alıcı', 'lt-to', h('textarea', {
        id: 'lt-to', class: 'input', rows: 2, value: L.recipient.join('\n'), placeholder: 'Firma adı\nİnsan Kaynakları', dataset: { fkey: 'lt-to' },
        oninput: set((v) => { L.recipient = v.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 6); }),
      })),
      row('Konu', 'lt-subj', h('input', { id: 'lt-subj', class: 'input', type: 'text', value: L.subject, dataset: { fkey: 'lt-subj' }, oninput: set((v) => { L.subject = v; }) })),
      row('Hitap', 'lt-greet', h('input', { id: 'lt-greet', class: 'input', type: 'text', value: L.greeting, placeholder: L.lang === 'en' ? 'Dear Hiring Manager,' : 'Sayın İlgili,', dataset: { fkey: 'lt-greet' }, oninput: set((v) => { L.greeting = v; }) })),
      L.paragraphs.map((p, i) => row((i + 1) + '. paragraf', 'lt-p' + i, h('textarea', {
        id: 'lt-p' + i, class: 'input', rows: 4, value: p, dataset: { fkey: 'lt-p' + i }, oninput: set((v) => { L.paragraphs[i] = v; }),
      }))),
      row('Kapanış', 'lt-close', h('input', { id: 'lt-close', class: 'input', type: 'text', value: L.closing, placeholder: L.lang === 'en' ? 'Kind regards,' : 'Saygılarımla,', dataset: { fkey: 'lt-close' }, oninput: set((v) => { L.closing = v; }) })),
      h('p', { class: 'mini-note' }, 'İmza: ' + (cv.name || 'adınız') + ' · PDF’e bugünün tarihi yazılır.'),
      ui.letterConfirm
        ? confirmBar('Ön yazı silinsin mi?', 'Sil', removeLetter, () => { ui.letterConfirm = false; renderFinalTools(); })
        : h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn small primary', onclick: () => copyText(letterText(L), 'Ön yazı') }, icon('doc'), 'Metni kopyala'),
          typeof PDF.buildLetter === 'function' && !env.noDownload
            ? h('button', { type: 'button', class: 'btn small', id: 'btn-letter-pdf', onclick: () => downloadLetter() }, icon('download'), 'Ön yazıyı PDF indir') : null,
          h('button', { type: 'button', class: 'btn small', onclick: () => { ui.letterConfirm = true; renderFinalTools(); } }, icon('trash'), 'Kaldır')),
      avail ? h('div', { class: 'letter-rev' },
        h('h3', { class: 'res-title' }, 'Değişiklik iste'),
        h('p', { class: 'mini-note' }, 'Örnek: “İkinci paragrafı kısalt”, “daha sade yaz”, “depo deneyimimi öne çıkar”.'),
        draftBox('coverReq', { label: 'Ön yazıda ne değişsin?', ph: 'Ne değişsin, söyleyin ya da yazın', done: () => doCoverRevise() }),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn small primary', id: 'btn-cover-rev', disabled: busyRev, onclick: () => doCoverRevise() },
          icon('wand'), busyRev ? 'Uygulanıyor…' : 'Değişikliği uygula')),
        errNote('coverRev', () => doCoverRevise())) : null);
  }
  const letterCore = (L) => ({
    recipient: L.recipient.slice(0, 3), subject: L.subject, greeting: L.greeting,
    paragraphs: L.paragraphs.map((p) => String(p).trim()).filter(Boolean), closing: L.closing,
  });
  /** The letter as plain text for e-mail bodies and platform fields: greeting, paragraphs, closing, name. */
  function letterText(L) {
    const en = L.lang === 'en';
    const paras = L.paragraphs.map((p) => String(p).trim()).filter(Boolean);
    const close = String(L.closing || (en ? 'Kind regards,' : 'Saygılarımla,')).trim() + (filled(cv.name) ? '\n' + cv.name.trim() : '');
    return [String(L.greeting || (en ? 'Dear Hiring Manager,' : 'Sayın İlgili,')).trim()].concat(paras, [close]).join('\n\n');
  }
  /** Scrub placeholders the model echoed into a letter → the person's own details (see fillMarks). */
  function fillLetter(L, vals) {
    const out = Object.assign({}, L);
    ['subject', 'greeting', 'closing'].forEach((k) => { if (typeof out[k] === 'string') out[k] = fillMarks(out[k], vals); });
    ['recipient', 'paragraphs'].forEach((k) => { if (Array.isArray(out[k])) out[k] = out[k].map((x) => (typeof x === 'string' ? fillMarks(x, vals) : x)); });
    return out;
  }
  /**
   * The letter as it goes out for a revision: every line scrubbed like a transcript, because people add
   * “0532 … numaralı telefondan ulaşabilirsiniz” to it. `found`: the first phone and e-mail taken out.
   */
  function scrubLetter(L) {
    const core = letterCore(L);
    const found = { phone: '', email: '' };
    const one = (t) => {
      const sc = scrubText(t);
      if (sc.found.phone && !found.phone) found.phone = sc.found.phone;
      if (sc.found.email && !found.email) found.email = sc.found.email;
      return sc.text;
    };
    return {
      letter: { recipient: core.recipient.map(one), subject: one(core.subject), greeting: one(core.greeting), paragraphs: core.paragraphs.map(one), closing: one(core.closing) },
      found,
    };
  }
  async function doCover(force) {
    if (toolBusy.cover) return;
    if (ui.letter && force !== true) { ui.coverConfirm = true; renderFinalTools(); return; }
    ui.coverConfirm = false;
    const ad = (ui.adDraft || '').trim();
    const hasAd = ad.length >= AD_MIN && ad.length <= AD_MAX;
    const target = hasAd ? '' : String(ui.coverTarget != null ? ui.coverTarget : cv.title || '').trim().slice(0, 200);
    if (rec.wanted) stopConvo();
    if (!askConsent(() => doCover(true))) return;
    const gen = dataGen;
    toolBusy.cover = true;
    ui.toolErr.cover = null;
    renderFinalTools();
    try {
      await waitQueue();
      if (gen !== dataGen) return;
      const lang = settings.lang === 'en' ? 'en' : 'tr';
      const payload = { cv: AI.toAI(contentCv()), lang };
      if (hasAd) payload.ad = ad; else if (target) payload.target = scrubText(target).text;
      const r = await aiCall('cover', payload);
      if (gen !== dataGen) return;
      const vals = { phone: cv.phone, email: cv.email };
      const letter = sanitizeLetter(fillLetter(Object.assign({}, r && r.letter, {
        company: r && r.company, role: r && r.role, target, ad: hasAd ? ad : '', generic: !hasAd, at: Date.now(), lang, name: '', date: '',
      }), vals));
      if (!letter || !letter.paragraphs.length) throw { code: 'upstream', message: 'Ön yazı alınamadı.' };
      ui.letter = letter;
      ui.coverReply = '';
      ui.letterConfirm = false;
      ui.open.cover = true;
      save();
      toast('Ön yazınız hazır. Paragrafları dilediğiniz gibi düzenleyebilirsiniz.', 4500);
    } catch (e) { if (gen === dataGen) toolFail('cover', e); }
    finally { if (gen === dataGen) { toolBusy.cover = false; renderFinalTools(); } }
  }
  /** “Değişiklik iste” for the letter: cover op with the (scrubbed) letter and the (scrubbed) instruction. */
  async function doCoverRevise() {
    const L = ui.letter;
    if (!L || toolBusy.coverRev) return;
    const text = (drafts.coverReq || '').trim();
    if (rec.wanted) stopConvo();
    if (text.length < 3) { toast('Ne değişsin, kısaca söyleyin ya da yazın.'); return; }
    if (!askConsent(doCoverRevise)) return;
    const sc = scrubText(text);
    const note = fillFound(sc.found);
    if (onlyContact(sc, text)) { setDraft('coverReq', ''); toast(note || 'Bu istekte değiştirilecek bir şey bulamadım.', 5000); return; }
    const sl = scrubLetter(L);
    const gen = dataGen;
    toolBusy.coverRev = true;
    ui.toolErr.coverRev = null;
    renderFinalTools();
    try {
      const payload = { cv: AI.toAI(contentCv()), lang: L.lang || 'tr', letter: sl.letter, instruction: sc.text.slice(0, 2000) };
      if (L.ad) payload.ad = L.ad; else if (L.target) payload.target = scrubText(L.target).text;
      const r = await aiCall('cover', payload);
      if (gen !== dataGen) return;
      // The details that were taken out go back where the model kept their placeholder: the number given in
      // the request (“telefonumu ekle 0532 …”), else the one that was in the letter, else the CV's own.
      const vals = { phone: sc.found.phone || sl.found.phone || cv.phone, email: sc.found.email || sl.found.email || cv.email };
      const next = sanitizeLetter(Object.assign({}, L, fillLetter((r && r.letter) || {}, vals), { company: (r && r.company) || L.company, role: (r && r.role) || L.role, at: Date.now() }));
      if (!next || !next.paragraphs.length) throw { code: 'upstream', message: 'Ön yazı güncellenemedi.' };
      ui.letter = next;
      ui.coverReply = fillMarks(String((r && r.reply) || 'Ön yazı güncellendi.'), vals);
      drafts.coverReq = '';
      save();
      toast(ui.coverReply, 5000);
    } catch (e) { if (gen === dataGen) toolFail('coverRev', e); }
    finally { if (gen === dataGen) { toolBusy.coverRev = false; renderFinalTools(); } }
  }
  async function downloadLetter() {
    const L = ui.letter;
    if (!L || typeof PDF.buildLetter !== 'function') return;
    if (env.noDownload) { toast(noDownloadMsg(), 6000); return; }
    if (exportBusy) return;
    exportBusy = true;
    const b0 = $('#btn-letter-pdf'); if (b0) b0.disabled = true;
    try {
      await ensurePdfmake();
      const lang = L.lang || 'tr';
      const dd = PDF.buildLetter(Object.assign(letterCore(L), { date: L.date, name: cv.name }), pdfCv(),
        { template: tplId(), accent: settings.accent, lang, profile: iv.profile || 'deneyimli' });
      await saveDoc(dd, PDF.fileName(cv, { kind: 'letter', lang }));
    } catch (e) {
      console.error(e);
      toast('Ön yazı PDF’i oluşturulamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.', 5000);
    } finally {
      exportBusy = false;
      const b = $('#btn-letter-pdf'); if (b) b.disabled = false;
    }
  }
  function removeLetter() {
    ui.letter = null;
    ui.letterConfirm = false;
    ui.coverReply = '';
    save();
    renderFinalTools();
    toast('Ön yazı silindi.');
  }

  // ---- CV Kontrolü (brief §5.3.3): checks the app runs itself. No AI, no score; every item can be hidden.
  const MONTHS = P.MONTHS_TR && P.MONTHS_TR.length === 12 ? P.MONTHS_TR : ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
  const monthNow = () => { const d = new Date(Date.now()); return d.getFullYear() * 12 + d.getMonth(); };
  /** A CV date as months: "Mart 2021" → that month, "2021" → Ocak–Aralık, "Devam ediyor" → `now`; null if unreadable. */
  function dateSpan(s, now) {
    const raw = String(s || '').trim();
    if (!raw) return null;
    let n = raw;
    try { n = P.normalizeDate(raw) || raw; } catch (_) { n = raw; }
    if (n === 'Devam ediyor' || /^(present|current|now)$/i.test(raw)) return { lo: now, hi: now, month: true, present: true };
    const parts = /^(\S+) ((?:19|20)\d{2})$/.exec(n);
    if (parts && MONTHS.indexOf(parts[1]) >= 0) { const v = Number(parts[2]) * 12 + MONTHS.indexOf(parts[1]); return { lo: v, hi: v, month: true }; }
    if (/^(19|20)\d{2}$/.test(n)) { const y = Number(n); return { lo: y * 12, hi: y * 12 + 11, month: false }; }
    return null;
  }
  const jobName = (j) => String(j.company || j.role || 'Bir iş').trim();
  const jobKey = (j) => fk((j.company || '') + ' ' + (j.role || '')) || fk(j.desc).slice(0, 40) || 'x';
  /** Skills one by one, also from grouped lines ("Diller: Go, C#"). */
  function skillItems(text) {
    const out = [];
    String(text || '').split('\n').forEach((line) => {
      P.splitList(line.replace(/^\s*[^:,\n]{2,30}:\s*/, '')).forEach((s) => {
        const v = String(s).trim();
        if (v && !out.some((x) => fk(x) === fk(v))) out.push(v);
      });
    });
    return out;
  }
  const skKey = (s) => P.foldAscii(P.trLower(String(s || ''))).replace(/[^a-z0-9#+.]+/g, ' ').replace(/\s+/g, ' ').trim();
  /** Does the (skKey'd) text mention the skill? Short names need a word boundary; longer ones may carry a suffix (“Excel’de”). */
  function mentions(hay, skill) {
    const k = skKey(skill).replace(/\.$/, '');
    if (!k) return true;
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const left = /^[a-z0-9]/.test(k) ? '(^|[^a-z0-9])' : '';
    const right = k.length >= 4 ? '' : '(?![a-z0-9#+])';
    return new RegExp(left + esc + right).test(hay);
  }
  function nameMailHint(name, email) {
    const parts = fk(name).split(' ').filter(Boolean);
    if (!parts.length) return '';
    const dom = String(email).split('@')[1] || 'gmail.com';
    return ' (örneğin ' + (parts.length > 1 ? parts[0] + '.' + parts[parts.length - 1] : parts[0]) + '@' + dom + ')';
  }
  /**
   * Local CV checks. Pure: cvChecks(cv, {now, ai, pages, profile}) → items
   * {id, level: 'warn' (blocks “Hazır”) | 'info', text, fix, skills?[{id, name}]}, warnings first.
   * fix kinds: quick (edit sheet), step (manual step + field), set (one-tap value), ask (follow-up to the AI),
   * edit (prefilled “Değişiklik iste”). Ids carry the checked value, so a hidden item comes back if it changes.
   */
  function cvChecks(c, opts) {
    const o = opts || {};
    const now = typeof o.now === 'number' ? o.now : monthNow();
    const ai = !!o.ai;
    const out = [];
    const add = (id, level, text, fix, extra) => out.push(Object.assign({ id, level, text, fix: fix || null }, extra || {}));
    const quick = (label, title, paths) => ({ kind: 'quick', label, title, paths });
    const step = (label, stepId, path) => ({ kind: 'step', label, step: stepId, path: path || '' });
    const ask = (label, question, alt) => (ai ? { kind: 'ask', label, question } : alt);
    const jobs = (c.jobs || []).filter((j) => filled(j.role) || filled(j.company) || filled(j.desc));
    const projects = (c.projects || []).filter((q) => filled(q.name) || filled(q.desc));

    if (!filled(c.name)) add('name', 'warn', 'Adınız ve soyadınız yazılmamış.', quick('Ekle', 'Ad ve meslek', ['name', 'title']));
    if (!filled(c.phone) && !filled(c.email)) add('contact', 'warn', 'İletişim bilgisi yok; işverenler size ulaşamaz. Telefon ya da e-posta ekleyin.', quick('Ekle', 'İletişim', ['phone', 'email']));
    if (filled(c.phone) && !isTrPhone(c.phone)) {
      let n = c.phone;
      try { n = P.normalizePhone(c.phone) || c.phone; } catch (_) { n = c.phone; }
      if (isTrPhone(n)) add('phone-fmt:' + fk(c.phone), 'warn', 'Telefon numaranızın yazımı düzensiz. “' + n + '” olarak düzeltelim mi?', { kind: 'set', label: 'Düzelt', key: 'phone', value: n });
      else add('phone:' + fk(c.phone), 'warn', 'Telefon numaranız eksik ya da hatalı görünüyor (örnek: 0532 123 45 67). Yurt dışı numarasıysa bu uyarıyı gizleyebilirsiniz.', quick('Düzelt', 'İletişim', ['phone']));
    }
    if (filled(c.email)) {
      const em = c.email.trim();
      if (!isEmail(em)) add('email-bad:' + fk(em), 'warn', 'E-posta adresiniz hatalı görünüyor (örnek: ad.soyad@gmail.com).', quick('Düzelt', 'İletişim', ['email']));
      else if (!emailMatchesName(em, c.name)) add('email-nick:' + fk(em), 'info', 'E-posta adresiniz bir takma ad gibi görünüyor. İşverenler adınızla oluşturulmuş bir e-postayı daha ciddi bulur' + nameMailHint(c.name, em) + '.', quick('Değiştir', 'İletişim', ['email']));
    }
    if (!filled(c.title)) add('title', 'info', 'Mesleğiniz ya da aradığınız pozisyon yazılmamış; adınızın altında görünür.', quick('Ekle', 'Ad ve meslek', ['title']));
    if (!filled(c.summary)) {
      add('summary', 'warn', 'Profil (kısa özet) boş. İki üç cümlelik bir özet, CV’de ilk okunan yerdir.',
        ask('Birlikte yazalım', 'Kendinizi iki üç cümleyle anlatır mısınız? Ne iş yapıyorsunuz, kaç yıldır ve nasıl bir iş arıyorsunuz?', step('Ekle', 'profil', 'summary')));
    }

    const spans = [];
    jobs.forEach((j) => {
      const key = jobKey(j);
      const name = jobName(j);
      const dates = ['jobs.' + j.id + '.start', 'jobs.' + j.id + '.end'];
      if (!filled(j.desc)) {
        add('bullets:' + key, 'warn', '“' + name + '” işinde hiç madde yok. Neler yaptığınızı bir iki madde olarak ekleyin.',
          ask('Anlatayım', '“' + name + '” işinde neler yapıyordunuz? Varsa bir başarınızı ya da bir rakamı da söyleyin.', quick('Ekle', name, ['jobs.' + j.id + '.desc'])));
      }
      const s = dateSpan(j.start, now);
      const e = dateSpan(j.end, now);
      if (!filled(j.start)) { add('nodate:' + key, 'info', '“' + name + '” için tarih yazılmamış. Ne zaman başladığınızı ekleyin (örn. Mart 2021).', quick('Ekle', name + ' · tarihler', dates)); return; }
      if (s && e && e.hi < s.lo) { add('reversed:' + key, 'warn', '“' + name + '” işinin bitiş tarihi başlangıcından önce görünüyor. Tarihleri kontrol edin.', quick('Düzelt', name + ' · tarihler', dates)); return; }
      if ((s && !s.month) || (e && !e.month)) add('month:' + key, 'info', '“' + name + '” için yalnızca yıl yazılmış. Ayı da eklerseniz daha net olur (örn. Mart 2021).', quick('Ay ekle', name + ' · tarihler', dates));
      if (s && e) spans.push({ j, key, name, a: s.hi, b: e.lo });
    });
    // Two jobs certainly overlap when even their narrowest reading shares two months or more
    // (a job ending in the month the next one starts is a normal change, and "2019–2021, 2021–2023" is fine).
    for (let x = 0; x < spans.length; x++) {
      for (let y = x + 1; y < spans.length; y++) {
        const A = spans[x]; const B = spans[y];
        if (Math.min(A.b, B.b) - Math.max(A.a, B.a) >= 2) {
          add('overlap:' + [A.key, B.key].sort().join('|'), 'warn', '“' + A.name + '” ile “' + B.name + '” tarihleri çakışıyor. Aynı dönemde iki işte çalıştıysanız sorun yok; değilse tarihleri düzeltin.',
            step('Tarihlere git', 'deneyim', 'jobs.' + A.j.id + '.start'));
        }
      }
    }

    // Skills nobody can see in action (flagged only, never deleted).
    if (jobs.some((j) => filled(j.desc)) || projects.length) {
      const hay = skKey([].concat(jobs.map((j) => (j.role || '') + ' ' + (j.desc || '')), projects.map((q) => [q.name, q.tech, q.desc].join(' ')), [c.certs || '']).join(' \n '));
      const lone = skillItems(c.skills).filter((sk) => !mentions(hay, sk)).slice(0, 12);
      if (lone.length) {
        add('skills', 'info', 'Şu beceriler hiçbir maddede ya da projede geçmiyor. Nerede kullandığınızı anlatırsanız daha inandırıcı olur; hiçbirini silmem.',
          ai ? null : step('Maddelere git', 'deneyim'), { skills: lone.map((sk) => ({ id: 'skill:' + fk(sk), name: sk })) });
      }
    }

    const pages = Number(o.pages) || 0;
    const cut = (n) => (ai ? { kind: 'edit', label: 'Kısaltmayı iste', instruction: 'CV’yi ' + n + ' sayfaya sığacak şekilde kısalt: eski işlerin maddelerini azalt, en yeni işlere dokunma.' } : step('Maddelere git', 'deneyim'));
    if (pages > 2) add('pages:' + pages, 'warn', 'CV’niz ' + pages + ' sayfa. En fazla 2 sayfa önerilir; eski işlerin maddelerini kısaltın.', cut('iki'));
    else if (pages === 2 && (o.profile === 'ogrenci' || o.profile === 'saha')) {
      add('onepage:' + o.profile, 'info', (o.profile === 'ogrenci' ? 'Öğrenci ve yeni mezun' : 'Saha ve ustalık') + ' CV’leri genelde tek sayfa olur; sizinki 2 sayfa.', cut('tek'));
    }

    if (!jobs.length && o.profile !== 'ogrenci') add('nojobs', 'info', 'İş deneyimi eklenmemiş. Staj, gönüllülük ya da aile işinde yardım da sayılır.', step('Ekle', 'deneyim'));
    if (!(c.edu || []).some((x) => filled(x.school) || filled(x.program))) add('noedu', 'info', 'Eğitim bilgisi eklenmemiş.', step('Ekle', 'egitim'));
    if (!filled(c.skills)) add('noskills', 'info', 'Beceriler boş. Kullandığınız programları, araçları ya da makineleri ekleyin.', step('Ekle', 'yetenek', 'skills'));
    return out.filter((x) => x.level === 'warn').concat(out.filter((x) => x.level !== 'warn'));
  }
  /** The checks minus what the person hid (skills one by one). */
  function visibleChecks() {
    const dis = new Set(ui.dismissed);
    const out = [];
    cvChecks(cv, { ai: aiUsable(), pages: ui.pages.master, profile: iv.profile }).forEach((it) => {
      if (it.skills) { const left = it.skills.filter((s) => !dis.has(s.id)); if (left.length) out.push(Object.assign({}, it, { skills: left })); return; }
      if (!dis.has(it.id)) out.push(it);
    });
    return out;
  }
  function checkCard() {
    if (!PDF.hasContent(cv)) return null;
    const items = visibleChecks();
    const warn = items.some((i) => i.level === 'warn');
    return h('div', { class: 'tool-group checks', id: 'cv-check' },
      h('h2', { class: 'group-title' }, 'CV Kontrolü'),
      warn ? h('p', { class: 'chk-title' }, 'Düzeltmeniz önerilenler')
        : h('p', { class: 'ready', role: 'status' }, h('b', null, 'Hazır ✓'), ' ', items.length ? 'Aşağıdakiler yalnızca öneri.' : 'Düzeltilmesi gereken bir şey bulamadım.'),
      items.length ? h('ul', { class: 'chk-list' }, items.map(checkItem)) : null,
      ui.dismissed.length ? h('button', { type: 'button', class: 'link-btn', onclick: () => { ui.dismissed = []; save(); renderFinalTools(); } }, 'Gizlediğim uyarıları geri getir') : null);
  }
  function checkItem(it) {
    const warn = it.level === 'warn';
    const a = ui.chkAsk;
    const asking = !!a && (a.id === it.id || (!!it.skills && it.skills.some((s) => s.id === a.id)));
    return h('li', { class: 'chk ' + it.level },
      h('span', { class: 'chk-ico', 'aria-hidden': 'true' }, warn ? '!' : 'i'),
      h('div', { class: 'chk-main' },
        h('p', null, h('span', { class: 'sr' }, warn ? 'Düzeltilmeli: ' : 'Öneri: '), it.text),
        it.skills ? h('div', { class: 'chips', role: 'group', 'aria-label': 'Maddelerde geçmeyen beceriler' }, it.skills.map((s) => (aiUsable()
          ? h('button', {
            type: 'button', class: 'chip big', 'aria-pressed': a && a.id === s.id ? 'true' : 'false', dataset: { fkey: 'sk-' + s.id },
            onclick: () => openCheckAsk(s.id, '“' + s.name + '” becerinizi nerede, ne için kullandınız? Kısaca anlatın.'),
          }, s.name)
          : h('span', { class: 'chip' }, s.name)))) : null,
        it.skills && aiUsable() && !asking ? h('p', { class: 'mini-note' }, 'Bir beceriye dokunun; nerede kullandığınızı anlatın.') : null,
        asking ? askPanel() : null,
        h('div', { class: 'btn-row' },
          it.fix ? h('button', { type: 'button', class: 'btn small' + (warn ? ' primary' : ''), dataset: { fkey: 'fix-' + it.id }, onclick: () => runFix(it) }, it.fix.label) : null,
          h('button', { type: 'button', class: 'text-btn', 'aria-label': 'Bu öneriyi gizle', onclick: () => dismissCheck(it) }, 'Gizle'))));
  }
  function openCheckAsk(id, question) {
    if (rec.wanted) stopConvo();
    ui.chkAsk = ui.chkAsk && ui.chkAsk.id === id ? null : { id, question };
    if (ui.chkAsk) ui.focusKey = 'dr-chk:' + id;
    renderFinalTools();
  }
  function askPanel() {
    const a = ui.chkAsk;
    return h('div', { class: 'ask-panel' },
      h('p', { class: 'ask-q' }, a.question),
      draftBox('chk:' + a.id, { label: a.question, ph: 'Söyleyin ya da yazın', done: () => sendCheckAsk() }),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn small primary', onclick: () => sendCheckAsk() }, 'Gönder'),
        h('button', { type: 'button', class: 'btn small', onclick: () => { if (rec.wanted) stopConvo(); ui.chkAsk = null; renderFinalTools(); } }, 'Vazgeç')));
  }
  /** A follow-up answer from CV Kontrolü goes into the master CV through the extract queue. */
  function sendCheckAsk() {
    const a = ui.chkAsk;
    if (!a) return;
    const key = 'chk:' + a.id;
    const text = (drafts[key] || '').trim();
    if (rec.wanted) stopConvo();
    if (text.length < 2) { toast('Kısaca söyleyin ya da yazın.'); return; }
    if (!askConsent(sendCheckAsk)) return;
    enqueue({ topic: 'followup', question: a.question.slice(0, 400), answer: text });
    drafts[key] = '';
    ui.chkAsk = null;
    renderFinalTools();
    toast('Teşekkürler. Cevabınız CV’nize işleniyor.', 4000);
  }
  function runFix(it) {
    const f = it.fix;
    if (!f) return;
    if (f.kind === 'ask') { openCheckAsk(it.id, f.question); return; }
    if (f.kind === 'quick') { openQuickEdit(f.title, f.paths.filter(pathExists)); return; }
    if (f.kind === 'set') { cv[f.key] = f.value; afterChange(); renderAll(); toast('Düzeltildi: ' + f.value); return; }
    if (f.kind === 'edit') {
      ui.editDraft = f.instruction;
      renderFinalTools();
      focusEl('#edit-req');
      toast('İsteği yazdım; uygulamak için “Uygula”ya dokunun.', 4500);
      return;
    }
    if (f.kind === 'step') jumpTo(f.step, f.path);
  }
  function jumpTo(stepId, path) {
    const i = STEPS.findIndex((s) => s.id === stepId);
    if (i < 0) return;
    goStep(i);
    if (path && pathExists(path)) { setActive(path, { scroll: true }); focusActive(); }
  }
  function dismissCheck(it) {
    const ids = it.skills ? it.skills.map((s) => s.id) : [it.id];
    ui.dismissed = ui.dismissed.concat(ids.filter((x) => !ui.dismissed.includes(x))).slice(-200);
    if (ui.chkAsk && ids.includes(ui.chkAsk.id)) ui.chkAsk = null;
    save();
    renderFinalTools();
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
    if (el.id === 'sheet-edit') renderAll();
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
    // “Verilerimi sil”: everything this app keeps in this browser (CV, interview, consent, mic note, invite code).
    const wipeBox = h('div', { class: 'wipe', id: 'wipe-box' });
    const wipeNote = 'Bu cihazdaki tüm bilgileriniz silinir. Sunucumuzda zaten bir şey saklanmaz.';
    const showWipe = (ask) => {
      wipeBox.replaceChildren(...(ask
        ? [h('p', { class: 'fine' }, h('b', null, 'Emin misiniz? '), wipeNote),
          h('div', { class: 'btn-row' },
            h('button', { type: 'button', class: 'btn small danger', dataset: { fkey: 'wipe-yes' }, onclick: wipeData }, icon('trash'), 'Evet, hepsini sil'),
            h('button', { type: 'button', class: 'btn small', dataset: { fkey: 'wipe-no' }, onclick: () => { showWipe(false); const b = $('[data-fkey="wipe-ask"]'); if (b) b.focus(); } }, 'Vazgeç'))]
        : [h('div', { class: 'btn-row' }, h('button', {
          type: 'button', class: 'btn small', dataset: { fkey: 'wipe-ask' },
          onclick: () => { showWipe(true); const b = $('[data-fkey="wipe-yes"]'); if (b) b.focus(); },
        }, icon('trash'), 'Verilerimi sil')),
        h('p', { class: 'fine' }, wipeNote)]));
    };
    showWipe(false);
    keepFocus(() => body.replaceChildren(...[
      h('div', { class: 'opts' },
        switchRow('set-tts', 'Soruları sesli oku', env.ttsVoice === false ? 'Bu cihazda Türkçe ses bulunamadı.' : '', ttsOn(), (v) => { settings.tts = v; save(); refreshTtsBtn(); }, env.ttsVoice === false),
        micUsable() ? autoNextRow('set-auto') : null,
        h('div', { class: 'opt-row' },
          h('span', null, 'Konuşacağınız dil', h('small', null, 'Yanıtları hangi dilde söyleyeceksiniz?')),
          h('div', { class: 'seg', role: 'group', 'aria-label': 'Konuşma dili' },
            h('button', { type: 'button', 'aria-pressed': settings.speechLang === 'tr-TR' ? 'true' : 'false', dataset: { fkey: 'sl-tr' }, onclick: () => { setSpeechLang('tr-TR'); openSettings(); } }, 'Türkçe'),
            h('button', { type: 'button', 'aria-pressed': settings.speechLang === 'en-US' ? 'true' : 'false', dataset: { fkey: 'sl-en' }, onclick: () => { setSpeechLang('en-US'); openSettings(); } }, 'English')))),
      settings.speechLang === 'en-US' ? h('p', { class: 'mini-note' }, 'İngilizce konuşurken komutlar: next, skip, back, yes, no, undo, repeat, stop. Sorular yine Türkçe okunur.') : null,
      h('details', { class: 'more', style: { marginTop: '12px' } },
        h('summary', null, 'Sesli komutlar'),
        voiceHelp()),
      h('div', { style: { marginTop: '18px' } }, resetBox),
      h('div', { style: { marginTop: '14px' } }, wipeBox),
      h('p', { class: 'fine', style: { marginTop: '14px' } }, privacyLine())].filter(Boolean)));
    openSheet('sheet-settings');
    if (confirmReset) { const b = $('[data-fkey="reset-yes"]'); if (b) b.focus(); }
  }
  function setSpeechLang(l) {
    settings.speechLang = l;
    rec.setLang(l);
    save();
  }
  function resetAll(silent) {
    stopConvo();
    // Calls still out belong to the CV being thrown away: aborted, and any late reply is dropped.
    newDataGen();
    cv = blankCv();
    setIv(blankInterview());
    ui.cvEn = null; ui.cvEnFor = ''; ui.editDraft = ''; ui.lastReply = '';
    ui.suggestions = {};
    ui.applied = {};
    ui.gateOpen = {};
    ui.story = '';
    ui.resumeStep = 0;
    ui.tailored = null; ui.letter = null;
    ui.dismissed = []; ui.adDraft = ''; ui.view = 'master'; ui.pages = {}; ui.toolErr = {}; ui.chkAsk = null;
    ui.styleDirty = false; ui.restyleUndo = null; ui.coverTarget = null; ui.coverReply = '';
    ui.tailorConfirm = false; ui.coverConfirm = false; ui.letterConfirm = false;
    Object.keys(drafts).forEach((k) => { delete drafts[k]; });
    ui.pickProfile = false; ui.k2 = {}; ui.phoneDraft = '';
    resetTopicUi();
    undoStacks.clear();
    clearTimeout(draftTimer);
    try { localStorage.removeItem(STORE_KEY); } catch (_) { /* ignore */ }
    hideSheet($('#sheet-settings'));
    goStep(0);
    ui.resumeStep = 0;
    if (silent !== true) toast('Yeni bir CV’ye başladınız.');
  }
  /** Removes every `sesli-cv:*` key from this browser's storage. */
  function clearStore() {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf('sesli-cv:') === 0) keys.push(k); }
      keys.forEach((k) => localStorage.removeItem(k));
    } catch (_) { /* ignore */ }
  }
  function wipeData() {
    resetAll(true);
    consent = '';
    ui.micPrimed = false;
    clearTimeout(saveTimer);
    clearTimeout(draftTimer);
    clearStore();
    const el = $('#saved'); if (el) el.textContent = '';
    if (aiState.status === 'ok') pingAI(); // an invite code may have been removed too
    toast('Bu cihazdaki bilgileriniz silindi.', 5000);
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
      if (ui.mode === 'talk') {
        if (talkGate() || iv.phase === 'waiting' || iv.phase === 'finalizing') { toast('Önce ekrandaki seçeneklerden birine dokunun.'); return; }
        if (!micUsable()) {
          if (ttsOn()) { conv.on = true; conv.mode = 'talk'; askTopic(); }
          else { const ta = $('#answer'); if (ta) ta.focus(); toast(dictationHelp(), 5000); }
          return;
        }
        conv.on = true; conv.mode = 'talk'; keepAwake(); askTopic({ speak: false });
        return;
      }
      if (!micUsable()) {
        if (ttsOn()) startConvo();
        else { focusActive(); toast(dictationHelp(), 5000); }
        return;
      }
      startConvo();
    });
    $('#btn-next').addEventListener('click', () => {
      if (ui.mode === 'talk') { submitAnswer(); return; }
      if (STEPS[ui.step].kind === 'preview') { downloadPdf(); return; }
      const s = conv.slot;
      if (conv.on && s && s.step === ui.step) {
        if (s.kind === 'gate' || s.kind === 'more') { answerGate(s, false); return; }
        if (s.kind === 'field' || s.kind === 'photo' || s.kind === 'review') { advance(s); return; }
      }
      goStep(ui.step + 1);
    });
    $('#btn-back').addEventListener('click', () => { if (ui.mode === 'talk') prevTopic(); else goStep(ui.step - 1); });
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
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.defaultPrevented && !openSh && ui.mode === 'talk') {
        // Ctrl+Enter sends the answer in the interview (but never from the name-fix form or the GitHub box).
        if (!e.target.closest('.fix-form, #gh-user')) { e.preventDefault(); submitAnswer(); }
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.defaultPrevented && !openSh && STEPS[ui.step].kind !== 'preview' && !e.target.closest('textarea')) {
        e.preventDefault(); goStep(ui.step + 1);
      }
    });
    D.addEventListener('visibilitychange', () => { if (D.hidden && (rec.wanted || conv.speaking || conv.on)) stopConvo(); });
    if (!IN_VIEWER) {
      window.addEventListener('popstate', (e) => {
        const openSh = $$('.sheet').find((s) => !s.hidden);
        if (openSh) { hideSheet(openSh); return; }
        if (ui.mode === 'talk') { try { history.pushState({ step: ui.step, talk: true }, ''); } catch (_) { /* ignore */ } prevTopic(); return; }
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
    try { ui.micPrimed = localStorage.getItem('sesli-cv:primed') === '1'; } catch (_) { /* ignore */ }
    try {
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: 'microphone' }).then((st) => {
          env.micPerm = st.state;
          st.onchange = () => { env.micPerm = st.state; };
        }).catch(() => {});
      }
    } catch (_) { /* ignore */ }
    try { consent = localStorage.getItem(CONSENT_KEY) === CONSENT_V ? CONSENT_V : ''; } catch (_) { consent = ''; }
    const stored = hotData && hotData.cv ? hotData : load();
    if (stored) {
      cv = sanitizeCv(stored.cv);
      settings = sanitizeSettings(stored.settings);
      setIv(sanitizeInterview(stored.interview));
      if (stored.consent === CONSENT_V) consent = CONSENT_V;
      ui.tailored = sanitizeTailored(stored.tailored);
      ui.letter = sanitizeLetter(stored.letter);
      ui.dismissed = sanitizeDismissed(stored.dismissed);
      ui.adDraft = strOf(stored.adDraft, AD_MAX + 2000) || (ui.tailored && ui.tailored.ad) || '';
      if (stored.cvEn && typeof stored.cvEnFor === 'string') { ui.cvEn = sanitizeCv(stored.cvEn); ui.cvEnFor = stored.cvEnFor; }
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
    pingAI();
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
    get iv() { return iv; }, get ai() { return aiState; }, get topics() { return TOPICS; }, get consent() { return consent; },
    submitAnswer, startTalk, talkGoto, pingAI, runQueue, finalizeCv,
    simulateFinal: (s) => onFinal(s, conv.slot),
    goStep, askSlot, startConvo, stopConvo, renderPreviews, slotsFor, nextSlot, isRefusal, mapChoice, gateAnswer,
    // interview v2
    topicsFor, setProfile, chooseProfile, hasConsent, giveConsent, askConsent, aiCall, scrubText, emailMatchesName, isTrPhone,
    parseMilitary, composeMilitary, sanitizeInterview, ivForBackup, wipeData, nextTopic, prevTopic, loopAnswer, skipFollowup,
    // final screen v2
    cvChecks, visibleChecks, dateSpan, skillItems, tplId, pdfCv, variantCv, letterText, sanitizeTailored, sanitizeLetter, sanitizeSettings,
    doTailor, doCover, doCoverRevise, doRestyle, downloadLetter, renderFinalTools, get drafts() { return drafts; },
    // fixes round: pure helpers for tests
    fillMarks, isEndWord, isPhoneSpeech, dictatedEmail, mergeReply, undoRestyle, doEdit, doTranslate, resetAll, importJson, chromeIntentUrl, shareUrl,
    get dataGen() { return dataGen; },
    load: (data) => { cv = sanitizeCv(data); afterChange(); renderAll(); },
  };

  try { if (window.claude && window.claude.hot && window.claude.hot.snapshot) window.claude.hot.snapshot(() => ({ cv, settings, step: ui.step })); } catch (_) { /* ignore */ }
  const hot = window.claude && window.claude.hot;
  if (hot && typeof hot.ready === 'function') hot.ready(start);
  else start((hot && hot.data) || null);
})();
