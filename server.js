const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const { Server } = require('socket.io');
const engine = require('./game/engine');
const Avatars = require('./public/avatars');

const app = express();
const server = http.createServer(app);
// Pings cada 20 s: detecta conexiones muertas sin saturar la red (y libera sus asientos/listeners).
const io = new Server(server, { pingInterval: 20000, pingTimeout: 20000, maxHttpBufferSize: 1e5 });

// `--dist`: sirve la versión minificada generada con `npm run build` (carpeta dist/).
const STATIC_DIR = process.argv.includes('--dist') && fs.existsSync(path.join(__dirname, 'dist')) ? path.join(__dirname, 'dist') : path.join(__dirname, 'public');

// Cabeceras de seguridad. La CSP solo permite recursos propios (la voz usa WebRTC, que no pasa por la CSP).
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=(), fullscreen=(self)',
  });
  next();
});
app.use(compression());

// La portada lleva URLs absolutas (Open Graph/canonical) según el dominio desde el que se pide (túnel, dominio propio…).
const indexHtml = () => fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
app.get(['/', '/index.html'], (req, res) => {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const origin = `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  res.set('Cache-Control', 'no-cache').type('html').send(indexHtml().replace(/__ORIGIN__/g, origin));
});
app.use(express.static(STATIC_DIR, {
  index: false,
  setHeaders: (res, file) => {
    if (/sw\.js$/.test(file)) res.set('Cache-Control', 'no-cache'); // el SW siempre se revalida
    else if (/\.(png|webp|jpg|svg|ico)$/.test(file)) res.set('Cache-Control', 'public, max-age=604800');
    else res.set('Cache-Control', 'no-cache'); // JS/CSS/JSON: se revalidan con ETag (304 si no cambiaron)
  },
}));

const pid = () => crypto.randomBytes(4).toString('hex'); // id público estable de un jugador en su mesa
const TURN_MS = (Number(process.env.TURN_SECONDS) || 20) * 1000; // tiempo por turno
const rooms = new Map(); // id -> room
let nextRoomId = 1;


// ---- Puntos de la mesa tras terminar una ronda (se llama una sola vez por ronda) ----
function settle(room) {
  const g = room.game;
  // Jugadores saltados por pozo vacío y sin jugada: se avisa a toda la mesa (es información pública)
  if (g.skipped && g.skipped.length) {
    io.to(room.id).emit('skipped', { names: g.skipped.map((i) => room.names[room.seats[i]]) });
    g.skipped = [];
  }
  if (g.status !== 'ended') return;
  if (g.result.unit !== null) room.scores[g.result.unit] += g.result.points;
  const unit = engine.matchWinner(room.scores, room.config.target);
  if (unit !== null) room.over = { unit };
  maybeAutoNext(room);
}

// ---- Modo automático (interruptor por jugador): room.auto[socketId] = true ----
const AUTO_PLAY_MS = 800, AUTO_NEXT_MS = 1500;
const isAuto = (room, seat) => !!(room.auto && room.auto[room.seats[seat]]);

// Si le toca a alguien en modo automático, juega su ficha más baja tras una pausa corta.
function scheduleAuto(room) {
  clearTimeout(room.autoHandle);
  const g = room.game;
  if (!g || g.status !== 'playing' || g.hold || !isAuto(room, g.turn)) return;
  const token = room.timerToken;
  room.autoHandle = setTimeout(() => onTimeout(room, token, 'auto'), AUTO_PLAY_MS);
}

function dealRoom(room) {
  room.game = engine.newRound(room.config.players, room.config.mode);
  room.round = (room.round || 0) + 1;
  armTimer(room);
  pushRoom(room);
  pushList();
}

// Anfitrión en modo automático: al acabar la ronda (o la partida) arranca la siguiente sin esperar clic.
function maybeAutoNext(room) {
  const g = room.game;
  if (!g || g.status !== 'ended' || room.nextHandle || !isAuto(room, room.seats.indexOf(room.host))) return;
  const round = room.round;
  room.nextHandle = setTimeout(() => {
    room.nextHandle = null;
    if (!rooms.has(room.id) || room.round !== round || !room.game || room.game.status !== 'ended') return;
    if (!isAuto(room, room.seats.indexOf(room.host))) return;
    if (room.over && room.away && room.away[room.host]) return;
    if (room.over) { room.scores = Array(unitCount(room)).fill(0); room.over = null; }
    dealRoom(room);
  }, AUTO_NEXT_MS);
}

// ---- Temporizador de turno: el servidor manda; los clientes solo dibujan la cuenta atrás ----
function armTimer(room) {
  clearTimeout(room.timerHandle);
  clearTimeout(room.holdHandle);
  clearTimeout(room.autoHandle);
  room.timerToken = (room.timerToken || 0) + 1;
  const g = room.game;
  if (!g || g.status !== 'playing') { room.turnEndsAt = null; return; }
  const token = room.timerToken;
  room.turnEndsAt = Date.now() + TURN_MS;
  room.timerHandle = setTimeout(() => onTimeout(room, token), TURN_MS);
  // Doble sin segundo doble: el turno sigue visible en el mismo jugador, igual que si pudiera jugar otro.
  // Se cede tras una pausa aleatoria (0,5-1,2 s) parecida a la de quien decide, para que el tiempo tampoco delate.
  if (g.hold) {
    const delay = Math.min(500 + Math.random() * 700, TURN_MS * 0.6);
    room.holdHandle = setTimeout(() => onHold(room, token), delay);
  }
  scheduleAuto(room);
}

function onHold(room, token) {
  const g = room.game;
  if (!rooms.has(room.id) || room.timerToken !== token || !g || g.status !== 'playing' || !g.hold) return;
  engine.releaseHold(g);
  settle(room);
  armTimer(room);
  pushRoom(room);
}

// Tiempo agotado: se juega la ficha de menos puntos; sin jugada, roba/pasa. Luego sigue el siguiente.
function onTimeout(room, token, reason = 'timeout') {
  const g = room.game;
  if (!rooms.has(room.id) || room.timerToken !== token || !g || g.status !== 'playing') return;
  const seat = g.turn;
  const events = reason === 'auto' ? engine.playRandomValidTile(g, seat) : engine.playLowestValidTile(g, seat);
  io.to(room.id).emit('timeout', { name: room.names[room.seats[seat]], events, reason });
  settle(room);
  armTimer(room);
  pushRoom(room);
}

// room = { id, name, host, config:{players, mode, target}, seats:[socketId], names:{socketId:name},
//          scores:[..], game: state|null }

function unitCount(room) {
  return room.config.mode === 'teams' ? 2 : room.config.players;
}

function roomList() {
  return [...rooms.values()].filter((r) => r.seats.some((id) => !(r.away && r.away[id]))).map((r) => ({
    id: r.id,
    host: r.names[r.host],
    players: r.config.players,
    mode: r.config.mode,
    target: r.config.target,
    seated: r.seats.length,
    inGame: !!r.game,
  }));
}

// Vista personalizada: cada jugador solo ve su propia mano.
function roomView(room, socketId) {
  const me = room.seats.indexOf(socketId);
  const g = room.game;
  return {
    id: room.id,
    config: room.config,
    isHost: room.host === socketId,
    me,
    seats: room.seats.map((id) => room.names[id]),
    avatars: room.seats.map((id) => room.avatars[id]),
    pids: room.seats.map((id) => room.pids[id]),
    voice: room.seats.map((id) => room.voice[id] || null),
    auto: room.seats.map((id) => !!(room.auto && room.auto[id])),
    away: room.seats.map((id) => !!(room.away && room.away[id])), // desconectados (juegan en automático y pueden volver)
    scores: room.scores,
    over: room.over || null,
    round: room.round || 0,
    game: g && {
      board: g.board,
      origin: g.origin,
      // Información privada: solo el jugador en turno sabe si puede jugar otro doble (o si solo está cediendo el turno)
      bonus: g.bonus && me === g.turn,
      holding: g.hold && me === g.turn,
      badHand: me >= 0 && engine.canRedeal(g, me), // privado: solo lo sabe quien tiene la mano mala
      turn: g.turn,
      status: g.status,
      result: g.result,
      boneyard: g.boneyard.length,
      counts: g.hands.map((h) => h.length),
      hand: me >= 0 ? g.hands[me] : [],
      moves: me >= 0 && g.status === 'playing' && g.turn === me && !g.hold ? engine.legalMoves(g, me) : [],
      timer: g.status === 'playing' && room.turnEndsAt ? { endsAt: room.turnEndsAt, now: Date.now(), total: TURN_MS } : null,
    },
  };
}

function pushRoom(room) {
  // Los ausentes (salieron o se desconectaron) no reciben la mesa: si su socket sigue vivo, los devolvería al tablero.
  room.seats.forEach((id) => { if (!(room.away && room.away[id])) io.to(id).emit('room', roomView(room, id)); });
}
const pushList = () => io.emit('rooms', roomList());

const EMPTY_TABLE_MS = 5 * 60 * 1000; // sin humanos conectados, la mesa se cierra tras este tiempo
const humansOnline = (room) => room.seats.filter((id) => !(room.away && room.away[id]));

function closeRoom(room, notice) {
  ['timerHandle', 'holdHandle', 'autoHandle', 'nextHandle', 'emptyHandle'].forEach((h) => clearTimeout(room[h]));
  room.game = null; // cualquier temporizador pendiente queda sin efecto
  rooms.delete(room.id);
  room.seats.forEach((id) => {
    const s = io.sockets.sockets.get(id);
    if (s && s.data.roomId === room.id) {
      s.leave(room.id); s.data.roomId = null; s.emit('room', null);
      if (notice) s.emit('notice', notice);
    }
  });
}

// Partida en curso: quien se va (cierra la pestaña, pierde conexión o pulsa Salir) conserva su asiento en modo automático
// y puede volver con el mismo navegador (token), tanto si se desconectó como si pulsó Salir. Los demás terminan la partida.
function markAway(room, socket, who, explicit) {
  const id = socket.id;
  room.away = room.away || {}; room.auto = room.auto || {};
  room.away[id] = true;
  room.auto[id] = true;
  delete room.voice[id];
  const others = humansOnline(room);
  if (room.host === id && others.length) room.host = others[0]; // el anfitrión pasa a un humano conectado
  if (others.length) {
    others.forEach((o) => io.to(o).emit('notice', `El jugador ${who} ha abandonado la partida. Su turno será controlado automáticamente.`));
  } else {
    room.emptyHandle = setTimeout(() => closeRoom(room), EMPTY_TABLE_MS); // nadie conectado: se espera a que vuelvan
  }
  if (explicit && socket.data.token) socket.emit('resume', { room: room.id }); // también tras Salir: aviso no bloqueante en el lobby
  scheduleAuto(room);
  maybeAutoNext(room);
  pushRoom(room);
}

function leave(socket, explicit) {
  const room = rooms.get(socket.data.roomId);
  if (!room) return;
  const who = room.names[socket.id] || 'Un jugador';
  socket.leave(room.id);
  socket.data.roomId = null;
  socket.emit('room', null); // el que sale vuelve al lobby
  if (room.game) {
    markAway(room, socket, who, explicit);
  } else if (room.host === socket.id) {
    // Sala de espera sin anfitrión: se cierra y todos vuelven al lobby.
    room.seats = room.seats.filter((id) => id !== socket.id);
    closeRoom(room, `${who} (anfitrión) cerró la mesa`);
  } else {
    room.seats = room.seats.filter((id) => id !== socket.id);
    delete room.voice[socket.id];
    pushRoom(room);
  }
  pushList();
}

// Asiento que este navegador dejó en una partida en curso (si sigue disponible).
function findResumable(token) {
  if (!token) return null;
  for (const room of rooms.values()) {
    if (!room.game) continue;
    for (const id of room.seats) {
      if (room.tokens && room.tokens[id] === token && room.away && room.away[id] && !(room.gone && room.gone[id])) return { room, id };
    }
  }
  return null;
}

// El asiento pasa del socket antiguo al nuevo: todos los mapas de la mesa usan el id del socket como clave.
function rekey(room, from, to) {
  ['names', 'avatars', 'pids', 'voice', 'auto', 'away', 'tokens', 'gone'].forEach((m) => {
    if (room[m] && from in room[m]) { room[m][to] = room[m][from]; delete room[m][from]; }
  });
  room.seats = room.seats.map((id) => (id === from ? to : id));
  if (room.host === from) room.host = to;
}

io.on('connection', (socket) => {
  // Guarda de errores: cada handler devuelve el mensaje al cliente sin tumbar el servidor.
  const on = (event, fn) => socket.on(event, (arg) => {
    try { fn(arg || {}); } catch (e) { socket.emit('notice', e.message); }
  });
  const needRoom = () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) throw new Error('No estás en una mesa');
    return room;
  };
  const needGame = () => {
    const room = needRoom();
    if (!room.game) throw new Error('La partida no ha iniciado');
    return room;
  };

  on('setName', ({ name, avatar, token }) => {
    name = String(name || '').trim().slice(0, 20);
    if (!name) throw new Error('Escribe un nombre');
    socket.data.name = name;
    socket.data.avatar = Avatars.byId(avatar) ? avatar : Avatars.random(); // valida contra el catálogo
    if (typeof token === 'string' && /^[\w-]{8,64}$/.test(token)) socket.data.token = token;
    socket.emit('named', name);
    socket.emit('rooms', roomList());
    const r = findResumable(socket.data.token);
    if (r && !socket.data.roomId) socket.emit('resume', { room: r.room.id }); // ¿volver a su partida?
  });

  on('createRoom', ({ players, mode, target }) => {
    if (!socket.data.name) throw new Error('Primero ingresa tu nombre');
    if (socket.data.roomId) throw new Error('Ya estás en una mesa');
    players = Number(players);
    if (![2, 3, 4].includes(players)) throw new Error('Jugadores: 2, 3 o 4');
    mode = players === 4 && mode === 'teams' ? 'teams' : 'individual';
    const room = {
      id: String(nextRoomId++), host: socket.id, config: { players, mode, target: engine.normalizeTarget(target) },
      seats: [socket.id], names: { [socket.id]: socket.data.name }, avatars: { [socket.id]: socket.data.avatar }, pids: { [socket.id]: pid() }, tokens: { [socket.id]: socket.data.token }, away: {}, gone: {}, voice: {}, chat: [], scores: [], game: null,
    };
    room.scores = Array(unitCount(room)).fill(0);
    rooms.set(room.id, room);
    socket.join(room.id);
    socket.data.roomId = room.id;
    pushRoom(room);
    pushList();
  });

  on('joinRoom', ({ id }) => {
    if (!socket.data.name) throw new Error('Primero ingresa tu nombre');
    if (socket.data.roomId) throw new Error('Ya estás en una mesa');
    const room = rooms.get(String(id));
    if (!room) throw new Error('La mesa no existe');
    if (room.game) throw new Error('La partida ya inició');
    if (room.seats.length >= room.config.players) throw new Error('Mesa llena');
    room.seats.push(socket.id);
    room.names[socket.id] = socket.data.name;
    room.avatars[socket.id] = socket.data.avatar;
    room.pids[socket.id] = pid();
    room.tokens = room.tokens || {}; room.tokens[socket.id] = socket.data.token;
    socket.emit('chatHistory', room.chat);
    socket.join(room.id);
    socket.data.roomId = room.id;
    pushRoom(room);
    pushList();
  });

  on('leaveRoom', () => leave(socket, true));

  // Volver a la partida que dejé (mismo navegador): recupera el asiento y la mano, y se apaga el automático.
  on('rejoin', () => {
    if (socket.data.roomId) throw new Error('Ya estás en una mesa');
    const r = findResumable(socket.data.token);
    if (!r) throw new Error('Esa partida ya no está disponible');
    const { room, id } = r;
    clearTimeout(room.emptyHandle);
    rekey(room, id, socket.id);
    delete room.auto[socket.id];
    delete room.away[socket.id];
    socket.data.name = room.names[socket.id];
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.emit('chatHistory', room.chat);
    humansOnline(room).filter((o) => o !== socket.id).forEach((o) => io.to(o).emit('notice', `${room.names[socket.id]} volvió a la partida`));
    scheduleAuto(room);
    pushRoom(room);
    pushList();
  });
  // Renunciar al asiento: la partida sigue sin esa persona (el automático la acompaña hasta el final).
  on('forfeit', () => {
    const r = findResumable(socket.data.token);
    if (r) r.room.gone[r.id] = true;
  });

  // ---- Chat de texto: límite de longitud y de frecuencia (5 mensajes / 4 s) ----
  on('chat', ({ text }) => {
    const room = needRoom();
    text = String(text || '').trim().slice(0, 200);
    if (!text) return;
    const now = Date.now();
    socket.data.chatTimes = (socket.data.chatTimes || []).filter((t) => now - t < 4000);
    if (socket.data.chatTimes.length >= 5) throw new Error('Vas muy rápido, espera un momento');
    socket.data.chatTimes.push(now);
    const msg = { pid: room.pids[socket.id], name: socket.data.name, avatar: room.avatars[socket.id], text, t: now };
    room.chat.push(msg);
    if (room.chat.length > 50) room.chat.shift();
    io.to(room.id).emit('chat', msg);
  });

  // ---- Voz: el servidor solo anuncia quién está en la voz y reenvía la señalización WebRTC ----
  on('voice', ({ on: joined, muted }) => {
    const room = needRoom();
    if (joined) room.voice[socket.id] = { muted: !!muted }; else delete room.voice[socket.id];
    pushRoom(room);
  });
  on('signal', ({ to, data }) => {
    const room = needRoom();
    if (!data || JSON.stringify(data).length > 20000) return;
    const target = room.seats.find((id) => room.pids[id] === to);
    if (target && target !== socket.id) io.to(target).emit('signal', { from: room.pids[socket.id], data });
  });

  const deal = dealRoom;

  on('startGame', () => {
    const room = needRoom();
    if (room.host !== socket.id) throw new Error('Solo el anfitrión inicia');
    if (room.game) throw new Error('Ya inició');
    if (room.seats.length !== room.config.players) throw new Error('Faltan jugadores');
    deal(room);
  });

  on('nextRound', () => {
    const room = needGame();
    if (room.host !== socket.id) throw new Error('Solo el anfitrión reparte');
    if (room.game.status !== 'ended') throw new Error('La ronda sigue en curso');
    if (room.over) throw new Error('La partida terminó: inicia una nueva');
    deal(room);
  });

  // Revancha: mismo grupo y objetivo, marcador en cero.
  on('rematch', () => {
    const room = needGame();
    if (room.host !== socket.id) throw new Error('Solo el anfitrión reinicia');
    if (!room.over) throw new Error('La partida sigue en curso');
    room.scores = Array(unitCount(room)).fill(0);
    room.over = null;
    deal(room);
  });

  // Acciones de juego: validan asiento/turno en el motor y difunden el nuevo estado.
  const act = (fn) => {
    const room = needGame();
    const seat = room.seats.indexOf(socket.id);
    const g = room.game;
    const sig = () => `${g.turn}:${g.board.length}:${g.status}`;
    const before = sig();
    fn(g, seat);
    settle(room);
    if (sig() !== before) armTimer(room); // turno nuevo (o doble extra / fin de ronda): reinicia la cuenta
    pushRoom(room);
  };
  // Modo automático: interruptor persistente. Mientras esté activo, cada turno suyo juega la ficha de menos puntos.
  on('auto', ({ on: v }) => {
    const room = needGame();
    room.auto = room.auto || {};
    room.auto[socket.id] = typeof v === 'boolean' ? v : !room.auto[socket.id];
    if (!room.auto[socket.id]) delete room.auto[socket.id];
    scheduleAuto(room);
    maybeAutoNext(room);
    pushRoom(room);
  });
  // Mano mala: cancela la ronda y revela las manos iniciales de todos (se reparte de nuevo con "siguiente ronda")
  on('redeal', () => act((g, seat) => engine.redeal(g, seat)));
  on('play', (a) => act((g, seat) => engine.play(g, seat, a.tile, a.side)));
  on('draw', () => act((g, seat) => engine.draw(g, seat)));
  on('endTurn', () => act((g, seat) => engine.endTurn(g, seat)));
  on('pass', () => act((g, seat) => engine.pass(g, seat)));

  on('disconnect', () => leave(socket, false));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`JADU Domino en http://localhost:${PORT}`));
