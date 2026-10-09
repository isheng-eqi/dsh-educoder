/**
 * Offline smoke test for dsh-plugin-educoder.
 *
 * It runs the plugin's real `apply` against a stub tool registry that performs
 * the same checks the live `ctx.tools.register` performs, so a schema the
 * registry would reject fails here instead of at activation time.
 *
 * Run it from a directory where `@deepseek-ai/dsh-tools` resolves — the DSH
 * profile directory is the easy one:
 *
 *   cd "$DSH_PROFILE_DIR"
 *   node <plugin>/tests/smoke.test.mjs
 *
 * Without that package the test falls back to a local subset check and says so,
 * so it still runs in a bare checkout.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pluginRoot = path.resolve(here, '..')

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Resolve the real registry assertions, or fall back to a local subset check. */
async function loadAssertions() {
  const roots = [process.env.DSH_PROFILE_DIR, process.cwd(), pluginRoot].filter(Boolean)
  for (const root of roots) {
    try {
      const require = createRequire(pathToFileURL(path.join(root, 'anchor.js')))
      const resolved = require.resolve('@deepseek-ai/dsh-tools')
      const module = await import(pathToFileURL(resolved).href)
      if (typeof module.assertSupportedJsonSchema === 'function') {
        return { real: true, ...module }
      }
    } catch {
      // try the next root
    }
  }
  return { real: false }
}

const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
/** Minimal stand-in: walk the subset the registry enforces. */
function localAssertSchema(node, at = 'schema') {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`${at} must be a schema object`)
  }
  if (Object.hasOwn(node, 'type')) {
    if (!SCHEMA_TYPES.has(node.type)) {
      throw new Error(`${at}.type must be one of ${[...SCHEMA_TYPES].join('/')}`)
    }
  } else {
    for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
      if (Object.hasOwn(node, key)) throw new Error(`${at}.${key} requires type`)
    }
    return
  }
  if (node.type === 'object' && Object.hasOwn(node, 'properties')) {
    for (const [key, value] of Object.entries(node.properties)) localAssertSchema(value, `${at}.properties.${key}`)
  }
  if (node.type === 'array' && Object.hasOwn(node, 'items')) localAssertSchema(node.items, `${at}.items`)
}

const assertions = await loadAssertions()
console.log(`registry assertions: ${assertions.real ? 'real (@deepseek-ai/dsh-tools)' : 'local subset fallback'}`)

const assertSupported = assertions.real ? assertions.assertSupportedJsonSchema : localAssertSchema

const plugin = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
console.log(`plugin: ${plugin.name} inject=${JSON.stringify(plugin.inject)}`)

// ---------------------------------------------------------------- registration
const registered = []
const stub = {
  effect: (fn) => {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  tools: {
    register: (definition) => {
      // Mirrors packages/core/tools/src/index.ts register().
      const output = definition.output
      if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function') {
        throw new TypeError(`tool "${definition.name}" must declare output { schema, render }`)
      }
      assertSupported(output.schema)
      if (definition.timeoutMs !== undefined
        && (!Number.isFinite(definition.timeoutMs) || definition.timeoutMs <= 0)) {
        throw new TypeError(`tool "${definition.name}" timeoutMs must be a positive finite number`)
      }
      if (definition.name === 'run_code') throw new Error('reserved name')
      // Beyond the live check, the model-facing schema must be a valid object.
      assertSupported(definition.parameters)
      if (definition.parameters.type !== 'object') {
        throw new Error(`tool "${definition.name}" parameters must be object-rooted`)
      }
      registered.push(definition)
      return () => {}
    },
  },
  get: () => undefined,
  logger: { info: () => {} },
}

console.log('apply():')
const config = plugin.Config({})
plugin.apply(stub, config)
check('registered three tools', registered.length === 3, `got ${registered.length}`)
check('tool names', registered.map(def => def.name).join(',') === 'educoder_homework,educoder_account,educoder_sweep',
  registered.map(def => def.name).join(','))
