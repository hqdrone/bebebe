/* Повторялка — голоса персонажей и короткие звуки-«добавки» (всё синтезируется Web Audio). */
(function (root) {
  'use strict';

  const VOICES = {
    squirrel: { rate: 1.65 },
    mouse:    { rate: 2.05 },
    bear:     { rate: 0.68 },
    raccoon:  { rate: 1.12, reverse: true },
    chicks:   { chorus: [
      { rate: 1.35, at: 0,    pan: -0.7, gain: 0.65 },
      { rate: 1.62, at: 0.07, pan: 0,    gain: 0.65 },
      { rate: 1.95, at: 0.14, pan: 0.7,  gain: 0.65 },
    ], sfxPitch: 1.6 },
    robot:    { rate: 1.0, ring: 55, ringMix: 0.8 },
    alien:    { rate: 1.3, ring: 380, ringMix: 0.6 },
    monster:  { rate: 0.55, ring: 28, ringMix: 0.7 },
    parrot:   { rate: 1.0, delay: 0.28, feedback: 0.45 },
    ghost:    { rate: 0.85, vibrato: [5, 35], highpass: 250, whisper: 0.9, delay: 0.19, feedback: 0.5, echoGain: 0.6, gain: 0.85 },
    snail:    { rate: 0.92, stretch: 2.0 },
    fish:     { rate: 1.12, lowpass: [650, 6], vibrato: [7, 70], bubbles: true, gain: 1.3 },
    penguin:  { rate: 1.15, bandpass: [1600, 1.1], drive: 14, radio: true, gain: 1.2 },
    cube:     { random: true },
  };

  const pitchOf = (id) => {
    const v = VOICES[id] || {};
    const r = v.sfxPitch || v.rate || 1;
    return Math.max(0.6, Math.min(2, r));
  };

  // ---------- офлайн-обработка буфера ----------
  function reverseBuf(ctx, b) {
    const o = ctx.createBuffer(1, b.length, b.sampleRate);
    const s = b.getChannelData(0), d = o.getChannelData(0);
    for (let i = 0; i < s.length; i++) d[i] = s[s.length - 1 - i];
    return o;
  }

  // растяжение во времени без изменения высоты (упрощённый WSOLA)
  function stretchBuf(ctx, b, k) {
    const s = b.getChannelData(0), sr = b.sampleRate;
    const G = Math.round(0.06 * sr), Ho = G >> 2, Hi = Math.max(1, Math.round(Ho / k));
    const tol = Math.round(0.008 * sr), L = Math.round(0.025 * sr);
    const frames = Math.max(1, Math.floor((s.length - G - tol) / Hi));
    const len = (frames - 1) * Ho + G;
    const out = new Float32Array(len), ws = new Float32Array(len);
    const w = new Float32Array(G);
    for (let i = 0; i < G; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (G - 1));
    let prev = 0;
    for (let f = 0; f < frames; f++) {
      let start = f * Hi;
      if (f > 0) {
        const nat = prev + Ho; // естественное продолжение прошлого куска
        let best = -Infinity, bestD = 0;
        for (let d = -tol; d <= tol; d += 3) {
          const c = start + d;
          if (c < 0 || c + G >= s.length || nat + L >= s.length) continue;
          let acc = 0;
          for (let i = 0; i < L; i += 3) acc += s[c + i] * s[nat + i];
          if (acc > best) { best = acc; bestD = d; }
        }
        start = Math.max(0, Math.min(s.length - G - 1, start + bestD));
      }
      const o = f * Ho;
      for (let i = 0; i < G; i++) { out[o + i] += s[start + i] * w[i]; ws[o + i] += w[i]; }
      prev = start;
    }
    for (let i = 0; i < len; i++) out[i] = ws[i] > 0.05 ? out[i] / ws[i] : out[i];
    const ob = ctx.createBuffer(1, len, sr);
    ob.copyToChannel(out, 0);
    return ob;
  }

  // шум, повторяющий огибающую голоса (шёпот)
  function whisperBuf(ctx, b) {
    const s = b.getChannelData(0), o = ctx.createBuffer(1, b.length, b.sampleRate), d = o.getChannelData(0);
    const a = 1 / (0.012 * b.sampleRate);
    let env = 0;
    for (let i = 0; i < s.length; i++) {
      env += (Math.abs(s[i]) - env) * a;
      d[i] = (Math.random() * 2 - 1) * env * 2.5;
    }
    return o;
  }

  let noiseCache = null;
  function noise(ctx) {
    if (noiseCache && noiseCache.sampleRate === ctx.sampleRate) return noiseCache;
    const n = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return (noiseCache = n);
  }
  function driveCurve(k) {
    const c = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; c[i] = (1 + k) * x / (1 + k * Math.abs(x)); }
    return c;
  }

  // ---------- голос ----------
  /** Собирает и запускает голос персонажа. Возвращает {nodes, dur, tail}. */
  function speak(ctx, buf, id, out) {
    const v = VOICES[id];
    const nodes = [];
    const N = (n) => { nodes.push(n); return n; };
    const t0 = ctx.currentTime + 0.03;
    const lead = v.radio ? 0.18 : 0;

    let b = buf;
    if (v.reverse) b = reverseBuf(ctx, b);
    if (v.stretch) b = stretchBuf(ctx, b, v.stretch);

    const voice = N(ctx.createGain());
    let dur = 0;
    const parts = v.chorus || [{ rate: v.rate, at: 0, pan: 0, gain: 1 }];
    for (const s of parts) {
      const src = N(ctx.createBufferSource());
      src.buffer = b;
      src.playbackRate.value = s.rate;
      if (v.vibrato) {
        const l = N(ctx.createOscillator()); l.frequency.value = v.vibrato[0];
        const lg = N(ctx.createGain()); lg.gain.value = v.vibrato[1];
        l.connect(lg); lg.connect(src.detune); l.start(t0);
      }
      let node = src;
      if (s.pan && ctx.createStereoPanner) { const pn = N(ctx.createStereoPanner()); pn.pan.value = s.pan; node.connect(pn); node = pn; }
      const g = N(ctx.createGain()); g.gain.value = s.gain;
      node.connect(g); g.connect(voice);
      src.start(t0 + lead + s.at);
      dur = Math.max(dur, lead + s.at + b.duration / s.rate);
    }
    if (v.whisper) {
      const ws = N(ctx.createBufferSource()); ws.buffer = whisperBuf(ctx, b); ws.playbackRate.value = v.rate;
      const bp = N(ctx.createBiquadFilter()); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.7;
      const wg = N(ctx.createGain()); wg.gain.value = v.whisper;
      ws.connect(bp); bp.connect(wg); wg.connect(voice);
      ws.start(t0);
    }

    let head = voice;
    const chain = (n) => { head.connect(n); head = n; return n; };
    if (v.ring) {
      // ring modulation: сигнал × синус (gain=0 + осциллятор на gain)
      const ring = N(ctx.createGain()); ring.gain.value = 0;
      const osc = N(ctx.createOscillator()); osc.frequency.value = v.ring;
      osc.connect(ring.gain); osc.start(t0);
      const wet = N(ctx.createGain()); wet.gain.value = v.ringMix * 1.6;
      const dry = N(ctx.createGain()); dry.gain.value = 1 - v.ringMix;
      const mix = N(ctx.createGain());
      head.connect(ring); ring.connect(wet); wet.connect(mix);
      head.connect(dry); dry.connect(mix);
      head = mix;
    }
    if (v.highpass) { const f = chain(N(ctx.createBiquadFilter())); f.type = 'highpass'; f.frequency.value = v.highpass; }
    if (v.lowpass) { const f = chain(N(ctx.createBiquadFilter())); f.type = 'lowpass'; f.frequency.value = v.lowpass[0]; f.Q.value = v.lowpass[1]; }
    if (v.bandpass) { const f = chain(N(ctx.createBiquadFilter())); f.type = 'bandpass'; f.frequency.value = v.bandpass[0]; f.Q.value = v.bandpass[1]; }
    if (v.drive) { const ws = chain(N(ctx.createWaveShaper())); ws.curve = driveCurve(v.drive); ws.oversample = '2x'; }
    const fin = chain(N(ctx.createGain()));
    fin.gain.value = v.gain || 1;
    fin.connect(out);

    let tail = 0.05;
    if (v.delay) {
      const d = N(ctx.createDelay(2)); d.delayTime.value = v.delay;
      const fb = N(ctx.createGain()); fb.gain.value = v.feedback;
      const ew = N(ctx.createGain()); ew.gain.value = v.echoGain || 0.8;
      fin.connect(d); d.connect(fb); fb.connect(d); d.connect(ew); ew.connect(out);
      tail = v.delay * Math.ceil(Math.log(0.02) / Math.log(v.feedback));
    }

    if (v.radio) {
      // «пшш» в начале и конце, треск, «пик»
      const nz = noise(ctx);
      const burst = (at, len, gain) => {
        const s = N(ctx.createBufferSource()); s.buffer = nz; s.loop = true;
        const g = N(ctx.createGain());
        g.gain.setValueAtTime(gain, at); g.gain.exponentialRampToValueAtTime(0.001, at + len);
        s.connect(g); g.connect(voice); s.start(at, Math.random()); s.stop(at + len + 0.02);
      };
      burst(t0, 0.16, 0.5);
      burst(t0 + dur, 0.2, 0.5);
      const cr = N(ctx.createBufferSource()); cr.buffer = nz; cr.loop = true;
      const cg = N(ctx.createGain()); cg.gain.value = 0.035;
      cr.connect(cg); cg.connect(voice); cr.start(t0); cr.stop(t0 + dur + 0.2);
      const bp = N(ctx.createOscillator()); bp.frequency.value = 1250;
      const bg = N(ctx.createGain()); bg.gain.setValueAtTime(0, t0); bg.gain.setValueAtTime(0.18, t0 + dur + 0.21); bg.gain.setValueAtTime(0, t0 + dur + 0.3);
      bp.connect(bg); bg.connect(out); bp.start(t0); bp.stop(t0 + dur + 0.35);
      dur += 0.35;
    }
    if (v.bubbles) {
      const n = Math.max(2, Math.round(dur * 3));
      for (let i = 0; i < n; i++) {
        const at = t0 + Math.random() * dur;
        const o = N(ctx.createOscillator()); o.type = 'sine';
        const f = 250 + Math.random() * 250;
        o.frequency.setValueAtTime(f, at); o.frequency.exponentialRampToValueAtTime(f * 3, at + 0.06);
        const g = N(ctx.createGain());
        g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.22, at + 0.01); g.gain.exponentialRampToValueAtTime(0.001, at + 0.07);
        o.connect(g); g.connect(out); o.start(at); o.stop(at + 0.08);
      }
    }
    return { nodes, dur, tail, t0 };
  }

  // ---------- звуки-добавки ----------
  const SFX_NAMES = ['hiccup', 'sneeze', 'giggle', 'raspberry'];

  /** Синтезирует короткий звук. Возвращает {nodes, dur}. */
  function sfx(ctx, name, out, pitch, when) {
    pitch = pitch || 1;
    const t = Math.max(ctx.currentTime + 0.02, when || 0);
    const nodes = [];
    const N = (n) => { nodes.push(n); return n; };
    const osc = (type, f) => { const o = N(ctx.createOscillator()); o.type = type; o.frequency.value = f; return o; };
    const env = (at, peak, a, d) => {
      const g = N(ctx.createGain());
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(peak, at + a); g.gain.exponentialRampToValueAtTime(0.001, at + a + d);
      return g;
    };
    const nsrc = () => { const s = N(ctx.createBufferSource()); s.buffer = noise(ctx); s.loop = true; return s; };
    const filt = (type, f, q) => { const b = N(ctx.createBiquadFilter()); b.type = type; b.frequency.value = f; b.Q.value = q || 0.7; return b; };
    let dur = 0.5;

    if (name === 'giggle') {
      for (let k = 0; k < 5; k++) {
        const st = t + k * 0.12, f0 = (620 + k * 35) * pitch;
        const o = osc('triangle', f0);
        o.frequency.setValueAtTime(f0, st); o.frequency.exponentialRampToValueAtTime(f0 * 1.45, st + 0.06);
        const g = env(st, 0.35, 0.01, 0.08);
        o.connect(g); g.connect(out); o.start(st); o.stop(st + 0.11);
        const n = nsrc(), bp = filt('bandpass', 3000, 1), ng = env(st, 0.12, 0.005, 0.05);
        n.connect(bp); bp.connect(ng); ng.connect(out); n.start(st, Math.random()); n.stop(st + 0.07);
      }
      dur = 0.65;
    } else if (name === 'hiccup') {
      const o = osc('triangle', 380 * pitch);
      o.frequency.setValueAtTime(380 * pitch, t); o.frequency.exponentialRampToValueAtTime(950 * pitch, t + 0.07);
      const g = env(t, 0.5, 0.008, 0.09);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.12);
      const n = nsrc(), hp = filt('highpass', 2000), ng = env(t, 0.25, 0.002, 0.03);
      n.connect(hp); hp.connect(ng); ng.connect(out); n.start(t); n.stop(t + 0.05);
      dur = 0.2;
    } else if (name === 'sneeze') {
      // «а-а-а…»
      const o = osc('sawtooth', 240 * pitch);
      o.frequency.setValueAtTime(240 * pitch, t); o.frequency.linearRampToValueAtTime(420 * pitch, t + 0.55);
      const lp = filt('lowpass', 1100, 4);
      const g = N(ctx.createGain());
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.22, t + 0.5); g.gain.linearRampToValueAtTime(0, t + 0.58);
      o.connect(lp); lp.connect(g); g.connect(out); o.start(t); o.stop(t + 0.6);
      // «…пчхи!»
      const n = nsrc(), bp = filt('bandpass', 3800, 0.8), ng = env(t + 0.62, 0.9, 0.005, 0.3);
      n.connect(bp); bp.connect(ng); ng.connect(out); n.start(t + 0.62); n.stop(t + 0.98);
      dur = 1.0;
    } else if (name === 'raspberry') {
      const o = osc('sawtooth', 75 * pitch);
      const am = N(ctx.createGain()); am.gain.value = 0.5;
      const lfo = osc('square', 26); const lg = N(ctx.createGain()); lg.gain.value = 0.5;
      lfo.connect(lg); lg.connect(am.gain);
      const lp = filt('lowpass', 1400, 1);
      const g = N(ctx.createGain());
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.05); g.gain.setValueAtTime(0.5, t + 0.55); g.gain.linearRampToValueAtTime(0, t + 0.72);
      o.connect(am); am.connect(lp); lp.connect(g); g.connect(out);
      const n = nsrc(), bp = filt('bandpass', 700, 1); const ng = N(ctx.createGain()); ng.gain.value = 0.25;
      n.connect(bp); bp.connect(ng); ng.connect(am);
      o.start(t); lfo.start(t); n.start(t); o.stop(t + 0.75); lfo.stop(t + 0.75); n.stop(t + 0.75);
      dur = 0.75;
    } else if (name === 'yawn') {
      const o = osc('sawtooth', 300 * pitch);
      o.frequency.setValueAtTime(300 * pitch, t); o.frequency.exponentialRampToValueAtTime(160 * pitch, t + 1.3);
      const lp = filt('lowpass', 1400, 5);
      lp.frequency.setValueAtTime(1400, t); lp.frequency.exponentialRampToValueAtTime(450, t + 1.3);
      const g = N(ctx.createGain());
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.2, t + 0.3); g.gain.linearRampToValueAtTime(0, t + 1.35);
      o.connect(lp); lp.connect(g); g.connect(out); o.start(t); o.stop(t + 1.4);
      dur = 1.4;
    } else if (name === 'hmph') {
      const n = nsrc(), lp = filt('lowpass', 700, 1), ng = env(t, 0.7, 0.01, 0.25);
      n.connect(lp); lp.connect(ng); ng.connect(out); n.start(t); n.stop(t + 0.3);
      const o = osc('sawtooth', 130 * pitch), og = env(t, 0.18, 0.01, 0.2), olp = filt('lowpass', 600);
      o.connect(olp); olp.connect(og); og.connect(out); o.start(t); o.stop(t + 0.25);
      dur = 0.35;
    }
    return { nodes, dur, t };
  }

  const api = { VOICES, SFX_NAMES, pitchOf, speak, sfx, reverseBuf, stretchBuf };
  root.PovtVoices = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
