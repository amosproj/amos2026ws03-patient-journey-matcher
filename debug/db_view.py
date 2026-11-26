"""Database view: read-only, one connection per request."""

from typing import Any

from common import (
    database_target,
    fetch_json,
    first,
    full_text_state,
    has_keyword_index,
    page,
    version,
)

from crawler.store import (
    STORE_LOCK,
)

# Every schema but the system ones: `public`, and one per matching approach, e.g. `keyword`.
USER_SCHEMA = "n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'"
CELL_LIMIT = 300
"""Characters of a value the table view shows; the keyword index has cells of 50,000 words."""
DOCUMENT_SORTS = {
    "changed": "changed_at",
    "retrieved": "retrieved_at",
    "created": "created_at",
    "published": "published_at",
    "expires": "expires_at",
    "title": "lower(title)",
    "id": "id",
    "source": "source",
}
FROM_SEARCH = "jsonb_path_exists(found_by, '$[*].query')"
DOCUMENT_STATS = """
SELECT count(*) AS total,
       count(*) FILTER (WHERE summary IS NOT NULL) AS with_summary,
       count(*) FILTER (WHERE doi IS NOT NULL) AS with_doi,
       count(*) FILTER (WHERE licence IS NOT NULL) AS with_licence,
       count(*) FILTER (WHERE jsonb_array_length(full_text) > 0) AS with_full_text,
       count(*) FILTER (WHERE NOT jsonb_path_exists(found_by, '$[*].query')) AS cited_only,
       count(*) FILTER (WHERE expires_at < now()) AS expired,
       count(*) FILTER (WHERE expires_at >= now() AND expires_at < now() + interval '7 days')
           AS expiring,
       count(*) FILTER (WHERE created_at > now() - interval '1 day') AS new_today,
       max(retrieved_at) AS last_retrieved
FROM documents
"""


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


async def user_tables(connection: Any) -> list[dict[str, Any]]:
    """The tables of every schema, those of the current schema first.

    `name` is the table as Postgres writes it: `documents`, or `keyword.documents` outside the
    search path. Postgres quotes it where needed, so it goes into SQL as it is.
    """
    return await fetch_json(
        connection,
        "SELECT c.oid::regclass::text AS name, n.nspname AS schema FROM pg_class AS c"
        " JOIN pg_namespace AS n ON n.oid = c.relnamespace"
        f" WHERE {USER_SCHEMA} AND c.relkind IN ('r', 'p')"
        " ORDER BY n.nspname <> current_schema(), n.nspname, c.relname",
    )


async def table_names(connection: Any) -> list[str]:
    return [table["name"] for table in await user_tables(connection)]


async def db_overview(connection: Any) -> dict[str, Any]:
    [info] = await fetch_json(
        connection,
        "SELECT current_database() AS database, current_user AS user,"
        " current_setting('server_version') AS version, current_schema() AS schema",
    )
    overview: dict[str, Any] = info
    tables = await user_tables(connection)
    for table in tables:
        name = table["name"]
        table["rows"] = await connection.fetchval(f"SELECT count(*) FROM {name}")
        table["bytes"] = await connection.fetchval(
            "SELECT pg_total_relation_size(to_regclass($1))", name
        )
    names = {table["name"] for table in tables}
    overview |= {
        "target": database_target(),
        "tables": tables,
        "keyword_index": await has_keyword_index(connection),
        "missing": [name for name in ("documents", "crawl_runs") if name not in names],
        "documents": None,
        "runs": None,
    }
    if "documents" in names:
        [stats] = await fetch_json(connection, DOCUMENT_STATS)

        async def facet(expression: str) -> list[Any]:
            return await fetch_json(
                connection,
                f"SELECT {expression} AS value, count(*) AS count FROM documents"
                " GROUP BY 1 ORDER BY 2 DESC, 1",
            )

        stats["sources"] = await facet("source")
        stats["types"] = await facet("content_type")
        stats["licences"] = await facet("licence")
        stats["topics"] = await fetch_json(
            connection,
            "SELECT entry ->> 'topic' AS value, count(DISTINCT d.id) AS count"
            " FROM documents AS d, jsonb_array_elements(d.found_by) AS entry"
            " WHERE entry ->> 'topic' IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1",
        )
        overview["documents"] = stats
    if "crawl_runs" in names:
        last = await fetch_json(connection, "SELECT * FROM crawl_runs ORDER BY id DESC LIMIT 1")
        overview["runs"] = {
            "total": await connection.fetchval("SELECT count(*) FROM crawl_runs"),
            "last": last[0] if last else None,
        }
    return overview


