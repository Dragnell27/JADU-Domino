// Prueba del serpenteo: sin solapes y dentro del ancho disponible en partidas simuladas.
const assert = require('assert');
const L = require('../public/layout.js');
const E = require('./engine.js');
let overlaps = 0, oob = 0, badOrient = 0, doubles = 0;
for (let i = 0; i < 300; i++) {
  const g = E.newRound(2, 'individual');
  while (g.status === 'playing') {
    if (g.hold) { E.releaseHold(g); continue; }
    const m = E.legalMoves(g, g.turn);
    if (m.length) { const k = Math.floor(Math.random() * m.length); E.play(g, g.turn, m[k].tile, m[k].side); }
    else if (g.boneyard.length) E.draw(g, g.turn);
    else E.pass(g, g.turn);
  }
  for (const W of [320, 800]) {
    const s = 30, r = L.layout(g.board, g.origin, s, W), rs = r.items;
    rs.forEach((A, a) => {
      // Orientación: el eje largo de cada ficha coincide con su rotación (0/180 horizontal, 90/270 vertical);
      // los dobles llevan +90°, es decir, quedan cruzados respecto al sentido del tramo.
      if (A.horiz !== (A.rot % 180 === 0)) badOrient++;
      if (A.first === A.second) doubles++;
      if (Math.abs(A.cx) + A.w / 2 > W / 2 + 1) oob++;
      for (let b = a + 1; b < rs.length; b++) {
        const B = rs[b];
        if (Math.abs(A.cx - B.cx) < (A.w + B.w) / 2 - 1 && Math.abs(A.cy - B.cy) < (A.h + B.h) / 2 - 1) overlaps++;
      }
    });
  }
}
console.log({ overlaps, oob, badOrient, doubles });
assert.strictEqual(badOrient, 0);
assert.strictEqual(overlaps, 0);
assert.strictEqual(oob, 0);
