# No npm dependencies: Node runs the TypeScript sources directly (type stripping) and signs with node:crypto.
FROM node:24.11.0-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test
ENTRYPOINT ["node", "src/cli.ts"]
CMD ["help"]
