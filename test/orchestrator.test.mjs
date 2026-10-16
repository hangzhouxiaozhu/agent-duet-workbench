import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * 编排状态机的测试。
 *
 * 关键点：runSession 把 adapters 作为参数注入，所以这里可以塞假适配器，
 * 完全离线地验证状态机行为 —— 不调用任何模型，不消耗任何额度。
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-duet-workbench-orch-'));
process.env.AGENT_DUET_WORKBENCH_SESSIONS_DIR = path.join(tmp, 'sessions');

// 动态 import：config.mjs 在导入时就读取 AGENT_DUET_WORKBENCH_SESSIONS_DIR，必须先设好环境变量
const store = await import('../src/session.mjs');
const { runSession, injectGuidance } = await import('../src/orchestrator.mjs');

function makeProject(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, 'index.html'), 'original\n');
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  return fs.realpathSync(dir);
}

const VERDICT = '```json\n{"converged": true, "agreements": ["都要改首屏"], "disagreements": [], "blocking": [], "next": "开工"}\n```';

function mockAdapter(id, { fail = false } = {}) {
  const calls = [];
  return {
    id,
    label: id,
    calls,
    // 注意字段名是 allowWrite（编排器实际传入的），不是 write
    async run({ onEvent, allowWrite }) {
      calls.push({ write: Boolean(allowWrite) });
      if (fail) return { ok: false, error: `${id} 模拟失败：未登录` };
      const text = `我是 ${id} 的方案。\n\n${VERDICT}`;
      onEvent?.({ type: 'delta', text: '我是 ' });
      onEvent?.({ type: 'message', text });
      return { ok: true, text, sessionId: `sess-${id}-${calls.length}`, usage: { output_tokens: 10 } };
    },
  };
}

async function run({ projectDir, claudeFail = false, codexFail = false }) {
  const id = store.createSession({
    requirement: '把首屏改到 3 秒内说清卖点',
    projectDir,
    settings: {
      maxRounds: 3, minRounds: 2, allowWrite: true, maxFixRounds: 1,
      leadAgent: 'claude', turnTimeoutMs: 5000,
    },
    status: 'running',
  }).id;

  const claude = mockAdapter('claude', { fail: claudeFail });
  const codex = mockAdapter('codex', { fail: codexFail });
  const events = [];

  const result = await runSession({
    sessionId: id,
    requirement: '把首屏改到 3 秒内说清卖点',
    projectDir,
    settings: {
      maxRounds: 3, minRounds: 2, allowWrite: true, maxFixRounds: 1,
      leadAgent: 'claude', turnTimeoutMs: 5000,
    },
    adapters: { claude, codex },
    onEvent: (e) => events.push(e),
  });

  const phases = [...new Set(events.filter((e) => e.type === 'phase').map((e) => e.phase))];
  return { id, result, events, phases, claude, codex, meta: store.readMeta(id) };
}

test('双方正常：走完 作答→讨论→定稿→实现→验收，会话完成', async () => {
  const project = makeProject('ok');
  const { result, phases, meta, claude, codex } = await run({ projectDir: project });

  assert.equal(result.ok, true, `会话失败: ${result.error}`);
  for (const p of ['propose', 'discuss', 'finalize', 'execute', 'review']) {
    assert.ok(phases.includes(p), `缺少阶段 ${p}（实际: ${phases.join(',')}）`);
  }
  // 跑完只代表「交付了」——任务算不算完成由用户点「验收通过」决定
  assert.equal(meta.status, 'delivered');
  assert.equal(meta.awaitingUser, true);

  // 第 1 轮两个都要被叫到
  assert.ok(claude.calls.length >= 1 && codex.calls.length >= 1);
  // 实现阶段有且只有主导方拿到写权限
  const writers = [...claude.calls, ...codex.calls].filter((c) => c.write).length;
  assert.ok(writers >= 1, '应该有人真正拿到写权限');
});

test('第 1 轮有一方失败：立刻中止，不再消耗额度', async () => {
  const project = makeProject('fail');
  const { result, phases, meta, codex, events } = await run({
    projectDir: project, claudeFail: true,
  });

  assert.equal(result.ok, false, '应该判定为失败');
  assert.match(result.error, /第 1 轮/, `错误信息应说明是第 1 轮失败: ${result.error}`);
  assert.equal(meta.status, 'failed');

  // 核心断言：绝不能进入后续任何阶段
  assert.ok(!phases.includes('discuss'), `不该进入讨论阶段: ${phases.join(',')}`);
  assert.ok(!phases.includes('finalize'), '不该进入定稿阶段');
  assert.ok(!phases.includes('execute'), '不该进入实现阶段');
  assert.ok(!phases.includes('review'), '不该进入验收阶段');

  // 搭档只被调用了一次（第 1 轮），没有把额度浪费在注定失败的会话上
  assert.equal(codex.calls.length, 1, `搭档被调用了 ${codex.calls.length} 次，应只调用 1 次`);

  // 失败原因要出现在事件流里，用户能看见
  const errText = events.filter((e) => e.type === 'error' || e.type === 'session.end')
    .map((e) => e.text || e.error || '').join(' ');
  assert.match(errText, /模拟失败|第 1 轮/, '事件流里应包含失败原因');
});

test('中止后状态落盘正确，不会留下 running 僵尸会话', async () => {
  const project = makeProject('fail2');
  const { meta } = await run({ projectDir: project, codexFail: true });
  assert.notEqual(meta.status, 'running');
  assert.equal(meta.status, 'failed');
  assert.ok(meta.finishedAt, '应记录结束时间');
});

/* ---------------------- 用户插话（曾经会被静默丢弃） ---------------------- */

