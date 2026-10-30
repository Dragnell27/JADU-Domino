// Websocket directo (sin sondeo HTTP previo) y reconexión con espera creciente de hasta 5 s.
const socket = io({ transports: ['websocket', 'polling'], reconnectionDelay: 500, reconnectionDelayMax: 5000, timeout: 10000 });

// Pantalla de carga: se oculta al conectar con el servidor (o a los 8 s, con aviso si no hay conexión).
(function splash() {
  const sp = document.getElementById('splash'), msg = document.getElementById('splashMsg');
  const hide = () => { sp.classList.add('done'); setTimeout(() => sp.remove(), 500); };
  socket.once('connect', hide);
  setTimeout(() => { if (!sp.isConnected) return; msg.textContent = navigator.onLine ? 'Tardando más de lo normal… reintentando' : 'Sin conexión a internet'; }, 4000);
  setTimeout(hide, 8000);
})();

// Service Worker (solo con HTTPS o localhost): caché de recursos estáticos y soporte offline básico.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

const $ = (id) => document.getElementById(id);
const show = (id) => {
  ['login', 'lobby', 'waiting', 'table'].forEach((s) => ($(s).hidden = s !== id));
  document.body.classList.toggle('in-table', id === 'table');
  // "Salir" solo existe una vez completado el registro (lobby, sala de espera o mesa); en el acceso está oculto
  document.body.classList.toggle('registered', id !== 'login');
  syncOrientation();
};

// ---------- Orientación (móvil en vertical -> sugerir horizontal) ----------
const portraitMQ = matchMedia('(max-width: 768px) and (orientation: portrait)');
let rotateDismissed = false;
try { rotateDismissed = sessionStorage.getItem('rotateOk') === '1'; } catch (e) { /* modo privado */ }

function syncOrientation() {
  document.body.classList.toggle('portrait-mobile', portraitMQ.matches);
  $('rotate').hidden = !(portraitMQ.matches && !rotateDismissed && !$('table').hidden);
}
portraitMQ.addEventListener('change', syncOrientation);
$('rotateOk').onclick = () => {
  rotateDismissed = true;
  try { sessionStorage.setItem('rotateOk', '1'); } catch (e) { /* ignorar */ }
  syncOrientation();
};
// Pantalla completa + bloqueo horizontal: solo funciona en algunos navegadores (Android Chrome).
$('rotateFs').onclick = async () => {
  try {
    await document.documentElement.requestFullscreen();
    await screen.orientation.lock('landscape');
  } catch (e) { toast('Gira el teléfono manualmente'); }
};
// Al girar o cambiar de tamaño, reajusta la mano (el paño ya se reajusta con su ResizeObserver).
let resizeT;
addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (room && room.game && !$('table').hidden && !dragging) renderHand(false); }, 120);
});

// Identidad estable de este navegador: permite recuperar el asiento si se cierra la pestaña o se cae la conexión.
const myToken = (() => {
  try {
    let t = localStorage.getItem('dominoToken');
    if (!t) { t = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)); localStorage.setItem('dominoToken', t); }
    return t;
  } catch (e) { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
})();
let room = null, lastReg = null; // lastReg: nombre/avatar para re-registrarse tras una reconexión
let prevRound = -1;
let selected = null; // ficha elegida por clic: [a, b]
let dragging = false;
let review = false;       // visor de tablero final activo
let handOrder = null;    // orden local de la mano (reordenada por el jugador, nunca se envía al servidor)
let badDismissed = -1;   // ronda en la que se cerró el aviso de mano mala
let prevHandKeys = null; // fichas de la mano en el render anterior (para resaltar la robada)
const tileKey = (t) => t.join('-');
const sameTile = (a, b) => a && b && ((a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]));

function toast(msg, kind, ms) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  t.className = kind || '';
  clearTimeout(toast.h);
  toast.h = setTimeout(() => (t.hidden = true), ms || (kind === 'info' ? 4000 : 2500));
}

// ---------- Fichas (DOM) ----------
// Cada valor es la lista de áreas de la cuadrícula 3x3 (tl . tr / ml c mr / bl . br) que llevan punto.
const PIPS = [[], ['c'], ['tl', 'br'], ['tl', 'c', 'br'], ['tl', 'tr', 'bl', 'br'], ['tl', 'tr', 'c', 'bl', 'br'], ['tl', 'tr', 'ml', 'mr', 'bl', 'br']];
function half(n) {
  const h = document.createElement('div');
  h.className = 'tile-half';
  PIPS[n].forEach((area) => {
    const p = document.createElement('i');
    p.className = 'pip ' + area;
    h.appendChild(p);
  });
  return h;
}
// first/second en orden de pantalla; horizontal = eje largo horizontal. s: px (número) o expresión CSS.
function tileEl(first, second, s, horizontal) {
  const el = document.createElement('div');
  el.className = 'domino-tile ' + (horizontal ? 'h' : 'v');
  el.style.setProperty('--s', typeof s === 'number' ? s + 'px' : s);
  el.dataset.sig = `${first}${second}${horizontal}`;
  el.append(half(first), half(second));
  return el;
}

// ---------- Panel de audio (HUD) ----------
{
  const mute = $('muteBtn'), menuBtn = $('audioMenuBtn'), menu = $('audioMenu');
  AudioManager.onChange(({ mode, muted }) => {
    const silent = muted || mode === 'off';
    setIcon(mute.querySelector('.ico'), silent ? 'speakerOff' : 'speaker');
    mute.setAttribute('aria-pressed', String(silent));
    menu.querySelectorAll('[data-mode]').forEach((b) => {
      const on = b.dataset.mode === mode && !muted;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', String(on));
    });
  });
  mute.onclick = () => AudioManager.toggleMute();
  menuBtn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  menu.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => {
    AudioManager.setMode(b.dataset.mode);
    AudioManager.play('place'); // vista previa
    menu.hidden = true;
  }));
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
}

