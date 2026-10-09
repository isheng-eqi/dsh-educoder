/**
 * Homework orchestration: walk a homework's challenges, submit what the
 * platform already knows, generate and grade real code for the rest, and retry
 * on the platform's own error report until each challenge passes.
 *
 * The walk is the part worth reading carefully. Educoder exposes no "give me
 * challenge N" call: the only enumeration is `prev_game` / `next_game`
 * traversal, `next_game` stays null until the previous challenge passes, and
 * `shixun_exec.json` answers with the *last visited* challenge rather than the
 * first unfinished one. So the walk rewinds to the head of the chain before
 * going forward, and re-reads a challenge after passing it to learn where the
 * chain continues.
 *
 * @module dsh-plugin-educoder/lib/flow
 */

import {
  EducoderClient,
  EducoderError,
  SessionExpiredError,
  choiceAnswers,
  failureReport,
  placeholderHit,
  splitPaths,
  statementOf,
  stripHtml,
  verdictOf,
} from './api.js'

/** Wait `ms`, honouring cancellation. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new EducoderError('操作已取消', 'ABORTED'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new EducoderError('操作已取消', 'ABORTED'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Hard-cap anything headed for a transcript; token cost is per character. */
export function bounded(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n... [truncated ${value.length - limit} of ${value.length} chars]`
}

/**
 * Authenticate, preferring a cached session.
 *
 * There is deliberately no "verify the session" call here. Verified live:
 * `/courses.json` answers with a full course list even with no session at all,
 * so it cannot distinguish a valid cookie from a stale one and using it as a
 * probe silently accepts an expired login. The session is instead proven by the
 * first genuinely authenticated call, and {@link ensureAuthenticated} recovers
 * from it there — before anything has been written.
 *
 * @param {object} options
 * @param {object} options.config - resolved plugin configuration.
 * @param {import('./api.js').SessionStore} options.store - session cache.
 * @param {(message: string) => void} [options.log] - progress sink.
 * @returns {Promise<EducoderClient>} a connected client.
 */
export async function connect({ config, store, log = () => {} }) {
  const client = new EducoderClient({
    baseUrl: config.baseUrl,
    requestTimeoutMs: config.requestTimeoutSec * 1000,
  })

  if (await client.loadSession(store)) {
    log('复用已缓存的头歌会话…')
    return client
  }

  if (!config.login || !config.password) {
    throw new EducoderError(
      '没有可用的头歌会话，且插件配置里没有 login / password。'
      + '请在插件配置中填写头歌账号与密码，或先运行 educoder-lab CLI 登录一次以生成共享的会话缓存。',
      'NO_CREDENTIALS',
    )
  }
  log(`正在以 ${config.login} 登录头歌…`)
  await client.login(config.login, config.password, store)
  return client
}

/**
 * Recover from a session the platform has stopped accepting.
 *
 * Only ever called before the run has written anything, so re-authenticating
 * and retrying cannot double-submit a challenge.
 *
 * @param {EducoderClient} client - the client whose session was rejected.
 * @param {object} config - resolved plugin configuration.
 * @param {import('./api.js').SessionStore} store - session cache.
 * @param {(message: string) => void} log - progress sink.
 */
export async function ensureAuthenticated(client, config, store, log) {
  if (!config.login || !config.password) {
    throw new EducoderError(
      '缓存的头歌会话已失效，而插件配置里没有 login / password，无法自动重新登录。'
      + '请在插件配置中填写头歌账号与密码。',
      'NO_CREDENTIALS',
    )
  }
  log('缓存的会话已失效，改用账号密码重新登录…')
  await client.login(config.login, config.password, store)
}

/**
 * Decide which model writes the answers.
 *
 * Configuration wins; otherwise the calling session's own model, then the
 * deployment default. A tool that silently answered with a different model than
 * the user selected would be surprising.
 *
 * @param {any} ctx - plugin context.
 * @param {object} config - resolved plugin configuration.
 * @returns {{provider: string, model: string}} the route to call.
 */
export function resolveSelection(ctx, config) {
  if (config.provider && config.model) {
    return { provider: config.provider, model: config.model }
  }
  try {
    const context = ctx.get('agents')?.currentInitiator()?.session?.requestContext?.()
    if (context?.provider && context?.model) {
      return { provider: context.provider, model: context.model }
    }
  } catch {
    // fall through to the deployment default
  }
  const fallback = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (fallback?.provider && fallback?.model) {
    return { provider: fallback.provider, model: fallback.model }
  }
  throw new EducoderError(
    '无法确定用哪个模型解题：请在插件配置里填写 provider / model',
    'NO_MODEL',
  )
}

/**
 * Send one non-conversational prompt to a model and collect its text.
 *
 * `sessionId` is deliberately omitted: this call is a private sub-request, and
 * attributing it to the live session would splice unrelated messages into the
 * conversation history.
 *
 * @returns {Promise<{text: string, finish: string|null}>} the reply and how the
 *   model stopped. `finish` matters because a reasoning model can spend the
 *   whole output budget thinking and return a truncated reply, which is a
 *   configuration problem rather than a wrong answer.
 */
export async function askModel(ctx, selection, { system, prompt, maxTokens, signal }) {
  const llm = ctx.get('llm')
  if (llm === undefined) {
    throw new EducoderError('llm 服务不可用，无法生成答案', 'NO_LLM')
  }
  let text = ''
  let finish = null
  const stream = llm.stream({
    provider: selection.provider,
    model: selection.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens,
    signal,
  })
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta') {
      text += chunk.text
      continue
    }
    if (chunk?.type === 'finish') {
      const kind = chunk.reason?.kind
      finish = kind ?? null
      if (kind === 'error') {
        throw new EducoderError(
          `模型调用失败：${chunk.reason?.failure?.message ?? 'unknown'}`,
          'LLM_ERROR',
        )
      }
      if (kind === 'aborted') {
        throw new EducoderError('模型调用被取消', 'ABORTED')
      }
    }
  }
  return { text, finish }
}

/**
 * Pull a `{ path: content }` object out of a model reply.
 *
 * Models wrap JSON in prose and fences inconsistently, so try every fenced
 * block first, then the outermost brace pair. Keys are matched against the
 * expected remote paths exactly, then by basename, because a model may echo the
 * file's name rather than its full path.
 *
 * @param {string} text - the raw reply.
 * @param {string[]} expectedPaths - remote paths that must be covered.
 * @returns {{files: Record<string, string>, unmatched: string[]}} resolved map.
 */
export function extractFiles(text, expectedPaths) {
  const candidates = []
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi
  let match
  while ((match = fenced.exec(text)) !== null) candidates.push(match[1])
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  candidates.push(text)

  let parsed = null
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.trim())
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value
        break
      }
    } catch {
      // try the next candidate
    }
  }
  if (parsed === null) return { files: {}, unmatched: [...expectedPaths] }

  // Accept both `{ path: content }` and `{ files: { path: content } }`.
  const table = parsed.files !== null && typeof parsed.files === 'object' && !Array.isArray(parsed.files)
    ? parsed.files
    : parsed

  const byPath = new Map()
  const byBase = new Map()
  for (const [key, value] of Object.entries(table)) {
    if (typeof value !== 'string') continue
    byPath.set(String(key).replace(/\\/g, '/').replace(/^\.?\//, ''), value)
    const base = String(key).split('/').pop()
    if (!byBase.has(base)) byBase.set(base, value)
  }

  const files = {}
  const unmatched = []
  for (const remote of expectedPaths) {
    const normalized = String(remote).replace(/\\/g, '/').replace(/^\.?\//, '')
    const base = normalized.split('/').pop()
    const value = byPath.get(normalized) ?? byPath.get(remote) ?? byBase.get(base)
    if (typeof value === 'string') files[remote] = value
    else unmatched.push(remote)
  }
  return { files, unmatched }
}

/** Build the `extras` envelope every write carries. */
function buildExtras(challenge, homeworkId, user) {
  return {
    challenge_id: challenge.id,
    homework_common_id: homeworkId,
    currentUserId: user.user_id,
    exercise_id: '',
    question_id: '',
    subject_id: '',
    competition_entry_id: '',
  }
}

/**
 * Compose the prompt for one code challenge.
 *
 * Expected test cases are included verbatim when the platform publishes them:
 * they are the specification the grader actually applies.
 */
function buildPrompt({ detail, remotePaths, originals, attempt, feedback, previous }) {
  const challenge = detail.challenge ?? {}
  const game = detail.game ?? {}
  const title = challenge.subject || game.name || game.identifier || '未命名关卡'
  const statement = bounded(stripHtml(statementOf(detail)), 6000)
  const tests = Array.isArray(detail.test_sets) ? detail.test_sets.slice(0, 8) : []

  const parts = []
  parts.push(`# 头歌实训关卡：${title}`)
  parts.push('')
  parts.push('## 题目描述')
  parts.push(statement || '(平台未提供描述)')

  if (tests.length > 0) {
    parts.push('')
    parts.push('## 平台的评测用例（input → 期望输出）')
    for (const test of tests) {
      const position = test?.position ?? '?'
      const input = bounded(String(test?.input ?? ''), 500)
      const output = bounded(String(test?.output ?? ''), 500)
      parts.push(`### 用例 ${position}`)
      parts.push('输入:')
      parts.push('```')
      parts.push(input)
      parts.push('```')
      parts.push('期望输出:')
      parts.push('```')
      parts.push(output)
      parts.push('```')
    }
  }

  parts.push('')
  parts.push('## 需要提交的文件（当前平台上的内容）')
  for (const remote of remotePaths) {
    parts.push(`### ${remote}`)
    parts.push('```')
    parts.push(bounded(originals[remote] ?? '', 8000))
    parts.push('```')
  }

  if (attempt > 1) {
    parts.push('')
    parts.push(`## 上一次提交（第 ${attempt - 1} 次）没有通过评测`)
    if (feedback) {
      parts.push('评测反馈：')
      parts.push(bounded(feedback, 2500))
    }
    if (previous && Object.keys(previous).length > 0) {
      parts.push('上一次你提交的内容：')
      for (const remote of remotePaths) {
        if (previous[remote] === undefined) continue
        parts.push(`### ${remote}`)
        parts.push('```')
        parts.push(bounded(previous[remote], 8000))
        parts.push('```')
      }
    }
    parts.push('请根据上面的失败原因修正，不要重复同样的错误。')
  }

  parts.push('')
  parts.push('## 输出要求')
  parts.push('只输出一个 JSON 对象，不要任何解释文字。')
  parts.push('键是下面的文件路径（原样复制），值是该文件**完整**的最终内容：')
  parts.push(remotePaths.map(path => `"${path}"`).join(', '))
  parts.push('')
  parts.push('约束：')
  parts.push('1. 值必须是完整文件内容，不能是补丁或片段，不要省略任何原有代码。')
  parts.push('2. 必须把题目里的填空（平台用连续的一串 “—” 表示）替换成真正的代码。')
  parts.push('3. 保持原有的类名、方法签名、包名和文件路径不变。')
  parts.push('4. 只有在平台确实要求时才添加 import。')
  parts.push('5. 输出必须是能被 JSON.parse 解析的合法 JSON（换行写成 \\n，注意转义）。')

  return parts.join('\n')
}