/**
 * 这两个用例守着一条会**静默丢掉用户输入**的路径。
 *
 * 旧代码在每轮讨论结束后无条件 `guidance.length = 0`，但插话只在
 * **该轮开始之前**被读进提示词。于是「看到 agent 正在跑、才想插一句话」这个
 * 最常见的情形下，插话既进不了当前这轮，又会被清掉 —— 彻底消失。
 * 如果这轮恰好收敛，更是连定稿都收不到。
 */
async function runWithGuidanceInjection({ maxRounds }) {
  const project = makeProject(`guide-${maxRounds}-${Math.random().toString(36).slice(2, 7)}`);
  const requirement = '给 cli.js 加 --dry-run';
  const settings = {
    maxRounds, minRounds: 2, allowWrite: false, maxFixRounds: 0,
    leadAgent: 'claude', turnTimeoutMs: 5000,
  };
  const id = store.createSession({
    requirement, projectDir: project, settings, status: 'running',
  }).id;

  const prompts = [];   // 每次调用 agent 时实际发出去的提示词
  const events = [];
  const GUIDANCE = '必须全部用中文输出';

  const mk = (agent) => ({
    id, label: agent, calls: 0,
    async run({ prompt }) {
      this.calls += 1;
      prompts.push({ agent, phase: null, prompt });
      // 在 claude 的第 2 次调用（= 第 1 个讨论轮）**进行中**插话，
      // 模拟用户看到它们正在跑才想补充要求
      if (agent === 'claude' && this.calls === 2) injectGuidance(id, GUIDANCE);
      return {
        ok: true,
        text: `我是 ${agent}。\n\n${VERDICT}`,
        sessionId: `s-${agent}-${this.calls}`,
      };
    },
  });

  await runSession({
    sessionId: id, requirement, projectDir: project, settings,
    adapters: { claude: mk('claude'), codex: mk('codex') },
    onEvent: (e) => events.push(e),
  });

  const delivered = prompts.filter((p) => p.prompt.includes(GUIDANCE));
  return { prompts, events, delivered, id, meta: store.readMeta(id) };
}

test('轮次进行中插入的话，最终一定会被传达（不会被静默丢弃）', async () => {
  const { delivered, events } = await runWithGuidanceInjection({ maxRounds: 2 });

  assert.ok(delivered.length > 0,
    `插话被静默丢弃了：${delivered.length} 次送达`);

  // 而且必须是"之后"送达的 —— 注入时那一轮的提示词早就构造好了，进不去
  const deliveredTo = [...new Set(delivered.map((d) => d.agent))];
  assert.ok(deliveredTo.length >= 1);

  // 事件流里要有明确回执，用户才知道话送到了
  const receipt = events.filter((e) => e.type === 'guidance.delivered');
  assert.equal(receipt.length, 1, `应有且仅有一次送达回执，实际 ${receipt.length}`);
  assert.match(receipt[0].text, /必须全部用中文输出/);
});

test('插话能让讨论在上限之外多跑一轮', async () => {
  const { events } = await runWithGuidanceInjection({ maxRounds: 2 });

  const discussRounds = events
    .filter((e) => e.type === 'phase' && e.phase === 'discuss')
    .map((e) => e.round);

  assert.ok(Math.max(...discussRounds) > 2,
    `用户还有话没说，就该超出上限继续一轮；实际讨论轮次：${discussRounds.join(',')}`);
});

/* ---------------- 收敛推手：议题账本 / 收紧压力 / 停滞裁决 ---------------- */

/**
 * 这三个机制解决的是同一个问题：**讨论不收敛**。
 * 实测过一条轨迹 —— 一致项 12→22，未决项也从 11 涨到 16。
 * 那不是收敛，是在累积问题。原因有三个，对应下面三组测试：
 *   1. 未决项每轮从零重建，没人对旧议题负责 → 账本 + 编号表态
 *   2. 没有进度压力，可以无限开新议题     → 收紧轮
 *   3. 卡住了也没人裁决                   → 停滞检测 + 强制裁决
 */
