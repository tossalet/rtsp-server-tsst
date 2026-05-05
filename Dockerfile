# Base image build on Debian 12 (Bookworm) — Race Control Server
FROM node:20-bookworm-slim

# Habilitar repositorios non-free para drivers de Intel
RUN sed -i 's/Components: main/Components: main contrib non-free non-free-firmware/g' /etc/apt/sources.list.d/debian.sources || true

# Install FFMpeg, networking utilities and Intel QSV Hardware Acceleration drivers
RUN apt-get update && apt-get install -y \
    ffmpeg \
    sqlite3 \
    iproute2 \
    curl \
    intel-media-va-driver \
    intel-media-va-driver-non-free \
    libvpl2 \
    libmfxgen1 \
    vainfo \
    && rm -rf /var/lib/apt/lists/*

# Create working directory
WORKDIR /usr/src/app

# Copy package info
COPY package*.json ./

# Install npm dependencies
RUN npm install

# Copy application files
COPY . .

# Expose Web Panel & API port
EXPOSE 4000
# Expose default SRT/UDP port ranges (example: 1024-50000 range, usually map via host networking anyway)
EXPOSE 1024-50000/udp

# Set initial database if needed (SQLite auto-creates so it's fine)
# Start the backend node process
CMD ["node", "server.js"]