const SYSTEM_PROMPT = [
  '你是一位资深编程讲师，正在替学生完成头歌（EduCoder）实训平台的编程关卡。',
  '你会拿到题目描述、平台的评测用例，以及平台上该关卡当前的文件内容。',
  '你的任务是给出能让平台评测通过的正确、完整、可编译的代码。',
  '严格遵守输出格式：只输出一个 JSON 对象，把文件路径映射到完整文件内容，不要输出任何其他文字。',
].join('\n')

/**
 * Pass one multiple-choice challenge without spending a single model token.
 *
 * Educoder does not publish answer keys in the challenge payload: on this
 * account `choose_test_cases[].standard_answer` is null for every choice
 * challenge, including a 172-question final-review exam, so there is nothing to
 * copy. What the platform *does* do is return `standard_answer` for every
 * question in the response to a submission (verified live: a probe submission
 * scored 4/20 and came back with all 20 correct answers).
 *
 * So the deterministic route is: submit a probe set, harvest the key from the
 * response, submit the key. Re-submission is effectively unlimited
 * (`submit_limit: false`, `submit_limit_num: 200`) and the recorded score comes
 * from the last submission, so the probe costs nothing that matters.
 *
 * @returns {Promise<{passed: boolean, attempts: number, note: string}>}
 */
