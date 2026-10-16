# tresjr-installer — installs and updates tresjr on a Kubernetes cluster
# (SELF_HOSTING.md): the same installer as on Cloudflare, on Node, its state
# in a Secret, talking to the cluster with its service account. Installed
# by the Helm chart (tresjr-installer); everything else it does itself.
# The bundle is plain JavaScript: built once, on the build machine's own
# platform; only the image below is per architecture (amd64, arm64).
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:node

FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/arcanum-pos/arcanum-installer" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.description="tresjr installer — installs and updates tresjr on Kubernetes"
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /src/dist/node.mjs ./dist/node.mjs
USER node
EXPOSE 8080
CMD ["node", "dist/node.mjs"]