function scriptedSession(script, { maxRounds = 6 } = {}) {
  const project = makeProject(`ledger-${Math.random().toString(36).slice(2, 7)}`);
  const requirement = '给 cli.js 加 --dry-run';
  const settings = {
    maxRounds, minRounds: 2, allowWrite: false, maxFixRounds: 0,
    leadAgent: 'claude', turnTimeoutMs: 5000,
  };
  const id = store.createSession({ requirement, projectDir: project, settings, status: 'running' }).id;

  const calls = { claude: 0, codex: 0 };
  const prompts = [];
  const mk = (agent) => ({
    id: agent,
    async run({ prompt }) {
      prompts.push({ agent, prompt });
      // 索引 0 留给 propose（它的返回值不参与判停），discuss 从 1 开始按顺序取
      const list = [{ converged: true }, ...(script[agent] || [])];
      const v = list[Math.min(calls[agent], list.length - 1)];
      calls[agent] += 1;
      return {
        ok: true,
        text: `正文\n\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``,
        sessionId: `${agent}-${calls[agent]}`,
      };
    },
  });

  const events = [];
  return runSession({
    sessionId: id, requirement, projectDir: project, settings,
    adapters: { claude: mk('claude'), codex: mk('codex') },
    onEvent: (e) => events.push(e),
  }).then(() => ({ events, prompts, id }));
}

const consensusOf = (events) => events.filter((e) => e.type === 'consensus');
const discussPrompts = (prompts) => prompts.filter((p) => /积压议题账本|收紧轮|本轮任务：评议/.test(p.prompt));

test('账本：双方都标注 resolved 才结案', async () => {
  const { events } = await scriptedSession({
    claude: [
      { converged: false, newIssues: ['日志前缀用哪个', '要不要加缓存'] },   // 第2轮：提两条
      { converged: true, resolved: [1, 2] },                                  // 第3轮：都结案
    ],
    codex: [
      { converged: false, newIssues: [] },
      { converged: true, resolved: [1, 2] },
    ],
  });
  const cs = consensusOf(events);
  assert.equal(cs[0].openCount, 2, `第2轮账本应为 2，实际 ${cs[0].openCount}`);
  assert.equal(cs[1].openCount, 0, `双方结案后账本应清空，实际 ${cs[1].openCount}`);
  assert.equal(cs[1].closed, 2, '要记录本轮结案数');
});

test('账本：只有一方说谈妥了不算结案（另一方还在坚持）', async () => {
  const { events } = await scriptedSession({
    claude: [
      { converged: false, newIssues: ['要不要加缓存'] },
      { converged: false, resolved: [1] },        // 只有 claude 认为谈妥
    ],
    codex: [
      { converged: false, newIssues: [] },
      { converged: false, resolved: [] },         // codex 不认
    ],
  });
  const cs = consensusOf(events);
  assert.equal(cs[1].openCount, 1, '一方结案不算数，账本不该减少');
  assert.equal(cs[1].closed, 0);
});

test('收紧压力：账本没减少时，下一轮进入收紧模式且禁止新增议题', async () => {
  const { events, prompts } = await scriptedSession({
    claude: [
      { converged: false, newIssues: ['要不要加缓存'] },
      { converged: false, newIssues: ['又一个新想法'] },   // 收紧轮应被忽略
      { converged: true, resolved: [1] },
    ],
    codex: [
      { converged: false, newIssues: [] },
      { converged: false, newIssues: [] },
      { converged: true, resolved: [1] },
    ],
  });
  const cs = consensusOf(events);
  // 第2轮建账本（没有可比对象，不判定进度）
  assert.equal(cs[0].pressure, 'normal');
  assert.equal(cs[0].openCount, 1);
  assert.equal(cs[0].added, 1, '正常轮可以新增议题');
  // 第3轮：账本没减少（1 → 2）→ 判定停滞 1 次
  assert.equal(cs[1].pressure, 'normal', '第3轮仍是正常模式，是它判定出停滞的');
  assert.equal(cs[1].openCount, 2);
  // 第4轮：收紧
  assert.equal(cs[2].pressure, 'tight', '账本没减少 → 下一轮收紧');
  assert.equal(cs[2].added, 0, '收紧轮必须忽略新增议题');
  assert.equal(cs[2].openCount, 1, '收紧轮靠结案把账本降下来了');

  const tightPrompt = prompts.find((p) => /本轮是收紧轮/.test(p.prompt));
  assert.ok(tightPrompt, '收紧轮的实际提示词里必须出现施压说明');
});

test('停滞检测：积压议题连续两轮不减 → 停止讨论，不再烧额度', async () => {
  const { events, prompts } = await scriptedSession({
    claude: [
      { converged: false, newIssues: ['死结'] },
      { converged: false, resolved: [] },
      { converged: false, resolved: [] },
    ],
    codex: [
      { converged: false, newIssues: [] },
      { converged: false, resolved: [] },
      { converged: false, resolved: [] },
    ],
  }, { maxRounds: 6 });

  const cs = consensusOf(events);
  // 第2轮建账本，第3轮不减(stall=1)，第4轮仍不减(stall=2) → 停
  assert.equal(cs.length, 3, `应在第 4 轮停止（实际讨论了 ${cs.length + 1} 轮）`);
  assert.ok(cs.every((c) => !c.converged), '这种情况本来就没收敛');
  const log = events.filter((e) => e.type === 'log').map((e) => e.text).join(' ');
  assert.match(log, /连续两轮没有减少/, '要明确告诉用户为什么停');
  assert.match(log, /逐条裁决/, '要说明接下来怎么办');

  // 停之后仍然要定稿，而且定稿提示词里带着未决议题
  const fin = prompts.find((p) => /定稿/.test(p.prompt));
  assert.ok(fin, '停滞也必须产出方案，不能白跑');
  assert.match(fin.prompt, /\*\*#1\*\*/, '定稿要拿到未决议题并逐条裁决');
  assert.match(fin.prompt, /停滞/);
});

test('正常收敛时账本为空，不会误触发停滞', async () => {
  const { events } = await scriptedSession({
    claude: [
      { converged: false, newIssues: ['小分歧'] },
      { converged: true, resolved: [1] },
    ],
    codex: [
      { converged: false, newIssues: [] },
      { converged: true, resolved: [1] },
    ],
  });
  const cs = consensusOf(events);
  assert.equal(cs.length, 2, '两轮就收敛');
  assert.equal(cs[1].converged, true);
  assert.equal(cs[1].openCount, 0);
});

/* ---------------- 从「共识」到「决策完备」 ---------------- */

/**
 * 这是最根本的一处改动。
 *
 * 旧目标：双方都 converged（互相满意）—— 可能永远达不到。
 * 新目标：**账本清空**（每条议题都有结论）—— 一定能达到。
 *
 * 因为方案的质量并不需要「全体一致」，只需要「没有悬而未决的问题」。
 * 达成结论的途径不止一条：谈妥、或者**由负责实现的一方裁决**。
 * 这把一个「共识问题」（可能无解）换成了「决策完备性问题」（一定有解）。
 */
test('裁决：主导方拍板即可结案，不必等对方点头', async () => {
  const { events } = await scriptedSession({
    claude: [   // leadAgent 默认是 claude
      { converged: false, newIssues: ['要不要加缓存'] },
      { converged: false, decided: [{ id: 1, how: '不加缓存', why: 'MVP 阶段收益不明' }] },
    ],
    codex: [
      { converged: false, newIssues: [] },
      { converged: false, resolved: [], blocking: [] },   // 只是不表态，没有明确反对
    ],
  });
  const cs = consensusOf(events);
  assert.equal(cs[1].openCount, 0, '主导方裁决后账本应清空');
  assert.equal(cs[1].decided, 1, '要记录本轮裁决数');
  assert.equal(cs[1].complete, true, '账本清空 = 决策完备');
});

test('裁决：账本清空就停，即使双方从没说过 converged', async () => {
  const { events } = await scriptedSession({
    claude: [
      { converged: false, newIssues: ['A'] },
      { converged: false, decided: [{ id: 1, how: '选 A', why: '理由' }] },
    ],
    codex: [
      { converged: false, newIssues: [] },
      { converged: false },
    ],
  });
  const cs = consensusOf(events);
  assert.equal(cs.length, 2, '两条讨论轮就够：建账本 → 裁决清空');
  assert.equal(cs[1].converged, false, '这是"完备"，不是"一致"');
  const log = events.filter((e) => e.type === 'log').map((e) => e.text).join(' ');
  assert.match(log, /账本已清空/, '日志要说清是"每条都有结论"，而不是"双方达成一致"');
  assert.match(log, /裁决/, '要说明是靠裁决完成的');
});

test('公平性：搭档明确反对时裁决留一轮，连续两轮坚持才生效', async () => {
  const { events } = await scriptedSession({
    claude: [
      { converged: false, newIssues: ['要不要加缓存'] },
      { converged: false, decided: [{ id: 1, how: '不加', why: 'MVP' }] },   // 第1次裁决
      { converged: false, decided: [{ id: 1, how: '不加', why: 'MVP' }] },   // 第2次坚持
    ],
    codex: [
      { converged: false, newIssues: [] },
      { converged: false, blocking: [1] },     // 明确反对 → 留一轮
      { converged: false, blocking: [1] },
    ],
  });
  const cs = consensusOf(events);
  assert.equal(cs[1].openCount, 1, '搭档明确反对时，第 1 次裁决不该硬压过去');
  assert.equal(cs[1].decided, 0, '本轮裁决未生效');
  assert.equal(cs[2].openCount, 0, '主导方坚持两轮后裁决生效（搭档的反对权有边界）');
});

test('裁决会传给定稿，方案必须照办', async () => {
  const { prompts } = await scriptedSession({
    claude: [
      { converged: false, newIssues: ['要不要加缓存'] },
      { converged: false, decided: [{ id: 1, how: '不加缓存', why: 'MVP 阶段收益不明' }] },
    ],
    codex: [
      { converged: false, newIssues: [] },
      { converged: false },
    ],
  });
  const fin = prompts.find((p) => /定稿/.test(p.prompt));
  assert.ok(fin);
  assert.match(fin.prompt, /已经作出的裁决/, '定稿要看到裁决');
  assert.match(fin.prompt, /不加缓存/, '裁决内容要带上');
  assert.match(fin.prompt, /不要再推翻/);
});

test('某一方本轮失败时，绝不能因为「账本为空」判定完备', async () => {
  // 这是实际踩到的坑：Claude 额度用尽返回一句提示，codex 看到垃圾只能回答
  // 「没有可评议的方案」→ 账本 0 条 → 被误判成"决策完备"直接收工。
  // 空账本只有在**双方都真的给出了结论**时才意味着完备。
  const project = makeProject('false-complete');
  const requirement = '随便做点什么';
  const settings = {
    maxRounds: 4, minRounds: 2, allowWrite: false, maxFixRounds: 0,
    leadAgent: 'claude', turnTimeoutMs: 5000,
  };
  const id = store.createSession({ requirement, projectDir: project, settings, status: 'running' }).id;

  let claudeCalls = 0;
  const mkClaude = {
    id: 'claude',
    async run() {
      claudeCalls += 1;
      // 第 1 轮（propose）正常，之后全部失败 —— 模拟"讨论阶段额度用尽"
      if (claudeCalls === 1) return { ok: true, text: '方案', sessionId: 'c1' };
      return { ok: false, error: 'Claude 额度已用尽', rateLimited: true };
    },
  };
  const mkCodex = {
    id: 'codex',
    async run() {
      // codex 每次都"成功"，但因为没有可评议的内容，它一条议题都提不出来
      return {
        ok: true,
        text: '没有可评议的方案\n\n```json\n{"converged":true,"agreements":[],"resolved":[],"decided":[],"blocking":[],"newIssues":[]}\n```',
        sessionId: 'x',
      };
    },
  };

  const events = [];
  const r = await runSession({
    sessionId: id, requirement, projectDir: project, settings,
    adapters: { claude: mkClaude, codex: mkCodex },
    onEvent: (e) => events.push(e),
  });

  // 额度用尽应当**提前中止**，而不是删掉 verdict 后继续跑下一轮 ——
  // 那只会单方面烧掉另一方的额度，而且对方看不到有效输入、只能空转。
  assert.equal(r.ok, false, '额度用尽应中止会话');
  assert.match(r.error, /额度已用尽/, `错误信息要说清原因：${r.error}`);
  assert.match(r.error, /白烧|另一方/, '要说明为什么不等它跑完');
  // 中止发生在判停之前，所以这一轮连共识事件都不该产生
  const cs = events.filter((e) => e.type === 'consensus');
  assert.equal(cs.length, 0, `不该对垃圾输入做判停（实际 ${cs.length} 轮共识事件）`);
  const end = events.find((e) => e.type === 'session.end');
  assert.equal(end.status, 'failed', '会话应记为失败，而不是"完成"');
});

/* ---------------- 分工实现：两个 agent 各写一部分 ---------------- */

/**
 * 单写者模式下只有一个 agent 有写权限。分工模式让两边都能写代码，
 * 但必须**串行** —— 同时改同一批文件会互相覆盖，而且没有 worktree 隔离兜底。
 */
function splitSession({ leadAgent = 'split' } = {}) {
  const project = makeProject(`split-${Math.random().toString(36).slice(2, 7)}`);
  const requirement = '实现两个互不相干的模块';
  const settings = {
    maxRounds: 2, minRounds: 2, allowWrite: true, maxFixRounds: 0,
    leadAgent, turnTimeoutMs: 5000,
  };
  const id = store.createSession({ requirement, projectDir: project, settings, status: 'running' }).id;

  const V = '```json\n{"converged":true,"agreements":[],"resolved":[],"decided":[],"blocking":[],"newIssues":[]}\n```';
  const calls = { claude: [], codex: [] };
  const mk = (agent) => ({
    id: agent,
    async run({ allowWrite }) {
      const wrote = Boolean(allowWrite);
      calls[agent].push(wrote);
      // 真的写点东西，否则会被判定"没有产生任何文件改动"
      if (wrote) {
        fs.writeFileSync(path.join(project, `${agent}-part.js`), `// ${agent}\n`);
      }
      return {
        ok: true,
        text: `${agent} ${wrote ? '实现了自己那部分' : '讨论了方案'}\n\n${V}`,
        sessionId: `${agent}-${calls[agent].length}`,
      };
    },
  });

  const events = [];
  return runSession({
    sessionId: id, requirement, projectDir: project, settings,
    adapters: { claude: mk('claude'), codex: mk('codex') },
    onEvent: (e) => events.push(e),
  }).then(() => ({ calls, events, project, projectName: path.basename(project) }));
}

