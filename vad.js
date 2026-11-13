/* Повторялка — детектор речи по громкости (RMS).
   Работает в браузере (window.PovtVAD) и в Node (module.exports) для тестов. */
(function (root) {
  'use strict';

  class PovtVAD {
    constructor(sampleRate, o = {}) {
      this.sr = sampleRate;
      this.minThr = o.minThr != null ? o.minThr : 0.025; // минимальный порог (ползунок)
      this.ratio = o.ratio || 2.8;          // порог = шум × ratio
      this.preroll = o.preroll || 0.35;     // предзапись, с
      this.endSilence = o.endSilence || 0.9;// тишина для конца фразы, с
      this.maxLen = o.maxLen || 10;         // максимум фразы, с
      this.minLen = o.minLen || 0.35;       // короче — игнор
      this.maxGain = o.maxGain || 6;        // нормализация не больше ×6
      this.fade = o.fade || 0.02;           // сглаживание краёв, с
      this.tailKeep = o.tailKeep || 0.12;   // сколько тишины оставить после голоса, с
      this.noise = o.initialNoise || 0.004;
      this.onStart = null;   // () => void
      this.onPhrase = null;  // (Float32Array, info) => void
      this.onDiscard = null; // (voicedSec) => void
      this.muted = false;
      this.unmuteIn = 0;
      this.lastRms = 0;
      this.reset();
    }

    threshold() { return Math.max(this.minThr, this.noise * this.ratio); }

    reset() {
      this.speaking = false;
      this.above = 0;
      this.pre = [];
      this.chunks = null;
      this.silent = 0;
    }

    /** Глушим вход (на время воспроизведения). Текущая фраза выбрасывается. */
    mute() { this.muted = true; this.unmuteIn = Infinity; this.reset(); }
    /** Снять глушение через sec секунд аудио-времени микрофона. */
    unmuteAfter(sec) { if (this.muted) this.unmuteIn = sec; }

    process(frame) {
      const n = frame.length, fd = n / this.sr;
      let s = 0;
      for (let i = 0; i < n; i++) s += frame[i] * frame[i];
      const rms = Math.sqrt(s / n);
      this.lastRms = rms;

      if (this.muted) {
        this.unmuteIn -= fd;
        if (this.unmuteIn <= 0) { this.muted = false; this.reset(); }
        return;
      }

      const thr = this.threshold();
      if (!this.speaking) {
        // адаптивный шум: вниз быстро, вверх медленно (~4 с)
        const a = rms < this.noise ? 0.15 : 0.01;
        this.noise += (rms - this.noise) * a;
        if (this.noise < 0.0005) this.noise = 0.0005;

        this.pre.push(frame);
        const maxPre = Math.ceil(this.preroll / fd) + 2;
        while (this.pre.length > maxPre) this.pre.shift();

        this.above = rms > thr ? this.above + 1 : 0;
        if (this.above >= 2) {
          this.speaking = true;
          this.chunks = this.pre;
          this.pre = [];
          this.startIdx = this.chunks.length - 2;
          this.lastVoice = this.chunks.length;
          this.silent = 0;
          if (this.onStart) this.onStart();
        }
      } else {
        this.chunks.push(frame);
        if (rms < thr * 0.75) this.silent++;
        else { this.silent = 0; this.lastVoice = this.chunks.length; }
        const len = (this.chunks.length - this.startIdx) * fd;
        if (this.silent * fd >= this.endSilence || len >= this.maxLen) this._finish(fd);
      }
    }

    _finish(fd) {
      const chunks = this.chunks, lastVoice = this.lastVoice;
      const voiced = (lastVoice - this.startIdx) * fd;
      this.reset();
      if (voiced < this.minLen) { if (this.onDiscard) this.onDiscard(voiced); return; }
      const keep = Math.min(chunks.length, lastVoice + Math.round(this.tailKeep / fd));
      let len = 0;
      for (let i = 0; i < keep; i++) len += chunks[i].length;
      const out = new Float32Array(len);
      let o = 0;
      for (let i = 0; i < keep; i++) { out.set(chunks[i], o); o += chunks[i].length; }
      PovtVAD.polish(out, this.sr, this.maxGain, this.fade);
      if (this.onPhrase) this.onPhrase(out, { voiced, seconds: len / this.sr });
    }

    /** Нормализация (≤ maxGain) и fade-in/out. */
    static polish(buf, sr, maxGain, fade) {
      let peak = 0;
      for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
      const gain = peak > 0 ? Math.min(maxGain, 0.95 / peak) : 1;
      const f = Math.min(Math.floor(fade * sr), buf.length >> 1);
      for (let i = 0; i < buf.length; i++) {
        let g = gain;
        if (i < f) g *= i / f;
        else if (i >= buf.length - f) g *= (buf.length - 1 - i) / f;
        buf[i] *= g;
      }
      return gain;
    }
  }

  root.PovtVAD = PovtVAD;
  if (typeof module !== 'undefined' && module.exports) module.exports = PovtVAD;
})(typeof window !== 'undefined' ? window : globalThis);
