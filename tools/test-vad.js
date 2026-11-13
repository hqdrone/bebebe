// Офлайн-проверка детектора речи: node tools/test-vad.js phrase.wav
// Моделирует тихую комнату, стук, кашель, фразу и «эхо» динамика в микрофон.
'use strict';
const fs = require('fs');
const PovtVAD = require('../vad.js');

const SR = 48000, FRAME = 2048;
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

function readWav(path) {
  const b = fs.readFileSync(path);
  let p = 12, data = null;
  while (p < b.length) {
    const id = b.toString('ascii', p, p + 4), sz = b.readUInt32LE(p + 4);
    if (id === 'data') { data = b.subarray(p + 8, p + 8 + sz); break; }
    p += 8 + sz;
  }
  const out = new Float32Array(data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}

function run(name, { phrase, rate = 1.65, echoTail = 0.05, speakerToMic = 0.5, minThr = 0.025 }) {
  // сценарий: [сек, что]
  const events = [];
  const total = 40 * SR;
  const mic = new Float32Array(total);
  for (let i = 0; i < total; i++) mic[i] = gauss() * 0.003 + 0.002 * Math.sin(2 * Math.PI * 50 * i / SR);
  const put = (sec, sig, gain) => { const o = Math.floor(sec * SR); for (let i = 0; i < sig.length && o + i < total; i++) mic[o + i] += sig[i] * gain; };
  // стук: 25 мс щелчок; кашель: 0.2 с шум
  const knock = new Float32Array(0.025 * SR).map((_, i, a) => gauss() * (1 - i / a.length));
  const cough = new Float32Array(0.2 * SR).map((_, i, a) => gauss() * Math.sin(Math.PI * i / a.length));
  put(12, knock, 0.6); events.push('12s стук');
  put(16, cough, 0.25); events.push('16s кашель');
  if (phrase) {
    let pk = 0; for (const v of phrase) pk = Math.max(pk, Math.abs(v));
    put(22, phrase, 0.25 / pk); events.push('22s «привет, как дела»');
  }

  const vad = new PovtVAD(SR, { minThr });
  const phrases = [];
  let pos = 0, playUntil = -1, unmuteAt = -1, playing = null;
  vad.onPhrase = (buf, info) => {
    const t = pos / SR;
    phrases.push({ t: t.toFixed(2), sec: info.seconds.toFixed(2), voiced: info.voiced.toFixed(2) });
    // «воспроизведение»: звук из динамика попадает обратно в микрофон
    vad.mute();
    const dur = buf.length / SR / rate;
    const out = new Float32Array(Math.floor((dur + echoTail + 0.3) * SR));
    for (let i = 0; i < out.length; i++) {
      const src = Math.floor(i * rate);
      let v = src < buf.length ? buf[src] : 0;
      // хвост реверберации комнаты 0.3 с
      const j = i - Math.floor(0.03 * SR); if (j > 0) v += out[j] * 0.35;
      out[i] = v;
    }
    put(t + 0.03, out, speakerToMic);
    playUntil = t + dur + echoTail;
  };
  for (; pos + FRAME <= total; pos += FRAME) {
    if (playUntil > 0 && pos / SR >= playUntil) { vad.unmuteAfter(0.45); playUntil = -1; }
    vad.process(mic.subarray(pos, pos + FRAME));
  }
  console.log(`\n== ${name}\n  события: ${events.join(', ')}\n  фраз распознано: ${phrases.length}`, phrases);
  return phrases.length;
}

const wav = process.argv[2] ? readWav(process.argv[2]) : null;
let ok = true;
ok &= run('Тихая комната + стук + кашель (без речи)', { phrase: null }) === 0;
if (wav) {
  ok &= run('Фраза, голос белочки', { phrase: wav, rate: 1.65 }) === 1;
  ok &= run('Фраза, медведь (длинное воспроизведение)', { phrase: wav, rate: 0.55 }) === 1;
  ok &= run('Фраза, попугай-эхо (хвост 1.4 с)', { phrase: wav, rate: 1.0, echoTail: 1.4 }) === 1;
  ok &= run('Фраза, макс. чувствительность', { phrase: wav, rate: 1.0, minThr: 0.01 }) === 1;
  ok &= run('Фраза, мин. чувствительность', { phrase: wav, rate: 1.0, minThr: 0.06 }) === 1;
}
console.log(ok ? '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : '\nЕСТЬ ОШИБКИ');
process.exit(ok ? 0 : 1);