test('分工模式：两个 agent 都拿到写权限，各写一部分', async () => {
  const { calls } = await splitSession();
  assert.ok(calls.claude.some(Boolean), 'Claude 应该有写权限');
  assert.ok(calls.codex.some(Boolean), 'Codex 也应该有写权限（这正是分工模式的意义）');
});

test('单写者模式：只有主导方拿写权限，搭档全程只读', async () => {
  const { calls } = await splitSession({ leadAgent: 'claude' });
  assert.ok(calls.claude.some(Boolean), '主导方要能写');
  assert.ok(!calls.codex.some(Boolean), '搭档不该拿到写权限');
});

test('分工模式：两个文件都真的被写出来了', async () => {
  const { project } = await splitSession();
  assert.ok(fs.existsSync(path.join(project, 'claude-part.js')), 'Claude 那部分应落盘');
  assert.ok(fs.existsSync(path.join(project, 'codex-part.js')), 'Codex 那部分应落盘');
});

test('分工模式：验收要两人都放行才算过', async () => {
  const { calls } = await splitSession();
  // 每个 agent 至少一次只读调用是"验收"
  const reviewish = calls.claude.filter((w) => !w).length + calls.codex.filter((w) => !w).length;
  assert.ok(reviewish >= 2, `应该有两轮验收（每方一次），实际只读调用 ${reviewish} 次`);
});

