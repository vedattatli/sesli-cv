/*
 * tests/app-env.js — a small browser for loading public/app.js in Apple's JavaScriptCore shell (test only).
 * A mini DOM with a CSS selector engine, a fake clock (setTimeout runs only when the test advances time),
 * localStorage, history, a fake speech recognizer (continuous, or one-shot like Android Chrome) and a fake
 * speech synthesizer with one Turkish voice. Used by tests/app.test.js; see that file for the scenarios.
 *
 * Globals for tests: advance(ms), settle(), say(text), lateFinal(rec, text), liveCount(), liveRecs(),
 * ttsSpeaking(), ttsLog, srLog, __store().
 */
/* global print */
var G = globalThis;
G.window = G;
G.console = { log: print, warn: print, error: function () { G.__errors = (G.__errors || []).concat([Array.prototype.join.call(arguments, ' ')]); } };
G.SCENARIO = (typeof arguments !== 'undefined' && arguments[0]) || 'desktop';

// ---------------------------------------------------------------- fake clock and timers
var clock = 1760000000000;
Date.now = function () { return clock; };
var timers = [];
var timerSeq = 0;
G.setTimeout = function (fn, ms) { var id = ++timerSeq; timers.push({ id: id, t: clock + Math.max(0, ms || 0), fn: fn }); return id; };
G.clearTimeout = function (id) { timers = timers.filter(function (x) { return x.id !== id; }); };
G.setInterval = function () { return 0; };
G.clearInterval = function () {};
G.drain = function () { if (typeof drainMicrotasks === 'function') drainMicrotasks(); };
/** Moves the clock on by ms, running due timers (and the promise jobs they start) in order. */
G.advance = function (ms) {
  var end = clock + (ms || 0);
  drain();
  for (;;) {
    timers.sort(function (a, b) { return a.t - b.t || a.id - b.id; });
    var next = timers[0];
    if (!next || next.t > end) break;
    timers.shift();
    clock = Math.max(clock, next.t);
    try { next.fn(); } catch (e) { print('TIMER ERROR: ' + e + '\n' + (e && e.stack)); G.__timerErrors = (G.__timerErrors || 0) + 1; }
    drain();
  }
  clock = end;
  drain();
};
G.settle = function () { for (var i = 0; i < 40; i++) advance(250); };

