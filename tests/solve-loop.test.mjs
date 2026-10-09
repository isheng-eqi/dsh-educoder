/**
 * Solve-loop test for dsh-educoder.
 *
 * `solveCodeChallenge` is the only part of the plugin that consumes the user's
 * real evaluation quota, so its exact wire behaviour is pinned down here with a
 * scripted model and a mock platform: what gets uploaded, how many grading runs
 * are started, and what the retry prompt actually contains.
 *
 * Run it from a directory where `@deepseek-ai/dsh-tools` resolves (the DSH
 * profile directory), same as smoke.test.mjs:
 *
 *   cd "$DSH_PROFILE_DIR"
 *   node <plugin>/tests/solve-loop.test.mjs
 */

import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pluginRoot = path.resolve(here, '..')
const load = name => import(pathToFileURL(path.join(pluginRoot, name)).href)

const plugin = await load('index.js')
const api = await load('lib/api.js')
const flow = await load('lib/flow.js')

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`)
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

/**
 * A model whose replies are scripted, recording every prompt it was sent.
 * A reply is either the text, or `{ text, finish }` to script the stop reason.
 */
function makeLlm(replies) {
  const prompts = []
  let index = 0
  return {
    prompts,
    stream(options) {
      prompts.push(options.messages[0].content[0].text)
      const raw = replies[Math.min(index, replies.length - 1)]
      index += 1
      const text = typeof raw === 'string' ? raw : raw.text
      const kind = typeof raw === 'string' ? 'stop' : (raw.finish ?? 'stop')
      return (async function* () {
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind } }
      })()
    },
  }
}

const ctxWith = llm => ({
  get(name) {
    if (name === 'llm') return llm
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'stub-provider', model: 'stub-model' }) }
    }
    return undefined
  },
})

/**
 * A mock EduCoder workspace for one code challenge.
 *
 * `verdicts[i]` is the outcome of the i-th grading run. The first poll after a
 * grading run reports `result: null`, exactly as the platform does while a run
 * is in flight, so the plugin's "not a verdict yet" handling is exercised too.
 */
function makePlatform({ remotePaths, originals, verdicts }) {
  const requests = []
  const state = { evaluateCount: 0, runIndex: -1, pollsSinceGrade: 99, current: null, commit: 'commit-0' }

  const view = inFlight => {
    const tests = inFlight || state.current === null
      ? (state.current?.tests ?? []).map(test => ({ ...test, result: null }))
      : state.current.tests
    return {
      homework_common_id: 4197532,
      sec_key: null,
      challenge: { id: 5539058, subject: 'Singleton', path: remotePaths.join('；') },
      game: {
        id: 238596610,
        identifier: 'g1',
        name: 'Singleton',
        status: inFlight || state.current === null ? 0 : state.current.status,
        final_score: state.current?.score ?? 0,
        accuracy: null,
        evaluate_count: state.evaluateCount,
      },
      myshixun: { identifier: 'mx-1', commit_id: state.commit },
      user: { user_id: 2264511 },
      shixun_environments: [{ shixun_environment_id: 1732557 }],
      test_sets: tests,
      last_compile_output: state.current?.compile ?? '',
      prev_game: null,
      next_game: null,
    }
  }

  return {
    zzud: 'tester',
    requests,
    async taskDetail() {
      const inFlight = state.pollsSinceGrade < 1
      state.pollsSinceGrade += 1
      return structuredClone(view(inFlight))
    },
    async readFile(_gid, _hw, remote) { return originals[remote] ?? '' },
    async saveFile(mid, payload) {
      requests.push({ kind: 'save', mid, payload })
      state.commit = `commit-${requests.filter(r => r.kind === 'save').length}`
      return state.commit
    },
    async grade(gid, payload) {
      requests.push({ kind: 'grade', gid, payload })
      state.runIndex += 1
      state.evaluateCount += 1
      state.pollsSinceGrade = 0
      state.current = verdicts[Math.min(state.runIndex, verdicts.length - 1)]
      return { code: 0, data: { msg: 'ok' } }
    },
  }
}

const FAILING = {
  status: 1,
  score: 0,
  compile: "Singleton.java:7: error: ';' expected",
  tests: [{ position: 1, result: false, input: '', output: 'OK', actual_output: 'ERROR' }],
}
const PASSING = {
  status: 2,
  score: 100,
  compile: 'compile successfully',
  tests: [{ position: 1, result: true, input: '', output: 'OK', actual_output: 'OK' }],
}

// A low poll interval keeps the suite fast; the deadline logic is unchanged.
const config = plugin.Config({ maxAttempts: 3, pollIntervalSec: 0, gradeTimeoutSec: 5 })
check('a 0-second poll interval is an accepted config value', config.pollIntervalSec === 0, String(config.pollIntervalSec))

// ---------------------------------------------------------------------------
console.log('single-file challenge: placeholder -> fail -> pass')
const REMOTE = 'src/step1/Singleton.java'
const PLACEHOLDER_REPLY = '```json\n{"src/step1/Singleton.java":"class Singleton {\\n  private static Singleton i = ————;\\n}\\n"}\n```'
const FIRST_REPLY = '```json\n{"src/step1/Singleton.java":"class Singleton {\\n  private static Singleton i = new Singleton();\\n}\\n"}\n```'
const SECOND_REPLY = '```json\n{"src/step1/Singleton.java":"class Singleton {\\n  private Singleton() {}\\n  private static final Singleton i = new Singleton();\\n}\\n"}\n```'

const llm = makeLlm([PLACEHOLDER_REPLY, FIRST_REPLY, SECOND_REPLY])
const platform = makePlatform({
  remotePaths: [REMOTE],
  originals: { [REMOTE]: 'class Singleton {\n  private static Singleton i = ————;\n}\n' },
  verdicts: [FAILING, PASSING],
})

const report = await flow.runHomework({
  ctx: ctxWith(llm),
  client: platform,
  target: { gameId: 'g1', homeworkId: 4197532 },
  config,
  store: { async save() {} },
  mode: 'solve',
  log: () => {},
})

const saves = platform.requests.filter(r => r.kind === 'save')
const grades = platform.requests.filter(r => r.kind === 'grade')

check('the run reports the challenge as passed', report.counts.passed === 1 && report.ok === true,
  JSON.stringify(report.counts))
check('it took three model attempts', report.challenges[0].attempts === 3, String(report.challenges[0].attempts))
check('the placeholder attempt uploaded nothing', saves.length === 2, `saves=${saves.length}`)
check('one grading run per uploading attempt, not per file', grades.length === 2, `grades=${grades.length}`)
check('the model saw three prompts', llm.prompts.length === 3, String(llm.prompts.length))

console.log('  upload payload:')
const save = saves[0].payload
check('save reports evaluate:0 (grading is triggered separately)', save.evaluate === 0)
check('save carries the remote path', save.path === REMOTE, save.path)
check('save carries the game id', save.game_id === 238596610, String(save.game_id))
check('save carries the challenge id in extras', save.extras.challenge_id === 5539058)
check('save carries the author id in extras', save.extras.currentUserId === 2264511)
check('save fills every empty extras slot the platform expects',
  save.extras.exercise_id === '' && save.extras.question_id === '' && save.extras.subject_id === ''
  && save.extras.competition_entry_id === '',
  JSON.stringify(save.extras))

console.log('  grading payload:')
const grade = grades[0].payload
check('grade sends first:1', grade.first === 1)
check('grade normalises a null sec_key to an empty string', grade.sec_key === '')
check('grade carries the shixun environment', grade.shixun_environment_id === 1732557)
check('grade carries the commit id from the save', grade.extras.commitID === 'commit-1', String(grade.extras.commitID))
check('grade repeats the challenge extras', grade.extras.challenge_id === 5539058 && grade.extras.currentUserId === 2264511)
check('the second grading run grades the second commit', grades[1].payload.extras.commitID === 'commit-2',
  String(grades[1].payload.extras.commitID))

console.log('  retry feedback:')
check('attempt 2 is told about the platform blank',
  llm.prompts[1].includes('仍然留着平台的填空') && llm.prompts[1].includes('Singleton.java'),
  'placeholder feedback missing')
check('attempt 2 is shown the original file', llm.prompts[1].includes('————'))
check('attempt 3 is told the first run failed',
  llm.prompts[2].includes('没有通过评测'), 'failure header missing')
check('attempt 3 receives the compiler error', llm.prompts[2].includes("';' expected"))
check('attempt 3 receives the output divergence', llm.prompts[2].includes('line 1'))
check('attempt 3 is shown what it submitted last time',
  llm.prompts[2].includes('new Singleton()'))
check('attempt 3 is asked for a complete JSON object', llm.prompts[2].includes('JSON.parse'))

// ---------------------------------------------------------------------------
console.log('multi-file challenge: one grading run for the whole challenge')
const A = 'src/step2/MeshAir.java'
const B = 'src/step2/MeshAirTest.java'
const multiLlm = makeLlm([
  `\`\`\`json\n{"${A}":"class MeshAir {}\\n","${B}":"class MeshAirTest {}\\n"}\n\`\`\``,
])
const multi = makePlatform({
  remotePaths: [A, B],
  originals: { [A]: 'class MeshAir { ———— }', [B]: 'class MeshAirTest {}' },
  verdicts: [PASSING],
})
const multiReport = await flow.runHomework({
  ctx: ctxWith(multiLlm),
  client: multi,
  target: { gameId: 'g1', homeworkId: 4197532 },
  config,
  store: { async save() {} },
  mode: 'solve',
  log: () => {},
})
const multiSaves = multi.requests.filter(r => r.kind === 'save')
const multiGrades = multi.requests.filter(r => r.kind === 'grade')
check('both files are uploaded', multiSaves.length === 2, `saves=${multiSaves.length}`)
check('but only ONE grading run is started', multiGrades.length === 1, `grades=${multiGrades.length}`)
check('the run passes', multiReport.counts.passed === 1)

