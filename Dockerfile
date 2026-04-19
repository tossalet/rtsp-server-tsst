# Base image build on Debian 11 (Bullseye) to mimic the OnPremise firmware natively
FROM node:18-bullseye-slim

# Install FFMpeg and other required networking utilities for TSST Server
RUN apt-get update && apt-get install -y \
    ffmpeg \
    sqlite3 \
    iproute2 \
    curl \
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
