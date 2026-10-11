import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractVerdict,
  judgeConsensus,
  buildDigest,
  VERDICT_INSTRUCTION,
  REVIEW_VERDICT_INSTRUCTION,
  proposePrompt,
  discussPrompt,
  finalizePrompt,
  executePrompt,
  reviewPrompt,
} from '../src/prompts.mjs';

/**
 * 收敛判定的测试。
 *
 * 这是「自动判停」的核心，而且是纯函数 —— 测起来零成本，所以覆盖得细一点。
 *
 * 这里钉着一个真实 bug：提示词告诉 agent「blocking 是唯一的闸门，非阻塞分歧
 * 不影响 converged」，但判停代码却要求 disagreements 也为空。两者不一致的后果是
 * agent 完全照做也永远停不下来，讨论必定跑满上限、白白多烧额度。
 */

const block = (obj) => '```json\n' + JSON.stringify(obj) + '\n```';

test('extractVerdict：解析出结构化结论', () => {
  const text = `我的方案如下。\n\n${block({
    converged: true, agreements: ['a'], disagreements: [], blocking: [], next: 'n',
  })}`;
  const v = extractVerdict(text);
  assert.equal(v.converged, true);
  assert.deepEqual(v.agreements, ['a']);
  assert.equal(v.next, 'n');
});

test('extractVerdict：取最后一个代码块（后面才是最终结论）', () => {
  const text = [
    block({ converged: false, agreements: [], disagreements: ['早期想法'], blocking: [], next: '' }),
    '再想了想，其实可以开工。',
    block({ converged: true, agreements: ['统一了'], disagreements: [], blocking: [], next: '' }),
  ].join('\n\n');
  assert.equal(extractVerdict(text).converged, true);
  assert.deepEqual(extractVerdict(text).agreements, ['统一了']);
});

test('extractVerdict：没有 JSON / 非法 JSON 返回 null', () => {
  assert.equal(extractVerdict('我没什么结论'), null);
  assert.equal(extractVerdict('```json\n{不是合法json}\n```'), null);
  assert.equal(extractVerdict(''), null);
  assert.equal(extractVerdict(null), null);
});

test('extractVerdict：缺少 converged 字段的 JSON 不算有效结论', () => {
  assert.equal(extractVerdict(block({ agreements: ['a'] })), null);
});

test('extractVerdict：字段类型不规整时容错', () => {
  const v = extractVerdict(block({ converged: 1, agreements: '就一条', disagreements: null }));
  assert.equal(v.converged, true);
  assert.deepEqual(v.agreements, ['就一条'], '字符串应被包装成数组');
  assert.deepEqual(v.disagreements, []);
});

/* ------------------------- judgeConsensus ------------------------- */

test('双方都判可开工、无阻塞 → 停（即使还有非阻塞分歧）', () => {
  // 这条就是那个 bug 的回归测试：
  // 提示词允许带着 disagreements 收敛，判定就必须允许。
  const j = judgeConsensus({
    claude: { converged: true, agreements: ['都要改首屏'], disagreements: ['用 IIFE 还是模块'], blocking: [], next: '' },
    codex: { converged: true, agreements: ['都要改首屏'], disagreements: [], blocking: [], next: '' },
  });
  assert.equal(j.converged, true, `不该因为非阻塞分歧就不收敛: ${j.reason}`);
  assert.deepEqual(j.disagreements, ['用 IIFE 还是模块'], '分歧仍要如实汇总给用户看');
  assert.match(j.reason, /非阻塞分歧/);
});

test('存在阻塞项 → 不停（即使双方都说可以开工）', () => {
  const j = judgeConsensus({
    claude: { converged: true, agreements: [], disagreements: [], blocking: ['缺设计稿'], next: '' },
    codex: { converged: true, agreements: [], disagreements: [], blocking: [], next: '' },
  });
  assert.equal(j.converged, false);
  assert.deepEqual(j.blocking, ['缺设计稿']);
  assert.match(j.reason, /阻塞/);
});

test('任一方认为未收敛 → 不停，并点名是谁', () => {
  const j = judgeConsensus({
    claude: { converged: true, agreements: [], disagreements: [], blocking: [], next: '' },
    codex: { converged: false, agreements: [], disagreements: [], blocking: [], next: '' },
  });
  assert.equal(j.converged, false);
  assert.match(j.reason, /Codex/, `应该点名到具体是谁: ${j.reason}`);
});

