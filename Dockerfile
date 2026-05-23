FROM node:20-slim

ENV NODE_ENV=production

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

RUN npm ci --omit=dev && rm -rf /root/.cache

# Copy application code
COPY server.js ./
COPY lib ./lib

# Run as non-root user
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
