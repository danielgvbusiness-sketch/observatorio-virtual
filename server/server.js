'use strict';

/* ================================================================
   OBSERVATORIO VIRTUAL DE ASTRONOMÍA — Servidor (Fase 2)
   ----------------------------------------------------------------
   Node.js + ws, AUTORITATIVO. Es la única fuente de verdad:
     · Asigna un id único a cada conexión (lo decide el servidor).
     · Mantiene `players` (id → {nombre,color,x,z,rot}) y `selectedPlanet`.
     · Valida posiciones (clampe al radio de la plataforma).
     · Sanitiza nombres (recorta y quita < >).
     · Late-join: envía el estado completo ("welcome") al que entra.
     · Difunde join/move/select/leave al resto de clientes.

   Protocolo (§4 del plan): mensajes JSON con campo "tipo".
     Cliente → Servidor:  join | move | select
     Servidor → Cliente:  welcome | player_joined | player_moved |
                          player_left | planet_selected
   ================================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

/* ----------------------------------------------------------------
   CONSTANTES
   ---------------------------------------------------------------- */
// Mismo límite que usa el cliente (RADIO_PLATAFORMA 9 - margen 0.7).
// Un cliente no puede teletransportarse fuera de la plataforma.
const LIMITE_PLATAFORMA = 8.3;

// Posición de aparición (coincide con el spawn local del cliente).
const POS_SPAWN = { x: 0, z: 4 };

// Puerto: los tiers gratuitos (Render) inyectan PORT en el entorno.
const PUERTO = process.env.PORT || 3000;

/* ----------------------------------------------------------------
   FUENTE DE VERDAD (en memoria; sin base de datos)
   Si el servidor se reinicia, la sala se vacía (aceptable en demo).
   ---------------------------------------------------------------- */
const players = {};        // id → { nombre, color, x, z, rot }
let selectedPlanet = null; // id del último planeta seleccionado (o null)

// Contador para asignar ids únicos. El SERVIDOR decide el id, no el cliente.
let contadorIds = 0;
function nuevoId() {
  contadorIds += 1;
  return 'u' + contadorIds;
}

/* ----------------------------------------------------------------
   VALIDACIÓN / SANITIZADO (autoridad del servidor)
   ---------------------------------------------------------------- */

// Clampe radial: si la posición sale de la plataforma, la trae al borde.
function limitarPosicion(pos) {
  const dist = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
  if (dist > LIMITE_PLATAFORMA) {
    const k = LIMITE_PLATAFORMA / dist;
    pos.x *= k;
    pos.z *= k;
  }
  return pos;
}

// Quita < y >, recorta espacios y limita a 16 caracteres (anti-inyección).
function sanitizarNombre(n) {
  if (typeof n !== 'string') return 'Visitante';
  const limpio = n.replace(/[<>]/g, '').trim().slice(0, 16);
  return limpio.length > 0 ? limpio : 'Visitante';
}

// Acepta solo color hex #rrggbb; si no, usa el cyan por defecto.
function sanitizarColor(c) {
  return (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) ? c : '#22d3ee';
}

// Convierte a número finito o devuelve un valor por defecto.
function aNumero(v, porDefecto) {
  const n = Number(v);
  return Number.isFinite(n) ? n : porDefecto;
}

/* ----------------------------------------------------------------
   SERVIDOR HTTP
   Responde 200 OK a peticiones normales (health check del proveedor).
   El WebSocket viaja sobre ESTE mismo servidor/puerto (requisito de
   los tiers gratuitos, que exponen un único puerto HTTP).
   ---------------------------------------------------------------- */
// Carga el cliente (index.html, en la raíz del repo: un nivel por encima
// de /server) UNA vez al arrancar. El MISMO servicio sirve el cliente y el
// WebSocket → una sola URL, sin tener que escribir ?ws=wss://… a mano.
const RUTA_CLIENTE = path.join(__dirname, '..', 'index.html');
let htmlCliente = null;
try {
  htmlCliente = fs.readFileSync(RUTA_CLIENTE);
  console.log('[http] index.html cargado (' + htmlCliente.length + ' bytes).');
} catch (e) {
  console.warn('[http] No se halló index.html en ' + RUTA_CLIENTE +
               '; se servirá solo el texto de estado. (' + e.message + ')');
}

const servidorHttp = http.createServer((req, res) => {
  const ruta = (req.url || '/').split('?')[0];
  // Sirve el cliente en "/" e "/index.html". El cliente, al cargarse por
  // http(s), abre el WebSocket contra ESTE mismo origen automáticamente.
  if (htmlCliente && (ruta === '/' || ruta === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlCliente);
    return;
  }
  // Cualquier otra ruta (incluido el health check del proveedor): 200 OK.
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Observatorio Virtual — servidor WebSocket activo.');
});

