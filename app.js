/* Повторялка — интерфейс, звук, анимация. */
(() => {
  'use strict';
  const SP = window.Sprites;
  const PovtVAD = window.PovtVAD;
  const $ = (s) => document.querySelector(s);

  // ---------- голоса ----------
  const VOICES = {
    squirrel: { rate: 1.65 },
    mouse:    { rate: 2.05 },
    bear:     { rate: 0.68 },
    robot:    { rate: 1.0, ring: 55, ringMix: 0.8 },
    alien:    { rate: 1.3, ring: 380, ringMix: 0.6 },
    monster:  { rate: 0.55, ring: 28, ringMix: 0.7 },
    parrot:   { rate: 1.0, delay: 0.28, feedback: 0.45 },
    cube:     { random: true },
  };
  const MUTE_AFTER = 0.45; // с: игнор микрофона после воспроизведения

  // ---------- настройки ----------
  const KEY_THR = 'povt.minThr', KEY_CHAR = 'povt.char';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* приватный режим */ } },
  };
  let minThr = parseFloat(store.get(KEY_THR));
  if (!(minThr >= 0.01 && minThr <= 0.06)) minThr = 0.025;
  let current = store.get(KEY_CHAR);
  if (!SP.CHARS[current]) current = 'squirrel';
  const thrToSlider = (t) => Math.round((0.06 - t) / 0.0005);   // вправо = чувствительнее
  const sliderToThr = (v) => +(0.06 - v * 0.0005).toFixed(4);

  // ---------- элементы ----------
  const hero = $('#hero'), hctx = hero.getContext('2d');
  const startHero = $('#startHero'), sctx = startHero.getContext('2d');
  const heroWrap = $('#heroWrap'), stage = $('#stage');
  const bubble = $('#bubble'), statusEl = $('#status'), grid = $('#grid');
  const sensInput = $('#sensInput'), sensBars = $('#sensBars');
  const HW = 56, HH = 50;

  // сетка выбора
  const picks = {};
  SP.ORDER.forEach((id) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'px-btn pick';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', SP.CHARS[id].name);
    b.title = SP.CHARS[id].name;
    const cv = document.createElement('canvas');
    cv.width = 34; cv.height = 34;
    SP.draw(cv.getContext('2d'), SP.build(id, {}), 1, 1, 0);
    b.appendChild(cv);
    b.addEventListener('click', () => select(id));
    grid.appendChild(b);
    picks[id] = b;
  });
  function markPick() {
    for (const id in picks) picks[id].setAttribute('aria-checked', id === current ? 'true' : 'false');
  }
  markPick();

  // ползунок
  for (let i = 0; i < 6; i++) { const e = document.createElement('i'); e.style.height = (4 + i * 2) + 'px'; sensBars.appendChild(e); }
  function showSens() {
    const v = +sensInput.value;
    [...sensBars.children].forEach((e, i) => e.classList.toggle('on', v >= i * 20 - 1));
  }
  sensInput.value = thrToSlider(minThr);
  showSens();
  sensInput.addEventListener('input', () => {
    minThr = sliderToThr(+sensInput.value);
    if (vad) vad.minThr = minThr;
    store.set(KEY_THR, String(minThr));
    showSens();
  });

  // ---------- размер героя ----------
  function fitHero() {
    const r = stage.getBoundingClientRect();
    const s = Math.max(1, Math.floor(Math.min(r.width / HW, r.height / HH)));
    heroWrap.style.width = HW * s + 'px';
    heroWrap.style.height = HH * s + 'px';
    bubble.style.fontSize = Math.max(16, Math.min(28, s * 4.5)) + 'px';
  }
  if (window.ResizeObserver) new ResizeObserver(fitHero).observe(stage);
  window.addEventListener('resize', fitHero);

  // ---------- звук ----------
  let ctx = null, vad = null, stream = null, master = null, analyser = null, anBuf = null;
  let started = false, lastBuffer = null, playing = null, playToken = 0, lastRandom = null;
  let mode = 'idle', shownId = current, tongueUntil = 0, palm = false, inLevel = 0;

  const WORKLET = `
    class PovtCapture extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) for (let i = 0; i < ch.length; i++) {
          this.buf[this.n++] = ch[i];
          if (this.n === 2048) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(2048); this.n = 0; }
        }
        return true;
      }
    }
    registerProcessor('povt-capture', PovtCapture);`;

  async function startAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('nomedia');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    await ctx.resume();

    // выход: master → компрессор → анализатор → динамик
    master = ctx.createGain(); master.gain.value = 1;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.ratio.value = 4;
    analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    anBuf = new Float32Array(analyser.fftSize);
    master.connect(comp); comp.connect(analyser); analyser.connect(ctx.destination);

    // вход
    vad = new PovtVAD(ctx.sampleRate, { minThr });
    vad.onPhrase = (samples) => {
      const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buf.copyToChannel(samples, 0);
      lastBuffer = buf;
      play(buf);
    };
    const src = ctx.createMediaStreamSource(stream);
    let node;
    if (ctx.audioWorklet && window.AudioWorkletNode) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      node = new AudioWorkletNode(ctx, 'povt-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (e) => onFrame(e.data);
    } else {
      node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    const sink = ctx.createGain(); sink.gain.value = 0; // узел должен быть в графе, звука нет
    src.connect(node); node.connect(sink); sink.connect(ctx.destination);
  }

  function onFrame(frame) {
    vad.process(frame);
    inLevel = vad.muted ? 0 : vad.lastRms / vad.threshold();
  }

  function outLevel() {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(anBuf);
    let s = 0;
    for (let i = 0; i < anBuf.length; i++) s += anBuf[i] * anBuf[i];
    return Math.sqrt(s / anBuf.length);
  }

  function stopVoice() {
    playToken++;
    if (!playing) return;
    for (const n of playing.nodes) {
      try { if (n.stop) n.stop(); } catch (e) { /* уже остановлен */ }
      try { n.disconnect(); } catch (e) { /* ок */ }
    }
    playing = null;
  }

  function play(buf) {
    if (!ctx || !buf) return;
    stopVoice();
    vad.mute();
    let id = current;
    if (VOICES[id].random) {
      const pool = SP.ORDER.filter((i) => !VOICES[i].random && i !== lastRandom);
      id = pool[Math.floor(Math.random() * pool.length)];
      lastRandom = id;
    }
    const v = VOICES[id];
    shownId = id;

    const t0 = ctx.currentTime + 0.03;
    const nodes = [];
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = v.rate;
    const out = ctx.createGain();
    nodes.push(src, out);
    if (v.ring) {
      // ring modulation: сигнал × синус (gain=0 + осциллятор на gain)
      const ring = ctx.createGain(); ring.gain.value = 0;
      const osc = ctx.createOscillator(); osc.frequency.value = v.ring;
      osc.connect(ring.gain);
      const wet = ctx.createGain(); wet.gain.value = v.ringMix * 1.6;
      const dry = ctx.createGain(); dry.gain.value = 1 - v.ringMix;
      src.connect(ring); ring.connect(wet); wet.connect(out);
      src.connect(dry); dry.connect(out);
      osc.start(t0);
      nodes.push(osc, ring, wet, dry);
    } else {
      src.connect(out);
    }
    let tail = 0.05;
    if (v.delay) {
      const d = ctx.createDelay(2); d.delayTime.value = v.delay;
      const fb = ctx.createGain(); fb.gain.value = v.feedback;
      const ew = ctx.createGain(); ew.gain.value = 0.8;
      out.connect(d); d.connect(fb); fb.connect(d); d.connect(ew); ew.connect(master);
      nodes.push(d, fb, ew);
      tail = v.delay * Math.ceil(Math.log(0.02) / Math.log(v.feedback));
    }
    out.connect(master);
    src.start(t0);

    const dur = buf.duration / v.rate;
    const token = playToken;
    playing = { nodes };
    mode = 'tease';
    bubble.hidden = false;
    bubble.classList.remove('pop'); void bubble.offsetWidth; bubble.classList.add('pop');
    setTimeout(() => {
      if (token !== playToken) return;
      mode = 'tongue';
      palm = Math.random() < 0.35;
      tongueUntil = performance.now() + 600 + Math.random() * 400;
    }, (dur + 0.03) * 1000);
    setTimeout(() => {
      if (token !== playToken) return;
      stopVoice();
      vad.unmuteAfter(MUTE_AFTER);
    }, (dur + tail + 0.08) * 1000);
  }

  function select(id) {
    current = id;
    store.set(KEY_CHAR, id);
    markPick();
    if (mode === 'idle') shownId = id;
    if (started && lastBuffer) play(lastBuffer);
  }

  hero.addEventListener('click', () => {
    if (started && lastBuffer) play(lastBuffer);
    else pokeUntil = performance.now() + 500;
  });

  // ---------- wake lock ----------
  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (e) { /* не страшно */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && started) {
      keepAwake();
      if (ctx && ctx.state !== 'running') ctx.resume();
    }
  });

  // ---------- старт ----------
  const playBtn = $('#playBtn'), errEl = $('#err');
  playBtn.addEventListener('click', async () => {
    playBtn.disabled = true;
    errEl.hidden = true;
    try {
      await startAudio();
      started = true;
      $('#start').hidden = true;
      $('#app').removeAttribute('aria-hidden');
      fitHero();
      keepAwake();
    } catch (e) {
      console.warn('Повторялка: нет микрофона', e);
      if (ctx) { try { ctx.close(); } catch (_) { /* ок */ } ctx = null; }
      errEl.textContent = !window.isSecureContext
        ? 'Нужно открыть по https://, иначе микрофон не работает.'
        : 'Нужен микрофон. Разреши доступ к нему и нажми «Играть» ещё раз.';
      errEl.hidden = false;
      playBtn.disabled = false;
    }
  });

  // ---------- анимация (10 fps) ----------
  let tick = 0, lastT = 0, nextBlink = 0, blinkUntil = 0, pokeUntil = 0, lastStatus = '';

  function pose(now, idle) {
    const p = { t: tick, eyes: 'normal', mouth: 'smile', earUp: 0, bob: (tick >> 1) & 1, flap: 0, palm: false, finger: tick & 1 };
    let dx = 0, dy = 0, tilt = 0, hearing = false;
    if (!idle && mode === 'tease') {
      const lv = outLevel();
      p.mouth = lv < 0.015 ? 'smile' : lv < 0.06 ? 'half' : 'open';
      p.eyes = tick % 8 < 6 ? 'squint' : 'normal';
      dy = [0, -1, -2, -1][tick % 4];
      const sw = (tick >> 1) & 1 ? 1 : -1;
      dx = sw; tilt = sw * 0.09;
      p.flap = lv > 0.02 ? tick & 1 : 0;
      p.bob = tick & 1;
    } else if (!idle && mode === 'tongue') {
      p.mouth = 'tongue'; p.eyes = 'squint'; p.palm = palm;
      dy = tick & 1 ? -1 : 0;
      p.flap = tick & 1;
    } else {
      hearing = !idle && vad && !vad.muted && (vad.speaking || inLevel > 0.7);
      if (hearing) {
        p.eyes = 'wide'; p.earUp = 1; tilt = 0.13; p.bob = tick & 1;
      } else {
        dy = ((tick / 5) | 0) % 2; // дыхание
        if (now > nextBlink) { blinkUntil = now + 160; nextBlink = now + 2000 + Math.random() * 2000; }
        if (now < blinkUntil) p.eyes = 'blink';
        if (now < pokeUntil) { p.eyes = 'happy'; dy = -1; }
      }
    }
    return { p, dx, dy, tilt, hearing };
  }

  function render(now) {
    const idle = !started;
    if (mode === 'tongue' && now > tongueUntil) { mode = 'idle'; shownId = current; bubble.hidden = true; }
    const { p, dx, dy, tilt, hearing } = pose(now, idle);
    const id = idle || mode === 'idle' ? current : shownId;
    const g = SP.build(id, p);
    const c2 = idle ? sctx : hctx;
    c2.clearRect(0, 0, HW, HH);
    SP.draw(c2, g, 12 + dx, 14 + dy, tilt);
    if (hearing) {
      const up = (tick >> 1) & 1;
      const big = inLevel > 1.8 ? 2 : 1;
      SP.glyph(c2, 'q', big > 1 ? 45 : 47, (big > 1 ? 0 : 5) + up, big, SP.COLORS.K);
      if (inLevel > 1.1) SP.glyph(c2, 'note', 2, 10 - up, inLevel > 2.5 ? 2 : 1, SP.COLORS.R);
      if (inLevel > 3) SP.glyph(c2, 'note', 6, 30 + up, 1, SP.COLORS.S);
    }
    if (started) {
      const st = mode !== 'idle' ? 'Бе-бе-бе!' : vad && vad.speaking ? 'Слушаю…' : 'Говори!';
      if (st !== lastStatus) { statusEl.textContent = st; lastStatus = st; }
    }
  }

  function loop(now) {
    requestAnimationFrame(loop);
    if (now - lastT < 100) return;
    lastT = now;
    tick++;
    render(now);
  }
  requestAnimationFrame(loop);
  fitHero();

  // ---------- офлайн ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW', e));
    });
  }

  // для отладки и автотестов
  window.__povt = {
    get state() { return { mode, current, shownId, started, minThr, speaking: !!(vad && vad.speaking), muted: !!(vad && vad.muted), hasPhrase: !!lastBuffer }; },
    get ctx() { return ctx; },
  };
})();