for (const definition of registered) {
  check(`${definition.name} has a description`, definition.description.length > 40)
  check(`${definition.name} is not concurrency safe or is read-only`, typeof definition.isConcurrencySafe === 'function')
}

// ------------------------------------------------------------------- rendering
const homework = registered.find(def => def.name === 'educoder_homework')
const account = registered.find(def => def.name === 'educoder_account')

const sample = {
  mode: 'solve',
  target: { gameId: 'op7hwrazem5u', homeworkId: 4197532 },
  account: 'tester',
  model: 'deepseek-official/deepseek-v4-flash',
  counts: { total: 2, alreadyPassed: 1, open: 1, passed: 1, failed: 0, skipped: 0, stillOpen: 0 },
  challenges: [
    { index: 1, gid: 'a', title: '第一关', kind: 'code', status: 'already-passed', attempts: 0, note: '进入作业前就已经通过' },
    { index: 2, gid: 'b', title: '第二关', kind: 'code', status: 'passed', attempts: 2, note: '第 2 次提交通过' },
  ],
  ok: true,
}
const blocks = homework.output.render({}, sample)
check('homework render returns text blocks',
  Array.isArray(blocks) && blocks.length === 1 && blocks[0].type === 'text' && blocks[0].text.includes('全部通过'))
check('homework render names the model', blocks[0].text.includes('deepseek-official/deepseek-v4-flash'))

const failBlocks = homework.output.render({}, {
  ...sample,
  ok: false,
  counts: { total: 2, alreadyPassed: 0, open: 2, passed: 1, failed: 1, skipped: 0, stillOpen: 0 },
  challenges: [{ index: 1, gid: 'b', title: '第二关', kind: 'code', status: 'failed', attempts: 3, note: '编译错误' }],
})
check('failure report lists unfinished challenges', failBlocks[0].text.includes('第二关') && failBlocks[0].text.includes('编译错误'))

const accountBlocks = account.output.render({}, {
  ok: true, account: 'me', sessionFile: 'x', sessionVerified: true, probe: { title: '第一关' },
  courses: [{ identifier: 'C1', name: '数据结构', tasks: 12 }],
})
check('account render lists courses', accountBlocks[0].text.includes('数据结构'))
check('account render claims verification only after a probe', accountBlocks[0].text.includes('会话已验证'))
const unverified = account.output.render({}, {
  ok: true, account: 'me', sessionFile: 'x', sessionVerified: false, probe: null, courses: [],
})
check('account render refuses to call an unprobed session verified', unverified[0].text.includes('会话未验证'))
const accountFail = account.output.render({}, { ok: false, account: '', courses: [], error: '账号或密码错误' })
check('account render surfaces the error', accountFail[0].text.includes('账号或密码错误'))

// ----------------------------------------------------------------- API client
const api = await import(pathToFileURL(path.join(pluginRoot, 'lib/api.js')).href)

console.log('parseTaskUrl():')
const cases = [
  ['https://www.educoder.net/tasks/AGUY4O7A/4197532/op7hwrazem5u', 'op7hwrazem5u', 4197532],
  ['https://www.educoder.net/tasks/4197532/op7hwrazem5u', 'op7hwrazem5u', 4197532],
  ['https://www.educoder.net/tasks/op7hwrazem5u', 'op7hwrazem5u', null],
  ['https://www.educoder.net/tasks/AGUY4O7A/4197532', null, 4197532],
  ['/tasks/AGUY4O7A/4197532/op7hwrazem5u?zzud=someone', 'op7hwrazem5u', 4197532],
  ['4197532', null, 4197532],
]
for (const [input, gameId, homeworkId] of cases) {
  const got = api.parseTaskUrl(input)
  check(`parse ${input}`, got.gameId === gameId && got.homeworkId === homeworkId, JSON.stringify(got))
}
let threw = false
try { api.parseTaskUrl('') } catch { threw = true }
check('empty target throws', threw)