// ---------- Login / lobby ----------
// Selector de avatar: 10 opciones; sin elegir, se asigna uno al azar al entrar.
let chosenAvatar = null;
const grid = $('avatarGrid');
DominoAvatars.AVATARS.forEach((a) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'av-opt';
  b.dataset.id = a.id;
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-checked', 'false');
  b.setAttribute('aria-label', a.name);
  b.title = a.name;
  b.innerHTML = `<span class="av-emoji">${a.emoji}</span><small>${a.name}</small>`;
  b.onclick = () => {
    chosenAvatar = a.id;
    grid.querySelectorAll('.av-opt').forEach((o) => {
      const on = o === b;
      o.classList.toggle('selected', on);
      o.setAttribute('aria-checked', String(on));
    });
    $('avatarHint').textContent = `Elegiste: ${a.name}`;
  };
  grid.appendChild(b);
});
// Perfil recordado en este navegador: al volver a entrar se autocompletan el nombre y el avatar.
const PROFILE_KEY = 'dominoProfile';
const loadProfile = () => { try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || {}; } catch (e) { return {}; } };
const saveProfile = (p) => { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) { /* sin almacenamiento: no se recuerda */ } };
(function restoreProfile() {
  const p = loadProfile();
  if (typeof p.name === 'string') $('nameInput').value = p.name.slice(0, 20);
  const opt = p.avatar && grid.querySelector(`.av-opt[data-id="${p.avatar}"]`);
  if (opt) opt.click();
})();
$('nameForm').onsubmit = (e) => {
  e.preventDefault();
  lastReg = { name: $('nameInput').value, avatar: chosenAvatar || DominoAvatars.random(), token: myToken };
  saveProfile({ name: lastReg.name.trim().slice(0, 20), avatar: lastReg.avatar });
  socket.emit('setName', lastReg);
};
socket.on('named', (n) => { $('who').textContent = n; show('lobby'); });

const radio = (name) => document.querySelector(`input[name=${name}]:checked`).value;
function syncModes() {
  const four = radio('players') === '4';
  $('modes').classList.toggle('off', !four);
  $('modeHint').hidden = four;
  document.querySelectorAll('input[name=mode]').forEach((i) => (i.disabled = !four));
  if (!four) document.querySelector('input[name=mode][value=individual]').checked = true;
}
document.querySelectorAll('input[name=players]').forEach((i) => (i.onchange = syncModes));
syncModes();
const syncTarget = () => {
  const t = $('cfgTarget');
  $('targetVal').textContent = t.value;
  t.style.setProperty('--fill', ((t.value - t.min) / (t.max - t.min)) * 100 + '%');
};
$('cfgTarget').oninput = syncTarget; syncTarget();
$('createForm').onsubmit = (e) => {
  e.preventDefault();
  socket.emit('createRoom', { players: radio('players'), mode: radio('mode'), target: $('cfgTarget').value, visibility: radio('vis') });
};

// Lista de mesas: públicas entran directo; las privadas (🔒) piden el código en la propia fila
socket.on('rooms', (list) => {
  const ul = $('roomList');
  ul.innerHTML = list.length ? '' : '<li class="muted">No hay mesas todavía: crea una</li>';
  list.forEach((r) => {
    const li = document.createElement('li');
    const mode = r.players === 4 ? (r.mode === 'teams' ? ' · parejas' : ' · individual') : '';
    const info = document.createElement('span');
    info.className = 'li-info';
    info.textContent = `${r.private ? '🔒' : '🌐'} #${r.num} de ${r.host} — ${r.seated}/${r.players}${mode} · ${r.target} pts${r.inGame ? ' · en juego' : ''}${r.spectators ? ' · 👁 ' + r.spectators : ''}`;
    const join = document.createElement('button');
    join.textContent = 'Unirse';
    join.disabled = r.inGame || r.seated >= r.players;
    const obs = document.createElement('button');
    obs.textContent = '👁 Observar';
    obs.className = 'obs-btn';
    obs.title = 'Mirar la partida sin jugar (puedes chatear y hablar)';
    const box = document.createElement('span');
    box.className = 'li-actions';
    box.append(join, obs);
    li.append(info, box);
    ul.appendChild(li);

    const go = (event, code) => socket.emit(event, { num: r.num, code });
    if (!r.private) { join.onclick = () => go('joinRoom'); obs.onclick = () => go('spectateRoom'); return; }
    // Privada: se despliega un campo para el código y luego se envía la acción elegida
    let row = null;
    const ask = (event) => {
      if (row) { row.remove(); row = null; return; }
      row = document.createElement('form');
      row.className = 'code-row';
      row.innerHTML = '<input maxlength="8" placeholder="Código de la mesa" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Código de la mesa"><button class="btn-wood gold">Entrar</button>';
      const inp = row.querySelector('input');
      inp.oninput = () => { inp.value = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); };
      row.onsubmit = (e) => { e.preventDefault(); if (!inp.value) return toast('Escribe el código de la mesa'); go(event, inp.value); };
      li.appendChild(row);
      inp.focus();
    };
    join.onclick = () => ask('joinRoom');
    obs.onclick = () => ask('spectateRoom');
  });
});

// Entrar por código (sirve para mesas públicas y privadas)
const codeVal = () => $('codeInput').value.trim().toUpperCase();
$('codeInput').oninput = () => { $('codeInput').value = $('codeInput').value.toUpperCase().replace(/[^A-Z0-9]/g, ''); };
$('codeForm').onsubmit = (e) => { e.preventDefault(); if (!codeVal()) return toast('Escribe el código de la mesa'); socket.emit('joinRoom', { id: codeVal() }); };
$('codeSpectate').onclick = () => { if (!codeVal()) return toast('Escribe el código de la mesa'); socket.emit('spectateRoom', { id: codeVal() }); };

socket.on('notice', toast);
$('leaveWait').onclick = () => socket.emit('leaveRoom');
// Salir del HUD: dentro de una mesa la abandona; en el lobby (sin mesa) vuelve a la pantalla de registro
// Salida de rescate: no espera al servidor. Aunque la mesa esté huérfana o la conexión falle, limpia el estado local y vuelve al lobby.
function resetToLobby() {
  room = null; prevRound = -1; lastSnap = null; review = false; prevHandKeys = null; handOrder = null; handPage = 0; selected = null;
  turnTimer = null; startTimerLoop();
  ['pozoModal', 'badhand'].forEach((id) => { const e = $(id); if (e) e.hidden = true; });
  document.body.classList.remove('in-room');
  show('lobby');
}
$('leaveGame').onclick = () => {
  if (room) { socket.emit('leaveRoom'); resetToLobby(); } else show('login');
};
// Si la conexión se cae y vuelve, el servidor ya no nos tiene en ninguna mesa: no dejar el tablero viejo congelado.
let wasConnected = false;
socket.on('connect', () => {
  if (wasConnected) {
    if (room) { resetToLobby(); toast('Se perdió la conexión: volviste al lobby', 'info'); }
    if (lastReg) socket.emit('setName', lastReg); // el servidor olvidó nuestro nombre al caer la conexión
  }
  wasConnected = true;
});
$('startBtn').onclick = () => socket.emit('startGame');

