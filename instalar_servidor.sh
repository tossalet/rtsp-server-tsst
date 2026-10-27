#!/bin/bash

# ============================================================
#   INSTALADOR DIRECTO — RACE CONTROL SERVER (SIN DOCKER)
#   HP EliteDesk 800 G5 · Intel i7-9700 · UHD 630
#   Debian 12 (Bookworm)
#   Sirve tanto para instalar desde cero como para ACTUALIZAR.
#   La base de datos (data/), logs/ y media/ nunca se tocan.
# ============================================================

if [ "$EUID" -ne 0 ]; then
  echo "❌ Ejecuta este script como root: sudo bash instalar_servidor.sh"
  exit 1
fi

APP_DIR="/opt/race-control-server"
SERVICE_NAME="race-control"
REPO_URL="https://github.com/tossalet/rtsp-server-tsst"

fail() { echo ""; echo "❌ ERROR: $1"; echo "   La instalación se ha detenido. El servicio anterior sigue como estaba."; exit 1; }

clear
echo "============================================================"
echo "  🚀 INSTALADOR RACE CONTROL SERVER"
echo "  Instalación directa en Debian (sin Docker)"
echo "============================================================"
echo ""

# ── 1. Actualizar sistema ─────────────────────────────────────
echo "📦 [1/7] Actualizando lista de paquetes..."
apt-get update -qq || fail "apt-get update. ¿Hay conexión a internet?"

# ── 2. Instalar dependencias del sistema ──────────────────────
echo "📦 [2/7] Instalando FFmpeg, drivers Intel y servidor de hora..."
apt-get install -y --no-install-recommends \
    ffmpeg \
    sqlite3 \
    iproute2 \
    curl \
    intel-media-va-driver \
    vainfo \
    git \
    build-essential \
    python3 \
    chrony || fail "instalando paquetes del sistema"

ffmpeg -hide_banner -protocols 2>/dev/null | grep -qw srt || fail "el FFmpeg instalado no soporta SRT"
echo "✅ Dependencias del sistema instaladas (FFmpeg con SRT: OK)."

# ── 3. Instalar Node.js 20 LTS ────────────────────────────────
echo ""
echo "📦 [3/7] Comprobando Node.js 20 LTS..."
if ! node --version 2>/dev/null | grep -q "^v20"; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || fail "descargando Node.js"
    apt-get install -y nodejs || fail "instalando Node.js"
fi
echo "✅ Node.js $(node --version) instalado."

# ── 4. Clonar o actualizar el repositorio ─────────────────────
echo ""
echo "📦 [4/7] Preparando el código de la aplicación..."
if [ -d "$APP_DIR/.git" ]; then
    echo "   Repositorio existente encontrado. Actualizando..."
    git -C "$APP_DIR" remote set-url origin "$REPO_URL"
    git -C "$APP_DIR" fetch origin main || fail "descargando la nueva versión de GitHub"
    # reset --hard en lugar de pull: las miniaturas que reescribe el servidor bloqueaban el pull.
    # Solo afecta a ficheros del repositorio; data/ (base de datos), logs/ y media/ no se tocan.
    git -C "$APP_DIR" reset --hard origin/main || fail "aplicando la nueva versión"
else
    echo "   Clonando repositorio desde GitHub..."
    git clone "$REPO_URL" "$APP_DIR" || fail "clonando el repositorio"
fi
echo "✅ Código en la versión $(git -C "$APP_DIR" log -1 --format='%h (%ad)' --date=short)."

# Base de datos: versiones antiguas usaban onpremise.db; la app usa race-control.db
mkdir -p "$APP_DIR/data"
if [ -f "$APP_DIR/data/onpremise.db" ] && [ ! -f "$APP_DIR/data/race-control.db" ]; then
    cp -a "$APP_DIR/data/onpremise.db" "$APP_DIR/data/race-control.db"
    echo "   Base de datos antigua onpremise.db copiada como race-control.db (el original se conserva)."
fi

# ── 5. Instalar dependencias npm (compiladas para Linux) ───────
echo ""
echo "📦 [5/7] Instalando dependencias Node.js..."
cd "$APP_DIR"
npm ci --omit=dev || npm install --omit=dev || fail "instalando dependencias npm"
node -e "require('sqlite3'); require('express'); require('socket.io'); require('systeminformation')" \
    || fail "las dependencias npm no cargan correctamente"
echo "✅ Dependencias npm instaladas."

# ── 6. Servidor de hora (NTP) para sincronizar las cámaras ────
echo ""
echo "🕒 [6/7] Configurando el mini PC como servidor de hora de la red local..."
mkdir -p /etc/chrony/conf.d
cat > /etc/chrony/conf.d/race-control.conf << 'EOF'
# Race Control: las cámaras de la red local se ponen en hora con este equipo.
# Con internet se sincroniza con los servidores públicos; sin internet sigue sirviendo su reloj.
allow 10.0.0.0/8
allow 172.16.0.0/12
allow 192.168.0.0/16
local stratum 10
EOF
systemctl enable chrony >/dev/null 2>&1
systemctl restart chrony && echo "✅ Servidor NTP activo (UDP 123)." || echo "⚠️  No se pudo arrancar chrony (la app funciona igual)."

# ── 7. Crear servicio systemd ─────────────────────────────────
echo ""
echo "⚙️  [7/7] Configurando servicio del sistema (arranque automático)..."

cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=Race Control Server (RTSP/SRT)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
TimeoutStopSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl restart ${SERVICE_NAME}

# ── Resultado: esperar a que la web responda de verdad ────────
echo -n "   Esperando a que el servidor responda"
OK=0
for i in $(seq 1 30); do
    if curl -s -m 2 http://127.0.0.1:4000/api/status | grep -q '"online":true'; then OK=1; break; fi
    echo -n "."; sleep 1
done
echo ""
LOCAL_IP=$(hostname -I | awk '{print $1}')

echo ""
echo "============================================================"
if [ "$OK" = "1" ]; then
    echo "  ✅ ¡INSTALACIÓN COMPLETADA CON ÉXITO!"
else
    echo "  ⚠️  El servicio no responde. Revisa:  journalctl -u ${SERVICE_NAME} -n 50"
fi
echo "============================================================"
echo ""
echo "  📍 Panel de control web:"
echo "  👉 http://$LOCAL_IP:4000"
echo ""
echo "  🕒 Servidor de hora para las cámaras (NTP):"
echo "  👉 En cada cámara: NTP = $LOCAL_IP , puerto 123, zona horaria Europe/Madrid"
echo ""
echo "  🔧 Comandos útiles:"
echo "     Ver logs en tiempo real:  journalctl -u ${SERVICE_NAME} -f"
echo "     Reiniciar servidor:       systemctl restart ${SERVICE_NAME}"
echo "     Detener servidor:         systemctl stop ${SERVICE_NAME}"
echo "     Ver estado:               systemctl status ${SERVICE_NAME}"
echo "     Clientes NTP (cámaras):   chronyc clients"
echo ""
echo "  💡 Para verificar aceleración Intel VAAPI:"
echo "     vainfo"
echo "============================================================"
