const assert = require('assert');
const E = require('./engine');

for (const n of [2, 3, 4]) {
  const s = E.newRound(n, 'individual');
  assert.strictEqual(s.hands.length, n);
  assert(s.hands.every((h) => h.length === 7));
  assert.strictEqual(s.boneyard.length, 28 - 7 * n);
}

const base = (hands, boneyard = [], mode = 'individual') => ({
  numPlayers: hands.length, mode, hands, boneyard, initialHands: hands.map((h) => h.map((x) => [...x])), acted: hands.map(() => false), skipped: [], board: [], turn: 0, passes: 0, status: 'playing', result: null,
});

// Orientación, extremos y turno
let s = base([[[6, 6], [6, 2], [1, 1]], [[2, 3], [5, 5]]]);
E.play(s, 0, [6, 6], 'left');
assert(s.hold); E.releaseHold(s); // tras un doble el turno se retiene y luego se cede
assert.deepStrictEqual(s.skipped, [1]); // el asiento 1 no tiene jugada y no hay pozo: se salta solo
assert.strictEqual(s.turn, 0);
assert.deepStrictEqual(E.ends(s.board), [6, 6]);
assert.throws(() => E.pass(s, 1), /turno/);
E.play(s, 0, [6, 2], 'right');
assert.deepStrictEqual(s.board, [[6, 6], [6, 2]]);
assert.deepStrictEqual(E.ends(s.board), [6, 2]);

// Robar: obligatorio si hay pozo y no hay jugada; no se puede pasar
s = base([[[0, 0]], [[3, 3]]], [[6, 6]]);
s.board = [[1, 2]];
assert.throws(() => E.pass(s, 0), /robar/);
E.draw(s, 0);
assert.strictEqual(s.hands[0].length, 2);
assert.strictEqual(s.turn, 0);

// Dominó: gana quien se queda sin fichas y suma las manos ajenas
s = base([[[1, 2]], [[2, 3], [4, 4]], [[0, 0]]]);
s.board = [[0, 2]];
E.play(s, 0, [1, 2], 'right');
assert.strictEqual(s.result.reason, 'domino');
assert.strictEqual(s.result.points, 13);
assert.strictEqual(s.result.unit, 0);

// Tranca inmediata: nadie tiene jugada -> se cierra en el primer pase, sin esperar al resto
s = base([[[1, 1], [0, 0]], [[5, 5]]]);
s.board = [[6, 6]];
E.pass(s, 0);
assert.strictEqual(s.status, 'ended');
assert.strictEqual(s.result.reason, 'blocked');
assert.strictEqual(s.result.winner, 0);
assert.strictEqual(s.result.points, 10 - 2); // fichas ajenas - propias

// a) Pozo vacío + sin jugadas -> cierre inmediato (ya probado arriba con pase).
// b) Bloqueo de puntas con pozo: extremos 0 y 4, y ninguna ficha fuera de la mesa los tiene
s = base([[[3, 4], [1, 1]], [[5, 5]]], [[2, 2], [1, 6]]);
s.board = [[0, 3]]; s.origin = 0;
E.play(s, 0, [3, 4], 'right');
assert.strictEqual(s.status, 'ended');
assert.strictEqual(s.boneyard.length, 2); // el pozo quedó intacto: nadie come
assert.strictEqual(s.result.reason, 'blocked');
assert.throws(() => E.draw(s, 1), /terminó/);

// Con una ficha útil en el pozo NO hay tranca: el siguiente (sin jugada) debe robar
s = base([[[3, 4], [1, 1]], [[5, 5]]], [[2, 2], [0, 6]]);
s.board = [[0, 3]]; s.origin = 0;
E.play(s, 0, [3, 4], 'right'); // puntas 0 y 4; el [0,6] del pozo encaja en el 0
assert.strictEqual(s.status, 'playing');
assert.strictEqual(s.turn, 1);
assert.throws(() => E.pass(s, 1), /robar/);
E.draw(s, 1); // saca [0,6]
assert.strictEqual(s.status, 'playing');
assert.strictEqual(s.turn, 1);
assert(E.legalMoves(s, 1).length > 0);

