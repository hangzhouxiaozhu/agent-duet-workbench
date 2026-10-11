/**
 * 生成界面截图（浅色 / 深色 × 新建面板 / 会话视图）。
 *
 * 跑在临时目录和合成会话上，不碰真实数据、不调用模型。
 * 运行：node test/screenshots.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs');
fs.mkdirSync(OUT, { recursive: true });

/* ---------- 隔离数据目录 + 合成会话 ---------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-duet-workbench-shot-'));
process.env.AGENT_DUET_WORKBENCH_SESSIONS_DIR = path.join(tmp, 'sessions');

const project = path.join(tmp, 'project');
fs.mkdirSync(project, { recursive: true });
const git = (...a) => execFileSync('git', a, { cwd: project, encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(project, 'index.html'), 'old\n');
git('init', '-q'); git('add', '-A');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
const BASE_SHA = git('rev-parse', 'HEAD');
fs.writeFileSync(path.join(project, 'index.html'), 'new headline\nextra line\n');

const store = await import('../src/session.mjs');
const SID = 'shot-0001';
store.createSession({
  id: SID,
  requirement: '把首屏改到能在 3 秒内说清卖点，移动端不能有横向滚动，转化按钮要出现在折叠线以上。',
  projectDir: project,
  settings: { maxRounds: 3, leadAgent: 'claude', allowWrite: true },
  status: 'completed', phase: 'completed', baseSha: BASE_SHA,
});
const ev = (e) => store.appendEvent(SID, e);
ev({ type: 'session.start', requirement: '把首屏改到能在 3 秒内说清卖点', projectDir: project, leadAgent: 'claude', peerAgent: 'codex' });
ev({ type: 'phase', phase: 'propose', round: 1, label: '独立作答' });
ev({ type: 'turn.start', agent: 'claude', phase: 'propose', round: 1 });
ev({ type: 'tool', agent: 'claude', phase: 'propose', round: 1, name: 'Read', detail: 'index.html', state: 'done' });
ev({ type: 'message', agent: 'claude', phase: 'propose', round: 1, text: '## 现状\n首屏只有一句 slogan，**没有说清卖点**。\n\n- 缺少可量化的主张\n- 移动端 375px 下有横向滚动\n\n建议先固定标题层级，再处理溢出。' });
ev({ type: 'turn.end', agent: 'claude', phase: 'propose', round: 1, ok: true });
ev({ type: 'turn.start', agent: 'codex', phase: 'propose', round: 1 });
ev({ type: 'tool', agent: 'codex', phase: 'propose', round: 1, name: 'Bash', detail: 'grep -n viewport index.html', state: 'done' });
ev({ type: 'message', agent: 'codex', phase: 'propose', round: 1, text: '同意。另外补三点：\n\n1. 缺 `viewport` meta，横向滚动的根因在这\n2. CTA 在 375px 下被挤到折叠线以下\n3. 建议把主标题压到 2 行以内' });
ev({ type: 'phase', phase: 'discuss', round: 2, label: '交叉讨论' });
ev({ type: 'consensus', round: 2, converged: false, agreements: ['都要先修 viewport', 'CTA 必须进折叠线'], disagreements: ['侧边栏是否保留'], blocking: ['还没有确定主标题文案'], reason: 'Claude 认为尚未收敛' });
ev({ type: 'phase', phase: 'discuss', round: 3, label: '交叉讨论' });
ev({ type: 'consensus', round: 3, converged: true, agreements: ['都要先修 viewport', 'CTA 必须进折叠线', '主标题压到 2 行'], disagreements: ['侧边栏用 IIFE 还是模块封装'], blocking: [], reason: '双方均判定可以开工，无阻塞项（保留 1 条非阻塞分歧）' });
ev({ type: 'phase', phase: 'finalize', round: 3, label: '方案定稿' });
ev({ type: 'plan', markdown: '# 实施方案\n\n## 目标\n3 秒内说清卖点，移动端无横向滚动。\n\n## 改动\n1. `index.html` 补 `viewport` meta\n2. 主标题改为可量化主张，压到 2 行\n3. CTA 提到折叠线以上\n\n| 文件 | 改动 |\n| --- | --- |\n| `index.html` | 结构 + 文案 |\n| `styles.css` | 溢出与断点 |\n' });
ev({ type: 'phase', phase: 'execute', round: 3, label: '动手实现' });
ev({ type: 'diff', phase: 'final', diff: 'diff --git a/index.html b/index.html\n--- a/index.html\n+++ b/index.html\n@@ -1,5 +1,7 @@\n-<meta name="viewport" content="width=1024">\n+<meta name="viewport" content="width=device-width, initial-scale=1">\n <h1>We build things</h1>\n-<p>Welcome to our website.</p>\n+<p>把交付周期从 6 周压到 6 天。</p>\n+<a class="cta" href="#start">开始免费试用</a>\n', files: [{ path: 'index.html', status: 'M' }, { path: 'styles.css', status: 'M' }] });
ev({ type: 'phase', phase: 'review', round: 3, label: '交叉验收' });
ev({ type: 'review.verdict', round: 3, fixRound: 0, rejected: false, verdict: { converged: true, blocking: [] } });
ev({ type: 'session.end', status: 'completed', outcome: 'done' });

/* ---------- 起服务 + 无头 Chrome ---------- */

