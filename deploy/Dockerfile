FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates util-linux python3-venv \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=build-ca \
    if [ -r /run/secrets/build-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build-ca; fi; \
    npm install --global --fetch-retries=1 bun@1.3.14 @openai/codex@0.171.0 \
    && bun --version && codex --version \
    && groupadd --gid 10001 tradingsim-agent \
    && useradd --uid 10001 --gid 10001 --create-home tradingsim-agent \
    && install -d -m 0700 -o 10001 -g 10001 /home/tradingsim-agent/.codex
RUN --mount=type=secret,id=build-ca \
    python3 -m venv /opt/alpaca-mcp \
    && if [ -r /run/secrets/build-ca ]; then export PIP_CERT=/run/secrets/build-ca; fi \
    && /opt/alpaca-mcp/bin/pip install --disable-pip-version-check 'alpaca-mcp-server==2.4.1' \
    && /opt/alpaca-mcp/bin/alpaca-mcp-server --version
ENV PATH="/opt/alpaca-mcp/bin:${PATH}"
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV TRADINGSIM_STATE_DIR=/var/lib/tradingsim \
    TRADINGSIM_CODEX_ISOLATE=1 \
    CODEX_HOME=/home/tradingsim-agent/.codex \
    HOME=/home/tradingsim-agent
ENTRYPOINT ["bun", "src/cli.ts"]
CMD ["schedule"]