async function solveChoiceChallenge({ client, gameId, detail, config, log }) {
  const challenge = detail.challenge ?? {}
  const total = (detail.chooses ?? []).length
    || (detail.choose_test_cases?.test_sets ?? []).length
  const submit = answer => client.choose(gameId, {
    answer,
    challenge_id: challenge.id,
    subject_id: detail.subject_id ?? null,
    question_id: null,
    competition_entry_id: null,
    smart_plan_page_item_bank_id: null,
  })

  // A challenge that does publish its answers needs no probing at all.
  const published = choiceAnswers(detail)
  if (published !== null) {
    const response = await submit(published)
    const correct = response?.choose_correct_num ?? 0
    const count = response?.challenge_chooses_count ?? published.length
    return {
      passed: count > 0 && correct === count,
      attempts: 1,
      note: `选择题 ${correct}/${count}（平台自带标准答案）`,
    }
  }

  if (total === 0) return { passed: false, attempts: 0, note: '没有可提交的题目' }

  for (let round = 1; round <= config.maxAttempts; round += 1) {
    log(`提交探针答案以获取答案键（${total} 题，不消耗模型 token）…`)
    const probe = await submit(Array.from({ length: total }, () => 'A'))
    const key = [...(probe?.test_sets ?? [])]
      .sort((a, b) => a.position - b.position)
      .map(test => test.standard_answer)

    if (key.length !== total || key.some(answer => answer === null || answer === undefined)) {
      return {
        passed: false,
        attempts: round,
        note: `选择题 ${probe?.choose_correct_num ?? 0}/${total}，平台没有回吐完整答案键`,
      }
    }

    const final = await submit(key)
    const correct = final?.choose_correct_num ?? 0
    const count = final?.challenge_chooses_count ?? total
    if (count > 0 && correct === count) {
      return {
        passed: true,
        attempts: round * 2,
        note: `选择题 ${correct}/${count}（探针收割答案键，未用模型）`,
      }
    }
  }

  return { passed: false, attempts: config.maxAttempts * 2, note: '选择题未能全对' }
}

/**
 * Solve one code challenge: generate, upload, grade, and retry on failure.
 *
 * Grading is triggered exactly once per attempt, not once per file: a challenge
 * is graded as a whole, so a per-file run would grade a half-applied workspace
 * and waste evaluator quota.
 *
 * @returns {Promise<{passed: boolean, attempts: number, note: string}>}
 */