def document_filter(params: dict[str, list[str]], indexed: bool) -> tuple[str, list[Any]]:
    """SQL conditions and arguments for the filters of the documents table.

    `indexed`: the keyword index exists, so its full-text status can be filtered.
    """
    conditions: list[str] = []
    args: list[Any] = []

    def arg(value: Any) -> str:
        args.append(value)
        return f"${len(args)}"

    if text := first(params, "q").lower():
        needle = arg(text)
        conditions.append(
            f"(strpos(lower(title), {needle}) > 0 OR strpos(lower(id), {needle}) > 0"
            f" OR strpos(coalesce(doi, ''), {needle}) > 0)"
        )
    if source := first(params, "source"):
        conditions.append(f"source = {arg(source)}")
    if content_type := first(params, "type"):
        conditions.append(f"content_type = {arg(content_type)}")
    origin = first(params, "origin")
    if origin == "search":
        conditions.append(FROM_SEARCH)
    elif origin == "cited":
        conditions.append(f"NOT {FROM_SEARCH}")
    if topic := first(params, "topic"):
        conditions.append(
            f"found_by @> jsonb_build_array(jsonb_build_object('topic', {arg(topic)}::text))"
        )
    licence = first(params, "licence")
    if licence == ":unknown":
        conditions.append("licence IS NULL")
    elif licence == ":known":
        conditions.append("licence IS NOT NULL")
    elif licence:
        conditions.append(f"licence = {arg(licence)}")
    expiry = first(params, "expiry")
    if expiry == "expired":
        conditions.append("expires_at < now()")
    elif expiry == "soon":
        conditions.append("expires_at >= now() AND expires_at < now() + interval '7 days'")
    elif expiry == "has":
        conditions.append("expires_at IS NOT NULL")
    elif expiry == "none":
        conditions.append("expires_at IS NULL")
    if run_id := first(params, "run"):
        if not run_id.isdigit():
            raise ValueError("run must be the ID of a store run")
        # A run's documents were retrieved while it ran; later runs move retrieved_at on.
        conditions.append(
            f"EXISTS (SELECT FROM crawl_runs AS r WHERE r.id = {arg(int(run_id))}"
            " AND r.source = documents.source"
            " AND documents.retrieved_at BETWEEN r.started_at AND r.finished_at)"
        )
    full_text, detail = first(params, "fulltext"), first(params, "detail")
    if full_text or detail:
        if not indexed:
            raise ValueError("No keyword index yet: run make index")
        # Like the keyword coverage: the indexer leaves expired documents alone.
        conditions.append("(expires_at IS NULL OR expires_at > now())")
        if full_text:
            states = FULL_TEXT_FILTERS.get(full_text)
            if states is None:
                raise ValueError("Unknown full-text state")
            conditions.append(f"{DOCUMENT_FULL_TEXT} = ANY ({arg(states)}::text[])")
        if detail:
            conditions.append(
                "EXISTS (SELECT FROM keyword.full_texts AS f"
                f" WHERE f.document_id = documents.id AND f.detail = {arg(detail)})"
            )
    return " AND ".join(conditions) or "true", args


