// Genera dist/: copia public/ minificando JS y CSS (esbuild). Uso: npm run build  ·  servir: node server.js --dist
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'public'), OUT = path.join(__dirname, '..', 'dist');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let before = 0, after = 0;
for (const f of fs.readdirSync(SRC)) {
  const src = path.join(SRC, f), dst = path.join(OUT, f);
  const raw = fs.readFileSync(src);
  before += raw.length;
  let out = raw;
  if (/\.(js|css)$/.test(f)) {
    // Scripts clásicos (globales compartidos entre archivos): sin bundling ni renombrado de variables globales.
    out = Buffer.from(esbuild.transformSync(raw.toString('utf8'), { loader: f.endsWith('.css') ? 'css' : 'js', minify: true, legalComments: 'none', target: 'es2019' }).code);
  } else if (f === 'index.html') {
    out = Buffer.from(raw.toString('utf8').replace(/>\s+</g, '><').replace(/\s*[\r\n]+\s*/g, ' '));
  }
  after += out.length;
  fs.writeFileSync(dst, out);
}
console.log(`dist/ listo: ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB`);
