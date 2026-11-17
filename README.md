# rtsp-server-tsst

Servidor TSST que recibe las cámaras de videovigilancia por **RTSP** y las entrega por **SRT** a Race Control (replay de comisarios).
Pensado para el mini PC HP EliteDesk 800 G5 (i7-9700, Intel UHD 630) con Debian 12 o 13, sin Docker.

## Instalar o actualizar

```bash
sudo bash ~/rtsp-server-tsst/instalar_servidor.sh
```

Si es la primera vez y la carpeta no existe:

```bash
git clone https://github.com/tossalet/rtsp-server-tsst ~/rtsp-server-tsst
sudo bash ~/rtsp-server-tsst/instalar_servidor.sh
```

El mismo script instala y actualiza, en la carpeta donde está (aquí `~/rtsp-server-tsst`). **Nunca toca** `data/` (base de datos `race-control.db`), `logs/` ni `media/`.
Antes de actualizar, por precaución: `sudo cp -a ~/rtsp-server-tsst/data ~/data-backup-$(date +%F)`

Panel web: `http://IP-DEL-MINI-PC:4000`

## Lista de comprobación en el circuito

1. `systemctl status rtsp-server-tsst` → `active (running)`.
2. En el panel, cada cámara con LED verde y bitrate > 0.
3. Cada salida SRT en modo **listener** con un **puerto distinto** (el panel rechaza puertos repetidos).
4. Desde Race Control, conectar como **caller** a `srt://IP-DEL-MINI-PC:PUERTO`.
5. Cámaras en hora: en cada cámara, servidor NTP = IP del mini PC, puerto 123, zona `Europe/Madrid`.
   Comprobar con `chronyc clients` en el mini PC que aparecen las cámaras.

## Visualización en el panel

- **Filas o mosaico**: botones junto a "Add Input" (pestaña Streams). Cada navegador recuerda su elección.
  En mosaico cada cámara es una tesela con la imagen siempre a la vista; las salidas aparecen al desplegarla.
- **Minigráfico de bitrate** del último minuto en cada entrada y salida (verde con señal).
- **Vídeo en vivo (HLS)**: con el ojo encendido y la miniatura a la vista (tarjeta desplegada o mosaico), se ve
  el vídeo real sin sonido. El servidor solo **copia** el vídeo (sin recodificar: ~1 % de un núcleo y ~25 MB por
  cámara mirada), guarda los trozos en RAM y lo apaga a los 15 s de que nadie mire. Si la cámara es H.265 y el
  navegador no lo reproduce, se queda la imagen fija.

- **Dashboard e historial**: con la monitorización instalada, el Dashboard muestra el historial de Prometheus
  (lo mismo que Grafana) sin salir del panel: tabla por cámara (% del tiempo con señal, reconexiones, bitrate
  medio y mínimo) y gráficas de bitrate de entrada y salida, reconexiones, CPU y memoria, por periodo
  (15 min, 1 h, 6 h, 24 h). Botón "Abrir Grafana" para el panel completo.
- **Analytics**: gráfica continua del último minuto de las señales marcadas, tabla "Estado de las señales"
  (estado, bitrate, tiempo en el aire, códec y latencia de cada entrada y salida) y el mismo historial.
- **Storage**: cada disco con su espacio libre (amarillo al 75 %, rojo al 90 %), grabaciones agrupadas por día con
  buscador, reproducción, descarga y borrado. Las grabaciones HLS aparecen como una sola entrada (sin sus trozos)
  y lo que se está grabando ahora no se puede borrar.

## Resolución, 4K y consumo

- Cada entrada muestra lo que **llega de verdad** de la cámara: etiqueta en la cabecera (4K, 1080p…) y, al desplegarla,
  "Llega: H.265 · 3840×2160 · 25 fps".
- Cada salida muestra cómo sale (copia directa, o códec y `4K → 1080p`) y su **consumo real** de CPU y de la GPU Intel,
  y cada cámara el total de su entrada, vista previa y salidas. Arriba a la derecha, el total de todo el vídeo.
  Se mide leyendo `/proc` (el driver i915 apunta el tiempo de GPU de cada proceso): no instala nada y solo
  trabaja con el panel abierto. Amarillo a partir del 40 %, rojo del 70 %.
- **Rescalar** (editar salida → "Resolución de salida": 2160p, 1440p, 1080p, 720p) solo es posible transcodificando.
  Con **Intel VAAPI** el vídeo se decodifica, se escala y se codifica en la GPU integrada (UHD 630), casi sin CPU.
  Si la GPU falla con un vídeo concreto antes de sacar imagen, la salida baja sola de nivel y lo indica en el log y en el panel:
  1) todo en GPU → 2) decodifica la CPU, escala y codifica la GPU → 3) decodifica y escala la CPU, codifica la GPU.
  Al editar o reactivar la salida se vuelve a probar todo en GPU. Nunca se amplía: si la cámara manda menos, sale tal cual.
  Para ver qué admite la GPU: `vainfo | grep -iE "VideoProc|EncSlice"`. El instalador pone el driver Intel completo
  (`intel-media-va-driver-non-free`, repositorio non-free) si está disponible: con el libre la GPU no escala.
  Por CPU (`libx264`) un 4K a 1080p ocupa varios núcleos: usar VAAPI.

