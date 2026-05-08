FROM python:3.12-slim-bookworm

ARG NODE_VERSION=22.21.1
ARG TARGETARCH

ENV AXCUT_MODEL_CACHE=/app/.cache/axcut/models \
    DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      ffmpeg \
      xz-utils; \
    rm -rf /var/lib/apt/lists/*; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in \
      amd64) node_arch="x64" ;; \
      arm64) node_arch="arm64" ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    tar -xJf "node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -C /usr/local --strip-components=1; \
    rm "node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    npm --version; \
    node --version; \
    pip install --no-cache-dir uv

COPY package.json package-lock.json pyproject.toml README.md ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/axcut-schema/package.json packages/axcut-schema/package.json

RUN npm ci

COPY . .

RUN uv venv .venv && uv pip install -e .

EXPOSE 5173

CMD ["npm", "run", "dev:docker"]
