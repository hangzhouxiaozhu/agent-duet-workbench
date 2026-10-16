import {
  proposePrompt,
  discussPrompt,
  finalizePrompt,
  executePrompt,
  reviewPrompt,
  extractVerdict,
  judgeConsensus,
  buildDigest,
  guidanceBlock,
  interruptAdjustmentBlock,
  AGENT_META,
} from './prompts.mjs';
import * as store from './session.mjs';
import * as gitguard from './gitguard.mjs';

/**
 * 编排状态机。
 *
 *   propose  ──►  discuss（循环，直到双方判停或达到轮数上限）
 *                     │
 *                     ▼
 *                 finalize  ──►  execute  ──►  review
 *                                  ▲            │
 *                                  └── 打回 ────┘
 *
 * 关键约束：
 *   - 讨论阶段两个 agent 并行且只读（codex 走 read-only 沙箱，claude 摘掉写文件工具）
 *   - 实现阶段只有一个 agent 有写权限，另一个只验收，杜绝互相覆盖
 *   - 每次动手之前先打 git 检查点
 */

const ACTIVE = new Map();

const PHASE_LABEL = {
  propose: '独立作答',
  discuss: '交叉讨论',
  finalize: '方案定稿',
  execute: '动手实现',
  review: '交叉验收',
  // 注意：这里只放**阶段**。completed / failed / interrupted 属于「会话状态」，
  // 由前端 STATUS_TEXT 统一负责显示 —— 两边各写一份文案，
  // 正是当初产生英文弹窗那个 bug 的根源（改了这张表、漏了那张表）。
};

export function getRuntime(sessionId) {
  return ACTIVE.get(sessionId) || null;
}

/** 当前正在跑的会话 id。并发跑会显著加快撞上订阅限流，UI 据此提示。 */
export function activeSessionIds() {
  return [...ACTIVE.keys()];
}

export function stopSession(sessionId) {
  const rt = ACTIVE.get(sessionId);
  if (!rt) return { ok: false, error: '会话未在运行' };
  rt.stopped = true;
  rt.controller.abort();
  return { ok: true };
}

/**
 * 用户插一句话。
 *
 *   immediate=false（默认）→ 排队，**下一个发言机会**交给双方；
 *   immediate=true        → 打断当前正在跑的那一轮，马上带上这句话重跑。
 *
 * 会话没在跑时不在这里处理（服务端会把话落盘记下，下次继续时交给双方）。
 */
export function injectGuidance(sessionId, text, { immediate = false } = {}) {
  const rt = ACTIVE.get(sessionId);
  if (!rt) return { ok: false, error: '会话未在运行' };
  const clean = String(text || '').trim();
  if (!clean) return { ok: false, error: '内容为空' };
  rt.guidance.push(clean);
  // 立刻回执，让界面能显示"已排队"，而不是等下一轮才有动静
  let interrupted = 0;
  if (immediate && rt.requestInterrupt) interrupted = rt.requestInterrupt();
  return {
    ok: true,
    pending: rt.guidance.length,
    phase: rt.phase || null,
    immediate: Boolean(immediate),
    // 打断了几轮。0 表示当时没有在跑的轮次，这句会在下一个发言机会生效。
    interrupted,
  };
}

/** 严格布尔：只认真正的布尔和明确的字符串，避免 "false" 这种 truthy 字符串被当成 true。 */
function toBool(v, dflt) {
  if (v === undefined || v === null) return dflt;
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return dflt;
}

