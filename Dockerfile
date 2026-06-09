FROM node:20-bookworm

WORKDIR /app

# Private @vurb-tech/shared — match Coolify's x-access-token git auth pattern.
ARG GITHUB_TOKEN
RUN if [ -n "$GITHUB_TOKEN" ]; then \
  git config --global http.sslVerify false && \
  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/" && \
  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:" && \
  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "ssh://git@github.com/"; \
  fi

COPY package.json package-lock.json ./

# npm uses lockfile "resolved" URLs; rewrite any stale git+ssh entries.
# Do not route npm/git through HTTP_PROXY during build — it causes EIDLETIMEOUT
# on registry.npmjs.org and git 128 on GitHub. Proxy is set at runtime below.
RUN sed -i 's|git+ssh://git@github.com/|git+https://github.com/|g' package-lock.json \
  && for attempt in 1 2 3 4 5; do \
    echo "npm install attempt ${attempt}/5"; \
    HTTP_PROXY= HTTPS_PROXY= http_proxy= https_proxy= \
    NODE_TLS_REJECT_UNAUTHORIZED=0 npm install --omit=dev --ignore-scripts && break; \
    if [ "$attempt" -eq 5 ]; then \
      echo "npm install failed after 5 attempts"; \
      exit 1; \
    fi; \
    sleep 20; \
  done

COPY . .

RUN for attempt in 1 2 3 4 5; do \
    echo "Prisma generate attempt ${attempt}/5"; \
    NODE_TLS_REJECT_UNAUTHORIZED=0 npm run prisma:generate && break; \
    if [ "$attempt" -eq 5 ]; then \
      echo "Prisma generate failed after 5 attempts"; \
      exit 1; \
    fi; \
    sleep 15; \
  done \
  && npm run verify:prisma-client

# Runtime proxy for scraping (not applied during npm install above).
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY:-$HTTP_PROXY}
ENV NO_PROXY=${NO_PROXY}
ENV http_proxy=${HTTP_PROXY}
ENV https_proxy=${HTTPS_PROXY:-$HTTP_PROXY}
ENV no_proxy=${NO_PROXY}

CMD ["node", "trackside-offroad-listener.js"]
