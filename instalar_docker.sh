#!/bin/bash

# Comprobar root
if [ "$EUID" -ne 0 ]; then
  echo "❌ Error: Por favor, ejecuta este instalador con permisos de administrador (root)."
  echo "👉 Usa el comando: sudo bash instalar_docker.sh"
  exit
fi

clear
echo "============================================================"
echo "🚀 INSTALADOR RÁPIDO CON DOCKER PARA RTSP SERVER TSST"
echo "============================================================"
echo "Este script preparará tu equipo (HP EliteDesk con Intel UHD)"
echo "instalando Docker y levantando el servidor automáticamente."
echo "============================================================"
echo ""

# 1. Instalar dependencias básicas si no están
echo "📦 Instalando curl y dependencias previas..."
apt-get update -qq
apt-get install -y curl udevil ntfs-3g exfatprogs

# 2. Configurar auto-montador de USB para que pase a Docker
echo "💽 Configurando automontaje de discos duros/USB..."
systemctl enable devmon@root
systemctl start devmon@root

# 3. Instalar Docker si no existe
if ! command -v docker &> /dev/null; then
    echo "🐳 Docker no encontrado. Descargando e instalando Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
else
    echo "✅ Docker ya está instalado en el sistema."
fi

# 4. Iniciar y habilitar Docker
systemctl enable docker
systemctl start docker

# 5. Levantar el contenedor
echo "🏗️ Construyendo y levantando el servidor con aceleración Intel UHD..."
echo "(Esto puede tardar unos minutos la primera vez que descargue la imagen base)"

# Si docker-compose plugin está instalado (v2) usamos `docker compose`, sino `docker-compose` v1
if docker compose version &> /dev/null; then
    docker compose up -d --build
else
    # Instalar docker-compose si es muy viejo y no está como plugin
    apt-get install -y docker-compose
    docker-compose up -d --build
fi

# 6. Mostrar el resultado final
LOCAL_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "============================================================"
echo "✨ ¡INSTALACIÓN COMPLETADA CON ÉXITO! ✨"
echo "============================================================"
echo "Tu servidor está en marcha con aceleración gráfica por hardware activada."
echo ""
echo "📍 Panel de control web:"
echo "👉 http://$LOCAL_IP:4000"
echo ""
echo "ℹ️  Nota: Si conectas un disco USB, Docker lo reconocerá automáticamente."
echo "============================================================"
