# tresjr-installer — installs and updates tresjr on a Kubernetes cluster or
# with Docker / Podman (SELF_HOSTING.md): the same installer as on Cloudflare,
# on Node. On Kubernetes its state is in a Secret and it talks to the cluster
# with its service account (installed by the Helm chart tresjr-installer);
# with compose (INSTALLER_TARGET=docker) its state is in /data and it talks
# to the engine through its socket. Everything else it does itself.
# The bundle is plain JavaScript: built once, on the build machine's own
# platform; only the image below is per architecture (amd64, arm64).
FROM --platform=$BUILDPLATFORM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS build
WORKDIR /src
# An empty /data for the image below (it has no mkdir).
RUN mkdir -p /data
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:node

# The image that runs: distroless — Node 24 on Debian, nothing else (no
# shell, no package manager: less to patch). Node is its entrypoint. As uid
# 1000, like the Alpine image before (the installer runs it so; existing data
# volumes belong to it).
FROM gcr.io/distroless/nodejs24-debian13@sha256:51eee69b25037942014428da85f5b436a4d88f283e545981d03f25b7db72469a
LABEL org.opencontainers.image.source="https://github.com/arcanum-pos/arcanum-installer" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.description="tresjr installer — installs and updates tresjr on Kubernetes or with Docker / Podman"
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build --chown=1000:1000 /data /data
COPY --from=build /src/dist/node.mjs ./dist/node.mjs
# An installer from before this image starts the next one as
# `node dist/node.mjs replace-installer …` (its own update with Docker);
# here node is the entrypoint already, so "node" is this file, which runs
# the script it was given.
COPY docker/node ./node
USER 1000:1000
EXPOSE 8080
CMD ["dist/node.mjs"]
