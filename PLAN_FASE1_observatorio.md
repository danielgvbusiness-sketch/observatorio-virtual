# Plan de Implementación — Fase 1
## Observatorio Virtual de Astronomía (mundo 3D web multiusuario, modo local)

> **Documento de referencia para Claude Code.** Describe QUÉ construir y EN QUÉ ORDEN.
> La Fase 1 es autocontenida: un solo `index.html` con Three.js (cdnjs, r128), sin servidor,
> sin módulos ES, sin localStorage. Avatares-bot simulan el multiusuario.
> El código se diseña pensando en la Fase 2 (WebSocket) para que esa sea un *swap*, no una reescritura.

---

## 0. Contexto (por qué cada decisión importa)

Esta demo es el caso en vivo de una charla técnica para el cargo "Especialista de Tecnologías
para la Educación". La demo debe reforzar tres mensajes:

1. **Profundidad técnica** → modelo cliente-servidor, autoridad, sincronización de estado.
2. **Traducción pedagógica** → un entorno multiusuario es un aula/laboratorio compartido.
3. **Inclusión multiplataforma** → corre con un link en cualquier laptop/celular, sin VR ni instalación.

El relato: *"el mismo modelo conceptual de Unity con Netcode for GameObjects —autoridad de
servidor, sincronización de estado, spawn de jugadores— se demuestra aquí en web con Three.js
porque corre en cualquier dispositivo de un aula"*.

---

## 1. Arquitectura y decisiones (NO improvisar; respetar tal cual)

| Decisión | Qué hacer | Por qué |
|---|---|---|
| Cliente único para 2 fases | `index.html` corre en modo bots si NO hay `?ws=` en la URL; en modo red si SÍ lo hay | En la charla se abre el link "pelado" y luego se pega `?ws=...`: demuestra que la capa de red es intercambiable |
| Bus de eventos | `EventBus` con `on`/`emit`. Eventos canónicos: `player:join`, `player:move`, `player:leave`, `planet:select`, `roster:change` | El HUD/feed/Mapa técnico solo escuchan el bus; no saben si la fuente es un bot o un WebSocket. Hace la Fase 2 un cambio de fuente |
| Estado central | `GameState`: `localPlayer`, `remotePlayers` (map), `selectedPlanet`, `activityFeed` | Modela la "fuente de verdad". En Fase 2 esa fuente vive en el servidor |
| Interpolación desde Fase 1 | Cada avatar tiene `position` y `targetPosition`; el render interpola hacia el objetivo | El Mapa técnico puede afirmar con verdad "interpolación de jugadores remotos" ya en local; se reutiliza en Fase 2 para latencia |
| Three.js r128 | Cargar desde cdnjs vía `<script>` clásico | Restricción dada; sin módulos ES |
| Cámara propia | Coordenadas esféricas (theta, phi, radio). NO usar OrbitControls | Restricción dada |
| Avatares | `CylinderGeometry` (cuerpo) + `SphereGeometry` (cabeza). NO usar `CapsuleGeometry` | `CapsuleGeometry` no existe en r128 |
| Etiquetas de nombre | Proyectar posición 3D a 2D con `vector.project(camera)` sobre divs HTML | Evita `CSS2DRenderer` (no disponible como script suelto fiable en r128) |
| Selección de planetas | `Raycaster` sobre clic/tap | Estándar y robusto |
| Sin persistencia | Nombre/color en memoria | Restricción dada (sin localStorage) |
| Tipografía | Inter desde Google Fonts, fallback `system-ui` | Estética premium pedida |
| Paleta | Navy `#0a0e1a`, cyan `#22d3ee`, glassmorphism (`backdrop-filter: blur`) | Estética cinematográfica pedida |
| Idioma | Todo el código, comentarios y UI en español | Restricción dada |

---

## 2. Estructura de archivos (Fase 1)

```
/index.html   ← TODO inline: <style>, <script src=three.js cdnjs>, <script> de la app
```

Un solo archivo. Nada más en esta fase.

---

## 3. Orden de construcción (12 pasos; cada uno debe verse funcionando antes del siguiente)