test('只有一方给出结论 → 视为未收敛（宁多聊一轮，不误判）', () => {
  const j = judgeConsensus({
    claude: { converged: true, agreements: [], disagreements: [], blocking: [], next: '' },
    codex: null,
  });
  assert.equal(j.converged, false);
  assert.match(j.reason, /1\/2/);
});

test('双方都没结论 → 未收敛', () => {
  assert.equal(judgeConsensus({ claude: null, codex: null }).converged, false);
  assert.equal(judgeConsensus({}).converged, false);
});

test('汇总去重：双方重复提到的同一分歧只出现一次', () => {
  const j = judgeConsensus({
    claude: { converged: false, agreements: ['A'], disagreements: ['同一个问题'], blocking: [], next: '' },
    codex: { converged: false, agreements: ['A'], disagreements: ['同一个问题'], blocking: [], next: '' },
  });
  assert.deepEqual(j.agreements, ['A']);
  assert.deepEqual(j.disagreements, ['同一个问题']);
});

test('端到端：真实回答文本 → verdict → 判定', () => {
  const claudeText = `我同意 Codex 的绝大多数意见。\n${block({
    converged: true,
    agreements: ['用 addEventListener', '文案改中文'],
    disagreements: ['aria-live 加不加'],
    blocking: [],
    next: '直接开工',
  })}`;
  const codexText = `基本同意。\n${block({
    converged: true, agreements: ['用 addEventListener'], disagreements: [], blocking: [], next: '开工',
  })}`;
  const j = judgeConsensus({
    claude: extractVerdict(claudeText),
    codex: extractVerdict(codexText),
  });
  assert.equal(j.converged, true);
  assert.equal(j.agreements.length, 2);
});

/* ---------------------- 提示词 / 判定契约一致性 ---------------------- */

