# rtsp-server-tsst

Servidor TSST que recibe las cámaras de videovigilancia por **RTSP** y las entrega por **SRT** a Race Control (replay de comisarios).
Pensado para el mini PC HP EliteDesk 800 G5 (i7-9700, Intel UHD 630) con Debian 12, sin Docker.

## Instalar o actualizar

```bash
sudo bash /opt/race-control-server/instalar_servidor.sh
```

Si es la primera vez y la carpeta no existe:

```bash
sudo git clone https://github.com/tossalet/rtsp-server-tsst /opt/race-control-server
sudo bash /opt/race-control-server/instalar_servidor.sh
```

El mismo script instala y actualiza. **Nunca toca** `data/` (base de datos `race-control.db`), `logs/` ni `media/`.
Antes de actualizar, por precaución: `sudo cp -a /opt/race-control-server/data ~/data-backup-$(date +%F)`

Panel web: `http://IP-DEL-MINI-PC:4000`

## Lista de comprobación en el circuito

1. `systemctl status race-control` → `active (running)`.
2. En el panel, cada cámara con LED verde y bitrate > 0.
3. Cada salida SRT en modo **listener** con un **puerto distinto** (el panel rechaza puertos repetidos).
4. Desde Race Control, conectar como **caller** a `srt://IP-DEL-MINI-PC:PUERTO`.
5. Cámaras en hora: en cada cámara, servidor NTP = IP del mini PC, puerto 123, zona `Europe/Madrid`.
   Comprobar con `chronyc clients` en el mini PC que aparecen las cámaras.

## Sincronización de cámaras

El instalador configura el mini PC como **servidor de hora (NTP)** de la red local, también sin internet.
Con todas las cámaras sincronizadas con él, el reloj sobreimpreso (OSD) y los tiempos internos de todas coinciden.
Todas las salidas SRT usan la misma latencia (200 ms desde el panel), así que el retardo de red es igual para todas.

## SRT

- Los parámetros `latency`, `rcvlatency` y `peerlatency` de FFmpeg van en **microsegundos**
  (`latency=200000` = 200 ms). Si se escribe un valor < 1000 (p.ej. `latency=200`) el servidor lo interpreta como ms y lo convierte.
- Cifrado opcional: añadir `&passphrase=CLAVE_DE_10_A_79_CARACTERES&pbkeylen=16` a la URL de la salida y la misma clave en Race Control.

## Diagnóstico

- Logs en vivo: `journalctl -u race-control -f` (o en el panel web).
- Si una cámara o salida falla, el log muestra el error real de FFmpeg (`[IN-x] FFmpeg: ...` / `[OUT-x] FFmpeg: ...`), con las contraseñas ocultas.
- Si una cámara deja de enviar sin cortar la conexión, el servidor la reconecta sola a los 20 s.
- Si Race Control se desconecta, la salida SRT se reabre en 2 s.
- GPU Intel: `vainfo`. Las salidas con códec VAAPI muestran los mensajes de la GPU (`[HW]`) en el log los primeros 20 s.
