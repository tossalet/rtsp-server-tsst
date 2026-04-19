#!/bin/bash

# Comprobar root
if [ "$EUID" -ne 0 ]; then
  echo "❌ Error: Por favor, ejecuta este instalador con permisos de administrador."
  echo "👉 Usa el comando: sudo bash instalar_servidor.sh"
  exit
fi

# Instalar whiptail por si no está (librería para dibujar menús visuales en la consola)
apt-get update -qq
apt-get install -y whiptail

# Bienvenida
whiptail --title "Instalador Servidor SRT TSST" --msgbox "Bienvenido al asistente de instalación del Servidor SRT para Raspberry Pi.\n\nA continuación, configuraremos los parámetros básicos de tu servidor, instalaremos Node.js, FFmpeg y lo dejaremos listo para funcionar." 14 65

# Preguntar Puerto Web
WEB_PORT=$(whiptail --title "Configuración" --inputbox "Introduce el PUERTO en el que deseas visualizar el Panel de Control Web:\n\n(Ejemplo: 3000, 80, 8080)" 12 60 "3000" 3>&1 1>&2 2>&3)
if [ -z "$WEB_PORT" ]; then WEB_PORT=3000; fi

# Preguntar Puerto SRT
SRT_PORT=$(whiptail --title "Configuración" --inputbox "Introduce el PUERTO BASE para la recepción de señal SRT:\n\n(Ejemplo: 8000)" 12 60 "8000" 3>&1 1>&2 2>&3)
if [ -z "$SRT_PORT" ]; then SRT_PORT=8000; fi

# Confirmación Final
whiptail --title "Resumen de Instalación" --yesno "Se procederá a instalar con la siguiente configuración:\n\n- Panel Web: Puerto $WEB_PORT\n- Señal SRT: Puerto Base $SRT_PORT\n\n¿Deseas iniciar la instalación ahora?" 14 60

if [ $? -ne 0 ]; then
    clear
    echo "Instalación cancelada por el usuario."
    exit 1
fi

clear
echo "🛠️ Iniciando instalación de dependencias base..."
apt-get install -y ffmpeg curl software-properties-common wget build-essential git

echo "📦 Instalando Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo "📂 Configurando el entorno de la aplicación..."
APP_DIR="/opt/srt-server"
rm -rf $APP_DIR
mkdir -p $APP_DIR

echo "💽 Instalando y configurando Auto-Montador moderno de memorias USB (udevil)..."
apt-get install -y ntfs-3g exfatprogs udevil
# Activar el servicio devmon en segundo plano para que escuche cuándo se pincha un USB y lo monte en /media
systemctl enable devmon@root
systemctl start devmon@root

# Descargamos la aplicación a su carpeta definitiva en linux (/opt/) desde GitHub
echo "Copiando archivos..."
# IMPORTANTE: Cambia esta URL por la de tu repositorio de GitHub real.
GITHUB_REPO="https://github.com/tossalet/rtsp-server-tsst.git"
git clone $GITHUB_REPO $APP_DIR
cd $APP_DIR

echo "⚙️ Instalando dependencias de Node (npm install)..."
npm install --production

# Crear archivo .env para el puerto
echo "PORT=$WEB_PORT" > .env
# Si nuestra app lee SRT_PORT del .env, también lo ponemos (dependiendo de nuestra lógica en app)
echo "SRT_BASE_PORT=$SRT_PORT" >> .env

echo "🚀 Creando servicio de arranque automático (Systemd)..."
cat <<EOF > /etc/systemd/system/tsst-srt.service
[Unit]
Description=Servidor SRT TSST y Panel Web
After=network.target

[Service]
ExecStart=/usr/bin/node $APP_DIR/server.js
WorkingDirectory=$APP_DIR
Restart=always
User=root
Environment=PATH=/usr/bin:/usr/local/bin
Environment=NODE_ENV=production
EnvironmentFile=/opt/srt-server/.env

[Install]
WantedBy=multi-user.target
EOF

# Refrescar y activar que inicie en cada arranque
systemctl daemon-reload
systemctl enable tsst-srt.service
systemctl start tsst-srt.service
systemctl status tsst-srt.service --no-pager

LOCAL_IP=$(hostname -I | awk '{print $1}')

whiptail --title "¡Instalación Completada!" --msgbox "El Servidor SRT se ha instalado correctamente y se ha programado para auto-arrancarse cada vez que enciendas la Raspberry.\n\nPuedes acceder a tu panel de control desde cualquier navegador en la red ingresando a:\n\n👉 http://$LOCAL_IP:$WEB_PORT" 15 65

clear
echo "✅ ¡Instalación Finalizada con éxito!"
echo "📍 Panel Web en: http://$LOCAL_IP:$WEB_PORT"