// ---------------------------------------------------------------------------
console.log('retry exhaustion')
const stubbornLlm = makeLlm(['```json\n{"src/step1/Singleton.java":"class Singleton { broken }"}\n```'])
const stubborn = makePlatform({
  remotePaths: [REMOTE],
  originals: { [REMOTE]: 'class Singleton { ———— }' },
  verdicts: [FAILING],
})
const stubbornReport = await flow.runHomework({
  ctx: ctxWith(stubbornLlm),
  client: stubborn,
  target: { gameId: 'g1', homeworkId: 4197532 },
  config,
  store: { async save() {} },
  mode: 'solve',
  log: () => {},
})
check('it stops after maxAttempts', stubbornReport.challenges[0].attempts === 3,
  String(stubbornReport.challenges[0].attempts))
check('and reports failure rather than success',
  stubbornReport.counts.failed === 1 && stubbornReport.ok === false, JSON.stringify(stubbornReport.counts))
check('the failure note carries the platform verdict',
  stubbornReport.challenges[0].note.includes("';' expected"), stubbornReport.challenges[0].note.slice(0, 120))

// ---------------------------------------------------------------------------
console.log('guarding against a half-applied submit')
const missingEnvLlm = makeLlm(['```json\n{"src/step1/Singleton.java":"class A {}"}\n```'])
const missingEnv = makePlatform({
  remotePaths: [REMOTE],
  originals: { [REMOTE]: 'x' },
  verdicts: [PASSING],
})
missingEnv.taskDetail = async () => {
  const detail = await makePlatform({ remotePaths: [REMOTE], originals: {}, verdicts: [] }).taskDetail()
  detail.shixun_environments = []
  return detail
}
const guarded = await flow.runHomework({
  ctx: ctxWith(missingEnvLlm),
  client: missingEnv,
  target: { gameId: 'g1', homeworkId: 4197532 },
  config,
  store: { async save() {} },
  mode: 'solve',
  log: () => {},
})
check('a challenge missing its environment is refused before any write',
  missingEnv.requests.filter(r => r.kind === 'save').length === 0
  && missingEnv.requests.filter(r => r.kind === 'grade').length === 0,
  JSON.stringify(missingEnv.requests.map(r => r.kind)))
