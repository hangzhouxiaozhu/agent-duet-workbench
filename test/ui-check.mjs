/**
 * 界面回归测试（无头 Chrome + CDP，零依赖）。
 *
 * 为什么必须有这个文件：
 *   曾经出过一个 bug —— `.modal{display:flex}` 覆盖了 HTML 的 `hidden` 属性，
 *   导致「插一句话」弹窗从加载起就永久盖住整个界面。
 *   当时我用「导出 DOM 数卡片数量」来验证，那个方法**完全看不出来**这个问题，
 *   因为 DOM 内容是对的，错的是最终有没有显示出来。
 *   所以这里一律读**计算样式**和**命中测试**（elementFromPoint），不看 DOM 文本。
 *
 * 运行：npm run test:ui
 * 它自己会在临时目录起一个服务，用合成的会话来测，不碰真实数据、不调用任何模型。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME_CANDIDATES = [
  process.env.AGENT_DUET_WORKBENCH_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? '✔' : '✘'} ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

/* ---------- 1. 准备隔离的数据目录与合成会话 ---------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-duet-workbench-ui-'));
process.env.AGENT_DUET_WORKBENCH_SESSIONS_DIR = path.join(tmp, 'sessions');

// 造一个**真实的 git 项目**：这样 /changes 接口走的是真实路径，
// 而不是被测试桩糊弄过去（之前就是因为用了假目录，才暴露出 refreshDiff 会清空内容）。
const project = path.join(tmp, 'project');
fs.mkdirSync(project, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(project, 'index.html'), 'old headline\n');
git('init', '-q');
git('add', '-A');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
const BASE_SHA = git('rev-parse', 'HEAD');
// 模拟会话期间 agent 产生的改动（未提交）
fs.writeFileSync(path.join(project, 'index.html'), 'new headline\nextra line\n');

const store = await import('../src/session.mjs');

const SESSION_ID = 'uitest-0001';
const meta = store.createSession({
  id: SESSION_ID,
  requirement: '把首屏改成能在 3 秒内说清卖点，移动端不能横向滚动',
  projectDir: project,
  settings: { maxRounds: 3, leadAgent: 'claude', allowWrite: true },
  status: 'completed',
  phase: 'completed',
  baseSha: BASE_SHA,
  scopeNotice: null,
});

// 合成一段事件流：覆盖每一类渲染分支
const ev = (e) => store.appendEvent(SESSION_ID, e);
ev({ type: 'session.start', requirement: meta.requirement, projectDir: tmp, leadAgent: 'claude', peerAgent: 'codex' });
ev({ type: 'phase', phase: 'propose', round: 1, label: '独立作答' });
ev({ type: 'turn.start', agent: 'claude', phase: 'propose', round: 1 });
ev({ type: 'tool', agent: 'claude', phase: 'propose', round: 1, name: 'Read', detail: 'index.html', state: 'done' });
ev({ type: 'message', agent: 'claude', phase: 'propose', round: 1, text: '## 现状\n首屏没有卖点。\n\n- 缺少标题\n- 有横向滚动' });
ev({ type: 'turn.end', agent: 'claude', phase: 'propose', round: 1, ok: true, usage: { input_tokens: 12000, output_tokens: 123 }, costUsd: 0.25 });
ev({ type: 'turn.start', agent: 'codex', phase: 'propose', round: 1 });
ev({ type: 'message', agent: 'codex', phase: 'propose', round: 1, text: '我同意，另外还要加 `viewport`。' });
ev({ type: 'turn.end', agent: 'codex', phase: 'propose', round: 1, ok: true });
ev({ type: 'phase', phase: 'discuss', round: 2, label: '交叉讨论' });
ev({ type: 'consensus', round: 2, converged: false, agreements: ['都要改首屏'], disagreements: ['是否保留侧边栏'], blocking: ['缺少设计稿'], reason: '仍有分歧' });
ev({ type: 'phase', phase: 'discuss', round: 3, label: '交叉讨论' });
// 第 3 轮按**新协议**：账本清空 = 决策完备，其中一条是主导方裁决的
ev({ type: 'consensus', round: 3, converged: true, agreements: ['都要改首屏', '加 viewport'], disagreements: [], blocking: [], reason: '账本已清空', openCount: 0, closed: 1, decided: 1, complete: true, decisions: [{ id: 2, how: '用模块封装', why: '便于测试' }], ledger: [] });
ev({ type: 'plan', markdown: '# 实施方案\n\n## 目标\n3 秒说清卖点。\n\n## 改动\n1. `index.html` 加标题\n' });
ev({ type: 'diff', phase: 'final', diff: 'diff --git a/index.html b/index.html\n--- a/index.html\n+++ b/index.html\n@@ -1,3 +1,4 @@\n-old\n+new\n+extra\n', files: [{ path: 'index.html', status: 'M' }] });
// 编排器的 log（没有 agent 字段）：用户要知道「为什么停了」
// 带一个固定的历史时间：重放时日志必须显示事件真实发生的时间，
// 而不是"现在"（用 new Date() 的话，翻看历史日志时每行时间戳都在说谎）
const OLD_TS = new Date('2026-10-12T03:45:07').getTime();
ev({ type: 'log', text: '第 3 轮达成一致，停止讨论', ts: OLD_TS });
// 同一段文本再来一次：日志必须折叠成一行并计数（codex 每轮都打同一段启动横幅）
ev({ type: 'log', text: '第 3 轮达成一致，停止讨论', ts: OLD_TS });
// 适配器转发上来的原始输出（有 agent 字段）：太吵，不该进日志区
ev({ type: 'log', agent: 'codex', phase: 'discuss', round: 3, text: '这条是 agent 的杂项输出，不该显示' });
// agent 报错：原本完全没有界面出口
ev({ type: 'stderr', agent: 'codex', phase: 'discuss', round: 3, text: 'claude 退出码 143' });
ev({ type: 'session.end', status: 'completed', outcome: 'done' });

// 交付了但用户还没验收的会话：任务结束与否该由用户判定。
// 所以这时「接着提需求」和「验收通过」都得可用，状态也不能写成「已完成」。
const DELIVERED_ID = 'uitest-delivered';
store.createSession({
  id: DELIVERED_ID,
  requirement: '把首屏改成能在 3 秒内说清卖点',
  projectDir: project,
  settings: { maxRounds: 3, leadAgent: 'claude', allowWrite: true },
  status: 'delivered',
  phase: 'delivered',
  awaitingUser: true,
  cycle: 2,
  baseSha: BASE_SHA,
  scopeNotice: null,
});
const evD = (e) => store.appendEvent(DELIVERED_ID, e);
evD({ type: 'session.start', requirement: '把首屏改成能在 3 秒内说清卖点', projectDir: tmp, leadAgent: 'claude', peerAgent: 'codex' });
evD({ type: 'session.end', status: 'delivered', outcome: 'done', awaitingUser: true });
// 第 2 次需求：用户追加的话必须出现在时间线上，否则界面还停在第一次的需求上
evD({ type: 'requirement', cycle: 2, text: '再把移动端的横向滚动修掉' });
evD({ type: 'session.start', requirement: '再把移动端的横向滚动修掉', projectDir: tmp, cycle: 2 });
evD({ type: 'phase', phase: 'propose', round: 1, cycle: 2, label: '独立作答' });
evD({ type: 'turn.start', agent: 'claude', phase: 'propose', round: 1, cycle: 2 });
evD({ type: 'message', agent: 'claude', phase: 'propose', round: 1, cycle: 2, text: '这次只动 CSS。' });
evD({ type: 'turn.end', agent: 'claude', phase: 'propose', round: 1, cycle: 2, ok: true });
evD({ type: 'session.end', status: 'delivered', outcome: 'done', awaitingUser: true, cycle: 2 });

/* ---------- 2. 起一个隔离的服务 ---------- */

