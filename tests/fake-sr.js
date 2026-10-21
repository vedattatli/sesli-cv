/* Test-only fake SpeechRecognition.
   fakeSay("metin")      → delivers interim + final to every open recognizer.
   fakePending("metin")  → the recognizer has heard words but not finalised them yet; they are delivered
                           as a final when stop() is called (what Chrome does), i.e. a "late final". */
(function () {
  const live = new Set();
  class FakeSR {
    constructor() { this.lang = 'tr-TR'; this.continuous = false; this.interimResults = false; this._on = false; this._pending = ''; }
    start() {
      if (this._on) { const e = new Error('already started'); e.name = 'InvalidStateError'; throw e; }
      this._on = true; this._pending = ''; live.add(this);
      setTimeout(() => { this.onstart && this.onstart(); this.onaudiostart && this.onaudiostart(); }, 20);
    }
    stop() {
      if (!this._on) return;
      live.delete(this);
      const pending = this._pending; this._pending = '';
      setTimeout(() => {
        if (pending) this._emit(pending, true, true);
        this._on = false;
        this.onend && this.onend();
      }, 120);
    }
    abort() { this._pending = ''; this.stop(); }
    _emit(text, isFinal, fromStop) {
      const res = [{ transcript: text }]; res.isFinal = isFinal;
      this.onresult && this.onresult({ resultIndex: 0, results: [res] });
      if (isFinal && !this.continuous && !fromStop) this.stop();
    }
  }
  window.SpeechRecognition = FakeSR;
  window.webkitSpeechRecognition = FakeSR;
  window.fakeSay = (text) => { live.forEach((r) => { r._emit(text.slice(0, Math.ceil(text.length / 2)), false); r._emit(text, true); }); return live.size; };
  window.fakePending = (text) => { live.forEach((r) => { r._pending = text; r._emit(text, false); }); return live.size; };
  window.fakeLive = () => live.size;
})();