/* ----------------------------------------------------------------
   SERVIDOR WEBSOCKET (adjunto al HTTP)
   ---------------------------------------------------------------- */
const wss = new WebSocketServer({ server: servidorHttp });

// Envía un objeto como JSON a un cliente concreto (si está abierto).
function enviar(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Difunde un objeto a todos los clientes; opcionalmente excluye un id.
function difundir(obj, exceptoId) {
  wss.clients.forEach((cliente) => {
    if (cliente.readyState === WebSocket.OPEN && cliente.id !== exceptoId) {
      enviar(cliente, obj);
    }
  });
}

// Construye el array de players para el mensaje "welcome".
function listaPlayers() {
  return Object.keys(players).map((id) => ({
    id: id,
    nombre: players[id].nombre,
    color: players[id].color,
    x: players[id].x,
    z: players[id].z,
    rot: players[id].rot
  }));
}

wss.on('connection', (ws) => {
  // 1) El servidor asigna el id de esta conexión.
  ws.id = nuevoId();
  console.log('[conexión] nuevo cliente: ' + ws.id +
              ' (en sala: ' + Object.keys(players).length + ')');

  // 2) Late-join: enviar SOLO a este cliente el estado completo actual.
  //    (Aún no está en `players`; entra al map cuando mande "join".)
  enviar(ws, {
    tipo: 'welcome',
    tuId: ws.id,
    players: listaPlayers(),
    selectedPlanet: selectedPlanet
  });

  // 3) Mensajes entrantes del cliente.
  ws.on('message', (datos) => {
    let msg;
    try {
      msg = JSON.parse(datos);
    } catch (e) {
      return; // mensaje no-JSON: se ignora
    }
    if (!msg || typeof msg.tipo !== 'string') return;

    switch (msg.tipo) {

      // ---- join: el cliente se presenta con nombre y color ----
      case 'join': {
        const nombre = sanitizarNombre(msg.nombre);
        const color = sanitizarColor(msg.color);
        players[ws.id] = {
          nombre: nombre,
          color: color,
          x: POS_SPAWN.x,
          z: POS_SPAWN.z,
          rot: 0
        };
        console.log('[join] ' + nombre + ' (' + ws.id + ')');

        // Avisar a los DEMÁS de que entró un jugador.
        difundir({
          tipo: 'player_joined',
          id: ws.id,
          nombre: nombre,
          color: color,
          x: POS_SPAWN.x,
          z: POS_SPAWN.z
        }, ws.id);
        break;
      }

      // ---- move: actualización de posición (ya viene con throttle) ----
      case 'move': {
        const p = players[ws.id];
        if (!p) return; // aún no hizo join
        const pos = limitarPosicion({
          x: aNumero(msg.x, p.x),
          z: aNumero(msg.z, p.z)
        });
        p.x = pos.x;
        p.z = pos.z;
        p.rot = aNumero(msg.rot, p.rot);

        // Reenviar a los demás (el emisor ya se pinta por input directo).
        difundir({
          tipo: 'player_moved',
          id: ws.id,
          x: p.x,
          z: p.z,
          rot: p.rot
        }, ws.id);
        break;
      }

      // ---- select: el cliente seleccionó un planeta ----
      case 'select': {
        const p = players[ws.id];
        if (!p) return;
        if (typeof msg.planetId !== 'string') return;
        selectedPlanet = msg.planetId;

        // La selección se replica a TODOS (incluido el emisor).
        difundir({
          tipo: 'planet_selected',
          planetId: selectedPlanet,
          porId: ws.id,
          porNombre: p.nombre
        });
        break;
      }

      default:
        // tipo desconocido: se ignora
        break;
    }
  });

  // 4) Desconexión: limpiar del map y avisar a los demás.
  ws.on('close', () => {
    const p = players[ws.id];
    if (p) {
      console.log('[desconexión] ' + p.nombre + ' (' + ws.id + ')');
      delete players[ws.id];
      difundir({ tipo: 'player_left', id: ws.id }, ws.id);
    } else {
      console.log('[desconexión] ' + ws.id + ' (sin join)');
    }
  });

  // Evita que un error de socket tumbe el proceso.
  ws.on('error', (err) => {
    console.warn('[error socket] ' + ws.id + ': ' + err.message);
  });
});

/* ----------------------------------------------------------------
   ARRANQUE
   ---------------------------------------------------------------- */
servidorHttp.listen(PUERTO, () => {
  console.log('========================================================');
  console.log(' Observatorio Virtual — servidor escuchando');
  console.log(' HTTP/WebSocket en el puerto ' + PUERTO);
  console.log(' Cliente:  http://localhost:' + PUERTO + '/  (sirve index.html + WS)');
  console.log('========================================================');
});