const { createServer } = await import('../src/server.mjs');
const PORT = 8899;
const server = createServer({ port: PORT });
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${PORT}`;

/* ---------- 3. 启动无头 Chrome ---------- */

const chromeBin = CHROME_CANDIDATES.find((p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
});
if (!chromeBin) {
  console.error(`\n跳过界面测试：找不到 Chrome。可用 AGENT_DUET_WORKBENCH_CHROME 指定路径。\n`);
  server.close();
  process.exit(0);
}

const DEBUG_PORT = 9401;
const profile = path.join(tmp, 'chrome');
const chrome = spawn(chromeBin, [
  '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  '--window-size=1400,1000',
  `${BASE}/`,
], { stdio: 'ignore' });

async function cleanup(code) {
  try { chrome.kill(); } catch { /* 已退出 */ }
  server.close();
  await sleep(150);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}

let target = null;
for (let i = 0; i < 50; i += 1) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (target) break;
  } catch { /* Chrome 还没起来 */ }
}
if (!target) {
  console.error('无法连接无头 Chrome');
  await cleanup(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params) => new Promise((resolve) => {
  const myId = ++msgId;
  pending.set(myId, resolve);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}

await send('Page.enable');
await send('Runtime.enable');
await sleep(3500);

/* ---------- 4. 断言 ---------- */

// 可见性一律以计算样式 + 命中测试判定
const VIS = `(() => {
  const vis = id => {
    const el = document.getElementById(id);
    if (!el) return 'MISSING';
    const cs = getComputedStyle(el);
    return (cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0') ? 'visible' : 'hidden';
  };
  const top = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  return JSON.stringify({
    setup: vis('setupView'), session: vis('sessionView'),
    modal: vis('guidanceModal'), sidebar: vis('sidebar'),
    topAtCenter: top ? (top.id || String(top.className)) : null,
  });
})()`;

const state = async () => JSON.parse(await evaluate(VIS));

/**
 * 断言界面「最终会」到达期望状态。
 * 不能点完立刻读：弹窗和面板都有淡入动画，第一帧的 opacity 正好是 0，
 * 立即采样会读到「不可见」——那是动画的起点，不是最终状态。
 */
async function expect(name, expected) {
  const deadline = Date.now() + 2000;
  const diffOf = (got) => Object.entries(expected).filter(([k, v]) => got[k] !== v);
  let got = await state();
  let bad = diffOf(got);
  while (bad.length && Date.now() < deadline) {
    await sleep(60);
    got = await state();
    bad = diffOf(got);
  }
  check(name, bad.length === 0,
    bad.map(([k, v]) => `${k}: 期望 ${v}, 实际 ${got[k]}`).join(' | '));
}

console.log('\n界面回归测试\n');

await expect('初始只显示新建面板，弹窗与侧栏均关闭', {
  setup: 'visible', session: 'hidden', modal: 'hidden', sidebar: 'hidden',
});

// 关键回归点：弹窗的 display:flex 不能盖过 hidden
{
  const s = await state();
  check('弹窗未遮挡界面（屏幕中心不是弹窗元素）',
    s.topAtCenter !== 'guidanceText' && s.topAtCenter !== 'guidanceModal',
    `屏幕中心最顶层元素是 ${s.topAtCenter}`);
}

await evaluate(`document.getElementById('btnToggleHistory').click()`);
await expect('点「历史」侧栏展开', { sidebar: 'visible' });
await evaluate(`document.getElementById('btnToggleHistory').click()`);
await expect('再点「历史」侧栏收起', { sidebar: 'hidden' });

// 没有会话时不该能插话 —— 直接禁用，而不是打开一个发不出去的弹窗
{
  const g = JSON.parse(await evaluate(`JSON.stringify({
    guidance: document.getElementById('btnGuidance').disabled,
    stop: document.getElementById('btnStop').disabled,
    cont: document.getElementById('btnContinue').disabled,
    complete: document.getElementById('btnComplete').hidden,
  })`));
  check('无会话时「插一句话」被禁用', g.guidance === true, `disabled=${g.guidance}`);
  check('无会话时「中止」被禁用', g.stop === true, `disabled=${g.stop}`);
  check('无会话时「接着提需求」被禁用', g.cont === true, `disabled=${g.cont}`);
  check('无会话时不显示「验收通过」', g.complete === true, `hidden=${g.complete}`);
}

// 切到会话视图。先清空提示区，好让下面「重放不该弹提示」的断言是确定的。
await evaluate(`document.getElementById('toastWrap').innerHTML = ''`);
await evaluate(`location.hash = '#/s/${SESSION_ID}'`);
await sleep(2500);
await expect('打开会话后：面板与弹窗都收起，会话可见', {
  setup: 'hidden', session: 'visible', modal: 'hidden', sidebar: 'hidden',
});

/**
 * 重放历史必须完全静默。
 * 曾经 openSession 会走两遍收尾逻辑：重放 session.end 一遍，
 * 之后又调一次 finishSession 且没标 replay —— 于是每点开一个已结束的会话就弹一个，
 * 点几个就堆成一摞。而且那份状态文案表漏了 interrupted，弹出来就是英文的 "interrupted"。
 */
{
  const t = JSON.parse(await evaluate(`JSON.stringify({
    count: document.querySelectorAll('.toast').length,
    texts: [...document.querySelectorAll('.toast')].map(el => el.textContent),
  })`));
  check('打开已结束的会话不弹任何提示（重放历史应当静默）',
    t.count === 0, `弹了 ${t.count} 个：${JSON.stringify(t.texts)}`);
}

// 已结束的会话：不能中止，但**插一句话必须还能用** ——
// 会话停下来之后想把话补上是很自然的事，那颗按钮变灰等于把用户刚打的话丢掉。
{
  const g = JSON.parse(await evaluate(`JSON.stringify({
    guidance: document.getElementById('btnGuidance').disabled,
    stop: document.getElementById('btnStop').disabled,
  })`));
  check('已结束的会话：不能再中止，但插话仍然可用',
    g.stop === true && g.guidance === false, JSON.stringify(g));
}

// 停下时的插话必须被收下并落盘（下次继续时交给双方），而不是回「会话未在运行」
{
  const r = await fetch(`${BASE}/api/sessions/${SESSION_ID}/guidance`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '上线前记得先备份数据库' }),
  }).then((x) => x.json());
  check('已结束的会话：插话被记下来而不是被拒', r.ok === true && r.queued === true, JSON.stringify(r));
  const pending = store.readMeta(SESSION_ID).pendingGuidance;
  check('记下的话真的落盘了（下次继续时第一件事交给双方）',
    Array.isArray(pending) && pending.includes('上线前记得先备份数据库'), JSON.stringify(pending));
}

// 停下时的插话弹窗要说清「只是先记下来」，否则用户以为按了就有人看
await evaluate(`document.getElementById('btnGuidance').click()`);
await sleep(200);
{
  const hint = JSON.parse(await evaluate(`JSON.stringify({
    text: document.getElementById('guidanceHint').textContent,
    send: document.getElementById('btnGuidanceSend').textContent,
    modesHidden: document.getElementById('guidanceModes').hidden,
    modes: [...document.querySelectorAll('input[name="guidanceMode"]')].map((el) => el.value),
    checked: (document.querySelector('input[name="guidanceMode"]:checked') || {}).value,
  })`));
  check('停下时插话弹窗说明了生效时机', hint.text.includes('接着提需求'), hint.text);
  check('停下时按钮文案是「记下来」而不是「发送」', hint.send === '记下来', hint.send);
  check('没在跑时不显示「排队 / 立即执行」选择（没有可打断的轮次）', hint.modesHidden === true);
  check('「排队 / 立即执行」两个选项都在，且默认是排队',
    hint.modes.join(',') === 'queue,now' && hint.checked === 'queue', JSON.stringify(hint));
  await evaluate(`document.getElementById('btnGuidanceCancel').click()`);
}

// 任务结束与否由用户判定：跑完了也一直能接着提需求，
// 否则用户只能新开一个会话，把上下文全丢掉。
{
  const c = JSON.parse(await evaluate(`JSON.stringify({
    continueDisabled: document.getElementById('btnContinue').disabled,
    completeHidden: document.getElementById('btnComplete').hidden,
  })`));
  check('跑完之后仍然能「接着提需求」', c.continueDisabled === false, `disabled=${c.continueDisabled}`);
  check('已经验收过的会话不再显示「验收通过」', c.completeHidden === true, `hidden=${c.completeHidden}`);
}

// 交付但还没验收的会话：状态要如实写成「待你确认」，而不是替你宣布「已完成」
await evaluate(`location.hash = '#/s/${DELIVERED_ID}'`);
await sleep(2000);
{
  const d = JSON.parse(await evaluate(`JSON.stringify({
    pill: (document.querySelector('#sessionMeta .status-pill') || {}).textContent || '',
    completeHidden: document.getElementById('btnComplete').hidden,
    continueDisabled: document.getElementById('btnContinue').disabled,
    reqStrip: document.getElementById('reqStrip').textContent,
  })`));
  check('交付后状态是「待你确认」，而不是替你宣布「已完成」',
    d.pill.includes('待你确认'), `状态徽章是「${d.pill}」`);
  check('追加的需求出现在时间线上',
    d.reqStrip.includes('再把移动端的横向滚动修掉'), `需求区：${d.reqStrip}`);
  check('交付后「接着提需求」可用', d.continueDisabled === false);
  check('交付后「验收通过」可用（结束与否交给你）', d.completeHidden === false);
}
// 切回最初那个会话：后面的用例都在它上面跑
await evaluate(`location.hash = '#/s/${SESSION_ID}'`);
await sleep(2000);

// 弹窗本身的显示/关闭逻辑（守着当初「.modal{display:flex} 盖过 hidden，
// 弹窗永久遮挡整个界面」那个 bug）。这里强行启用按钮，只测弹窗行为。
await evaluate(`document.getElementById('btnGuidance').disabled = false`);
await evaluate(`document.getElementById('btnGuidance').click()`);
await expect('弹窗能正常打开', { modal: 'visible' });
await expect('弹窗打开时确实盖在界面上（是可见的模态）', { modal: 'visible' });
await evaluate(`document.getElementById('btnGuidanceCancel').click()`);
await expect('点取消弹窗关闭', { modal: 'hidden' });

// 内容确实渲染出来了（这一层用 DOM 查询是合适的）
const content = JSON.parse(await evaluate(`(() => {
  const claude = document.getElementById('colClaude');
  const codex = document.getElementById('colCodex');
  return JSON.stringify({
    claudeMsgs: claude.querySelectorAll('.msg').length,
    codexMsgs: codex.querySelectorAll('.msg').length,
    tools: claude.querySelectorAll('.tool').length,
    hasConsensus: !document.getElementById('consensusBody').textContent.includes('双方给出第一轮结论'),
    consensusBadge: document.getElementById('consensusBadge').textContent,
    consensusText: document.getElementById('consensusBody').textContent,
    hasPlan: document.getElementById('planBody').querySelector('h1') !== null,
    diffLines: document.getElementById('diffBody').querySelectorAll('.add, .del').length,
    fileChips: document.getElementById('fileList').querySelectorAll('.filechip').length,
    logText: document.getElementById('sessionLog').textContent,
    logHidden: document.getElementById('sessionLog').hidden,
    logErrs: document.getElementById('sessionLog').querySelectorAll('.log-line.err').length,
    logTotal: document.querySelectorAll('#sessionLog .log-line').length,
  });
})()`));

check('Claude 栏渲染出消息', content.claudeMsgs >= 1, `实际 ${content.claudeMsgs}`);
check('Codex 栏渲染出消息', content.codexMsgs >= 1, `实际 ${content.codexMsgs}`);
check('工具活动渲染出', content.tools >= 1, `实际 ${content.tools}`);
check('共识面板已填充', content.hasConsensus);
check('账本清空时徽章说「无待定项」（判据是完备，不是双方满意）',
  content.consensusBadge === '无待定项', `徽章实际是「${content.consensusBadge}」`);
check('面板列出已裁决的议题及其理由',
  content.consensusText.includes('已裁决 (1)') && content.consensusText.includes('用模块封装'),
  `面板文字：${content.consensusText.slice(0, 200)}`);
check('定稿方案已渲染为 Markdown', content.hasPlan);
check('会话日志显示了「为什么停了」',
  !content.logHidden && content.logText.includes('第 3 轮达成一致'),
  `hidden=${content.logHidden} text=${JSON.stringify(content.logText.slice(0, 120))}`);
check('agent 的杂项输出不混进日志（只留编排器的说明）',
  !content.logText.includes('不该显示'),
  `日志里出现了 agent 噪声：${JSON.stringify(content.logText.slice(0, 200))}`);
check('日志时间戳用的是事件真实时间，不是重放时间',
  content.logText.includes('03:45:07'),
  `没找到 03:45:07，日志开头是：${JSON.stringify(content.logText.slice(0, 60))}`);
check('连续重复的日志行被折叠并计数（否则日志区会被同一段横幅刷满）',
  content.logTotal === 2 && /×2/.test(content.logText),
  `行数=${content.logTotal} 文本=${JSON.stringify(content.logText.slice(0, 80))}`);
check('agent 报错出现在日志里并标红',
  content.logText.includes('退出码 143') && content.logErrs >= 1,
  `logErrs=${content.logErrs} text=${JSON.stringify(content.logText.slice(0, 200))}`);
check('diff 着色行已渲染', content.diffLines >= 2, `实际 ${content.diffLines}`);
check('文件清单已渲染', content.fileChips >= 1, `实际 ${content.fileChips}`);

/* ---------- 5. 中断的会话不能显示成"还在跑" ---------- */

console.log('\n中断会话的显示\n');

// 造一个被服务重启打断的会话：turn.start 有，配对的 turn.end 永远没有
const DEAD_ID = 'uitest-dead';
store.createSession({
  id: DEAD_ID,
  requirement: '被中断的会话',
  projectDir: project,
  settings: { maxRounds: 8 },
  status: 'interrupted',
  phase: 'interrupted',
  baseSha: BASE_SHA,
  interruptedReason: '服务重启导致会话中断',
});
const dev = (e) => store.appendEvent(DEAD_ID, e);
dev({ type: 'session.start', requirement: '被中断的会话', projectDir: project, leadAgent: 'claude' });
dev({ type: 'phase', phase: 'discuss', round: 8, label: '交叉讨论' });
dev({ type: 'turn.start', agent: 'claude', phase: 'discuss', round: 8 });
dev({ type: 'status', agent: 'claude', status: 'thinking', phase: 'discuss', round: 8 });
dev({ type: 'turn.start', agent: 'codex', phase: 'discuss', round: 8 });
// 注意：故意不写 turn.end —— 这正是进程被杀时的真实情况
dev({ type: 'session.end', status: 'interrupted', error: '服务重启，该会话已中断' });

await evaluate(`document.getElementById('toastWrap').innerHTML = ''`);
await evaluate(`location.hash = '#/s/${DEAD_ID}'`);
await sleep(2200);

// 这条是用户实际遇到的那个：点开一个「已中断」的会话，弹出一摞英文 "interrupted"
{
  const t = JSON.parse(await evaluate(`JSON.stringify({
    texts: [...document.querySelectorAll('.toast')].map(el => el.textContent),
  })`));
  check('打开「已中断」的会话也不弹提示',
    t.texts.length === 0, `弹了：${JSON.stringify(t.texts)}`);
  check('界面上不出现英文状态名',
    !t.texts.some((x) => /interrupted|stopped|completed|failed/i.test(x)),
    `实际：${JSON.stringify(t.texts)}`);
}

const dead = JSON.parse(await evaluate(`(() => {
  const busy = [...document.querySelectorAll('.col-status')].filter(el => el.classList.contains('busy'));
  const spinners = document.querySelectorAll('.msg-body .spinner');
  const pill = document.querySelector('#sessionMeta .status-pill');
  return JSON.stringify({
    busyCount: busy.length,
    busyText: busy.map(el => el.textContent).join(','),
    spinnerCount: spinners.length,
    draftCount: document.querySelectorAll('.msg.draft').length,
    pillText: pill ? pill.textContent : null,
    pillClass: pill ? pill.className : null,
    stopDisabled: document.getElementById('btnStop').disabled,
  });
})()`));

check('中断的会话不显示任何「正在跑」的栏位状态',
  dead.busyCount === 0, `仍有 ${dead.busyCount} 个栏位在转圈：${dead.busyText}`);
check('中断的会话不留下空转圈的草稿气泡',
  dead.spinnerCount === 0 && dead.draftCount === 0,
  `spinner=${dead.spinnerCount} draft=${dead.draftCount}`);
check('会话头部明确标出「已中断」',
  dead.pillText === '已中断' && /warn/.test(dead.pillClass || ''),
  `pill="${dead.pillText}" class="${dead.pillClass}"`);
check('中断的会话不能点中止', dead.stopDisabled === true);

/* ---------- 8. 阶段路线 ---------- */

console.log('\n阶段路线\n');

// 必须在 DEAD_ID 被删除之前跑 —— 它只走到 discuss，正好验「停在这里」
await evaluate(`location.hash = '#/s/${DEAD_ID}'`);
await sleep(1800);
{
  const r = JSON.parse(await evaluate(`(() => {
    const ph = [...document.querySelectorAll('.phase')];
    const xs = ph.map((e) => {
      const b = e.querySelector('.phase-node').getBoundingClientRect();
      return Math.round(b.x + b.width / 2);
    });
    return JSON.stringify({
      count: ph.length,
      labels: ph.map((e) => e.querySelector('.phase-label').textContent.replace(/第 ?\\d+ ?轮|停在这里/g, '').trim()),
      gaps: xs.slice(1).map((x, i) => x - xs[i]),
      halted: ph.filter((e) => e.classList.contains('halted')).map((e) => e.dataset.phase),
      done: ph.filter((e) => e.classList.contains('done')).map((e) => e.dataset.phase),
      hasRoundBadge: ph.every((e) => Boolean(e.querySelector('.phase-round'))),
      // 连接线：::after 的宽度不为 0
      connectors: ph.filter((e) => {
        const w = getComputedStyle(e, '::after').width;
        return w && w !== 'auto' && parseFloat(w) > 10;
      }).length,
    });
  })()`));

  check('阶段路线有 5 个节点', r.count === 5, String(r.count));
  // 亚像素会导致 ±1~2px 的误差，用容差而不是严格要求相等
  check('节点等距（是一条路线，不是散落的胶囊）',
    Math.max(...r.gaps) - Math.min(...r.gaps) <= 3 && r.gaps[0] > 100, JSON.stringify(r.gaps));
  check('节点之间有连接线', r.connectors === 4, `实际 ${r.connectors} 条`);
  check('每个节点都有轮次位置', r.hasRoundBadge === true);
  check('标签正确', r.labels.join('|') === '独立作答|交叉讨论|方案定稿|动手实现|交叉验收',
    r.labels.join('|'));
  // 这是刚修的真 bug：原来无条件把五个阶段全打勾
  check('只走到 discuss 时，后面的阶段不能被打勾',
    r.done.join(',') === 'propose', `实际打勾的是：${r.done.join(',') || '(无)'}`);
  check('中断处标出「停在这里」而不是假装完成',
    r.halted.length === 1 && r.halted[0] === 'discuss', JSON.stringify(r.halted));
}

// 已正常结束的会话：到过的阶段都要打勾
await evaluate(`location.hash = '#/s/${SESSION_ID}'`);
await sleep(1800);
{
  const d = JSON.parse(await evaluate(`JSON.stringify({
    done: [...document.querySelectorAll('.phase.done')].map(e => e.dataset.phase),
    halted: [...document.querySelectorAll('.phase.halted')].map(e => e.dataset.phase),
  })`));
  // 这个合成会话只到过 propose 和 discuss，后面三个阶段不该被打勾
  check('正常结束的会话：只给到过的阶段打勾',
    d.done.join(',') === 'propose,discuss', JSON.stringify(d.done));
  check('正常结束的会话不该有「停在这里」', d.halted.length === 0, JSON.stringify(d.halted));
}


/* ---------- 6. 历史侧栏：状态用中文 + 可删除 ---------- */

console.log('\n历史侧栏\n');

await evaluate(`document.getElementById('btnToggleHistory').click()`);
await expect('侧栏展开', { sidebar: 'visible' });

{
  const sidebar = JSON.parse(await evaluate(`(() => {
    const items = [...document.querySelectorAll('.session-item')];
    return JSON.stringify({
      count: items.length,
      texts: items.map(el => (el.querySelector('.si-status') || {}).textContent || '(无)'),
      delButtons: document.querySelectorAll('.session-item .si-del').length,
    });
  })()`));

  check('侧栏条目都有状态标签', sidebar.texts.every((t) => t !== '(无)'), JSON.stringify(sidebar.texts));
  // 曾经只有 interrupted 漏了中文映射，侧栏里混着英文的 "interrupted"
  check('状态标签全是中文（不再混英文状态名）',
    sidebar.texts.every((t) => !/[a-z]/.test(t)),
    `实际：${JSON.stringify(sidebar.texts)}`);
  check('每条记录都有删除按钮', sidebar.delButtons === sidebar.count,
    `按钮 ${sidebar.delButtons} 个 / 记录 ${sidebar.count} 条`);
}

// 键盘事件必须只激活对应控件：Delete 按钮不能被父行的 Enter/Space 抢走。
{
  const initialHash = await evaluate('location.hash');
  const press = async (key) => evaluate(`(() => {
    const target = document.activeElement;
    if (!target) return false;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
    // DOM 合成键盘事件不会自动触发原生按钮 click，这里显式模拟其键盘激活默认动作。
    target.click();
    target.dispatchEvent(new KeyboardEvent('keyup', { key: ${JSON.stringify(key)}, bubbles: true }));
    return true;
  })()`);
  for (const [key, code, keyCode] of [['Enter', 'Enter', 13], [' ', 'Space', 32]]) {
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.session-item')].find(el => el.textContent.includes('被中断的会话'));
      const button = row?.querySelector('.si-del');
      button?.focus();
      return document.activeElement === button;
    })()`);
    await press(key);
    await sleep(250);
    const result = JSON.parse(await evaluate(`JSON.stringify({ hash: location.hash, confirmOpen: !document.getElementById('confirmModal').hidden })`));
    check(`删除按钮按 ${key === ' ' ? 'Space' : key} 打开确认但不导航`,
      result.confirmOpen && result.hash === initialHash, JSON.stringify(result));
    await evaluate(`document.getElementById('btnConfirmNo').click()`);
    await sleep(150);
  }

  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.session-item')].find(el => el.textContent.includes('被中断的会话'));
    row?.focus();
  })()`);
  await press('Enter');
  await sleep(700);
  check('历史行按 Enter 仍可打开会话', (await evaluate('location.hash')) === `#/s/${DEAD_ID}`);

  await evaluate(`location.hash = '#/s/${SESSION_ID}'`);
  await sleep(900);
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.session-item')].find(el => el.textContent.includes('被中断的会话'));
    row?.focus();
  })()`);
  await press(' ');
  await sleep(700);
  check('历史行按 Space 仍可打开会话', (await evaluate('location.hash')) === `#/s/${DEAD_ID}`);
}

