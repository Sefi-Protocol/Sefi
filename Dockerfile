# Single image that can run any Sefi app via the APP build arg (api|worker|demo-agent).
FROM node:22-alpine
ARG APP=api
ENV APP=${APP}
WORKDIR /app

RUN corepack enable

# Install deps with the workspace manifests first for better layer caching.
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY services ./services
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile || pnpm install

EXPOSE 8080
# tsx runs the TypeScript entrypoints directly (no build step needed for MVP).
CMD ["sh", "-c", "pnpm --filter @sefi/${APP} start"]