// checkGameBlocked: mano, pozo y mesa vacía
s = base([[[1, 1]], [[5, 5]]], [[2, 2]]);
assert(!E.checkGameBlocked(s)); // tablero vacío
s.board = [[0, 6]];
assert(E.checkGameBlocked(s));
s.hands[0] = [[0, 0]];
assert(!E.checkGameBlocked(s));
s.hands[0] = [[1, 1]]; s.boneyard = [[6, 6]];
assert(!E.checkGameBlocked(s));

// Empate exacto: por defecto gana quien salió; con tieRule 'none' nadie suma
s = base([[[1, 2]], [[0, 3]]]);
s.board = [[6, 6]]; s.starter = 1;
E.pass(s, 0);
assert.strictEqual(s.result.tie, true);
assert.strictEqual(s.result.winner, 1);
assert.strictEqual(s.result.points, 3 - 3);
s = base([[[1, 2]], [[0, 3]]]);
s.board = [[6, 6]]; s.tieRule = 'none';
E.pass(s, 0);
assert.strictEqual(s.result.winner, null);
assert.strictEqual(s.result.points, 0);

// Parejas: gana el equipo con menor suma combinada
s = base([[[1, 1]], [[6, 6]], [[0, 2]], [[5, 5]]], [], 'teams');
s.board = [[3, 4]];
E.pass(s, 0);
assert.strictEqual(s.result.unit, 0); // 2+2=4 contra 12+10=22
assert.strictEqual(s.result.points, 22 - 4);

// Doble extra: con extremos 4 y 5 y los dobles 4/4 y 5/5 en mano, juega ambos en un turno
s = base([[[4, 4], [5, 5], [1, 2]], [[0, 4]]]);
s.board = [[4, 5]]; s.origin = 0;
E.play(s, 0, [4, 4], 'left');
assert.strictEqual(s.turn, 0); assert(s.bonus);
assert.deepStrictEqual(E.legalMoves(s, 0).map((m) => m.tile), [[5, 5]]); // solo dobles durante el extra
E.play(s, 0, [5, 5], 'right');
assert(s.hold); E.releaseHold(s);
assert.strictEqual(s.turn, 1); assert(!s.bonus);
// Se puede renunciar al extra
s = base([[[4, 4], [5, 5], [1, 2]], [[0, 4]]]);
s.board = [[4, 5]];
E.play(s, 0, [4, 4], 'left');
E.endTurn(s, 0);
assert.strictEqual(s.turn, 1);
assert.throws(() => E.endTurn(s, 1), /extra/);

// Quién sale: 6/6
assert.strictEqual(E.findStarter([[[1, 2]], [[6, 6]]]), 1);
assert.strictEqual(E.findStarter([[[1, 2]], [[3, 3]]]), 1);
assert.strictEqual(E.findStarter([[[1, 2]], [[3, 4]]]), 1);