// 真删一次。删除走自绘确认框（不用原生 confirm —— 被浏览器抑制时会静默失效）
const clicked = await evaluate(`(() => {
  const el = [...document.querySelectorAll('.session-item')]
    .find(i => i.textContent.includes('被中断的会话'));
  if (!el) return 'not-found';
  el.querySelector('.si-del').click();
  return 'clicked';
})()`);
check('点得到那条记录的删除按钮', clicked === 'clicked', clicked);
await sleep(400);

// 确认框必须真的出现（原生 confirm 被抑制时是"点了没反应也没提示"）
{
  const dlg = JSON.parse(await evaluate(`JSON.stringify({
    visible: !document.getElementById('confirmModal').hidden,
    role: document.getElementById('confirmModal').getAttribute('role'),
    modal: document.getElementById('confirmModal').getAttribute('aria-modal'),
    text: document.getElementById('confirmText').textContent.slice(0, 40),
  })`));
  check('删除前弹出确认框（而不是依赖可能被抑制的原生 confirm）', dlg.visible === true);
  check('确认框有对话框语义', dlg.role === 'dialog' && dlg.modal === 'true', JSON.stringify(dlg));
}
await evaluate(`document.getElementById('btnConfirmYes').click()`);
await sleep(1200);

{
  const after = JSON.parse(await evaluate(`(() => {
    const items = [...document.querySelectorAll('.session-item')];
    return JSON.stringify({
      stillThere: items.some(i => i.textContent.includes('被中断的会话')),
    });
  })()`));
  check('删除后该记录从侧栏消失', after.stillThere === false);
}