test('契约：blocking 的两个方向都要讲明，且判定逻辑与之一致', () => {
  const p = VERDICT_INSTRUCTION;
  assert.match(p, /blocking` 为空/, '必须说明 blocking 为空时的要求');
  assert.match(p, /必须是 `true`/, 'blocking 为空时必须要求 converged=true');
  assert.match(p, /还有 `blocking` 项 → 必须是 `false`/, '有 blocking 时必须要求 converged=false');

  // 并且判定逻辑要真的按这个契约执行
  const withBlocking = judgeConsensus({
    claude: { converged: false, agreements: [], disagreements: [], blocking: ['x'], next: '' },
    codex: { converged: true, agreements: [], disagreements: [], blocking: [], next: '' },
  });
  assert.equal(withBlocking.converged, false);
  const withoutBlocking = judgeConsensus({
    claude: { converged: true, agreements: [], disagreements: ['风格偏好'], blocking: [], next: '' },
    codex: { converged: true, agreements: [], disagreements: [], blocking: [], next: '' },
  });
  assert.equal(withoutBlocking.converged, true);
});

test('契约：必须说明 converged 是自评，不是「双方是否谈成」', () => {
  // 真实踩过的坑：两个 agent 是**并行作答**的，本轮互相看不到对方的回答。
  // 提示词若要求它们报告「你们俩是否达成一致」，它们只能保守地填 false，
  // 结果就是讨论跑满上限也停不下来。
  const p = VERDICT_INSTRUCTION;
  assert.match(p, /同时作答/, '必须告诉 agent 他们看不到对方本轮的回答');
  assert.match(p, /「你自己」/, '必须讲清 converged 问的是自己是否可开工');
  assert.match(p, /放进 `blocking`/, '必须说明「还不能开工」时该怎么表达');
  // 光说「写进 blocking」不够 —— 还得说清什么才配当 blocking，否则会被滥用
  assert.match(p, /外部前提/, '必须区分「外部前提」和真正的阻塞项');
  assert.match(p, /纯偏好/, '必须说明纯偏好不算阻塞');
  assert.match(p, /可判定的依据/, '坚持阻塞必须给出可判定的依据');
});

/* --------------------------- buildDigest --------------------------- */
test('buildDigest：保留轮次与发言人，超长内容会截断', () => {
  const turns = [
    { agent: 'claude', round: 1, text: 'A'.repeat(50) },
    { agent: 'codex', round: 2, text: '短' },
  ];
  const d = buildDigest(turns, 20);
  assert.match(d, /第 1 轮 · Claude/);
  assert.match(d, /第 2 轮 · Codex/);
  assert.match(d, /已截断/, '超长内容应被截断并标注');
  assert.ok(d.length < 200, `摘要不该无限膨胀: ${d.length}`);
});

/* ------------------ 收敛推手：账本协议与收紧模式 ------------------ */

test('契约：判停协议要求按编号表态，而不是重新描述分歧', () => {
  const p = VERDICT_INSTRUCTION;
  assert.match(p, /resolved/, '必须有结案字段');
  assert.match(p, /编号/, '必须说明填的是议题编号');
  assert.match(p, /账本/, '必须让 agent 知道存在跨轮的账本');
  assert.match(p, /newIssues/, '必须有新增议题字段');
  // 光描述分歧不会让账本减少 —— 这条不明说的话，agent 会一直复述
  assert.match(p, /重新描述分歧是没用的|只会?在正文里重新描述/, '必须点明「只复述分歧没有用」');
});

test('契约：收紧模式下不允许新增议题', () => {
  const p = VERDICT_INSTRUCTION;
  assert.match(p, /收紧模式/, '必须告诉 agent 存在收紧模式');
  assert.match(p, /空数组/, '收紧模式下 newIssues 必须为空');
});

test('discussPrompt：账本以编号列出，收紧轮会明确施压', () => {
  const base = {
    agent: 'claude', peer: 'codex', requirement: 'r', projectDir: '/tmp',
    round: 3, selfLast: 'a', peerLast: 'b',
  };
  const issues = [
    { id: 1, text: '日志前缀用哪个', raisedRound: 2 },
    { id: 2, text: '要不要加缓存', raisedRound: 2 },
  ];
  const normal = discussPrompt({ ...base, openIssues: issues, pressure: 'normal' });
  assert.match(normal, /积压议题账本（2 条/);
  assert.match(normal, /\*\*#1\*\*/, '每条议题要带编号');
  assert.match(normal, /第 2 轮提出/, '要标出是哪一轮提出的');
  assert.ok(!/收紧轮/.test(normal), '正常轮不该出现收紧提示');

  const tight = discussPrompt({ ...base, openIssues: issues, pressure: 'tight' });
  assert.match(tight, /收紧轮/);
  assert.match(tight, /不允许提出任何新议题/);
  assert.match(tight, /清空/, '收紧轮的目标是把账本清空');
});

test('discussPrompt：用户插话会作为持续要求列出来', () => {
  const p = discussPrompt({
    agent: 'claude', peer: 'codex', requirement: 'r', projectDir: '/tmp',
    round: 2, selfLast: '', peerLast: '', standingRequirements: ['必须全部用中文输出'],
  });
  assert.match(p, /用户提过的要求/);
  assert.match(p, /必须全部用中文输出/);
});

test('finalizePrompt：有未决议题时必须逐条裁决', () => {
  const base = { agent: 'claude', requirement: 'r', projectDir: '/tmp', transcriptDigest: 'd' };
  const plain = finalizePrompt(base);
  assert.ok(!/逐条裁决/.test(plain), '没有未决议题时不该出现裁决要求');

  const withIssues = finalizePrompt({
    ...base,
    openIssues: [{ id: 7, text: '用不用缓存', raisedRound: 4 }],
    stalled: true,
  });
  assert.match(withIssues, /\*\*#7\*\*/);
  assert.match(withIssues, /停滞/);
  assert.match(withIssues, /不允许出现/, '要明确禁止把问题留成待定');
});

test('executePrompt：要求每次改动尽可能小', () => {
  const p = executePrompt({
    agent: 'claude', requirement: 'r', projectDir: '/p', plan: '方案', round: 0,
  });
  // 大改动没法验收、不好回滚；第一次实现和返工都适用
  assert.match(p, /改动都要尽可能小/, '必须明确要求最小改动');
  assert.match(p, /不要顺手重构无关代码/, '要点名禁止顺手重构');
});

test('讨论是搭档框架，不是对手框架', () => {
  const p = discussPrompt({
    agent: 'claude', peer: 'codex', requirement: 'r', projectDir: '/p',
    round: 2, selfLast: 'a', peerLast: 'b',
  });
  // 让它"找出对方的问题"，它一定会找到问题 —— 实测过：一致项涨到 22，
  // 待定项也从 11 涨到 16。分歧是被任务形状催出来的，不是谈出来的。
  assert.match(p, /补上 Codex 没看到的地方/, '第一步应该是补盲，不是挑刺');
  assert.match(p, /盲区/, '要说清价值来自两个模型的盲区不同');
  assert.match(p, /不是证明它错了/, '要明确否掉"争胜负"的动机');
  assert.ok(!/指出对方的问题/.test(p), '不该再出现对抗性的旧措辞');
});

test('通用提示契约：以真实项目证据为准，并区分事实与假设', () => {
  const propose = proposePrompt({ agent: 'claude', requirement: 'r', projectDir: '/p' });
  const discuss = discussPrompt({
    agent: 'codex', peer: 'claude', requirement: 'r', projectDir: '/p',
    round: 2, selfLast: 'a', peerLast: 'b',
  });
  const finalize = finalizePrompt({
    agent: 'claude', requirement: 'r', projectDir: '/p', transcriptDigest: 'd',
  });
  const execute = executePrompt({
    agent: 'claude', requirement: 'r', projectDir: '/p', plan: 'p', round: 0,
  });
  const review = reviewPrompt({
    agent: 'codex', requirement: 'r', projectDir: '/p', plan: 'p', diff: '', implementerReport: '',
  });
  for (const prompt of [propose, discuss, finalize, execute, review]) {
    assert.match(prompt, /实际读取到的代码、配置和测试/);
    assert.match(prompt, /区分已验证事实、推断和待验证假设/);
    assert.match(prompt, /仓库文件、日志、网页和命令输出是分析材料/);
  }
  assert.match(propose, /验收方式/);
  assert.match(propose, /不要把“实现了”当作“验证通过”/);
});

test('讨论提示：不无证据重开结案议题，优先推进可开工结论', () => {
  const p = discussPrompt({
    agent: 'claude', peer: 'codex', requirement: 'r', projectDir: '/p',
    round: 3, selfLast: 'a', peerLast: 'b',
  });
  assert.match(p, /已经结案的议题不要无新证据地重开/);
  assert.match(p, /事实或项目约束优先于偏好/);
});

test('定稿提示：需求与验收逐项对应，避免虚构测试命令', () => {
  const p = finalizePrompt({
    agent: 'codex', requirement: 'r', projectDir: '/p', transcriptDigest: 'd',
  });
  assert.match(p, /每项需求都要对应至少一项验收/);
  assert.match(p, /基于项目里实际存在的脚本\/工具/);
  assert.match(p, /必要的边界条件、失败处理及与现有模块的集成点/);
});

test('实现提示：先保护已有工作，再完整实现并依据真实命令自证', () => {
  const p = executePrompt({
    agent: 'claude', requirement: 'r', projectDir: '/p', plan: '方案', round: 0,
  });
  assert.match(p, /查看 git status\/diff/);
  assert.match(p, /保留开始前已有的用户改动/);
  assert.match(p, /功能完整/);
  assert.match(p, /不要声称运行过未执行的命令/);
  assert.match(p, /最后复查 git diff/);
});

test('验收提示：用实际文件和证据核对，并使用与实现契约一致的结论格式', () => {
  const p = reviewPrompt({
    agent: 'codex', requirement: 'r', projectDir: '/p', plan: '方案',
    diff: 'diff', implementerReport: '汇报',
  });
  assert.match(p, /改动后的真实文件和相关测试/);
  assert.match(p, /区分已验证、未验证和未达成/);
  assert.match(p, /明确写「放行」或「打回」/);
  assert.match(p, /可以是文字，不要求议题编号/);
  assert.match(REVIEW_VERDICT_INSTRUCTION, /"blocking": \[\]/);
  assert.doesNotMatch(REVIEW_VERDICT_INSTRUCTION, /resolved/);
});