console.log('sign():')
const [ts, signature] = api.sign('GET', 1700000000000)
check('timestamp is echoed', ts === 1700000000000)
// Independently recomputed: base64("method=GET&ak=...&sk=...&time=1700000000000") then md5.
check('signature matches the reference construction',
  /^[0-9a-f]{32}$/.test(signature) && signature === 'e279c864e2752591aa53c3989b9fdbeb',
  signature)

console.log('helpers:')
check('splitPaths handles both semicolons',
  JSON.stringify(api.splitPaths('src/A.java；src/B.java; src/C.java')) === JSON.stringify(['src/A.java', 'src/B.java', 'src/C.java']))
check('placeholderHit finds a platform blank', api.placeholderHit('a\nint b = ————;') !== null)
check('placeholderHit passes clean code', api.placeholderHit('int b = 1;') === null)
check('choiceAnswers orders by position', JSON.stringify(api.choiceAnswers({
  choose_test_cases: { test_sets: [{ position: 2, standard_answer: 'B' }, { position: 1, standard_answer: 'A' }] },
})) === JSON.stringify(['A', 'B']))
check('choiceAnswers refuses a missing key', api.choiceAnswers({
  choose_test_cases: { test_sets: [{ position: 1, standard_answer: null }] },
}) === null)
check('verdictOf reads status 2 as passed',
  api.verdictOf({ game: { status: 2 }, test_sets: [{ position: 1, result: true }] }).passed === true)
check('verdictOf refuses to call a running test settled',
  api.verdictOf({ game: { status: 0 }, test_sets: [{ position: 1, result: null }] }).settled === false)
check('divergence locates the first difference',
  api.divergence('a\nb\nc', 'a\nX\nc').includes('line 2'))

console.log('extractFiles():')
const flow = await import(pathToFileURL(path.join(pluginRoot, 'lib/flow.js')).href)
check('parses a fenced block',
  flow.extractFiles('```json\n{"src/A.java":"class A {}"}\n```', ['src/A.java']).files['src/A.java'] === 'class A {}')
check('falls back to the outermost braces',
  flow.extractFiles('here: {"B.java":"class B {}"} done', ['src/deep/B.java']).files['src/deep/B.java'] === 'class B {}')
check('accepts a nested files object',
  flow.extractFiles('{"files":{"src/A.java":"x"}}', ['src/A.java']).files['src/A.java'] === 'x')
check('reports unmatched paths',
  JSON.stringify(flow.extractFiles('no json', ['src/A.java']).unmatched) === JSON.stringify(['src/A.java']))