### Paso 1 — Esqueleto HTML + CSS estático
- Overlay de **pantalla de entrada**: input de nombre, selector de color (6 swatches), botón "Entrar".
- Shells del HUD: título + badge de modo (arriba-izq), panel de participantes, feed de actividad, panel de info de planeta (derecha).
- Panel **Mapa técnico** oculto + su botón toggle.
- Glassmorphism, navy/cyan, Inter. Responsive con media queries (en móvil los paneles se reducen/colapsan).

### Paso 2 — Boot de Three.js
- `WebGLRenderer({antialias:true, alpha:true})`, `Scene`, `PerspectiveCamera`, loop `requestAnimationFrame`, handler `resize`.
- **Verificar:** ventana navy que reescala sin deformar.

### Paso 3 — Entorno (sala planetario)
- Sala oscura (cilindro/caja grande invertida, material oscuro).
- Campo estelar: `Points` con ~3000 estrellas.
- Plataforma circular (`CylinderGeometry` plano) con anillo emisivo cyan.
- Luces: `AmbientLight` tenue + `PointLight` desde el sol.
- **Verificar:** sala tipo planetario con estrellas y plataforma iluminada.

### Paso 4 — Sistema solar holográfico
- Sol (esfera emisiva + `PointLight`).
- 8 planetas, cada uno dentro de un `Object3D` pivote que rota (órbita).
- `userData` de cada planeta con **datos educativos reales en español**: nombre, diámetro, distancia al Sol, duración del día, duración del año, nº de lunas, dato curioso. (Ver tabla en §5.)
- Toque holográfico: transparencia leve / halos con sprites.
- **Verificar:** planetas orbitando a distintas velocidades.

### Paso 5 — Controles de cámara propios
- Esféricas alrededor de target `(0, 1.5, 0)`: arrastre ratón → theta/phi (clamp en phi); rueda → radio (min/max).
- Táctil: 1 dedo orbita, pinch hace zoom.
- **Verificar:** girar/acercar fluido en escritorio y móvil.

### Paso 6 — Factory de avatares + spawn local
- `crearAvatar(nombre, color)` → grupo cilindro+esfera coloreado + etiqueta de nombre.
- Al pulsar "Entrar": cerrar overlay, crear avatar local sobre la plataforma, emitir `player:join`.
- **Verificar:** tras entrar, tu avatar aparece con su nombre flotando.

### Paso 7 — Movimiento del jugador local
- WASD mueve en plano XZ relativo a la orientación de cámara; límite al radio de plataforma.
- Táctil: joystick virtual simple o botones direccionales.
- Movimiento significativo emite `player:move` (con throttle).
- **Verificar:** caminar sin salir de la plataforma.

### Paso 8 — EventBus + GameState
- Implementar `EventBus` (`on`/`emit`) y `GameState`.
- Reconectar pasos 6–7 para que escriban en `GameState` y emitan por el bus.
- **Verificar:** eventos visibles en consola.

### Paso 9 — HUD reactivo + selección de planetas
- Suscribir paneles al bus: lista de participantes (punto de color), feed ("Ana seleccionó Marte"), panel de info.
- `Raycaster` sobre clic/tap → actualiza `GameState.selectedPlanet`, emite `planet:select`, resalta el planeta, muestra su ficha.
- **Verificar:** tocar un planeta muestra datos educativos y aparece en el feed.

### Paso 10 — Gestor de bots
- 3 bots con nombre+color (ej. Ana, Luis, Sofía).
- Cada bot: elige `targetPosition` aleatorio en plataforma, interpola hacia él (emite `player:move`); cada N s selecciona un planeta (emite `planet:select`).
- Los bots escriben en `remotePlayers` igual que lo hará la red.
- **Verificar:** 3 avatares deambulan suaves y disparan selecciones en el feed.

### Paso 11 — Mapa técnico (FUNCIÓN ESTRELLA)
Panel toggle con filas `{concepto, descripción, eventKey}`:

| En pantalla | Concepto netcode | eventKey |
|---|---|---|
| Entrar | spawn del jugador (NetworkObject) | `player:join` |
| Moverse (tú/bots) | sincronización de estado (NetworkVariable) / interpolación | `player:move` |
| Seleccionar planeta | evento replicado (RPC) | `planet:select` |
| Otros avatares moviéndose | interpolación de jugadores remotos | `player:move` |
| Lista de presentes | autoridad del servidor | `roster:change` |

