/* Повторялка — пиксельные персонажи 32×32.
   Каждый кадр собирается в массив индексов палитры (Uint8Array 32×32):
   силуэт из простых фигур → автоматический контур → лицо из пиксельных штампов. */
(function (root) {
  'use strict';

  // 12 цветов: мягкая пастель
  const PALETTE = [
    null,      // 0 прозрачный
    '#fff3dc', // 1 c  крем (фон, животики)
    '#4a3044', // 2 K  контур (тёмная слива)
    '#ffffff', // 3 W  белый (блики, зубки)
    '#f6a8b8', // 4 P  розовый (румянец)
    '#e2607a', // 5 R  красный (рот, язык)
    '#f2a65a', // 6 O  оранжевый
    '#a8735a', // 7 B  коричневый
    '#b8bad0', // 8 G  серый
    '#8fd6b4', // 9 M  мята
    '#b9a0e6', // 10 L лаванда
    '#ffd66e', // 11 Y жёлтый
    '#8cc6ea', // 12 S голубой
  ];
  const c = 1, K = 2, W = 3, P = 4, R = 5, O = 6, B = 7, G = 8, M = 9, L = 10, Y = 11, S = 12;
  const CH = { c, K, W, P, R, O, B, G, M, L, Y, S };
  const N = 32;

  // ---------- примитивы ----------
  function grid() { return { w: N, h: N, d: new Uint8Array(N * N) }; }
  function set(g, x, y, col) { if (x >= 0 && y >= 0 && x < g.w && y < g.h) g.d[y * g.w + x] = col; }
  function ell(g, cx, cy, rx, ry, col) {
    const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(g.h - 1, Math.ceil(cy + ry));
    const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(g.w - 1, Math.ceil(cx + rx));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) g.d[y * g.w + x] = col;
    }
  }
  function rect(g, x0, y0, x1, y1, col) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(g, x, y, col); }
  function outline(g) {
    const s = g.d.slice();
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      const i = y * g.w + x;
      if (s[i]) continue;
      if ((x > 0 && s[i - 1]) || (x < g.w - 1 && s[i + 1]) || (y > 0 && s[i - g.w]) || (y < g.h - 1 && s[i + g.w])) g.d[i] = K;
    }
  }
  // штамп из строк; 'X' — основной цвет персонажа, '.' — пропуск
  function stamp(g, x0, y0, rows, X, mirror) {
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let i = 0; i < row.length; i++) {
        const ch = row[mirror ? row.length - 1 - i : i];
        const col = ch === 'X' ? X : CH[ch];
        if (col) set(g, x0 + i, y0 + r, col);
      }
    }
  }
  const mirrorX = (x, w) => N - x - w;

  // ---------- лицо ----------
  const EYES = {
    normal: ['.KK.', 'KWKK', 'KKKK', 'KKKK', '.KK.'],
    wide:   ['.KKK.', 'KWWKK', 'KWKKK', 'KKKKK', 'KKKKK', '.KKK.'],
    blink:  ['....', '....', '....', 'KKKK', '....'],
    happy:  ['....', '.KK.', 'K..K', '....', '....'],
    squint: ['K...', '.KK.', '...K', '.KK.', 'K...'],
  };
  const MOUTH = {
    smile:  ['K..K', '.KK.'],
    half:   ['.KKKK.', 'KRRRRK', '.KKKK.'],
    open:   ['.KKKK.', 'KRRRRK', 'KRRRRK', 'KRPPRK', '.KKKK.'],
    tongue: ['KKKKKK', '.KRRK.', '.KRPK.', '..KK..'],
  };
  const BEAK = {
    smile:  ['OOOO', 'OOOO', '.OO.'],
    half:   ['OOOO', 'KRRK', '.OO.'],
    open:   ['OOOO', 'KRRK', 'KRRK', '.OO.'],
    tongue: ['OOOO', 'KRRK', '.RR.', '.RP.', '..K.'],
  };
  const HAND = [
    '....K.K.K..',
    '...KXKXKXK.',
    'KKKXXXXXXK.',
    'KXXXXXXXXK.',
    'KKKXXXXXK..',
    '...KKKKK...',
  ];

  function face(g, p, f) {
    const ey = f.ey != null ? f.ey : 10, lx = f.lx != null ? f.lx : 10;
    const my = f.my != null ? f.my : 16, by = f.by != null ? f.by : 16, bx = f.bx != null ? f.bx : 6;
    let kind = p.eyes || 'normal';
    if (f.big && kind === 'normal') kind = 'wide';
    const st = EYES[kind], w = st[0].length, big = st.length > 5;
    const x1 = big ? lx - 1 : lx, y1 = big ? ey - 1 : ey;
    const mir = kind === 'squint' || kind === 'happy';
    stamp(g, x1, y1, st, 0, false);
    stamp(g, mirrorX(x1, w), y1, st, 0, mir);
    if (!f.noBlush) { stamp(g, bx, by, ['PPP']); stamp(g, mirrorX(bx, 3), by, ['PPP']); }
    const m = (f.beak ? BEAK : MOUTH)[p.mouth || 'smile'];
    stamp(g, 16 - m[0].length / 2, my, m);
    return my;
  }

  // ---------- персонажи ----------
  const CHARS = {
    squirrel: {
      name: 'Белочка', color: O,
      build(g, p) {
        const sw = [0, 1, 1, 0, -1, -1][p.t % 6]; // хвост качается
        ell(g, 25 + sw, 18, 4.5, 8, B);
        ell(g, 27 + sw, 10, 3, 3, B);
        ell(g, 9, 6 - (p.earUp < 0 ? 1 : 0), 2.5, 4, O);
        ell(g, 23, 6 - (p.earUp > 0 ? 1 : 0), 2.5, 4, O);
        ell(g, 16, 13, 11, 9.5, O);
        ell(g, 16, 24.5, 8, 5, O);
        ell(g, 8.5, 23.5, 2, 2.5, O); ell(g, 23.5, 23.5, 2, 2.5, O);
        ell(g, 11.5, 29, 2.5, 1.4, O); ell(g, 20.5, 29, 2.5, 1.4, O);
        outline(g);
        rect(g, 8, 4 - (p.earUp < 0 ? 1 : 0), 9, 6 - (p.earUp < 0 ? 1 : 0), P);
        rect(g, 22, 4 - (p.earUp > 0 ? 1 : 0), 23, 6 - (p.earUp > 0 ? 1 : 0), P);
        ell(g, 16, 25, 4.5, 3.5, c);
        ell(g, 16, 17.5, 5, 3, c);
        face(g, p, { ey: 9, my: 16, by: 15, bx: 6 });
        if ((p.mouth || 'smile') === 'smile') { set(g, 15, 18, W); set(g, 16, 18, W); }
      },
    },
    mouse: {
      name: 'Мышка', color: G,
      build(g, p) {
        const wag = [0, 1, 0, -1][p.t % 4];
        // хвост-верёвочка
        [[23, 27], [24, 28], [25, 28], [26, 28], [27, 27 + wag], [28, 26 + wag], [28, 25 + wag], [27, 24 + wag]]
          .forEach(([x, y]) => set(g, x, y, P));
        ell(g, 7, 7 - (p.earUp < 0 ? 1 : 0), 5, 5, G);
        ell(g, 25, 7 - (p.earUp > 0 ? 1 : 0), 5, 5, G);
        ell(g, 16, 14.5, 10.5, 8.5, G);
        ell(g, 16, 24.5, 7.5, 5, G);
        ell(g, 9, 23.5, 2, 2.5, G); ell(g, 23, 23.5, 2, 2.5, G);
        ell(g, 11.5, 29, 2.5, 1.4, G); ell(g, 20.5, 29, 2.5, 1.4, G);
        outline(g);
        ell(g, 7, 7 - (p.earUp < 0 ? 1 : 0), 3, 3, P);
        ell(g, 25, 7 - (p.earUp > 0 ? 1 : 0), 3, 3, P);
        ell(g, 16, 25, 4.5, 3.5, c);
        face(g, p, { ey: 11, my: 17, by: 17, bx: 7 });
        rect(g, 15, 16, 16, 16, P); // носик
        [[1, 16], [2, 16], [3, 16], [1, 19], [2, 18], [3, 18]].forEach(([x, y]) => { set(g, x, y, K); set(g, 31 - x, y, K); });
      },
    },
    bear: {
      name: 'Медведь-великан', color: B,
      build(g, p) {
        ell(g, 7.5, 6 - (p.earUp < 0 ? 1 : 0), 3.5, 3.5, B);
        ell(g, 24.5, 6 - (p.earUp > 0 ? 1 : 0), 3.5, 3.5, B);
        ell(g, 16, 13.5, 12, 10, B);
        ell(g, 16, 25, 9, 5, B);
        ell(g, 6.5, 24, 2.5, 3, B); ell(g, 25.5, 24, 2.5, 3, B);
        ell(g, 11, 29.2, 3, 1.4, B); ell(g, 21, 29.2, 3, 1.4, B);
        outline(g);
        ell(g, 7.5, 6 - (p.earUp < 0 ? 1 : 0), 2, 2, c);
        ell(g, 24.5, 6 - (p.earUp > 0 ? 1 : 0), 2, 2, c);
        ell(g, 16, 18, 5.5, 4, c);
        ell(g, 16, 26, 5, 3, c);
        face(g, p, { ey: 9, my: 18, by: 15, bx: 5 });
        stamp(g, 14, 15, ['KKKK', 'KWKK', '.KK.']); // нос
      },
    },
    robot: {
      name: 'Робот', color: G,
      build(g, p) {
        const wig = p.bob ? 1 : 0;
        rect(g, 15, 3, 16, 4, G);                     // антенна
        rect(g, 14 + wig, 1, 17 + wig, 2, p.t % 4 < 2 ? R : Y);
        rect(g, 5, 5, 26, 21, G);
        [[5, 5], [26, 5], [5, 21], [26, 21]].forEach(([x, y]) => set(g, x, y, 0));
        rect(g, 3, 11, 4, 14, G); rect(g, 27, 11, 28, 14, G); // болтики-уши
        if (p.earUp > 0) rect(g, 29, 10, 29, 15, G);
        rect(g, 9, 22, 22, 28, G);
        rect(g, 6, 23, 7, 26, G); rect(g, 24, 23, 25, 26, G);
        rect(g, 10, 29, 14, 30, G); rect(g, 17, 29, 21, 30, G);
        outline(g);
        rect(g, 7, 7, 24, 20, K);
        rect(g, 8, 8, 23, 19, S);
        face(g, p, { ey: 9, my: 15, by: 14, bx: 8 });
        set(g, 11, 24, p.t % 2 ? Y : M); set(g, 13, 24, p.t % 3 ? R : P);
        rect(g, 16, 24, 20, 26, c); rect(g, 17, 25, 17 + (p.t % 4), 25, M);
      },
    },
    alien: {
      name: 'Пришелец', color: M,
      build(g, p) {
        const bob = p.bob ? 1 : 0;
        [[11, 5], [10, 4], [10, 3]].forEach(([x, y]) => { set(g, x, y, M); set(g, 31 - x, y, M); });
        ell(g, 9.5 - bob, 2, 1.6, 1.6, Y);
        ell(g, 22.5 + bob, 2, 1.6, 1.6, Y);
        ell(g, 16, 13.5, 12.5, 9, M);
        ell(g, 16, 25, 6.5, 4.5, M);
        ell(g, 9.5, 24.5, 2, 2.5, M); ell(g, 22.5, 24.5, 2, 2.5, M);
        ell(g, 12.5, 29.2, 2.5, 1.4, M); ell(g, 19.5, 29.2, 2.5, 1.4, M);
        outline(g);
        set(g, 7, 8, c); set(g, 8, 7, c); set(g, 24, 8, c); set(g, 23, 7, c);
        face(g, p, { ey: 10, my: 17, by: 16, bx: 5, big: true });
        ell(g, 16, 25.5, 3.5, 2.5, c);
      },
    },
    monster: {
      name: 'Чудище', color: L,
      build(g, p) {
        stamp(g, 7, 2 - (p.earUp < 0 ? 1 : 0), ['..Y', '.YY', 'YYY']);
        stamp(g, 22, 2 - (p.earUp > 0 ? 1 : 0), ['Y..', 'YY.', 'YYY']);
        ell(g, 16, 14, 11.5, 9.5, L);
        [[9, 4], [14, 3], [17, 3], [22, 4]].forEach(([x, y]) => set(g, x, y, L)); // шёрстка
        ell(g, 16, 25, 8.5, 5, L);
        ell(g, 7.5, 23.5, 2.5, 3, L); ell(g, 24.5, 23.5, 2.5, 3, L);
        ell(g, 11, 29.2, 3, 1.4, L); ell(g, 21, 29.2, 3, 1.4, L);
        outline(g);
        set(g, 8, 9, P); set(g, 9, 8, P); set(g, 24, 10, P); set(g, 23, 20, P);
        ell(g, 16, 26, 5, 3, c);
        const my = face(g, p, { ey: 10, my: 16, by: 16, bx: 6 });
        if (p.mouth !== 'smile') { set(g, 14, my + 1, W); set(g, 17, my + 1, W); } // клычки
        set(g, 8, 30, W); set(g, 13, 30, W); set(g, 18, 30, W); set(g, 23, 30, W); // коготки
      },
    },
    parrot: {
      name: 'Попугай-эхо', color: S,
      build(g, p) {
        stamp(g, 13, 1 - (p.earUp ? 1 : 0) + 1, ['..RR..', '.RRRR.', 'RRRRR.', '.RRR..']);
        if (p.flap) { ell(g, 4.5, 17, 3, 4.5, S); ell(g, 27.5, 17, 3, 4.5, S); }
        else { ell(g, 6.5, 23.5, 2.5, 5, S); ell(g, 25.5, 23.5, 2.5, 5, S); }
        ell(g, 16, 13, 10.5, 9, S);
        ell(g, 16, 24.5, 8, 5, S);
        ell(g, 12, 29.2, 2.5, 1.4, O); ell(g, 20, 29.2, 2.5, 1.4, O);
        outline(g);
        if (p.flap) { rect(g, 3, 18, 5, 18, Y); rect(g, 26, 18, 28, 18, Y); }
        else { rect(g, 6, 25, 6, 27, Y); rect(g, 25, 25, 25, 27, Y); }
        ell(g, 16, 25.5, 5, 3.5, Y);
        face(g, p, { ey: 9, my: 15, by: 15, bx: 6, beak: true });
      },
    },
    cube: {
      name: 'Случайно', color: Y,
      build(g, p) {
        const t = p.earUp ? 1 : 0;
        rect(g, 5, 5 - t, 26, 26, Y);
        [[5, 5 - t], [6, 5 - t], [5, 6 - t], [26, 5 - t], [25, 5 - t], [26, 6 - t], [5, 26], [6, 26], [5, 25], [26, 26], [25, 26], [26, 25]]
          .forEach(([x, y]) => set(g, x, y, 0));
        rect(g, 9, 27, 12, 29, Y); rect(g, 19, 27, 22, 29, Y);
        outline(g);
        const pips = [P, S, M, L];
        const pc = (k) => pips[(p.t + k) % 4];
        rect(g, 8, 8, 9, 9, pc(0)); rect(g, 22, 8, 23, 9, pc(1));
        rect(g, 8, 22, 9, 23, pc(2)); rect(g, 22, 22, 23, 23, pc(3));
        face(g, p, { ey: 11, my: 18, by: 17, bx: 6 });
      },
    },
  };
  const ORDER = ['squirrel', 'mouse', 'bear', 'robot', 'alien', 'monster', 'parrot', 'cube'];

  function build(id, pose) {
    const p = Object.assign({ t: 0, eyes: 'normal', mouth: 'smile', earUp: 0, bob: 0, flap: 0, palm: false, finger: 0 }, pose || {});
    const ch = CHARS[id];
    const g = grid();
    ch.build(g, p);
    if (p.palm) stamp(g, 16 + (p.finger ? 1 : 0), ch.handY || 11, HAND, P); // «нос-ладошка»
    return g;
  }

  // рисует сетку в контекст: 1 пиксель спрайта = 1 пиксель canvas, tilt — пиксельный наклон
  function draw(ctx, g, ox, oy, tilt) {
    tilt = tilt || 0;
    for (let y = 0; y < g.h; y++) {
      const sx = tilt ? Math.round((16 - y) * tilt) : 0;
      let x = 0;
      while (x < g.w) {
        const col = g.d[y * g.w + x];
        if (!col) { x++; continue; }
        let x2 = x + 1;
        while (x2 < g.w && g.d[y * g.w + x2] === col) x2++;
        ctx.fillStyle = PALETTE[col];
        ctx.fillRect(ox + x + sx, oy + y, x2 - x, 1);
        x = x2;
      }
    }
  }

  const GLYPHS = {
    q:    ['.KKK.', 'K...K', '....K', '..KK.', '..K..', '.....', '..K..'],
    note: ['..K..', '..KK.', '..K.K', '..K..', 'KKK..', 'KKK..'],
  };
  function glyph(ctx, name, x, y, scale, col) {
    const rows = GLYPHS[name];
    ctx.fillStyle = PALETTE[col];
    for (let r = 0; r < rows.length; r++) for (let i = 0; i < rows[r].length; i++)
      if (rows[r][i] !== '.') ctx.fillRect(x + i * scale, y + r * scale, scale, scale);
  }

  const api = { PALETTE, COLORS: CH, CHARS, ORDER, build, draw, glyph, N };
  root.Sprites = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