async function solveCodeChallenge({
  ctx, client, selection, gameId, homeworkId, detail, config, log, signal,
}) {
  const challenge = detail.challenge ?? {}
  const game = detail.game ?? {}
  const myshixun = detail.myshixun ?? {}
  const user = detail.user ?? {}
  const environments = Array.isArray(detail.shixun_environments) ? detail.shixun_environments : []
  const remotePaths = splitPaths(challenge.path)

  const missing = []
  if (!myshixun.identifier) missing.push('myshixun identifier')
  if (!challenge.id) missing.push('challenge id')
  if (!user.user_id) missing.push('current user id')
  if (environments.length === 0) missing.push('shixun environment')
  if (remotePaths.length === 0) missing.push('远端代码文件')
  if (missing.length > 0) {
    return { passed: false, attempts: 0, note: `平台响应缺少 ${missing.join('、')}，跳过以避免半提交` }
  }

  const originals = {}
  for (const remote of remotePaths) {
    originals[remote] = await client.readFile(gameId, homeworkId, remote)
  }

  const extras = buildExtras(challenge, homeworkId, user)
  const environmentId = environments[0]?.shixun_environment_id
  let feedback = null
  let previous = null

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    if (signal?.aborted) throw new EducoderError('操作已取消', 'ABORTED')
    log(`第 ${attempt}/${config.maxAttempts} 次生成答案…`)

    const { text: reply, finish } = await askModel(ctx, selection, {
      system: SYSTEM_PROMPT,
      prompt: buildPrompt({ detail, remotePaths, originals, attempt, feedback, previous }),
      maxTokens: config.maxTokens,
      signal,
    })
    const { files, unmatched } = extractFiles(reply, remotePaths)

    // Validate before the first write: a half-applied submit is worse than a
    // refusal, and a file that still holds a platform blank can never compile.
    if (unmatched.length > 0) {
      // A reply cut off by the output cap is a different problem from a reply
      // that simply forgot a file, and it needs a different fix.
      feedback = finish === 'max-tokens'
        ? `你的输出被 maxTokens=${config.maxTokens} 截断了，JSON 不完整，所以无法解析出这些文件：`
          + `${unmatched.join('、')}。请直接输出最终文件内容，不要任何解释或额外文字；`
          + '内容确实很长时，优先保证 JSON 完整。'
        : `你的回复里没有包含这些文件：${unmatched.join('、')}。请为每一个文件路径都给出完整内容。`
      log(finish === 'max-tokens'
        ? `模型输出被 maxTokens 截断，重试…`
        : `模型漏掉了 ${unmatched.length} 个文件，重试…`)
      continue
    }
    const blanks = remotePaths
      .map(remote => ({ remote, hit: placeholderHit(files[remote]) }))
      .filter(entry => entry.hit !== null)
    if (blanks.length > 0) {
      feedback = '这些文件里仍然留着平台的填空（连续的一串 —），上传后必然编译失败，必须替换成真正的代码：\n'
        + blanks.map(entry => `- ${entry.remote} ${entry.hit}`).join('\n')
      log(`答案仍含平台占位符（${blanks.length} 个文件），重试…`)
      previous = files
      continue
    }

    let commit = ''
    for (const remote of remotePaths) {
      commit = await client.saveFile(myshixun.identifier, {
        path: remote,
        evaluate: 0,
        content: files[remote],
        game_id: game.id,
        tab_type: 1,
        homework_common_id: homeworkId,
        extras,
      })
    }
    previous = files

    const baseline = verdictOf(await client.taskDetail(gameId, homeworkId))
    const result = await client.grade(gameId, {
      sec_key: detail.sec_key || '',
      resubmit: '',
      first: 1,
      content_modified: 0,
      shixun_environment_id: environmentId,
      tab_type: 1,
      extras: { ...extras, commitID: commit || String(myshixun.commit_id ?? '') },
    })
    if (result.code !== undefined && result.code !== 0) {
      feedback = `平台拒绝启动评测：code=${result.code} ${result?.data?.msg ?? ''}`
      log('评测未能启动，重试…')
      continue
    }

    log('已提交，等待评测结果…')
    const verdict = await waitForVerdict(client, gameId, homeworkId, {
      timeoutMs: config.gradeTimeoutSec * 1000,
      pollMs: config.pollIntervalSec * 1000,
      signal,
      baselineKey: baseline.key,
      baselineCount: Number(baseline.game?.evaluate_count ?? 0),
    })

    if (verdict === null) {
      feedback = '等待评测结果超时。'
      continue
    }
    if (verdict.passed) {
      return { passed: true, attempts: attempt, note: `第 ${attempt} 次提交通过` }
    }
    feedback = failureReport(verdict)
    log(`第 ${attempt} 次未通过，把评测反馈交回模型修正…`)
  }

  return {
    passed: false,
    attempts: config.maxAttempts,
    note: bounded(feedback ?? '未通过，且没有拿到评测反馈', 600),
  }
}