// ---------- Sala ----------
// Oferta de volver a una partida en curso que dejé (mismo navegador).
socket.on('resume', () => { $('resume').hidden = false; });
$('resumeYes').onclick = () => { $('resume').hidden = true; socket.emit('rejoin'); };
$('resumeNo').onclick = () => { $('resume').hidden = true; socket.emit('forfeit'); };

socket.on('room', (r) => {
  room = r;
  if (r) $('resume').hidden = true;
  if (r && r.game && r.game.timer) r.game.timer.offset = r.game.timer.now - Date.now();
  if (!r) { prevRound = -1; lastSnap = null; review = false; prevHandKeys = null; handOrder = null; return show('lobby'); }
  if (!r.game) return renderWaiting();
  if (dragging) return; // no reconstruir la mano a mitad de un arrastre
  renderTable();
});

// Observadores: etiqueta propia ("Modo observador") y contador con la lista; los nombres llevan data-pid para el indicador de voz.
function renderSpectators() {
  const bar = $('specBar'), specs = room.specs || [];
  bar.hidden = !room.spectator && !specs.length;
  if (bar.hidden) return;
  bar.innerHTML = `<span>👁 ${room.spectator ? 'Modo observador' : specs.length === 1 ? '1 observador' : specs.length + ' observadores'}</span>`;
  bar.title = specs.map((s) => s.name).join(', ');
  bar.onclick = () => toast('👁 Observando: ' + (specs.map((s) => s.name).join(', ') || '—'), 'info');
}

function renderWaiting() {
  show('waiting');
  const cfg = room.config, n = cfg.players, seated = room.seats.length;
  $('wId').textContent = room.id;
  const chips = [room.private ? '🔒 Privada' : '🌐 Pública', `${n} jugadores`, `Objetivo ${cfg.target} pts`];
  if (n === 4) chips.push(cfg.mode === 'teams' ? 'Parejas' : 'Individual');
  $('wInfo').innerHTML = chips.map((t) => `<span class="chip">${t}</span>`).join('');

  const grid = $('wSeats');
  grid.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const name = room.seats[i];
    const slot = document.createElement('div');
    slot.className = 'seat-slot ' + (name ? 'taken' : 'empty');
    if (name) slot.dataset.pid = (room.pids || [])[i] || '';
    const team = cfg.mode === 'teams' ? `<span class="team t${i % 2}">Equipo ${i % 2 + 1}</span>` : '';
    slot.innerHTML = name
      ? `<div class="avatar big">${avatarOf(i)}</div>
         <div class="s-name">${esc(name)}${voiceIcon(i)}${i === 0 ? ' <span title="Anfitrión">👑</span>' : ''}${i === room.me ? ' <small>(tú)</small>' : ''}</div>
         ${team}<span class="ready">✔ Listo</span>`
      : `<div class="avatar big ghost">🪑</div><div class="s-name wait">Esperando jugador…</div>${team}`;
    grid.appendChild(slot);
  }

  const missing = n - seated;
  $('wHint').textContent = room.spectator ? '👁 Estás observando: verás la partida cuando inicie'
    : missing ? `Faltan ${missing} ${missing === 1 ? 'jugador' : 'jugadores'}`
    : room.isHost ? '¡Mesa completa! Puedes iniciar la partida.' : 'Esperando a que el anfitrión inicie…';
  renderSpectators();
  $('startBtn').hidden = !room.isHost;
  $('startBtn').disabled = missing > 0;
}

// ---------- Mesa ----------
const teams = () => room.config.mode === 'teams';
const label = (u) => (teams() ? `Equipo ${u + 1}` : room.seats[u]);
const sidesOf = (t) => room.game.moves.filter((m) => sameTile(m.tile, t)).map((m) => m.side);
const myTurn = () => room.game.status === 'playing' && room.game.turn === room.me;

// ---------- Temporizador de turno (solo dibuja; el servidor decide cuándo se acaba) ----------
let turnTimer = null, statusBase = '', timerRaf = 0, lastSec = -1;
const TIMER_COLORS = { ok: '#8fe37a', warn: '#f2c14e', danger: '#ff5a4a' };

function startTimerLoop() {
  cancelAnimationFrame(timerRaf);
  if (turnTimer && room && room.game && room.game.status === 'playing') tickTimer(); // pinta ya, sin esperar al siguiente frame
  else clearTimerUI();
}
function clearTimerUI() {
  $('hand').classList.remove('urgent'); $('board').classList.remove('urgent');
  lastSec = -1;
}
function tickTimer() {
  if (!turnTimer || !room || !room.game || room.game.status !== 'playing' || $('table').hidden) return clearTimerUI();
  const left = Math.max(0, turnTimer.endsAt - (Date.now() + turnTimer.offset));
  const sec = Math.ceil(left / 1000);
  // Verde > 10 s, amarillo 5-10 s, rojo en los últimos 5 s
  const color = left <= 5000 ? TIMER_COLORS.danger : left <= 10000 ? TIMER_COLORS.warn : TIMER_COLORS.ok;
  document.querySelectorAll('.seatcard.turn').forEach((el) => {
    el.style.setProperty('--p', (left / turnTimer.total).toFixed(4));
    el.style.setProperty('--tc', color);
    const s = el.querySelector('.tsec');
    if (s) s.textContent = sec;
  });
  const urgent = left <= 5000 && left > 0;
  $('hand').classList.toggle('urgent', urgent && myTurn());
  $('board').classList.toggle('urgent', urgent && myTurn());
  $('status').textContent = `${statusBase} · ${sec} s`;
  $('pozoSec').textContent = `${sec} s`;
  if (sec !== lastSec) { // un tic por segundo cuando es mi turno y quedan 5 s o menos
    lastSec = sec;
    if (myTurn() && sec <= 5 && sec > 0) AudioManager.play('tick');
  }
  if (left > 0) timerRaf = requestAnimationFrame(tickTimer);
}

// El servidor jugó por alguien que se quedó sin tiempo.
socket.on('timeout', ({ name, events, reason }) => {
  closePozoModal(); // tiempo agotado / juego automático: el servidor ya robó y jugó por el jugador
  const played = events.find((x) => x.type === 'play');
  const drawn = events.filter((x) => x.type === 'draw').length;
  let what;
  if (played) what = `jugó ${played.tile[0]}|${played.tile[1]} (su ficha de menos puntos)`;
  else if (events.some((x) => x.type === 'pass')) what = 'pasó el turno';
  else what = 'cedió el turno';
  if (drawn) what = `robó ${drawn} y ${what}`;
  if (reason === 'auto') return; // modo automático continuo: no se avisa en cada jugada
  toast(`⏱ ${name} se quedó sin tiempo y ${what}`, 'info');
});

