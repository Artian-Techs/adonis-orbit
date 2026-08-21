import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'

import edge from 'edge.js'
import { DateTime } from 'luxon'

import { favicon, logo } from '../logo.js'
import JobRun, { JobRunStatus, type JobRunStatusValue } from '../models/job_run.js'
import SilencedJob from '../models/silenced_job.js'
import { retryRun } from '../retry.js'
import type { OrbitConfig } from '../types.js'

const PER_PAGE = 50

/** The sizes of a page that a person chooses between. */
const PER_PAGE_SIZES = [25, 50, 100]

/** Where the size of a page is held, and for how long. */
const PER_PAGE_COOKIE = 'orbit_per_page'
const PER_PAGE_AGE = '1y'

/** How many numbers of pages stand on each side of the one that is read. */
const PAGER_WINDOW = 2

/** The two modes that a person chooses between. */
const THEMES = ['light', 'dark']

/** Where the choice of the mode is held, and for how long. */
const THEME_COOKIE = 'orbit_theme'
const THEME_AGE = '1y'

/** The statuses of a job that a person may ask for again. */
const ENDED_BADLY: JobRunStatusValue[] = [JobRunStatus.FAILED, JobRunStatus.LOST]

/** What the list shows, and what the pager carries from one page to the next. */
interface Filters {
  status?: string
  job?: string
}

/** How far back the metrics read. */
const METRICS_WINDOW = { hours: 24 }

const STATUS_LABELS: Record<JobRunStatusValue, string> = {
  [JobRunStatus.PENDING]: 'Pending',
  [JobRunStatus.RUNNING]: 'Running',
  [JobRunStatus.RETRYING]: 'Retrying',
  [JobRunStatus.COMPLETED]: 'Completed',
  [JobRunStatus.FAILED]: 'Failed',
  [JobRunStatus.LOST]: 'Lost',
}

/**
 * The drawings of the side menu. They are written here, and the page prints
 * them as they are.
 */
const ICONS = {
  overview:
    '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
  pending: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  running: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5 3.5-5 3.5z"/>',
  retrying: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
  completed: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  failed: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 16.5v.5"/>',
  lost: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5l5 5"/><path d="M14.5 9.5l-5 5"/>',
  silenced:
    '<path d="M18 8a6 6 0 0 0-9.3-5"/><path d="M6 9v5l-2 3h13"/><path d="M10.5 20a2 2 0 0 0 3 0"/><path d="M3 3l18 18"/>',
  metrics: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
} as const

/**
 * The page that shows what the queue does.
 *
 * It reads the table, not Redis: a job that ended left Redis, and the table
 * keeps it. The page is served by the API itself, outside the front, thus it
 * answers even when the front is down.
 */
export default class DashboardController {
  #silenced?: string[]