// Partida simulada completa: siempre termina sin errores
for (let i = 0; i < 300; i++) {
  const n = 2 + (i % 3);
  const g = E.newRound(n, 'individual');
  for (let steps = 0; g.status === 'playing'; steps++) {
    assert(steps < 500);
    if (g.hold) { E.releaseHold(g); continue; }
    const m = E.legalMoves(g, g.turn);
    if (m.length) E.play(g, g.turn, m[0].tile, m[0].side);
    else if (g.boneyard.length) E.draw(g, g.turn);
    else E.pass(g, g.turn);
  }
  if (g.result.reason === 'blocked') { // invariante: tranca real, nada que encaje queda fuera de la mesa
    const [l, r] = E.ends(g.board);
    const rest = [...g.boneyard, ...g.hands.flat()];
    assert(!rest.some((x) => x.includes(l) || x.includes(r)));
  }
}
// Objetivo y ganador global
assert.strictEqual(E.normalizeTarget(undefined), 100);
assert.strictEqual(E.normalizeTarget(30), 50);
assert.strictEqual(E.normalizeTarget(9999), 500);
assert.strictEqual(E.normalizeTarget(120), 100);
assert.strictEqual(E.normalizeTarget(130), 150);
assert.strictEqual(E.matchWinner([99, 40], 100), null);
assert.strictEqual(E.matchWinner([100, 40], 100), 0);
assert.strictEqual(E.matchWinner([40, 130, 20], 100), 1);
assert.strictEqual(E.matchWinner([120, 120], 100), null); // empate arriba: otra ronda
// Auto / tiempo agotado: se juega la ficha jugable de MENOS puntos
s = base([[[1, 2], [6, 5], [0, 3], [4, 4]], [[2, 2]]]);
s.board = [[2, 3]]; s.origin = 0; // puntas 2 y 3: juegan [1,2] (3 pts) y [0,3] (3 pts); [6,5] y [4,4] no
assert.deepStrictEqual(E.lowestMove(s, 0).tile, [1, 2]); // empate: la primera
s = base([[[6, 2], [1, 2], [0, 3]], [[5, 5]]]);
s.board = [[2, 3]]; s.origin = 0;
assert.deepStrictEqual(E.lowestMove(s, 0).tile, [1, 2]); // 3 pts < 8 pts de [6,2]
s = base([[[6, 2], [4, 3]], [[5, 5]]]);
s.board = [[2, 3]]; s.origin = 0;
assert.deepStrictEqual(E.lowestMove(s, 0).tile, [4, 3]); // 7 < 8
assert.deepStrictEqual(E.lowestMove(base([[[6, 6], [0, 1]], [[1, 1]]]), 0).tile, [0, 1]); // salida: la más baja
s = base([[[6, 2], [1, 2], [0, 3]], [[3, 5]]]);
s.board = [[2, 3]]; s.origin = 0;
const ev = E.autoMove(s, 0);
assert.deepStrictEqual(ev.map((x) => x.type), ['play']);
assert.deepStrictEqual(s.board.length, 2);
assert.strictEqual(s.turn, 1); // pasa al siguiente de inmediato
// Sin jugada y con pozo: roba hasta poder jugar, luego juega la peor
s = base([[[5, 5]], [[0, 0]]], [[0, 2], [4, 4], [3, 3]]); // pop() saca [3,3], luego [4,4], luego [0,2]
s.board = [[0, 6]]; s.origin = 0;
const ev2 = E.autoMove(s, 0).map((x) => x.type);
assert.deepStrictEqual(ev2, ['draw', 'draw', 'draw', 'play']);
// Sin jugada y sin pozo: pasa
s = base([[[5, 5]], [[0, 1]]]);
s.board = [[0, 6]]; s.origin = 0;
assert.deepStrictEqual(E.autoMove(s, 0).map((x) => x.type), ['pass']);
// Doble extra: al agotarse el tiempo solo renuncia (ya había jugado)
s = base([[[4, 4], [5, 5], [1, 2]], [[0, 4]]]);
s.board = [[4, 5]];
E.play(s, 0, [4, 4], 'left');
assert(s.bonus);
assert.deepStrictEqual(E.autoMove(s, 0).map((x) => x.type), ['endTurn']);
assert.strictEqual(s.turn, 1);
// Doble SIN segundo doble: el turno se retiene (igual que cuando sí hay segundo doble) y se cede después
s = base([[[3, 3], [1, 2]], [[3, 5]]]);
s.board = [[0, 3]]; s.origin = 0;
E.play(s, 0, [3, 3], 'right');
assert.strictEqual(s.turn, 0); assert(s.hold); assert(!s.bonus); assert.strictEqual(s.status, 'playing');
assert.throws(() => E.play(s, 0, [1, 2], 'right'), /en curso/);
assert.throws(() => E.pass(s, 0), /en curso/);
assert.throws(() => E.draw(s, 0), /en curso/);
assert.throws(() => E.endTurn(s, 0), /en curso/);
E.releaseHold(s);
assert.strictEqual(s.turn, 1); assert(!s.hold);
assert.throws(() => E.releaseHold(s), /retenido/);
// Un doble que cierra el juego termina al instante, sin retener
s = base([[[3, 3], [1, 1]], [[5, 5]]]);
s.board = [[0, 3]]; s.origin = 0;
E.play(s, 0, [3, 3], 'right');
assert.strictEqual(s.status, 'ended'); assert.strictEqual(s.result.reason, 'blocked'); assert(!s.hold);
// Un doble que vacía la mano es dominó
s = base([[[3, 3]], [[5, 5]]]);
s.board = [[0, 3]]; s.origin = 0;
E.play(s, 0, [3, 3], 'right');
assert.strictEqual(s.result.reason, 'domino');
// Tiempo agotado durante una retención: solo cede el turno
s = base([[[3, 3], [1, 2]], [[3, 5]]]);
s.board = [[0, 3]]; s.origin = 0;
E.play(s, 0, [3, 3], 'right');
assert.deepStrictEqual(E.autoMove(s, 0).map((x) => x.type), ['endTurn']);
assert.strictEqual(s.turn, 1);
// Auto con doble: juega el doble más bajo y cierra el turno al instante (sin retener ni usar el 2º doble)
s = base([[[3, 3], [1, 2]], [[3, 5]]]);
s.board = [[0, 3]]; s.origin = 0;
assert.deepStrictEqual(E.autoMove(s, 0).map((x) => x.type), ['play', 'endTurn']);
assert.strictEqual(s.turn, 1); assert(!s.hold); assert(!s.bonus);
s = base([[[4, 4], [5, 5], [1, 2]], [[0, 4]]]);
s.board = [[4, 5]];
assert.deepStrictEqual(E.autoMove(s, 0).map((x) => x.type), ['play', 'endTurn']); // con 2º doble disponible
assert.strictEqual(s.board.length, 2); assert.strictEqual(s.turn, 1);
assert.deepStrictEqual(s.board[0], [4, 4]); // jugó el 4/4 (8 pts) antes que el 5/5 (10 pts)
// Salto automático de turno: pozo vacío y sin jugada -> se cede al siguiente que sí puede jugar
s = base([[[1, 1], [6, 2]], [[5, 5]], [[2, 3]]]);
s.board = [[6, 4]]; s.origin = 0;
E.play(s, 0, [6, 2], 'left'); // puntas 2 y 4
assert.deepStrictEqual(s.skipped, [1]);
assert.strictEqual(s.turn, 2);
// Con fichas en el pozo NO se salta: el jugador debe robar
s = base([[[6, 2], [1, 1]], [[5, 5]]], [[2, 2]]);
s.board = [[6, 4]]; s.origin = 0;
E.play(s, 0, [6, 2], 'left');
assert.deepStrictEqual(s.skipped, []);
assert.strictEqual(s.turn, 1);
// Si el siguiente no puede y vuelve al mismo jugador, este sigue jugando
s = base([[[6, 2], [2, 2]], [[5, 5]]]);
s.board = [[6, 4]]; s.origin = 0;
E.play(s, 0, [6, 2], 'left');
assert.deepStrictEqual(s.skipped, [1]);
assert.strictEqual(s.turn, 0);

