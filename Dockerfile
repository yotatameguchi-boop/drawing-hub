FROM node:24-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app
COPY server/ ./server/
COPY index.html guide.html ./

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server/server.mjs"]
