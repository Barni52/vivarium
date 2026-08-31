// Inline Dockerfiles ported from claude-box.ps1 (ref lines 344-506), with the
// entire tmux layer removed: no tmux, no /etc/tmux.conf, no tmux-help, no
// tmux-based clip-paste. Vivarium drives everything from the app UI instead.
//
// Bump IMAGE_VERSION to force stale images to rebuild. It is written as a label
// and checked before every container start.

export const IMAGE_VERSION = '1'

export const SLIM_IMAGE = 'vivarium:slim'
export const FULL_IMAGE = 'vivarium:full'

// Reuse the reference script's volume names so an existing claude-box setup's
// auth (.credentials.json), settings (.claude.json), memory, and caches carry
// over into Vivarium unchanged — sign in once, stay signed in.
export const CREDS_VOLUME = 'claude-box-creds' // shared: /home/node/.claude
export const HOME_VOLUME = 'claude-box-home' //  shared: all of /home/node

// Host services the container must reach at localhost:PORT (ported from ref 66-70).
export const BACKEND_PORTS = ['9980', '8080', '9090'] // Tomcat, Keycloak, 9090 backend

export function slimDockerfile(): string {
  return `FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \\
        git curl wget gnupg ca-certificates sudo less jq procps openssh-client socat \\
        ripgrep unzip xz-utils ncurses-term \\
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# host-forward: for each port in $HOST_FORWARD_PORTS, listen on the container's
# own localhost:PORT and relay to $HOST_FORWARD_TARGET:PORT, then exec the real
# command. Lets the app/tests keep calling localhost:PORT unchanged while
# actually reaching a backend on the host. No-op if HOST_FORWARD_PORTS is empty.
RUN printf '%s\\n' \\
        '#!/usr/bin/env bash' \\
        'target="\${HOST_FORWARD_TARGET:-host.docker.internal}"' \\
        'if [ -n "$HOST_FORWARD_PORTS" ]; then' \\
        '  for p in \${HOST_FORWARD_PORTS//,/ }; do' \\
        '    echo "[vivarium] localhost:$p -> $target:$p" >&2' \\
        '    socat "TCP-LISTEN:$p,fork,reuseaddr" "TCP:$target:$p" &' \\
        '  done' \\
        'fi' \\
        'exec "$@"' \\
        > /usr/local/bin/host-forward \\
    && chmod +x /usr/local/bin/host-forward

RUN echo "node ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers \\
    && mkdir -p /home/node/.claude /workspace /clip \\
    && chown -R node:node /home/node /workspace /clip

LABEL vivarium.version="${IMAGE_VERSION}"
LABEL vivarium.variant="slim"

USER node
WORKDIR /workspace
ENV CLAUDE_CONFIG_DIR=/home/node/.claude
# UTF-8 locale: without it the shell runs in the POSIX C locale and mangles all
# box-drawing/Unicode output (broken TUI rendering).
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
CMD ["bash"]
`
}

export function fullDockerfile(): string {
  return `FROM ${SLIM_IMAGE}
USER root

# Temurin JDK 25 (mvnw downloads Maven itself into ~/.m2)
RUN wget -qO- https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /usr/share/keyrings/adoptium.gpg \\
    && echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb bookworm main" > /etc/apt/sources.list.d/adoptium.list \\
    && apt-get update && apt-get install -y --no-install-recommends temurin-25-jdk \\
    && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64

RUN npm install -g pnpm@11.5.2 playwright

# headless Chromium (+ its OS libs) for in-container browser testing; browsers
# live outside /home so the home volume never hides them.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN playwright install --with-deps chromium && chmod -R a+rX /opt/ms-playwright
ENV NODE_PATH=/usr/local/lib/node_modules

LABEL vivarium.version="${IMAGE_VERSION}"
LABEL vivarium.variant="full"

USER node
`
}