check('and it is reported as failed with the reason',
  guarded.counts.failed === 1 && guarded.challenges[0].note.includes('shixun environment'),
  guarded.challenges[0].note)

// ---------------------------------------------------------------------------
console.log('choice challenge submission')
const chooseCalls = []
const choicePlatform = {
  zzud: 'tester',
  async taskDetail() {
    return {
      homework_common_id: 4197532,
      challenge: { id: 187694, subject: '选择题', path: '' },
      game: { id: 1, identifier: 'g1', name: '选择题', status: 0, evaluate_count: 0 },
      myshixun: { identifier: 'mx-1' },
      user: { user_id: 2264511 },
      shixun_environments: [{ shixun_environment_id: 1 }],
      // Deliberately out of order: the platform wants them sorted by position.
      choose_test_cases: {
        test_sets: [{ position: 2, standard_answer: 'B' }, { position: 1, standard_answer: 'A' }],
      },
      prev_game: null,
      next_game: null,
    }
  },
  async choose(gid, payload) {
    chooseCalls.push({ gid, payload })
    return { choose_correct_num: 2, challenge_chooses_count: 2 }
  },
}
const choiceReport = await flow.runHomework({
  ctx: ctxWith(makeLlm([])),
  client: choicePlatform,
  target: { gameId: 'g1', homeworkId: 4197532 },
  config,
  store: { async save() {} },
  mode: 'solve',
  log: () => {},
})
check('exactly one choice submission', chooseCalls.length === 1, String(chooseCalls.length))
check('the answers are ordered by position',
  JSON.stringify(chooseCalls[0].payload.answer) === JSON.stringify(['A', 'B']),
  JSON.stringify(chooseCalls[0].payload.answer))
