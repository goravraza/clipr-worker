FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp updated on every build (critical for YouTube bypasses)
RUN pip3 install --no-cache-dir --break-system-packages --upgrade yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.js"]
