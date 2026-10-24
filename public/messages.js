// Frases para jugadas inválidas (ficha soltada en una punta donde no encaja).
// Edita libremente: añade, cambia o borra líneas. Si la lista queda vacía se usa un mensaje por defecto.
const INVALID_PLAY_MESSAGES = [
  '¡Esa ficha no pega ahí!',
  'Piénsalo bien, por ahí no es...',
  '¡Ilegal! Intenta con otra ficha.',
  'Ese número no coincide con la punta.',
  '¡Cuidado! Esa jugada no es válida.',
  '¿No sabes jugar o que?'
];
const INVALID_PLAY_MS = 2000; // duración del aviso

// Elige una frase al azar, evitando repetir la anterior cuando hay más de una.
let lastInvalidIdx = -1;
function randomInvalidMessage() {
  const list = INVALID_PLAY_MESSAGES;
  if (!list.length) return 'Esa ficha no encaja ahí';
  let i = Math.floor(Math.random() * list.length);
  if (list.length > 1 && i === lastInvalidIdx) i = (i + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length;
  lastInvalidIdx = i;
  return list[i];
}
