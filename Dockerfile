# Node runs the TypeScript sources directly (type stripping) and signs with node:crypto; the only other piece is the
# QUIC sender for the direct path to the leader (Python + aioquic, pinned in py/requirements.txt).
FROM node:24.11.0-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY py/requirements.txt py/requirements.txt
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r py/requirements.txt
ENV PYTHON=/opt/venv/bin/python
COPY package.json ./
COPY src ./src
COPY py ./py
COPY test ./test
ENTRYPOINT ["node", "src/cli.ts"]
CMD ["reproduce"]
