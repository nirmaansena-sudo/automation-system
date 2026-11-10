# One pinned runtime dependency: H3 geospatial indexing, no paid map service.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY n8n ./n8n
COPY docs ./docs
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 HOST=0.0.0.0
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.js"]