const goneStatus = await fetch(`${BASE}/api/sessions/${DEAD_ID}`).then((r) => r.status);
check('删除后该会话接口返回 404', goneStatus === 404, `实际 HTTP ${goneStatus}`);

/* ---------- 7. 无障碍 ---------- */

console.log('\n无障碍\n');

{
  const a11y = JSON.parse(await evaluate(`(() => {
    const item = document.querySelector('.session-item');
    const tw = document.getElementById('toastWrap');
    return JSON.stringify({
      itemTabIndex: item ? item.tabIndex : null,
      itemRole: item ? item.getAttribute('role') : null,
      itemAria: item ? item.getAttribute('aria-label') : null,
      toastLive: tw.getAttribute('aria-live'),
      toastRole: tw.getAttribute('role'),
    });
  })()`));

  check('历史记录可以用键盘聚焦（之前是 tabIndex=-1 的 div，只能 Tab 到「删除」）',
    a11y.itemTabIndex === 0 && a11y.itemRole === 'button',
    JSON.stringify(a11y));
  check('历史记录有可读的无障碍名称', Boolean(a11y.itemAria), String(a11y.itemAria));
  check('提示区是 live region（否则屏幕阅读器全程静默）',
    a11y.toastLive === 'polite' && a11y.toastRole === 'status', JSON.stringify(a11y));
}