// Compara con el estado anterior y dispara los sonidos: ficha puesta, robo, pase, tu turno, fin de ronda.
let lastSnap = null;
function soundsFor(g) {
  const snap = { round: room.round, board: g.board.length, pozo: g.boneyard, turn: g.turn, status: g.status, over: !!room.over };
  const p = lastSnap; lastSnap = snap;
  if (!p || p.round !== snap.round) { AudioManager.play('deal'); return; }
  const placed = snap.board > p.board;
  if (placed) AudioManager.play('place');
  else if (snap.pozo < p.pozo) AudioManager.play('draw');
  else if (snap.turn !== p.turn && snap.status === 'playing') AudioManager.play('pass');
  if (snap.status === 'ended' && p.status !== 'ended') AudioManager.play(g.result.reason === 'domino' ? 'win' : g.result.reason === 'redeal' ? 'error' : 'blocked', placed ? 0.25 : 0);
  if (snap.over && !p.over) AudioManager.play('win', g.result.reason === 'blocked' ? 2.2 : 1.4);
  if (snap.status === 'playing' && snap.turn !== p.turn && snap.turn === room.me) AudioManager.play('turn', placed ? 0.2 : 0);
}

function renderTable() {
  show('table');
  const g = room.game, me = room.me;
  const newRound = room.round !== prevRound;
  prevRound = room.round;
  soundsFor(g);
  if (newRound) { review = false; prevHandKeys = null; handOrder = null; }
  if (newRound || !g.moves.some((m) => sameTile(m.tile, selected))) selected = null;

  const st = $('status');
  st.textContent = g.status === 'ended' ? 'Ronda terminada' : myTurn() ? (g.bonus ? '¡Juega otro doble!' : g.holding ? 'Cediendo el turno…' : '¡Tu turno!') : `Turno de ${room.seats[g.turn]}`;
  st.classList.toggle('mine', myTurn());
  statusBase = st.textContent;
  // Reloj del servidor: la diferencia entre su hora y la nuestra evita desfases entre clientes.
  // El desfase reloj servidor/cliente se fijó al RECIBIR la sala: recalcularlo aquí (p. ej. tras soltar una ficha) adelantaría o reiniciaría la cuenta.
  turnTimer = g.timer ? { endsAt: g.timer.endsAt, offset: g.timer.offset, total: g.timer.total } : null;
  startTimerLoop();

  renderSeats(newRound);
  renderSpectators();
  renderHand(newRound);
  renderPozo();
  renderBadHand();
  renderBoard();

  $('hand').classList.toggle('myturn', myTurn());
  $('board').classList.toggle('myturn', myTurn());

  const act = $('actions'); act.innerHTML = '';
  if (g.status === 'ended' && review) {
    // Visor de tablero final: la mesa queda congelada hasta que el anfitrión continúe
    const back = el('button', 'btn-wood', 'Ver resumen');
    back.onclick = () => { review = false; renderTable(); };
    act.append(back);
    if (room.isHost) {
      const next = el('button', 'btn-wood gold', room.over ? 'Jugar otra partida' : 'Siguiente ronda');
      next.onclick = () => socket.emit(room.over ? 'rematch' : 'nextRound');
      act.append(next);
    } else act.append(el('span', 'muted', 'Esperando al anfitrión…'));
  } else if (myTurn() && !g.holding) {
    if (g.bonus) {
      const b = el('button', 'btn-wood', 'No jugar otro doble');
      b.onclick = () => socket.emit('endTurn');
      act.append(b);
    } else if (!g.moves.length && !g.boneyard) {
      const b = el('button', 'btn-wood gold', 'Pasar');
      b.onclick = () => socket.emit('pass');
      act.append(b);
    }
    // El robo se hace desde el pozo flotante (arrastrar o clic)
  }
  if (!room.spectator && (g.status === 'playing' || (room.auto || [])[room.me])) {
    // Interruptor del modo automático: persiste hasta que se vuelva a pulsar
    const on = !!(room.auto || [])[room.me];
    const auto = el('button', 'btn-wood auto' + (on ? ' on' : ''), `🤖 Auto: ${on ? 'ON' : 'OFF'}`);
    auto.setAttribute('aria-pressed', String(on));
    auto.title = on ? 'Modo automático activo: pulsa para volver a jugar tú' : 'Activar modo automático: se juega tu ficha de menos puntos en cada turno';
    auto.onclick = () => socket.emit('auto');
    act.append(auto);
  }
  if (g.badHand && g.status === 'playing' && badDismissed === room.round) {
    const chip = el('button', 'btn-wood', '🔄 Mano mala: reiniciar');
    chip.onclick = () => socket.emit('redeal');
    act.append(chip);
  }

  renderResult();
}

// ---------- Paneles de jugadores ----------
// Avatar (emoji) del asiento: viene del servidor; si falta, uno fijo por posición.
const avatarOf = (seat) => (DominoAvatars.byId((room.avatars || [])[seat]) || DominoAvatars.AVATARS[seat % 10]).emoji;
const esc = (s) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
// Posición en pantalla según el orden de turno (horario): yo abajo -> izquierda -> arriba -> derecha.
const POSITIONS = { 2: ['top'], 3: ['left', 'right'], 4: ['left', 'top', 'right'] };

