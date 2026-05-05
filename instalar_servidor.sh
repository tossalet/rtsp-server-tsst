#!/bin/bash

# ============================================================
#   INSTALADOR DIRECTO — RACE CONTROL SERVER (SIN DOCKER)
#   HP EliteDesk 800 G5 · Intel i7-9700 · UHD 630
#   Debian 12 (Bookworm)
# ============================================================

if [ "$EUID" -ne 0 ]; then
  echo "❌ Ejecuta este script como root: sudo bash instalar_servidor.sh"
  exit 1
fi

APP_DIR="/opt/race-control-server"
SERVICE_NAME="race-control"

clear
echo "============================================================"
echo "  🚀 INSTALADOR RACE CONTROL SERVER"
echo "  Instalación directa en Debian (sin Docker)"
echo "============================================================"
echo ""

# ── 1. Actualizar sistema ─────────────────────────────────────
echo "📦 [1/6] Actualizando sistema..."
apt-get update -qq

# ── 2. Instalar dependencias del sistema ──────────────────────
echo "📦 [2/6] Instalando FFmpeg, SQLite e Intel QSV..."
apt-get install -y --no-install-recommends \
    ffmpeg \
    sqlite3 \
    iproute2 \
    curl \
    intel-media-va-driver \
    vainfo \
    git \
    build-essential \
    python3

echo "✅ Dependencias del sistema instaladas."

# ── 3. Instalar Node.js 20 LTS ────────────────────────────────
echo ""
echo "📦 [3/6] Instalando Node.js 20 LTS..."
if ! node --version 2>/dev/null | grep -q "v20"; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
echo "✅ Node.js $(node --version) instalado."

# ── 4. Clonar o actualizar el repositorio ─────────────────────
echo ""
echo "📦 [4/6] Preparando el código de la aplicación..."
if [ -d "$APP_DIR/.git" ]; then
    echo "   Repositorio existente encontrado. Actualizando..."
    git -C "$APP_DIR" pull
else
    echo "   Clonando repositorio desde GitHub..."
    git clone https://github.com/tossalet/rtsp-server-tsst "$APP_DIR"
fi

# ── 5. Instalar dependencias npm (compiladas para Linux) ───────
echo ""
echo "📦 [5/6] Instalando dependencias Node.js (compilando para Linux)..."
cd "$APP_DIR"
npm install --omit=dev
echo "✅ Dependencias npm instaladas y compiladas para Linux."

# ── 6. Crear servicio systemd ─────────────────────────────────
echo ""
echo "⚙️  [6/6] Configurando servicio del sistema (arranque automático)..."

cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=Race Control Server (RTSP/SRT)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl restart ${SERVICE_NAME}

# ── Resultado ─────────────────────────────────────────────────
sleep 2
LOCAL_IP=$(hostname -I | awk '{print $1}')
STATUS=$(systemctl is-active ${SERVICE_NAME})

echo ""
echo "============================================================"
if [ "$STATUS" = "active" ]; then
    echo "  ✅ ¡INSTALACIÓN COMPLETADA CON ÉXITO!"
else
    echo "  ⚠️  Instalación completada (verifica el estado: systemctl status ${SERVICE_NAME})"
fi
echo "============================================================"
echo ""
echo "  📍 Panel de control web:"
echo "  👉 http://$LOCAL_IP:4000"
echo ""
echo "  🔧 Comandos útiles:"
echo "     Ver logs en tiempo real:  journalctl -u ${SERVICE_NAME} -f"
echo "     Reiniciar servidor:       systemctl restart ${SERVICE_NAME}"
echo "     Detener servidor:         systemctl stop ${SERVICE_NAME}"
echo "     Ver estado:               systemctl status ${SERVICE_NAME}"
echo ""
echo "  💡 Para verificar aceleración Intel QSV:"
echo "     vainfo"
echo "============================================================"
