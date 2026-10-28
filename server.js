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

// Los temporizadores corren fuera de los handlers de Socket.io: sin este guardia, una excepción tumbaría todo el servidor.
const safe = (fn) => { try { fn(); } catch (e) { console.error('Error en temporizador:', e); } };
// Código de mesa: 5 caracteres sin letras/números que se confunden (0/O, 1/I/L). Se comparte para entrar.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRoomCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
const normCode = (v) => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');


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
  room.autoHandle = setTimeout(() => safe(() => onTimeout(room, token, 'auto')), AUTO_PLAY_MS);
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
  room.nextHandle = setTimeout(() => safe(() => {
    room.nextHandle = null;
    if (!rooms.has(room.id) || room.round !== round || !room.game || room.game.status !== 'ended') return;
    if (!isAuto(room, room.seats.indexOf(room.host))) return;
    if (room.over && room.away && room.away[room.host]) return;
    if (room.over) { room.scores = Array(unitCount(room)).fill(0); room.over = null; }
    dealRoom(room);
  }), AUTO_NEXT_MS);
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
  room.timerHandle = setTimeout(() => safe(() => onTimeout(room, token)), TURN_MS);
  // Doble sin segundo doble: el turno sigue visible en el mismo jugador, igual que si pudiera jugar otro.
  // Se cede tras una pausa aleatoria (0,5-1,2 s) parecida a la de quien decide, para que el tiempo tampoco delate.
  if (g.hold) {
    const delay = Math.min(500 + Math.random() * 700, TURN_MS * 0.6);
    room.holdHandle = setTimeout(() => safe(() => onHold(room, token)), delay);
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
    spectator: me < 0, // observa: ve la mesa pero no juega ni ve manos
    myPid: room.pids[socketId],
    specs: (room.spectators || []).map((id) => ({ name: room.names[id], avatar: room.avatars[id], pid: room.pids[id] })),
    // Todos los que pueden hablar por voz (jugadores y observadores), con su estado
    people: everyone(room).map((id) => ({ pid: room.pids[id], voice: room.voice[id] || null })),
    away: room.seats.map((id) => !!(room.away && room.away[id])), // desconectados (juegan en automático y pueden volver)
    scores: room.scores,
    over: room.over || null,
    round: room.round || 0,
    game: g && (() => {
      // Los dobles del turno en curso se ocultan a los demás hasta que se resuelva (no delatan un segundo doble)
      const pub = me === g.turn ? { board: g.board, origin: g.origin, hidden: 0 } : engine.publicBoard(g);
      return {
      board: pub.board,
      origin: pub.origin,
      // Información privada: solo el jugador en turno sabe si puede jugar otro doble (o si solo está cediendo el turno)
      bonus: g.bonus && me === g.turn,
      holding: g.hold && me === g.turn,
      badHand: me >= 0 && engine.canRedeal(g, me), // privado: solo lo sabe quien tiene la mano mala
      turn: g.turn,
      status: g.status,
      result: g.result,
      boneyard: g.boneyard.length,
      counts: g.hands.map((h, i) => h.length + (i === g.turn && me !== g.turn ? pub.hidden : 0)),
      hand: me >= 0 ? g.hands[me] : [],
      moves: me >= 0 && g.status === 'playing' && g.turn === me && !g.hold ? engine.legalMoves(g, me) : [],
      timer: g.status === 'playing' && room.turnEndsAt ? { endsAt: room.turnEndsAt, now: Date.now(), total: TURN_MS } : null,
      };
    })(),
  };
}

function pushRoom(room) {
  // Los ausentes (salieron o se desconectaron) no reciben la mesa: si su socket sigue vivo, los devolvería al tablero.
  everyone(room).forEach((id) => { if (!(room.away && room.away[id])) io.to(id).emit('room', roomView(room, id)); });
}
const pushList = () => {}; // las mesas ya no son públicas: se entra con código (no hay lista de mesas)

const EMPTY_TABLE_MS = 5 * 60 * 1000; // sin humanos conectados, la mesa se cierra tras este tiempo
const MAX_SPECTATORS = 20;
// Expulsados: se vetan por código del navegador (o por conexión si no lo tienen) para que no vuelvan a entrar a esa mesa.
const banKey = (socket) => socket.data.token || socket.id;
const isBanned = (room, socket) => !!(room.banned && room.banned.includes(banKey(socket)));
const isSpectator = (room, id) => !!(room.spectators && room.spectators.includes(id));
// Todos los que están en la mesa (jugadores + observadores): para chat, voz y avisos.
const everyone = (room) => [...room.seats, ...(room.spectators || [])];
const humansOnline = (room) => room.seats.filter((id) => !(room.away && room.away[id]));

function closeRoom(room, notice) {
  ['timerHandle', 'holdHandle', 'autoHandle', 'nextHandle', 'emptyHandle'].forEach((h) => clearTimeout(room[h]));
  room.game = null; // cualquier temporizador pendiente queda sin efecto
  rooms.delete(room.id);
  everyone(room).forEach((id) => {
    const s = io.sockets.sockets.get(id);
    if (s && s.data.roomId === room.id) {
      s.leave(room.id); s.data.roomId = null; s.emit('room', null);
      if (notice) s.emit('notice', notice);
    }
  });
}

