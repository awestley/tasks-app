FROM node:24-bookworm-slim AS web
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM ghcr.io/astral-sh/uv:0.9.5 AS uv
FROM python:3.12-slim-bookworm
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app/api
COPY api/pyproject.toml api/uv.lock ./
RUN uv sync --frozen --no-dev
COPY api/ ./
COPY --from=web /build/web/dist /app/web/dist
RUN useradd --create-home --uid 10001 taskwell && chown -R taskwell:taskwell /app
USER taskwell
ENV PATH="/app/api/.venv/bin:$PATH" STATIC_DIRECTORY=/app/web/dist TASKWELL_API_URL=http://127.0.0.1:8080
EXPOSE 8080
CMD ["uvicorn", "taskwell.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
