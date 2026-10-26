# E2B and Postgres

Hurdle runs locally and saves results to `.hurdle/results-v1` by default. Follow this
guide only when you need isolated E2B execution, Postgres storage, or both.

For E2B setup, the default sandbox, use `npx hurdle setup --yes` in your evaluation project. It
reads configured credentials, reuses or builds a template, and saves a Runtime used by
subsequent commands. For storage setup, run `npx hurdle setup --store postgres`
with an existing database URL. It checks the connection, applies the schema, and
saves storage settings while preserving Local or E2B execution. See
[sandbox and storage setup](./sandbox-setup.md). The manual steps below support
custom Runtime files when working from a repository checkout.

| Runtime | Execution | Result store |
| --- | --- | --- |
| Default | Local | Filesystem |
| `e2b` | E2B | Filesystem |
| `postgres` | Local | Postgres |
| `e2b-postgres` | E2B | Postgres |

## 1. Configure credentials

Add only the services you use to the ignored `.env.local` file:

```sh
ANTHROPIC_API_KEY=...
TOGETHER_API_KEY=...
E2B_API_KEY=...
E2B_TEMPLATE=...
HURDLE_RESULT_STORE_DATABASE_URL=postgresql://...
```

The Together Suites need the Anthropic and Together keys. E2B needs
`E2B_API_KEY` and `E2B_TEMPLATE`. Postgres needs
`HURDLE_RESULT_STORE_DATABASE_URL`. Existing `TAE_RESULT_STORE_DATABASE_URL`
credentials remain supported; new projects should use the Hurdle name. The
Hurdle variable takes precedence when present, even if empty; the legacy alias
applies only when it is absent. For the same variable name, `.env.local` overrides
the shell.

Install the optional backend packages:

```sh
npm run setup:backends
```

## 2. Create a Runtime

Choose one command:

```sh
npm run runtime:init -- e2b
npm run runtime:init -- postgres
npm run runtime:init -- e2b-postgres
```

The command writes `.hurdle/runtime/<kind>.json` and refuses to overwrite an
existing file.

Your E2B template must contain Node.js 22 and Claude Code. Set its name with
`E2B_TEMPLATE`, or pass it directly:

```sh
npm run runtime:init -- e2b --template YOUR_E2B_TEMPLATE
```

Runtime initialization creates local configuration only. It does not create an
E2B template, database, or schema.

## 3. Initialize Postgres

Skip this step for filesystem storage. For either Postgres Runtime, apply the
schema once:

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
billable requests. E2B lists account resources without allocating a sandbox.
Postgres checks the connection and schema without applying migrations.

For the same variable name, values in `.env.local` take precedence over values
inherited from the shell. Hurdle names take precedence over legacy aliases as
described above. Evaluation runs use the same precedence.

## 5. Run one cell

Set the Runtime path you created, then run a RAG cell:

```sh
RUNTIME=.hurdle/runtime/e2b.json

npm run hurdle -- run \
  evals/together/hybrid.suite.mjs \
  --runtime "$RUNTIME" \
  --task rag-search \
  --condition baseline \
  --view
```

Use `.hurdle/runtime/postgres.json` or
`.hurdle/runtime/e2b-postgres.json` for the other configurations.

Filesystem-backed E2B results are saved in `.hurdle/e2b-results-v1`. Postgres
results are written to the configured database.

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

E2B, Agent, Judge, and Together usage may be billed.

Voice, DMI, fine-tuning, Jig, and persistent-resource lifecycle Tasks are
outside the preview. This release does not claim legacy score continuity or full
replacement of the legacy runner.


## Together sandbox

Together execution can use filesystem or Postgres storage through the same
Runtime API. Run `hurdle setup --sandbox together --yes` for an artifact-only
Suite, or initialize `together` / `together-postgres` with `--snapshot ALIAS`.
Read [Together sandbox setup and limitations](./sandbox-setup.md#together-sandbox)
before use. Together API Suites use a separate Guardian VM for the same trusted
capture, request blocking and Task credential substitution as E2B. Unlike E2B,
Together sandbox still places the Agent's own model credential in the Agent VM;
see [where credentials live](./sandbox-setup.md#where-credentials-live).
