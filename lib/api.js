/**
 * Educoder (头歌) platform JSON API client.
 *
 * The endpoint set, payload shapes, and field traps implemented here were
 * verified against the live platform by the reference client in
 * `houakun/educoder-lab` (MIT), which this module ports to the Host process.
 *
 * The `AK`/`SK` pair below is the platform's *public* client constant, baked
 * into Educoder's own web bundle: it signs the request envelope, and is not a
 * user secret. The user's credentials are the login/password (or the cached
 * session cookie), and those never leave the local profile.
 *
 * Nothing here is browser automation: every call is a documented JSON request.
 *
 * @module dsh-plugin-educoder/lib/api
 */

import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Platform API origin. */
export const DEFAULT_BASE_URL = 'https://data.educoder.net/api'

/** Default session cache, shared with the `educoder-lab` Python CLI. */
export const DEFAULT_SESSION_FILE = path.join(homedir(), '.educoder', 'session.json')

/** Public client key published in Educoder's web bundle. */
const AK = 'e9dd5b4322f9f7d83d009de9bfa100c3'
/** Public client secret published in Educoder's web bundle. */
const SK = '2e3da06ae26ba9f76a5d8d355746f2fe'

const RETRIES = 3
const BACKOFF_MS = 500
const RETRY_STATUS = new Set([429, 500, 502, 503, 504])

/** Any platform-side or transport-side failure. */
export class EducoderError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'EducoderError'
    this.code = code ?? 'EDUCODER_ERROR'
  }
}

/** The cached session is no longer accepted; a fresh login is required. */
export class SessionExpiredError extends EducoderError {
  constructor(message) {
    super(message, 'SESSION_EXPIRED')
    this.name = 'SessionExpiredError'
  }
}

/**
 * Build the signed request envelope for one API call.
 *
 * The platform mandates md5 over a base64 payload. This is a wire-protocol
 * handshake rather than a security primitive, which is why the construction
 * looks unusual: `method=<M>&ak=<AK>&sk=<SK>&time=<epoch-ms>`, base64-encoded,
 * then hashed.
 *
 * @param {string} method - HTTP method the signature covers.
 * @param {number} [now] - epoch milliseconds; injectable for tests.
 * @returns {[number, string]} the timestamp and signature actually sent.
 */
export function sign(method, now = Date.now()) {
  const payload = `method=${String(method).toUpperCase()}&ak=${AK}&sk=${SK}&time=${now}`
  const encoded = Buffer.from(payload, 'utf8').toString('base64')
  return [now, createHash('md5').update(encoded, 'utf8').digest('hex')]
}

/**
 * Split `challenge.path`, which lists several files joined by a full-width
 * `；` (and sometimes a half-width `;`).
 * @param {unknown} raw - the platform field.
 * @returns {string[]} one entry per answer file.
 */
