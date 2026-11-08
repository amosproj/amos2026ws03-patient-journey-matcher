# The pgvector image plus pg_textsearch (BM25 ranking, PostgreSQL License) for the keyword index.
FROM pgvector/pgvector:pg18
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-18-pg-textsearch=1.5.1-1.pgdg12+1 \
    && rm -rf /var/lib/apt/lists/*