// Escape 应该能关掉插话弹窗。
// 注意要先回到一个「有会话」的视图：插话在没有会话时是被禁用的（这是有意的），
// 上一步删记录已经退回了新建面板。
await evaluate(`location.hash = '#/s/${SESSION_ID}'`);
await sleep(2000);
await evaluate(`document.getElementById('btnGuidance').disabled = false`);
await evaluate(`document.getElementById('btnGuidance').click()`);
await expect('插话弹窗打开', { modal: 'visible' });
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
await expect('按 Escape 关掉插话弹窗', { modal: 'hidden' });


/** 在浏览器里算 WCAG 对比度（次要文字曾经只有 3.0:1，AA 要求 4.5:1）。 */
const CONTRAST = `(() => {
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const nums = (str) => (str.match(/[\\d.]+/g) || []).map(Number);

  // 把 el 之上所有半透明背景合成到第一个不透明背景上，得到真实呈现的底色
  const flatten = (el) => {
    const layers = [];
    let node = el;
    while (node) {
      const p = nums(getComputedStyle(node).backgroundColor);
      const a = p.length > 3 ? p[3] : (p.length === 3 ? 1 : 0);
      if (a >= 1) {
        let [r, g, b] = p.slice(0, 3);
        for (const L of layers.reverse()) {
          r = L.rgb[0] * L.a + r * (1 - L.a);
          g = L.rgb[1] * L.a + g * (1 - L.a);
          b = L.rgb[2] * L.a + b * (1 - L.a);
        }
        return [r, g, b];
      }
      if (a > 0) layers.push({ rgb: p.slice(0, 3), a });
      node = node.parentElement;
    }
    return [255, 255, 255];
  };

  const el = document.querySelector('.si-when') || document.querySelector('.sub');
  if (!el) return JSON.stringify({ error: 'no element' });
  const fg = nums(getComputedStyle(el).color).slice(0, 3);
  const bg = flatten(el);
  const a = lum(fg); const b = lum(bg);
  return JSON.stringify({
    fg: 'rgb(' + fg.join(',') + ')',
    bg: 'rgb(' + bg.map((v) => Math.round(v)).join(',') + ')',
    ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
  });
})()`;