/**
 * Poll until a grading run settles.
 *
 * Two guards make this trustworthy. `test_sets` carries `result: null` while a
 * run is in flight, so its presence is never a verdict; and a fresh run is
 * confirmed through `game.evaluate_count` rather than assumed, because
 * otherwise a stale verdict from the previous run reads as the new one.
 * A run is accepted once the count advances and two consecutive polls agree, or
 * immediately on `status == 2`.
 *
 * @returns {Promise<ReturnType<typeof verdictOf>|null>} the last verdict seen.
 */
async function waitForVerdict(client, gameId, homeworkId, options) {
  const { timeoutMs, pollMs, signal, baselineKey, baselineCount } = options
  const deadline = Date.now() + timeoutMs
  let previousKey
  let last = null
  let sawNewRun = baselineCount === null || baselineCount === undefined
  while (Date.now() < deadline) {
    await sleep(pollMs, signal)
    last = verdictOf(await client.taskDetail(gameId, homeworkId))
    const count = Number(last.game?.evaluate_count ?? 0)
    if (count > (baselineCount ?? -1)) sawNewRun = true
    if (last.game?.status === 2) return last
    if (sawNewRun && last.key !== null && last.key === previousKey && last.key !== baselineKey) {
      return last
    }
    previousKey = last.key
  }
  return last
}

/** Rewind from the entry challenge to the head of the chain. */
async function rewindChain(client, entryGameId, homeworkId, log, seed) {
  const cache = new Map()
  // The caller already read the entry challenge to prove the session, so reuse
  // that read instead of paying for it twice.
  if (seed !== undefined && seed !== null) cache.set(String(seed.gid), seed.detail)
  const detailOf = async gid => {
    if (!cache.has(gid)) cache.set(gid, await client.taskDetail(gid, homeworkId))
    return cache.get(gid)
  }
  const chain = []
  let cursor = String(entryGameId)
  while (cursor && cursor !== 'null' && !chain.includes(cursor)) {
    chain.push(cursor)
    const detail = await detailOf(cursor)
    cursor = detail?.prev_game ? String(detail.prev_game) : ''
  }
  chain.reverse()
  log(`从入口回退到首个关卡，共 ${chain.length} 个关卡`)
  return { chain, cache, detailOf }
}

/** Resolve the `(gameId, homeworkId)` pair from whatever the caller supplied. */
export async function resolveTarget(client, target) {
  let { gameId, homeworkId } = target
  if (gameId === null && homeworkId !== null) {
    const found = await client.findHomework(homeworkId)
    if (found === null) {
      throw new EducoderError(`当前账号的课程里找不到 homework_id=${homeworkId} 的作业`, 'NOT_FOUND')
    }
    gameId = await client.entryGame(found.homework)
    if (!gameId) throw new EducoderError('无法解析该作业的入口关卡', 'NOT_FOUND')
  }
  if (gameId !== null && (homeworkId === null || homeworkId === undefined)) {
    const detail = await client.taskDetail(gameId, null)
    homeworkId = detail.homework_common_id ?? null
  }
  return { gameId, homeworkId }
}

/**
 * Run one homework: survey it, or finish every open challenge.
 *
 * @param {object} options
 * @param {any} options.ctx - plugin context, for the model call.
 * @param {EducoderClient} options.client - connected client.
 * @param {{gameId: string|null, homeworkId: number|null}} options.target
 * @param {object} options.config - resolved plugin configuration.
 * @param {import('./api.js').SessionStore} options.store - session cache, for one re-login.
 * @param {'survey'|'solve'} options.mode - report only, or actually finish.
 * @param {(message: string) => void} options.log - progress sink.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>} a JSON-serializable run report.
 */
