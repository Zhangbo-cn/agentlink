FROM node:22-alpine
ENV NODE_ENV=production AGENTLINK_DATA_DIR=/data PORT=8787 HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --omit=peer --ignore-scripts && npm cache clean --force
COPY server ./server
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "--experimental-transform-types", "--no-warnings", "server/src/main.ts"]