// Estado de voz de un asiento: 🎙️ hablando disponible / 🔇 silenciado (según lo que anuncia el servidor).
const voiceIcon = (seat) => {
  const v = (room.voice || [])[seat];
  return v ? `<span class="vstate ${v.muted ? 'muted' : 'live'}" title="${v.muted ? 'Micrófono silenciado' : 'En el chat de voz'}">${v.muted ? '🔇' : '🎙️'}</span>` : '';
};
function seatCard(seat, deal, el, vertical) {
  const g = room.game, me = room.me;
  const partner = teams() && seat !== me && seat % 2 === me % 2;
  const score = room.scores[teams() ? seat % 2 : seat];
  el.classList.add('seatcard');
  el.dataset.pid = (room.pids || [])[seat] || '';
  el.classList.toggle('turn', g.turn === seat && g.status === 'playing');
  el.classList.toggle('automode', !!(room.auto || [])[seat]);
  const active = g.turn === seat && g.status === 'playing';
  el.innerHTML = `<div class="avatar">${avatarOf(seat)}${(room.auto || [])[seat] ? '<span class="robot" title="Modo automático">🤖</span>' : ''}${active ? '<span class="tsec"></span>' : ''}</div>
    <div class="info"><div class="name">${esc(room.seats[seat])}${(room.away || [])[seat] ? ' <small title="Desconectado: juega en automático">🔌</small>' : ''}${partner ? ' <small>(pareja)</small>' : ''}</div>
    <div class="pts">${teams() ? 'Equipo ' + (seat % 2 + 1) + ': ' : ''}<b>${score}</b> / ${room.config.target} pts</div></div>
    ${voiceIcon(seat)}
    ${seat === me ? '<button class="mic-btn" type="button" data-state="off" title="Micrófono">🎤</button>' : `<span class="cnt" title="Fichas en mano">🁢 ${g.counts[seat]}</span>`}`;
  if (seat === me) return;
  if (g.status === 'ended' && review && g.result) { // visor final: se ven las fichas que les quedaron
    const rv = document.createElement('div');
    rv.className = 'reveal';
    rv.append(miniHand(g.result.hands[seat]));
    el.appendChild(rv);
    return;
  }
  const backs = document.createElement('div');
  backs.className = 'backs' + (vertical ? ' col' : '');
  for (let i = 0; i < g.counts[seat]; i++) {
    const b = document.createElement('i');
    b.className = 'back' + (deal ? ' deal' : '');
    if (deal) b.style.animationDelay = `${(i * room.seats.length + seat) * 40}ms`;
    backs.appendChild(b);
  }
  el.appendChild(backs);
}

function renderSeats(deal) {
  const n = room.seats.length, me = room.me >= 0 ? room.me : 0; // el observador mira desde el asiento 0
  ['top', 'left', 'right'].forEach((p) => ($('seat-' + p).hidden = true));
  POSITIONS[n].forEach((pos, i) => {
    const el = $('seat-' + pos);
    el.hidden = false;
    seatCard((me + 1 + i) % n, deal, el, pos !== 'top');
  });
  seatCard(me, false, $('meCard'), false);
}

// ---------- Mano + arrastrar y soltar ----------
const handLandscape = matchMedia('(orientation: landscape) and (max-height: 520px)');
handLandscape.addEventListener('change', () => { if (room && room.game && !$('table').hidden && !dragging) renderHand(false); });

// Orden local de la mano: las fichas conservan el orden que eligió el jugador; las nuevas van al final.
function orderedHand(hand) {
  const idx = new Map((handOrder || []).map((k, i) => [k, i]));
  const pos = (t) => (idx.has(tileKey(t)) ? idx.get(tileKey(t)) : 1e6);
  const sorted = hand.slice().sort((a, b) => pos(a) - pos(b));
  handOrder = sorted.map(tileKey);
  return sorted;
}

// Paginado de la mano: máximo 9 fichas por página; los botones solo existen si hay más de 9.
const HAND_PAGE = 9;
let handPage = 0;
function renderHand(deal) {
  const g = room.game, hand = $('hand');
  // El tamaño base (7 fichas) lo da el clamp() de --hs en CSS; con 8 o 9 fichas, o con la página llena, se reduce para que quepan.
  const root = document.documentElement.style;
  const n = g.hand.length, paged = n > HAND_PAGE, shown = Math.min(n, HAND_PAGE);
  if (shown > 7) root.setProperty('--hs', Math.max(24, Math.min(56, Math.floor((innerWidth - 56 - (paged ? 60 : 0)) / shown) - 10, Math.floor(innerHeight * 0.1))) + 'px');
  else root.removeProperty('--hs');
  const keys = g.hand.map(tileKey);
  const fresh = !deal && prevHandKeys ? keys.filter((k) => !prevHandKeys.has(k)) : [];
  prevHandKeys = new Set(keys);
  const sorted = orderedHand(g.hand);
  const pages = Math.max(1, Math.ceil(n / HAND_PAGE));
  if (deal) handPage = 0;
  const firstFresh = sorted.findIndex((t) => fresh.includes(tileKey(t)));
  if (firstFresh >= 0) handPage = Math.floor(firstFresh / HAND_PAGE); // la ficha robada se muestra en su página
  handPage = Math.min(Math.max(handPage, 0), pages - 1);
  hand.innerHTML = '';
  sorted.slice(handPage * HAND_PAGE, handPage * HAND_PAGE + HAND_PAGE).forEach((t, i) => {
    const sides = sidesOf(t);
    const el = tileEl(t[0], t[1], 'var(--hs)', false); // la mano siempre va de pie (vertical)
    el.classList.add('mine');
    el.dataset.key = tileKey(t);
    if (sides.length) el.classList.add('playable');
    if (sameTile(selected, t)) el.classList.add('selected');
    if (deal) { el.classList.add('deal'); el.style.animationDelay = `${i * 70}ms`; }
    if (fresh.includes(tileKey(t))) el.classList.add('drawn'); // revelada al entrar en la mano
    el.onpointerdown = (ev) => startDrag(ev, el, t, sides.length > 0); // siempre se puede arrastrar para reordenar
    hand.appendChild(el);
  });
  renderPager(pages);
  // Si aun así no caben, la mano se desliza con el dedo.
  hand.classList.toggle('scroll', hand.scrollWidth > hand.clientWidth + 1);
}
function renderPager(pages) {
  const show = pages > 1;
  ['handPrev', 'handNext', 'handPageInfo'].forEach((id) => { $(id).hidden = !show; });
  if (!show) return;
  // Las flechas miden exactamente lo mismo que una ficha y se alinean con su base
  const wrap = $('handWrap'), hand = $('hand'), tile = hand.firstElementChild, cs = getComputedStyle(hand);
  if (tile) {
    wrap.style.setProperty('--nav-h', tile.offsetHeight + 'px');
    wrap.style.setProperty('--nav-mb', (parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth)) + 'px');
  }
  $('handPageInfo').textContent = `${handPage + 1}/${pages}`;
  $('handPrev').disabled = handPage === 0;
  $('handNext').disabled = handPage === pages - 1;
}
function gotoHandPage(d) {
  handPage += d;
  AudioManager.play('pick');
  if (room && room.game) renderHand(false);
}
$('handPrev').onclick = () => gotoHandPage(-1);
$('handNext').onclick = () => gotoHandPage(1);

// ---------- Mano mala (4+ dobles) ----------
$('badRestart').onclick = () => socket.emit('redeal');
$('badKeep').onclick = () => { badDismissed = room.round; renderBadHand(); renderTable(); };
function renderBadHand() {
  const g = room.game;
  const show = g.badHand && g.status === 'playing' && badDismissed !== room.round;
  $('badhand').hidden = !show;
  if (show) $('badText').textContent = `Tienes ${g.hand.filter((t) => t[0] === t[1]).length} dobles en tu mano inicial.`;
}
socket.on('skipped', ({ names }) => {
  toast(`⏭ ${names.join(' y ')} ${names.length > 1 ? 'no tienen' : 'no tiene'} jugada y el pozo está vacío: turno saltado`, 'info');
  AudioManager.play('pass');
});