// ---------------------------------------------------------------- mini DOM
function camel(s) { return s.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }); }
function Node0() { this.childNodes = []; this.parentNode = null; }
function TextNode(t) { Node0.call(this); this.nodeType = 3; this.data = String(t); }
Object.defineProperty(TextNode.prototype, 'textContent', { get: function () { return this.data; }, set: function (v) { this.data = String(v); } });
function El(tag) {
  Node0.call(this);
  this.nodeType = 1;
  this.localName = String(tag).toLowerCase();
  this.tagName = this.localName.toUpperCase();
  this.attrs = {};
  this.dataset = {};
  this.listeners = {};
  var self = this;
  this.style = { setProperty: function (k, v) { this[k] = v; } };
  this.classList = {
    add: function () { for (var i = 0; i < arguments.length; i++) if (!this.contains(arguments[i])) self.className = (self.className + ' ' + arguments[i]).trim(); },
    remove: function () { for (var i = 0; i < arguments.length; i++) { var c = arguments[i]; self.className = self.className.split(/\s+/).filter(function (x) { return x && x !== c; }).join(' '); } },
    contains: function (c) { return self.className.split(/\s+/).indexOf(c) >= 0; },
    toggle: function (c, on) { var want = on === undefined ? !this.contains(c) : !!on; if (want) this.add(c); else this.remove(c); return want; },
  };
  this.value = '';
  this.hidden = false;
  this.checked = false;
  this.disabled = false;
  this.inert = false;
}
El.prototype = Object.create(Node0.prototype);
Object.defineProperty(El.prototype, 'className', { get: function () { return this.attrs['class'] || ''; }, set: function (v) { this.attrs['class'] = String(v); } });
Object.defineProperty(El.prototype, 'id', { get: function () { return this.attrs.id || ''; }, set: function (v) { this.attrs.id = String(v); } });
El.prototype.setAttribute = function (k, v) {
  if (k.slice(0, 5) === 'data-') { this.dataset[camel(k.slice(5))] = String(v); return; }
  this.attrs[k] = String(v);
};
El.prototype.getAttribute = function (k) {
  if (k.slice(0, 5) === 'data-') { var d = this.dataset[camel(k.slice(5))]; return d === undefined ? null : d; }
  return this.attrs[k] === undefined ? null : this.attrs[k];
};
El.prototype.hasAttribute = function (k) { return this.getAttribute(k) !== null; };
El.prototype.removeAttribute = function (k) { if (k.slice(0, 5) === 'data-') delete this.dataset[camel(k.slice(5))]; else delete this.attrs[k]; };
function toNode(k) { return k && k.nodeType ? k : new TextNode(k); }
El.prototype.append = function () {
  for (var i = 0; i < arguments.length; i++) {
    var n = toNode(arguments[i]);
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
  }
};
El.prototype.appendChild = function (n) { this.append(n); return n; };
El.prototype.removeChild = function (n) {
  var i = this.childNodes.indexOf(n);
  if (i >= 0) this.childNodes.splice(i, 1);
  n.parentNode = null;
  if (D.activeElement && (D.activeElement === n || (n.contains && n.contains(D.activeElement)))) D.activeElement = D.body;
  return n;
};
El.prototype.replaceChildren = function () {
  var self = this;
  this.childNodes.slice().forEach(function (c) { self.removeChild(c); });
  this.append.apply(this, arguments);
};
El.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
Object.defineProperty(El.prototype, 'children', { get: function () { return this.childNodes.filter(function (n) { return n.nodeType === 1; }); } });
Object.defineProperty(El.prototype, 'firstChild', { get: function () { return this.childNodes[0] || null; } });
Object.defineProperty(El.prototype, 'textContent', {
  get: function () { return this.childNodes.map(function (n) { return n.textContent; }).join(''); },
  set: function (v) { this.replaceChildren(); if (v !== '' && v != null) this.append(String(v)); },
});
Object.defineProperty(El.prototype, 'isConnected', { get: function () { var n = this; while (n) { if (n === D) return true; n = n.parentNode; } return false; } });
Object.defineProperty(El.prototype, 'offsetHeight', { get: function () { return 100; } });
Object.defineProperty(El.prototype, 'clientWidth', { get: function () { return 320; } });
El.prototype.contains = function (n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; };
El.prototype.addEventListener = function (t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); };
El.prototype.removeEventListener = function (t, fn) { this.listeners[t] = (this.listeners[t] || []).filter(function (f) { return f !== fn; }); };
El.prototype.dispatchEvent = function (ev) {
  ev.target = ev.target || this;
  var n = this;
  while (n) {
    ev.currentTarget = n;
    (n.listeners && n.listeners[ev.type] || []).slice().forEach(function (fn) { fn.call(n, ev); });
    if (ev._stop || !ev.bubbles) break;
    n = n.parentNode;
  }
  return !ev.defaultPrevented;
};
function Ev(type, init) {
  this.type = type; this.bubbles = true; this.defaultPrevented = false;
  for (var k in (init || {})) this[k] = init[k];
}
Ev.prototype.preventDefault = function () { this.defaultPrevented = true; };
Ev.prototype.stopPropagation = function () { this._stop = true; };
El.prototype.click = function () { if (this.disabled) return; this.dispatchEvent(new Ev('click')); };
El.prototype.focus = function () { D.activeElement = this; };
El.prototype.blur = function () { if (D.activeElement === this) D.activeElement = D.body; };
El.prototype.select = function () {};
El.prototype.scrollIntoView = function () {};
El.prototype.animate = function () {};
El.prototype.setPointerCapture = function () {};
El.prototype.getBoundingClientRect = function () { return { width: 300, height: 400, top: 0, left: 0 }; };
El.prototype.getContext = function () {
  return new Proxy({}, { get: function (t, k) { if (k in t) return t[k]; return function () {}; }, set: function (t, k, v) { t[k] = v; return true; } });
};
El.prototype.toDataURL = function (type) { return 'data:' + (type || 'image/png') + ';base64,QUJD'; };

