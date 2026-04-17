FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Create default storage directory
RUN mkdir -p /data/storage

ENV STORAGE_DIR=/data/storage \
    PORT=3000 \
    PUBLIC_DOMAIN=localhost \
    REPO_NAME=my-cloud \
    ADMIN_USER=admin \
    ADMIN_PASS=changeme \
    MAX_BYTES=107374182400

EXPOSE 3000

VOLUME ["/data/storage"]

CMD ["node", "server.js"]
