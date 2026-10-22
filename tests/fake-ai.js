/* Test-only fake /api/cv: answers in the browser so the interview UI can be exercised without a server.
   window.fakeAI = {
     delay: ms before each answer (default 600),
     fail: null | 'network' | 'upstream' | 'access_code' | 'rate_limited' | 'not_configured' | 'bad_request' | 'internal' | 'too_large'
           (every op fails this way),
     failOps: { tailor: 'upstream', … } (only these ops fail; wins over `fail`),
     calls: [request bodies, oldest first], headers: [request headers, same order],
     last(op?) → latest request body (of that op) or null,  count(op?) → number of requests,
     sent(text) → true when any request so far contained text (privacy checks),  reset() → clears calls and failures,
     aborted: number of requests cancelled through their AbortSignal while they waited (like a real fetch: AbortError)
   }
   Contract mirrored from api/cv.py: extract → {cv, heard, missing[], confirm[]}, review {hints} → {followups},
   tailor {ad} → {cv, company, role, matched[], missing[], changes[]}, cover → {letter, company, role, reply}. */
(function () {
  const realFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  const cfg = window.fakeAI = {
    delay: 600, fail: null, failOps: {}, calls: [], headers: [], aborted: 0,
    last(op) {
      for (let i = this.calls.length - 1; i >= 0; i--) if (!op || this.calls[i].op === op) return this.calls[i];
      return null;
    },
    count(op) { return this.calls.filter((c) => !op || c.op === op).length; },
    sent(text) {
      const t = String(text);
      return this.calls.some((c) => JSON.stringify(c).indexOf(t) >= 0) || this.headers.some((h) => JSON.stringify(h).indexOf(t) >= 0);
    },
    reset() { this.calls.length = 0; this.headers.length = 0; this.fail = null; this.failOps = {}; this.aborted = 0; },
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const reply = (status, body, headers) => new Response(JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) });
  const lower = (t) => String(t || '').replace(/I/g, 'ı').replace(/İ/g, 'i').toLowerCase();
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);

  const ERRORS = {
    access_code: [401, 'Erişim kodu eksik ya da hatalı.'],
    upstream: [502, 'Yapay zekâ hizmetine şu an ulaşılamıyor. Lütfen biraz sonra tekrar deneyin.'],
    rate_limited: [429, 'Çok fazla istek gönderildi. Lütfen birkaç dakika sonra tekrar deneyin.'],
    not_configured: [503, 'Yapay zekâ hizmeti henüz ayarlanmamış.'],
    bad_request: [400, 'Geçersiz istek.'],
    internal: [500, 'Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.'],
    too_large: [413, 'İstek çok büyük.'],
  };
  function failure(mode) {
    if (mode === 'network') throw new TypeError('Failed to fetch');
    const code = ERRORS[mode] ? mode : 'upstream';
    const body = { error: code, message: '(deneme) ' + ERRORS[code][1] };
    if (code === 'rate_limited') { body.retryAfter = 30; return reply(429, body, { 'Retry-After': '30' }); }
    return reply(ERRORS[code][0], body);
  }
  const bad = (message) => reply(400, { error: 'bad_request', message });

  // one plausible follow-up per topic (extract → missing[])
  const MISSING = {
    about: 'Hangi şehirde yaşıyorsunuz?',
    goal: 'Nasıl bir iş arıyorsunuz?',
    experience: 'Bu işte kaç kişilik bir ekiple çalıştınız?',
    education: 'Hangi yıl mezun oldunuz?',
    projects: 'Bu projede tam olarak siz ne yaptınız?',
    skills: 'Hangi programları kullanabiliyorsunuz?',
    extras: 'Bir sertifikanız ya da ehliyetiniz var mı?',
    free: 'En son nerede çalıştınız?',
  };
  const AD_TERMS = ['SAP', 'Forklift', 'Excel', 'İngilizce', 'SQL', 'Python', 'Docker', 'Stok yönetimi', 'Ekip yönetimi', 'Vardiya'];
  function fromAd(ad, re) { const m = re.exec(ad || ''); return m ? m[1].trim().slice(0, 120) : ''; }
  function adCompany(ad) { return fromAd(ad, /(?:firma|şirket|company)\s*:\s*([^\n]+)/i) || (ad ? 'Kuzey Lojistik' : ''); }
  function adRole(ad, cv, target) { return fromAd(ad, /(?:pozisyon|unvan|position)\s*:\s*([^\n]+)/i) || String(target || '').trim() || cv.title || 'Depo Sorumlusu'; }

  function extract(body, cv) {
    const t = body.topic;
    const answer = String(body.answer || '').trim();
    const github = Array.isArray(body.github) ? body.github : [];
    if (!answer && !github.length) return bad('Cevap boş görünüyor. Lütfen tekrar konuşun.');
    const ans = answer.slice(0, 140);
    if (t === 'about') { cv.name = cv.name || 'Deneme Kişi'; cv.title = cv.title || 'Yazılım Geliştirici'; cv.city = 'İzmir'; }
    else if (t === 'goal' || t === 'followup') cv.summary = ((cv.summary || '') + ' ' + ans).trim();
    else if (t === 'experience') cv.jobs = (cv.jobs || []).concat([{ company: 'Örnek A.Ş.', role: 'Geliştirici', city: 'İzmir', start: 'Mart 2021', end: 'Devam ediyor', bullets: [ans] }]);
    else if (t === 'education') cv.edu = (cv.edu || []).concat([{ school: 'Ege Üniversitesi', program: 'Bilgisayar Mühendisliği', degree: 'Lisans', start: '2014', end: '2018', note: '' }]);
    else if (t === 'projects') cv.projects = (cv.projects || []).concat(github.slice(0, 2).map((r) => ({ name: r.name, tech: r.language, link: r.url, bullets: [r.description || 'GitHub projesi'] })).concat(ans ? [{ name: 'Sözlü proje', tech: 'Python', link: '', bullets: [ans] }] : []));
    else if (t === 'skills') {
      const add = ['Python', 'SQL'];
      cv.skills = list(cv.skills).concat(add.filter((x) => !list(cv.skills).includes(x)));
      if (body.profile === 'yazilim') {
        const groups = Array.isArray(cv.skillGroups) ? cv.skillGroups : [];
        cv.skillGroups = groups.concat([{ name: 'Diller', items: ['Python'] }, { name: 'Veritabanı', items: ['SQL'] }]);
      }
    } else if (t === 'extras' && /ingilizce/.test(lower(ans))) {
      cv.langs = (cv.langs || []).concat([{ name: 'İngilizce', level: 3, cefr: 'B2', exam: '' }]);
    } else cv.certs = (cv.certs || []).concat([ans]);
    const q = MISSING[t];
    return reply(200, {
      cv,
      heard: '(deneme) ' + t + ' bölümüne eklendi: ' + ans.slice(0, 40),
      missing: q ? ['(deneme) ' + q] : [],
      confirm: t === 'experience' ? ['Örnek A.Ş.'] : [],
    });
  }

  function review(body) {
    const seen = {}, hints = [];
    list(body.hints).forEach((h) => { const k = lower(h); if (!seen[k]) { seen[k] = 1; hints.push(h); } });
    return reply(200, { followups: hints.length ? hints.slice(0, 5) : ['(deneme) Son işinize hangi ay başladınız?', '(deneme) Hangi programları kullanabiliyorsunuz?'] });
  }

  function tailor(body, cv) {
    const ad = String(body.ad || '').trim();
    if (ad.length < 40) return bad('İlan metni boş ya da çok kısa görünüyor. Lütfen ilanın tamamını yapıştırın.');
    if (ad.length > 10000) return bad('İlan metni çok uzun. Lütfen yalnızca ilanın kendisini yapıştırın.');
    const adLow = lower(ad);
    const inAd = (term) => adLow.indexOf(lower(term)) >= 0;
    const first = (items) => items.filter(inAd).concat(items.filter((x) => !inAd(x)));
    const skills = list(cv.skills);
    const company = adCompany(ad), role = adRole(ad, cv);
    // a reordered copy: same facts, ad terms first
    cv.skills = first(skills);
    if (Array.isArray(cv.skillGroups)) cv.skillGroups = cv.skillGroups.map((g) => Object.assign({}, g, { items: first(list(g && g.items)) }));
    cv.jobs = (cv.jobs || []).map((j) => Object.assign({}, j, { bullets: list(j.bullets).slice().reverse() }));
    if (cv.summary) cv.summary = cv.summary + ' (deneme: ' + role + ' için uyarlandı)';
    const cvText = lower(JSON.stringify(cv));
    const matched = skills.filter(inAd).slice(0, 15).map((term) => ({ term, where: 'Yetenekler' }));
    (cv.jobs || []).forEach((j) => { if (j.role && inAd(j.role)) matched.push({ term: j.role, where: 'Deneyim: ' + (j.company || j.role) }); });
    let missing = AD_TERMS.filter((term) => inAd(term) && cvText.indexOf(lower(term)) < 0).slice(0, 3)
      .map((term) => ({ term, question: '(deneme) ' + term + ' ile ilgili deneyiminiz var mı? Varsa kısaca anlatın.' }));
    if (!missing.length) missing = [{ term: 'Vardiyalı çalışma', question: '(deneme) Vardiyalı çalıştığınız oldu mu?' }];
    const changes = ['(deneme) Yetenekler ilana göre sıralandı.', '(deneme) Deneyim maddelerinin sırası ilana göre değişti.'];
    if (cv.summary) changes.push('(deneme) Profil ' + (company || 'ilan') + ' için yeniden yazıldı.');
    return reply(200, { cv, company, role, matched: matched.slice(0, 15), missing, changes });
  }

  function cover(body, cv) {
    const ad = String(body.ad || '').trim();
    if (ad.length > 10000) return bad('İlan metni çok uzun. Lütfen yalnızca ilanın kendisini yapıştırın.');
    const instruction = String(body.instruction || '').trim();
    const company = adCompany(ad), role = adRole(ad, cv, body.target);
    const old = body.letter;
    if (old && typeof old === 'object' && list(old.paragraphs).length && instruction) {
      const letter = {
        recipient: list(old.recipient).slice(0, 3), subject: String(old.subject || ''), greeting: String(old.greeting || ''),
        paragraphs: list(old.paragraphs).slice(0, 5), closing: String(old.closing || ''),
      };
      const i = letter.paragraphs.length - 1;
      letter.paragraphs[i] = letter.paragraphs[i] + ' (deneme: ' + instruction.slice(0, 60) + ')';
      return reply(200, { letter, company, role, reply: '(deneme) Ön yazı güncellendi: ' + instruction.slice(0, 40) });
    }
    const job = (cv.jobs || [])[0];
    const skills = list(cv.skills).slice(0, 3);
    const paragraphs = [
      company ? company + ' bünyesindeki ' + role + ' pozisyonuna başvurmak istiyorum.' : role + ' olarak çalışabileceğim bir pozisyona başvurmak istiyorum.',
      job ? (job.company || 'Son işyerim') + ' şirketinde ' + (job.role || 'çalışan') + ' olarak çalıştım. ' + (list(job.bullets)[0] || 'İşimi özenle yaptım.')
        : 'Eğitimim ve bugüne kadarki deneyimlerim bu işe hazır olduğumu gösteriyor.',
      skills.length ? 'Özellikle ' + skills.join(', ') + ' konularında kendimi geliştirdim.' : 'Yeni şeyler öğrenmeye ve ekip içinde çalışmaya açığım.',
    ];
    if (ad) paragraphs.push('İlanınızda aranan niteliklere uyduğumu düşünüyorum; görüşme fırsatı verirseniz kendimi daha ayrıntılı anlatmaktan memnuniyet duyarım.');
    return reply(200, {
      letter: {
        recipient: company ? [company, 'İnsan Kaynakları Departmanı'] : ['İnsan Kaynakları Departmanı'],
        subject: role + ' pozisyonu başvurusu', greeting: 'Sayın Yetkili,', paragraphs, closing: 'Saygılarımla,',
      },
      company, role,
      reply: ad ? '(deneme) Ön yazınız ilana göre hazırlandı.' : '(deneme) İlan olmadan genel bir ön yazı hazırlandı.',
    });
  }

  window.fetch = async function (url, init) {
    if (!String(url).endsWith('/api/cv')) {
      if (realFetch) return realFetch(url, init);
      throw new TypeError('Failed to fetch');
    }
    let body;
    try { body = JSON.parse((init && init.body) || '{}'); } catch (_) { body = null; }
    cfg.calls.push(body && typeof body === 'object' ? body : {});
    cfg.headers.push(Object.assign({}, (init && init.headers) || {}));
    // An aborted request rejects like fetch does (the app cancels its calls when the data is wiped).
    await new Promise((resolve, reject) => {
      const sig = init && init.signal;
      let waiting = true;
      const abort = () => { if (!waiting) return; waiting = false; cfg.aborted++; const e = new Error('The operation was aborted.'); e.name = 'AbortError'; reject(e); };
      if (sig && sig.aborted) { abort(); return; }
      const t = setTimeout(() => { waiting = false; resolve(); }, cfg.delay);
      if (sig && typeof sig.addEventListener === 'function') sig.addEventListener('abort', () => { if (waiting) { clearTimeout(t); abort(); } });
    });
    if (!body || typeof body !== 'object') return reply(400, { error: 'bad_request', message: 'İstek okunamadı (geçersiz JSON).' });
    const mode = (cfg.failOps && cfg.failOps[body.op]) || cfg.fail;
    if (mode) return failure(mode);
    const cv = clone(body.cv || {});
    switch (body.op) {
      case 'ping': return reply(200, { ok: true, configured: true });
      case 'extract': return extract(body, cv);
      case 'review': return review(body);
      case 'finalize': cv.summary = (cv.summary || '') + ' (düzenlendi' + (body.style === 'resmi' ? ', resmi' : '') + ')'; return reply(200, { cv });
      case 'edit': return reply(200, { cv, reply: '(deneme) İsteğiniz uygulandı: ' + String(body.instruction || '').slice(0, 40) });
      case 'translate': cv.title = 'Software Developer'; return reply(200, { cv });
      case 'tailor': return tailor(body, cv);
      case 'cover': return cover(body, cv);
      default: return bad('Bilinmeyen işlem.');
    }
  };
})();