check('the choice payload names the challenge', chooseCalls[0].payload.challenge_id === 187694,
  String(chooseCalls[0].payload.challenge_id))
check('the choice payload sends the nulls the platform expects',
  chooseCalls[0].payload.subject_id === null
  && chooseCalls[0].payload.question_id === null
  && chooseCalls[0].payload.competition_entry_id === null
  && chooseCalls[0].payload.smart_plan_page_item_bank_id === null,
  JSON.stringify(chooseCalls[0].payload))
check('a fully correct choice submission counts as passed',
  choiceReport.counts.passed === 1 && choiceReport.counts.failed === 0, JSON.stringify(choiceReport.counts))

// ---------------------------------------------------------------------------
console.log('challengeLimit')
const chainState = { c1: false, c2: false }
const chainView = gid => ({
  homework_common_id: 4197532,
  challenge: { id: gid === 'c1' ? 1 : 2, subject: gid, path: '' },
  game: { id: 1, identifier: gid, name: gid, status: chainState[gid] ? 2 : 0, evaluate_count: 0 },
  myshixun: { identifier: 'mx' },
  user: { user_id: 1 },
  shixun_environments: [{ shixun_environment_id: 1 }],
  choose_test_cases: { test_sets: [{ position: 1, standard_answer: 'A' }] },
  prev_game: gid === 'c1' ? null : 'c1',
  next_game: chainState[gid] ? (gid === 'c1' ? 'c2' : null) : null,
})
const chainPlatform = {
  zzud: 'tester',
  async taskDetail(gid) { return structuredClone(chainView(gid)) },
  async choose(gid) {
    chainState[gid] = true
    return { choose_correct_num: 1, challenge_chooses_count: 1 }
  },
}
const limited = await flow.runHomework({
  ctx: ctxWith(makeLlm([])),
  client: chainPlatform,
  target: { gameId: 'c2', homeworkId: 4197532 },
  config: plugin.Config({ challengeLimit: 1, pollIntervalSec: 0 }),
  store: { async save() {} },
  mode: 'solve',
  log: () => {},
})
check('the whole homework is still enumerated', limited.counts.total === 2, JSON.stringify(limited.counts))
check('only the allowed number is processed', limited.counts.passed === 1 && limited.counts.skipped === 1,
  JSON.stringify(limited.counts))

// ---------------------------------------------------------------------------
console.log('mid-run stop keeps the partial result')
const stopState = { c1: false, c2: false, c3: false }
const stopView = gid => ({
  homework_common_id: 4197532,
  challenge: { id: gid === 'c1' ? 1 : gid === 'c2' ? 2 : 3, subject: gid, path: '' },
  game: { id: 1, identifier: gid, name: gid, status: stopState[gid] ? 2 : 0, evaluate_count: 0 },
  myshixun: { identifier: 'mx' },
  user: { user_id: 1 },
  shixun_environments: [{ shixun_environment_id: 1 }],
  choose_test_cases: { test_sets: [{ position: 1, standard_answer: 'A' }] },
  prev_game: gid === 'c1' ? null : gid === 'c2' ? 'c1' : 'c2',
  next_game: stopState[gid] ? (gid === 'c1' ? 'c2' : gid === 'c2' ? 'c3' : null) : null,
})
const stopPlatform = {
  zzud: 'tester',
  attempted: [],
  async taskDetail(gid) { return structuredClone(stopView(gid)) },
  async choose(gid) {
    stopPlatform.attempted.push(gid)
    if (gid === 'c2') throw new api.SessionExpiredError('会话在中途失效')
    stopState[gid] = true
    return { choose_correct_num: 1, challenge_chooses_count: 1 }
  },
}
const partial = await flow.runHomework({
  ctx: ctxWith(makeLlm([])),
  client: stopPlatform,
  target: { gameId: 'c3', homeworkId: 4197532 },
  config,
  store: { async save() {} },
  mode: 'solve',
  log: () => {},
})
check('the run reports the stop instead of throwing',
  partial.stopped?.code === 'SESSION_EXPIRED', JSON.stringify(partial.stopped))