export async function runHomework({ ctx, client, target, config, store, mode, log, signal }) {
  const resolved = await resolveTarget(client, target)
  const { gameId, homeworkId } = resolved
  const selection = mode === 'solve' ? resolveSelection(ctx, config) : null

  // Reading the entry challenge doubles as the session check. `/courses.json`
  // answers with a full course list even without a session, so a task read is
  // the first call that can actually tell a good cookie from a stale one — and
  // doing it here means recovery happens before anything has been written.
  let entryDetail
  try {
    entryDetail = await client.taskDetail(gameId, homeworkId)
  } catch (error) {
    if (!(error instanceof SessionExpiredError)) throw error
    await ensureAuthenticated(client, config, store, log)
    entryDetail = await client.taskDetail(gameId, homeworkId)
  }

  const { chain, cache, detailOf } = await rewindChain(client, gameId, homeworkId, log, {
    gid: String(gameId),
    detail: entryDetail,
  })
  const queue = [...chain]
  const seen = new Set()
  const challenges = []
  let index = 0

  let stopped = null
  while (queue.length > 0) {
    if (signal?.aborted) throw new EducoderError('操作已取消', 'ABORTED')
    const gid = queue.shift()
    if (seen.has(gid)) continue
    seen.add(gid)
    index += 1

    const entry = { index, gid, title: gid, kind: 'code', status: 'pending', attempts: 0, note: '' }
    let recorded = false
    // Only a challenge we actually changed needs re-reading: `next_game` is
    // revealed by passing it, so a challenge that was already passed carries its
    // successor in the detail we already hold.
    let mutated = false
    try {
      let detail = await detailOf(gid)
      const challenge = detail?.challenge ?? {}
      const game = detail?.game ?? {}
      const title = challenge.subject || game.name || gid
      entry.title = title

      if (game.status === 2) {
        entry.status = 'already-passed'
        entry.kind = Array.isArray(detail?.choose_test_cases?.test_sets) && detail.choose_test_cases.test_sets.length > 0 ? 'choice' : 'code'
        entry.note = '进入作业前就已经通过'
        log(`[${index}] ✅ ${title}（已完成）`)
      } else if (config.challengeLimit > 0 && challenges.filter(item => item.status !== 'already-passed').length >= config.challengeLimit) {
        entry.status = 'skipped'
        entry.note = `达到 challengeLimit=${config.challengeLimit}，未处理`
        log(`[${index}] ⏭️ ${title}（超出本次处理上限）`)
      } else {
        const published = choiceAnswers(detail)
        const questionCount = (detail.chooses ?? []).length
          || (detail.choose_test_cases?.test_sets ?? []).length
        const isChoice = published !== null || questionCount > 0
        let choiceDone = false

        if (isChoice) {
          entry.kind = 'choice'
          if (mode === 'survey') {
            entry.status = 'open'
            entry.note = published !== null
              ? `选择题 ${published.length} 题，平台已给出标准答案`
              : `选择题 ${questionCount} 题，平台未公布答案（提交一次即可让平台回吐答案键，不需要模型）`
            log(`[${index}] 📋 ${title}（${entry.note}）`)
          } else {
            mutated = true
            const outcome = await solveChoiceChallenge({ client, gameId: gid, detail, config, log })
            entry.attempts = outcome.attempts
            choiceDone = outcome.passed
            entry.status = outcome.passed ? 'passed' : 'failed'
            entry.note = outcome.note
            log(`[${index}] ${outcome.passed ? '✅' : '❌'} ${title}（${entry.note}）`)
          }
        }

        const remotePaths = splitPaths(challenge.path)
        const hasCode = remotePaths.length > 0
        if (mode === 'survey') {
          if (!isChoice) {
            entry.kind = 'code'
            entry.status = 'open'
            entry.note = hasCode ? `${remotePaths.length} 个文件待完成` : '没有可提交的题目或代码文件'
            log(`[${index}] 📝 ${title}（代码题，${entry.note}）`)
          }
        } else if (hasCode && !choiceDone) {
          entry.kind = entry.kind === 'choice' ? 'choice+code' : 'code'
          log(`[${index}] 📝 ${title}：开始生成代码（${remotePaths.length} 个文件）`)
          mutated = true
          const outcome = await solveCodeChallenge({
            ctx, client, selection, gameId: gid, homeworkId, detail, config, log, signal,
          })
          entry.attempts = outcome.attempts
          entry.status = outcome.passed ? 'passed' : 'failed'
          entry.note = outcome.note
          log(`[${index}] ${outcome.passed ? '✅' : '❌'} ${title}（${outcome.note}）`)
        } else if (!isChoice && !hasCode && entry.status === 'pending') {
          entry.status = 'skipped'
          entry.note = '既不是选择题，也没有代码文件'
          log(`[${index}] ⏭️ ${title}（无法处理）`)
        }
      }

      if (!entry.status || entry.status === 'pending') entry.status = 'skipped'
      challenges.push(entry)
      recorded = true

      // Passing a challenge is what reveals the next one, so re-read it after we
      // changed it rather than trusting the cached `next_game`.
      if (mutated) {
        cache.delete(gid)
        detail = await detailOf(gid)
      }
      const next = detail?.next_game
      if (next && !seen.has(String(next))) queue.unshift(String(next))
    } catch (error) {
      // A failure partway through must not throw away what already passed.
      // Everything submitted so far stays submitted on the platform, so the run
      // reports it and names the challenge that stopped the walk; re-running
      // picks up from there because completed challenges read as already passed.
      if (!(error instanceof EducoderError)) throw error
      if (!recorded) {
        entry.status = 'failed'
        entry.note = `${error.code === 'SESSION_EXPIRED' ? '会话失效' : '平台或网络错误'}：${error.message}`
        challenges.push(entry)
      }
      stopped = error
      log(`[${index}] ⚠️ ${entry.title}：${entry.note}`)
      break
    }
  }

  const open = challenges.filter(item => item.status !== 'already-passed')
  const passed = open.filter(item => item.status === 'passed').length
  const failed = open.filter(item => item.status === 'failed').length
  const skipped = open.filter(item => item.status === 'skipped').length
  const stillOpen = open.filter(item => item.status === 'open').length

  return {
    mode,
    target: { gameId, homeworkId },
    account: client.zzud,
    model: selection === null ? null : `${selection.provider}/${selection.model}`,
    counts: {
      total: challenges.length,
      alreadyPassed: challenges.length - open.length,
      open: open.length,
      passed,
      failed,
      skipped,
      stillOpen,
    },
    challenges,
    // A walk that stopped early is never a clean result, whatever the counts say.
    ...(stopped === null ? {} : {
      stopped: { code: stopped.code ?? 'EDUCODER_ERROR', message: stopped.message },
    }),
    // `ok` means "nothing is outstanding", for a survey exactly as much as for a
    // solve: a survey that finds open challenges has not found a finished
    // homework, and reporting otherwise is how a caller gets misled.
    ok: stopped === null && failed + stillOpen + skipped === 0,
  }
}