// ---------- Pozo flotante ----------
// El cliente solo conoce cuántas fichas quedan; cuál sale lo decide el servidor al robar.
function canDraw() {
  const g = room && room.game;
  return !!g && g.status === 'playing' && myTurn() && !g.moves.length && !g.bonus && !g.holding && g.boneyard > 0;
}
function renderPozo() {
  const g = room.game, pz = $('pozo');
  pz.hidden = !(g.boneyard > 0 && g.status === 'playing');
  if (pz.hidden) { renderPozoModal(false); return; } // pozo vacío: el modal se cierra siempre
  const can = canDraw();
  $('pozoCount').textContent = g.boneyard;
  pz.classList.toggle('active', can);
  pz.setAttribute('aria-disabled', String(!can));
  pz.title = can ? 'Arrastra una ficha a tu mano o haz clic para robar' : `Pozo: ${g.boneyard} ${g.boneyard === 1 ? 'ficha' : 'fichas'}`;
  $('pozoHint').hidden = !can;
  renderPozoModal(can && !(room.auto || [])[room.me] && !review);
}

// Modal del pozo: se abre solo cuando no tengo jugada y aún hay fichas. Con modo automático el servidor roba y juega
// por mí al instante, así que no se muestra. Bloquea el paño (no la mano) hasta que robe lo necesario.
function renderPozoModal(show) {
  const m = $('pozoModal');
  if (!show) {
    if (!m.hidden) { // limpieza táctil: sin ficha enfocada/resaltada ni cuadrícula fantasma
      if (m.contains(document.activeElement)) document.activeElement.blur();
      $('pozoGrid').innerHTML = '';
    }
    m.hidden = true;
    return;
  }
  const n = room.game.boneyard, grid = $('pozoGrid');
  if (m.hidden) {
    const h = $('me').getBoundingClientRect().height;
    m.style.setProperty('--me-h', Math.ceil(h + 8) + 'px'); // deja visible mi mano
    AudioManager.play('pick');
  }
  m.hidden = false;
  $('pozoModalCount').textContent = `${n} ${n === 1 ? 'ficha' : 'fichas'} en el pozo`;
  if (grid.children.length !== n) {
    grid.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pz-tile'; b.setAttribute('aria-label', 'Robar una ficha');
      b.onclick = () => { if (canDraw()) { AudioManager.play('pick'); socket.emit('draw'); } };
      grid.appendChild(b);
    }
  }
}
function closePozoModal() { renderPozoModal(false); }
(function initPozo() {
  const pz = $('pozo');
  const draw = () => { if (canDraw()) { AudioManager.play('pick'); socket.emit('draw'); } };
  pz.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); draw(); } };
  pz.onpointerdown = (ev) => {
    if (!canDraw()) return;
    ev.preventDefault();
    pz.setPointerCapture(ev.pointerId);
    const sx = ev.clientX, sy = ev.clientY, hand = $('hand');
    let clone = null;
    const over = (x, y) => { // soltar sobre la mano (con 28px de margen)
      const r = hand.getBoundingClientRect();
      return x > r.left - 28 && x < r.right + 28 && y > r.top - 28 && y < r.bottom + 28;
    };
    const move = (e) => {
      if (!clone) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) < 6) return;
        dragging = true;
        clone = document.createElement('div');
        clone.className = 'tile-back-drag';
        document.body.appendChild(clone);
        hand.classList.add('drop-ready');
        AudioManager.play('pick');
      }
      clone.style.left = e.clientX + 'px';
      clone.style.top = e.clientY + 'px';
      hand.classList.toggle('drop-hot', over(e.clientX, e.clientY));
    };
    const end = (e) => {
      pz.removeEventListener('pointermove', move);
      pz.removeEventListener('pointerup', end);
      pz.removeEventListener('pointercancel', end);
      hand.classList.remove('drop-ready', 'drop-hot');
      if (clone) {
        clone.remove(); dragging = false;
        if (e.type === 'pointerup' && over(e.clientX, e.clientY)) draw();
        if (room && room.game) renderTable(); // ponerse al día con lo que llegó durante el arrastre
      } else if (e.type === 'pointerup') draw(); // clic simple
    };
    pz.addEventListener('pointermove', move);
    pz.addEventListener('pointerup', end);
    pz.addEventListener('pointercancel', end);
  };
})();

function shake(el) {
  el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
}

const slotEls = {};
function slotEl(side) {
  if (!slotEls[side]) {
    const el = document.createElement('div');
    el.className = 'slot';
    el.dataset.side = side;
    el.onclick = () => selected && tryPlay(selected, side);
    $('chain').appendChild(el);
    slotEls[side] = el;
  }
  return slotEls[side];
}

// Resalta las casillas donde la ficha puede jugarse (ficha null = apaga todo).
function markSlots(tile) {
  const sides = tile ? sidesOf(tile) : [];
  for (const [side, el] of Object.entries(slotEls)) {
    const key = side === 'center' ? 'left' : side;
    el.classList.toggle('valid', sides.includes(key));
    el.classList.remove('hover');
  }
}

function tryPlay(tile, side) {
  if (!myTurn()) return;
  const key = side === 'center' ? 'left' : side;
  if (!sidesOf(tile).includes(key)) {
    toast(randomInvalidMessage(), 'invalid', INVALID_PLAY_MS);
    AudioManager.play('error');
    return;
  }
  selected = null;
  socket.emit('play', { tile, side: key });
}

// Casilla más cercana al puntero (tolerancia de 1.5 fichas) para soltar con holgura.
function slotNear(x, y) {
  let best = null, bestD = Infinity;
  for (const el of Object.values(slotEls)) {
    if (el.style.display === 'none') continue;
    const r = el.getBoundingClientRect();
    const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
    if (d < bestD && d < Math.max(r.width, r.height) * 1.5) { best = el; bestD = d; }
  }
  return best;
}