check('a stopped run is never ok', partial.ok === false)
check('the challenge that already passed survives in the report',
  partial.counts.passed === 1, JSON.stringify(partial.counts))
check('the challenge that failed is reported with the reason',
  partial.challenges.some(c => c.gid === 'c2' && c.status === 'failed' && c.note.includes('会话失效')),
  JSON.stringify(partial.challenges.map(c => [c.gid, c.status])))
check('the walk does not continue past the failure',
  !stopPlatform.attempted.includes('c3'), JSON.stringify(stopPlatform.attempted))
const rendered = flow.renderReport(partial)
check('the rendered report announces the stop',
  rendered.includes('中途停止') && rendered.includes('会话在中途失效'), rendered.split('\n')[0])

// ---------------------------------------------------------------------------
console.log('a reply cut off by the output cap is named as such')
// A reasoning model can spend the whole output budget thinking, so a truncated
// JSON reply is a configuration problem, not a forgotten file.
const truncLlm = makeLlm([
  { text: '```json\n{"src/step1/Singleton.java":"class Singleton {', finish: 'max-tokens' },
])
const truncPlatform = makePlatform({
  remotePaths: [REMOTE],
  originals: { [REMOTE]: 'class Singleton { ———— }' },
  verdicts: [PASSING],
})
const truncReport = await flow.runHomework({
  ctx: ctxWith(truncLlm),
  client: truncPlatform,
  target: { gameId: 'g1', homeworkId: 4197532 },
  config: plugin.Config({ maxAttempts: 2, pollIntervalSec: 0, gradeTimeoutSec: 5 }),
  store: { async save() {} },
  mode: 'solve',
  log: () => {},
})
check('a truncated reply uploads nothing',
  truncPlatform.requests.length === 0, JSON.stringify(truncPlatform.requests.map(r => r.kind)))
check('the retry names maxTokens as the cause', truncLlm.prompts[1].includes('maxTokens'),
  truncLlm.prompts[1].slice(-200))
check('and it is not reported as a forgotten file',
  !truncLlm.prompts[1].includes('你的回复里没有包含这些文件'))
check('the failure note also blames the output cap',
  truncReport.challenges[0].note.includes('maxTokens'), truncReport.challenges[0].note.slice(0, 120))

// ---------------------------------------------------------------------------
console.log('choice challenge with no published key (must cost zero model tokens)')
// The platform publishes no answer key for this account's choice challenges,
// but it returns `standard_answer` for every question in the response to a
// submission. So: probe, harvest, resubmit — no model involved.
const harvestState = { passed: false }
const harvestCalls = []
const KEY = ['C', 'D', 'B']
const harvestPlatform = {
  zzud: 'tester',
  async taskDetail() {
    return {
      homework_common_id: 4197532,
      subject_id: null,
      challenge: { id: 2035583, subject: '第八章作业', path: '' },
      game: {
        id: 1, identifier: 'g1', name: '第八章作业',
        status: harvestState.passed ? 2 : 0, evaluate_count: 0,
      },
      myshixun: { identifier: 'mx' },
      user: { user_id: 1 },
      shixun_environments: [{ shixun_environment_id: 1 }],
      choose_test_cases: { test_sets: KEY.map((_, i) => ({ position: i + 1, standard_answer: null })) },
      chooses: KEY.map((_, i) => ({
        position: i + 1,
        subject: `题目 ${i + 1}`,
        challenge_question: [{ position: 0, option_name: 'A' }, { position: 1, option_name: 'B' }],
      })),
      prev_game: null,
      next_game: null,
    }
  },
  async choose(_gid, payload) {
    harvestCalls.push([...payload.answer])
    const exact = payload.answer.length === KEY.length
      && payload.answer.every((answer, index) => answer === KEY[index])
    if (exact) harvestState.passed = true
    return {
      challenge_chooses_count: KEY.length,
      choose_correct_num: payload.answer.filter((answer, index) => answer === KEY[index]).length,
      test_sets: KEY.map((correct, index) => ({
        position: index + 1,
        standard_answer: correct,
        result: payload.answer[index] === correct,
        actual_output: payload.answer[index],
      })),
    }
  },
}
const ctxWithoutModel = {
  get(name) {
    if (name === 'llm') throw new Error('a choice challenge must never call the model')
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'stub-provider', model: 'stub-model' }) }
    }
    return undefined
  },
}
const harvested = await flow.runHomework({
  ctx: ctxWithoutModel,
  client: harvestPlatform,
  target: { gameId: 'g1', homeworkId: 4197532 },
  config,
  store: { async save() {} },
  mode: 'solve',
  log: () => {},
})
check('a probe submission is sent first', harvestCalls.length >= 1 && harvestCalls[0].every(a => a === 'A'),
  JSON.stringify(harvestCalls[0]))
