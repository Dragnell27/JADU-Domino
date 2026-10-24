// AudioManager: efectos y música del juego.
// Todo se sintetiza con Web Audio (sin archivos de audio).
// Modos: 'full' (música + efectos), 'sfx' (solo efectos), 'bgm' (solo música), 'off'. Más un mute general.
// Los navegadores móviles bloquean el audio hasta un gesto del usuario: se activa en la primera interacción.
(function (root) {
  const KEY = 'dominoAudio';
  const MODES = ['full', 'sfx', 'bgm', 'off'];
  const BGM_VOL = 0.16, SFX_VOL = 0.9;

  let ctx = null, master, sfxG, bgmG, noiseBuf;
  let mode = 'full', muted = false, unlocked = false;
  let bgmTimer = null, nextBar = 0, barIdx = 0;
  const listeners = [];

  // ---------- Preferencias ----------
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (MODES.includes(s.mode)) mode = s.mode;
    muted = !!s.muted;
  } catch (e) { /* sin localStorage: valores por defecto */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ mode, muted })); } catch (e) { /* ignorar */ } };
  const sfxOn = () => !muted && (mode === 'full' || mode === 'sfx');
  const bgmOn = () => !muted && (mode === 'full' || mode === 'bgm');
  const emit = () => listeners.forEach((f) => f({ mode, muted }));

  // ---------- Contexto ----------
  function ensureCtx() {
    if (ctx) return ctx;
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain(); master.connect(ctx.destination);
    sfxG = ctx.createGain(); sfxG.connect(master);
    bgmG = ctx.createGain(); bgmG.gain.value = 0; bgmG.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }

  function applyGains() {
    if (!ctx) return;
    const t = ctx.currentTime;
    sfxG.gain.setTargetAtTime(sfxOn() ? SFX_VOL : 0, t, 0.03);
    bgmG.gain.setTargetAtTime(bgmOn() ? BGM_VOL : 0, t, 0.25);
    if (bgmOn() && unlocked) startBgm(); else stopBgm();
  }

  function unlock() {
    if (unlocked) return;
    if (!ensureCtx()) return;
    ctx.resume().then(() => {
      unlocked = true;
      const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate); s.connect(ctx.destination); s.start(0);
      applyGains();
    }).catch(() => {});
  }
  ['pointerdown', 'touchend', 'keydown'].forEach((ev) => addEventListener(ev, unlock, { passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend(); else ctx.resume();
  });

  // ---------- Bloques de síntesis ----------
  function tone(t, freq, dur, { type = 'sine', vol = 0.2, attack = 0.005, to = null, dest = null } = {}) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || sfxG);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(t, dur, { filter = 'bandpass', freq = 2000, to = null, q = 1, vol = 0.3, attack = 0.002, dest = null } = {}) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = filter; f.Q.value = q; f.frequency.setValueAtTime(freq, t);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(dest || sfxG);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  }

  const SYNTH = {
    // Ficha de resina contra la mesa: golpe seco grave + chasquido agudo.
    place(t, v = 1) {
      tone(t, 170, 0.11, { to: 55, vol: 0.55 * v });
      noise(t, 0.06, { freq: 2300, q: 1.1, vol: 0.55 * v });
      noise(t + 0.012, 0.04, { freq: 1500, q: 1.5, vol: 0.25 * v });
    },
    // Deslizar una ficha por el paño.
    draw(t) {
      noise(t, 0.22, { freq: 700, to: 2600, q: 0.8, vol: 0.22, attack: 0.04 });
      noise(t + 0.2, 0.05, { freq: 2000, q: 1.3, vol: 0.18 });
    },
    // Pasar turno: dos golpecitos suaves descendentes.
    pass(t) { tone(t, 660, 0.12, { vol: 0.16 }); tone(t + 0.11, 495, 0.16, { vol: 0.14 }); },
    // Es tu turno: campanita sutil.
    turn(t) { tone(t, 784, 0.35, { vol: 0.12 }); tone(t + 0.09, 1175, 0.45, { vol: 0.09 }); },
    // Dominó / victoria: arpegio brillante y monedas.
    win(t) {
      [523, 659, 784, 1047, 1319].forEach((f, i) => tone(t + i * 0.09, f, 0.45, { type: 'triangle', vol: 0.2 }));
      [2093, 2637, 3136, 2349, 3520].forEach((f, i) => tone(t + 0.5 + i * 0.07, f, 0.18, { vol: 0.07 }));
    },
    // Tranca: golpe sordo + campana de cierre.
    blocked(t) {
      tone(t, 120, 0.4, { to: 45, vol: 0.6 });
      [[392, 0.24], [392 * 2.76, 0.12], [392 * 5.4, 0.06]].forEach(([f, v]) => tone(t + 0.05, f, 1.3, { vol: v }));
    },
    // Mensaje de chat: dos notas altas muy suaves.
    msg(t) { tone(t, 988, 0.14, { vol: 0.1 }); tone(t + 0.1, 1319, 0.2, { vol: 0.09 }); },
    // Cuenta atrás: tic corto y seco.
    tick(t) { tone(t, 1400, 0.06, { type: 'square', vol: 0.05 }); },
    pick(t) { noise(t, 0.05, { filter: 'highpass', freq: 3000, vol: 0.12 }); },
    error(t) { tone(t, 200, 0.18, { type: 'square', to: 120, vol: 0.07 }); },
    // Reparto: ráfaga de fichas.
    deal(t) { for (let i = 0; i < 6; i++) SYNTH.place(t + i * 0.075, 0.35); },
  };

  function play(name, delay = 0) {
    if (!sfxOn() || !unlocked || !ctx) return;
    const t = ctx.currentTime + delay;
    if (SYNTH[name]) SYNTH[name](t);
  }

  // ---------- Música de fondo procedural (lounge suave, en bucle) ----------
  // Cmaj9 - Am9 - Dm9 - G13, ~68 bpm: pad lento + bajo + notas sueltas de pentatónica.
  const BAR = 60 / 68 * 4;
  const CHORDS = [
    { root: 130.81, notes: [261.63, 329.63, 392.0, 493.88] },   // Cmaj7
    { root: 110.0, notes: [220.0, 261.63, 329.63, 392.0] },     // Am7
    { root: 146.83, notes: [293.66, 349.23, 440.0, 523.25] },   // Dm7
    { root: 98.0, notes: [196.0, 293.66, 349.23, 493.88] },     // G7
  ];
  const PENTA = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];

  function scheduleBar(t, idx) {
    const ch = CHORDS[idx % CHORDS.length];
    // Pad: voces suaves con ataque y liberación largos.
    ch.notes.forEach((f, i) => {
      [0, 1].forEach((d) => {
        const o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
        o.type = 'triangle'; o.frequency.value = f; o.detune.value = d ? 6 : -6;
        lp.type = 'lowpass'; lp.frequency.value = 900;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.05 - i * 0.004, t + 1.2);
        g.gain.linearRampToValueAtTime(0.04, t + BAR - 0.6);
        g.gain.linearRampToValueAtTime(0.0001, t + BAR + 0.8);
        o.connect(lp); lp.connect(g); g.connect(bgmG);
        o.start(t); o.stop(t + BAR + 1);
      });
    });
    // Bajo: dos notas por compás.
    [0, 2].forEach((beat) => tone(t + beat * (BAR / 4), ch.root, BAR / 2.2, { vol: 0.16, attack: 0.04, dest: bgmG }));
    // Notas sueltas tipo piano eléctrico.
    for (let i = 0; i < 4; i++) {
      if (Math.random() < 0.55) {
        const f = PENTA[Math.floor(Math.random() * PENTA.length)];
        tone(t + (i + (Math.random() < 0.3 ? 0.5 : 0)) * (BAR / 4), f, 1.1, { vol: 0.05, attack: 0.01, dest: bgmG });
      }
    }
  }
  function startBgm() {
    if (bgmTimer || !ctx) return;
    nextBar = ctx.currentTime + 0.2;
    const tick = () => {
      while (nextBar < ctx.currentTime + 2) { scheduleBar(nextBar, barIdx++); nextBar += BAR; }
    };
    tick(); bgmTimer = setInterval(tick, 500);
  }
  function stopBgm() { if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; } }

  // ---------- API ----------
  const api = {
    play,
    get state() { return { mode, muted }; },
    setMode(m) { if (!MODES.includes(m)) return; mode = m; muted = false; save(); applyGains(); emit(); },
    toggleMute() {
      // Con el modo en 'off', pulsar el altavoz reactiva el audio completo.
      if (mode === 'off') { mode = 'full'; muted = false; } else muted = !muted;
      save(); applyGains(); emit();
    },
    onChange(f) { listeners.push(f); f({ mode, muted }); },
    unlock,
  };
  root.AudioManager = api;
})(window);