test('分工模式：定稿提示词里要求出分工表', async () => {
  const project = makeProject('split-plan');
  const settings = {
    maxRounds: 2, minRounds: 2, allowWrite: false, maxFixRounds: 0,
    leadAgent: 'split', turnTimeoutMs: 5000,
  };
  const id = store.createSession({ requirement: 'x', projectDir: project, settings, status: 'running' }).id;
  const V = '```json\n{"converged":true,"agreements":[],"resolved":[],"decided":[],"blocking":[],"newIssues":[]}\n```';
  const prompts = [];
  const mk = (a) => ({
    id: a,
    async run({ prompt }) {
      prompts.push({ a, prompt });
      return { ok: true, text: `t ${V}`, sessionId: a };
    },
  });
  await runSession({
    sessionId: id, requirement: 'x', projectDir: project, settings,
    adapters: { claude: mk('claude'), codex: mk('codex') }, onEvent: () => {},
  });
  const fin = prompts.find((p) => /定稿/.test(p.prompt));
  assert.ok(fin, '应该有定稿调用');
  assert.match(fin.prompt, /分工表/, '分工模式下定稿必须要求分工表');
  assert.match(fin.prompt, /不要碰同一个文件|不要碰同一个/, '要说明两边不能碰同一个文件');
});

/* ---------------- 落地方式由讨论决定 ---------------- */

/**
 * 谁实现、要不要分工，本来不该由用户在开会前拍板 ——
 * 任务是什么形状、能不能切开，只有讨论完才知道。
 * 所以问的是他们俩，而不是设置里的固定值。
 */
