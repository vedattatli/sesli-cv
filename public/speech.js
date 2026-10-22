/* Sesli CV — konuşma tanıma (Web Speech API) ve soru okuma (speechSynthesis) */
(function (root) {
  'use strict';

  const SR = root.SpeechRecognition || root.webkitSpeechRecognition || null;
  const NAV = root.navigator || {};
  const UA = NAV.userAgent || '';
  const coarse = () => { try { return !!(root.matchMedia && root.matchMedia('(any-pointer: coarse)').matches); } catch (_) { return false; } };
  // "Masaüstü sitesi" açık Android Chrome ve Android tabletler UA'da Linux gösterir; dokunmatik ekranla ayırırız.
  const IS_ANDROID = /Android/i.test(UA) || (/Linux/.test(UA) && !/CrOS/.test(UA) && (NAV.maxTouchPoints > 0) && coarse());
  const IS_IOS = /iPhone|iPad|iPod/i.test(UA) || (/Macintosh/.test(UA) && NAV.maxTouchPoints > 1);
  // Android Chrome repeats earlier text inside each new result when continuous=true, and iOS Safari
  // ends continuous sessions unpredictably. On phones we listen one utterance at a time and restart.
  const ONE_SHOT = IS_ANDROID || IS_IOS;
  const SILENCE_MS = 25000;      // stop re-opening the mic after this long without hearing anything
  const MIN_GAP_MS = IS_ANDROID ? 400 : 60; // Android reports a busy recognizer as 'not-allowed' if restarted too fast

  function isRecognitionSupported() { return !!SR; }
  function isSynthesisSupported() {
    return typeof root.speechSynthesis !== 'undefined' && typeof root.SpeechSynthesisUtterance === 'function';
  }

  /** Is the microphone allowed for this document by Permissions Policy? null = unknown. */
  function micPolicyAllowed() {
    try {
      const pol = root.document && (root.document.permissionsPolicy || root.document.featurePolicy);
      if (pol && typeof pol.allowsFeature === 'function') return pol.allowsFeature('microphone');
    } catch (_) { /* ignore */ }
    return null;
  }

  /**
   * One recognizer for the whole page.
   * opts: { lang, onInterim(text, tag), onFinal(text, tag), onState(state), onError(code, message) }
   * start(tag): every result is delivered with the tag of the session that heard it, so audio captured
   * for one question can never be attributed to the next one, even if it arrives after stop().
   * states: 'idle' | 'starting' | 'listening'
   * error codes: 'blocked' | 'service' | 'no-mic' | 'network' | 'language' | 'unsupported' | 'unstable' | 'silence'
   */
  function createRecognizer(opts) {
    const o = Object.assign({
      lang: 'tr-TR', onInterim() {}, onFinal() {}, onState() {}, onError() {},
    }, opts || {});
    let rec = null;
    let wanted = false;
    let live = false;          // a session is open (between start() succeeding and onend)
    let state = 'idle';
    let quickEnds = 0;
    let lastStart = 0;
    let lastEnd = 0;
    let lastHeardAt = 0;
    let heard = false;         // did the current session deliver any result?
    let everListened = false;  // has any session in this page reached 'listening'?
    let transientRetries = 0;
    let pendingTag = null;
    let sessionTag = null;
    let lastFinalIdx = -1;
    let lastFinal = '';
    let lastFinalAt = 0;
    let endWaiters = [];
    let restartTimer = 0;

    function setState(s) {
      if (state === s) return;
      state = s;
      try { o.onState(s); } catch (e) { setTimeout(() => { throw e; }); }
    }
    function scheduleStart(delay) {
      clearTimeout(restartTimer);
      setState('starting');
      restartTimer = setTimeout(() => { restartTimer = 0; if (wanted) startInternal(); }, Math.max(0, delay));
    }

    function build() {
      const r = new SR();
      r.lang = o.lang;
      r.continuous = !ONE_SHOT;
      r.interimResults = true;
      r.maxAlternatives = 1;
      const opened = () => { everListened = true; transientRetries = 0; if (wanted) setState('listening'); };
      r.onstart = opened;
      r.onaudiostart = opened;
      r.onresult = (e) => {
        const tag = sessionTag;
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          const t = res && res[0] ? res[0].transcript : '';
          if (res.isFinal) {
            if (i <= lastFinalIdx) continue; // this result slot was already delivered
            let s = t.trim();
            const now = Date.now();
            if (!s || (s === lastFinal && now - lastFinalAt < 800)) { lastFinalIdx = i; continue; }
            // Some engines resend the whole utterance so far; pass on only the new part.
            if (lastFinal && s.length > lastFinal.length && s.indexOf(lastFinal) === 0 && now - lastFinalAt < 4000) {
              s = s.slice(lastFinal.length).trim();
              lastFinal = t.trim();
            } else {
              lastFinal = s;
            }
            lastFinalIdx = i;
            lastFinalAt = now;
            if (s) o.onFinal(s, tag);
          } else {
            interim += t;
          }
        }
        o.onInterim(interim.trim(), tag);
        heard = true;
        lastHeardAt = Date.now();
        quickEnds = 0;
      };
      r.onerror = (e) => {
        const code = e && e.error;
        if (code === 'no-speech' || code === 'aborted') return;
        if (code === 'not-allowed' && everListened && wanted && transientRetries < 2) {
          transientRetries++; // Android: the recognizer was still busy; onend will retry after a pause
          return;
        }
        if (code === 'not-allowed') { wanted = false; o.onError('blocked', e.message || ''); return; }
        if (code === 'service-not-allowed') { wanted = false; o.onError('service', e.message || ''); return; }
        if (code === 'audio-capture') { wanted = false; o.onError('no-mic', e.message || ''); return; }
        if (code === 'network') { wanted = false; o.onError('network', e.message || ''); return; }
        if (code === 'language-not-supported') { wanted = false; o.onError('language', e.message || ''); return; }
        o.onError(code || 'unknown', (e && e.message) || '');
      };
      r.onend = () => {
        live = false;
        lastEnd = Date.now();
        o.onInterim('', sessionTag);
        const waiters = endWaiters; endWaiters = [];
        waiters.forEach((f) => f());
        if (!wanted) { setState('idle'); return; }
        // Chrome closes a session after silence or ~60 s; phones after each utterance. Re-open it,
        // but give up if sessions keep dying immediately (no mic, policy, offline) or nobody speaks.
        if (!heard && Date.now() - lastStart < 900) quickEnds++; else quickEnds = 0;
        if (quickEnds >= 4) { wanted = false; setState('idle'); o.onError('unstable', ''); return; }
        if (!heard && Date.now() - lastHeardAt > SILENCE_MS) { wanted = false; setState('idle'); o.onError('silence', ''); return; }
        const delay = transientRetries ? 600 * transientRetries : (quickEnds ? 250 * quickEnds : 0);
        scheduleStart(Math.max(MIN_GAP_MS, delay));
      };
      return r;
    }

    function startInternal() {
      if (!rec) rec = build();
      const sinceEnd = Date.now() - lastEnd;
      if (!live && sinceEnd < MIN_GAP_MS) { scheduleStart(MIN_GAP_MS - sinceEnd); return; }
      if (live) { setState('starting'); return; } // old session still closing; its onend restarts us
      const prevTag = sessionTag;
      try {
        rec.lang = o.lang;
        sessionTag = pendingTag;
        lastStart = Date.now();
        lastFinal = '';
        lastFinalIdx = -1;
        heard = false;
        setState('starting');
        rec.start();
        live = true;
      } catch (err) {
        if (err && err.name === 'InvalidStateError') { sessionTag = prevTag; live = true; return; } // still running
        wanted = false;
        setState('idle');
        o.onError('unknown', String((err && err.message) || err));
      }
    }

    return {
      /** Start (or keep) listening; results carry `tag`. */
      start(tag) {
        if (!SR) { o.onError('unsupported', ''); return; }
        pendingTag = tag === undefined ? null : tag;
        quickEnds = 0;
        lastHeardAt = Date.now();
        if (wanted && live) { sessionTag = pendingTag; return; }
        wanted = true;
        if (!restartTimer) startInternal();
      },
      /** Point the open session at a new tag (the user moved to another field while talking). */
      retag(tag) { pendingTag = tag; if (live || wanted) sessionTag = tag; },
      /** Stops listening; resolves once the engine has really closed (so TTS is not recorded). */
      stop() {
        wanted = false;
        clearTimeout(restartTimer); restartTimer = 0;
        if (!rec || !live) { setState('idle'); return Promise.resolve(); }
        return new Promise((resolve) => {
          let done = false;
          const finish = () => { if (!done) { done = true; if (!wanted) setState('idle'); resolve(); } };
          endWaiters.push(finish);
          try { rec.stop(); } catch (_) { finish(); }
          setTimeout(finish, 1200);
        });
      },
      abort() {
        wanted = false;
        clearTimeout(restartTimer); restartTimer = 0;
        if (rec && live) { try { rec.abort(); } catch (_) { /* ignore */ } }
        setState('idle');
      },
      setLang(l) { o.lang = l; if (rec) rec.lang = l; },
      get wanted() { return wanted; },
      get state() { return state; },
      get tag() { return sessionTag; },
    };
  }

  // ---------- Text to speech ----------
  let voicesPromise = null;
  function loadVoices() {
    if (!isSynthesisSupported()) return Promise.resolve([]);
    if (voicesPromise) return voicesPromise;
    voicesPromise = new Promise((resolve) => {
      const now = root.speechSynthesis.getVoices();
      if (now && now.length) { resolve(now); return; }
      const t = setTimeout(() => resolve(root.speechSynthesis.getVoices() || []), 1500);
      try {
        root.speechSynthesis.addEventListener('voiceschanged', () => {
          clearTimeout(t);
          resolve(root.speechSynthesis.getVoices() || []);
        }, { once: true });
      } catch (_) { /* old Safari */ }
    }).then((v) => { if (!v.length) voicesPromise = null; return v; });
    return voicesPromise;
  }
  /** Calls cb whenever the browser's voice list changes (Android loads it late). */
  function onVoicesChanged(cb) {
    if (!isSynthesisSupported()) return;
    try { root.speechSynthesis.addEventListener('voiceschanged', () => { voicesPromise = null; cb(); }); } catch (_) { /* ignore */ }
  }

  function voiceScore(v) {
    const n = (v.name || '').toLowerCase();
    let s = 0;
    if (/(enhanced|premium|natural|neural|siri)/.test(n)) s += 4;
    if (n.includes('google')) s += 3;
    if (v.localService) s += 1;
    if (v.default) s += 1;
    return s;
  }

  async function pickVoice(lang) {
    const voices = await loadVoices();
    const want = String(lang || 'tr-TR').toLowerCase().replace('_', '-');
    const base = want.split('-')[0];
    const cands = voices.filter((v) => String(v.lang || '').toLowerCase().replace('_', '-').split('-')[0] === base);
    cands.sort((a, b) => voiceScore(b) - voiceScore(a));
    return cands[0] || null;
  }

  async function hasVoice(lang) { return !!(await pickVoice(lang)); }
  /** true = a voice for lang exists, false = voices loaded but none for lang, null = list not loaded yet. */
  async function voiceStatus(lang) {
    if (!isSynthesisSupported()) return false;
    const v = await loadVoices();
    if (!v.length) return null;
    return !!(await pickVoice(lang));
  }

  /** Speak text. Resolves true when finished, false when interrupted/unavailable. */
  async function speak(text, opts) {
    const o = opts || {};
    if (!isSynthesisSupported() || !text) return false;
    const lang = o.lang || 'tr-TR';
    const voice = await pickVoice(lang);
    if (!voice && o.requireVoice !== false) return false;
    try { root.speechSynthesis.cancel(); } catch (_) { /* ignore */ }
    return new Promise((resolve) => {
      const u = new root.SpeechSynthesisUtterance(text);
      u.lang = voice ? voice.lang : lang;
      if (voice) u.voice = voice;
      u.rate = o.rate || 1;
      u.pitch = 1;
      let done = false;
      const finish = (ok) => { if (!done) { done = true; clearTimeout(guard); resolve(ok); } };
      u.onend = () => finish(true);
      u.onerror = () => finish(false);
      // Chrome occasionally never fires onend; never let the interview hang on it.
      const guard = setTimeout(() => finish(true), Math.min(25000, 2000 + text.length * 85));
      root.speechSynthesis.speak(u);
    });
  }

  function cancelSpeech() {
    if (!isSynthesisSupported()) return;
    try { root.speechSynthesis.cancel(); } catch (_) { /* ignore */ }
  }

  root.CVSpeech = {
    isRecognitionSupported, isSynthesisSupported, micPolicyAllowed,
    createRecognizer, speak, cancelSpeech, pickVoice, hasVoice, voiceStatus, onVoicesChanged,
    IS_ANDROID, IS_IOS, ONE_SHOT,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