check('the harvested key is submitted second',
  JSON.stringify(harvestCalls[1]) === JSON.stringify(KEY), JSON.stringify(harvestCalls[1]))
check('exactly two submissions were needed', harvestCalls.length === 2, String(harvestCalls.length))
check('the challenge passes', harvested.counts.passed === 1 && harvested.ok === true,
  JSON.stringify(harvested.counts))
check('the note says the model was not used',
  harvested.challenges[0].note.includes('未用模型'), harvested.challenges[0].note)
check('the challenge is reported as a choice challenge', harvested.challenges[0].kind === 'choice')

// ---------------------------------------------------------------------------
console.log('sweep skips complete homeworks without reading any challenge')
const sweepCalls = { taskDetail: 0, homeworks: 0, choose: 0 }
const sweepClient = {
  zzud: 'tester',
  async courses() {
    return [{ identifier: 'C1', name: '课程一' }, { identifier: 'C2', name: '课程二' }]
  },
  async homeworks(courseIdentifier) {
    sweepCalls.homeworks += 1
    if (courseIdentifier === 'C1') {
      // One finished homework and one still open.
      return [
        { homework_id: 111, name: '已完成的作业', challenge_count: 3, finished_challenge_count: 3 },
        { homework_id: 222, name: '未完成的作业', challenge_count: 2, finished_challenge_count: 1 },
      ]
    }
    return [{ homework_id: 333, name: '全做完的', challenge_count: 5, finished_challenge_count: 5 }]
  },
  async entryGame() { return 'g-open' },
  async taskDetail() {
    sweepCalls.taskDetail += 1
    return {
      homework_common_id: 222,
      subject_id: null,
      // An OPEN choice challenge: a scan must report it, never submit it.
      challenge: { id: 1, subject: '关卡', path: '' },
      game: { id: 1, identifier: 'g-open', name: '关卡', status: 0, evaluate_count: 0 },
      myshixun: { identifier: 'mx' },
      user: { user_id: 1 },
      shixun_environments: [{ shixun_environment_id: 1 }],
      choose_test_cases: { test_sets: [{ position: 1, standard_answer: null }] },
      chooses: [{ position: 1, subject: '题目', challenge_question: [{ position: 0, option_name: 'A' }] }],
      prev_game: null,
      next_game: null,
    }
  },
  async choose() {
    sweepCalls.choose += 1
    return { choose_correct_num: 0, challenge_chooses_count: 0 }
  },
}
const swept = await flow.sweep({
  ctx: ctxWith(makeLlm([])),
  client: sweepClient,
  config,
  store: { async save() {} },
  mode: 'scan',
  course: '',
  log: () => {},
})
check('both courses are listed', sweepCalls.homeworks === 2, String(sweepCalls.homeworks))
check('only the open homework is walked', swept.homeworksWithWork === 1, String(swept.homeworksWithWork))
check('the finished homework is never read',
  swept.homeworks[0].homeworkId === 222 && swept.homeworks[0].course === '课程一',
  JSON.stringify(swept.homeworks.map(h => h.homeworkId)))
check('a scan walks the open homework only',
  sweepCalls.taskDetail === 1, String(sweepCalls.taskDetail))
check('a scan reports success even though work remains',
  swept.ok === true && swept.mode === 'scan' && swept.outstanding === 1,
  `ok=${swept.ok} outstanding=${swept.outstanding}`)
// A scan must never submit: it is routed through the read-only survey path.
check('a scan never calls choose', sweepCalls.choose === 0, String(sweepCalls.choose))
check('a scan reports the open challenge as still open',
  swept.homeworks[0].counts.stillOpen === 1, JSON.stringify(swept.homeworks[0].counts))
const sweepText = flow.renderSweep(swept)
check('the sweep report names the open homework', sweepText.includes('未完成的作业'), sweepText.split('\n')[0])
check('the sweep report claims no completion for a scan of open work',
  !sweepText.includes('全部完成'), sweepText.split('\n')[1])

console.log()
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
