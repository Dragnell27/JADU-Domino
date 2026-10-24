# JADU Domino

Dominó multijugador en tiempo real para navegador. Mesas de 2, 3 o 4 jugadores (individual o por parejas), chat de texto y de voz, modo automático, reconexión a la partida y versión instalable (PWA) que se puede abrir a pantalla completa en el móvil.

- **Servidor:** Node.js + Express + Socket.io. El servidor es la autoridad: reparte, valida cada jugada, controla los turnos y el reloj.
- **Cliente:** HTML, CSS y JavaScript sin framework ni paso de compilación obligatorio.

---

## Contenido

1. [Inicio rápido](#inicio-rápido)
2. [Cómo se juega](#cómo-se-juega)
3. [Reglas implementadas](#reglas-implementadas)
4. [Funciones de la mesa](#funciones-de-la-mesa)
5. [Móvil, PWA y pantalla completa](#móvil-pwa-y-pantalla-completa)
6. [Configuración](#configuración)
7. [Estructura del proyecto](#estructura-del-proyecto)
8. [Arquitectura](#arquitectura)
9. [Eventos de Socket.io](#eventos-de-socketio)
10. [Pruebas](#pruebas)
11. [Producción y despliegue](#producción-y-despliegue)
12. [Seguridad y privacidad](#seguridad-y-privacidad)
13. [Limitaciones conocidas](#limitaciones-conocidas)
14. [Personalización](#personalización)

---

## Inicio rápido

Requisitos: **Node.js 18 o superior**.

```bash
npm install
npm start
```

Abre <http://localhost:3000>. Para jugar con otras personas, comparte la dirección del servidor (en la misma red local usa la IP de tu equipo, por ejemplo `http://192.168.1.20:3000`).

| Comando | Qué hace |
|---|---|
| `npm start` | Arranca el servidor sirviendo `public/` (desarrollo). |
| `npm test` | Ejecuta las pruebas del motor de reglas. |
| `npm run build` | Genera `dist/` con JS, CSS y HTML minificados. |
| `npm run start:prod` | Compila y arranca sirviendo `dist/` (`node server.js --dist`). |

---

## Cómo se juega

1. **Registro:** escribe tu nombre de usuario y elige un avatar entre los 10 disponibles (si no eliges, se asigna uno al azar). El navegador recuerda tu nombre y avatar para la próxima vez.
2. **Lobby:** crea una mesa (2, 3 o 4 jugadores, individual o por parejas, puntos objetivo de 50 a 500) o únete a una de las mesas abiertas de la lista.
3. **Sala de espera:** cuando la mesa se llena, el anfitrión pulsa **Iniciar**.
4. **Mesa:** en tu turno arrastra una ficha de tu mano a una punta del tablero, o tócala para seleccionarla y toca la punta donde quieres jugarla. Las fichas que no encajan se atenúan.
5. **Pozo:** si no tienes jugada y quedan fichas en el pozo, se abre un modal con las fichas boca abajo; toca una para robarla.
6. **Fin de ronda:** se muestran los puntos y un visor del tablero final. El anfitrión reparte la siguiente ronda; al llegar al puntaje objetivo hay un ganador global y opción de revancha.

---

## Reglas implementadas

**Fichas y reparto**
- Juego doble-seis de 28 fichas; 7 fichas por jugador. Con 2 o 3 jugadores sobran fichas y forman el pozo; con 4 jugadores no hay pozo.

**Apertura y turnos**
- La primera ronda abre quien tiene el 6|6; si nadie lo tiene, abre quien tiene la ficha más alta. La apertura es libre (cualquier ficha).
- Turnos en sentido horario. En parejas, los asientos 1 y 3 contra 2 y 4.

**Jugar fichas**
- Una ficha solo se juega si uno de sus lados coincide con una punta del tablero.
- Los dobles se colocan cruzados.
- **Doble múltiple:** tras jugar un doble puedes jugar otro doble en el mismo turno. Para que los rivales no deduzcan si tenías otro doble, el turno se cede tras una pausa aleatoria de 0,5 a 1,2 s.

**Pozo, pase y salto**
- Sin jugada y con pozo: se roba hasta poder jugar. El pozo es público (todos ven cuántas fichas quedan) pero la ficha que sale es desconocida.
- Sin jugada y con el pozo vacío: se pasa. Si un jugador no puede jugar y el pozo está vacío, su turno se salta solo y se avisa a la mesa.

**Fin de ronda y puntos**
- **Dominó:** gana quien se queda sin fichas.
- **Tranca:** inmediata; ocurre en cuanto ningún jugador puede jugar y el pozo está vacío. Gana quien tiene menos puntos en mano; en empate gana quien salió primero.
- **Puntaje de la ronda:** suma de las fichas de los rivales menos la suma de las propias (por equipo en el modo parejas).
- **Partida:** puntos objetivo configurables de 50 a 500 (de 50 en 50; por defecto 100).

**Mano mala**
- Si recibes 4 o más dobles y aún no has jugado, puedes reiniciar la ronda; se revelan las manos de todos.

**Tiempo y modo automático**
- Cada turno dura **20 s**. Al agotarse, el servidor juega por ti la **ficha válida más baja** (o roba/cede el turno si no hay jugada).
- **Modo automático (interruptor ON/OFF):** mientras esté activo, el servidor juega una **ficha válida al azar** en cada uno de tus turnos y resuelve el robo del pozo por ti. Si el anfitrión lo tiene activo, la siguiente ronda o partida empieza sola.

**Abandono y reconexión**
- Si un jugador cierra la pestaña, pierde conexión o pulsa **Salir** en plena partida, su asiento pasa a **modo automático** y los demás terminan la partida.
- Si fue por desconexión (no por pulsar Salir) y vuelve con el mismo navegador, se le ofrece **volver a la partida** (recupera su mano y se apaga el automático) o descartarla. Quien pulsa **Salir** renuncia al asiento y no se le ofrece volver.
- Si el anfitrión se va, el cargo pasa a un jugador conectado. Si no queda ningún humano conectado, la mesa se cierra a los 5 minutos.
- En la sala de espera (antes de empezar) salir libera el lugar; si sale el anfitrión, la mesa se cierra.

---

## Funciones de la mesa

- **Tablero en serpentina** que escala para que quepa toda la cadena, con dobles cruzados.
- **Mano:** ordénala arrastrando las fichas entre sí (el orden es local); se eleva 10 px al tocar o pasar el cursor.
- **Reloj de turno** en el avatar del jugador, con colores (verde, amarillo, rojo) y un tic en los últimos 5 s.
- **Frases aleatorias** al intentar una jugada inválida (editables en [`public/messages.js`](public/messages.js)).
- **Audio:** efectos y música sintetizados con Web Audio (no hay archivos de audio). 4 modos (completo, solo efectos, solo música, silencio) guardados en el navegador.
- **Chat de texto** con contador de no leídos y límite de frecuencia.
- **Chat de voz** por WebRTC (malla entre jugadores); indicador de quién habla.
- **Visor de tablero final:** congela la mesa al terminar la ronda y muestra las fichas restantes de cada jugador.

---

## Móvil, PWA y pantalla completa

- Diseño adaptable: vertical compacto, horizontal con la mano de pie en una sola fila, zonas seguras (notch) y objetivos táctiles amplios.
- **Botón de pantalla completa** (Android, escritorio e iPad). En iPhone Apple no permite forzarla.
- **Botón de instalar:** en Android/Chrome abre el diálogo nativo de instalación. En iOS muestra los pasos: Compartir → *Añadir a pantalla de inicio*.
- **Manifiesto** ([`public/manifest.json`](public/manifest.json)): nombre JADU Domino, pantalla completa, orientación horizontal, iconos normales y *maskable*.
- **Service Worker** ([`public/sw.js`](public/sw.js)): guarda en caché el juego (red primero para HTML/JS/CSS; caché primero para imágenes). Sin conexión carga la pantalla de inicio, pero no se puede jugar.
- **Pantalla de carga** mientras se conecta el WebSocket.
- Meta etiquetas SEO, Open Graph y Twitter Card; las URLs absolutas se rellenan con el dominio desde el que se accede.

> El Service Worker, la instalación y la voz requieren **HTTPS** (o `localhost`).

---

## Configuración

Variables de entorno:

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor. |
| `TURN_SECONDS` | `20` | Segundos por turno. |

Constantes en [`server.js`](server.js): `AUTO_PLAY_MS` (0,8 s antes de jugar en automático), `AUTO_NEXT_MS` (1,5 s antes de repartir sola la siguiente ronda), `EMPTY_TABLE_MS` (5 min de espera con la mesa sin humanos) y la pausa tras un doble (en `armTimer`).

Ejemplo:

```bash
PORT=8080 TURN_SECONDS=30 npm start
```

(En PowerShell: `$env:PORT=8080; $env:TURN_SECONDS=30; npm start`.)

---

## Estructura del proyecto

```
.
├── server.js              Servidor: Express, Socket.io, salas, temporizadores, reconexión
├── game/
│   ├── engine.js          Motor de reglas (puro, sin red ni DOM)
│   ├── engine.test.js     Pruebas del motor
│   └── layout.test.js     Prueba del algoritmo de tablero (solapes, límites, orientación)
├── public/                Cliente (se sirve tal cual en desarrollo)
│   ├── index.html         Páginas: registro, lobby, espera, mesa; metadatos SEO/PWA
│   ├── client.js          Estado de la UI, render, arrastrar y soltar, reloj, pozo
│   ├── social.js          Chat de texto, voz WebRTC, pantalla completa, instalación
│   ├── layout.js          Algoritmo de tablero en serpentina
│   ├── audio.js           Efectos y música sintetizados (Web Audio)
│   ├── avatars.js         Catálogo de 10 avatares
│   ├── icons.js           Iconos SVG del HUD
│   ├── messages.js        Frases de jugada inválida (editable)
│   ├── style.css          Estilos (madera/casino, responsive)
│   ├── manifest.json      Manifiesto PWA
│   ├── sw.js              Service Worker
│   └── *.png, robots.txt  Iconos, imagen para redes, robots
├── scripts/build.js       Minificación a dist/ (esbuild)
└── dist/                  Salida de `npm run build` (generada)
```

---

## Arquitectura

**El servidor decide, el cliente dibuja.**

- Cada mesa (`room`) guarda asientos, nombres, avatares, puntajes, estado de la partida y temporizadores.
- El servidor envía a cada jugador una **vista personalizada** (`roomView`): solo ve su propia mano. La información privada (si puedes jugar otro doble, si tienes mano mala) solo se envía a quien corresponde.
- **Reloj:** el servidor fija cuándo termina el turno (`endsAt`). El cliente calcula el desfase de reloj una sola vez al recibir la sala, de modo que arrastrar o soltar fichas nunca reinicia la cuenta.
- **Motor** ([`game/engine.js`](game/engine.js)): funciones puras sobre el estado (`newRound`, `play`, `draw`, `pass`, `endTurn`, `legalMoves`, `playLowestValidTile`, `playRandomValidTile`, `redeal`, `matchWinner`…). Se prueba sin red.
- **Identidad:** cada navegador guarda un token en `localStorage` y lo envía al registrarse. Con él el servidor reconoce un asiento en automático y permite volver (`rekey` mueve los datos del socket viejo al nuevo).
- **Voz:** malla WebRTC entre jugadores; Socket.io solo hace de señalización. STUN público de Google, sin TURN.

---

## Eventos de Socket.io

**Cliente → servidor:** `setName`, `createRoom`, `joinRoom`, `leaveRoom`, `rejoin`, `forfeit`, `startGame`, `nextRound`, `rematch`, `play`, `draw`, `endTurn`, `pass`, `auto`, `redeal`, `chat`, `voice`, `signal`.

**Servidor → cliente:** `named`, `rooms` (lista de mesas), `room` (vista de la mesa; `null` = fuera de mesa), `notice` (aviso), `timeout` (el servidor jugó por alguien), `skipped`, `chat`, `chatHistory`, `signal`, `resume` (oferta de volver a una partida).

---

## Pruebas

```bash
npm test                      # motor de reglas
node game/layout.test.js      # tablero: solapes, límites y orientación de dobles
```

Las pruebas del motor cubren apertura, dobles múltiples, tranca, puntajes, mano mala, salto de turno, pozo, ficha más baja y ficha aleatoria. No hay pruebas automáticas de la interfaz, la voz ni los dispositivos reales.

---

## Producción y despliegue

```bash
npm run start:prod
```

- Sirve la versión minificada (`dist/`), con compresión y cabeceras de seguridad.
- Pon el servicio detrás de **HTTPS** (proxy inverso o túnel). Si hay proxy, que reenvíe `X-Forwarded-Proto` y `Host`, y que permita **WebSocket**.
- Las URLs de Open Graph se generan con el dominio de la petición.
- El estado vive en memoria: reiniciar el servidor borra las mesas. Una sola instancia (sin balanceo entre varias).

Para probar en el móvil con un túnel (por ejemplo túneles de VS Code o similares), expón el puerto 3000 y abre la URL HTTPS que te da.

---

## Seguridad y privacidad

- **CSP estricta:** solo recursos del mismo origen; además `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` y `Permissions-Policy` (micrófono solo de la propia página).
- Los textos de chat se insertan como texto (no HTML) y los nombres se escapan.
- Límite de longitud y de frecuencia en el chat (5 mensajes cada 4 s).
- Validación de todas las acciones en el servidor (turno, asiento, jugada legal).
- No hay cuentas ni contraseñas: el token del navegador solo sirve para recuperar un asiento.

---

## Limitaciones conocidas

- **Identidad por navegador:** si se borran los datos del sitio o se cambia de dispositivo, no se recupera el asiento. Quien copie el token podría ocuparlo.
- **Voz:** solo STUN; detrás de algunas redes (NAT estrictos) puede no conectar sin un servidor TURN. Requiere HTTPS.
- **iPhone:** no permite pantalla completa por API; se usa la instalación en pantalla de inicio. Safari y Firefox no se han probado a fondo.
- **Fichas en móvil vertical estrecho:** son pequeñas (unos 37 px de ancho); en horizontal con mano de pie miden unos 30×60 px en pantallas de 667 px.
- **Privacidad tras un doble:** la pausa aleatoria da protección parcial; un rival atento puede notar patrones.
- **Persistencia:** sin base de datos; no hay historial de partidas ni ranking.
- **Probado** con pruebas automáticas del motor, bots de Socket.io y capturas de Chrome sin interfaz; no con dispositivos reales ni dos máquinas en voz real.

---

## Personalización

- **Frases de jugada inválida:** edita la lista en [`public/messages.js`](public/messages.js).
- **Avatares:** catálogo en [`public/avatars.js`](public/avatars.js).
- **Tiempo por turno:** variable `TURN_SECONDS`.
- **Pausa tras un doble, retrasos del automático y espera de mesa vacía:** constantes en [`server.js`](server.js).
- **Colores y tipografía:** variables y reglas en [`public/style.css`](public/style.css); colores de marca también en `manifest.json` y `theme-color`.
- **Imagen para redes:** [`public/og-image.png`](public/og-image.png) (1200×630).