  /**
   * Everything the queue did, and the four numbers that say how it goes.
   *
   * The side menu leads here with a status. A row that was asked again leads
   * here with the identifier of the job that answered. Without one and without
   * the other, the page shows the numbers and the last jobs of every status.
   */
  async index(ctx: HttpContext) {
    const { request } = ctx
    const status = request.input('status')
    const job = request.input('job')
    const page = Number(request.input('page', 1)) || 1

    const silenced = await this.#silencedNames()
    const perPage = this.#perPage(request)

    const build = () => {
      const query = JobRun.query().orderBy('id', 'desc')

      if (status) {
        query.where('status', status)
      }

      /**
       * A person who asks for one job asks for that job, thus a class that is
       * silenced answers here as any other class.
       */
      if (job) {
        query.where('jobId', job)
      } else if (silenced.length > 0) {
        query.whereNotIn('name', silenced)
      }

      return query
    }

    let runs = await build().paginate(page, perPage)

    /**
     * A person who asks for one job asks for that job, thus a class that is
     * silenced answers here as any other class.
     */
    if (page > runs.lastPage && runs.lastPage > 0) {
      runs = await build().paginate(runs.lastPage, perPage)
    }

    const answers = await this.#answers(runs.all())
    const alone = Boolean(status || job)

    return this.#render(ctx, 'index', {
      active: status || 'overview',
      title: this.#title(status, job),
      showStats: !alone,
      stats: alone ? null : await this.#stats(),
      status: status ?? '',
      rows: runs.all().map((run) => this.#row(run, silenced, answers)),
      pager: this.#pager(runs, { status, job }),
      perPage: { current: perPage, sizes: PER_PAGE_SIZES },
    })
  }

  /**
   * How many rows one page holds.
   *
   * The choice is held in a cookie, thus the menu carries it from one status
   * to the next and no address holds it.
   */
  #perPage(request: HttpContext['request']) {
    const size = Number(request.plainCookie(PER_PAGE_COOKIE))

    return PER_PAGE_SIZES.includes(size) ? size : PER_PAGE
  }

  /**
   * Every address that the pager leads to. The page reads them, it builds
   * none.
   *
   * The numbers stand around the page that is read, and the first and the last
   * stand at the ends. A hole between two of them is a step that the page
   * writes as a gap.
   */
  #pager(runs: { currentPage: number; lastPage: number; total: number }, filters: Filters) {
    const current = runs.currentPage
    const last = runs.lastPage
    const href = (page: number) => this.#href({ ...filters, page: page > 1 ? page : undefined })

    const pager = {
      page: current,
      lastPage: last,
      total: runs.total,
      previous: current > 1 ? href(current - 1) : null,
      next: current < last ? href(current + 1) : null,
      pages: [] as { number: number | null; href: string | null; current: boolean }[],
    }

    if (last < 2) {
      return pager
    }

    const numbers = new Set([1, last])

    for (let number = current - PAGER_WINDOW; number <= current + PAGER_WINDOW; number++) {
      if (number >= 1 && number <= last) {
        numbers.add(number)
      }
    }

    let previous = 0

    for (const number of [...numbers].sort((a, b) => a - b)) {
      if (previous > 0 && number - previous > 1) {
        pager.pages.push({ number: null, href: null, current: false })
      }

      pager.pages.push({ number, href: href(number), current: number === current })
      previous = number
    }

    return pager
  }

  /** One address of the page, with the values that name what it shows. */
  #href(params: Record<string, string | number | undefined>) {
    const query = new URLSearchParams()

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') {
        query.set(key, String(value))
      }
    }

    const search = query.toString()
    const { path } = this.#config()

    return search ? `${path}?${search}` : path
  }

  /**
   * Read more rows on one page, or fewer.
   *
   * The choice is held in a cookie, as the mode is. A page that stands past
   * the last one after the change answers with the last one.
   */
  async perPage({ params, response }: HttpContext) {
    const size = Number(params.count)

    if (!PER_PAGE_SIZES.includes(size)) {
      return response.notFound({ success: false, error: 'Not found' })
    }

    response.plainCookie(PER_PAGE_COOKIE, String(size), {
      path: this.#config().path,
      maxAge: PER_PAGE_AGE,
      httpOnly: false,
      sameSite: 'lax',
    })

    return response.redirect().withQs().back()
  }

  /** What the page is called. */
  #title(status?: string, job?: string) {
    if (job) {
      return 'One job'
    }

    return status ? STATUS_LABELS[status as JobRunStatusValue] : 'Overview'
  }

  /**
   * What became of the jobs that were asked again.
   *
   * One reading answers for the whole page: a row that names a new job reads
   * the status of that job beside it, and leads to it.
   */
  async #answers(runs: JobRun[]) {
    const asked = runs.map((run) => run.retriedJobId).filter((id) => id !== null)

    if (asked.length === 0) {
      return new Map<string, JobRunStatusValue>()
    }

    const answers = await JobRun.query().whereIn('jobId', asked).select('jobId', 'status')

    return new Map(answers.map((run) => [run.jobId, run.status]))
  }

  /**
   * The classes that the lists leave out.
   *
   * Their work goes on and their trace is written. Take a name away from here
   * and everything it did comes back, including what it did while it was
   * silent.
   */
  async silenced(ctx: HttpContext) {
    const silenced = await SilencedJob.query().orderBy('name', 'asc')

    return this.#render(ctx, 'silenced', {
      active: 'silenced',
      title: 'Silenced jobs',
      names: silenced.map((row) => row.name),
    })
  }

  /**
   * What each class and each queue cost in the last day.
   *
   * A job that takes long, or that fails often, is read here before it is read
   * in the list.
   */
  async metrics(ctx: HttpContext) {
    const since = DateTime.now().minus(METRICS_WINDOW).toJSDate()

    return this.#render(ctx, 'metrics', {
      active: 'metrics',
      title: 'Metrics',
      hours: METRICS_WINDOW.hours,
      byJob: await this.#metricsBy(['name', 'queue'], since),
      byQueue: await this.#metricsBy(['queue'], since),
    })
  }

  /**
   * Ask the queue for one job again.
   *
   * The row that answers stays where it is. The new job opens a row of its
   * own, thus the page shows the two.
   */
  async retry({ params, response }: HttpContext) {
    const run = await JobRun.findOrFail(params.id)

    await retryRun(run)

    return response.redirect().back()
  }

  /**
   * Read the page in the light, or in the dark.
   *
   * The choice is held in a cookie, thus the page carries it on the next
   * request and no script reads it. A person who chose nothing reads the mode
   * of their machine.
   */
  async theme({ params, response }: HttpContext) {
    const theme = String(params.theme)

    if (!THEMES.includes(theme)) {
      return response.notFound({ success: false, error: 'Not found' })
    }

    response.plainCookie(THEME_COOKIE, theme, {
      path: this.#config().path,
      maxAge: THEME_AGE,
      httpOnly: false,
      sameSite: 'lax',
    })

    return response.redirect().back()
  }

  /** Take a class out of the lists, or put it back. */
  async silence({ params, response }: HttpContext) {
    const name = String(params.name)
    const silenced = await SilencedJob.findBy('name', name)

    if (silenced) {
      await silenced.delete()
    } else {
      await SilencedJob.create({ name })
    }

    return response.redirect().back()
  }

  /** The four numbers of the overview. */
  async #stats() {
    const now = DateTime.now()

    return {
      perMinute: await this.#finishedSince(now.minus({ minutes: 1 })),
      pastHour: await this.#finishedSince(now.minus({ hours: 1 })),
      failedPastWeek: await this.#count(
        JobRun.query()
          .where('status', JobRunStatus.FAILED)
          .where('finishedAt', '>', now.minus({ days: 7 }).toJSDate())
      ),
      running: await this.#count(JobRun.query().where('status', JobRunStatus.RUNNING)),
    }
  }

  #finishedSince(moment: DateTime) {
    return this.#count(JobRun.query().where('finishedAt', '>', moment.toJSDate()))
  }

  async #count(query: ReturnType<typeof JobRun.query>) {
    const [row] = await query.count('* as total').pojo<{ total: string }>()

    return Number(row.total)
  }

  /**
   * What one column cost over the window.
   *
   * The count of the failures rides with the count of the rows: one reading of
   * the table answers both.
   */
  async #metricsBy(columns: ('name' | 'queue')[], since: Date) {
    const group = columns.join(', ')

    const result = await db.rawQuery(
      `select ${group},
              count(*) as total,
              count(*) filter (where status = ?) as failed,
              round(avg(duration)::numeric, 1) as average,
              round(max(duration)::numeric, 1) as longest
         from ${JobRun.table}
        where finished_at > ?
        group by ${group}
        order by count(*) desc`,
      [JobRunStatus.FAILED, since]
    )

    return (result.rows as Record<string, string>[]).map((row) => ({
      label: row.label,
      total: Number(row.total),
      failed: Number(row.failed),
      average: row.average === null ? null : Number(row.average),
      longest: row.longest === null ? null : Number(row.longest),
    }))
  }

  /**
   * The classes that the lists leave out.
   *
   * One request reads them once: the page asks for them, and the frame around
   * it asks again for its counts.
   */
  async #silencedNames() {
    if (!this.#silenced) {
      const rows = await SilencedJob.query().select('name')
      this.#silenced = rows.map((row) => row.name)
    }

    return this.#silenced
  }

  /**
   * The word that the buttons of the page carry.
   *
   * A form that asks for something writes it beside what it asks. An
   * application that guards its forms reads it; one that does not, reads
   * nothing, and the page holds no word at all.
   */
  /** What the application told Orbit. */
  #config() {
    return app.config.get<OrbitConfig>('orbit', {
      path: '/queue',
      authorize: () => false,
      sinks: [],
    })
  }

  /** The mode that the person chose, if they chose one. */
  #theme(request: HttpContext['request']) {
    const theme = request.plainCookie(THEME_COOKIE)

    return THEMES.includes(theme) ? theme : null
  }

  #csrfToken(request: HttpContext['request']) {
    return (request as unknown as { csrfToken?: string }).csrfToken ?? null
  }

  /** What one line of the table shows. The page reads, it does not calculate. */
  #row(run: JobRun, silenced: string[], answers: Map<string, JobRunStatusValue>) {
    const answer = run.retriedJobId ? answers.get(run.retriedJobId) : undefined

    return {
      id: run.id,
      jobId: run.jobId,
      name: run.name,
      queue: run.queue,
      status: run.status,
      statusLabel: STATUS_LABELS[run.status],
      attempts: run.attempts,
      duration: run.duration,
      payload: JSON.stringify(run.payload ?? {}, null, 2),
      error: run.error,
      dispatchedAt: run.dispatchedAt?.toFormat('dd LLL yyyy HH:mm:ss') ?? null,
      finishedAt: run.finishedAt?.toFormat('dd LLL yyyy HH:mm:ss') ?? null,
      retriedAt: run.retriedAt?.toFormat('dd LLL yyyy HH:mm:ss') ?? null,
      retriedJobId: run.retriedJobId,
      retriedStatus: answer ? STATUS_LABELS[answer] : null,
      canRetry: ENDED_BADLY.includes(run.status) && !run.retriedJobId,
      isSilenced: silenced.includes(run.name),
    }
  }

  /**
   * The page, with everything the frame around it asks for.
   *
   * The side menu carries the count of each status, thus every page says how
   * many jobs wait and how many fell.
   */
  async #render(
    { request, response }: HttpContext,
    template: string,
    data: Record<string, unknown>
  ) {
    const config = this.#config()

    /**
     * A silenced class counts nowhere: a badge that says two, over a list that
     * shows nothing, says nothing true.
     */
    const silenced = await this.#silencedNames()
    const query = db.from(JobRun.table).select('status').count('* as total').groupBy('status')

    if (silenced.length > 0) {
      query.whereNotIn('name', silenced)
    }

    const counts = await query

    const byStatus = Object.fromEntries(counts.map((row) => [row.status, Number(row.total)]))

    const menu = [
      { key: 'overview', label: 'Overview', href: config.path, icon: ICONS.overview, count: null },
      ...Object.values(JobRunStatus).map((status) => ({
        key: status,
        label: STATUS_LABELS[status],
        href: `${config.path}?status=${status}`,
        icon: ICONS[status],
        count: byStatus[status] ?? 0,
      })),
      {
        key: 'silenced',
        label: 'Silenced',
        href: `${config.path}/silenced`,
        icon: ICONS.silenced,
        count: null,
      },
      {
        key: 'metrics',
        label: 'Metrics',
        href: `${config.path}/metrics`,
        icon: ICONS.metrics,
        count: null,
      },
    ]

    const html = await edge.render(`orbit::${template}`, {
      ...data,
      path: config.path,
      logo,
      favicon,
      theme: this.#theme(request),
      menu,
      csrfToken: this.#csrfToken(request),
    })

    response.header('content-type', 'text/html; charset=utf-8')

    return response.send(html)
  }
}
