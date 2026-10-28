// Chat de texto y chat de voz de la mesa.
// - Texto: mensajes por Socket.io a todos los de la mesa (con historial y contador de no leídos).
// - Voz: WebRTC entre jugadores (malla P2P, máx. 3 conexiones por jugador); Socket.io solo hace de
//   señalización. Cada jugador puede entrar/salir de la voz y silenciar su micrófono.
// Usa globals de client.js: socket, room, $, toast, esc, AudioManager.

// ---------------------------------------------------------------- Chat de texto
const Chat = { open: false, unread: 0 };
const chatList = $('chatList');

const myPid = () => (room ? room.myPid || null : null);
const emojiOf = (id) => (DominoAvatars.byId(id) || DominoAvatars.AVATARS[0]).emoji;

function addChatMessage(m, silent) {
  const mine = m.pid === myPid();
  const li = document.createElement('li');
  li.className = 'msg' + (mine ? ' mine' : '');
  const time = new Date(m.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // textContent: el texto de otros jugadores nunca se interpreta como HTML
  const av = document.createElement('span'); av.className = 'm-av'; av.textContent = emojiOf(m.avatar);
  const body = document.createElement('div'); body.className = 'm-body';
  const head = document.createElement('div'); head.className = 'm-head'; head.textContent = `${mine ? 'Tú' : m.name} · ${time}`;
  const txt = document.createElement('div'); txt.className = 'm-text'; txt.textContent = m.text;
  body.append(head, txt); li.append(av, body);
  chatList.appendChild(li);
  while (chatList.children.length > 80) chatList.firstChild.remove();
  chatList.scrollTop = chatList.scrollHeight;
  if (!silent && !mine && !Chat.open) { Chat.unread++; renderUnread(); AudioManager.play('msg'); }
}
function renderUnread() {
  const b = $('chatBadge');
  b.hidden = Chat.unread === 0;
  b.textContent = Chat.unread > 9 ? '9+' : String(Chat.unread);
  $('chatBtn').classList.toggle('alert', Chat.unread > 0);
}
function setChatOpen(open) {
  Chat.open = open;
  $('chat').hidden = !open;
  if (open) { Chat.unread = 0; renderUnread(); chatList.scrollTop = chatList.scrollHeight; setTimeout(() => $('chatInput').focus(), 50); }
}
function sendChat(text) {
  text = String(text).trim();
  if (text) socket.emit('chat', { text });
}

$('chatBtn').onclick = (e) => { e.stopPropagation(); setChatOpen(!Chat.open); };
$('chatClose').onclick = () => setChatOpen(false);
$('chatForm').onsubmit = (e) => { e.preventDefault(); sendChat($('chatInput').value); $('chatInput').value = ''; };
document.querySelectorAll('#chatQuick button').forEach((b) => (b.onclick = () => sendChat(b.textContent)));
socket.on('chat', (m) => addChatMessage(m, false));
socket.on('chatHistory', (list) => { chatList.innerHTML = ''; list.forEach((m) => addChatMessage(m, true)); });

// ---------------------------------------------------------------- Voz (WebRTC)
const Voice = { on: false, muted: true, stream: null, peers: new Map(), ctx: null, analysers: new Map(), timer: null };
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
const sendSignal = (to, data) => socket.emit('signal', { to, data });

function watchSpeaking(key, stream) {
  try {
    Voice.ctx = Voice.ctx || new (window.AudioContext || window.webkitAudioContext)();
    Voice.ctx.resume();
    const an = Voice.ctx.createAnalyser(); an.fftSize = 512;
    Voice.ctx.createMediaStreamSource(stream).connect(an);
    Voice.analysers.set(key, an);
    if (!Voice.timer) Voice.timer = setInterval(tickSpeaking, 180);
  } catch (e) { /* sin indicador de voz */ }
}
function tickSpeaking() {
  const speaking = new Set(), buf = new Uint8Array(256);
  Voice.analysers.forEach((an, key) => {
    an.getByteTimeDomainData(buf);
    let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
    if (Math.sqrt(s / buf.length) > 0.04 && !(key === myPid() && Voice.muted)) speaking.add(key);
  });
  document.querySelectorAll('[data-pid]').forEach((e) => e.classList.toggle('speaking', speaking.has(e.dataset.pid)));
}

function makePeer(pid, initiator) {
  const pc = new RTCPeerConnection(ICE);
  const peer = { pc, initiator, audio: null, pending: [], polite: myPid() > pid };
  if (Voice.stream) Voice.stream.getAudioTracks().forEach((t) => pc.addTrack(t, Voice.stream));
  else pc.addTransceiver('audio', { direction: 'recvonly' }); // solo escucha
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal(pid, { candidate: e.candidate }); };
  pc.ontrack = (e) => {
    if (peer.audio) return;
    const a = document.createElement('audio');
    a.autoplay = true; a.playsInline = true; a.srcObject = e.streams[0];
    document.body.appendChild(a);
    a.play().catch(() => {});
    peer.audio = a;
    watchSpeaking(pid, e.streams[0]);
  };
  pc.onnegotiationneeded = async () => {
    if (!peer.initiator) return;
    try { await pc.setLocalDescription(); sendSignal(pid, { sdp: pc.localDescription }); } catch (e) { /* se reintenta al reconectar */ }
  };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') dropPeer(pid); };
  Voice.peers.set(pid, peer);
  return peer;
}
function dropPeer(pid) {
  const p = Voice.peers.get(pid);
  if (!p) return;
  p.pc.close();
  if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
  Voice.analysers.delete(pid);
  Voice.peers.delete(pid);
}

