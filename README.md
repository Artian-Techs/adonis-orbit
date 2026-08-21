<p align="center">
  <img src="templates/orbit.svg" width="96" alt="Orbit">
</p>

# adonis-orbit

What the queue of AdonisJS did with each job, kept in a table, read on a page,
and asked again when it failed.

The queue holds its jobs in Redis and lets them go when they end. This package
listens to the channels that the queue publishes, writes one row for each job,
and serves a page that reads the table. A job that failed keeps the values it
carried, so a person can ask for it again — from the page, or from a command.

It works with AdonisJS 6 and 7.

## Install

```bash
pnpm add @artian-techs/adonis-orbit
node ace configure @artian-techs/adonis-orbit
node ace migration:run
```

The configure step writes the provider in `adonisrc.ts`, publishes
`config/orbit.ts`, publishes the two migrations — the table of the jobs, and
the one that names the silenced classes — and declares the two environment
variables that guard the page.

## The page

```
http://localhost:3333/queue
```

It asks for a name and a word, in Basic auth. **While one of the two is
missing, the page answers "not found"**: a machine that carries neither shows
nothing.

The page holds no session on purpose: it belongs to the team that runs the
machine, not to the users of the application. It speaks English only.

A menu on the left leads to each view, and carries the count of each status.
Under it, one button reads the page in the light or in the dark. The page reads
the mode of the machine while nobody chose; a choice is held in a cookie. The
page holds no JavaScript.

The list carries a pager over the table and under it: the number of every page
that stands near the one that is read, the first, the last, and a gap between
them. **Rows** says how many jobs one page holds — 25, 50 or 100. The choice is
held in a cookie, thus the menu carries it from one status to the next. Without
one, fifty.

| Entry | What it shows |
| --- | --- |
| Overview | four numbers, then the last jobs of every status |
| Pending, Running, Retrying, Completed, Failed, Lost | the same list, of one status |
| Silenced | the classes that the lists leave out |
| Metrics | what each class and each queue cost over the last 24 hours |

The four numbers of the overview:

| Number | What it counts |
| --- | --- |
| Jobs per minute | the jobs that ended in the last minute |
| Jobs past hour | the jobs that ended in the last hour |
| Failed jobs past 7 days | the jobs whose last try fell |
| Jobs running now | the jobs a worker holds at this moment |

Metrics reads the same table: for each class and for each queue, how many jobs
ended, how many fell, and the average and the longest of their durations.

## Silence a job

A job that runs every minute fills the list and hides the rest. The button
**Silence** on any row takes its class out of the lists, and out of the counts
of the menu.

Nothing else changes: the worker keeps its work, and the table keeps its trace.
The page **Silenced** shows what is left out, and **Show again** brings the
class back — with everything it did while it was silent.

## Configuration

```ts
import { DatabaseSink, basicAuth, defineConfig } from '@artian-techs/adonis-orbit'

import env from '#start/env'

export default defineConfig({
  path: '/queue',

  authorize: basicAuth({
    user: env.get('ORBIT_DASHBOARD_USER'),
    password: env.get('ORBIT_DASHBOARD_PASSWORD'),
  }),

  sinks: [new DatabaseSink()],
})
```

## Who may read the page

`authorize` reads the request and answers `true` or `false`. It answers `false`,
and the page says "not found": a machine that guards nothing shows nothing.

`basicAuth` asks for a name and a word, with no session. It is what the
configure step writes, and it answers "not found" while one of the two is
missing.

An application that already knows who is asking writes its own guard:

```ts
const TEAM = ['someone@example.com', 'someone-else@example.com']

export default defineConfig({
  path: '/queue',

  authorize: async ({ auth }) => {
    await auth.check()

    return TEAM.includes(auth.user?.email ?? '')
  },

  sinks: [new DatabaseSink()],
})
```

The package imports no authentication of its own: the guard reads the context
of the request, and the application says what it reads there.

A guard that wants to say something other than "not found" writes its answer
before it says `false`:

```ts
authorize: async (ctx) => {
  if (await ctx.auth.check()) {
    return true
  }

  ctx.response.redirect('/login')

  return false
}
```

## Where the trace goes

**Nothing is kept that the configuration does not name.** The table of
`job_runs` is one sink among others, and the configure step writes it in
`config/orbit.ts`:

```ts
import { DatabaseSink, defineConfig } from '@artian-techs/adonis-orbit'

export default defineConfig({
  path: '/queue',
  auth: { user: env.get('ORBIT_DASHBOARD_USER'), password: env.get('ORBIT_DASHBOARD_PASSWORD') },

  sinks: [new DatabaseSink(), new MySink()],
})
```

