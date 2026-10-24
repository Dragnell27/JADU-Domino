// Catálogo de avatares: lo comparten el cliente (selector y tarjetas) y el servidor (validación).
(function (root) {
  const AVATARS = [
    { id: 'panda', emoji: '🐼', name: 'Panda' },
    { id: 'zorro', emoji: '🦊', name: 'Zorro' },
    { id: 'buho', emoji: '🦉', name: 'Búho' },
    { id: 'pulpo', emoji: '🐙', name: 'Pulpo' },
    { id: 'unicornio', emoji: '🦄', name: 'Unicornio' },
    { id: 'tigre', emoji: '🐯', name: 'Tigre' },
    { id: 'leon', emoji: '🦁', name: 'León' },
    { id: 'rana', emoji: '🐸', name: 'Rana' },
    { id: 'mono', emoji: '🐵', name: 'Mono' },
    { id: 'pinguino', emoji: '🐧', name: 'Pingüino' },
    { id: 'gato', emoji: '🐱', name: 'Gato' },
    { id: 'perro', emoji: '🐶', name: 'Perro' },
    { id: 'conejo', emoji: '🐰', name: 'Conejo' },
    { id: 'oso', emoji: '🐻', name: 'Oso' },
    { id: 'koala', emoji: '🐨', name: 'Koala' },
    { id: 'dragon', emoji: '🐲', name: 'Dragón' },
    { id: 'lobo', emoji: '🐺', name: 'Lobo' },
    { id: 'delfin', emoji: '🐬', name: 'Delfín' },
    { id: 'aguila', emoji: '🦅', name: 'Águila' },
    { id: 'dinosaurio', emoji: '🦖', name: 'Dinosaurio' },
  ];
  const byId = (id) => AVATARS.find((a) => a.id === id);
  const random = () => AVATARS[Math.floor(Math.random() * AVATARS.length)].id;
  const api = { AVATARS, byId, random };
  if (typeof module !== 'undefined') module.exports = api; else root.DominoAvatars = api;
})(this);
