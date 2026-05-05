# ============================================================
# Race Control Server — Docker Image
# Base: Debian 12 (Bookworm) + Node.js 20 LTS
# Hardware: Intel UHD 630 (QSV via VAAPI)
# ============================================================
FROM node:20-bookworm-slim

# ── Sistema: repositorios contrib/non-free para drivers Intel ──
RUN sed -i 's/Components: main/Components: main contrib non-free non-free-firmware/g' \
    /etc/apt/sources.list.d/debian.sources 2>/dev/null || true

# ── Sistema: paquetes necesarios ──────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    sqlite3 \
    iproute2 \
    curl \
    intel-media-va-driver \
    vainfo \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# ── App: directorio de trabajo ────────────────────────────────
WORKDIR /usr/src/app

# ── App: instalar dependencias npm (SOLO package.json primero) ─
# Este paso se hace ANTES de copiar el código fuente.
# Así las dependencias nativas (sqlite3) se compilan para Linux.
COPY package*.json ./
RUN npm install --omit=dev

# ── App: copiar el código fuente ──────────────────────────────
# node_modules ya existe y es Linux-nativo, no se sobreescribe.
COPY server.js ./
COPY streamManager.js ./
COPY public ./public/

# ── Red: puertos expuestos ────────────────────────────────────
EXPOSE 4000
EXPOSE 1024-50000/udp

# ── Arranque ──────────────────────────────────────────────────
CMD ["node", "server.js"]