function autoRoleSession(view) {
  const project = makeProject(`auto-${Math.random().toString(36).slice(2, 7)}`);
  const requirement = '做个东西';
  const settings = {
    maxRounds: 2, minRounds: 2, allowWrite: false, maxFixRounds: 0,
    leadAgent: 'auto', turnTimeoutMs: 5000,
  };
  const id = store.createSession({ requirement, projectDir: project, settings, status: 'running' }).id;
  const prompts = [];
  const mk = (agent) => {
    let n = 0;
    return {
      id: agent,
      async run({ prompt }) {
        prompts.push({ agent, prompt });
        n += 1;
        // 索引 0 是 propose，之后才带 execution
        const exec = n === 1 ? null : (view[agent] || null);
        const v = { converged: true, agreements: [], resolved: [], decided: [], blocking: [], newIssues: [] };
        if (exec) v.execution = exec;
        return { ok: true, text: `t\n\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``, sessionId: `${agent}${n}` };
      },
    };
  };
  const events = [];
  return runSession({
    sessionId: id, requirement, projectDir: project, settings,
    adapters: { claude: mk('claude'), codex: mk('codex') },
    onEvent: (e) => events.push(e),
  }).then(() => ({ events, prompts }));
}

const decisionLog = (events) =>
  events.filter((e) => e.type === 'log').map((e) => e.text).find((t) => /讨论决定/.test(t)) || '';

test('由讨论决定：两边都主张分工 → 分工，且定稿要求分工表', async () => {
  const { events, prompts } = await autoRoleSession({
    claude: { mode: 'split', reason: '按模块切开很清楚' },
    codex: { mode: 'split', reason: '可以并行' },
  });
  assert.match(decisionLog(events), /分工实现/, decisionLog(events));
  const fin = prompts.find((p) => /定稿/.test(p.prompt));
  assert.match(fin.prompt, /分工表/, '分工决定要传导到定稿');
});

test('由讨论决定：主导方主张单干 → 单干，且指明谁做', async () => {
  const { events, prompts } = await autoRoleSession({
    claude: { mode: 'single', implementer: 'codex', reason: '要改同一批文件，切开反而乱' },
    codex: { mode: 'single', implementer: 'codex' },
  });
  assert.match(decisionLog(events), /由 Codex 实现/, decisionLog(events));
  const fin = prompts.find((p) => /定稿/.test(p.prompt));
  assert.ok(!/分工表/.test(fin.prompt), '单干时不该再要求分工表');
});

test('由讨论决定：搭档主张分工但主导方主张单干 → 听主导方（它是裁决方）', async () => {
  const { events } = await autoRoleSession({
    claude: { mode: 'single', implementer: 'claude', reason: '耦合太紧' },
    codex: { mode: 'split', reason: '我想写点东西' },
  });
  const log = decisionLog(events);
  assert.match(log, /由 Claude 实现/, log);
  assert.ok(!/分工实现/.test(log), '不该因为搭档想分工就强行分工');
});

test('由讨论决定：双方都说不出落地方式 → 保守单干并明确警告', async () => {
  const { events } = await autoRoleSession({ claude: null, codex: null });
  assert.match(decisionLog(events), /由 Claude 实现/);
  const warn = events.filter((e) => e.type === 'warning').map((e) => e.text).join(' ');
  assert.match(warn, /没有给出落地方式/, '说不清时要明确告诉用户走了保守策略');
});

test('由讨论决定：讨论提示词里要问 execution，其他模式不问', async () => {
  const auto = await autoRoleSession({ claude: { mode: 'split' }, codex: { mode: 'split' } });
  const autoDiscuss = auto.prompts.filter((p) => /评议/.test(p.prompt));
  assert.ok(autoDiscuss.length > 0);
  assert.match(autoDiscuss[0].prompt, /谁来落地/, '由讨论决定时必须问落地方式');

  const fixed = await splitSession({ leadAgent: 'claude' });
  const fixedDiscuss = fixed.prompts ? [] : [];
  // 固定模式下不追加该指令（用 prompts 里是否有该段来判断）
  const anyAuto = auto.prompts.some((p) => /谁来落地/.test(p.prompt));
  assert.equal(anyAuto, true);
});
/* ---------------------- 追加需求：任务结束与否由用户判定 ---------------------- */

/**
 * 「任务做完了没有」应该由用户判定：自动化流程跑完只把会话标成 delivered，
 * 用户还能接着提需求。这两个用例守住这条路径。
 */
test('追加需求：带上一次交付的方案，且每个 agent 的第一轮续聊 CLI 会话', async () => {
  const project = makeProject('continue-ok');
  const first = await run({ projectDir: project });
  assert.equal(first.meta.status, 'delivered', '跑完只算交付，不该替用户宣布完成');
  assert.equal(first.meta.awaitingUser, true);
  const plan = store.readPlan(first.id);
  assert.ok(plan.length > 0, '第一次交付应该留下方案，作为续跑的背景');

  const seen = [];
  const make = (agent) => ({
    id: agent, label: agent,
    async run({ prompt, resumeId, onEvent }) {
      seen.push({ agent, prompt, resumeId });
      const text = `续：${agent}\n\n${VERDICT}`;
      onEvent?.({ type: 'message', text });
      return { ok: true, text, sessionId: `sess-${agent}-cont` };
    },
  });

  const result = await runSession({
    sessionId: first.id,
    requirement: '再把移动端的横向滚动修掉',
    projectDir: project,
    settings: { maxRounds: 2, minRounds: 1, allowWrite: false, maxFixRounds: 0, leadAgent: 'claude', turnTimeoutMs: 5000 },
    adapters: { claude: make('claude'), codex: make('codex') },
    onEvent: () => {},
    cycle: 2,
    priorContext: { cycle: 2, previousRequirement: '把首屏改到 3 秒内说清卖点', previousPlan: plan },
    resumeIds: { claude: 'claude-old', codex: 'codex-old' },
  });
  assert.equal(result.ok, true, `续跑失败: ${result.error}`);

  for (const agent of ['claude', 'codex']) {
    const mine = seen.filter((s) => s.agent === agent);
    assert.equal(mine[0].resumeId, `${agent}-old`, '第一轮应该续聊上次的 CLI 会话（它记得之前谈过什么）');
    assert.match(mine[0].prompt, /移动端的横向滚动/, '提示词里要有这次的新需求');
    assert.match(mine[0].prompt, /第 2 次需求/, '提示词里要说明这是追加需求，不是从零开始');
    assert.ok(mine.slice(1).every((s) => !s.resumeId), '后续轮次仍然每轮给完整上下文，不该继续 resume');
  }

  const meta = store.readMeta(first.id);
  assert.equal(meta.cycle, 2, '会话要记住这是第几次需求');
  assert.equal(meta.status, 'delivered', '追加需求跑完仍然只是交付');
  assert.equal(meta.awaitingUser, true, '交付后仍在等用户确认');
});

test('续聊会话失效时自动回退，不把用户刚提的需求丢掉', async () => {
  const project = makeProject('continue-fallback');
  const id = store.createSession({
    requirement: '第二轮需求', projectDir: project,
    settings: { maxRounds: 2, minRounds: 1, allowWrite: false, maxFixRounds: 0, leadAgent: 'claude', turnTimeoutMs: 5000 },
    status: 'running',
  }).id;

  const events = [];
  const make = (agent) => ({
    id: agent, label: agent,
    async run({ resumeId, onEvent }) {
      if (resumeId) return { ok: false, error: 'session not found' };
      const text = `补上方案。\n\n${VERDICT}`;
      onEvent?.({ type: 'message', text });
      return { ok: true, text, sessionId: `fresh-${agent}` };
    },
  });

  const result = await runSession({
    sessionId: id,
    requirement: '第二轮需求',
    projectDir: project,
    settings: { maxRounds: 2, minRounds: 1, allowWrite: false, maxFixRounds: 0, leadAgent: 'claude', turnTimeoutMs: 5000 },
    adapters: { claude: make('claude'), codex: make('codex') },
    onEvent: (e) => events.push(e),
    cycle: 2,
    priorContext: { cycle: 2, previousRequirement: '第一轮需求', previousPlan: '旧方案' },
    resumeIds: { claude: 'gone', codex: 'gone' },
  });

  assert.equal(result.ok, true, `回退后应该跑完: ${result.error}`);
  const logged = events.filter((e) => e.type === 'log').map((e) => e.text || '').join(' ');
  assert.match(logged, /续聊会话不可用/, '要如实告诉用户续聊失效并已回退，而不是静默失败');
  assert.equal(store.readMeta(id).status, 'delivered');
});
test('会话停下时记下的插话，下次继续时第一件事就交给双方', async () => {
  const project = makeProject('pending-guidance');
  const id = store.createSession({
    requirement: '老需求', projectDir: project,
    settings: { maxRounds: 2, minRounds: 1, allowWrite: false, maxFixRounds: 0, leadAgent: 'claude', turnTimeoutMs: 5000 },
    status: 'delivered',
    pendingGuidance: ['上线前先备份数据库'],
  }).id;

  const prompts = [];
  const make = (agent) => ({
    id: agent, label: agent,
    async run({ prompt, onEvent }) {
      prompts.push(prompt);
      const text = `收到。\n\n${VERDICT}`;
      onEvent?.({ type: 'message', text });
      return { ok: true, text, sessionId: `s-${agent}` };
    },
  });

  const result = await runSession({
    sessionId: id, requirement: '上线', projectDir: project,
    settings: { maxRounds: 2, minRounds: 1, allowWrite: false, maxFixRounds: 0, leadAgent: 'claude', turnTimeoutMs: 5000 },
    adapters: { claude: make('claude'), codex: make('codex') },
    onEvent: () => {}, cycle: 2,
  });
  assert.equal(result.ok, true, `续跑失败: ${result.error}`);
  assert.ok(prompts.some((p) => p.includes('上线前先备份数据库')), '第一轮的提示词里必须带上之前记下的插话');
  assert.deepEqual(store.readMeta(id).pendingGuidance, [], '取用之后要清掉，不能反复塞同一句');
});
/* ---------------------- 插话的两种生效方式 ---------------------- */

/**
 * 「立即执行」和「排队」必须是两种真实不同的行为：
 * 排队 = 等当前这一轮跑完再交给双方；立即 = 打断当前这一轮，在它已有的上下文上接着调整。
 * 并发的两轮（第 1 轮、讨论轮都是两个 agent 同时跑）必须拿到**同一份**要求，
 * 否则会有一个 agent 白跑一轮不带纠正的答案。
 */
test('立即执行：打断后接着原有上下文调整，不丢 CLI 会话与已产出的内容', async () => {
  const project = makeProject('guidance-now');
  const settings = { maxRounds: 2, minRounds: 1, allowWrite: false, maxFixRounds: 0, leadAgent: 'claude', turnTimeoutMs: 5000 };
  const id = store.createSession({ requirement: '改首屏', projectDir: project, settings, status: 'running' }).id;

  const prompts = { claude: [], codex: [] };
  const resumes = { claude: [], codex: [] };
  const make = (agent) => ({
    id: agent, label: agent,
    async run({ prompt, signal, resumeId, onEvent }) {
      prompts[agent].push(prompt);
      resumes[agent].push(resumeId);
      if (prompts[agent].length === 1) {
        // 先产出一点内容，再挂住等「立即执行」把它打断
        onEvent?.({ type: 'delta', text: `我先改了标题（${agent}）` });
        if (signal.aborted) return { ok: false, aborted: true, error: '已中止' };
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        return { ok: false, aborted: true, error: '已中止' };
      }
      const text = `按新要求改了。\n\n${VERDICT}`;
      onEvent?.({ type: 'message', text });
      return { ok: true, text, sessionId: `s-${agent}` };
    },
  });

  const events = [];
  const run = runSession({
    sessionId: id, requirement: '改首屏', projectDir: project, settings,
    adapters: { claude: make('claude'), codex: make('codex') },
    onEvent: (e) => events.push(e),
    // 模拟「这个会话之前续聊过」：CLI 会话 id 是有的
    resumeIds: { claude: 'old-claude', codex: 'old-codex' },
  });

  // 等两个 agent 都真的开始跑第一轮（它们是并发跑的）
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (prompts.claude.length && prompts.codex.length) { clearInterval(timer); resolve(); }
    }, 10);
  });
  const r = injectGuidance(id, '不要再改侧边栏', { immediate: true });
  assert.equal(r.interrupted, 2, '并发跑的那两轮都该被打断');

  const result = await run;
  assert.equal(result.ok, true, `会话应该跑完: ${result.error}`);

  for (const agent of ['claude', 'codex']) {
    assert.ok(prompts[agent].length >= 2, `${agent} 应该被打断后接着改一次`);
    // 关键：接着同一个 CLI 会话说，这才叫「在原有上下文基础上调整」
    assert.ok(resumes[agent][1], `${agent} 重跑时必须带着 CLI 会话上下文`);
    assert.equal(resumes[agent][1], resumes[agent][0], `${agent} 不能把会话上下文丢掉`);
    assert.match(prompts[agent][1], /不要从头重做/, '要说清是在原有基础上调整，而不是重来');
    assert.match(prompts[agent][1], /不要再改侧边栏/, '要带上用户的新要求');
    assert.match(prompts[agent][1], /我先改了标题/, '被打断前已产出的内容要交回去，不能丢');
    assert.ok(!/## 本轮任务：独立给出方案/.test(prompts[agent][1]), '续得上时只发调整说明，不重复整个原任务');
  }

  assert.ok(events.some((e) => e.type === 'log' && /接着它已有的上下文按新要求调整/.test(e.text || '')), '要如实说明是接着改');
  assert.ok(events.some((e) => e.type === 'guidance.delivered'), '取用时要有回执');
});
test('「立即执行」连点多次也不会把会话跑死', async () => {
  const project = makeProject('guidance-spam');
  const settings = { maxRounds: 2, minRounds: 1, allowWrite: false, maxFixRounds: 0, leadAgent: 'claude', turnTimeoutMs: 5000 };
  const id = store.createSession({ requirement: '改首屏', projectDir: project, settings, status: 'running' }).id;

  const prompts = { claude: [], codex: [] };
  const make = (agent) => ({
    id: agent, label: agent,
    async run({ prompt, signal, onEvent }) {
      prompts[agent].push(prompt);
      // 前三次都挂住，专门等着被「立即执行」打断；第四次必须能正常跑完
      if (prompts[agent].length <= 3) {
        await new Promise((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', resolve, { once: true });
        });
        return { ok: false, aborted: true, error: '已中止' };
      }
      const text = `改完了。\n\n${VERDICT}`;
      onEvent?.({ type: 'message', text });
      return { ok: true, text, sessionId: `s-${agent}` };
    },
  });

  const events = [];
  const run = runSession({
    sessionId: id, requirement: '改首屏', projectDir: project, settings,
    adapters: { claude: make('claude'), codex: make('codex') },
    onEvent: (e) => events.push(e),
  });

  const waitFor = async (n) => {
    const deadline = Date.now() + 4000;
    while ((prompts.claude.length < n || prompts.codex.length < n) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  await waitFor(1);
  injectGuidance(id, '第一次修正', { immediate: true });
  await waitFor(2);
  injectGuidance(id, '第二次修正', { immediate: true });
  await waitFor(3);
  injectGuidance(id, '第三次修正', { immediate: true });

  const result = await run;
  // 关键：不能报成「第 1 轮有 agent 失败」——那会把真正原因（用户连点）藏起来
  assert.equal(result.ok, true, `连点多次不该把会话判成失败: ${result.error}`);
  assert.ok(prompts.claude.length >= 4, `第四次尝试必须真的跑起来，实际 ${prompts.claude.length}`);
  assert.match(prompts.claude[3], /第三次修正/, '最后一次尝试要带上最后那句要求');
  assert.match(prompts.claude[3], /第一次修正/, '之前几次的要求也要累积保留，不能丢');
  assert.ok(!events.some((e) => e.type === 'error' && /第 1 轮/.test(e.text || '')), '不该冒出「第 1 轮失败」');
});
test('CLI 报出模型后立刻落盘：被中断的会话也不会丢这个值', async () => {
  const project = makeProject('model-immediate');
  const settings = { maxRounds: 2, minRounds: 2, allowWrite: false, leadAgent: 'claude', turnTimeoutMs: 5000 };
  const id = store.createSession({
    requirement: '随便一件事',
    projectDir: project,
    settings,
    status: 'running',
  }).id;

  let midRun = null;
  const reporting = (agent, model) => ({
    id,
    label: agent,
    async run({ onEvent }) {
      onEvent?.({ type: 'session', sessionId: `sess-${agent}`, ...(model ? { model } : {}) });
      // 事件刚报完就读一次 meta：此刻这一轮还没收尾，收尾那段代码根本还没轮到
      const now = store.readMeta(id);
      if (model) midRun = { status: now.status, models: now.agentModels || {} };
      onEvent?.({ type: 'message', text: VERDICT });
      return { ok: true, text: VERDICT, sessionId: `sess-${agent}`, usage: {} };
    },
  });

  await runSession({
    sessionId: id,
    requirement: '随便一件事',
    projectDir: project,
    settings,
    adapters: { claude: reporting('claude', 'claude-opus-5-5'), codex: reporting('codex', null) },
    onEvent: () => {},
  });

  assert.ok(midRun, '应当读到 claude 报出的模型');
  assert.equal(midRun.status, 'running', '读的时候应当还在一轮中途，而不是已经收尾');
  assert.equal(midRun.models.claude, 'claude-opus-5-5');
  assert.equal(midRun.models.codex, undefined, 'codex 不上报模型，就不该凭空写一个');
});