Take `DatabaseSink` away, and the table stays empty and the page shows nothing:
the page reads the table, and reads nothing else. A machine that sends its
trace somewhere else thus keeps none of it.

A sink reads one step of one job, and gives nothing back:

```ts
import type { JobEvent, Sink } from '@artian-techs/adonis-orbit'

class MySink implements Sink {
  async write(events: JobEvent[]) {
    // { type: 'dispatched' | 'started' | 'finished', at, job: { id, name, queue, payload, attempts } }
  }
}
```

The events of one step arrive together: a dispatch of ten jobs calls `write`
once, with ten events. A sink that fails is written in the log, and the job
that runs goes on.

## What of the payload is kept

A payload holds what a person wrote: an address, a name, a number. The
configuration says how much of it the trace keeps.

```ts
export default defineConfig({
  // ...

  /** 'full' by default. 'none' keeps nothing. */
  payload: (payload, job) => ({ ...payload, password: undefined }),
})
```

The rule is applied before the first sink reads the event, thus what it takes
out reaches nothing and nobody.

## What the table holds

One row for one job, completed at each step.

| Status | What it says |
| --- | --- |
| `pending` | the job waits for a worker |
| `running` | a worker holds it |
| `retrying` | a try failed, the next one is set |
| `completed` | done |
| `failed` | every try fell |
| `lost` | the queue let the job go, and no worker said how it ended |

The row that the dispatch writes and the row that the worker writes are the
same row. Either of the two can arrive first, thus the first one writes and the
second one completes.

## Ask a job again

From the page, with the button on a row that failed or that the queue lost. Or
with the job that the package carries:

```ts
import { JobRun, JobRunStatus, retryRun } from '@artian-techs/adonis-orbit'

const runs = await JobRun.query().where('status', JobRunStatus.FAILED)

for (const run of runs) {
  await retryRun(run)
}
```

The row is never replaced: the new job takes a new identifier and opens its own
row, and the old one names it.

## Tests

```bash
pnpm test
```

The tests read a PostgreSQL server, as the package does. The environment names
it, and without it the tests read `127.0.0.1:5432` and the database
`orbit_test`:

| Variable | What it names |
| --- | --- |
| `PG_HOST` | the machine, `127.0.0.1` |
| `PG_PORT` | the port, `5432` |
| `PG_USER` | the name, `postgres` |
| `PG_PASSWORD` | the word, `postgres` |
| `PG_DATABASE` | the database, `orbit_test` |

A server for the tests alone:

```bash
docker run -d --name orbit-test-pg -p 55432:5432 \
  -e POSTGRES_USER=orbit -e POSTGRES_PASSWORD=orbit -e POSTGRES_DB=orbit_test \
  postgres:16

PG_PORT=55432 PG_USER=orbit PG_PASSWORD=orbit pnpm test
```

The tests create the two tables from the stubs of `stubs/migrations`, and take
them away at the end.

`pnpm preview` opens the page on `http://localhost:3333/queue`, with jobs of
every status to read and the name `orbit` and the word `orbit`. It reads a
database of its own, `orbit_preview`, and makes it if it is not there.

## Close the rows that wait for nothing

A worker publishes what it does, and Orbit reads it. A worker that refuses a
job **before it starts** publishes nothing: it fails the job in the queue and
takes the next one. This happens at every deployment where the worker restarts
after the API, because the worker of the old build does not carry the class
that the new API asks for.

The row of that job stays `pending`, and the page shows a job that waits for a
worker that will never take it.

`ReconcileJobRuns` asks the queue about every row that stayed open too long:

```ts
import { ReconcileJobRuns } from '@artian-techs/adonis-orbit'

await ReconcileJobRuns.schedule({ minutes: 5 }).cron('* * * * *').run()
```

- the queue holds the job, thus the row is right and stays as it is;
- the queue holds the answer, thus the row takes it, with its error;
- the queue holds nothing, thus the row becomes `lost`.

`minutes` says how long a row stays open before the queue is asked about it.
It leaves the events of the worker the time to land: a row that a worker closed
a second ago is never read. Without it, five minutes.

The rows are read from the table, thus this needs `DatabaseSink`. The answers
go to every sink of the configuration, as the events of the worker do.

A queue that keeps its failed jobs gives the error that stopped them. Ask for
it in `config/queue.ts`, else the queue removes a job as soon as it fails and
the row can only say `lost`:

```ts
defaultJobOptions: { removeOnFail: false },
```

## Take out the traces that ended well

The package carries `PruneJobRuns` and names it to the queue itself. Give it a
place in the schedule of the application:

```ts
import { PruneJobRuns } from '@artian-techs/adonis-orbit'

await PruneJobRuns.schedule({ days: 7 }).cron('10 0 * * *').run()
```

A row that failed is never taken out.
