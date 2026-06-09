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

ARG GITHUB_TOKEN

RUN git config --global http.sslVerify false \
  && if [ -n "$HTTP_PROXY" ]; then \
    git config --global http.proxy "$HTTP_PROXY" && \
    git config --global https.proxy "${HTTPS_PROXY:-$HTTP_PROXY}"; \
  fi \
  && if [ -n "$GITHUB_TOKEN" ]; then \
    git config --global url."https://${GITHUB_TOKEN}:x-oauth-basic@github.com/".insteadOf "https://github.com/" && \
    git config --global url."https://${GITHUB_TOKEN}:x-oauth-basic@github.com/".insteadOf "git@github.com:" && \
    git config --global url."https://${GITHUB_TOKEN}:x-oauth-basic@github.com/".insteadOf "ssh://git@github.com/"; \
  fi

COPY package.json package-lock.json ./

# npm honors lockfile "resolved" URLs; ours was pinned to git+ssh despite package.json using https.
RUN sed -i 's|git+ssh://git@github.com/|git+https://github.com/|g' package-lock.json

ARG GITHUB_TOKEN

RUN git config --global http.sslVerify false \
  && if [ -n "$HTTP_PROXY" ]; then \
    git config --global http.proxy "$HTTP_PROXY" && \
    git config --global https.proxy "${HTTPS_PROXY:-$HTTP_PROXY}"; \
  fi \
  && if [ -n "$GITHUB_TOKEN" ]; then \
    git config --global url."https://${GITHUB_TOKEN}:x-oauth-basic@github.com/".insteadOf "https://github.com/" && \
    git config --global url."https://${GITHUB_TOKEN}:x-oauth-basic@github.com/".insteadOf "git@github.com:" && \
    git config --global url."https://${GITHUB_TOKEN}:x-oauth-basic@github.com/".insteadOf "ssh://git@github.com/"; \
  fi \
  && npm config set strict-ssl false \
  && npm config set fetch-retries 8 \
  && npm config set fetch-retry-factor 2 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 180000 \
  && npm config set fetch-timeout 600000 \
  && if [ -n "$HTTP_PROXY" ]; then \
    npm config set proxy "$HTTP_PROXY" && \
    npm config set https-proxy "${HTTPS_PROXY:-$HTTP_PROXY}"; \
  fi \
  && if [ -n "$GITHUB_TOKEN" ]; then \
    echo "Pre-installing @vurb-tech/shared via authenticated HTTPS"; \
    GIT_SSL_NO_VERIFY=1 NODE_TLS_REJECT_UNAUTHORIZED=0 npm install \
      "git+https://${GITHUB_TOKEN}:x-oauth-basic@github.com/ctesene/vurb-tech-shared.git#cfa0810064433f04440569217dcb947c1a7c6916" \
      --omit=dev --ignore-scripts --no-audit --no-fund; \
  fi \
  && for attempt in 1 2 3 4 5; do \
    echo "npm install attempt ${attempt}/5"; \
    GIT_SSL_NO_VERIFY=1 NODE_TLS_REJECT_UNAUTHORIZED=0 npm install --omit=dev --ignore-scripts && break; \
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

CMD ["node", "trackside-offroad-listener.js"]