// Mano mala: 4+ dobles iniciales y sin haber ejecutado el primer turno
const bad = () => base([[[0, 0], [1, 1], [2, 2], [3, 3], [4, 5], [1, 2], [0, 6]], [[6, 6], [5, 5], [4, 4], [1, 6], [2, 3], [0, 1], [0, 2]]]);
s = bad(); s.turn = 0;
assert.strictEqual(E.doubleCount(s.hands[0]), 4);
assert(E.canRedeal(s, 0));
assert(!E.canRedeal(s, 1)); // solo 3 dobles
assert.throws(() => E.redeal(s, 1), /reiniciar/);
E.play(s, 0, [4, 5], 'left'); // juega su turno: la opción se bloquea para el resto de la ronda
assert(!E.canRedeal(s, 0));
assert.throws(() => E.redeal(s, 0), /reiniciar/);
// Reiniciar: cancela la ronda y revela las manos iniciales de todos
s = bad(); s.turn = 0;
E.redeal(s, 0);
assert.strictEqual(s.status, 'ended');
assert.strictEqual(s.result.reason, 'redeal');
assert.strictEqual(s.result.requester, 0); assert.strictEqual(s.result.doubles, 4);
assert.deepStrictEqual(s.result.hands, bad().hands);
assert.strictEqual(s.result.points, 0); assert.strictEqual(s.result.unit, null);
assert.throws(() => E.redeal(s, 0), /terminó/);
// Se puede reiniciar sin que sea tu turno, mientras no hayas actuado
s = base([[[6, 5], [1, 2], [0, 3], [4, 1], [5, 1], [2, 4], [0, 1]], [[0, 0], [1, 1], [2, 2], [3, 3], [4, 5], [1, 4], [0, 6]]]);
s.turn = 0;
E.play(s, 0, [1, 2], 'left');
assert(E.canRedeal(s, 1));
E.redeal(s, 1);
assert.strictEqual(s.result.requester, 1);
// Robar también cuenta como haber ejecutado el turno
s = base([[[0, 0], [1, 1], [2, 2], [3, 3], [4, 5], [1, 2], [0, 6]], [[6, 6], [5, 4]]], [[2, 5]]);
s.board = [[3, 6]]; s.origin = 0; s.turn = 0;
E.play(s, 0, [3, 3], 'left'); // juega un doble (turno retenido)
assert(!E.canRedeal(s, 0));