// Arrastrar una ficha de la mano: sobre la propia mano la reordena (en vivo, solo en este cliente);
// sobre un extremo del paño la juega (si encaja). Un clic la selecciona.
function startDrag(ev, el, tile, canPlay) {
  ev.preventDefault();
  const sx = ev.clientX, sy = ev.clientY, hand = $('hand');
  let clone = null;

  const overHand = (x, y) => {
    const r = hand.getBoundingClientRect();
    return x > r.left - 12 && x < r.right + 12 && y > r.top - 12 && y < r.bottom + 12;
  };
  // La ficha arrastrada (atenuada) se coloca en el hueco donde quedaría; admite varias filas.
  const reorder = (x, y) => {
    let ref = null;
    for (const ch of hand.children) {
      if (ch === el) continue;
      const r = ch.getBoundingClientRect();
      if (y < r.top - 4 || (y <= r.bottom + 4 && x < r.left + r.width / 2)) { ref = ch; break; }
    }
    return ref;
  };

  const move = (e) => {
    if (!clone) {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) < 6) return;
      dragging = true;
      AudioManager.play('pick');
      clone = el.cloneNode(true);
      clone.className = 'domino-tile ' + (el.classList.contains('h') ? 'h' : 'v') + ' drag';
      // Mismo tamaño que la ficha de la mano (el clon vive en <body> y no hereda su --s).
      clone.style.setProperty('--s', (el.classList.contains('h') ? el.offsetWidth / 2 : el.offsetWidth) + 'px');
      document.body.appendChild(clone);
      el.classList.add('lifted');
      if (canPlay) markSlots(tile);
    }
    clone.style.left = e.clientX + 'px';
    clone.style.top = e.clientY + 'px';
    if (overHand(e.clientX, e.clientY)) {
      Object.values(slotEls).forEach((s) => s.classList.remove('hover'));
    } else if (canPlay) {
      const near = slotNear(e.clientX, e.clientY);
      Object.values(slotEls).forEach((s) => s.classList.toggle('hover', s === near && s.classList.contains('valid')));
    }
  };
  const end = (e) => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
    if (!clone) { // clic
      if (canPlay) { selected = sameTile(selected, tile) ? null : tile; AudioManager.play('pick'); return renderTable(); }
      if (myTurn()) shake(el);
      return;
    }
    clone.remove();
    dragging = false;
    el.classList.remove('lifted');
    const drop = e.type === 'pointerup';
    if (drop && overHand(e.clientX, e.clientY)) { // soltada en la mano: se queda el nuevo orden
      const ref = reorder(e.clientX, e.clientY);
      if (el.nextSibling !== ref) hand.insertBefore(el, ref);
      // El nuevo orden solo afecta a la página visible; el resto de la mano conserva su lugar.
      const all = handOrder.slice(), vis = [...hand.children].map((ch) => ch.dataset.key);
      all.splice(handPage * HAND_PAGE, vis.length, ...vis);
      handOrder = all;
      return renderTable();
    }
    const near = drop && canPlay ? slotNear(e.clientX, e.clientY) : null;
    if (!near) { renderTable(); markSlots(selected); return; } // se cancela: la mano vuelve a su orden
    if (sidesOf(tile).includes(near.dataset.side === 'center' ? 'left' : near.dataset.side)) tryPlay(tile, near.dataset.side);
    else { shake(el); toast(randomInvalidMessage(), 'invalid', INVALID_PLAY_MS); AudioManager.play('error'); markSlots(selected); }
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
}

// ---------- Paño ----------
const chainEls = new Map(); // key -> elemento
let lastBoardLen = 0;

function renderBoard() {
  if (!room || !room.game) return;
  const g = room.game, board = $('board'), chain = $('chain');
  const fit = DominoLayout.fit(g.board, g.origin, board.clientWidth, board.clientHeight);
  // El contenedor ocupa al menos el área visible; si la cadena es mayor, hay scroll panorámico.
  const W = Math.max(fit.width + 24, board.clientWidth - 6), H = Math.max(fit.height + 24, board.clientHeight - 6);
  chain.style.width = W + 'px'; chain.style.height = H + 'px';
  // Si cambia el tamaño de ficha, recolocar sin transición para que cajas y puntos no se desfasen.
  chain.classList.toggle('instant', fit.s !== renderBoard.lastS);
  renderBoard.lastS = fit.s;
  const ox = W / 2 - (fit.minX + fit.width / 2), oy = H / 2 - (fit.minY + fit.height / 2);

  if (!g.board.length) { chainEls.forEach((e) => e.remove()); chainEls.clear(); }
  const seen = new Set();
  fit.items.forEach((it) => {
    seen.add(it.key);
    let el = chainEls.get(it.key);
    const sig = `${it.first}${it.second}${it.horiz}`;
    if (!el || el.dataset.sig !== sig) {
      const fresh = tileEl(it.first, it.second, fit.s, it.horiz);
      if (el) el.replaceWith(fresh); else { chain.appendChild(fresh); if (lastBoardLen) fresh.classList.add('new'); }
      el = fresh; chainEls.set(it.key, el);
    }
    el.style.setProperty('--s', fit.s + 'px');
    el.dataset.rot = it.rot;
    Object.assign(el.style, { left: ox + it.cx - it.w / 2 + 'px', top: oy + it.cy - it.h / 2 + 'px' });
  });
  chainEls.forEach((el, k) => { if (!seen.has(k)) { el.remove(); chainEls.delete(k); } });
  lastBoardLen = g.board.length;

  const mine = myTurn();
  ['left', 'right', 'center'].forEach((side) => {
    const r = fit.slots[side];
    if (!r) { if (slotEls[side]) slotEls[side].style.display = 'none'; return; }
    const el = slotEl(side);
    el.style.display = '';
    el.classList.toggle('on', mine);
    Object.assign(el.style, { left: ox + r.cx - r.w / 2 + 'px', top: oy + r.cy - r.h / 2 + 'px', width: r.w + 'px', height: r.h + 'px' });
  });
  markSlots(selected);
}
new ResizeObserver(() => { if (room && room.game && !$('table').hidden) renderBoard(); }).observe($('board'));

// ---------- Resultado ----------
let revealedRound = -1;
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

// Fila de mini-fichas con lo que quedó en la mano.
function miniHand(hand) {
  const box = el('div', 'mini-hand');
  if (!hand.length) { box.append(el('span', 'none', 'Sin fichas')); return box; }
  hand.forEach((t) => box.append(tileEl(t[0], t[1], 14, true)));
  return box;
}

