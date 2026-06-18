# Plan de Implementación — Fase 2 (v2, arquitectura corregida)
## Multiusuario real: servidor Node.js + WebSocket (ws), cliente estático separado, conexión por QR

> **Documento de referencia para Claude Code.** Convierte la demo de la Fase 1 (bots locales)
> en multiusuario real, con un servidor **autoritativo** que sincroniza posiciones de avatares
> y selección de planetas.
>
> **Premisa (no reescribir el cliente):** la Fase 1 ya dejó `EventBus`, `GameState`,
> interpolación (`targetX/targetZ`), la bandera `MODO_RED` y el `NetworkManager` stub.
> La Fase 2 es: (a) crear el servidor; (b) rellenar el `NetworkManager`; (c) desplegar en
> DOS plataformas; (d) generar el QR de acceso. El HUD **no se toca**: solo cambia la fuente de los eventos.

---

## 0. Cambios respecto a la v1 de este plan (LEER)

1. **El servidor WebSocket NO va en Vercel.** Vercel es serverless: cada invocación termina tras
   responder, no mantiene un proceso vivo que sostenga sockets abiertos. Un servidor `ws` no corre
   ahí. El servidor va en **Render** (o Railway/Fly), que mantiene el proceso encendido.
2. **El cliente (`index.html`) SÍ puede ir en Vercel/Netlify/GitHub Pages.** Es estático.
   La arquitectura correcta es separar: cliente estático en un CDN, servidor WebSocket en un host
   con proceso persistente. El cliente se conecta por `wss://` al servidor.
3. **Sin base de datos.** El estado es efímero (quién está en la sala, posiciones, planeta
   seleccionado). Vive en memoria del servidor. Si reinicia, la sala se vacía: aceptable para demo
   y mencionable como punto de escalabilidad/persistencia en la charla.
4. **Acceso por QR.** El link final lleva el `?ws=` incrustado; los asistentes escanean y entran
   sin escribir ni configurar nada.

---

## 1. Arquitectura de la Fase 2

```
                 (CDN estático)                         (proceso persistente)
  Móvil escanea  ┌───────────────┐   carga el HTML   ┌──────────────────────┐
  QR ──────────► │ Vercel/Netlify│ ────────────────► │  index.html (cliente)│
                 │  index.html   │                   └──────────┬───────────┘
                 └───────────────┘                              │ wss://
                                                                ▼
                                              ┌──────────────────────────────┐
                                              │  Render: server.js (Node+ws)  │
                                              │  fuente de verdad en memoria: │
                                              │  players{}, selectedPlanet    │
                                              └──────────────────────────────┘
```

- **Cliente estático** (Vercel/Netlify/GitHub Pages): sirve `index.html`. No tiene lógica de red propia más allá del `NetworkManager`.
- **Servidor autoritativo** (Render): única fuente de verdad. Valida, asigna IDs, sincroniza, hace broadcast.
- **El cliente es "tonto" respecto al estado remoto:** envía intenciones (`join`/`move`/`select`) y pinta lo que el servidor manda, traduciéndolo a eventos del bus.
- **Reutiliza la interpolación de Fase 1:** los `move` entrantes escriben `targetX/targetZ`, no la posición directa.

---

## 2. Estructura de archivos

```
/index.html         ← MISMO archivo de Fase 1; se rellena el NetworkManager. Se publica en Vercel/Netlify.
/server/
  ├── server.js      ← Node + ws, autoritativo. Se despliega en Render.
  └── package.json   ← dependencia "ws", script "start", lee process.env.PORT
```

> Pueden vivir en el mismo repo de GitHub. Render apunta a `/server`; Vercel/Netlify publica la raíz (el `index.html`).

---

## 3. Servidor (`server/server.js`)

### Responsabilidades (autoridad)
1. Aceptar conexiones WebSocket; asignar `id` único por cliente (lo decide el servidor).
2. Mantener la fuente de verdad: `players` (map `id → {nombre,color,x,z,rot}`) y `selectedPlanet`.
3. **Validar posiciones**: clampear `x`/`z` al radio de la plataforma (mismo límite que el cliente).
4. **Sanitizar el nombre**: recortar a ~16 caracteres y quitar `<`/`>`.
5. **Late-join**: al conectar, enviar estado completo solo a ese cliente (`welcome`).
6. **Broadcast** de cada cambio a los demás.
7. Limpiar al desconectar: eliminar del map y avisar `player_left`.

