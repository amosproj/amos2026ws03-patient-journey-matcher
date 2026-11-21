# The pgvector image plus pg_textsearch (BM25 ranking, PostgreSQL License) for the keyword index.
# Debian 13 by name: the package version below exists only for it (pgdg13). pgvector by version,
# like pg_textsearch: raise it with each pgvector release, as older tags are no longer rebuilt with
# PostgreSQL's minor updates. .github/workflows/ci.yml uses the same tag.
FROM pgvector/pgvector:0.8.7-pg18-trixie
# pgdg archive: keeps every version, pgdg drops old ones; HTTPS only, hence ca-certificates
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && echo "deb [ signed-by=/usr/local/share/keyrings/postgres.gpg.asc ] https://apt-archive.postgresql.org/pub/repos/apt trixie-pgdg-archive main" \
        > /etc/apt/sources.list.d/pgdg-archive.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-18-pg-textsearch=1.5.1-1.pgdg13+1 \
    && rm -rf /var/lib/apt/lists/*
