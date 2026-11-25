# Postgres result storage

Hurdle runs locally and saves results to `.hurdle/results-v1` by default. Follow this
guide only when you need Postgres storage.

In an evaluation project, run `npx hurdle setup --store postgres` with an
existing database URL. It checks the connection, applies the schema, and saves
storage settings while preserving Local or Together execution. See
[sandbox and storage setup](./sandbox-setup.md#use-postgres-for-results). The
manual steps below support custom Runtime files when working from a repository
checkout.

| Runtime | Execution | Result store |
| --- | --- | --- |
| Default | Local | Filesystem |
| `postgres` | Local | Postgres |
| `together-postgres` | Together sandbox | Postgres |

## 1. Configure credentials

Add only the services you use to the ignored `.env.local` file:

```sh
ANTHROPIC_API_KEY=...
TOGETHER_API_KEY=...
HURDLE_RESULT_STORE_DATABASE_URL=postgresql://...
```

The Together Suites need the Anthropic and Together keys. Postgres needs
`HURDLE_RESULT_STORE_DATABASE_URL`. Existing `TAE_RESULT_STORE_DATABASE_URL`
credentials remain supported; new projects should use the Hurdle name. The
Hurdle variable takes precedence when present, even if empty; the legacy name
applies only when it is absent. For the same variable name, `.env.local` overrides
the shell.

## 2. Create a Runtime

Choose one command:

```sh
npm run runtime:init -- postgres
npm run runtime:init -- together-postgres
```

The command writes `.hurdle/runtime/<kind>.json` and refuses to overwrite an
existing file. Runtime initialization creates local configuration only. It does
not create a database or schema.

## 3. Initialize Postgres

Apply the schema once:

```sh
npm run db:migrate
```

Hurdle stores tables in the `hurdle` schema. Output artifact bytes
stay in the local `.hurdle/postgres-artifacts` sidecar.

Migrations are versioned and checksum-verified. For existing databases, the
schema migration transactionally renames `tae` to `hurdle`, preserving Run rows,
captured evidence, and migration history. Fresh databases finish with the
`hurdle` schema. If both schemas exist, migration refuses without changes;
it does not merge or drop either schema.

Stop existing run, Viewer, and setup processes, then use the updated Hurdle
version consistently before migrating. Clients at `0.2.4` or earlier expect
`tae`; they cannot read `hurdle`, and their setup can recreate the old schema.
Run setup or `db:migrate` to apply the upgrade; `validate`, evaluation runs, and
the Viewer do not migrate the database. Legacy environment variables remain
supported.

The rename preserves schema ownership and grants, and requires schema ownership
and permission to rename it. Update external SQL and `search_path` settings that
name `tae` to use `hurdle`; Hurdle's Result Store uses explicit schema-qualified
queries. Do not reset a populated database or reuse legacy session tables as
canonical Run records.

## 4. Verify the setup

```sh
npm run preflight
```

Preflight checks only configured services. Anthropic and Together make small
billable requests. Postgres checks the connection and schema without applying
migrations.

For the same variable name, values in `.env.local` take precedence over values
inherited from the shell. Hurdle names take precedence over legacy names as
described above. Evaluation runs use the same precedence.

## 5. Run one cell

Set the Runtime path you created, then run a tool-calling cell:

```sh
RUNTIME=.hurdle/runtime/postgres.json

npm run hurdle -- run \
  evals/together/hybrid.suite.mjs \
  --runtime "$RUNTIME" \
  --task tool-calling-agent-loop \
  --condition baseline \
  --view
```

Use `.hurdle/runtime/together-postgres.json` to run the same cell in the
Together sandbox. Results are written to the configured database.

## Reopen results

```sh
npm run hurdle -- view --runtime .hurdle/runtime/postgres.json
```

Use the same Runtime file that produced the run.

To verify Postgres directly:

```sql
select table_name
from information_schema.tables
where table_schema = 'hurdle'
order by table_name;

select id, state, created_at
from hurdle.runs
order by created_at desc;
```

## Beta limitations

Agent, Judge, and Together usage may be billed.

Voice, DMI, fine-tuning, Jig, and persistent-resource lifecycle Tasks are
outside the preview. This release does not claim legacy score continuity or full
replacement of the legacy runner.
