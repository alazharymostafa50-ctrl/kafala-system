FROM node:22-bookworm-slim
# Chromium لإنتاج PDF، وأدوات PostgreSQL للنسخ الاحتياطي، وخطوط عربية احتياطية
RUN apt-get update && apt-get install -y --no-install-recommends chromium postgresql-client fonts-noto-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production CHROME_PATH=/usr/bin/chromium STORAGE_DIR=/data/storage HOST=0.0.0.0
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN useradd -r -u 10001 kafala && mkdir -p /data/storage && chown -R kafala /data
USER kafala
EXPOSE 3000
CMD ["node", "server.js"]