async def db_documents(connection: Any, params: dict[str, list[str]]) -> dict[str, Any]:
    indexed = await has_keyword_index(connection)
    where, args = document_filter(params, indexed)
    state = DOCUMENT_FULL_TEXT if indexed else "NULL::text"
    sort = DOCUMENT_SORTS.get(first(params, "sort") or "changed")
    if sort is None:
        raise ValueError("Unknown sort column")
    order = "ASC" if first(params, "order") == "asc" else "DESC"
    limit, offset = page(params)
    total = await connection.fetchval(f"SELECT count(*) FROM documents WHERE {where}", *args)
    rows = await fetch_json(
        connection,
        f"""SELECT id, source, content_type, title, published_at, published_precision, licence,
                   doi, retrieved_at, changed_at, created_at, expires_at,
                   {FROM_SEARCH} AS from_search, {state} AS full_text_state,
                   jsonb_array_length(jsonb_path_query_array(found_by, '$[*].cited_by'))
                       AS cited_by,
                   (SELECT coalesce(jsonb_agg(DISTINCT entry ->> 'query'), '[]')
                    FROM jsonb_array_elements(found_by) AS entry WHERE entry ? 'query')
                       AS queries,
                   (SELECT coalesce(jsonb_agg(DISTINCT entry ->> 'topic'), '[]')
                    FROM jsonb_array_elements(found_by) AS entry
                    WHERE entry ->> 'topic' IS NOT NULL) AS topics
            FROM documents
            WHERE {where}
            ORDER BY {sort} {order} NULLS LAST, id
            LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}""",
        *args,
        limit,
        offset,
    )
    return {"total": total, "offset": offset, "limit": limit, "rows": rows}


async def db_document(connection: Any, document_id: str) -> dict[str, Any]:
    rows = await fetch_json(connection, "SELECT * FROM documents WHERE id = $1", document_id)
    if not rows:
        raise LookupError(f"No document {document_id} (deleted or never stored)")
    document = rows[0]
    citing = [entry["cited_by"] for entry in document["found_by"] if "cited_by" in entry]
    titles = {
        row["id"]: row["title"]
        for row in await fetch_json(
            connection, "SELECT id, title FROM documents WHERE id = ANY($1::text[])", citing
        )
    }
    cites = await fetch_json(
        connection,
        "SELECT id, title FROM documents"
        " WHERE found_by @> jsonb_build_array(jsonb_build_object('cited_by', $1::text))"
        " ORDER BY id",
        document_id,
    )
    return {
        "document": document,
        "cited_by": [{"id": item, "title": titles.get(item)} for item in citing],
        "cites": cites,
        "index": await document_index(connection, document_id),
    }


async def db_titles(connection: Any, ids: list[str]) -> dict[str, Any]:
    """Title and kind of the stored documents among `ids`, e.g. the candidates of a match."""
    rows = await fetch_json(
        connection,
        "SELECT id, title, source, content_type FROM documents WHERE id = ANY($1::text[])",
        ids,
    )
    return {"rows": rows}


INDEX_CURRENT = f"i.document_changed_at = date_trunc('milliseconds', {version('d')})"
"""An index row `i` holds the current version of its document `d` (`toIndex` in @matcher/db)."""


async def document_index(connection: Any, document_id: str) -> dict[str, Any] | None:
    """What the keyword index holds of a document; None before the first `make index`."""
    if not await has_keyword_index(connection):
        return None
    metadata = await fetch_json(
        connection,
        f"""SELECT i.content, {INDEX_CURRENT} AS current
            FROM keyword.documents AS i JOIN documents AS d ON d.id = i.document_id
            WHERE i.document_id = $1""",
        document_id,
    )
    words = "string_to_table(i.terms, ' ') AS word WHERE word <> ''"
    full_text = await fetch_json(
        connection,
        f"""SELECT i.status, i.detail, i.url, i.media_type, i.words, i.fetched_at,
                   {INDEX_CURRENT} AS current,
                   (SELECT count(DISTINCT word) FROM {words}) AS distinct_words,
                   (SELECT coalesce(jsonb_agg(top ORDER BY top.count DESC, top.word), '[]')
                    FROM (SELECT word, count(*) AS count FROM {words}
                          GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 30) AS top) AS top_words
            FROM keyword.full_texts AS i JOIN documents AS d ON d.id = i.document_id
            WHERE i.document_id = $1""",
        document_id,
    )
    return {
        "metadata": metadata[0] if metadata else None,
        "full_text": full_text[0] if full_text else None,
    }