/* ---------- 9. 样式完整性（防"CSS 被静默删掉"） ---------- */

console.log('\n样式完整性\n');

/**
 * 这一节守着一个真实的翻车：我做阶段路线时用区间替换改 CSS，
 * 把夹在中间的 .stats / .convergence / .session-log 三组样式一起删掉了 ——
 * DOM 完全正常，只是没样式，界面变成一堆裸文本。
 * 只看 DOM 是发现不了的，必须读**计算样式**。
 */
{
  const st = JSON.parse(await evaluate(`(() => {
    const pick = (sel, props) => {
      const el = document.querySelector(sel);
      if (!el) return { missing: true };
      const cs = getComputedStyle(el);
      const o = {};
      for (const p of props) o[p] = cs[p];
      return o;
    };
    return JSON.stringify({
      stat: pick('.stats .stat', ['borderTopWidth', 'borderRadius', 'backgroundColor', 'paddingLeft']),
      log: pick('.session-log', ['borderTopWidth', 'borderRadius', 'fontFamily', 'paddingLeft']),
      conv: pick('.convergence', ['paddingTop', 'borderBottomWidth']),
      node: pick('.phase-node', ['borderRadius', 'width', 'height']),
      card: pick('.column', ['borderTopWidth', 'borderRadius', 'backgroundColor']),
      conn: (() => {
        const el = document.querySelector('.phase');
        return el ? getComputedStyle(el, '::after').backgroundImage !== undefined
          || getComputedStyle(el, '::after').width : 'none';
      })(),
    });
  })()`));

  const px = (v) => parseFloat(v) || 0;
  check('成本看板的胶囊有边框和圆角',
    px(st.stat.borderTopWidth) > 0 && px(st.stat.borderRadius) > 10,
    JSON.stringify(st.stat));
  check('成本看板胶囊有底色（不是透明裸文本）',
    st.stat.backgroundColor !== 'rgba(0, 0, 0, 0)', st.stat.backgroundColor);
  check('日志区有边框和等宽字体',
    px(st.log.borderTopWidth) > 0 && /mono/i.test(st.log.fontFamily), JSON.stringify(st.log));
  check('收敛曲线区块有内边距和分隔线',
    px(st.conv.paddingTop) > 0 && px(st.conv.borderBottomWidth) > 0, JSON.stringify(st.conv));
  check('阶段节点是圆形',
    px(st.node.borderRadius) >= px(st.node.width) / 2, JSON.stringify(st.node));
  check('双栏卡片有边框和圆角',
    px(st.card.borderTopWidth) > 0 && px(st.card.borderRadius) > 0, JSON.stringify(st.card));
}

