# juanjob hi res — BitChord Addon

Addon HTTP para [BitChord](https://github.com/kushagrasinghx/BitChord) con **múltiples fuentes de audio y failover automático**. Reproduce **FLAC real** —hasta **24-bit / 192 kHz** cuando Qobuz está disponible— y si una fuente falla, resuelve la misma grabación en otra.

Sin cuentas, sin login, sin API keys. Todo lo que usa es público.

---

## Qué resuelve realmente

BitChord rechaza cualquier stream con DRM (`encrypted: true`), así que la pregunta no es "qué servicios tienen lossless" sino **"cuáles entregan un archivo limpio que se pueda abrir"**:

| Fuente | Rol | Upstream |
|---|---|---|
| **Qobuz** | Audio principal (hasta 24/192) | `soundfean-musics.onrender.com/a` |
| **Tidal** | Audio (FLAC/DASH) | Aurix + `gglos` como catálogo de respaldo |
| **Monochrome** | Audio (FLAC/DASH) | Auto-descubrimiento vía registro oficial de instancias |
| **Netease** | Audio (FLAC 16/44.1) | `losslessbridge.de.deplexo.com` |
| **Internet Archive** | Último respaldo | `archive.org` |
| **Deezer** | Solo catálogo | `api.deezer.com` — sus filas se resuelven en cualquier fuente de audio |

---

## Failover automático

**Búsqueda** — todas las fuentes se consultan en paralelo. Si una falla o tarda, las demás devuelven igual; las filas duplicadas (mismo título/artista/duración) se fusionan.

**Stream** — si la fuente propia de una fila falla, el addon **re-matea la misma grabación** (título + artista + duración ±45s) en las demás fuentes de audio y resuelve ahí:

```
stream(qb:12345) → Qobuz caído
  → "So What - Miles Davis, 547s"
  → busca en Monochrome → misma grabación → FLAC ✅
```

Eso aplica a **todas** las filas, incluidas las de Deezer.

**Monochrome** — descubre instancias vivas desde el registro oficial `monochrome-music/monochrome/public/instances.json` y las renueva solo; si cambian de dominio, el addon se adapta sin tocar código.

---

## Verificación real, no declarada

El addon no promete "lossless" y listo. Cada provider devuelve el codec, sample rate y bit depth reales del stream que entrega. Para Internet Archive hace un `Range: bytes=0-63` y parsea el bloque **STREAMINFO** del FLAC; para Tidal declara explícitamente el transporte DASH cuando corresponde:

```json
{
  "url": "https://streaming-qobuz-std.akamaized.net/file?...&fmt=27...",
  "codec": "flac",
  "container": "flac",
  "manifest": "none",
  "encrypted": false,
  "sampleRate": 192000,
  "bitDepth": 24,
  "bitrate": 4610250,
  "quality": "Lossless · 24-bit / 192 kHz",
  "provider": "Qobuz"
}
```

Los números salen del archivo o del upstream confiable, no del catálogo. Si la URL devuelve HTML, MP3, o cualquier otra cosa, la resolución se descarta. La doc de BitChord es explícita sobre esto: *una etiqueta lossless sobre un URL lossy no crea un badge lossless*.

---

## Deploy en Deplexo

El addon está conectado a Deplexo desde GitHub: **cada push a `master` dispara un build y un deploy automático**.

```bash
git push origin master
```

La URL de producción es `https://bitchord-hires-addon.de.deplexo.com`. El deploy viejo de Vercel quedó deshabilitado por billing (`402 Payment required`); Deplexo es el activo.

Para probar en local antes:

```bash
npm run dev          # http://localhost:8787
```

### Instalarlo en BitChord

**Settings → Sources → Add an addon** → pegá la raíz o el manifest:

```
https://bitchord-hires-addon.de.deplexo.com
```

Tocá *Test* para el health check.

### Configuración incluida

- `bitchordAuth: true` — solo la app oficial de BitChord puede consultar `/search`, `/stream` y `/health`. El manifest queda público. Ver *Addon auth* abajo.
- `checkValidLossless: 1` — el addon solo se consulta con una salida capaz de lossless (cable, USB, HDMI, o BT LDAC/LHDC/aptX Lossless). Con BT normal no se le habla. En la lista aparece *Needs a lossless output*.
- `allowDownloads: 1` — las descargas salen de este addon, así que se guardan en FLAC. Si una fuente falla, el failover resuelve la pista en otra; si el addon devuelve 404, BitChord cae a la siguiente fuente.
- `settings.quality` — `lossless` / `high` / `low`. BitChord reenvía el valor elegido en `/search` y `/stream`.

### Addon auth

Implementa el protocolo oficial de BitChord 1.9.1+ con el verificador `lib/bitchord-addon-auth.mjs` (sin dependencias, WebCrypto):

- `GET /` y `GET /manifest.json` son **públicos**: BitChord lee el flag sin credenciales.
- `/search`, `/stream` y `/health` exigen `X-BitChord-Token` y `X-BitChord-Proof`.
- Un pedido sin credenciales, de un fork, de un script o del navegador recibe `401` con `WWW-Authenticate: BitChord` y un código (`missing`, `expired`, `invalid_token`, `invalid_proof`, `stale_proof`); si no se pueden bajar las claves públicas, `503 unavailable`.
- La prueba viene del hardware del teléfono y de la clave de firma oficial: **BitChord desktop/web no puede usar el addon** una vez aplicado el bloqueo.
- Hosts configurados: `bitchord-hires-addon.de.deplexo.com` (principal) y `bitchord-hires-addon.vercel.app` (alias).

---

## Endpoints

```
GET /manifest.json                       público
GET /health                              requiere addon auth
GET /search?q=...&quality=LOSSLESS       requiere addon auth
GET /stream/{id}?quality=LOSSLESS        requiere addon auth
```

`/health` reporta cada provider por separado con su latencia, así ves qué está caído antes de culpar a BitChord:

```json
{
  "ok": true,
  "node": "v22.x",
  "audioSources": ["Qobuz", "Tidal", "Monochrome", "Netease", "Internet Archive"],
  "providers": [
    { "provider": "qobuz", "reachable": false, "latencyMs": 189 },
    { "provider": "tidal", "reachable": false, "latencyMs": 194 },
    { "provider": "monochrome", "reachable": true, "latencyMs": 94 },
    { "provider": "netease", "reachable": true, "latencyMs": 4868 },
    { "provider": "deezer", "reachable": true, "latencyMs": 285 },
    { "provider": "archive", "reachable": true, "latencyMs": 480 }
  ]
}
```

### Formatos de Qobuz

El addon pide hi-res a soundfean y devuelve el mejor disponible:

| Calidad | Resultado |
|---|---|
| `HI_RES` | FLAC 24-bit (hasta 192 kHz) |
| `LOSSLESS` | FLAC 16/44.1 (CD) |
| `LOW` | MP3 320 |

---

## Ids

Los ids son opacos y están prefijados por provider:

```
qb:13176085      Qobuz
td:12345678      Tidal
mc:987654321     Monochrome
ne:21335863      Netease
dz:3135556       Deezer (catálogo; se resuelve en cualquier fuente de audio)
ia:vegabonds...  Internet Archive
```

`/stream` devuelve **404** cuando el addon no tiene esa pista. Eso es intencional: la doc dice que 404 mueve la resolución limpiamente a la siguiente fuente, en vez de dejar el reproductor roto.

---

## Tests

```bash
npm test              # end-to-end contra los upstreams reales
npm run test:contract # contrato + honestidad de los metadatos
```

El test de contrato falla si: un artwork viene relativo, si un stream se marca `encrypted: true`, si aparece un `sampleRate` inverosímil, si un `bitDepth` raro, si un miss devuelve una URL inventada, o si se filtra un campo interno.

---

## Estructura

```
api/index.js                  handler HTTP (contrato BitChord) + guard de auth
lib/bitchord-addon-auth.mjs   verificador oficial (sin dependencias)
lib/router.js                 búsqueda paralela, failover y cross-matching
lib/flac.js                   parser de STREAMINFO + sondeo de URLs
lib/cache.js                  TTL: search 10 min, stream 4 min
lib/providers/qobuz.js        audio principal (vía soundfean-musics)
lib/providers/tidal.js        audio (Aurix DASH + gglos)
lib/providers/monochrome.js   audio (auto-descubrimiento de instancias)
lib/providers/netease.js      audio (losslessbridge)
lib/providers/archive.js      audio de respaldo
lib/providers/deezer.js       catálogo
test/run.js                   e2e
lib/contract.test.js          contrato
```

Sin dependencias. Node ≥ 20.

---

## Variables de entorno (opcionales)

Ninguna hace falta para que funcione.

| Variable | Para qué |
|---|---|
| `QOBUZ_UPSTREAM_BASE_URL` | Otro addon de Qobuz si soundfean (`soundfean-musics.onrender.com/a`) cae |
| `QOBUZ_REST_API` | Tu propia instancia de `qobuz-rest-api`, si preferís no depender del addon público |
| `TIDAL_UPSTREAM_BASE_URL` | Otro upstream de Aurix para Tidal |
| `TIDAL_SEARCH_BACKUP_URL` | Otro catálogo de respaldo de Tidal (gglos por defecto) |
| `NETEASE_UPSTREAM_BASE_URL` | Otro upstream de Netease (losslessbridge por defecto) |

---

## Nota

Esto solo reproduce audio que **vos ya pagás en otra parte**: el addon no descarga, no extrae claves, no desvía DRM, no bypasea autenticación. Reutiliza streams públicos o que tu propia cuenta ya puede reproducir. Las URLs firmadas de Qobuz expiran en ~30 min, así que nada queda cacheado para siempre.

Si tenés Qobuz o Tidal propio y queréscalidad y estabilidad garantizadas en vez de un proxy público, decímelo y lo adapto para que use tu cuenta.