FROM node:20-slim

# Install curl, unzip, ca-certificates and official rclone
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
  && curl -fsSL https://rclone.org/install.sh | bash \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

ENV PORT=3456
EXPOSE 3456

CMD ["node", "server.js"]
