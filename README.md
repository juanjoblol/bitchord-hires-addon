# BitChord Hi-Res Lossless Addon

Addon HTTP para [BitChord](https://github.com/kushagrasinghx/BitChord) que reproduce **FLAC real de alta resolución** verificado leyendo el propio archivo — hasta **24-bit / 192 kHz**.

Sin cuentas, sin login, sin API keys. Todo lo que usa es público.

---

## Qué resuelve realmente

BitChord rechaza cualquier stream con DRM (`encrypted: true`), así que la pregunta no es "qué servicios tienen lossless" sino **"cuáles entregan un archivo limpio que se pueda abrir"**:

| Fuente | Rol | Estado verificado |
|---|---|---|
| **Qobuz** | Audio principal | ⚠️ Proxy público caído (402). Si vuelve, FLAC hasta 24/192 |
| **Tidal** | Audio principal | ✅ FLAC 16/44.1 vía losslessbridge (Monochrome/hifi-api). Sin cuenta |
| **Internet Archive** | Audio secundario | ✅ FLAC real desde el CDN, sin cuenta |
| **Deezer** | Solo catálogo | ✅ `api.deezer.com`. Sus filas se resuelven buscando la misma canción en Tidal/Qobuz |
| Spotify | — | ❌ Web API nunca expone URLs de archivo |
| Apple Music | — | ❌ FairPlay cifrado |
| Amazon Music | — | ❌ Widevine DRM |

O sea: **Tidal y Archive dan el audio ahora mismo; Qobuz lo hará cuando su proxy vuelva.** Es el mismo enfoque que SpotiFLAC, y es la razón por la que buscás en Deezer y igual te suena en FLAC 24/192.

---

## Verificación real, no declarada

El addon no promete "lossless" y listo. Antes de devolver un stream hace un `Range: bytes=0-63` y parsea el bloque **STREAMINFO** del FLAC:

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

Los números salen del archivo, no del catálogo. Si la URL devuelve HTML, MP3, o cualquier otra cosa, la resolución se descarta y se prueba el siguiente formato. La doc de BitChord es explícita sobre esto: *una etiqueta lossless sobre un URL lossy no crea un badge lossless*.

---

## Deploy en Vercel

```bash
npm i -g vercel
cd bitchord-hires-addon
vercel deploy --prod
```

Te devuelve algo como `https://bitchord-hires-addon.vercel.app`. Ya tiene HTTPS.

Para probar en local antes:

```bash
npm run dev          # http://localhost:8787
```

### Instalarlo en BitChord

**Settings → Sources → Add an addon** → pegá la raíz o el manifest:

```
https://bitchord-hires-addon.vercel.app
```

Tocá *Test* para el health check.

### Configuración incluida

- `checkValidLossless: 1` — el addon solo se consulta con una salida capaz de lossless (cable, USB, HDMI, o BT LDAC/LHDC/aptX Lossless). Con BT normal no se le habla. En la lista aparece *Needs a lossless output*.
- `allowDownloads: 1` — las descargas salen de este addon, así que se guardan en FLAC. Solo funciona para pistas que existan en Qobuz; si el addon devuelve 404, BitChord cae a la siguiente fuente.
- `settings.quality` — `lossless` / `high` / `low`. BitChord reenvía el valor elegido en `/search` y `/stream`.

---

## Endpoints

```
GET /manifest.json
GET /health
GET /search?q=...&quality=LOSSLESS
GET /stream/{id}?quality=LOSSLESS
```

`/health` reporta cada provider por separado con su latencia, así ves qué está caído antes de culpar a BitChord:

```json
{
  "ok": true,
  "node": "v22.x",
  "audioSources": ["Qobuz", "Internet Archive"],
  "providers": [
    { "provider": "qobuz", "reachable": true, "latencyMs": 448 },
    { "provider": "deezer", "reachable": true, "latencyMs": 285 },
    { "provider": "archive", "reachable": true, "latencyMs": 537 }
  ]
}
```

### Formatos de Qobuz

El addon pide el mejor formato disponible y baja de escalón si el CDN falla:

|(fmt) | Resultado |
|---|---|
| 27 | FLAC 24/192 |
| 7 | FLAC 24/96 |
| 6 | FLAC 16/44.1 (CD) |
| 5 | MP3 320 (tier LOW) |

---

## Ids

Los ids son opacos y están prefijados por provider:

```
qb:13176085      Qobuz
dz:3135556       Deezer (catálogo; se resuelve vía Qobuz)
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
api/index.js              handler HTTP (contrato BitChord)
lib/router.js             merge de búsqueda, resolución, matching Deezer→Qobuz
lib/flac.js               parser de STREAMINFO + sondeo de URLs
lib/cache.js              TTL: search 10 min, stream 4 min
lib/providers/qobuz.js    audio principal
lib/providers/archive.js  audio secundario
lib/providers/deezer.js   catálogo
test/run.js               e2e
lib/contract.test.js      contrato
```

Sin dependencias. Node ≥ 20.

---

## Variables de entorno (opcionales)

Ninguna hace falta para que funcione.

| Variable | Para qué |
|---|---|
| `QOBUZ_UPSTREAM_BASE_URL` | Otro proxy de Qobuz si el default (`qobuz-dll.vercel.app`) cambia de host |
| `QOBUZ_REST_API` | Tu propia instancia de `qobuz-rest-api`, si preferís no depender del proxy público |

---

## Nota

Esto solo reproduce audio que **vos ya pagás en otra parte**: el addon no descarga, no extrae claves, no desvía DRM, no bypasea autenticación. Reutiliza streams públicos o que tu propia cuenta ya puede reproducir. Las URLs firmadas de Qobuz expiran en ~30 min, así que nada queda cacheado para siempre.

Si tenés Qobuz o Tidal propio y queréscalidad y estabilidad garantizadas en vez de un proxy público, decímelo y lo adapto para que use tu cuenta.