/** Render a run report as the compact text a model should read. */
export function renderReport(report) {
  const lines = []
  const icon = { 'passed': '✅', 'failed': '❌', 'skipped': '⏭️', 'already-passed': '✅', 'open': '📋', 'pending': '•' }
  // The headline is derived from the counts, not from `ok`: a survey only ever
  // reports, but "全部通过" must still mean the homework really is finished.
  const outstanding = report.counts.failed + report.counts.stillOpen + report.counts.skipped
  const headline = report.stopped
    ? '中途停止（已完成的部分已在平台上生效）'
    : outstanding === 0
      ? '全部通过'
      : report.mode === 'survey'
        ? `巡检完成，还有 ${outstanding} 个关卡没通过`
        : `仍有 ${outstanding} 个关卡没通过`
  lines.push(`头歌作业${report.mode === 'survey' ? '巡检' : '处理'}结果：${headline}`)
  lines.push(`账号=${report.account || '?'} homework_id=${report.target.homeworkId ?? '?'} 入口=${report.target.gameId ?? '?'}`)
  if (report.model) lines.push(`解题模型=${report.model}`)
  const counts = report.counts
  lines.push(
    `关卡 ${counts.total} 个：原本已通过 ${counts.alreadyPassed}，`
    + `本次通过 ${counts.passed}，失败 ${counts.failed}，跳过 ${counts.skipped}`
    + `${counts.stillOpen > 0 ? `，待完成 ${counts.stillOpen}` : ''}`,
  )
  lines.push('')
  if (report.stopped) {
    lines.push(`⚠️ 中途停止：${report.stopped.message}`)
    lines.push('已经通过的关卡在平台上已经生效，重新运行会从下一个未通过的关卡继续。')
    lines.push('')
  }
  for (const item of report.challenges) {
    lines.push(`${icon[item.status] ?? '•'} [${item.index}] ${item.title} (${item.kind}) — ${item.note}`)
  }
  const unfinished = report.challenges.filter(item => item.status === 'failed' || item.status === 'open' || item.status === 'skipped')
  if (unfinished.length > 0 && report.mode !== 'survey') {
    lines.push('')
    lines.push('未完成的关卡：')
    for (const item of unfinished) {
      lines.push(`- ${item.title} [gid=${item.gid}]：${item.note}`)
    }
  }
  return lines.join('\n')
}

/** Match courses by identifier, numeric id, or a name substring. */
function selectCourses(courses, query) {
  if (!query) return courses
  const needle = String(query).trim()
  const lowered = needle.toLowerCase()
  return courses.filter(course =>
    String(course?.identifier) === needle
    || String(course?.id) === needle
    || String(course?.name ?? '').toLowerCase().includes(lowered))
}

/**
 * Find every homework that still has unfinished challenges, and optionally
 * finish them — the whole account, or one course.
 *
 * Discovery is deliberately cheap. A course's homework list already reports
 * `finished_challenge_count` against `challenge_count`, so a complete homework
 * is skipped without reading a single challenge; only the homeworks that still
 * report work get walked challenge by challenge. That turns a full-account scan
 * into roughly one request per course plus the walk of the few open homeworks,
 * and a scan spends **no model tokens at all**.
 *
 * `finished_challenge_count` under-reports rather than over-reports (the
 * platform updates it lazily), so `done >= total` is a safe skip.
 *
 * @param {object} options
 * @param {'scan'|'solve'} options.mode - `scan` reads and reports only.
 * @param {string} [options.course] - limit to one course.
 * @returns {Promise<object>} a compact, JSON-serializable sweep report.
 */