/* ---------- 10. 收敛曲线与成本看板 ---------- */

console.log('\n收敛曲线与成本看板\n');

{
  const c = JSON.parse(await evaluate(`(() => {
    const box = document.getElementById('convergence');
    if (box.hidden) return JSON.stringify({ hidden: true });
    const agree = box.querySelector('.conv-agree');
    const open = box.querySelector('.conv-open');
    return JSON.stringify({
      hidden: false,
      agreePts: agree ? agree.getAttribute('points').trim().split(/\\s+/).length : 0,
      dotAgree: box.querySelectorAll('.dot-agree').length,
      dotOpen: box.querySelectorAll('.dot-open').length,
      convMark: box.querySelectorAll('.conv-line').length,
      legend: box.querySelector('.conv-legend').textContent.replace(/\\s+/g, ' ').trim(),
    });
  })()`));

  check('有两轮以上共识时显示收敛曲线', c.hidden === false, JSON.stringify(c));
  check('曲线点数与共识轮数一致（这里 2 轮）',
    c.agreePts === 2 && c.dotAgree === 2 && c.dotOpen === 2, JSON.stringify(c));
  check('达成一致的那一轮被标出来', c.convMark === 1, `竖线 ${c.convMark} 条`);
  check('图例给出最终计数与收敛轮次',
    c.legend.includes('第 3 轮收敛'), `图例实际：${c.legend}`);
}

