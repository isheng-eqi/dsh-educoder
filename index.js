/**
 * dsh-plugin-educoder — one interface that finishes a 头歌 (EduCoder) homework.
 *
 * `educoder_homework` takes the task URL straight out of the browser, walks
 * every challenge of that homework through the platform's own JSON API, submits
 * the multiple-choice answers the platform itself publishes, and for code
 * challenges asks the session's model to write each answer file, uploads it,
 * starts one grading run, and feeds the platform's verdict back to the model
 * until the challenge passes.
 *
 * There is no browser automation and no screen scraping: every step is a
 * documented JSON call, signed with the platform's public client constant.
 *
 * @module dsh-plugin-educoder
 */

import Schema from '@deepseek-ai/schemastery'
import {
  DEFAULT_BASE_URL,
  DEFAULT_SESSION_FILE,
  EducoderError,
  SessionExpiredError,
  SessionStore,
  parseTaskUrl,
} from './lib/api.js'
import { connect, renderReport, renderSweep, resolveTarget, runHomework, sweep } from './lib/flow.js'

export const name = 'educoder'

/** The tool registry and the model route are both required to do the work. */
export const inject = ['tools']

/** Deployment configuration; every tunable is validated at load. */
export const Config = Schema.object({
  /** 头歌登录账号（手机号 / 邮箱 / 用户名）。 */
  login: Schema.string().default(''),
  /** 头歌登录密码；只落在本机 profile 里，不会进入对话。 */
  password: Schema.string().role('secret').default(''),
  /** 会话缓存路径；留空用 ~/.educoder/session.json（与 educoder-lab CLI 共享）。 */
  sessionFile: Schema.string().default(''),
  /** 平台 API 根地址。 */
  baseUrl: Schema.string().default(DEFAULT_BASE_URL),
  /** 生成答案用的 provider；留空用当前会话的模型。 */
  provider: Schema.string().default(''),
  /** 生成答案用的 model；留空用当前会话的模型。 */
  model: Schema.string().default(''),
  /** 每道代码题最多让模型重试几次。 */
  maxAttempts: Schema.natural().default(3),
  /** 单次生成的最大 token 数。 */
  maxTokens: Schema.natural().default(8000),
  /** 单次评测的最长等待秒数。 */
  gradeTimeoutSec: Schema.natural().default(180),
  /** 轮询评测结果的间隔秒数。 */
  pollIntervalSec: Schema.natural().default(3),
  /** 单个 HTTP 请求的超时秒数。 */
  requestTimeoutSec: Schema.natural().default(30),
  /** 本次最多处理几个未通过关卡；0 表示不限（真正的一键做完）。 */
  challengeLimit: Schema.natural().default(0),
  /** 单次全量扫描最多处理几份作业；0 表示不限。 */
  homeworkLimit: Schema.natural().default(0),
  /** 工具整体超时（分钟）；超过后框架会中断本次调用。 */
  toolTimeoutMinutes: Schema.natural().default(45),
})

/** The `url` argument accepts every task-URL shape the platform emits. */
const TARGET_SCHEMA = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description:
        '头歌作业链接，例如 https://www.educoder.net/tasks/AGUY4O7A/4197532/op7hwrazem5u。'
        + '也接受 /tasks/<homeworkId>/<gameIdentifier>、纯 homework_common_id，或单个关卡标识。',
    },
    mode: {
      type: 'string',
      enum: ['solve', 'survey'],
      description: 'solve（默认）真正做完；survey 只巡检并报告哪些关卡还没过，不提交任何东西。',
    },
    challengeLimit: {
      type: 'number',
      description: '本次最多处理几个未通过的关卡；0 或省略表示不限。想分批做时用它。',
    },
  },
  required: ['url'],
  additionalProperties: false,
}

/** Shared: turn a thrown error into one actionable line for the caller. */
function describeFailure(error) {
  if (error instanceof SessionExpiredError) {
    return `${error.message}。会话缓存已失效，请确认插件配置里的 login / password 仍然正确。`
  }
  if (error instanceof EducoderError) return error.message
  return `未预期的错误：${error?.message ?? String(error)}`
}

/**
 * Register the Educoder tools.
 * @param {any} ctx - plugin context.
 * @param {any} config - validated configuration.
 */
