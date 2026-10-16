# tresjr-installer — installs and updates tresjr on a Kubernetes cluster or
# with Docker / Podman (SELF_HOSTING.md): the same installer as on Cloudflare,
# on Node. On Kubernetes its state is in a Secret and it talks to the cluster
# with its service account (installed by the Helm chart tresjr-installer);
# with compose (INSTALLER_TARGET=docker) its state is in /data and it talks
# to the engine through its socket. Everything else it does itself.
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
      org.opencontainers.image.description="tresjr installer — installs and updates tresjr on Kubernetes or with Docker / Podman"
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /src/dist/node.mjs ./dist/node.mjs
USER node
EXPOSE 8080
CMD ["node", "dist/node.mjs"]
