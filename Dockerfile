FROM node:20-bookworm

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY:-$HTTP_PROXY}
ENV NO_PROXY=${NO_PROXY}
ENV http_proxy=${HTTP_PROXY}
ENV https_proxy=${HTTPS_PROXY:-$HTTP_PROXY}
ENV no_proxy=${NO_PROXY}

WORKDIR /app

# GITHUB_TOKEN: Add as build secret in Coolify for private repo access
ARG GITHUB_TOKEN
RUN if [ -n "$GITHUB_TOKEN" ]; then \
  git config --global url."https://${GITHUB_TOKEN}:x-oauth-basic@github.com/".insteadOf "https://github.com/" && \
  git config --global url."https://${GITHUB_TOKEN}:x-oauth-basic@github.com/".insteadOf "git@github.com:" && \
  git config --global url."https://${GITHUB_TOKEN}:x-oauth-basic@github.com/".insteadOf "ssh://git@github.com/"; \
fi

COPY . .

RUN npm config set strict-ssl false \
    && npm config set proxy "$HTTP_PROXY" \
    && npm config set https-proxy "${HTTPS_PROXY:-$HTTP_PROXY}" \
    && npm config set fetch-retries 8 \
    && npm config set fetch-retry-factor 2 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 180000 \
    && npm config set fetch-timeout 300000 \
    && for attempt in 1 2 3 4 5; do \
      echo "npm install attempt ${attempt}/5"; \
      NODE_TLS_REJECT_UNAUTHORIZED=0 npm install --omit=dev --ignore-scripts && break; \
      if [ "$attempt" -eq 5 ]; then \
        echo "npm install failed after 5 attempts"; \
        exit 1; \
      fi; \
      sleep 20; \
    done \
    && for attempt in 1 2 3 4 5; do \
      echo "Prisma generate attempt ${attempt}/5"; \
      NODE_TLS_REJECT_UNAUTHORIZED=0 npm run prisma:generate && break; \
      if [ "$attempt" -eq 5 ]; then \
        echo "Prisma generate failed after 5 attempts"; \
        exit 1; \
      fi; \
      sleep 15; \
    done \
    && npm run verify:prisma-client

CMD ["node", "trackside-offroad-listener.js"]