const { createServer } = await import('../src/server.mjs');
const PORT = 8891;
const server = createServer({ port: PORT });
await new Promise((r) => server.once('listening', r));

const CHROME = [
  process.env.AGENT_DUET_WORKBENCH_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

if (!CHROME) { console.error('找不到 Chrome'); server.close(); process.exit(1); }

const DEBUG = 9402;
// 脚本被中断时也要把无头 Chrome 带走 —— 否则它会一直占着调试端口，
// 下一次运行就会连到那个旧实例上，卡住不动（实际踩过）。
const killChrome = () => { try { chrome.kill(); } catch { /* 已退出 */ } };
process.on('exit', killChrome);
process.on('SIGINT', () => { killChrome(); process.exit(130); });
process.on('SIGTERM', () => { killChrome(); process.exit(143); });

const chrome = spawn(CHROME, [
  '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${path.join(tmp, 'chrome')}`,
  '--window-size=1560,1200', `http://127.0.0.1:${PORT}/`,
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 50; i += 1) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (target) break;
  } catch { /* 还没起来 */ }
}
if (!target) { console.error('无法连接 Chrome'); chrome.kill(); server.close(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const x = JSON.parse(m.data); if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); } };
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1560, height: 1200, deviceScaleFactor: 2, mobile: false });
await sleep(2500);

async function shoot(name) {
  await sleep(600);
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  console.log(`  ✔ ${path.relative(ROOT, file)}  (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
}

async function setTheme(pref) {
  await evaluate(`localStorage.setItem('agent-duet-workbench-theme','${pref}');
    (function(){ var d = ${pref === 'dark'};
      document.documentElement.dataset.theme = d ? 'dark' : 'light';
      document.documentElement.dataset.themePref = '${pref}';
      var i = document.getElementById('themeIcon'); if (i) i.textContent = d ? '☾' : '☀';
    })();`);
  await sleep(400);
}

console.log('\n生成截图\n');

// 新建面板
await evaluate(`location.hash = ''`); await sleep(800);
for (const t of ['light', 'dark']) {
  await setTheme(t);
  await shoot(`screenshot-setup-${t}.png`);
}

// 会话视图
await evaluate(`location.hash = '#/s/${SID}'`); await sleep(2500);
for (const t of ['light', 'dark']) {
  await setTheme(t);
  await shoot(`screenshot-session-${t}.png`);
}

chrome.kill(); server.close();
await sleep(200);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n完成。\n');