// ------------------------------------------------------------------ transport
// The live platform reports an unusable session inside an ordinary HTTP 200
// body, so the transport contract is worth pinning down without the network.
console.log('transport:')
const realFetch = globalThis.fetch
const respondJson = body => {
  globalThis.fetch = async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
const transport = new api.EducoderClient({})
transport.session = 'stale-session'

respondJson({ status: 401, message: '请登录后再操作' })
let sessionError = null
try { await transport.request('GET', '/tasks/x.json') } catch (error) { sessionError = error }
check('body status 401 raises SessionExpiredError',
  sessionError instanceof api.SessionExpiredError, String(sessionError))

const raw = await transport.request('GET', '/accounts/login.json', undefined, { sessionSensitive: false })
check('sessionSensitive:false keeps the raw body', raw.status === 401)

respondJson({ status: -102 })
let signatureError = null
try { await transport.request('GET', '/tasks/x.json') } catch (error) { signatureError = error }
check('status -102 raises BAD_SIGNATURE', signatureError?.code === 'BAD_SIGNATURE', String(signatureError))

globalThis.fetch = async () => new Response('nope', { status: 401 })
let httpError = null
try { await transport.request('GET', '/tasks/x.json') } catch (error) { httpError = error }
check('HTTP 401 raises SessionExpiredError', httpError instanceof api.SessionExpiredError)

globalThis.fetch = async () => new Response('not json at all', { status: 200 })
let jsonError = null
try { await transport.request('GET', '/tasks/x.json') } catch (error) { jsonError = error }
check('a non-JSON body raises BAD_JSON', jsonError?.code === 'BAD_JSON', String(jsonError))

// A rejected login is a credential verdict, not an expired session.
globalThis.fetch = async () => new Response(JSON.stringify({ status: -3, message: '用户名或密码错误' }), { status: 200 })
let credentialError = null
try { await new api.EducoderClient({}).login('nobody', 'wrong', null) } catch (error) { credentialError = error }
check('a wrong password raises BAD_CREDENTIALS', credentialError?.code === 'BAD_CREDENTIALS', String(credentialError))

// login() must take the session from Set-Cookie, not from the JSON body.
globalThis.fetch = async () => {
  const headers = new Headers()
  headers.append('set-cookie', '_educoder_session=SESSIONVALUE; Path=/; HttpOnly')
  headers.append('set-cookie', 'autologin_trustie=AUTOVALUE; Path=/')
  return new Response(JSON.stringify({ status: 1, login: 'me' }), { status: 200, headers })
}
const loginClient = new api.EducoderClient({})
await loginClient.login('me', 'pw', null)
check('login captures _educoder_session', loginClient.session === 'SESSIONVALUE', loginClient.session)
check('login captures autologin_trustie', loginClient.autologin === 'AUTOVALUE', loginClient.autologin)
check('login records the account name', loginClient.zzud === 'me', loginClient.zzud)
check('login sends both cookies afterwards',
  loginClient.cookieHeader() === 'autologin_trustie=AUTOVALUE; _educoder_session=SESSIONVALUE',
  loginClient.cookieHeader())

globalThis.fetch = realFetch

// ------------------------------------------------------- homework walk (mocked)
// A three-challenge homework whose entry point is the LAST challenge, which is
// what the platform actually returns: c1 already passed, c2 and c3 open choice
// challenges. `next_game` is null until the challenge before it passes, so a
// walk that trusts the cached detail stops after the first one.
function makePlatform() {
  const state = { c1: true, c2: false, c3: false }
  const chooseCalls = []
  const detailOf = gid => ({
    homework_common_id: 4197532,
    challenge: { id: `ch-${gid}`, subject: `关卡 ${gid}`, path: '' },
    game: { id: 238596610, identifier: gid, name: `关卡 ${gid}`, status: state[gid] ? 2 : 0, evaluate_count: 0 },
    myshixun: { identifier: 'mx-1', commit_id: 'c0' },
    user: { user_id: 2264511 },
    shixun_environments: [{ shixun_environment_id: 1732557 }],
    choose_test_cases: { test_sets: [{ position: 1, standard_answer: 'A' }, { position: 2, standard_answer: 'B' }] },
    prev_game: gid === 'c1' ? null : gid === 'c2' ? 'c1' : 'c2',
    next_game: state[gid] ? (gid === 'c1' ? 'c2' : gid === 'c2' ? 'c3' : null) : null,
  })
  return {
    zzud: 'tester',
    chooseCalls,
    async taskDetail(gid) { return structuredClone(detailOf(gid)) },
    async choose(gid) {
      chooseCalls.push(gid)
      state[gid] = true
      return { choose_correct_num: 2, challenge_chooses_count: 2 }
    },
  }
}

const stubCtx = {
  get: name => (name === 'agentDefaultModel'
    ? { currentSelection: () => ({ provider: 'stub-provider', model: 'stub-model' }) }
    : undefined),
}
const baseConfig = plugin.Config({})

console.log('runHomework(survey):')
const surveyClient = makePlatform()
const survey = await flow.runHomework({
  ctx: stubCtx,
  client: surveyClient,
  target: { gameId: 'c3', homeworkId: 4197532 },
  config: baseConfig,
  mode: 'survey',
  log: () => {},
})
check('walks every challenge exactly once', survey.counts.total === 3, JSON.stringify(survey.counts))
check('counts the already-passed challenge once', survey.counts.alreadyPassed === 1, JSON.stringify(survey.counts))
check('reports the two open challenges', survey.counts.stillOpen === 2, JSON.stringify(survey.counts))
check('survey submits nothing', surveyClient.chooseCalls.length === 0)
// A survey only reports, but it must not claim the homework is finished.
check('a survey of unfinished work is not ok', survey.ok === false, String(survey.ok))
check('a survey of unfinished work does not say 全部通过',
  !flow.renderReport(survey).includes('全部通过')
  && flow.renderReport(survey).includes('巡检完成，还有 2 个关卡没通过'),
  flow.renderReport(survey).split('\n')[0])

console.log('runHomework(solve, choice-only):')
const solveClient = makePlatform()
const solved = await flow.runHomework({
  ctx: stubCtx,
  client: solveClient,
  target: { gameId: 'c3', homeworkId: 4197532 },
  config: baseConfig,
  mode: 'solve',
  log: () => {},
})
check('submits each open challenge once', JSON.stringify(solveClient.chooseCalls) === JSON.stringify(['c2', 'c3']),
  JSON.stringify(solveClient.chooseCalls))
check('walks three challenges', solved.counts.total === 3, JSON.stringify(solved.counts))
check('passes both open challenges', solved.counts.passed === 2, JSON.stringify(solved.counts))
check('nothing failed', solved.counts.failed === 0)
check('reports ok', solved.ok === true)
check('reports the resolved model', solved.model === 'stub-provider/stub-model', solved.model)

console.log('auth recovery:')
// `/courses.json` answers with a full course list even with no session, so
// connect() must not pretend a cached cookie was verified, and the run must
// recover from a stale one before it writes anything.
const staleStore = {
  async load() { return { zzud: 'me', session: 'stale', autologin: '' } },
  async save() {},
}
const connected = await flow.connect({
  config: { ...baseConfig, login: '', password: '' },
  store: staleStore,
  log: () => {},
})
check('connect adopts a cached session without probing it', connected.session === 'stale', connected.session)

let recoverError = null
try {
  await flow.ensureAuthenticated(connected, { ...baseConfig, login: '', password: '' }, staleStore, () => {})
} catch (error) { recoverError = error }
check('ensureAuthenticated explains missing credentials', recoverError?.code === 'NO_CREDENTIALS', String(recoverError))

const loginCalls = []
await flow.ensureAuthenticated({
  async login(user, password) { loginCalls.push([user, password]) },
}, { ...baseConfig, login: 'me', password: 'pw' }, staleStore, () => {})
check('ensureAuthenticated re-logs in with the configured account',
  JSON.stringify(loginCalls) === JSON.stringify([['me', 'pw']]), JSON.stringify(loginCalls))

const authConfig = plugin.Config({ login: 'me', password: 'pw' })
const recovering = makePlatform()
const realTaskDetail = recovering.taskDetail
let firstRead = true
recovering.taskDetail = async (gid, homeworkId) => {
  if (firstRead) {
    firstRead = false
    throw new api.SessionExpiredError('stale cookie')
  }
  return realTaskDetail(gid, homeworkId)
}
const reLogins = []
recovering.login = async user => { reLogins.push(user); recovering.zzud = user }
const recovered = await flow.runHomework({
  ctx: stubCtx,
  client: recovering,
  target: { gameId: 'c3', homeworkId: 4197532 },
  config: authConfig,
  store: staleStore,
  mode: 'solve',
  log: () => {},
})
check('a stale session is re-logged-in exactly once', JSON.stringify(reLogins) === JSON.stringify(['me']), JSON.stringify(reLogins))
check('the run then completes', recovered.counts.passed === 2 && recovered.ok === true, JSON.stringify(recovered.counts))

console.log()
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