/** 数字允许字符串形式（HTTP body 里很常见），非法就退回默认值。 */
function toInt(v, dflt) {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

export async function runSession({
  sessionId, requirement, projectDir, settings, adapters, onEvent,
  cycle = 1,        // 这是这个会话的第几次需求（用户每追加一次需求 +1）
  priorContext = null, // 上一次的需求与已交付方案，追加需求时作为背景
  resumeIds = null,    // 上次的 CLI 会话 id，让两个 agent 记得之前谈过什么
}) {
  const meta = store.readMeta(sessionId);
  if (!meta) throw new Error(`会话不存在: ${sessionId}`);

  const emit = (event) => {
    // cycle 统一注入：前端靠它把「第 2 次需求 · 第 1 轮」和第一次的同名轮次区分开
    const full = { sessionId, cycle, ...event };
    store.appendEvent(sessionId, full);
    onEvent?.(full);
  };

  const rt = {
    controller: new AbortController(),
    stopped: false,
    // 待传达。会话停下时用户插的话会留在 meta.pendingGuidance 里，
    // 所以这一轮一开始就带着它 —— 收下的话不会因为当时没在跑就消失。
    guidance: [...(meta.pendingGuidance || [])],
    standing: [],   // 已传达，之后每一轮继续作为硬性要求
    phase: null,
  };
  ACTIVE.set(sessionId, rt);
  // 记下拥有这个会话的进程。别的实例启动时靠它判断「这是不是孤儿」——
  // 只看「本进程内存里没有」会把另一个实例正在跑的会话误判成孤儿。
  store.patchMeta(sessionId, { pid: process.pid });

  const turns = [];       // 讨论记录，用于生成 transcript
  const verdicts = {};    // 最近一轮双方的 verdict
  // 各自的 CLI session id。追加需求时从 meta 带过来，于是两个 agent
  // 记得之前谈过什么，而不是从零重新认识这个项目。
  const agentSession = { ...(resumeIds || {}) };
  // CLI 实际上报的模型（Claude 会给，Codex 不给）
  const agentModel = {};
  // 只有每个 agent 在本次追加需求后的**第一轮**才去续聊；
  // 之后仍然「每轮都给完整上下文」，保持原来可预测的行为。
  const pendingResume = new Set(Object.keys(resumeIds || {}));

  const maxRounds = clamp(toInt(settings.maxRounds, 4), 1, 8);
  const minRounds = clamp(toInt(settings.minRounds, 2), 1, maxRounds);
  /* 分工模式：两个 agent **依次**各写自己那部分。
   * 串行而不是并行 —— 同时写同一批文件会互相覆盖，没法收拾。
   * leadAgent 在分工模式下仍作为"讨论主导方"（裁决权、定稿），默认 claude。 */
  const split = settings.leadAgent === 'split';
  // 「由讨论决定」：谁落地、要不要分工，交给两个 agent 在讨论里定
  const autoRoles = settings.leadAgent === 'auto';
  const leadAgent = settings.leadAgent === 'codex' ? 'codex' : 'claude';
  const peerAgent = leadAgent === 'claude' ? 'codex' : 'claude';
  // 不能写 `settings.allowWrite !== false`：字符串 "false" 是 truthy，
  // 于是专门用来「只讨论不动文件」的安全开关会被静默绕过，
  // 而且落盘的 settings 还会记成 true（审计记录失真）。
  const allowWrite = toBool(settings.allowWrite, true);

  const setPhase = (phase, round, extra = {}) => {
    rt.phase = phase;
    store.patchMeta(sessionId, { phase, round, status: 'running' });
    emit({ type: 'phase', phase, round, label: PHASE_LABEL[phase] || phase, ...extra });
  };

  /**
   * 取走待传达的用户插话。**只有真的取用才清空。**
   *
   * 这里曾经是个静默丢数据的 bug：旧代码在每轮讨论结束后无条件
   * `rt.guidance.length = 0`，但插话只在**该轮开始前**被读进提示词。
   * 于是「在某轮进行中插入」的话 —— 也就是最常见的情形，用户看到它们在跑才想插话 ——
   * 既进不了这一轮，又会被这行清掉，彻底消失；若这一轮恰好收敛，更是永远送不到。
   * 现在改成：取用时才清空，并且每个阶段都会取。
   */
  const takeGuidance = (phase) => {
    if (!rt.guidance.length) return null;
    const text = rt.guidance.join('；');
    rt.guidance.length = 0;
    // 记成长期要求：用户说了一次「别用外部 CDN」，后面每一轮都该继续遵守
    rt.standing.push(text);
    // 真的取用了才把落盘的那份清掉：中途崩了也不会把用户的话弄丢
    store.patchMeta(sessionId, { pendingGuidance: [] });
    emit({ type: 'guidance.delivered', phase, text });
    return text;
  };

  /* 每一轮自己的中断开关。
   *
   * 之前所有轮次共用会话级的 AbortController，于是「停掉这一轮」和「停掉整个会话」
   * 是同一件事 —— 想立即插话就只能把整个会话杀掉。拆开之后，用户点「立即执行」
   * 可以只打断当前这一轮，会话继续往下走。 */
  const liveTurns = new Set();

  const beginTurn = ({ interruptible = true } = {}) => {
    const controller = new AbortController();
    const onSessionAbort = () => controller.abort();
    rt.controller.signal.addEventListener('abort', onSessionAbort, { once: true });
    // 不可打断的轮次不进登记表，于是「立即执行」不会再把它掀掉
    if (interruptible) liveTurns.add(controller);
    return {
      signal: controller.signal,
      get interruptedByUser() { return Boolean(controller.interruptedByUser); },
      get carriedGuidance() { return controller.carriedGuidance || null; },
      release: () => {
        liveTurns.delete(controller);
        rt.controller.signal.removeEventListener('abort', onSessionAbort);
      },
    };
  };

  /**
   * 「立即执行」：打断当前所有在跑的轮次，并把这句要求当场取走。
   *
   * 当场取走（而不是留在缓冲里）是为了让并发的两轮拿到**同一份**要求：
   * 如果留给它们各自去取，先重跑的那个会把话取走，另一个 agent 就会白跑一轮
   * 不带纠正的答案。取走时会记进 standing，所以它对后续轮次依然长期有效。
   */
  rt.requestInterrupt = () => {
    const targets = [...liveTurns];
    // 没有正在跑的轮次：留在缓冲里，下一个发言机会自然会带上它（等价于排队）
    if (!targets.length) return 0;
    const text = takeGuidance(rt.phase || 'interrupt');
    for (const controller of targets) {
      controller.interruptedByUser = true;
      if (text) controller.carriedGuidance = text;
      controller.abort();
    }
    return targets.length;
  };

  const agentName = (a) => AGENT_META[a]?.name || a;

  /**
   * 单次尝试：跑一个 agent 的一轮。始终用完整上下文，行为可预测。
   *
   * 调度（要不要重跑）在下面的 runTurn 里，这里只管跑完这一轮并如实回报。
   */
  async function attemptTurn(agent, { phase, round, prompt, write, resumeId, ignoreInterrupt = false }) {
    const adapter = adapters[agent];
    emit({ type: 'turn.start', agent, phase, round });
    const started = Date.now();
    const turn = beginTurn({ interruptible: !ignoreInterrupt });

    let draft = '';
    // codex 不发流式片段，只在消息完成时给全文；两条都留着，打断时才不至于两手空空
    let lastMessage = '';
    let result;
    try {
      result = await adapter.run({
        prompt,
        cwd: projectDir,
        resumeId,
        allowWrite: Boolean(write),
        // 讨论阶段一律只读（安全设计，不变）；实现阶段按用户授权的级别给。
        // 'workspace' = 可写项目 + 可联网装依赖；'full' = 完全不限。
        sandbox: !write
          ? 'read-only'
          : (settings.sandbox === 'full' ? 'danger-full-access' : 'workspace-write'),
        timeoutMs: settings.turnTimeoutMs,
        // 用这一轮自己的开关，而不是会话级那个：
        // 否则「打断当前这一轮」就等于「停掉整个会话」
        signal: turn.signal,
        onEvent: (ev) => {
          if (ev.type === 'delta') {
            draft += ev.text;
          }
          if (ev.type === 'message' && ev.text) {
            lastMessage = ev.text;
          }
          if (ev.type === 'session' && ev.sessionId) {
            agentSession[agent] = ev.sessionId;
          }
          if (ev.type === 'session' && ev.model) {
            const reported = String(ev.model);
            if (agentModel[agent] !== reported) {
              agentModel[agent] = reported;
              // 立刻落盘，而不是等本轮收尾再写：会话被中止/中断时收尾那段根本不会执行，
              // 那样这个值就只剩事件流里有（界面靠回放还能显示，但别的地方读 meta 就空了）
              try { store.patchMeta(sessionId, { agentModels: { ...agentModel } }); } catch { /* meta 写不进去不该拖垮这一轮 */ }
            }
          }
          // 统一补上 agent/round 维度后转发
          emit({ ...ev, agent, phase, round });
        },
      });
    } finally {
      turn.release();
    }

    const durationMs = Date.now() - started;
    emit({
      type: 'turn.end',
      agent,
      phase,
      round,
      ok: result.ok,
      durationMs,
      usage: result.usage,
      costUsd: result.costUsd,
      error: result.ok ? undefined : result.error,
      aborted: result.aborted,
    });

    return {
      result,
      durationMs,
      interruptedByUser: turn.interruptedByUser,
      carriedGuidance: turn.carriedGuidance,
      // 被打断前已经产出的内容：交给下一轮接着写，而不是丢掉
      partialText: draft || lastMessage,
    };
  }

  /**
   * 跑一个 agent 的一轮，并在两种情况下重跑：
   *   1. 用户点了「立即执行」→ 这一轮是我们主动打断的，带上新要求重跑；
   *   2. 续聊的 CLI 会话失效 → 丢掉历史重跑一次。
   */
  async function runTurn(agent, { phase, round, prompt, write, noResume = false }) {
    const wantResume = !noResume && pendingResume.has(agent);
    let resumeId = wantResume ? (agentSession[agent] || null) : null;
    pendingResume.delete(agent);

    const basePrompt = prompt;
    let attemptPrompt = prompt;
    const adjustments = [];   // 每次被打断累积一段「接着改」的说明
    let resumeFallbackUsed = false;
    let interruptReruns = 0;

    for (;;) {
      /* 「立即执行」连点很多次也不会把会话跑死：
       * 打断重跑到 3 次之后，这一轮变成不可打断，让它安安静静跑完。
       * （旧行为是第 3 次打断后直接把这一轮判成失败 —— 在第 1 轮就会把整个会话带崩，
       *   而且报的是「agent 失败」，完全看不出真正原因是用手点出来的。） */
      const { result, durationMs, interruptedByUser, carriedGuidance, partialText } =
        await attemptTurn(agent, {
          phase, round, prompt: attemptPrompt, write, resumeId,
          ignoreInterrupt: interruptReruns >= 3,
        });

      if (result.sessionId) agentSession[agent] = result.sessionId;

      /* 用户点了「立即执行」：这一轮是我们主动打断的（不是会话被停），
       * 目的就是让他不用等 —— 立刻把他的话拼进去，把同一轮重跑一次。 */
      if (result.aborted && interruptedByUser && !rt.stopped) {
        interruptReruns += 1;
        emit({ type: 'log', text: `已中断 ${agentName(agent)} 当前这一轮，接着它已有的上下文按新要求调整` });
        adjustments.push(interruptAdjustmentBlock({ guidance: carriedGuidance, partialText }));
        const adjustment = adjustments.join(String.fromCharCode(10));
        /* 保留 resumeId：接着它自己的 CLI 会话说，才叫「在原有上下文基础上调整」。
         * 续得上就只发调整说明（原任务已经在它的会话里）；续不上才把原任务一起带上，
         * 保证它仍然知道自己在做什么。 */
        attemptPrompt = resumeId ? adjustment : basePrompt + adjustment;
        continue;
      }

      /* 续跑时我们让 CLI「接着上次的会话说」。那个 id 存在磁盘上，可能已经被清理
       * 或过期 —— 那时这一轮会直接失败。用户刚提的新需求不该因为一段可能已不存在的
       * 历史而丢掉：丢掉 resume 重跑一次，代价只是这一轮没有记忆。 */
      if (!result.ok && resumeId && !result.aborted && !result.rateLimited && !result.authError && !resumeFallbackUsed) {
        resumeFallbackUsed = true;
        emit({
          type: 'log',
          text: `${agentName(agent)} 的续聊会话不可用（${String(result.error || '未知原因').slice(0, 120)}），改为不带历史重跑这一轮`,
        });
        delete agentSession[agent];
        resumeId = null;
        // 续不上也要把调整说明带上：不能因为 resume 失效就把用户的要求丢了
        if (adjustments.length) attemptPrompt = basePrompt + adjustments.join(String.fromCharCode(10));
        continue;
      }

      return { ...result, durationMs };
    }
  }

  function contextBlock(phase, round, agent, peerText) {
    const selfLast = [...turns].reverse().find((t) => t.agent === agent)?.text || null;
    return { selfLast, peerLast: peerText };
  }

  try {
    /* ---------------- 基线检查点 ---------------- */
    const base = gitguard.checkpoint(projectDir, `会话 ${sessionId} 开始前的工作区快照`);
    if (!base.ok) {
      emit({ type: 'warning', text: `无法建立 git 检查点：${base.error}（回滚能力不可用）` });
    } else {
      store.patchMeta(sessionId, { baseSha: base.sha });
      emit({ type: 'checkpoint', sha: base.sha, label: '会话基线', created: base.created });
    }
    const baseSha = base.ok ? base.sha : null;

    store.patchMeta(sessionId, {
      status: 'running',
      phase: 'propose',
      cycle,
      // 追加需求意味着「上一轮交付的东西要改」：把用户验收的状态收回，
      // 免得界面上还挂着「已完成」。
      awaitingUser: false,
      confirmedAt: null,
      // 首次启动才开始计时；追加需求不该把开始时间改成今天
      ...(meta.startedAt ? {} : { startedAt: new Date().toISOString() }),
      // 基线保持第一次的那个：整个会话的「回滚到基线」始终指向最初的状态
      baseSha: meta.baseSha || baseSha,
      settings: { ...settings, maxRounds, minRounds, leadAgent, allowWrite, split, autoRoles },
    });

    emit({ type: 'session.start', requirement, projectDir, leadAgent, peerAgent, split });

    /* ---------------- 第 1 轮：独立作答 ---------------- */
    setPhase('propose', 1);
    const proposeGuidance = takeGuidance('propose');
    const proposeResults = await Promise.all(
      ['claude', 'codex'].map(async (agent) => {
        const prompt = proposePrompt({ agent, requirement, projectDir, priorContext })
          + guidanceBlock(proposeGuidance);
        const res = await runTurn(agent, { phase: 'propose', round: 1, prompt, write: false });
        return { agent, res };
      }),
    );

    for (const { agent, res } of proposeResults) {
      if (res.ok) turns.push({ agent, round: 1, text: res.text, phase: 'propose' });
    }

    if (rt.stopped) throw new AbortError();

    // 有一方在第 1 轮就挂了（多半是没登录/超时），后面的讨论不可能成立。
    // 立刻停下，别把剩下的额度全烧在一个注定失败的会话上。
    const failedFirst = proposeResults.filter((r) => !r.res.ok);
    if (failedFirst.length) {
      const detail = failedFirst
        .map((f) => `${agentName(f.agent)}：${f.res.error || '未知错误'}`)
        .join('；');
      throw new Error(`第 1 轮有 agent 失败，已提前中止以免浪费额度 —— ${detail}`);
    }

    /* ---------------- 讨论循环 ---------------- */
    let round = 1;
    let converged = false;

    /* 议题账本：跨轮持续存在的未决项。
     *
     * 之前每轮的「未决项」是把两个 agent 当轮列的文本求并集 ——
     * 上一轮提的问题，这一轮谁都不提就消失了，新问题可以无限加。
     * 实测过：一致项 12→22，未决项也从 11 涨到 16，
     * 那不是收敛，是**在累积问题**。
     *
     * 现在每条议题有稳定编号，agent 必须按编号表态（结案 / 仍阻塞），
     * 账本由系统维护，跨轮只减不增（新增有硬限额）。
     */
    const ledger = [];        // [{ id, text, raisedRound }]
    let nextIssueId = 1;
    let prevOpen = null;
    let stallRounds = 0;
    let pressure = 'normal';  // 'normal' | 'tight'
    let stalled = false;
    const decisions_ = [];    // 主导方在讨论中作出的裁决，会被写进定稿
    const normText = (t) => String(t).replace(/\s+/g, '').slice(0, 60);

    // 轮数到了上限，但如果用户还有话没传达，就再给一轮 —— 不能把他的话丢掉。
    const hardCap = maxRounds + 2;
    while (round < maxRounds || (rt.guidance.length > 0 && round < hardCap)) {
      round += 1;
      setPhase('discuss', round);

      if (round > maxRounds) {
        emit({ type: 'log', text: `用户有补充要求，追加第 ${round} 轮讨论` });
      }

      const roundGuidance = takeGuidance('discuss');

      const lastOf = (a) => [...turns].reverse().find((t) => t.agent === a)?.text || null;
      const claudeLast = lastOf('claude');
      const codexLast = lastOf('codex');

      const openIssues = ledger.map((i) => ({ id: i.id, text: i.text, raisedRound: i.raisedRound }));

      const results = await Promise.all(
        ['claude', 'codex'].map(async (agent) => {
          const peer = agent === 'claude' ? 'codex' : 'claude';
          const prompt = discussPrompt({
            agent,
            peer,
            requirement,
            projectDir,
            round,
            selfLast: agent === 'claude' ? claudeLast : codexLast,
            peerLast: agent === 'claude' ? codexLast : claudeLast,
            openIssues,
            pressure,
            standingRequirements: rt.standing,
            isLead: agent === leadAgent,
            autoRoles,
          }) + guidanceBlock(roundGuidance);
          const res = await runTurn(agent, { phase: 'discuss', round, prompt, write: false });
          return { agent, res };
        }),
      );

      if (rt.stopped) throw new AbortError();

      // 额度用尽不会在几秒内恢复：继续跑只是单方面烧另一方的额度，
      // 而且对方看不到有效输入，只会回答「没有可评议的方案」—— 纯浪费。
      const limited = results.find((r) => r.res?.rateLimited);
      if (limited) {
        throw new Error(
          `${agentName(limited.agent)} 额度已用尽，讨论提前中止（继续只会白烧另一方的额度）。`
          + `等额度恢复后重跑。原始信息：${String(limited.res.error).slice(0, 200)}`,
        );
      }

      for (const { agent, res } of results) {
        if (!res.ok) {
          // 本轮失败的 agent 必须清掉旧 verdict，否则上一轮的结论会被当成本轮结论
          delete verdicts[agent];
          continue;
        }
        turns.push({ agent, round, text: res.text, phase: 'discuss' });
        verdicts[agent] = extractVerdict(res.text);
      }

      /* --- 更新账本 ---
       *
       * 结案有两条路，这是「从共识到决策完备」的关键：
       *   1. 双方都标 resolved —— 谈妥了；
       *   2. **主导方裁决** —— 谈不拢，但实现由它负责，所以它有权拍板。
       *
       * 只有第 1 条的话，共识达不成就永远结不了案（实测过：未决项 11→16，越谈越多）。
       * 加上第 2 条，账本一定能清空 —— 而账本清空就意味着方案可以开工了。
       *
       * 公平性：搭档用 blocking 明确反对时，裁决可以再留一轮；
       * 连续两轮坚持裁决就生效。之后还有验收环节兜底。
       */
      const resolvedBy = (a) => new Set(verdicts[a]?.resolved || []);
      const ra = resolvedBy('claude');
      const rb = resolvedBy('codex');
      const peerBlocking = new Set(verdicts[peerAgent]?.blockingIds || []);
      const decisions = new Map(
        (verdicts[leadAgent]?.decided || []).map((d) => [d.id, d]),
      );
      const closed = [];
      const decidedNow = [];
      for (let i = ledger.length - 1; i >= 0; i -= 1) {
        const it = ledger[i];
        if (ra.has(it.id) && rb.has(it.id)) {
          closed.push(it.id);
          ledger.splice(i, 1);
          continue;
        }
        const d = decisions.get(it.id);
        if (!d) continue;
        it.decidedCount = (it.decidedCount || 0) + 1;
        // 搭档没有明确反对，或者主导方已经坚持两轮 → 裁决生效
        if (!peerBlocking.has(it.id) || it.decidedCount >= 2) {
          it.decision = d;
          decisions_.push({ id: it.id, text: it.text, how: d.how, why: d.why });
          decidedNow.push(it.id);
          closed.push(it.id);
          ledger.splice(i, 1);
        }
      }
      const forced = decisions_.length > 0;
      // 新增议题：收紧轮一律忽略；正常轮最多 2 条，且按文本去重
      let added = 0;
      if (pressure !== 'tight') {
        outer:
        for (const a of ['claude', 'codex']) {
          for (const it of verdicts[a]?.newIssues || []) {
            if (added >= 2) break outer;
            if (ledger.some((L) => normText(L.text) === normText(it.text))) continue;
            ledger.push({ id: nextIssueId++, text: it.text, raisedRound: round });
            added += 1;
          }
        }
      }

      const judge = judgeConsensus(verdicts);
      const openNow = ledger.length;
      /* 决策完备 = 账本清空，**且双方这一轮都真的给出了结论**。
       *
       * 后半句不能省：某一方本轮失败（没登录、超时、额度用尽）时 verdict 会被删掉，
       * 此时"零条议题"只代表没人提出问题，不代表问题解决了。
       * 实际踩过：Claude 额度用尽返回一句提示，codex 看到垃圾只能回答
       * 「没有可评议的方案」，于是账本为空 → 被误判成"完备"直接收工。
       */
      const bothVerdicts = Boolean(verdicts.claude && verdicts.codex);
      const complete = openNow === 0 && bothVerdicts;
      emit({
        type: 'consensus',
        round,
        ...judge,
        openCount: openNow,
        closed: closed.length,
        decided: decidedNow.length,
        complete,
        added,
        pressure,
        decisions: decisions_.map((d) => ({ id: d.id, how: d.how, why: d.why })),
        ledger: ledger.map((i) => ({ id: i.id, text: i.text, raisedRound: i.raisedRound })),
      });

      /* --- 进度与停滞 --- */
      if (prevOpen !== null) {
        if (openNow >= prevOpen) stallRounds += 1;
        else stallRounds = 0;
      }
      prevOpen = openNow;

      if (stallRounds >= 2) {
        stalled = true;
        emit({
          type: 'log',
          text: `积压议题连续两轮没有减少（仍有 ${openNow} 条），停止讨论，转由主导方逐条裁决`,
        });
        break;
      }
      pressure = stallRounds >= 1 ? 'tight' : 'normal';

      /* 停止条件有两条，任一条成立就能开工：
       *   1. 双方都满意（judge.converged）—— 理想情况；
       *   2. **账本清空** —— 每条议题都有结论（谈妥的，或主导方裁决的）。
       * 加上第 2 条才可能真的停得下来：共识是可望不可即的，完备是可以达到的。 */
      if ((judge.converged || complete) && round >= minRounds) {
        if (rt.guidance.length && round < hardCap) {
          emit({ type: 'log', text: '已经有结论了，但用户有补充要求，再讨论一轮' });
          continue;
        }
        converged = true;
        emit({
          type: 'log',
          text: judge.converged
            ? `第 ${round} 轮达成一致，停止讨论`
            : `第 ${round} 轮议题账本已清空（${decisions_.length} 条由主导方裁决），停止讨论`,
        });
        break;
      }
    }

    if (!converged) {
      emit({ type: 'log', text: `达到轮数上限（${round} 轮），按当前状态定稿` });
    }

    /* ---------------- 落地方式：由讨论决定 ----------------
     *
     * 谁实现、要不要分工，本来不该由用户在开会前拍板 ——
     * 任务是什么形状、能不能切开，只有讨论完才知道。所以问的是他们俩。
     *
     * 裁定规则：两边都主张分工 → 分工；主导方主张分工 → 分工；
     * 主导方主张单干 → 听它的（它同时是裁决方）；都说不清 → 保守单干。
     */
    let execMode = split ? 'split' : 'single';
    let execImplementer = leadAgent;
    if (autoRoles) {
      const leadView = verdicts[leadAgent]?.execution;
      const peerView = verdicts[peerAgent]?.execution;
      const reason = (leadView?.reason || peerView?.reason || '').slice(0, 100);
      if (leadView?.mode === 'split' || peerView?.mode === 'split') {
        // 只要**主导方**主张分工就分工；它主张单干而搭档主张分工时不强推
        if (leadView?.mode === 'split') {
          execMode = 'split';
        } else {
          execMode = 'single';
          execImplementer = leadView?.implementer || leadAgent;
        }
      } else if (leadView?.mode === 'single' || peerView?.mode === 'single') {
        execMode = 'single';
        execImplementer = leadView?.implementer || peerView?.implementer || leadAgent;
      } else {
        execMode = 'single';
        emit({ type: 'warning', text: '双方都没有给出落地方式，按保守策略由主导方一人实现' });
      }
      emit({
        type: 'log',
        text: execMode === 'split'
          ? `讨论决定：分工实现，两人各写一部分${reason ? `（${reason}）` : ''}`
          : `讨论决定：由 ${agentName(execImplementer)} 实现，${agentName(execImplementer === 'claude' ? 'codex' : 'claude')} 验收${reason ? `（${reason}）` : ''}`,
      });
    }

    // 谁落地谁定稿 —— 方案要交到动手的人手里
    const finalizer = execMode === 'split' ? leadAgent : execImplementer;
    const reviewerOf = (w) => (w === 'claude' ? 'codex' : 'claude');

    /* ---------------- 定稿 ---------------- */
    setPhase('finalize', round);
    const digest = buildDigest(turns);
    const finalizeGuidance = takeGuidance('finalize');
    const finalizeRes = await runTurn(finalizer, {
      phase: 'finalize',
      round,
      prompt: finalizePrompt({
        agent: finalizer,
        requirement,
        projectDir,
        priorContext,
        transcriptDigest: digest,
        // 把还没结案的议题交给定稿人 —— 他必须逐条裁决，方案里不许留「待定」
        openIssues: ledger.map((i) => ({ id: i.id, text: i.text, raisedRound: i.raisedRound })),
        // 讨论中已经作出的裁决，定稿必须照办
        decisions: decisions_,
        stalled,
        split: execMode === 'split',
      }) + guidanceBlock(finalizeGuidance),
      write: false,
    });

    let plan = finalizeRes.ok ? finalizeRes.text : '';
    if (!plan) {
      // 定稿失败就用最后一轮的内容兜底，不能让整个会话白跑
      plan = turns.filter((t) => t.phase === 'discuss').slice(-2).map((t) => t.text).join('\n\n---\n\n');
      emit({ type: 'warning', text: '定稿失败，已使用最后一轮讨论内容作为方案' });
    }
    store.savePlan(sessionId, plan);
    emit({ type: 'plan', markdown: plan });

    if (rt.stopped) throw new AbortError();

    /* ---------------- 实现 + 验收循环 ----------------
     *
     * 单写者模式（默认）：只有主导方有写权限，搭档只读验收。
     * 分工模式（leadAgent='split'）：两个 agent **依次**各写自己那部分。
     *
     * 为什么串行：两个 agent 同时改同一批文件会互相覆盖，而且没有可靠的
     * 冲突解决手段（没有 worktree 隔离）。依次动手就没有这个问题，
     * 代价是慢一些 —— 换来的是"两边都能写代码"。
     */
    let fixRound = 0;
    let reviewerNote = null;
    const maxFixRounds = clamp(toInt(settings.maxFixRounds, 2), 0, 4);
    let outcome = 'done';
    const isSplit = execMode === 'split';
    const writerLabel = (w) => (isSplit ? `${agentName(w)} 负责的部分` : '实现');

    while (allowWrite) {
      const writers = isSplit ? [leadAgent, peerAgent] : [execImplementer];
      const reports = {};

      for (let i = 0; i < writers.length; i += 1) {
        const w = writers[i];
        const peer = w === 'claude' ? 'codex' : 'claude';
        setPhase('execute', round, { fixRound, agent: w });

        const pre = gitguard.checkpoint(
          projectDir,
          fixRound === 0
            ? `会话 ${sessionId} ${writerLabel(w)}前检查点`
            : `会话 ${sessionId} 第 ${fixRound} 次返工 · ${writerLabel(w)}前检查点`,
        );
        if (pre.ok) {
          emit({ type: 'checkpoint', sha: pre.sha, label: '实现前', created: pre.created, agent: isSplit ? w : undefined });
        }

        const g = takeGuidance('execute');
        if (g) reviewerNote = [reviewerNote, `用户补充要求：${g}`].filter(Boolean).join('\n\n');

        const res = await runTurn(w, {
          phase: 'execute',
          round,
          prompt: executePrompt({
            agent: w,
            requirement,
            projectDir,
            plan,
            round: fixRound,
            reviewerNote,
            split: isSplit,
            // 第二个动手的人能看到第一个人的检查点，可以读、可以依赖，但不该改
            otherDone: isSplit && i > 0 && pre.ok ? pre.sha : null,
            peerName: agentName(peer),
          }) + guidanceBlock(g),
          write: true,
        });

        if (rt.stopped) throw new AbortError();
        if (res.ok) reports[w] = res.text;
      }

      // 验收的是**合起来**的结果，不是某一个人的部分
      const preAll = gitguard.checkpoint(projectDir, `会话 ${sessionId} ${writerLabel('')}后检查点`);
      const diff = gitguard.diffFrom(projectDir, baseSha);
      const files = gitguard.changedFiles(projectDir, baseSha);
      emit({ type: 'diff', phase: 'execute', round, diff, files, fixRound });

      if (!files.length) {
        emit({ type: 'warning', text: '实现阶段没有产生任何文件改动' });
      }

      /* ---------------- 验收 ---------------- */
      // 单写者：由搭档验收一次；分工：两人各验收一遍，都要放行才算过
      const reviewers = isSplit ? [leadAgent, peerAgent] : [reviewerOf(execImplementer)];
      const implementerReport = isSplit
        ? writers.map((w) => `### ${agentName(w)} 的汇报\n${reports[w] || '(未完成)'}`).join('\n\n')
        : (reports[execImplementer] || '(实现阶段失败)');

      let rejectedBy = null;
      let rejectNote = null;
      let reviewFailed = false;

      for (const rv of reviewers) {
        setPhase('review', round, { fixRound, agent: rv });
        const rg = takeGuidance('review');
        const res = await runTurn(rv, {
          phase: 'review',
          round,
          prompt: reviewPrompt({
            agent: rv,
            requirement,
            projectDir,
            plan,
            diff,
            implementerReport,
          }) + guidanceBlock(rg),
          write: false,
        });

        if (rt.stopped) throw new AbortError();

        if (!res.ok) {
          reviewFailed = true;
          break;
        }
        turns.push({ agent: rv, round, text: res.text, phase: 'review' });
        const verdict = extractVerdict(res.text);
        const rejected = !verdict?.converged || verdict.blocking.length > 0 || /打回/.test(res.text);
        emit({ type: 'review.verdict', round, fixRound, rejected, verdict, agent: isSplit ? rv : undefined });
        if (rejected && !rejectedBy) {
          rejectedBy = rv;
          rejectNote = res.text;
        }
      }

      if (reviewFailed) {
        outcome = 'review-failed';
        emit({ type: 'warning', text: '验收阶段失败，结束会话' });
        break;
      }
      if (!rejectedBy) {
        outcome = 'done';
        break;
      }
      if (fixRound >= maxFixRounds) {
        outcome = 'done-with-issues';
        emit({ type: 'warning', text: `返工已达上限（${maxFixRounds} 次），仍有未解决的问题` });
        break;
      }
      fixRound += 1;
      reviewerNote = rejectNote;
    }

    if (!allowWrite) emit({ type: 'log', text: '未开启写入权限，仅产出方案，未改动代码' });

    /* ---------------- 收尾 ---------------- */
    const finalDiff = gitguard.diffFrom(projectDir, baseSha);
    emit({ type: 'diff', phase: 'final', diff: finalDiff, files: gitguard.changedFiles(projectDir, baseSha) });

    const transcript = store.renderTranscript({ ...meta, baseSha }, turns);
    if (cycle > 1) store.appendTranscript(sessionId, `\n\n---\n\n${transcript}`);
    else store.saveTranscript(sessionId, transcript);
    store.patchMeta(sessionId, {
      // 注意这里是 **delivered（已交付）**，不是 completed。
      // 「任务算不算做完」由用户判定 —— 自动化流程跑完只代表这一轮做完了；
      // 用户还可以接着提需求，或者点「验收通过」把它结束掉。
      status: 'delivered',
      phase: 'delivered',
      awaitingUser: true,
      outcome,
      cycle,
      finishedAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
      agentSessions: agentSession,
    // CLI 自己上报的模型（Claude 在 init 事件里给）。Codex 不上报，就留空，
    // 界面会退回显示「配置值」，而不是假装知道它用了什么。
    agentModels: agentModel,
    });
    emit({ type: 'session.end', status: 'delivered', outcome, baseSha, awaitingUser: true });
    return { ok: true, outcome };
  } catch (err) {
    const stopped = err instanceof AbortError || rt.stopped;
    store.patchMeta(sessionId, {
      status: stopped ? 'stopped' : 'failed',
      phase: stopped ? 'stopped' : 'failed',
      finishedAt: new Date().toISOString(),
    });
    emit({
      type: 'session.end',
      status: stopped ? 'stopped' : 'failed',
      error: stopped ? undefined : err.message,
    });
    if (!stopped) emit({ type: 'error', text: err.message });
    return { ok: false, error: err.message, stopped };
  } finally {
    ACTIVE.delete(sessionId);
  }
}

class AbortError extends Error {
  constructor() {
    super('会话已中止');
    this.name = 'AbortError';
  }
}

function clamp(n, lo, hi) {
  const v = Number.isFinite(n) ? Math.trunc(n) : lo;
  return Math.min(Math.max(v, lo), hi);
}