export function apply(ctx, config) {
  const settings = {
    login: config.login ?? '',
    password: config.password ?? '',
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    sessionFile: config.sessionFile || DEFAULT_SESSION_FILE,
    provider: config.provider ?? '',
    model: config.model ?? '',
    maxAttempts: config.maxAttempts ?? 3,
    maxTokens: config.maxTokens ?? 8000,
    gradeTimeoutSec: config.gradeTimeoutSec ?? 180,
    pollIntervalSec: config.pollIntervalSec ?? 3,
    requestTimeoutSec: config.requestTimeoutSec ?? 30,
    challengeLimit: config.challengeLimit ?? 0,
    homeworkLimit: config.homeworkLimit ?? 0,
    toolTimeoutMinutes: config.toolTimeoutMinutes ?? 45,
  }
  const store = new SessionStore(settings.sessionFile)
  const timeoutMs = Math.max(60_000, settings.toolTimeoutMinutes * 60_000)

  // Progress goes to the Host log; the model gets the structured report at the
  // end of the call.
  const makeLog = label => message => {
    ctx.logger?.info?.(`[educoder] ${label} ${message}`)
    console.log(`[dsh-plugin-educoder] ${label} ${message}`)
  }

  ctx.effect(() => ctx.tools.register({
    name: 'educoder_homework',
    description: [
      '一键完成头歌（EduCoder, educoder.net）作业：给一个作业链接，插件会登录你的账号、遍历该作业的全部关卡、',
      '自动提交平台自带的选择题标准答案，并对每道代码题调用模型生成完整答案文件、上传、触发一次评测，',
      '再把评测报错交回模型修正，直到通过或用完重试次数。全程走平台 JSON API，不依赖浏览器。',
      'mode=survey 时只巡检并报告哪些关卡还没过，不提交任何东西。',
      '注意：solve 会真实提交并消耗评测次数。',
    ].join(''),
    parameters: TARGET_SCHEMA,
    output: {
      // An annotation-only schema is the registry's unconstrained-JSON form.
      // The report is a rich object, and `render` owns what the user sees.
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const input = args ?? {}
      const mode = input.mode === 'survey' ? 'survey' : 'solve'
      const log = makeLog(`[${mode}]`)
      const target = parseTaskUrl(input.url)
      const effective = input.challengeLimit === undefined || input.challengeLimit === null
        ? settings
        : { ...settings, challengeLimit: Math.max(0, Number(input.challengeLimit) || 0) }
      if (target.gameId === null && target.homeworkId === null) {
        throw new Error(`educoder_homework: 无法从 ${input.url} 解析出头歌任务标识`)
      }
      log(`目标 game=${target.gameId ?? '-'} homework=${target.homeworkId ?? '-'}`)
      try {
        const client = await connect({ config: effective, store, log })
        return await runHomework({
          ctx,
          client,
          target,
          config: effective,
          store,
          mode,
          log,
          signal: exec.signal,
        })
      } catch (error) {
        throw new Error(`educoder_homework: ${describeFailure(error)}`)
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'educoder_account',
    description: [
      '检查头歌（EduCoder）账号连接状态，并列出该账号的课程。当 educoder_homework 报登录/权限错误时用它定位问题。',
      '注意：头歌的课程列表接口不需要登录也会返回数据，所以它不能证明凭据有效。',
      '传入 url（作业链接）时本工具会真的读一次该关卡，那才是会话有效的证据。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '可选：一个头歌作业/关卡链接。给了就真读一次该关卡来验证会话是否有效。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => {
        if (value.ok !== true) return [{ type: 'text', text: `头歌账号连接失败：${value.error}` }]
        const lines = [`头歌账号 ${value.account} 已登录（会话缓存：${value.sessionFile}）`]
        lines.push(value.sessionVerified
          ? `会话已验证：成功读到关卡「${value.probe.title}」，cookie 有效。`
          : '会话未验证：课程列表接口无需登录也会返回数据，不能作为凭据有效的证据。传入 url 才能真正验证。')
        lines.push(`可见课程 ${value.courses.length} 门：`)
        for (const course of value.courses) {
          lines.push(`- ${course.identifier} ${course.name}（${course.tasks ?? '?'} 个实训）`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const log = makeLog('[account]')
      const url = typeof args?.url === 'string' ? args.url.trim() : ''
      try {
        const client = await connect({ config: settings, store, log })
        const courses = await client.courses()
        let probe = null
        if (url !== '') {
          const resolved = await resolveTarget(client, parseTaskUrl(url))
          const detail = await client.taskDetail(resolved.gameId, resolved.homeworkId)
          probe = {
            gameId: resolved.gameId,
            homeworkId: resolved.homeworkId,
            title: detail?.challenge?.subject ?? detail?.game?.name ?? resolved.gameId,
            status: detail?.game?.status ?? null,
          }
        }
        return {
          ok: true,
          account: client.zzud,
          sessionFile: settings.sessionFile,
          sessionVerified: probe !== null,
          probe,
          courses: courses.map(course => ({
            identifier: course?.identifier ?? '',
            name: course?.name ?? '',
            tasks: course?.tasks_count ?? null,
            active: course?.is_end !== true,
          })),
        }
      } catch (error) {
        return {
          ok: false,
          account: '',
          sessionFile: settings.sessionFile,
          sessionVerified: false,
          probe: null,
          courses: [],
          error: describeFailure(error),
        }
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'educoder_sweep',
    description: [
      '扫描整个头歌账号（或指定一门课），找出所有还有未通过关卡的作业，并可选地全部做完。',
      '性价比最高的入口：',
      'scan 模式只读不提交、且**完全不消耗模型 token**（作业列表自带每份作业的通过数，已完成的作业直接跳过，不读任何关卡）；',
      'solve 模式下，选择题靠平台在提交响应里回吐的答案键零 token 通过，只有代码题才会调用模型。',
      '想低成本知道"还有哪些没做"就用 scan；想一次全做完就用 solve。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['scan', 'solve'],
          description: 'scan（默认）只扫描并报告，不提交任何东西；solve 真正做完发现的未通过关卡。',
        },
        course: {
          type: 'string',
          description: '可选：只处理这一门课，可用课程标识符（如 AGUY4O7A）、数字 id 或课名片段。省略则扫描全部课程。',
        },
        homeworkLimit: {
          type: 'number',
          description: '本次最多处理几份作业；0 或省略表示不限。想分批做时用它。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderSweep(value) }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const input = args ?? {}
      const mode = input.mode === 'solve' ? 'solve' : 'scan'
      const log = makeLog(`[sweep:${mode}]`)
      const effective = input.homeworkLimit === undefined || input.homeworkLimit === null
        ? settings
        : { ...settings, homeworkLimit: Math.max(0, Number(input.homeworkLimit) || 0) }
      try {
        const client = await connect({ config: effective, store, log })
        return await sweep({
          ctx,
          client,
          config: effective,
          store,
          mode,
          course: typeof input.course === 'string' ? input.course.trim() : '',
          log,
          signal: exec.signal,
        })
      } catch (error) {
        throw new Error(`educoder_sweep: ${describeFailure(error)}`)
      }
    },
  }))
}
