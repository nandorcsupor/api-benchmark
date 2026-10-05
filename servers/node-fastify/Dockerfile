# Build context is the repo root: the image needs data/products.json too.
# Pin the patch version: npm ci pins the libraries, but not the V8 that runs them.
FROM node:24.21.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY servers/node-fastify/package.json servers/node-fastify/package-lock.json ./
RUN npm ci --omit=dev
COPY servers/node-fastify/server.js ./
COPY data/products.json /app/data/products.json
EXPOSE 8080
CMD ["node", "server.js"]