// Tabla de manos (una fila por jugador con sus fichas y puntos); `mark(seat)` resalta filas.
function handsTable(hands, mark) {
  const sum = (h) => h.reduce((s, t) => s + t[0] + t[1], 0);
  const table = el('table', 'm-table');
  table.innerHTML = '<thead><tr><th>Jugador</th><th>Fichas en mano</th><th>Pts</th></tr></thead>';
  const body = el('tbody');
  hands.forEach((h, s) => {
    const tr = el('tr', mark(s) ? 'win' : '');
    tr.append(el('td', 'who', `<span class="avatar sm">${avatarOf(s)}</span>${esc(room.seats[s])}`));
    const td = el('td'); td.append(miniHand(h)); tr.append(td);
    tr.append(el('td', 'num', String(sum(h))));
    body.append(tr);
  });
  table.append(body);
  return table;
}

function renderResult() {
  const g = room.game, res = $('result'), banner = $('blocked');
  if (g.status !== 'ended') { // ronda en curso: limpiar cualquier aviso pendiente
    clearTimeout(renderResult.t); renderResult.pending = false;
    banner.hidden = true; res.hidden = true;
    return;
  }
  if (review) { res.hidden = true; banner.hidden = true; return; } // visor de tablero final
  const r = g.result;
  // Tranca: primero el aviso a pantalla completa (bloquea toda interacción) y luego el resultado.
  if (r.reason === 'blocked' && revealedRound !== room.round) {
    res.hidden = true; banner.hidden = false;
    if (!renderResult.pending) {
      renderResult.pending = true;
      renderResult.t = setTimeout(() => {
        renderResult.pending = false; revealedRound = room.round;
        banner.hidden = true;
        if (room && room.game) renderResult();
      }, 1800);
    }
    return;
  }
  banner.hidden = true; res.hidden = false;

  const modal = el('div', 'modal' + (room.over ? ' winner' : ''));
  if (r.reason === 'redeal') { // ronda cancelada por mano mala: se muestran las manos iniciales de todos
    modal.append(el('div', 'm-icon', '🔄'), el('h2', 'm-title', '¡Mano mala!'),
      el('p', 'm-sub', `<b>${esc(room.seats[r.requester])}</b> tenía ${r.doubles} dobles y reinició la ronda`),
      el('p', 'muted', 'Estas eran las manos de todos:'), handsTable(r.hands, (s) => s === r.requester));
    const act = el('div', 'm-actions');
    if (room.isHost) {
      const b = el('button', 'btn-wood gold big', 'Nueva ronda');
      b.onclick = () => socket.emit('nextRound');
      act.append(b);
    } else act.append(el('p', 'muted', 'Esperando al anfitrión…'));
    modal.append(act);
    res.replaceChildren(modal);
    return;
  }
  const tie = r.tie ? (r.winner === null ? ' Empate exacto: tabla.' : ' Empate exacto: gana quien salió.') : '';

  if (room.over) {
    const u = room.over.unit;
    modal.append(el('div', 'm-icon', '🏆'), el('h2', 'm-title', '¡Ganador de la mesa!'),
      el('p', 'm-sub', `<b>${esc(label(u))}</b> llegó a ${room.config.target} puntos`));
    const st = el('div', 'standings');
    room.scores.map((s, i) => [i, s]).sort((a, b) => b[1] - a[1]).forEach(([i, s]) =>
      st.append(el('div', i === u ? 'top' : '', `<span>${esc(label(i))}</span><span>${s} pts</span>`)));
    modal.append(st, el('h4', 'm-sec', 'Última ronda'));
  } else {
    modal.append(el('div', 'm-icon', r.reason === 'domino' ? '🎉' : '🔒'),
      el('h2', 'm-title', r.reason === 'domino' ? '¡Dominó!' : '¡Juego trancado!'));
  }
  const calc = r.reason === 'blocked' && r.winner !== null ? ` <small>(${r.others} − ${r.own})</small>` : '';
  modal.append(el('p', 'm-sub', (r.winner === null ? 'Nadie suma puntos' : `${esc(label(r.unit))} suma <b>${r.points}</b> puntos${calc}`) + tie));

  modal.append(handsTable(r.hands, (s) => r.winner !== null && r.unit === (teams() ? s % 2 : s)));

  const act = el('div', 'm-actions');
  const view = el('button', 'btn-wood', '🔍 Ver tablero final');
  view.onclick = () => { review = true; renderTable(); };
  act.append(view);
  if (room.isHost) {
    const b = el('button', 'btn-wood gold big', room.over ? 'Jugar otra partida' : 'Siguiente ronda');
    b.onclick = () => socket.emit(room.over ? 'rematch' : 'nextRound');
    act.append(b);
  } else {
    act.append(el('p', 'muted', 'Esperando al anfitrión…'));
  }
  modal.append(act);
  res.replaceChildren(modal);
}


// ---------- Código de mesa y gestión del anfitrión (expulsar) ----------
$('copyCode').onclick = async () => {
  const text = `Únete a mi mesa de JADU Domino con el código ${room.id}: ${location.origin}`;
  try { await navigator.clipboard.writeText(text); toast('Código copiado: ' + room.id, 'info'); }
  catch (e) { toast('Código de la mesa: ' + room.id, 'info'); }
};
function renderManage() {
  if (!room) return;
  $('kickBtn').hidden = !room.isHost;
  if (!room.isHost) { $('manage').hidden = true; return; }
  if ($('manage').hidden) return;
  $('manageCode').textContent = room.id;
  const ul = $('manageList');
  ul.innerHTML = '';
  const rows = [];
  room.seats.forEach((name, i) => { if (i !== room.me) rows.push({ name, pid: room.pids[i], tag: (room.away || [])[i] ? '🔌 desconectado' : 'jugador', emoji: avatarOf(i) }); });
  (room.specs || []).forEach((s) => rows.push({ name: s.name, pid: s.pid, tag: '👁 observador', emoji: (DominoAvatars.byId(s.avatar) || DominoAvatars.AVATARS[0]).emoji }));
  if (!rows.length) ul.innerHTML = '<li class="muted">Aún no hay nadie más en la mesa</li>';
  rows.forEach((r) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="mg-av">${r.emoji}</span><span class="mg-name">${esc(r.name)} <small>${r.tag}</small></span>`;
    const b = document.createElement('button');
    b.className = 'btn-wood danger'; b.textContent = 'Expulsar';
    b.onclick = () => { // dos toques para confirmar
      if (b.dataset.sure) { socket.emit('kick', { pid: r.pid }); return; }
      b.dataset.sure = '1'; b.textContent = '¿Seguro?';
      setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = 'Expulsar'; } }, 3000);
    };
    li.appendChild(b);
    ul.appendChild(li);
  });
}
$('kickBtn').onclick = () => { $('manage').hidden = false; renderManage(); };
$('manageClose').onclick = () => { $('manage').hidden = true; };
socket.on('room', (r) => { if (!r) $('manage').hidden = true; else renderManage(); });