### Detalles de implementación
- `http.createServer` + adjuntar `ws` al mismo servidor; escuchar en `process.env.PORT || 3000`.
  **Razón:** Render expone un único puerto HTTP; el WebSocket va sobre ese mismo servidor.
- Responder `200 OK` en peticiones HTTP normales (health check del proveedor).
- `try/catch` al parsear: un JSON malformado o un tipo desconocido NO debe tumbar el server.
- Sin base de datos: todo en memoria.

---

## 4. Protocolo de mensajes (JSON sobre WebSocket)

Todos los mensajes son objetos con campo `tipo`.

### Cliente → Servidor
| tipo | payload | cuándo |
|---|---|---|
| `join` | `{ nombre, color }` | al conectar y tener nombre/color |
| `move` | `{ x, z, rot }` | al moverse (throttle cliente ~15-20 Hz) |
| `select` | `{ planetId }` | al seleccionar un planeta |

### Servidor → Cliente
| tipo | payload | a quién |
|---|---|---|
| `welcome` | `{ tuId, players:[{id,nombre,color,x,z,rot}], selectedPlanet }` | solo al que entra (late-join) |
| `player_joined` | `{ id, nombre, color, x, z }` | a los demás |
| `player_moved` | `{ id, x, z, rot }` | a los demás |
| `player_left` | `{ id }` | a los demás |
| `planet_selected` | `{ planetId, porId, porNombre }` | a todos |

### Traducción mensaje → EventBus (mantiene el HUD intacto)
| mensaje del servidor | el NetworkManager emite |
|---|---|
| `welcome` | un `player:join` por cada player remoto + `roster:change` + (si hay) `planet:select` |
| `player_joined` | `player:join` + `roster:change` |
| `player_moved` | `player:move` (escribe `targetX/targetZ`) |
| `player_left` | `player:leave` + `roster:change` |
| `planet_selected` | `planet:select` |

> Son exactamente los mismos eventos del §4 de la Fase 1. Por eso el HUD, el feed y el Mapa técnico
> no cambian: ahora `highlightConcept` se dispara por mensajes reales de red.

---

## 5. Cambios en el cliente (`index.html`) — mínimos

1. **Rellenar `NetworkManager`** (ya existe como stub). Cuando hay `?ws=`:
   - Abrir `new WebSocket(urlDe(?ws=))`.
   - `onopen`: enviar `join {nombre, color}`.
   - `onmessage`: parsear y **traducir a eventos del bus** según la tabla del §4.
   - Ignorar mensajes cuyo `id === tuId` (no duplicar al jugador local).
2. **Ganchos de envío:** al moverse el local → `enviarMove(x,z,rot)` (throttle); al seleccionar → `enviarSelect(planetId)`. En modo local no hacen nada.
3. **Badge:** "EN VIVO" cuando el socket está abierto.
4. **Reconexión básica:** si el socket se cierra, reintentar a ~2 s con aviso en el feed ("Reconectando…"). Útil por el cold start del tier gratuito.
5. **Interpolación de remotos:** reusar `actualizarAvataresRemotos` de Fase 1.

### 5b. Panel de QR opcional en el HUD (recomendado para la charla)
- Botón "Invitar" en el HUD que abre un panel con el **QR del link actual** (`location.href`), para
  proyectarlo desde la propia demo sin salir a otra herramienta.
- Generar el QR en cliente con una librería ligera por `<script>` desde cdnjs (ej. `qrcodejs`), respetando la restricción de no-módulos-ES.
- El panel muestra también el link en texto, por si alguien prefiere teclearlo.
- **Refuerza el mensaje de inclusión:** el QR aparece en pantalla, el asistente escanea y entra; nadie instala nada.

> Nada de esto toca el render ni el HUD existente: es un panel nuevo + el NetworkManager.

---

## 6. `server/package.json`

```json
{
  "name": "observatorio-servidor",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": { "ws": "^8.18.0" },
  "engines": { "node": ">=18" }
}
```

---

## 7. Despliegue paso a paso (DOS plataformas)

### 7a. Servidor en Render (tier gratuito)
> Render se elige por: tier gratuito real, soporta WebSocket sobre HTTPS (`wss://`), proceso
> persistente, deploy desde GitHub. Alternativas equivalentes: Railway, Fly.
> **No usar Vercel/Netlify para el servidor:** son serverless y no sostienen un WebSocket abierto.

