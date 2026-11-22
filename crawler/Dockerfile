# The image of the crawler-<source> services in compose.yaml, one container per source
# (Documentation/build-deploy/deployment.md#scheduled-crawls). Debian, not Alpine: biopython has no musl wheel.
FROM python:3.12-slim-trixie
COPY --from=ghcr.io/astral-sh/uv:0.13 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
# Dependencies first, so a code change does not install them again.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --locked --no-dev --no-install-project
# Editable install (the uv default): the crawler finds topics/ next to src/.
COPY src src
COPY topics topics
RUN uv sync --locked --no-dev
USER nobody
ENTRYPOINT ["/app/.venv/bin/crawler"]
