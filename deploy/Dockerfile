# Multi-stage: build the JavaScript, then keep only production dependencies.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json tsconfig.build.json ./
COPY server ./server
COPY sdk ./sdk
COPY cli ./cli
COPY bin ./bin
RUN npm ci --ignore-scripts && npm run build

FROM node:22-alpine
ENV NODE_ENV=production AGENTLINK_DATA_DIR=/data PORT=8787 HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --omit=peer --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/bin ./bin
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "bin/agentlink-server.mjs"]