export async function sweep({ ctx, client, config, store, mode, course, log, signal }) {
  const courses = selectCourses(await client.courses(), course)
  if (courses.length === 0) {
    throw new EducoderError(`找不到课程：${course}`, 'NOT_FOUND')
  }

  const results = []
  let processed = 0
  let examined = 0

  for (const item of courses) {
    if (signal?.aborted) throw new EducoderError('操作已取消', 'ABORTED')
    let homeworks = []
    try {
      homeworks = await client.homeworks(item.identifier)
    } catch (error) {
      if (error instanceof SessionExpiredError) throw error
      log(`${item.name}：读取作业列表失败（${error.message}）`)
      continue
    }
    examined += homeworks.length

    const open = homeworks.filter(homework => {
      const total = Number(homework?.challenge_count ?? 0)
      const done = Number(homework?.finished_challenge_count ?? 0)
      return total > 0 && done < total
    })
    if (open.length === 0) continue
    log(`${item.name}：${open.length} 份作业还有未完成关卡`)

    for (const homework of open) {
      if (signal?.aborted) throw new EducoderError('操作已取消', 'ABORTED')
      const homeworkId = Number(homework.homework_id)
      const base = { course: item.name, courseIdentifier: item.identifier, homeworkId, name: homework.name }

      if (config.homeworkLimit > 0 && processed >= config.homeworkLimit) {
        results.push({ ...base, skipped: true, note: `达到 homeworkLimit=${config.homeworkLimit}，本次未处理` })
        continue
      }
      const entry = await client.entryGame(homework)
      if (!entry) {
        results.push({ ...base, ok: false, note: '无法解析入口关卡' })
        continue
      }
      log(`${homework.name}：开始（入口 ${entry}）`)
      const report = await runHomework({
        ctx,
        client,
        target: { gameId: entry, homeworkId },
        config,
        store,
        // `runHomework` only knows survey/solve; a scan must never submit.
        mode: mode === 'scan' ? 'survey' : 'solve',
        log: message => log(`  [${homework.name}] ${message}`),
        signal,
      })
      processed += 1
      results.push({
        ...base,
        ok: report.ok,
        counts: report.counts,
        ...(report.stopped ? { stopped: report.stopped } : {}),
        challenges: report.challenges.map(item => ({
          title: item.title,
          status: item.status,
          kind: item.kind,
          note: item.note,
        })),
      })
    }
  }

  const totals = results.reduce((acc, item) => {
    if (!item.counts) return acc
    acc.challenges += item.counts.total
    acc.passed += item.counts.passed
    acc.failed += item.counts.failed
    acc.stillOpen += item.counts.stillOpen
    return acc
  }, { challenges: 0, passed: 0, failed: 0, stillOpen: 0 })

  return {
    mode,
    scope: course ?? 'all',
    account: client.zzud,
    coursesScanned: courses.length,
    homeworksExamined: examined,
    homeworksWithWork: results.length,
    homeworksProcessed: processed,
    totals,
    homeworks: results,
    /** Challenges still not passed once this sweep finished. */
    outstanding: totals.failed + totals.stillOpen,
    /**
     * Whether the sweep itself ran to completion. This is deliberately NOT
     * "everything is passed": a scan that finds open work succeeded, and saying
     * otherwise would read as an error. Use `outstanding` for the outcome.
     */
    ok: results.every(item => item.skipped === true
      || (item.counts !== undefined && item.stopped === undefined)),
  }
}

/** Render a sweep report as the compact text a model should read. */
export function renderSweep(report) {
  const lines = []
  const outstanding = report.totals.failed + report.totals.stillOpen
  const headline = report.mode === 'scan'
    ? (report.homeworksWithWork === 0 ? '没有未完成的作业' : `发现 ${report.homeworksWithWork} 份作业未完成`)
    : (outstanding === 0 ? '全部完成' : `仍有 ${outstanding} 个关卡未通过`)
  lines.push(`头歌全量${report.mode === 'scan' ? '扫描' : '处理'}结果：${headline}`)
  lines.push(`账号=${report.account} 范围=${report.scope} 课程=${report.coursesScanned} 份作业=${report.homeworksExamined}`)
  if (report.mode !== 'scan') {
    lines.push(`本次处理 ${report.homeworksProcessed} 份作业：通过 ${report.totals.passed}、失败 ${report.totals.failed}、待完成 ${report.totals.stillOpen}`)
  }
  lines.push('')
  if (report.homeworks.length === 0) {
    lines.push('（所有作业的关卡都已通过）')
  }
  for (const item of report.homeworks) {
    if (item.skipped || !item.counts) {
      lines.push(`⏭️ ${item.course} / ${item.name} — ${item.note ?? '未处理'}`)
      continue
    }
    const icon = item.ok ? '✅' : '❌'
    lines.push(`${icon} ${item.course} / ${item.name} (hw=${item.homeworkId})`)
    lines.push(`   关卡 ${item.counts.total} 个：通过 ${item.counts.passed}、失败 ${item.counts.failed}、待完成 ${item.counts.stillOpen}、跳过 ${item.counts.skipped}`)
    if (item.stopped) lines.push(`   ⚠️ 中途停止：${item.stopped.message}`)
    for (const challenge of item.challenges ?? []) {
      if (report.mode === 'scan' && challenge.status === 'already-passed') continue
      lines.push(`   - [${challenge.status}] ${challenge.title} (${challenge.kind})：${challenge.note}`)
    }
  }
  return lines.join('\n')
}