// selector engine: alternatives (,) of descendant chains of compounds tag#id.class[attr="v"]
function splitTop(sel, ch) {
  var out = [], cur = '', depth = 0, q = null;
  for (var i = 0; i < sel.length; i++) {
    var c = sel[i];
    if (q) { cur += c; if (c === q && sel[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[') depth++;
    if (c === ']') depth--;
    if (depth === 0 && (ch === ' ' ? /\s/.test(c) : c === ch)) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function parseCompound(s) {
  var c = { tag: null, id: null, classes: [], attrs: [] };
  var re = /^([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="((?:[^"\\]|\\.)*)")?\]/g;
  var m;
  while ((m = re.exec(s)) !== null) {
    if (m[0] === '') { re.lastIndex++; continue; }
    if (m[1]) c.tag = m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push([m[4], m[5] === undefined ? null : m[5].replace(/\\(.)/g, '$1')]);
  }
  return c;
}
function matchCompound(el, c) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && c.tag !== '*' && el.localName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (var i = 0; i < c.classes.length; i++) if (!el.classList.contains(c.classes[i])) return false;
  for (var j = 0; j < c.attrs.length; j++) {
    var v = el.getAttribute(c.attrs[j][0]);
    if (v === null) return false;
    if (c.attrs[j][1] !== null && v !== c.attrs[j][1]) return false;
  }
  return true;
}
function matches(el, sel) {
  return splitTop(sel, ',').some(function (alt) {
    var parts = splitTop(alt, ' ').map(parseCompound);
    if (!matchCompound(el, parts[parts.length - 1])) return false;
    var n = el.parentNode;
    for (var i = parts.length - 2; i >= 0; i--) {
      while (n && !matchCompound(n, parts[i])) n = n.parentNode;
      if (!n) return false;
      n = n.parentNode;
    }
    return true;
  });
}
function walk(root, fn) { root.childNodes.forEach(function (n) { if (n.nodeType === 1) { fn(n); walk(n, fn); } }); }
El.prototype.querySelectorAll = function (sel) { var out = []; walk(this, function (n) { if (matches(n, sel)) out.push(n); }); return out; };
El.prototype.querySelector = function (sel) { return this.querySelectorAll(sel)[0] || null; };
El.prototype.matches = function (sel) { return matches(this, sel); };
El.prototype.closest = function (sel) { var n = this; while (n && n.nodeType === 1) { if (matches(n, sel)) return n; n = n.parentNode; } return null; };

var D = new El('#document');
D.nodeType = 9;
D.documentElement = new El('html');
D.head = new El('head');
D.body = new El('body');
D.documentElement.append(D.head, D.body);
D.append(D.documentElement);
D.activeElement = D.body;
D.hidden = false;
D.createElement = function (t) { return new El(t); };
D.createElementNS = function (ns, t) { return new El(t); };
D.createTextNode = function (t) { return new TextNode(t); };
D.getElementById = function (id) { return D.querySelector('#' + id); };
D.createRange = function () { return { selectNodeContents: function () {} }; };
G.document = D;
G.getSelection = function () { return { removeAllRanges: function () {}, addRange: function () {} }; };
G.CSS = { escape: function (s) { return String(s).replace(/["\\]/g, '\\$&'); } };
G.Event = Ev;

// the page skeleton: the ids app.js expects from index.html
function mk(tag, attrs, kids) {
  var e = new El(tag);
  Object.keys(attrs || {}).forEach(function (k) { if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); });
  (kids || []).forEach(function (k) { e.append(k); });
  return e;
}
function sheet(id, inner) {
  var s = mk('div', { id: id, class: 'sheet' }, [mk('div', { class: 'sheet-scrim', 'data-close': '' }),
    mk('div', { class: 'sheet-panel' }, [mk('button', { class: 'icon-btn', 'data-close': '' })].concat(inner))]);
  s.hidden = true;
  return s;
}
D.body.append(
  mk('header', { class: 'topbar' }, [
    mk('a', { id: 'brand' }), mk('span', { id: 'progress-text' }), mk('i', { id: 'progress-bar' }),
    mk('button', { id: 'btn-tts' }, [mk('use', { id: 'tts-use' })]), mk('button', { id: 'btn-settings' }), mk('button', { id: 'btn-preview' }),
  ]),
  mk('div', { id: 'shell', class: 'shell' }, [
    mk('nav', { class: 'rail' }, [mk('ol', { id: 'rail-list' }), mk('p', { id: 'saved' })]),
    mk('main', { id: 'stage' }, [
      mk('div', { id: 'step' }),
      mk('div', { id: 'dock', class: 'dock' }, [
        mk('div', { id: 'caption' }), mk('div', { id: 'dock-adv' }),
        mk('button', { id: 'btn-back' }), mk('button', { id: 'btn-mic' }, [mk('use', { id: 'mic-use' })]), mk('button', { id: 'btn-next' }),
        mk('div', { id: 'dock-status' }),
      ]),
    ]),
    mk('aside', { class: 'side-preview' }, [mk('span', { id: 'pv-badge' }), mk('div', { id: 'pv-side' })]),
  ]),
  sheet('sheet-preview', [mk('p', { id: 'sheet-preview-note' }), mk('div', { id: 'pv-sheet' })]),
  sheet('sheet-settings', [mk('div', { id: 'settings-body' })]),
  sheet('sheet-edit', [mk('h2', { id: 'sheet-edit-title' }), mk('div', { id: 'edit-body' })]),
  sheet('sheet-copy', [mk('div', { id: 'copy-body' })]),
  sheet('sheet-consent', [mk('div', { id: 'consent-body' })]),
  mk('div', { id: 'toast' }));

// ---------------------------------------------------------------- browser APIs
var store = {};
G.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; },
  key: function (i) { return Object.keys(store)[i] || null; },
  get length() { return Object.keys(store).length; },
  clear: function () { store = {}; },
};
G.__store = function () { return store; };
G.location = { href: 'https://sesli-cv.example/app/', hash: '', search: '', pathname: '/app/' };
G.history = { state: null, pushState: function (s) { this.state = s; }, replaceState: function (s) { this.state = s; }, back: function () {} };
G.navigator = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', maxTouchPoints: 0 };
G.matchMedia = function () { return { matches: false, addEventListener: function () {} }; };
G.innerWidth = 1024;
G.devicePixelRatio = 1;
G.scrollTo = function () {};
G.addEventListener = function () {};
G.top = G;
G.URL = { createObjectURL: function () { return 'blob:x'; }, revokeObjectURL: function () {} };
G.Blob = function (parts) { this.parts = parts; };
G.File = function (parts, name) { this.parts = parts; this.name = name; };
G.Image = function () { var self = this; setTimeout(function () { self.naturalWidth = 900; self.naturalHeight = 1200; if (self.onload) self.onload(); }, 5); };
G.FileReader = function () { this.readAsText = function (f) { var self = this; self.result = f._text; setTimeout(function () { if (self.onload) self.onload(); }, 1); }; };
G.fetch = function () { return Promise.reject(new TypeError('no network in tests')); };
// AbortController: enough for app.js to abort the calls of a wiped CV
G.AbortController = function () {
  var sig = { aborted: false, _on: [], addEventListener: function (t, f) { if (t === 'abort') this._on.push(f); } };
  this.signal = sig;
  this.abort = function () { if (sig.aborted) return; sig.aborted = true; sig._on.forEach(function (f) { f(); }); };
};

// ---------------------------------------------------------------- fake speech recognition
// Desktop Chrome keeps one continuous session; Android Chrome (G.ONE_SHOT) ends it after each final.
G.evSeq = 0;
G.srLog = [];
var live = [];
function FakeSR() { this.lang = 'tr-TR'; this.continuous = true; this.interimResults = true; this._on = false; this._n = 0; }
FakeSR.prototype.start = function () {
  if (this._on) { var e = new Error('already'); e.name = 'InvalidStateError'; throw e; }
  var self = this;
  this._on = true; this._n = 0;
  live.push(this);
  srLog.push({ t: clock, s: ++G.evSeq, ev: 'sr-start' });
  setTimeout(function () { if (self.onstart) self.onstart(); if (self.onaudiostart) self.onaudiostart(); }, 20);
};
FakeSR.prototype.stop = function () {
  if (!this._on) return;
  var self = this;
  live = live.filter(function (r) { return r !== self; });
  setTimeout(function () { self._on = false; srLog.push({ t: clock, s: ++G.evSeq, ev: 'sr-end' }); if (self.onend) self.onend(); }, 120);
};
FakeSR.prototype.abort = function () { this.stop(); };
G.SpeechRecognition = FakeSR;
G.webkitSpeechRecognition = FakeSR;
/** Delivers one final result to a recognizer session, as Chrome does. */
G.lateFinal = function (r, text) {
  var res = [{ transcript: text }]; res.isFinal = true;
  var pad = [];
  for (var i = 0; i < r._n; i++) { var x = [{ transcript: '' }]; x.isFinal = true; pad.push(x); }
  if (r.onresult) r.onresult({ resultIndex: r._n, results: pad.concat([res]) });
  r._n++;
};
/** The person says `text`: every open session gets it as a final, then the app reacts. */
G.say = function (text) {
  var recs = live.slice();
  recs.forEach(function (r) { lateFinal(r, text); });
  advance(50);
  if (G.ONE_SHOT) { recs.forEach(function (r) { if (!r.continuous && r._on) r.stop(); }); advance(900); }
  return recs.length;
};
G.liveCount = function () { return live.length; };
G.liveRecs = function () { return live.slice(); };

// ---------------------------------------------------------------- fake speech synthesis (one Turkish voice)
G.ttsLog = [];
G.SpeechSynthesisUtterance = function (text) { this.text = text; };
var speakingU = null;
G.speechSynthesis = {
  getVoices: function () { return [{ lang: 'tr-TR', name: 'Google Türkçe', localService: true }]; },
  addEventListener: function () {},
  speak: function (u) {
    speakingU = u;
    ttsLog.push({ t: clock, s: ++G.evSeq, ev: 'tts-start', text: u.text });
    setTimeout(function () { if (speakingU === u) { speakingU = null; ttsLog.push({ t: clock, s: ++G.evSeq, ev: 'tts-end' }); if (u.onend) u.onend(); } }, 600);
  },
  cancel: function () { if (speakingU) { var u = speakingU; speakingU = null; ttsLog.push({ t: clock, s: ++G.evSeq, ev: 'tts-cancel' }); if (u.onerror) u.onerror({}); } },
};
G.ttsSpeaking = function () { return !!speakingU; };