// Partida en curso: quien se va (cierra la pestaña, pierde conexión o pulsa Salir) conserva su asiento en modo automático
// y puede volver con el mismo navegador (token), tanto si se desconectó como si pulsó Salir. Los demás terminan la partida.
function markAway(room, socket, who, explicit, msg) {
  const id = socket.id;
  room.away = room.away || {}; room.auto = room.auto || {};
  room.away[id] = true;
  room.auto[id] = true;
  delete room.voice[id];
  const others = humansOnline(room);
  if (room.host === id && others.length) room.host = others[0]; // el anfitrión pasa a un humano conectado
  if (others.length) {
    others.forEach((o) => io.to(o).emit('notice', msg || `El jugador ${who} ha abandonado la partida. Su turno será controlado automáticamente.`));
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
  if (isSpectator(room, socket.id)) { // un observador se va: la partida no se entera
    room.spectators = room.spectators.filter((id) => id !== socket.id);
    ['names', 'avatars', 'pids', 'voice', 'tokens'].forEach((m) => { if (room[m]) delete room[m][socket.id]; });
    pushRoom(room);
    pushList();
    return;
  }
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
  if (from === to) return; // salió con Salir y vuelve por el MISMO socket: nada que mover (copiar y borrar la misma clave borraba sus datos)
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
      id: newRoomCode(), host: socket.id, config: { players, mode, target: engine.normalizeTarget(target) },
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
    const room = rooms.get(normCode(id));
    if (!room) throw new Error('Código incorrecto: esa mesa no existe');
    if (isBanned(room, socket)) throw new Error('El anfitrión te expulsó de esta mesa');
    if (room.game) throw new Error('La partida ya inició (puedes entrar como observador)');
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

  // Expulsar (solo el anfitrión): jugadores u observadores. Queda vetado en esa mesa.
  on('kick', ({ pid: target }) => {
    const room = needRoom();
    if (room.host !== socket.id) throw new Error('Solo el anfitrión puede expulsar');
    const id = everyone(room).find((x) => room.pids[x] === target);
    if (!id || id === socket.id) throw new Error('Jugador no válido');
    const who = room.names[id] || 'Un jugador';
    const tsock = io.sockets.sockets.get(id);
    room.banned = room.banned || [];
    const key = (room.tokens && room.tokens[id]) || id;
    if (!room.banned.includes(key)) room.banned.push(key);
    const kickedMsg = 'El anfitrión te expulsó de la sala';
    if (isSpectator(room, id)) {
      room.spectators = room.spectators.filter((x) => x !== id);
      ['names', 'avatars', 'pids', 'voice', 'tokens'].forEach((m) => { if (room[m]) delete room[m][id]; });
    } else if (room.game) {
      room.gone = room.gone || {}; room.gone[id] = true; // no puede volver: su asiento sigue en automático
      if (!(room.away && room.away[id])) markAway(room, { id, data: {}, emit() {} }, who, false, `${who} fue expulsado de la mesa. Su turno será controlado automáticamente.`);
    } else {
      room.seats = room.seats.filter((x) => x !== id);
      ['names', 'avatars', 'pids', 'voice', 'tokens'].forEach((m) => { if (room[m]) delete room[m][id]; });
      humansOnline(room).forEach((o) => io.to(o).emit('notice', `${who} fue expulsado de la mesa`));
    }
    if (tsock) { tsock.leave(room.id); tsock.data.roomId = null; tsock.emit('room', null); tsock.emit('notice', kickedMsg); }
    pushRoom(room);
    socket.emit('notice', `${who} fue expulsado`);
  });

  // Observador: entra a una mesa (en espera o en juego) sin asiento. Ve el tablero, escribe en el chat y habla por voz.
  on('spectateRoom', ({ id }) => {
    if (!socket.data.name) throw new Error('Primero ingresa tu nombre');
    if (socket.data.roomId) throw new Error('Ya estás en una mesa');
    const room = rooms.get(normCode(id));
    if (!room) throw new Error('Código incorrecto: esa mesa no existe');
    if (isBanned(room, socket)) throw new Error('El anfitrión te expulsó de esta mesa');
    room.spectators = room.spectators || [];
    if (room.spectators.length >= MAX_SPECTATORS) throw new Error('La mesa tiene demasiados observadores');
    room.spectators.push(socket.id);
    room.names[socket.id] = socket.data.name;
    room.avatars[socket.id] = socket.data.avatar;
    room.pids[socket.id] = pid();
    room.tokens = room.tokens || {}; room.tokens[socket.id] = socket.data.token;
    socket.emit('chatHistory', room.chat);
    socket.join(room.id);
    socket.data.roomId = room.id;
    humansOnline(room).forEach((o) => io.to(o).emit('notice', `👁 ${socket.data.name} está observando la partida`));
    pushRoom(room);
    pushList();
  });

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
    const target = everyone(room).find((id) => room.pids[id] === to);
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
    if (seat < 0) throw new Error('Eres observador: no puedes jugar');
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
    if (room.seats.indexOf(socket.id) < 0) throw new Error('Eres observador: no puedes jugar');
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