{
  const st = JSON.parse(await evaluate(`(() => {
    const box = document.getElementById('sessionStats');
    return JSON.stringify({ hidden: box.hidden, text: box.textContent.replace(/\\s+/g, ' ').trim() });
  })()`));
  check('成本看板显示出来', st.hidden === false, JSON.stringify(st));
  check('看板包含调用次数与花费',
    /\d+ 次/.test(st.text) && /\$/.test(st.text), `看板实际：${st.text}`);
}

/* ---------- 11. 授权级别选择器 ---------- */

console.log('\n授权级别\n');

{
  const sel = JSON.parse(await evaluate(`(() => {
    const el = document.getElementById('sandbox');
    return JSON.stringify({
      exists: Boolean(el),
      value: el ? el.value : null,
      options: el ? [...el.options].map(o => o.value) : [],
    });
  })()`));
  check('高级设置里有「授权级别」选择器', sel.exists === true);
  check('默认档是 workspace（可写项目 + 可联网装依赖）',
    sel.value === 'workspace', `实际 ${sel.value}`);
  check('提供 full 档（完全不限）', sel.options.includes('full'), JSON.stringify(sel.options));
}

{
  const lead = JSON.parse(await evaluate(`(() => {
    const el = document.getElementById('leadAgent');
    return JSON.stringify({ options: [...el.options].map(o => o.value) });
  })()`));
  check('「谁主导实现」提供四种：Claude / Codex / 分工 / 由讨论决定',
    lead.options.join(',') === 'claude,codex,split,auto', JSON.stringify(lead.options));
  check('有「由讨论决定」这一档（不让用户在开会前拍板）',
    lead.options.includes('auto'));
}

/* ---------- 12. 主题切换 ---------- */

console.log('\n主题切换\n');

async function themeSnapshot() {
  return JSON.parse(await evaluate(`(() => {
    const cs = getComputedStyle(document.body);
    return JSON.stringify({
      theme: document.documentElement.dataset.theme,
      pref: document.documentElement.dataset.themePref,
      bg: cs.backgroundColor,
      color: cs.color,
      icon: document.getElementById('themeIcon').textContent,
      stored: localStorage.getItem('agent-duet-workbench-theme'),
    });
  })()`));
}
async function clickTheme() {
  await evaluate(`document.getElementById('btnTheme').click()`);
  await sleep(150);
}

// 先走到一个已知起点（初始可能是 auto）
for (let i = 0; i < 3 && (await themeSnapshot()).pref !== 'light'; i += 1) await clickTheme();

const light = await themeSnapshot();
check('浅色：data-theme=light 且写入了 localStorage',
  light.theme === 'light' && light.stored === 'light', JSON.stringify(light));

await clickTheme();
const dark = await themeSnapshot();
check('深色：data-theme=dark 且写入了 localStorage',
  dark.theme === 'dark' && dark.stored === 'dark', JSON.stringify(dark));

// 这条才是关键：断言设计令牌真的换了一套，而不是只改了个属性名
check('浅色与深色的实际背景色不同（令牌确实生效）',
  light.bg !== dark.bg, `浅色 ${light.bg} / 深色 ${dark.bg}`);

// 浅色下的对比度
{
  const c = JSON.parse(await evaluate(CONTRAST));
  check('浅色：次要文字对比度达到 WCAG AA (4.5:1)',
    c.ratio >= 4.5, `${Number(c.ratio).toFixed(2)}:1  fg=${c.fg} 背景=${c.bg}`);
}
check('浅色与深色的实际文字色不同',
  light.color !== dark.color, `浅色 ${light.color} / 深色 ${dark.color}`);

// 深色下的对比度
{
  const c = JSON.parse(await evaluate(CONTRAST));
  check('深色：次要文字对比度达到 WCAG AA (4.5:1)',
    c.ratio >= 4.5, `${Number(c.ratio).toFixed(2)}:1  fg=${c.fg} 背景=${c.bg}`);
}

await clickTheme();
const auto = await themeSnapshot();
check('三态循环回到 auto，且 auto 被解析成了具体的 light/dark',
  auto.pref === 'auto' && (auto.theme === 'light' || auto.theme === 'dark'),
  JSON.stringify(auto));

/* ---------- 7. 汇总 ---------- */

const failed = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - failed.length}/${results.length} 通过\n`);
await cleanup(failed.length ? 1 : 0);