// Negociación con "peer educado" para resolver el caso de dos ofertas simultáneas.
async function onSignal({ from, data }) {
  if (!Voice.on) return;
  let peer = Voice.peers.get(from);
  try {
    if (data.sdp) {
      if (!peer) peer = makePeer(from, false);
      const pc = peer.pc;
      const collision = data.sdp.type === 'offer' && pc.signalingState !== 'stable';
      if (collision && !peer.polite) return; // ignoramos su oferta; contestará la nuestra
      await pc.setRemoteDescription(data.sdp);
      peer.pending.splice(0).forEach((c) => pc.addIceCandidate(c).catch(() => {}));
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription();
        sendSignal(from, { sdp: pc.localDescription });
      }
    } else if (data.candidate && peer) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.pending.push(data.candidate);
    }
  } catch (e) { console.warn('voz:', e); }
}
socket.on('signal', onSignal);

async function joinVoice() {
  if (Voice.on) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection) {
    return toast('Tu navegador no soporta voz (se necesita HTTPS)');
  }
  try {
    Voice.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    Voice.muted = false;
  } catch (e) {
    Voice.stream = null; Voice.muted = true;
    toast('Sin acceso al micrófono: solo escucharás a los demás');
  }
  Voice.on = true;
  if (Voice.stream) watchSpeaking(myPid(), Voice.stream);
  socket.emit('voice', { on: true, muted: Voice.muted });
  // Quien entra llama a los que ya estaban en la voz.
  room.people.forEach((p) => { if (p.pid !== myPid() && p.voice) makePeer(p.pid, true); }); // jugadores y observadores
  renderVoice();
}
function leaveVoice(notify = true) {
  if (!Voice.on && !Voice.stream) return;
  [...Voice.peers.keys()].forEach(dropPeer);
  if (Voice.stream) Voice.stream.getTracks().forEach((t) => t.stop());
  Voice.analysers.clear();
  Voice.stream = null; Voice.on = false; Voice.muted = true;
  if (notify) socket.emit('voice', { on: false });
  renderVoice();
}
function toggleMic() {
  if (!Voice.on) return joinVoice();
  if (!Voice.stream) { leaveVoice(); return joinVoice(); } // reintenta pedir el micrófono
  Voice.muted = !Voice.muted;
  Voice.stream.getAudioTracks().forEach((t) => (t.enabled = !Voice.muted));
  socket.emit('voice', { on: true, muted: Voice.muted });
  renderVoice();
}