- `highlightConcept(eventKey)` se suscribe al bus y resalta la fila ~1.5 s cuando ocurre el evento.
- Nota fija visible: *"MODO LOCAL: estos eventos son simulados; en Fase 2 viajan por WebSocket"*.
- **Verificar:** cada acción ilumina su fila en vivo.

### Paso 12 — Pulido
- Brillo holográfico, layout móvil, rendimiento (reusar geometrías/materiales; reducir estrellas si baja FPS).
- **Verificar:** 30+ FPS en móvil de gama media.

---

## 4. Convención de eventos del bus (contrato estable para Fase 2)

```
player:join    { id, nombre, color, x, z }
player:move    { id, x, z, rot }
player:leave   { id }
planet:select  { planetId, porId, porNombre }
roster:change  { players: [{id, nombre, color}] }
```

En Fase 1 los emiten el jugador local y los bots.
En Fase 2 los emite el `NetworkManager` al recibir mensajes del servidor. **El HUD no cambia.**

---

## 5. Datos educativos de planetas (en español, reales)

Usar estos campos por planeta: `nombre`, `diametroKm`, `distanciaSolMillonesKm`, `duracionDia`, `duracionAnio`, `lunas`, `datoCurioso`. Valores de referencia:

- **Mercurio** — 4 879 km — 58 M km — 58.6 días — 88 días — 0 lunas — "El más cercano al Sol; sus días duran más que sus años."
- **Venus** — 12 104 km — 108 M km — 243 días — 225 días — 0 lunas — "Gira al revés y es el planeta más caliente del sistema solar."
- **Tierra** — 12 742 km — 150 M km — 24 horas — 365 días — 1 luna — "El único mundo conocido con vida."
- **Marte** — 6 779 km — 228 M km — 24.6 horas — 687 días — 2 lunas — "Alberga el volcán más grande conocido: el Monte Olimpo."
- **Júpiter** — 139 820 km — 778 M km — 9.9 horas — 12 años — 95 lunas — "Su Gran Mancha Roja es una tormenta más grande que la Tierra."
- **Saturno** — 116 460 km — 1 434 M km — 10.7 horas — 29 años — 146 lunas — "Sus anillos son hielo y roca; flotaría en agua por su baja densidad."
- **Urano** — 50 724 km — 2 871 M km — 17 horas — 84 años — 28 lunas — "Rota casi acostado sobre su órbita."
- **Neptuno** — 49 244 km — 4 495 M km — 16 horas — 165 años — 16 lunas — "Tiene los vientos más rápidos del sistema solar."

> Escalar tamaños/distancias para que quepan en la plataforma (no a escala real); los datos del panel sí son reales.

---

## 6. Lista de verificación — cierre Fase 1

- [ ] Abre con doble clic, sin servidor, en Chrome y en móvil.
- [ ] Entrada con nombre+color hace *spawn* del avatar.
- [ ] Cámara orbita y hace zoom (ratón y táctil) sin librerías externas.
- [ ] WASD/táctil mueve al avatar dentro de la plataforma.
- [ ] 3 bots deambulan suaves (interpolados) y seleccionan planetas solos.
- [ ] Tocar un planeta muestra datos educativos reales en español.
- [ ] Feed registra "X seleccionó Y"; lista de participantes correcta.
- [ ] Mapa técnico resalta la fila correcta en cada acción.
- [ ] 30+ FPS en gama media; código comentado en español; sin `localStorage`.
- [ ] El `NetworkManager` queda *stubbed* (presente pero inactivo sin `?ws=`), listo para Fase 2.

---

## 7. Notas para que la Fase 2 sea un swap limpio

- El `BotManager` debe poder **desactivarse con una bandera** (`MODO_RED`) sin tocar el HUD.
- `NetworkManager` debe existir ya en Fase 1 como esqueleto: si hay `?ws=`, conecta; si no, no hace nada.
- Las posiciones entrantes (bots o red) solo escriben `targetPosition`; la interpolación es la misma.