## Codificación de la cámara (Hikvision y Dahua)

Botón de deslizadores en cada entrada RTSP: lee y cambia códec, resolución, fps, CBR/VBR, bitrate y GOP del mismo
stream que usa la entrada (principal o secundario, según la URL). Usa el usuario y la contraseña de la URL RTSP
(Hikvision por ISAPI, Dahua por CGI, autenticación Digest). Si la web de la cámara no está en el puerto 80,
se indica en la ventana y queda guardado. Al aplicar, la entrada se reconecta sola con la nueva codificación.

- Recomendado para carreras: **CBR**, GOP de 1–2 s (25–50 a 25 fps) y **sin H.264+/H.265+ (Smart Codec)**,
  que alarga el GOP y da saltos en el replay. La ventana avisa si está activo.
- Orientativo: 4K a 12–16 Mbps en H.265 (20–25 en H.264); 1080p a 4–6 Mbps en H.265 (6–8 en H.264).

## Gráficas con Grafana (opcional)

```bash
sudo bash ~/rtsp-server-tsst/instalar_servidor.sh --monitorizacion
```

Instala Prometheus (historial, 15 días como máximo) y Grafana en el puerto **4001**, con un panel ya preparado:
señales con y sin señal, bitrate de entrada y salida, reconexiones, CPU, memoria y red del mini PC.
Consumo aproximado: 200 MB de RAM y CPU casi nula. Ambos con prioridad baja: el vídeo siempre va primero.
Una vez instalado aparece "Grafana" en el menú del panel, y las actualizaciones normales lo mantienen.

Sin `--monitorizacion` no se instala nada: el servidor solo expone `/metrics` (formato Prometheus), que no
consume nada si nadie lo pide y solo responde desde el propio mini PC (o con `METRICS_TOKEN` desde fuera).

## Sincronización de cámaras

El instalador configura el mini PC como **servidor de hora (NTP)** de la red local, también sin internet.
Con todas las cámaras sincronizadas con él, el reloj sobreimpreso (OSD) y los tiempos internos de todas coinciden.
Conviene que todas las salidas SRT usen la misma latencia (500 ms por defecto), así el retardo de red es igual para todas.

## Entradas SRT

Además de cámaras RTSP, una entrada puede recibir una fuente **SRT** (y luego redistribuirla por sus salidas):

- **SRT Listener**: el servidor abre un puerto y espera. El emisor se conecta como *caller* a `srt://IP-DEL-SERVIDOR:PUERTO`
  (passphrase opcional: 10–79 caracteres, sin espacios ni `& ? # = %`, la misma en el emisor). Cada listener, entrada
  o salida, necesita un puerto distinto (el panel lo rechaza si se repite).
  Mientras no hay emisor no se reinicia. Si el emisor se corta, SRT lo detecta a los ~5 s y el puerto se reabre en 1 s;
  el emisor (vMix, codificador) debe tener activada la reconexión automática.
- **SRT Caller**: el servidor se conecta a `srt://IP-EMISOR:PUERTO[?streamid=...&passphrase=...]`.

## SRT

- **Cuadraditos (macrobloques) = latencia SRT corta para la red.** La latencia es el buffer donde SRT recupera
  los paquetes perdidos. Se elige en cada salida desde el panel: 250 ms (cable perfecto), **500 ms (por defecto)**,
  1000 ms (WiFi / radioenlace), 2000 ms. Emisor y receptor negocian y gana la mayor, así que subirla aquí
  arregla también a Race Control y vMix. Regla práctica: latencia ≥ 4 × el ping entre equipos.
  Prueba con red simulada (5 % pérdida, 160 ms de ida y vuelta, 1080p 8 Mbps): 250 ms → 154 errores, 500 ms → 37, 1000 ms → 0.
- Si el log muestra `no da abasto: descartados ... KB`, el problema no es la red sino que ese receptor
  o el disco no consumen a tiempo.
- Los parámetros `latency`, `rcvlatency` y `peerlatency` de FFmpeg van en **microsegundos**
  (`latency=500000` = 500 ms). Si se escribe un valor < 1000 (p.ej. `latency=200`) el servidor lo interpreta como ms
  y lo convierte. Una URL SRT sin `latency` recibe 500 ms (libsrt pondría 120 ms).
- Las salidas creadas con la web antigua (200 ms) se pasan solas a 500 ms al arrancar.
- Cifrado opcional: añadir `&passphrase=CLAVE_DE_10_A_79_CARACTERES&pbkeylen=16` a la URL de la salida y la misma clave en Race Control.

## Diagnóstico

- Logs en vivo: `journalctl -u rtsp-server-tsst -f` (o en el panel web).
- Descargar el log desde el Dashboard: últimos 15 min, última hora, 6 h, 24 h o todo (las horas del log van en UTC).
- Si una cámara o salida falla, el log muestra el error real de FFmpeg (`[IN-x] FFmpeg: ...` / `[OUT-x] FFmpeg: ...`), con las contraseñas ocultas.
- Si una cámara deja de enviar sin cortar la conexión, el servidor la reconecta sola a los 20 s.
- Si Race Control se desconecta, la salida SRT se reabre en 2 s.
- GPU Intel: `vainfo`. Las salidas con códec VAAPI muestran los mensajes de la GPU (`[HW]`) en el log los primeros 20 s.
