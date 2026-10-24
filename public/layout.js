// Algoritmo del paño: la cadena crece desde la ficha de origen hacia ambos lados y serpentea.
// Brazo derecho: derecha -> baja -> izquierda -> baja ...; brazo izquierdo es su simétrico (sube).
// Los dobles se colocan cruzados respecto al sentido de la cadena. Todo en px, centro (0,0) = origen.
(function (root) {
  // cr = semiancho transversal de la última ficha colocada (los dobles cruzados son más anchos).
  function makeArm(x, y, dx, vdir, cr) {
    return { px: x, py: y, dx, dy: 0, hx: dx, vdir, run: 0, cr };
  }

  function turn(a, s, toVertical) {
    const ex = toVertical ? 0 : -a.hx, ey = toVertical ? a.vdir : 0;
    // La esquina cuelga de la mitad exterior de la última ficha, fuera de su ancho transversal.
    a.px += -a.dx * s / 2 + ex * a.cr;
    a.py += -a.dy * s / 2 + ey * a.cr;
    a.dx = ex; a.dy = ey; a.run = 0;
    if (!toVertical) a.hx = ex;
  }

  // Coloca una ficha en el brazo (muta el brazo). inner/outer = valores del lado cercano/lejano al origen.
  function place(a, s, lim, dbl, inner, outer) {
    for (;;) {
      const along = dbl ? s : 2 * s;
      if (a.dy === 0) {
        if (a.run > 0 && Math.abs(a.px + a.dx * along) > lim) { turn(a, s, true); continue; }
      } else if (a.run >= 2 * s) { turn(a, s, false); continue; }
      break;
    }
    const along = dbl ? s : 2 * s, horiz = a.dy === 0;
    const rect = {
      cx: a.px + a.dx * along / 2, cy: a.py + a.dy * along / 2,
      w: horiz === !dbl ? 2 * s : s, h: horiz === !dbl ? s : 2 * s,
      horiz: !(horiz === dbl), // eje largo horizontal
    };
    // first/second en orden de pantalla (izq→der o arriba→abajo)
    // Rotación (0/90/180/270): sentido de avance del tramo (der 0, abajo 90, izq 180, arriba 270); +90 si es doble.
    rect.rot = ((a.dx > 0 ? 0 : a.dx < 0 ? 180 : a.dy > 0 ? 90 : 270) + (dbl ? 90 : 0)) % 360;
    const outerFirst = a.dx < 0 || a.dy < 0;
    rect.first = outerFirst ? outer : inner;
    rect.second = outerFirst ? inner : outer;
    a.px += a.dx * along; a.py += a.dy * along; a.run += along;
    a.cr = (horiz ? rect.h : rect.w) / 2;
    return rect;
  }

  // board: fichas orientadas [izq, der]; origin: índice de la primera ficha jugada.
  function layout(board, origin, s, width) {
    // La cadena gira al acercarse al borde: margen de ~100px (menos en pantallas estrechas).
    // Un doble cruzado en la esquina sobresale s/2, de ahí el término extra.
    const lim = width / 2 - Math.min(100, width * 0.1) - s / 2;
    const items = [], slots = {};
    const o = board[origin];
    let rightArm, leftArm;
    if (o) {
      const dbl = o[0] === o[1];
      const w = dbl ? s : 2 * s;
      items.push({ key: o.join('-'), cx: 0, cy: 0, w, h: dbl ? 2 * s : s, horiz: !dbl, first: o[0], second: o[1], rot: dbl ? 90 : 0 });
      rightArm = makeArm(w / 2, 0, 1, 1, (dbl ? 2 * s : s) / 2);
      leftArm = makeArm(-w / 2, 0, -1, -1, (dbl ? 2 * s : s) / 2);
      for (let i = origin + 1; i < board.length; i++) {
        const t = board[i];
        items.push({ key: t.join('-'), ...place(rightArm, s, lim, t[0] === t[1], t[0], t[1]) });
      }
      for (let i = origin - 1; i >= 0; i--) {
        const t = board[i];
        items.push({ key: t.join('-'), ...place(leftArm, s, lim, t[0] === t[1], t[1], t[0]) });
      }
      // Casilla donde caería la próxima ficha (sencilla) en cada extremo.
      slots.right = place({ ...rightArm }, s, lim, false, 0, 0);
      slots.left = place({ ...leftArm }, s, lim, false, 0, 0);
    } else {
      slots.center = { cx: 0, cy: 0, w: 2 * s, h: s, horiz: true };
    }
    const rects = [...items, ...Object.values(slots)];
    const minX = Math.min(...rects.map((r) => r.cx - r.w / 2)), maxX = Math.max(...rects.map((r) => r.cx + r.w / 2));
    const minY = Math.min(...rects.map((r) => r.cy - r.h / 2)), maxY = Math.max(...rects.map((r) => r.cy + r.h / 2));
    return { items, slots, minX, minY, width: maxX - minX, height: maxY - minY };
  }

  // Elige el mayor tamaño de ficha con el que todo cabe sin scroll; si no cabe, usa el mínimo (y hay scroll).
  function fit(board, origin, width, height, sizes) {
    sizes = sizes || [58, 52, 46, 40, 34, 29, 25, 22, 19, 16];
    const pad = 24;
    let res;
    for (const s of sizes) {
      res = layout(board, origin, s, width - pad);
      res.s = s;
      if (res.height <= height - pad) break;
    }
    return res;
  }

  const api = { layout, fit };
  if (typeof module !== 'undefined') module.exports = api; else root.DominoLayout = api;
})(this);