function renderVoice() {
  const btn = $('micBtn');
  const state = !Voice.on ? 'off' : Voice.muted ? 'muted' : 'live';
  btn.dataset.state = state;
  setIcon(btn.querySelector('.ico'), state === 'muted' ? 'micOff' : 'mic');
  btn.title = { off: 'Unirse al chat de voz', muted: 'Activar micrófono', live: 'Silenciar micrófono' }[state];
  btn.setAttribute('aria-label', btn.title);
  $('voiceLeave').hidden = !Voice.on;
  $('voiceStatus').textContent = !Voice.on ? 'Voz desactivada' : Voice.muted ? 'En voz · micrófono silenciado' : 'En voz · micrófono activo';
  document.querySelectorAll('.mic-btn').forEach((b) => {
    b.dataset.state = state;
    b.textContent = { off: '🎤', muted: '🔇', live: '🎙️' }[state];
  });
}
$('micBtn').onclick = toggleMic;
$('voiceLeave').onclick = () => leaveVoice();
document.addEventListener('click', (e) => { if (e.target.closest('.mic-btn')) toggleMic(); });

// Cada actualización de la sala: conectar/desconectar según quién esté en la voz.
socket.on('room', (r) => {
  document.body.classList.toggle('in-room', !!r);
  if (!r) { leaveVoice(false); setChatOpen(false); chatList.innerHTML = ''; Chat.unread = 0; renderUnread(); return; }
  if (Voice.on) {
    Voice.peers.forEach((_, pid) => { const p = r.people.find((x) => x.pid === pid); if (!p || !p.voice) dropPeer(pid); });
  }
  renderVoice();
});
renderVoice();

// ---------------------------------------------------------------- Pantalla completa
// Android/escritorio: Fullscreen API. iPhone no la ofrece: se indica cómo instalar el juego (sin barra del navegador).
(function () {
  const btn = $('fsBtn'), de = document.documentElement;
  const standalone = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return; // ya está sin navegador
  const request = de.requestFullscreen || de.webkitRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  const isFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!request && !ios) return;
  btn.hidden = false;
  const render = () => {
    setIcon(btn.querySelector('.ico'), isFs() ? 'shrink' : 'expand');
    btn.title = btn.ariaLabel = isFs() ? 'Salir de pantalla completa' : 'Pantalla completa';
  };
  btn.onclick = () => {
    if (!request) return toast('En iPhone: Compartir → «Añadir a pantalla de inicio» y ábrelo desde el icono para jugar sin barras', 'info', 8000);
    if (isFs()) return exit.call(document);
    Promise.resolve(request.call(de, { navigationUI: 'hide' })).catch(() => toast('Tu navegador no permitió la pantalla completa'));
  };
  document.addEventListener('fullscreenchange', render);
  document.addEventListener('webkitfullscreenchange', render);
  render();
})();

// ---------------------------------------------------------------- Instalar app (sin barras del navegador)
// Chrome/Android/escritorio: diálogo nativo (beforeinstallprompt). iOS: no hay API, se muestran los pasos.
(function () {
  const btn = $('installBtn');
  if (matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone) return;
  let deferred = null;
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) btn.hidden = false;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; btn.hidden = false; });
  addEventListener('appinstalled', () => { deferred = null; btn.hidden = true; toast('¡App instalada! Ábrela desde su icono'); });
  btn.onclick = async () => {
    if (deferred) { deferred.prompt(); await deferred.userChoice.catch(() => {}); deferred = null; btn.hidden = true; return; }
    toast('Compartir → «Añadir a pantalla de inicio», y ábrelo desde el icono', 'info', 8000);
  };
})();