1. **Probar local primero:** en `/server`, `npm install` y `npm start`. Abrir el cliente con
   `index.html?ws=ws://localhost:3000` en dos pestañas; comprobar que se ven entre sí.
2. **Subir a GitHub** (`index.html` en la raíz, carpeta `server/`).
3. **Render → New → Web Service** → conectar el repo:
   - *Root Directory:* `server`
   - *Build Command:* `npm install`
   - *Start Command:* `npm start`
   - *Instance Type:* Free
4. Render entrega `https://TUAPP.onrender.com`. El WebSocket es `wss://TUAPP.onrender.com`.

### 7b. Cliente en Vercel o Netlify (estático)
> El `index.html` es estático: cualquiera de los dos sirve. Vercel y Netlify NO pueden hostear el
> servidor `ws`, pero SÍ el cliente. Esta separación es la arquitectura correcta.

- **Netlify (drag-and-drop, lo más simple):** arrastrar el `index.html` (o la carpeta) a Netlify Drop → da una URL `https://TUDEMO.netlify.app`.
- **Vercel:** importar el repo; *Framework Preset:* Other; sin build. Da `https://TUDEMO.vercel.app`.
- **GitHub Pages:** activar Pages sobre el repo; sirve el `index.html` de la raíz.

### 7c. Construir el link final y el QR
- Link de acceso: `https://TUDEMO.vercel.app?ws=wss://TUAPP.onrender.com`
  (ojo: `wss`, no `ws`, porque el servidor se sirve sobre HTTPS).
- Generar el QR de ese link (el panel "Invitar" de §5b, o un generador externo para la diapositiva).

### 7d. Cold start (mencionar en la charla, no esconder)
- El plan gratuito de Render **duerme** tras inactividad; la primera conexión tarda ~30-50 s en despertar.
- Para la charla: abrir el link 1 minuto antes para "calentarlo".

---

## 8. Lista de verificación — cierre Fase 2

- [ ] `npm install && npm start` levanta el servidor en local sin errores.
- [ ] Dos pestañas con `?ws=ws://localhost:3000` se ven los avatares moverse mutuamente.
- [ ] La selección de planeta hecha en una pestaña se replica en la otra.
- [ ] Un tercer cliente que entra tarde recibe `welcome` con el estado completo.
- [ ] Al cerrar una pestaña, su avatar desaparece para los demás (`player_left`).
- [ ] El servidor clampea posiciones fuera de límites (probar x/z enormes).
- [ ] El nombre se sanitiza (probar con `<b>hola`).
- [ ] El servidor no se cae con JSON malformado o tipo desconocido.
- [ ] El jugador local no se duplica al recibir sus propios mensajes.
- [ ] El mismo `index.html` corre en local sin `?ws=` (bots) y en vivo con `?ws=` (red).
- [ ] El Mapa técnico resalta filas por eventos reales de red.
- [ ] **Servidor desplegado en Render** responde en `https://...onrender.com` (no Vercel).
- [ ] **Cliente desplegado en Vercel/Netlify** carga el `index.html`.
- [ ] El link `https://CLIENTE?ws=wss://SERVIDOR` funciona desde un móvil con datos móviles.
- [ ] El panel "Invitar" muestra el QR del link actual y al escanearlo se entra a la sala.
- [ ] Reconexión: al dormir/despertar el server, el cliente reintenta y se recupera.

---

## 9. Notas para la charla (usar la arquitectura a favor)

- "Pasar de bots a multiusuario real **no cambió el HUD ni la lógica**: solo cambió la fuente de
  los eventos. Esa separación estado/presentación es lo que en Unity hace el NetworkManager de
  Netcode for GameObjects."
- "El servidor **no puede ir en Vercel**: es serverless y no sostiene una conexión abierta. Hay que
  separarlo en un host con proceso persistente. Saber elegir eso —y asumir su costo— es justo el
  criterio de factibilidad que evalúa este cargo."
- "No hay base de datos porque el estado es efímero. Si esto fuera un aula real con progreso de
  estudiantes, entraría la capa de persistencia y otra decisión de costos."
- "El servidor es autoritativo: valida posiciones y sanitiza nombres. En un aula, esa autoridad
  impide que un estudiante rompa la sesión de los demás."
- "Escanearon un QR y entraron. Sin app, sin VR, en su propio teléfono. Eso es inclusión
  multiplataforma demostrada, no prometida."
