// Motor de dominó: funciones puras sobre un objeto de estado. Sin sockets ni I/O.
// Ficha = [a, b]. El tablero es una cadena de fichas ya orientadas de izquierda a derecha:
// extremo izquierdo = board[0][0], extremo derecho = board[board.length - 1][1].

const HAND_SIZE = 7;

function fullSet() {
  const tiles = [];
  for (let a = 0; a <= 6; a++) for (let b = a; b <= 6; b++) tiles.push([a, b]);
  return tiles;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const pips = (tile) => tile[0] + tile[1];
const handPips = (hand) => hand.reduce((s, t) => s + pips(t), 0);
const isDouble = (t) => t[0] === t[1];
const same = (x, y) => (x[0] === y[0] && x[1] === y[1]) || (x[0] === y[1] && x[1] === y[0]);

function ends(board) {
  return board.length ? [board[0][0], board[board.length - 1][1]] : null;
}

// Quién sale: 6/6; si no está repartido, el doble más alto; si no hay dobles, la ficha de más puntos.
function findStarter(hands) {
  for (let d = 6; d >= 0; d--) {
    const seat = hands.findIndex((h) => h.some((t) => t[0] === d && t[1] === d));
    if (seat !== -1) return seat;
  }
  let best = -1, bestSeat = 0;
  hands.forEach((h, seat) => h.forEach((t) => {
    if (pips(t) > best) { best = pips(t); bestSeat = seat; }
  }));
  return bestSeat;
}

// mode: 'individual' | 'teams' (solo 4 jugadores; equipos = asientos pares vs impares)
// opts.tieRule: empate exacto en tranca -> 'starter' (gana quien salió, por defecto) | 'none' (tabla, nadie suma)
function newRound(numPlayers, mode, opts = {}) {
  const deck = shuffle(fullSet());
  const hands = Array.from({ length: numPlayers }, () => deck.splice(0, HAND_SIZE));
  const turn = findStarter(hands);
  return {
    numPlayers,
    mode,
    tieRule: opts.tieRule || 'starter',
    starter: turn,
    hands,
    initialHands: hands.map((h) => h.map((t) => [...t])), // para revelarlas si alguien reinicia por mano mala
    acted: hands.map(() => false), // quién ya ejecutó su primer turno
    skipped: [], // asientos saltados en el último cambio de turno (pozo vacío y sin jugada)
    boneyard: deck, // 2 jugadores: 14 fichas; 3 jugadores: 7; 4 jugadores: 0
    board: [],
    hold: false, // turno retenido tras un doble sin otro doble: evita delatar la mano (ver play)
    bonus: false, // true: acaba de jugar un doble y puede jugar otro doble en el mismo turno
    origin: 0, // índice en board de la primera ficha jugada (ancla del paño)
    turn,
    status: 'playing', // 'playing' | 'ended'
    result: null,
  };
}

// Movimientos legales del asiento. Con tablero vacío (salida) puede jugar cualquier ficha.
function legalMoves(state, seat) {
  const hand = state.bonus ? state.hands[seat].filter(isDouble) : state.hands[seat];
  const e = ends(state.board);
  if (!e) return hand.map((tile) => ({ tile, side: 'left' }));
  const moves = [];
  for (const tile of hand) {
    if (tile[0] === e[0] || tile[1] === e[0]) moves.push({ tile, side: 'left' });
    if (tile[0] === e[1] || tile[1] === e[1]) moves.push({ tile, side: 'right' });
  }
  return moves;
}

function fail(msg) { throw new Error(msg); }

function checkTurn(state, seat) {
  if (state.status !== 'playing') fail('La ronda ya terminó');
  if (state.turn !== seat) fail('No es tu turno');
  if (state.hold) fail('Turno en curso');
}

function play(state, seat, tile, side) {
  checkTurn(state, seat);
  const hand = state.hands[seat];
  const idx = hand.findIndex((t) => same(t, tile));
  if (idx === -1) fail('No tienes esa ficha');
  const owned = hand[idx];
  const e = ends(state.board);

  let placed;
  if (!e) {
    placed = [owned[0], owned[1]];
  } else if (side === 'left') {
    if (owned[1] === e[0]) placed = [owned[0], owned[1]];
    else if (owned[0] === e[0]) placed = [owned[1], owned[0]];
    else fail('La ficha no encaja a la izquierda');
  } else if (side === 'right') {
    if (owned[0] === e[1]) placed = [owned[0], owned[1]];
    else if (owned[1] === e[1]) placed = [owned[1], owned[0]];
    else fail('La ficha no encaja a la derecha');
  } else fail('Lado inválido');

  state.acted[seat] = true;
  hand.splice(idx, 1);
  if (side === 'left' && e) { state.board.unshift(placed); state.origin++; }
  else state.board.push(placed);

  if (hand.length === 0) return finish(state, 'domino', seat);
  // Regla de la casa: tras un doble, si tienes otro doble que encaje, puedes jugarlo en el mismo turno.
  // Para no delatar la mano, el turno se retiene tras CUALQUIER doble (haya segundo doble o no):
  // los rivales ven lo mismo en ambos casos. Sin segundo doble, el servidor lo cede un instante
  // después (releaseHold) con una pausa parecida a la de alguien que decide.
  state.bonus = false;
  state.hold = false;
  if (!isDouble(placed)) return advance(state, seat);
  state.bonus = true;
  if (legalMoves(state, seat).length) return state; // aún tiene jugada: no puede estar trancado
  state.bonus = false;
  if (checkGameBlocked(state)) return finish(state, 'blocked', null); // el cierre es público de todos modos
  state.hold = true;
  return state;
}

// Cede el turno retenido tras un doble sin segundo doble.
function releaseHold(state) {
  if (state.status !== 'playing' || !state.hold) fail('No hay turno retenido');
  state.hold = false;
  return advance(state, state.turn);
}

// Cierra el turno de `seat`: si tras su acción nadie puede jugar, el juego se tranca ya
// (sin obligar al siguiente a robar del pozo); si no, pasa el turno.
// ¿Tiene `seat` alguna ficha que encaje en las puntas? (El pozo no cuenta.)
function hasMove(state, seat) {
  const en = ends(state.board);
  if (!en) return true;
  return state.hands[seat].some((t) => t.includes(en[0]) || t.includes(en[1]));
}

// Pasa el turno. Si el pozo está vacío y el siguiente no tiene jugada, lo salta solo: no hay nada que
// robar ni que jugar, así que nadie tiene que pulsar "pasar". Si nadie puede jugar, es tranca (antes).
function advance(state, seat) {
  state.skipped = [];
  if (checkGameBlocked(state)) return finish(state, 'blocked', null);
  let next = (seat + 1) % state.numPlayers;
  for (let i = 0; i < state.numPlayers && !state.boneyard.length && !hasMove(state, next); i++) {
    state.acted[next] = true; // su turno cuenta como ya ejecutado
    state.skipped.push(next);
    next = (next + 1) % state.numPlayers;
  }
  state.turn = next;
  return state;
}

// Tranca real: ninguna ficha que NO esté en la mesa (ni en una mano ni en el pozo) encaja en alguna punta.
//  a) pozo vacío y nadie tiene jugada;
//  b) bloqueo de puntas: las fichas que las puntas exigen (p. ej. todos los 2) ya están en la mesa,
//     aunque queden fichas en el pozo. Se cierra de inmediato, sin que nadie coma.
// Si el pozo aún tiene una ficha que encaja, no hay tranca: quien no puede jugar debe robar.
function checkGameBlocked(state) {
  const e = ends(state.board);
  if (!e) return false;
  const fits = (t) => t.includes(e[0]) || t.includes(e[1]);
  return !state.hands.some((hand) => hand.some(fits)) && !state.boneyard.some(fits);
}

// Renunciar al doble extra y ceder el turno.
function endTurn(state, seat) {
  checkTurn(state, seat);
  if (!state.bonus) fail('No tienes jugada extra');
  state.bonus = false;
  return advance(state, seat);
}

// Roba del pozo (solo si no tienes jugada y queda pozo). Mantienes el turno.
function draw(state, seat) {
  checkTurn(state, seat);
  if (!state.boneyard.length) fail('El pozo está vacío');
  if (legalMoves(state, seat).length) fail('Tienes una ficha jugable');
  state.acted[seat] = true;
  state.hands[seat].push(state.boneyard.pop());
  // La ficha robada pudo ser la última que faltaba para cerrar: tranca inmediata.
  if (checkGameBlocked(state)) return finish(state, 'blocked', null);
  return state;
}

// Pasar: solo sin jugada y sin pozo.
function pass(state, seat) {
  checkTurn(state, seat);
  if (state.boneyard.length) fail('Debes robar del pozo');
  if (legalMoves(state, seat).length) fail('Tienes una jugada disponible');
  state.acted[seat] = true;
  return advance(state, seat);
}

// Unidad de puntaje: el asiento (individual) o el equipo 0/1 (parejas).
const unitOf = (state, seat) => (state.mode === 'teams' ? seat % 2 : seat);

// Domino -> el ganador suma las fichas de los rivales (en parejas, solo las del otro equipo;
// individual, las de todos los demás).
// Tranca -> solo cuentan las fichas que ya están en mano. Gana el jugador (o equipo, con la suma
// combinada) con menos puntos y recibe: puntos de los rivales - puntos propios en mano.
// Empate exacto: según tieRule, gana quien salió ('starter') o nadie suma ('none').
function finish(state, reason, dominoSeat) {
  state.status = 'ended';
  state.bonus = false;
  state.hold = false;
  const totals = state.hands.map(handPips);
  const unitTotals = {};
  totals.forEach((t, s) => { const u = unitOf(state, s); unitTotals[u] = (unitTotals[u] || 0) + t; });

  let winner = dominoSeat, tie = false;
  if (reason === 'blocked') {
    const min = Math.min(...Object.values(unitTotals));
    const tied = Object.keys(unitTotals).map(Number).filter((u) => unitTotals[u] === min);
    let wu = tied[0];
    if (tied.length > 1) {
      tie = true;
      if (state.tieRule === 'none') wu = null;
      else {
        // El que salió; si su bando no empató, el primer empatado en orden de turno desde la salida.
        for (let i = 0; i < state.numPlayers; i++) {
          const u = unitOf(state, (state.starter + i) % state.numPlayers);
          if (tied.includes(u)) { wu = u; break; }
        }
      }
    }
    winner = wu === null ? null
      : totals.map((t, s) => [t, s]).filter(([, s]) => unitOf(state, s) === wu).sort((x, y) => x[0] - y[0])[0][1];
  }
  let points = 0, others = 0, own = 0;
  if (winner !== null) {
    const wu = unitOf(state, winner);
    others = Object.entries(unitTotals).reduce((sum, [u, t]) => (Number(u) === wu ? sum : sum + t), 0);
    own = reason === 'blocked' ? unitTotals[wu] : 0;
    points = others - own;
  }
  state.result = {
    reason,
    winner,
    unit: winner === null ? null : unitOf(state, winner),
    points,
    others,
    own,
    tie,
    hands: state.hands.map((h) => h.map((t) => [...t])),
  };
  return state;
}

// Ficha jugable de MENOS puntos (pips): protege las fichas altas del propio jugador.
// Es la que se juega sola cuando se agota el tiempo o se pulsa "juego automático". Con empate, la primera.
function lowestMove(state, seat) {
  const moves = legalMoves(state, seat);
  if (!moves.length) return null;
  return moves.reduce((best, m) => (pips(m.tile) < pips(best.tile) ? m : best));
}

// Ficha jugable al azar (modo automático activado: jugador casual e impredecible).
function randomMove(state, seat, rng = Math.random) {
  const moves = legalMoves(state, seat);
  return moves.length ? moves[Math.floor(rng() * moves.length)] : null;
}

// Resuelve automáticamente TODO el turno de `seat` y devuelve lo que hizo:
//  - turno retenido tras un doble, o doble extra: lo cede (la IA no aprovecha el segundo doble);
//  - con jugada: juega la ficha que elija `pick` (por defecto la de menos puntos) y cierra el turno aunque pudiera seguir con otro doble;
//  - sin jugada: roba del pozo hasta poder jugar (y entonces juega la más baja) o pasa si no queda pozo.
function autoMove(state, seat, pick = lowestMove) {
  const events = [];
  while (state.status === 'playing' && state.turn === seat) {
    if (state.hold) { releaseHold(state); events.push({ type: 'endTurn' }); break; }
    if (state.bonus) { endTurn(state, seat); events.push({ type: 'endTurn' }); break; }
    const m = pick(state, seat);
    if (m) {
      play(state, seat, m.tile, m.side);
      events.push({ type: 'play', tile: m.tile });
      if (state.status === 'playing' && state.turn === seat) { // doble: queda retenido o con extra
        if (state.bonus) endTurn(state, seat); else releaseHold(state);
        events.push({ type: 'endTurn' });
      }
      break;
    }
    if (state.boneyard.length) { draw(state, seat); events.push({ type: 'draw' }); continue; }
    pass(state, seat); events.push({ type: 'pass' }); break;
  }
  return events;
}

// ---- Mano mala: 4 o más dobles en la mano inicial ----
const BAD_HAND_DOUBLES = 4;
const doubleCount = (hand) => hand.filter(isDouble).length;

// Puede reiniciar quien recibió 4+ dobles y aún no ha ejecutado su primer turno (aunque no sea su turno).
function canRedeal(state, seat) {
  return state.status === 'playing' && !state.acted[seat] && doubleCount(state.initialHands[seat]) >= BAD_HAND_DOUBLES;
}

// Cancela la ronda al instante y deja las manos iniciales de todos en el resultado para mostrarlas.
function redeal(state, seat) {
  if (state.status !== 'playing') fail('La ronda ya terminó');
  if (!canRedeal(state, seat)) fail('Ya no puedes reiniciar la ronda');
  state.status = 'ended';
  state.bonus = false;
  state.hold = false;
  state.skipped = [];
  state.result = {
    reason: 'redeal', requester: seat, doubles: doubleCount(state.initialHands[seat]),
    winner: null, unit: null, points: 0, others: 0, own: 0, tie: false,
    hands: state.initialHands.map((h) => h.map((t) => [...t])),
  };
  return state;
}

// Objetivo de la mesa: 50..500 en pasos de 50 (por defecto 100).
function normalizeTarget(v) {
  const n = Math.round(Number(v) / 50) * 50;
  return Number.isFinite(n) && n > 0 ? Math.min(500, Math.max(50, n)) : 100;
}

// Ganador global: unidad con más puntos si alcanzó el objetivo. Si dos unidades empatan arriba,
// no hay ganador todavía y se juega otra ronda.
function matchWinner(scores, target) {
  const top = Math.max(...scores);
  if (top < target || scores.filter((s) => s === top).length > 1) return null;
  return scores.indexOf(top);
}

// Tiempo agotado: castigo táctico, siempre la ficha válida más baja.
const playLowestValidTile = (state, seat) => autoMove(state, seat, lowestMove);
// Modo automático activado: ficha válida al azar.
const playRandomValidTile = (state, seat) => autoMove(state, seat, randomMove);

module.exports = { playLowestValidTile, playRandomValidTile, randomMove, canRedeal, redeal, doubleCount, releaseHold, lowestMove, autoMove, normalizeTarget, matchWinner, newRound, legalMoves, checkGameBlocked, play, draw, pass, endTurn, ends, handPips, unitOf, findStarter, fullSet };
