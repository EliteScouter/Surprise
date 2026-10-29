FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
# Pick up OS security patches released since the base image was published.
RUN apk upgrade --no-cache
COPY package.json package-lock.json ./
# Install exactly the locked dependency tree, then remove the package managers so an
# attacker who gets code execution can't use them to pull in tooling.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/lib/node_modules/corepack /usr/local/bin/corepack
COPY server.js ./
COPY lib ./lib
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
