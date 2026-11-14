/* Повторялка — интерфейс, звук, реакции, анимация. */
(() => {
  'use strict';
  const SP = window.Sprites;
  const PV = window.PovtVoices;
  const PovtVAD = window.PovtVAD;
  const $ = (s) => document.querySelector(s);
  const VOICES = PV.VOICES;
  const K = SP.COLORS;

  const MUTE_AFTER = 0.45;     // с: игнор микрофона после любого звука из динамика
  const EXTRA_CHANCE = 0.3;    // шанс «добавки» после фразы
  const SLEEP_AFTER = 30000;   // мс тишины до засыпания
  const SHOUT_RMS = 0.22;      // крик (абсолютный RMS)

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

  // выбор персонажа
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
  function markPick(scroll) {
    for (const id in picks) picks[id].setAttribute('aria-checked', id === current ? 'true' : 'false');
    if (scroll) {
      const b = picks[current];
      grid.scrollLeft = Math.max(0, b.offsetLeft - (grid.clientWidth - b.offsetWidth) / 2);
    }
  }
  markPick(true);

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

  // размер героя: целый масштаб
  function fitHero() {
    const r = stage.getBoundingClientRect();
    const s = Math.max(1, Math.floor(Math.min(r.width / HW, r.height / HH)));
    heroWrap.style.width = HW * s + 'px';
    heroWrap.style.height = HH * s + 'px';
    bubble.style.fontSize = Math.max(16, Math.min(28, s * 4.5)) + 'px';
  }
  if (window.ResizeObserver) new ResizeObserver(fitHero).observe(stage);
  window.addEventListener('resize', fitHero);

  // ---------- состояние ----------
  let ctx = null, vad = null, stream = null, master = null, analyser = null, anBuf = null;
  let started = false, lastBuffer = null, playing = null, audioToken = 0, lastRandom = null;
  // mode: idle | tease | extra | tongue | tickle | angry | yawn | sleep | wake
  let mode = 'idle', modeAt = 0, modeUntil = 0, shownId = current, palm = false, extraName = null;
  let inLevel = 0, shoutUntil = 0, speechAt = 0, speechMax = 0, lastLively = performance.now();
  let taps = [], phraseTimes = [];
  const now = () => performance.now();
  function setMode(m, ms) { mode = m; modeAt = now(); modeUntil = ms ? modeAt + ms : 0; }

  // ---------- звук ----------
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

    master = ctx.createGain(); master.gain.value = 1;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.ratio.value = 4;
    analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    anBuf = new Float32Array(analyser.fftSize);
    master.connect(comp); comp.connect(analyser); analyser.connect(ctx.destination);

    vad = new PovtVAD(ctx.sampleRate, { minThr });
    vad.onStart = () => { speechAt = now(); speechMax = 0; };
    vad.onPhrase = (samples) => {
      const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buf.copyToChannel(samples, 0);
      lastBuffer = buf;
      phraseTimes.push(now());
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
    const sink = ctx.createGain(); sink.gain.value = 0;
    src.connect(node); node.connect(sink); sink.connect(ctx.destination);
  }

  function onFrame(frame) {
    vad.process(frame);
    if (vad.muted) { inLevel = 0; return; }
    inLevel = vad.lastRms / vad.threshold();
    const t = now();
    if (inLevel > 0.7) lastLively = t;
    if (vad.speaking) speechMax = Math.max(speechMax, inLevel);
    if (vad.lastRms > SHOUT_RMS && inLevel > 5) shoutUntil = t + 700;
  }

  function outLevel() {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(anBuf);
    let s = 0;
    for (let i = 0; i < anBuf.length; i++) s += anBuf[i] * anBuf[i];
    return Math.sqrt(s / anBuf.length);
  }

  function stopVoice() {
    audioToken++;
    if (!playing) return;
    for (const n of playing.nodes) {
      try { if (n.stop) n.stop(); } catch (e) { /* уже остановлен */ }
      try { n.disconnect(); } catch (e) { /* ок */ }
    }
    playing = null;
  }
  // микрофон глушится на всё время звука и ещё MUTE_AFTER после
  function releaseAfter(sec) {
    const tok = audioToken;
    setTimeout(() => {
      if (tok !== audioToken) return;
      stopVoice();
      vad.unmuteAfter(MUTE_AFTER);
    }, sec * 1000);
  }
  function at(sec, fn) { const tok = audioToken; setTimeout(() => { if (tok === audioToken) fn(); }, sec * 1000); }

  function pickVoice() {
    if (!VOICES[current].random) return current;
    const pool = SP.ORDER.filter((i) => !VOICES[i].random && i !== lastRandom);
    lastRandom = pool[Math.floor(Math.random() * pool.length)];
    return lastRandom;
  }

  function play(buf) {
    if (!ctx || !buf) return;
    stopVoice();
    vad.mute();
    lastLively = now();
    const id = pickVoice();
    shownId = id;
    const r = PV.speak(ctx, buf, id, master);
    const nodes = r.nodes;
    let end = r.dur + r.tail;
    let extra = null;
    if (Math.random() < EXTRA_CHANCE) {
      extra = PV.SFX_NAMES[Math.floor(Math.random() * PV.SFX_NAMES.length)];
      const s = PV.sfx(ctx, extra, master, PV.pitchOf(id), r.t0 + r.dur + 0.12);
      nodes.push(...s.nodes);
      extra = { name: extra, at: r.dur + 0.12, dur: s.dur };
      end = Math.max(end, extra.at + s.dur);
    }
    playing = { nodes };
    setMode('tease');
    showBubble('бе-бе!');
    if (extra) at(extra.at, () => { setMode('extra', extra.dur * 1000 + 100); extraName = extra.name; showBubble(EXTRA_TEXT[extra.name]); });
    else at(r.dur + 0.03, startTongue);
    releaseAfter(end + 0.08);
  }

  function startTongue() { setMode('tongue', 600 + Math.random() * 400); palm = Math.random() < 0.35; showBubble('бе-бе!'); }

  function playSfx(name, id) {
    if (!ctx) return 0;
    stopVoice();
    vad.mute();
    const s = PV.sfx(ctx, name, master, PV.pitchOf(id || current));
    playing = { nodes: s.nodes };
    releaseAfter(s.dur + 0.08);
    return s.dur;
  }

  const EXTRA_TEXT = { hiccup: 'ик!', sneeze: 'апчхи!', giggle: 'хи-хи!', raspberry: 'пфррр!' };
  let bubbleText = '';
  function showBubble(text) {
    if (!text) { bubble.hidden = true; bubbleText = ''; return; }
    if (bubble.hidden || bubbleText !== text) {
      bubble.textContent = text;
      bubbleText = text;
      bubble.hidden = false;
      bubble.classList.remove('pop'); void bubble.offsetWidth; bubble.classList.add('pop');
    }
  }

  function select(id) {
    current = id;
    store.set(KEY_CHAR, id);
    markPick(false);
    lastLively = now();
    if (mode === 'sleep' || mode === 'yawn') wake();
    if (mode === 'idle' || mode === 'wake') shownId = id;
    if (started && lastBuffer) play(lastBuffer);
  }

  // ---------- реакции ----------
  function wake() {
    stopVoice();
    if (vad && vad.muted) vad.unmuteAfter(0.1);
    shownId = current;
    setMode('wake', 800);
    showBubble('ой!');
    lastLively = now();
  }

  hero.addEventListener('click', () => {
    const t = now();
    lastLively = t;
    if (!started) { setMode('tickle', 700); return; }
    if (mode === 'sleep' || mode === 'yawn') { wake(); return; }
    if (mode === 'angry') return;                // сердится — не мешаем
    taps = taps.filter((x) => t - x < 2500);
    taps.push(t);
    if (taps.length >= 5) {                       // затыкали — сердится
      taps = [];
      shownId = current;
      setMode('angry', 1700);
      showBubble('хмф!');
      playSfx('hmph');
      return;
    }
    const busy = mode === 'tease' || mode === 'extra' || mode === 'tongue' || mode === 'tickle';
    if (busy || !lastBuffer) {                   // щекотка
      shownId = mode === 'idle' ? current : shownId;
      setMode('tickle', 900);
      showBubble('хи-хи!');
      playSfx('giggle', shownId);
      return;
    }
    play(lastBuffer);                            // повтор последней фразы
  });

  // ---------- wake lock ----------
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') await navigator.wakeLock.request('screen');
    } catch (e) { /* не страшно */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && started) {
      keepAwake();
      if (ctx && ctx.state !== 'running') ctx.resume();
      lastLively = now();
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
      lastLively = now();
      setMode('idle');
      $('#start').hidden = true;
      $('#app').removeAttribute('aria-hidden');
      fitHero();
      markPick(true);
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
  let tick = 0, lastT = 0, nextBlink = 0, blinkUntil = 0, lastStatus = '';
  const FLOAT = [0, 0, -1, -1, -1, 0, 0, 1, 1, 1];

  // переходы между режимами по времени
  function advance(t) {
    if (!started) { if (mode === 'tickle' && t > modeUntil) setMode('idle'); return; }
    if (modeUntil && t > modeUntil) {
      if (mode === 'yawn') { setMode('sleep'); showBubble(''); return; }
      if (mode === 'extra') { startTongue(); return; }
      setMode('idle'); shownId = current; showBubble('');
    }
    if (mode === 'sleep' && (inLevel > 1 || (vad && vad.speaking))) { wake(); return; }
    if (mode === 'idle' && vad && !vad.speaking && !vad.muted && t - lastLively > SLEEP_AFTER) {
      setMode('yawn', 1500);
      showBubble('');
      playSfx('yawn');
    }
  }

  function moodHigh(t) {
    phraseTimes = phraseTimes.filter((x) => t - x < 120000);
    return phraseTimes.length >= 4;
  }

  function pose(t) {
    const p = { t: tick, eyes: 'normal', mouth: 'smile', earUp: 0, bob: (tick >> 1) & 1, flap: 0, palm: false, finger: tick & 1, paws: null, blush: K.P };
    let dx = 0, dy = 0, tilt = 0;
    const glyphs = [];
    let status = 'Говори!';
    const el = t - modeAt;
    const alt = tick & 1 ? 1 : -1;

    switch (mode) {
      case 'tease': {
        const lv = outLevel();
        p.mouth = lv < 0.015 ? 'smile' : lv < 0.06 ? 'half' : 'open';
        p.eyes = tick % 8 < 6 ? 'squint' : 'normal';
        dy = [0, -1, -2, -1][tick % 4];
        const sw = (tick >> 1) & 1 ? 1 : -1;
        dx = sw; tilt = sw * 0.09;
        p.flap = lv > 0.02 ? tick & 1 : 0;
        p.bob = tick & 1;
        status = 'Бе-бе-бе!';
        break;
      }
      case 'extra':
        status = 'Бе-бе-бе!';
        if (extraName === 'hiccup') {
          p.eyes = 'wide'; p.mouth = 'half'; dy = el < 200 ? -3 : 0;
          glyphs.push(['bang', 47, 3, 2, K.K]);
        } else if (extraName === 'sneeze') {
          if (el < 650) { p.eyes = 'happy'; p.mouth = 'half'; tilt = -0.12; dy = -1; }
          else { p.eyes = 'squint'; p.mouth = 'open'; tilt = 0.15; dx = 1; glyphs.push(['drop', 46, 18, 1, K.S], ['drop', 50, 24, 1, K.S]); }
        } else if (extraName === 'giggle') {
          p.eyes = 'happy'; p.mouth = tick & 1 ? 'open' : 'half'; dx = alt; dy = -(tick & 1);
        } else {
          p.eyes = 'squint'; p.mouth = tick & 1 ? 'tongue' : 'half'; dx = alt;
        }
        break;
      case 'tongue':
        p.mouth = 'tongue'; p.eyes = 'squint'; p.palm = palm;
        dy = tick & 1 ? -1 : 0; p.flap = tick & 1;
        status = 'Бе-бе-бе!';
        break;
      case 'tickle':
        p.eyes = 'happy'; p.mouth = tick & 1 ? 'open' : 'half';
        dx = alt; dy = -(tick & 1); tilt = alt * 0.1; p.flap = tick & 1;
        glyphs.push(['heart', 45, 4 - (tick >> 1) % 3, 1, K.R]);
        status = 'Ой, щекотно!';
        break;
      case 'angry':
        p.eyes = 'angry'; p.mouth = 'frown'; p.blush = K.R; dx = alt;
        glyphs.push(['puff', 6 + (tick % 3), 4 - (tick % 3), 1, K.G], ['puff', 44 - (tick % 3), 4 - ((tick + 1) % 3), 1, K.G]);
        status = 'Ну хватит!';
        break;
      case 'yawn':
        p.eyes = 'blink'; p.mouth = 'open'; tilt = -0.08; dy = -1;
        status = 'А-а-ам…';
        break;
      case 'sleep': {
        p.eyes = 'blink';
        const slow = (tick / 10 | 0) % 2;
        p.mouth = slow ? 'half' : 'smile'; dy = slow;
        const z = (tick >> 2) % 4;
        glyphs.push(['z', 44, 12 - z * 3, 1, K.K]);
        if (z > 1) glyphs.push(['z', 47, 9 - z * 2, 1, K.L]);
        status = 'Хр-р-р…';
        break;
      }
      case 'wake':
        p.eyes = 'wide'; p.mouth = 'half'; dy = el < 250 ? -3 : -1;
        glyphs.push(['bang', 47, 2, 2, K.R]);
        status = 'Ой! Не сплю!';
        break;
      default: { // idle / слушает
        const hearing = started && vad && !vad.muted && (vad.speaking || inLevel > 0.7);
        if (hearing && t < shoutUntil) {                    // крик — закрывает уши
          p.eyes = 'squint'; p.mouth = 'frown'; p.paws = 'cover'; dx = alt;
          glyphs.push(['bang', 47, 2, 2, K.R], ['bang', 4, 4, 1, K.R]);
          status = 'Ой, громко!';
        } else if (hearing) {
          const whisper = vad.speaking && t - speechAt > 500 && speechMax < 2.5;
          p.eyes = 'wide'; p.earUp = 1; tilt = whisper ? 0.2 : 0.13; p.bob = tick & 1;
          if (whisper) { p.paws = 'cup'; dx = 1; }
          const up = (tick >> 1) & 1;
          const big = inLevel > 1.8 ? 2 : 1;
          glyphs.push(['q', big > 1 ? 45 : 47, (big > 1 ? 0 : 5) + up, big, K.K]);
          if (inLevel > 1.1) glyphs.push(['note', 2, 10 - up, inLevel > 2.5 ? 2 : 1, K.R]);
          if (inLevel > 3) glyphs.push(['note', 6, 30 + up, 1, K.S]);
          status = vad.speaking ? (whisper ? 'Шепчешь? Слушаю…' : 'Слушаю…') : 'Говори!';
        } else {
          dy = ((tick / 5) | 0) % 2;
          if (t > nextBlink) { blinkUntil = t + 160; nextBlink = t + 2000 + Math.random() * 2000; }
          if (t < blinkUntil) p.eyes = 'blink';
          if (started && moodHigh(t) && tick % 60 < 12) { // хорошее настроение — пританцовывает
            p.eyes = 'happy'; dy = [0, -1, -2, -1][tick % 4]; tilt = ((tick >> 1) & 1 ? 1 : -1) * 0.08;
            glyphs.push(['heart', 45, 3, 1, K.R]);
          }
        }
      }
    }
    return { p, dx, dy, tilt, glyphs, status };
  }

  function render(t) {
    advance(t);
    const { p, dx, dy, tilt, glyphs, status } = pose(t);
    const id = mode === 'idle' || !started ? current : shownId;
    const fl = SP.CHARS[id].float ? FLOAT[tick % 10] : 0;
    const g = SP.build(id, p);
    const c2 = started ? hctx : sctx;
    c2.clearRect(0, 0, HW, HH);
    SP.draw(c2, g, 12 + dx, 14 + dy + fl, tilt);
    for (const [name, x, y, sc, col] of glyphs) SP.glyph(c2, name, x, y, sc, col);
    if (started && status !== lastStatus) { statusEl.textContent = status; lastStatus = status; }
  }

  function loop(t) {
    requestAnimationFrame(loop);
    if (t - lastT < 100) return;
    lastT = t;
    tick++;
    render(t);
  }
  requestAnimationFrame(loop);
  fitHero();

  // ---------- офлайн ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW', e));
    });
    // новая версия приложения: перезагружаемся, пока игра ещё не начата
    let reloaded = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !started && !reloaded) { reloaded = true; location.reload(); }
    });
  }

  // для отладки и автотестов
  window.__povt = {
    get state() { return { mode, current, shownId, started, minThr, extraName, speaking: !!(vad && vad.speaking), muted: !!(vad && vad.muted), hasPhrase: !!lastBuffer }; },
    set sleepAfter(ms) { lastLively = now() - SLEEP_AFTER + ms; },
    get ctx() { return ctx; },
  };
})();