async def db_term_test(connection: Any, params: dict[str, list[str]]) -> dict[str, Any]:
    """Whether a search term finds a document, by the rule of the matcher's `matched_terms`."""
    term = first(params, "q")
    if not term:
        raise ValueError("Enter a term")
    if not await has_keyword_index(connection):
        raise ValueError("No keyword index yet: run make index")
    [result] = await fetch_json(
        connection,
        """SELECT tsvector_to_array(to_tsvector('english', $2)) AS stems,
                  (SELECT to_tsvector('english', i.content) @@ query
                   FROM keyword.documents AS i WHERE i.document_id = $1) AS metadata,
                  (SELECT i.lexemes @@ query FROM keyword.full_texts AS i
                   WHERE i.document_id = $1 AND i.status = 'indexed') AS full_text
           FROM plainto_tsquery('english', $2) AS query""",
        first(params, "id"),
        term,
    )
    return {"term": term, **result}


async def db_runs(connection: Any, params: dict[str, list[str]]) -> dict[str, Any]:
    limit, offset = page(params)
    rows = await fetch_json(
        connection, "SELECT * FROM crawl_runs ORDER BY id DESC LIMIT $1 OFFSET $2", limit, offset
    )
    total = await connection.fetchval("SELECT count(*) FROM crawl_runs")
    return {"total": total, "offset": offset, "limit": limit, "rows": rows}


async def db_schema(connection: Any) -> dict[str, Any]:
    return {
        "columns": await fetch_json(
            connection,
            f"""SELECT c.oid::regclass::text AS table, a.attname AS name,
                       format_type(a.atttypid, a.atttypmod) AS type,
                       NOT a.attnotnull AS nullable,
                       CASE WHEN a.attidentity <> '' THEN 'identity'
                            WHEN a.attgenerated <> ''
                                THEN 'generated: ' || pg_get_expr(d.adbin, d.adrelid)
                            ELSE pg_get_expr(d.adbin, d.adrelid) END AS default
                FROM pg_attribute AS a
                JOIN pg_class AS c ON c.oid = a.attrelid
                JOIN pg_namespace AS n ON n.oid = c.relnamespace
                LEFT JOIN pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE {USER_SCHEMA} AND c.relkind IN ('r', 'p')
                  AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY c.oid, a.attnum""",
        ),
        "constraints": await fetch_json(
            connection,
            f"""SELECT o.conrelid::regclass::text AS table, o.conname AS name,
                       pg_get_constraintdef(o.oid) AS definition
                FROM pg_constraint AS o JOIN pg_namespace AS n ON n.oid = o.connamespace
                -- NOT NULL is in the columns already (PostgreSQL 18 lists it here, too).
                WHERE {USER_SCHEMA} AND o.conrelid <> 0 AND o.contype <> 'n'
                ORDER BY 1, o.contype, 2""",
        ),
        "indexes": await fetch_json(
            connection,
            f"""SELECT i.indrelid::regclass::text AS table, c.relname AS name,
                       pg_get_indexdef(i.indexrelid) AS definition,
                       pg_relation_size(i.indexrelid) AS bytes
                FROM pg_index AS i
                JOIN pg_class AS c ON c.oid = i.indexrelid
                JOIN pg_namespace AS n ON n.oid = c.relnamespace
                WHERE {USER_SCHEMA} ORDER BY 1, 2""",
        ),
        "extensions": await fetch_json(
            connection,
            "SELECT extname AS name, extversion AS version FROM pg_extension"
            " WHERE extname <> 'plpgsql' ORDER BY 1",
        ),
    }