// Modo automático: ficha al azar entre las jugables; expiración: siempre la más baja
{
  const st = base([[[6, 6], [0, 1]], [[1, 1]]]);
  const seen = new Set();
  for (let k = 0; k < 60; k++) {
    const c = JSON.parse(JSON.stringify(st));
    const ev = E.playRandomValidTile(c, 0);
    seen.add(ev.find((x) => x.type === 'play').tile.join('-'));
  }
  assert.ok(seen.has('6-6') && seen.has('0-1'), 'el modo automático juega fichas distintas');
  for (let k = 0; k < 20; k++) {
    const ev = E.playLowestValidTile(JSON.parse(JSON.stringify(st)), 0);
    assert.deepStrictEqual(ev.find((x) => x.type === 'play').tile, [0, 1]);
  }
}

// Auto-juego cuando los rivales se saltan y el turno vuelve al mismo jugador (antes lanzaba "No hay turno retenido")
{
  const st = base([[[6, 6], [6, 2], [2, 2]], [[3, 4], [5, 5]]]);
  E.play(st, 0, [6, 6], 'left'); E.releaseHold(st); // el asiento 1 se salta y el turno vuelve al 0
  [E.playLowestValidTile, E.playRandomValidTile].forEach((fn) => {
    const c = JSON.parse(JSON.stringify(st));
    const ev = fn(c, 0); // juega [6,2] (no doble); el asiento 1 sigue sin jugada, así que vuelve a tocar al 0
    assert.ok(ev.some((x) => x.type === 'play'));
    assert.strictEqual(c.turn, 0);
    assert.ok(!c.hold && !c.bonus);
  });
}

// Privacidad del doble: los demás no ven el doble hasta que su dueño decide (segundo doble o cierre de turno)
{
  // Apertura con doble: la mesa pública queda vacía mientras el turno está retenido
  let st = base([[[6, 6], [6, 2], [2, 2]], [[3, 4], [5, 5], [1, 2]]]);
  E.play(st, 0, [6, 6], 'left');
  assert.deepStrictEqual(E.publicBoard(st).board, []);
  assert.strictEqual(E.publicBoard(st).hidden, 1);
  E.releaseHold(st); // se resuelve: ahora se ve
  assert.deepStrictEqual(E.publicBoard(st).board, [[6, 6]]);
  assert.strictEqual(E.publicBoard(st).hidden, 0);

  // Doble a la derecha y segundo doble: ambos ocultos; el resto de la mesa sí se ve
  st = base([[[6, 6], [6, 2], [2, 2], [1, 1]], [[1, 2], [5, 5], [3, 3]]]);
  E.play(st, 0, [6, 2], 'right'); // no doble: avanza
  assert.strictEqual(E.publicBoard(st).hidden, 0);
  st.turn = 0; st.hold = false; // vuelve a tocar a 0 (el 1 se saltó o se simula)
  E.play(st, 0, [6, 6], 'left');   // doble: pendiente, y tiene otro doble que encaja? [2,2] encaja en el extremo 2
  const pb = E.publicBoard(st);
  assert.strictEqual(pb.hidden, 1);
  assert.strictEqual(pb.board.length, st.board.length - 1);
  assert.ok(!pb.board.some((x) => x[0] === 6 && x[1] === 6));
  assert.strictEqual(st.bonus, true);
  E.play(st, 0, [2, 2], 'right'); // segundo doble
  assert.strictEqual(E.publicBoard(st).hidden, 2);
  if (st.bonus) E.endTurn(st, 0); else E.releaseHold(st); // al ceder el turno, todo se publica
  assert.strictEqual(E.publicBoard(st).hidden, 0);
  assert.strictEqual(E.publicBoard(st).board.length, st.board.length);
}
console.log('OK');
