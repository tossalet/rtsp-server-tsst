# ============================================================
# Race Control Server — Docker Image
# Base: Debian 12 (Bookworm) + Node.js 20 LTS
# Hardware: Intel UHD 630 (QSV via VAAPI)
# ============================================================
FROM node:20-bookworm-slim

# ── Sistema: repositorios contrib/non-free para drivers Intel ──
RUN sed -i 's/Components: main/Components: main contrib non-free non-free-firmware/g' \
    /etc/apt/sources.list.d/debian.sources 2>/dev/null || true

# ── Sistema: solo lo necesario en tiempo de ejecución ─────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    intel-media-va-driver \
    vainfo \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# ── Dependencias primero (capa cacheada si no cambia package.json) ──
# Las herramientas de compilación solo se usan si sqlite3 no trae binario precompilado y se eliminan en la misma capa
COPY package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y python3 make g++ && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /root/.npm

# ── Código fuente (.dockerignore excluye node_modules, ffmpeg de Windows, media, BD...) ──
COPY . .

EXPOSE 4000
# Con network_mode: host (docker-compose) no hace falta publicar el rango de puertos SRT

CMD ["node", "server.js"]
