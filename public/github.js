/* Sesli CV — GitHub'dan herkese açık depoları çeker (global: CVGitHub). Anahtar gerekmez; GitHub
   kimliksiz istekleri IP başına saatte 60 ile sınırlar, bu yüzden en fazla 1 + 6 istek yapılır. */
(function (root) {
  'use strict';

  const API = 'https://api.github.com';
  const P = root.CVParse;

  /** "github.com/ayse", "https://github.com/ayse/", "github nokta com slash ayse", "@ayse", "ayse" → "ayse" */
  function parseUser(input) {
    let t = String(input || '').trim();
    if (!t) return '';
    if (/\s/.test(t) && P && P.normalizeUrl) t = P.normalizeUrl(t); // dictated form
    t = t.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/^@/, '');
    const m = /^github\.com\/([^/?#\s]+)/i.exec(t);
    if (m) t = m[1];
    t = t.replace(/\/.*$/, '');
    return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(t) ? t : '';
  }

  async function getJson(url, accept) {
    let r;
    try { r = await root.fetch(url, { headers: { Accept: accept || 'application/vnd.github+json' } }); }
    catch (_) { throw { code: 'network', message: 'GitHub’a ulaşılamadı. İnternet bağlantınızı kontrol edin.' }; }
    if (r.status === 404) throw { code: 'not_found', message: 'Bu kullanıcı adıyla bir GitHub hesabı bulunamadı.' };
    if (r.status === 403 || r.status === 429) throw { code: 'rate_limited', message: 'GitHub şu an çok fazla istek aldı; birkaç dakika sonra tekrar deneyin.' };
    if (!r.ok) throw { code: 'http_' + r.status, message: 'GitHub bir hata döndürdü.' };
    return accept && accept.indexOf('raw') >= 0 ? r.text() : r.json();
  }

  // README'den CV için işe yarar metin: rozetler, resimler, HTML ve kod blokları atılır.
  function readmeExcerpt(md, max) {
    let t = String(md || '');
    t = t.replace(/```[\s\S]*?```/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return t.length > (max || 2500) ? t.slice(0, max || 2500) + '…' : t;
  }

  function score(r) {
    const ageDays = r.pushed ? (Date.now() - Date.parse(r.pushed)) / 864e5 : 9999;
    return r.stars * 3 + (r.description ? 4 : 0) + (r.topics.length ? 2 : 0) + (r.homepage ? 2 : 0) +
      Math.min(6, (r.size || 0) / 500) + Math.max(0, 6 - ageDays / 120);
  }

  /** Kullanıcının çatallanmamış, arşivlenmemiş depoları; en anlamlıdan aza doğru. */
  async function listRepos(user) {
    const u = parseUser(user);
    if (!u) throw { code: 'bad_user', message: 'GitHub kullanıcı adı anlaşılamadı. Örnek: github.com/kullaniciadi' };
    const list = await getJson(API + '/users/' + encodeURIComponent(u) + '/repos?per_page=100&sort=pushed&type=owner');
    const repos = (Array.isArray(list) ? list : []).filter((x) => x && !x.fork && !x.archived && !x.disabled)
      .filter((x) => String(x.name).toLowerCase() !== u.toLowerCase()) // profil README deposu
      .map((x) => ({
        name: String(x.name || ''),
        description: String(x.description || ''),
        language: String(x.language || ''),
        stars: Number(x.stargazers_count) || 0,
        url: String(x.html_url || '').replace(/^https?:\/\//, ''),
        homepage: String(x.homepage || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
        topics: Array.isArray(x.topics) ? x.topics.slice(0, 8).map(String) : [],
        updated: String(x.pushed_at || '').slice(0, 10),
        pushed: x.pushed_at || '',
        size: Number(x.size) || 0,
        readme: '',
      }));
    repos.sort((a, b) => score(b) - score(a));
    return { user: u, repos };
  }

  /** Seçilen depoların README özetlerini ekler (en fazla 6 istek). */
  async function withReadmes(user, repos, limit) {
    const u = parseUser(user);
    const n = Math.min(limit || 6, repos.length);
    await Promise.all(repos.slice(0, n).map(async (r) => {
      try {
        const md = await getJson(API + '/repos/' + encodeURIComponent(u) + '/' + encodeURIComponent(r.name) + '/readme', 'application/vnd.github.raw+json');
        r.readme = readmeExcerpt(md, 2500);
      } catch (_) { r.readme = ''; }
    }));
    return repos;
  }

  /** Sunucuya gönderilecek sade biçim. */
  function forAI(repos) {
    return repos.slice(0, 12).map((r) => ({
      name: r.name, description: r.description, language: r.language, stars: r.stars, url: r.url,
      homepage: r.homepage, topics: r.topics, updated: r.updated, readme: r.readme,
    }));
  }

  root.CVGitHub = { parseUser, listRepos, withReadmes, forAI, readmeExcerpt };
})(typeof globalThis !== 'undefined' ? globalThis : this);