export function splitPaths(raw) {
  if (raw === null || raw === undefined || raw === '') return []
  return String(raw)
    .split(/[；;]/)
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

/**
 * Read the platform's own answer key for a multiple-choice challenge.
 *
 * Educoder returns `standard_answer` for every choice test set, so there is
 * nothing to solve: the answers are ordered by `position` and submitted
 * verbatim.
 *
 * @param {any} detail - a `/tasks/{gid}.json` response body.
 * @returns {string[] | null} ordered answers, or null when this is not a fully
 *   answered choice challenge.
 */
export function choiceAnswers(detail) {
  const sets = detail?.choose_test_cases?.test_sets
  if (!Array.isArray(sets) || sets.length === 0) return null
  const ordered = [...sets].sort((a, b) => (a?.position ?? 0) - (b?.position ?? 0))
  const answers = ordered.map(set => set?.standard_answer)
  if (answers.some(answer => answer === null || answer === undefined || answer === '')) return null
  return answers.map(String)
}

/** The statement lives in `task_pass` despite the misleading field name. */
export function statementOf(detail) {
  const challenge = detail?.challenge ?? {}
  const game = detail?.game ?? {}
  return String(challenge.description || challenge.task_pass || game.description || '')
}

/** Minimal HTML-to-text for the statement, which arrives as Markdown/HTML. */
export function stripHtml(html) {
  if (!html) return ''
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * A platform blank: runs of U+2014/U+2015. They are not legal in any language
 * the platform grades, so a file that still holds one can never compile and
 * uploading it burns an evaluation run for nothing.
 */
const PLACEHOLDER_RE = /[\u2014\u2015]{2,}/

/**
 * Describe the first platform blank left in `text`.
 * @param {string} text - the candidate file content.
 * @returns {string | null} a human-readable location, or null when clean.
 */
export function placeholderHit(text) {
  const lines = String(text).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    if (PLACEHOLDER_RE.test(lines[index])) {
      return `line ${index + 1}: ${lines[index].trim().slice(0, 60)}`
    }
  }
  return null
}

/**
 * Report where two outputs first differ.
 *
 * Truncating both sides hides the interesting part whenever the divergence sits
 * past the cut, so locate the first difference instead: the failure report stays
 * short *and* sufficient for the model to act on.
 *
 * @param {string} actual - what the graded run produced.
 * @param {string} expected - what the platform wanted.
 * @returns {string} a one-line description of the divergence.
 */
export function divergence(actual, expected) {
  const actualLines = String(actual).split(/\r?\n/)
  const expectedLines = String(expected).split(/\r?\n/)
  const clip = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit)}…`)
  for (let index = 0; index < Math.max(actualLines.length, expectedLines.length); index += 1) {
    const got = actualLines[index]
    const want = expectedLines[index]
    if (got === want) continue
    if (got === undefined) {
      const rest = expectedLines.slice(index, index + 3).map(line => clip(line, 60)).join(' | ')
      const hidden = expectedLines.length - index - 3
      return `ends early at line ${index + 1}; expected ${rest}${hidden > 0 ? ` (+${hidden} more lines)` : ''}`
    }
    if (want === undefined) {
      const rest = actualLines.slice(index, index + 3).map(line => clip(line, 60)).join(' | ')
      const hidden = actualLines.length - index - 3
      return `extra output at line ${index + 1}: ${rest}${hidden > 0 ? ` (+${hidden} more lines)` : ''}`
    }
    let spot = 0
    while (spot < Math.min(got.length, want.length) && got[spot] === want[spot]) spot += 1
    const from = Math.max(0, spot - 20)
    return `line ${index + 1} col ${spot + 1}: expected ${clip(want.slice(from, spot + 60), 90)} got ${clip(got.slice(from, spot + 60), 90)}`
  }
  return 'output matches; check the exit status or the time limit'
}

/**
 * Read the current verdict for one challenge.
 *
 * `test_sets` alone is *not* a verdict: the platform already returns the list
 * with `result: null` while a run is still in flight, so the mere presence of
 * test sets must never be read as terminal.
 *
 * @param {any} detail - a `/tasks/{gid}.json` response body.
 * @returns {{settled: boolean, passed: boolean, game: any, tests: any[], compileOutput: string, key: string|null}}
 */
export function verdictOf(detail) {
  const game = detail?.game ?? {}
  const tests = Array.isArray(detail?.test_sets) ? detail.test_sets : []
  const rated = tests.filter(test => test?.result !== null && test?.result !== undefined)
  const complete = tests.length > 0 && rated.length === tests.length
  const passed = game.status === 2 || (complete && rated.every(test => Boolean(test.result)))
  const settled = game.status === 2 || complete
  const key = complete
    ? `${game.status}|${game.final_score}|${game.accuracy}|${tests.map(test => (test.result ? 1 : 0)).join('')}`
    : null
  return {
    settled,
    passed,
    game,
    tests,
    compileOutput: String(detail?.last_compile_output ?? ''),
    key,
  }
}

/** Render settled test sets into the feedback a retry needs. */
export function failureReport(verdict) {
  const lines = []
  const failing = verdict.tests.filter(test => !test?.result)
  for (const test of failing) {
    const position = test?.position ?? '?'
    const actual = test?.actual_output
    const expected = test?.output
    if (actual === undefined || actual === null) {
      lines.push(`- case ${position}: produced no output`)
      continue
    }
    lines.push(`- case ${position}: ${divergence(String(actual), String(expected ?? ''))}`)
    if (test?.input !== undefined && test?.input !== null) {
      lines.push(`  input was: ${String(test.input).slice(0, 200)}`)
    }
  }
  if (verdict.compileOutput) {
    lines.push(`- compiler/runtime output: ${verdict.compileOutput.slice(0, 800)}`)
  }
  return lines.join('\n')
}

/**
 * Resolve an Educoder task URL into the two identifiers the API needs.
 *
 * Accepted shapes, all seen in the wild:
 *   /tasks/<classroom>/<homeworkId>/<gameIdentifier>   (the common one)
 *   /tasks/<homeworkId>/<gameIdentifier>
 *   /tasks/<gameIdentifier>
 *   /tasks/<classroom>/<homeworkId>                    (homework, no challenge)
 *
 * @param {string} input - a full URL, a path, or a bare identifier.
 * @returns {{gameId: string|null, homeworkId: number|null, source: string}}
 */
export function parseTaskUrl(input) {
  const raw = String(input ?? '').trim()
  if (raw === '') throw new EducoderError('缺少头歌作业链接或标识符', 'BAD_TARGET')

  let pathname = raw
  let search = ''
  try {
    const url = new URL(raw)
    pathname = url.pathname
    search = url.search
  } catch {
    const [beforeHash] = raw.split('#')
    const splitAt = beforeHash.indexOf('?')
    if (splitAt >= 0) {
      pathname = beforeHash.slice(0, splitAt)
      search = beforeHash.slice(splitAt)
    } else {
      pathname = beforeHash
    }
  }

  const params = new URLSearchParams(search)
  const fromQuery = params.get('homework_common_id') ?? params.get('homework_id')

  const marker = pathname.indexOf('/tasks/')
  const tail = marker >= 0 ? pathname.slice(marker + '/tasks/'.length) : pathname
  const segments = tail.split('/').map(part => part.trim()).filter(Boolean)

  if (segments.length === 0 && fromQuery === null) {
    throw new EducoderError(`无法从 ${raw} 解析出头歌任务标识`, 'BAD_TARGET')
  }

  const numeric = /^\d{5,}$/
  let gameId = null
  let homeworkId = fromQuery !== null && numeric.test(String(fromQuery)) ? Number(fromQuery) : null

  if (segments.length > 0) {
    const last = segments[segments.length - 1]
    if (numeric.test(last)) {
      // A trailing number is a homework id, never a game identifier.
      homeworkId = Number(last)
    } else {
      gameId = last
    }
  }

  if (homeworkId === null) {
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if (numeric.test(segments[index])) {
        homeworkId = Number(segments[index])
        break
      }
    }
  }

  return { gameId, homeworkId, source: raw }
}

/** Safe on-disk session store, shared in shape with the Python CLI. */
export class SessionStore {
  /** @param {string} file - absolute path of the session cache. */
  constructor(file) {
    this.file = file
  }

  /** @returns {Promise<{zzud: string, session: string, autologin: string}|null>} */
  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'))
      const session = String(parsed?.session ?? '')
      if (session === '') return null
      return {
        zzud: String(parsed?.zzud ?? ''),
        session,
        autologin: String(parsed?.autologin ?? ''),
      }
    } catch {
      return null
    }
  }

  /** Write atomically, then tighten permissions where the platform allows it. */
  async save(value) {
    await mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
    try {
      await chmod(temporary, 0o600)
    } catch {
      // best effort: Windows ACLs do not map onto POSIX mode bits
    }
    await rename(temporary, this.file)
  }
}

/** One authenticated conversation with the Educoder JSON API. */
export class EducoderClient {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl] - API origin.
   * @param {number} [options.requestTimeoutMs] - per-request ceiling.
   */
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.requestTimeoutMs = Number(options.requestTimeoutMs) > 0 ? Number(options.requestTimeoutMs) : 30_000
    /** Account login name; the platform calls it `zzud`. */
    this.zzud = ''
    /** `_educoder_session` cookie value. */
    this.session = ''
    /** `autologin_trustie` cookie value. */
    this.autologin = ''
  }

  /** Adopt a cached session, if one parses. */
  async loadSession(store) {
    const cached = await store.load()
    if (cached === null) return false
    this.zzud = cached.zzud
    this.session = cached.session
    this.autologin = cached.autologin
    return true
  }

  /** Persist the current session. */
  async saveSession(store) {
    await store.save({ zzud: this.zzud, session: this.session, autologin: this.autologin })
  }

  /** @returns {string} the Cookie header for this session. */
  cookieHeader() {
    const parts = []
    if (this.autologin) parts.push(`autologin_trustie=${this.autologin}`)
    if (this.session) parts.push(`_educoder_session=${this.session}`)
    return parts.join('; ')
  }

  /**
   * Perform one signed API request, keeping the response headers.
   *
   * Login is the only caller that needs the raw response: the session lives in
   * `Set-Cookie`, which the transport must surface rather than a JSON body.
   *
   * @param {string} method - HTTP method.
   * @param {string} apiPath - path beginning with `/`.
   * @param {any} [body] - JSON body for writes.
   * @param {{pcAuth?: string, extraHeaders?: Record<string,string>, signal?: AbortSignal, sessionSensitive?: boolean}} [options]
   *   `sessionSensitive: false` keeps a body-level `status: 401` as data
   *   instead of raising, for calls that report their own credential verdict.
   * @returns {Promise<{data: any, response: Response}>} parsed body plus headers.
   */
  async requestRaw(method, apiPath, body, options = {}) {
    if (!apiPath.startsWith('/')) {
      throw new EducoderError(`拒绝非相对 API 路径: ${apiPath}`, 'BAD_PATH')
    }
    const url = `${this.baseUrl}${apiPath}`
    if (new URL(url).protocol !== 'https:') {
      throw new EducoderError(`拒绝非 https 请求: ${url.slice(0, 80)}`, 'BAD_URL')
    }

    const [timestamp, signature] = sign(method)
    const headers = {
      'X-EDU-Type': 'pc',
      'X-EDU-Timestamp': String(timestamp),
      'X-EDU-Signature': signature,
      'Pc-Authorization': options.pcAuth !== undefined ? options.pcAuth : (this.session || 'null'),
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    }
    const cookie = this.cookieHeader()
    if (cookie) headers.Cookie = cookie
    if (options.extraHeaders) Object.assign(headers, options.extraHeaders)

    let payload
    if (body !== undefined) {
      payload = JSON.stringify(body)
      headers['Content-Type'] = 'application/json; charset=utf-8'
    }

    let response
    let text = ''
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      const timeout = AbortSignal.timeout(this.requestTimeoutMs)
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
      let failure = null
      try {
        response = await fetch(url, { method, headers, body: payload, signal, redirect: 'follow' })
        text = await response.text()
      } catch (error) {
        failure = error
        response = undefined
      }
      if (options.signal?.aborted) throw new EducoderError('操作已取消', 'ABORTED')

      if (failure === null && response.status === 401) {
        throw new SessionExpiredError('会话已过期 (HTTP 401)，请重新登录头歌')
      }
      const retryable = failure !== null
        ? attempt < RETRIES - 1
        : RETRY_STATUS.has(response.status) && attempt < RETRIES - 1
      if (!retryable) {
        if (failure !== null) {
          throw new EducoderError(`网络错误（已重试 ${RETRIES} 次）：${failure.message}`, 'NETWORK')
        }
        break
      }
      const factor = response !== undefined && response.status === 429 ? 4 : 1
      await new Promise(resolve => setTimeout(resolve, BACKOFF_MS * 2 ** attempt * factor))
    }

    if (response === undefined) throw new EducoderError('网络错误：无响应', 'NETWORK')
    if (!response.ok && text === '') {
      throw new EducoderError(`HTTP ${response.status}（空响应）`, 'HTTP')
    }

    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new EducoderError(`响应不是 JSON (HTTP ${response.status}): ${text.slice(0, 200)}`, 'BAD_JSON')
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new EducoderError('响应不是 JSON 对象', 'BAD_JSON')
    }
    if (data.status === -102) {
      throw new EducoderError('签名被拒绝 (status=-102)：AK/SK 或本机时钟偏差', 'BAD_SIGNATURE')
    }
    // The platform reports an unusable session as `status: 401` inside an
    // otherwise ordinary HTTP 200 body, so the transport status alone never
    // reveals it. Verified live: an unauthenticated `/tasks/<gid>.json` answers
    // exactly `{"status":401,"message":"请登录后再操作"}`.
    if (data.status === 401 && options.sessionSensitive !== false) {
      throw new SessionExpiredError(
        `会话无效或已过期（平台返回 status=401：${data.message ?? '请登录后再操作'}）`,
      )
    }
    return { data, response }
  }

  /**
   * Perform one signed API request and return only its JSON body.
   * @param {string} method - HTTP method.
   * @param {string} apiPath - path beginning with `/`.
   * @param {any} [body] - JSON body for writes.
   * @param {{pcAuth?: string, extraHeaders?: Record<string,string>, signal?: AbortSignal}} [options]
   * @returns {Promise<any>} the parsed JSON object.
   */
  async request(method, apiPath, body, options = {}) {
    const { data } = await this.requestRaw(method, apiPath, body, options)
    return data
  }

  /** Authenticate and cache the resulting cookies. */
  async login(login, password, store) {
    if (!login || !password) {
      throw new EducoderError('未配置头歌账号或密码：请在插件配置里填写 login / password', 'NO_CREDENTIALS')
    }
    const { data, response } = await this.requestRaw(
      'POST',
      '/accounts/login.json',
      { login, password, autologin: true, tl: null, source: null },
      {
        pcAuth: 'null',
        // A rejected login is a credential verdict (-3/-4), not an expired
        // session, so this call must not be read as one.
        sessionSensitive: false,
        extraHeaders: {
          Origin: 'https://www.educoder.net',
          Referer: 'https://www.educoder.net/login',
        },
      },
    )
    if (data.status === -3) throw new EducoderError('头歌账号或密码错误', 'BAD_CREDENTIALS')
    if (data.status === -4) throw new EducoderError('该头歌账号需要先绑定手机号或邮箱', 'UNBOUND_ACCOUNT')
    if (typeof data.status === 'number' && data.status < 0) {
      throw new EducoderError(`登录失败 (status=${data.status}): ${data.message ?? ''}`, 'LOGIN_FAILED')
    }

    // The session is carried by cookies, not by the JSON body.
    const jar = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : []
    for (const cookie of jar) {
      const [pair] = String(cookie).split(';')
      const separator = pair.indexOf('=')
      if (separator < 0) continue
      const name = pair.slice(0, separator).trim()
      const value = pair.slice(separator + 1).trim()
      if (name === '_educoder_session') this.session = value
      else if (name === 'autologin_trustie') this.autologin = value
    }
    if (this.session === '') {
      throw new EducoderError('登录成功但响应缺少 _educoder_session cookie', 'LOGIN_FAILED')
    }
    this.zzud = String(data.login ?? login)
    if (store) await this.saveSession(store)
    return data
  }

  /** @returns {Promise<any[]>} this account's courses. */
  async courses() {
    const data = await this.request(
      'GET',
      `/courses.json?page=1&limit=100&order=mine&search=&zzud=${encodeURIComponent(this.zzud)}`,
    )
    return Array.isArray(data.courses) ? data.courses : []
  }

  /** @returns {Promise<any[]>} homeworks inside one course. */
  async homeworks(courseIdentifier) {
    const data = await this.request(
      'GET',
      `/courses/${encodeURIComponent(courseIdentifier)}/homework_commons.json`
      + `?limit=100&status=0&id=${encodeURIComponent(courseIdentifier)}&type=4&order=0&zzud=${encodeURIComponent(this.zzud)}`,
    )
    return Array.isArray(data.homeworks) ? data.homeworks : []
  }

  /**
   * Find a homework by its numeric id, scanning the account's courses.
   * Needed only when the caller supplied an id without a challenge identifier.
   */
  async findHomework(homeworkId) {
    for (const course of await this.courses()) {
      const identifier = course?.identifier
      if (!identifier) continue
      const found = (await this.homeworks(identifier)).find(
        item => Number(item?.homework_id) === Number(homeworkId),
      )
      if (found) return { course, homework: found }
    }
    return null
  }

  /**
   * The first challenge of a homework.
   *
   * `shixun_exec.json` answers with the last *visited* challenge, which is why
   * the walk in `flow.js` rewinds through `prev_game` before going forward.
   */
  async entryGame(homework) {
    const shixun = homework?.shixun_identifier
    const homeworkId = homework?.homework_id
    if (shixun && homeworkId) {
      try {
        const data = await this.request(
          'GET',
          `/shixuns/${encodeURIComponent(shixun)}/shixun_exec.json`
          + `?homework_common_id=${encodeURIComponent(homeworkId)}&zzud=${encodeURIComponent(this.zzud)}`,
        )
        if (data.game_identifier) return String(data.game_identifier)
      } catch (error) {
        if (error instanceof SessionExpiredError) throw error
      }
    }
    return homework?.myshixun_identifier ? String(homework.myshixun_identifier) : null
  }

  /** One challenge's full detail payload. */
  async taskDetail(gameIdentifier, homeworkId) {
    const query = new URLSearchParams()
    if (homeworkId !== null && homeworkId !== undefined) {
      query.set('homework_common_id', String(homeworkId))
    }
    query.set('zzud', this.zzud)
    return this.request('GET', `/tasks/${encodeURIComponent(gameIdentifier)}.json?${query}`)
  }

  /** Read one answer file; the platform transfers it base64-encoded. */
  async readFile(gameIdentifier, homeworkId, remotePath) {
    const query = new URLSearchParams({
      path: String(remotePath),
      homework_common_id: homeworkId === null || homeworkId === undefined ? '' : String(homeworkId),
      exercise_id: '',
      zzud: this.zzud,
    })
    const data = await this.request('GET', `/tasks/${encodeURIComponent(gameIdentifier)}/rep_content.json?${query}`)
    const encoded = data?.content?.content ?? ''
    return encoded === '' ? '' : Buffer.from(String(encoded), 'base64').toString('utf8')
  }

  /**
   * Write one remote file. `evaluate` stays 0 on purpose: grading is triggered
   * once per challenge, because a save-triggered run would grade a
   * half-applied workspace for every file but the last.
   *
   * @returns {Promise<string>} the resulting commit id.
   */
  async saveFile(myshixunIdentifier, payload) {
    const data = await this.request(
      'POST',
      `/myshixuns/${encodeURIComponent(myshixunIdentifier)}/update_file.json?zzud=${encodeURIComponent(this.zzud)}`,
      payload,
    )
    return String(data?.content?.commitID ?? '')
  }

  /** Start one grading run for an existing commit. */
  async grade(gameIdentifier, payload) {
    const data = await this.request(
      'POST',
      `/tasks/${encodeURIComponent(gameIdentifier)}/game_build.json?zzud=${encodeURIComponent(this.zzud)}`,
      payload,
    )
    return data?.res ?? {}
  }

  /** Submit a multiple-choice challenge. */
  async choose(gameIdentifier, payload) {
    return this.request(
      'POST',
      `/tasks/${encodeURIComponent(gameIdentifier)}/choose_build.json?zzud=${encodeURIComponent(this.zzud)}`,
      payload,
    )
  }
}