async def emptying_plan(connection: Any, names: list[str]) -> dict[str, Any]:
    """What emptying `names` deletes: those tables and every table that references them."""
    existing = await table_names(connection)
    if not names:
        raise ValueError("Choose at least one table")
    if unknown := [name for name in names if name not in existing]:
        raise LookupError(f"No table {', '.join(unknown)}")
    tables = await fetch_json(
        connection,
        """WITH RECURSIVE targets (oid) AS (
               SELECT to_regclass(name)::oid FROM unnest($1::text[]) AS name
               UNION
               SELECT c.conrelid FROM pg_constraint AS c
               JOIN targets AS t ON c.confrelid = t.oid WHERE c.contype = 'f'
           )
           SELECT oid::regclass::text AS name FROM pg_class
           WHERE oid IN (SELECT oid FROM targets) ORDER BY 1""",
        names,
    )
    for table in tables:
        table["rows"] = await connection.fetchval(f"SELECT count(*) FROM {table['name']}")
        table["requested"] = table["name"] in names
    database = await connection.fetchval("SELECT current_database()")
    return {"database": database, "tables": tables}


async def empty_tables(connection: Any, names: list[str], confirm: str) -> dict[str, Any]:
    """Delete every row of `names` and the tables that reference them, in one transaction."""
    database = await connection.fetchval("SELECT current_database()")
    if confirm != database:
        raise ValueError(f"Type the database name, {database}, to confirm")
    async with connection.transaction():
        # Waits for a store run that is writing, as store runs wait for each other.
        await connection.execute("SELECT pg_advisory_xact_lock($1)", STORE_LOCK)
        plan = await emptying_plan(connection, names)
        tables = ", ".join(table["name"] for table in plan["tables"])
        await connection.execute(f"TRUNCATE TABLE {tables} RESTART IDENTITY")
    return {"database": database, "emptied": plan["tables"]}


async def db_table(connection: Any, params: dict[str, list[str]]) -> dict[str, Any]:
    """Any table, e.g. one of an index, as plain rows; long values are cut to `CELL_LIMIT`."""
    name = first(params, "name")
    if name not in await table_names(connection):
        raise LookupError(f"No table {name}")
    limit, offset = page(params)
    columns = [
        column["name"]
        for column in await fetch_json(
            connection,
            "SELECT attname AS name FROM pg_attribute WHERE attrelid = to_regclass($1)"
            " AND attnum > 0 AND NOT attisdropped ORDER BY attnum",
            name,
        )
    ]

    def cell(column: str) -> str:
        value = f"t.{quote_ident(column)}"
        return (
            f"CASE WHEN length({value}::text) > {CELL_LIMIT}"
            f" THEN to_jsonb(left({value}::text, {CELL_LIMIT}) || ' … ('"
            f" || length({value}::text) || ' characters)')"
            f" ELSE to_jsonb({value}) END AS {quote_ident(column)}"
        )

    return {
        "name": name,
        "columns": columns,
        "total": await connection.fetchval(f"SELECT count(*) FROM {name}"),
        "offset": offset,
        "limit": limit,
        "rows": await fetch_json(
            connection,
            f"SELECT {', '.join(map(cell, columns))} FROM {name} AS t"
            f" ORDER BY t.{quote_ident(columns[0])} LIMIT $1 OFFSET $2",
            limit,
            offset,
        ),
    }


DOCUMENT_FULL_TEXT = (
    f"coalesce((SELECT {full_text_state('f', 'documents')} FROM keyword.full_texts AS f"
    " WHERE f.document_id = documents.id), 'new')"
)
"""The full-text state of a row of the documents table."""
FULL_TEXT_FILTERS = {
    "indexed": ["indexed"],
    "skipped": ["skipped"],
    "failed": ["failed"],
    "unread": ["new", "changed"],
}
"""The full-text filter of the documents table: the columns of the keyword coverage."""
