import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

/**
 * 服务层的测试。
 *
 * 重点是僵尸会话对账 —— 这个 bug 的表现很误导人：
 * 界面上会话显示「正在运行」，但中止按钮是灰的、点不动，而且每次打开页面
 * 都会自动跳回这个永远跑不完的会话。根因是落盘的 status 停在了 running，
 * 而内存里其实早就没有这个会话了（上个进程留下的）。
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-duet-workbench-srv-'));
process.env.AGENT_DUET_WORKBENCH_SESSIONS_DIR = path.join(tmp, 'sessions');

// 必须先设好环境变量再动态导入：config.mjs 在导入时就读取它
const store = await import('../src/session.mjs');
const { reconcileOrphanSessions, createServer } = await import('../src/server.mjs');
const { runSession, stopSession } = await import('../src/orchestrator.mjs');

const make = (status, id) => store.createSession({
  id,
  requirement: '随便一个需求',
  projectDir: tmp,
  settings: {},
  status,
  phase: status === 'running' ? 'discuss' : 'completed',
}).id;

test('启动对账：落盘说在跑、内存里没有 → 标记为已中断', () => {
  const id = make('running', 'zombie-1');

  const orphans = reconcileOrphanSessions();
  assert.ok(orphans.includes(id), `应识别为僵尸，实际识别到 ${JSON.stringify(orphans)}`);

  const meta = store.readMeta(id);
  assert.equal(meta.status, 'interrupted');
  assert.equal(meta.phase, 'interrupted');
  assert.ok(meta.finishedAt, '应补上结束时间');
  assert.match(meta.interruptedReason, /重启/);
});

test('僵尸会话要补一条结束事件，否则前端重放后仍停在运行态', () => {
  const id = make('running', 'zombie-2');
  reconcileOrphanSessions();

  const end = store.readEvents(id).find((e) => e.type === 'session.end');
  assert.ok(end, '缺少 session.end 事件');
  assert.equal(end.status, 'interrupted');
  assert.match(end.error, /重启/);
});

test('对账是幂等的，重复启动不会反复改写', () => {
  const id = make('running', 'zombie-3');
  assert.ok(reconcileOrphanSessions().includes(id));

  const after1 = store.readMeta(id).finishedAt;
  const second = reconcileOrphanSessions();
  assert.ok(!second.includes(id), '第二次不该再动它');
  assert.equal(store.readMeta(id).finishedAt, after1, '结束时间不该被改写');
});

test('已正常结束的会话不会被误伤', () => {
  const id = make('completed', 'done-1');
  reconcileOrphanSessions();
  const meta = store.readMeta(id);
  assert.equal(meta.status, 'completed');
  assert.equal(meta.interruptedReason, undefined);
});

test('对账不碰会话的事件流（除补的那条结束事件外）', () => {
  const id = make('running', 'zombie-4');
  store.appendEvent(id, { sessionId: id, type: 'message', agent: 'claude', text: '已有的内容' });

  const before = store.readEvents(id).length;
  reconcileOrphanSessions();
  const after = store.readEvents(id);

  assert.equal(after.length, before + 1, '只应新增一条 session.end');
  assert.ok(after.some((e) => e.type === 'message' && e.text === '已有的内容'), '原有事件必须保留');
});

/* ------------------------------ 删除会话 ------------------------------ */

test('删除会话会清掉本地记录', () => {
  const id = make('completed', 'del-1');
  store.appendEvent(id, { sessionId: id, type: 'message', agent: 'claude', text: 'x' });

  const r = store.deleteSession(id);
  assert.equal(r.ok, true, r.error);
  assert.equal(store.readMeta(id), null, 'meta 应读不到了');
  assert.equal(
    fs.existsSync(path.join(process.env.AGENT_DUET_WORKBENCH_SESSIONS_DIR, id)), false,
    '目录应被删掉',
  );
});

test('删除会话绝不会碰项目目录里的文件', () => {
  // 安全底线：删的是 duet 自己的记录，不是用户的项目
  const project = fs.mkdtempSync(path.join(tmp, 'proj-'));
  fs.writeFileSync(path.join(project, 'keep-me.txt'), 'important');
  fs.mkdirSync(path.join(project, 'src'));
  fs.writeFileSync(path.join(project, 'src', 'app.js'), 'code');

  const id = store.createSession({
    id: 'del-2', requirement: 'x', projectDir: project, settings: {},
  }).id;
  store.deleteSession(id);

  assert.equal(fs.readFileSync(path.join(project, 'keep-me.txt'), 'utf8'), 'important');
  assert.equal(fs.readFileSync(path.join(project, 'src', 'app.js'), 'utf8'), 'code');
});

test('删除会话拒绝路径穿越', () => {
  for (const bad of ['..', '../..', '../../etc', 'a/b', '/tmp', '.hidden', '']) {
    const r = store.deleteSession(bad);
    assert.equal(r.ok, false, `不该接受 ${JSON.stringify(bad)}`);
  }
});

test('删除不存在的会话：返回失败而不是抛异常', () => {
  const r = store.deleteSession('does-not-exist');
  assert.equal(r.ok, false);
  assert.match(r.error, /不存在/);
});

/* ------------------------- 事件合并（性能关键路径） ------------------------- */

/**
 * delta 是流式输出的碎片。实测一个 7494 事件的会话里 7282 条是 delta（97%），
 * 而前端处理 delta 就是往同一个气泡追加文本 —— 合并后语义等价，
 * 但把打开会话的耗时从 5099ms 降到 90ms（实测 57 倍）。
 * 因为合并的是用户要看的正文，正确性要求很硬：一个字都不能丢或乱序。
 */

const d = (agent, round, text, phase = 'discuss') => ({ type: 'delta', agent, round, phase, text });

test('compactEvents：连续同 agent 的 delta 合并成一条，文本一字不差', () => {
  const input = [d('claude', 2, '你'), d('claude', 2, '好'), d('claude', 2, '呀')];
  const out = store.compactEvents(input);
  assert.equal(out.length, 1, `应合并成 1 条，实际 ${out.length}`);
  assert.equal(out[0].text, '你好呀');
  assert.equal(out[0].type, 'delta');
});

test('compactEvents：不同 agent 的 delta 不合并', () => {
  const out = store.compactEvents([d('claude', 2, 'A'), d('codex', 2, 'B')]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.text), ['A', 'B']);
});

test('compactEvents：不同轮次或阶段的 delta 不合并', () => {
  const out = store.compactEvents([
    d('claude', 2, '第2轮'),
    d('claude', 3, '第3轮A'),
    d('claude', 3, '第3轮B'),   // 与上一条同 agent 同轮同阶段 → 应该合并
    { type: 'delta', agent: 'claude', round: 3, phase: 'propose', text: '别的阶段' },
  ]);
  assert.deepEqual(out.map((e) => e.text), ['第2轮', '第3轮A第3轮B', '别的阶段']);
  assert.equal(out[0].round, 2);
  assert.equal(out[1].round, 3);
  assert.equal(out[2].phase, 'propose');
});

test('compactEvents：非 delta 事件原样保留，且顺序不变', () => {
  const input = [
    { type: 'turn.start', agent: 'claude', round: 2, phase: 'discuss' },
    d('claude', 2, 'abc'),
    { type: 'turn.end', agent: 'claude', round: 2, phase: 'discuss' },
  ];
  const out = store.compactEvents(input);
  assert.deepEqual(out.map((e) => e.type), ['turn.start', 'delta', 'turn.end']);
});

test('compactEvents：中间夹了别的事件就不会跨越合并', () => {
  const input = [
    d('claude', 2, '前'),
    { type: 'tool', agent: 'claude', round: 2, name: 'Read' },
    d('claude', 2, '后'),
  ];
  const out = store.compactEvents(input);
  assert.equal(out.length, 3, '被工具事件隔开的 delta 不能合并，否则内容顺序会错');
  assert.deepEqual(out.map((e) => e.text ?? e.type), ['前', 'tool', '后']);
});

test('compactEvents：不修改传入的对象（纯函数）', () => {
  const input = [d('claude', 2, 'A'), d('claude', 2, 'B')];
  const snapshot = JSON.stringify(input);
  store.compactEvents(input);
  assert.equal(JSON.stringify(input), snapshot, '原地改了入参，调用方拿到的数据被污染');
});

test('compactEvents：全量拼接等于原文本（不丢字）', () => {
  const chunks = Array.from({ length: 500 }, (_, i) => `片${i}-`);
  const out = store.compactEvents(chunks.map((t) => d('claude', 2, t)));
  assert.equal(out.length, 1);
  assert.equal(out[0].text, chunks.join(''));
});

test('compactEvents：空数组与单元素不出问题', () => {
  assert.deepEqual(store.compactEvents([]), []);
  assert.equal(store.compactEvents([d('claude', 1, 'x')]).length, 1);
});

/* ------------------- 事件序号（SSE 续传与去重的基础） ------------------- */

/**
 * 为什么要序号：SSE 断线重连时 EventSource 会用**同一个 URL** 重连。
 * 如果"从哪继续"是按条数算的，重连时那个数不会前进，服务端就会把
 * 已经处理过的事件全部重发 —— 消息重复渲染，而且每个 turn.start 都会
 * 再建一个气泡，留下永远转圈的幽灵。用单调递增的 seq 才能精确表达"这条我收过了"。
 */

test('appendEvent：新事件拿到递增且互不重复的 seq', () => {
  const id = make('running', 'seq-1');
  const a = store.appendEvent(id, { type: 'x' });
  const b = store.appendEvent(id, { type: 'y' });
  const c = store.appendEvent(id, { type: 'z' });
  assert.ok(Number.isFinite(a.seq), '必须带 seq');
  assert.equal(b.seq, a.seq + 1);
  assert.equal(c.seq, b.seq + 1);
});

test('readEvents：给没有 seq 的老事件按行号补号（否则续传会漏掉全部历史）', () => {
  const dir = path.join(process.env.AGENT_DUET_WORKBENCH_SESSIONS_DIR, 'legacy-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    `${JSON.stringify({ type: 'a', ts: 1 })}\n${JSON.stringify({ type: 'b', ts: 2 })}\n`,
  );
  const evs = store.readEvents('legacy-1');
  assert.deepEqual(evs.map((e) => e.seq), [1, 2]);
});

test('老事件补号后，新分配号不会和它撞（续传游标依赖这一点）', () => {
  const dir = path.join(process.env.AGENT_DUET_WORKBENCH_SESSIONS_DIR, 'legacy-2');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    `${JSON.stringify({ type: 'a', ts: 1 })}\n${JSON.stringify({ type: 'b', ts: 2 })}\n`,
  );
  // 老文件有 2 行 → 计数器应从 2 起算
  const fresh = store.appendEvent('legacy-2', { type: 'c' });
  assert.equal(fresh.seq, 3, '新事件的号必须接在老事件之后');
  const all = store.readEvents('legacy-2');
  assert.deepEqual(all.map((e) => e.seq), [1, 2, 3]);
});

test('compactEvents：合并后保留组内最大的 seq（否则续传会把整组重发）', () => {
  const out = store.compactEvents([
    { type: 'delta', agent: 'claude', round: 1, phase: 'discuss', text: 'A', seq: 10 },
    { type: 'delta', agent: 'claude', round: 1, phase: 'discuss', text: 'B', seq: 11 },
    { type: 'delta', agent: 'claude', round: 1, phase: 'discuss', text: 'C', seq: 12 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].seq, 12, '应取组内最大 seq，这样 after=12 能正确排掉整组');
});

test('续传契约：按 seq > after 过滤，既不漏也不重', () => {
  const evs = store.compactEvents([
    { type: 'turn.start', seq: 1 },
    { type: 'delta', agent: 'claude', round: 1, phase: 'discuss', text: 'A', seq: 2 },
    { type: 'delta', agent: 'claude', round: 1, phase: 'discuss', text: 'B', seq: 3 },
    { type: 'message', seq: 4 },
  ]);
  const after = (n) => evs.filter((e) => (e.seq || 0) > n).map((e) => e.seq);
  // 4 条原始事件合并成 3 条：两条 delta 拼成一条，它的 seq 取组内最大值 3
  assert.deepEqual(evs.map((e) => e.seq), [1, 3, 4]);
  assert.deepEqual(after(0), [1, 3, 4], '从头开始就是全部');
  assert.deepEqual(after(1), [3, 4], 'after=1 时那条合并后的 delta 还没发过');
  assert.deepEqual(after(3), [4], 'after=3 表示客户端已消费整组 delta，只补后面的');
  assert.deepEqual(after(4), [], 'after 到末尾就什么都不发（重连不重发）');
});

/* ------------- 多实例：不能把别的进程正在跑的会话当孤儿 ------------- */

/**
 * reconcileOrphanSessions 原先只看「本进程内存里有没有 runtime」。
 * 但 runtime 只存在于**拥有它的那个进程**里 —— 于是开第二个实例时，
 * 它会把第一个实例正在跑的会话标成「已中断」，还往事件流里插一条假的 session.end
 * （前端重放到它就会结束会话，时间线自相矛盾），而那个会话其实还在烧额度。
 * 触发路径是工具自己教的：端口被占用时提示换端口。
 */
test('别的进程还在跑的会话不能被当成孤儿', () => {
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const id = 'live-other';
    store.createSession({
      id, requirement: 'x', projectDir: tmp, settings: {}, status: 'running', pid: sleeper.pid,
    });

    const orphans = reconcileOrphanSessions();
    assert.ok(!orphans.includes(id), '另一个活进程拥有的会话被误判成孤儿');
    assert.equal(store.readMeta(id).status, 'running', '状态被改坏了');
    assert.ok(!store.readEvents(id).some((e) => e.type === 'session.end'),
      '不该往别人正在跑的会话里插假的 session.end');
  } finally {
    sleeper.kill('SIGKILL');
  }
});

test('拥有者进程已经死了 → 才算孤儿', () => {
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  const pid = sleeper.pid;
  sleeper.kill('SIGKILL');
  // 等进程真的退出
  return new Promise((resolve) => setTimeout(resolve, 300)).then(() => {
    const id = 'dead-owner';
    store.createSession({
      id, requirement: 'x', projectDir: tmp, settings: {}, status: 'running', pid,
    });
    assert.ok(reconcileOrphanSessions().includes(id), '拥有者已死，应判定为孤儿');
    assert.equal(store.readMeta(id).status, 'interrupted');
  });
});

test('没有 pid 记录的老会话：沿用原判定（本进程没有 runtime 就是孤儿）', () => {
  const id = make('running', 'no-pid');
  assert.ok(reconcileOrphanSessions().includes(id));
  assert.equal(store.readMeta(id).status, 'interrupted');
});

/* ---------------- 损坏的记录不能被当成「空会话」 ---------------- */

/**
 * 损坏的文件原先返回 null / [] —— 调用方无法区分「文件坏了」和「本来就没有」，
 * 于是界面把一个损坏的会话显示成正常但空白。这正是「界面在骗你」那一类问题。
 */
test('meta.json 损坏：标记为损坏而不是当作不存在', () => {
  const dir = path.join(process.env.AGENT_DUET_WORKBENCH_SESSIONS_DIR, 'broken-meta');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), '{ 这不是合法 JSON');

  const meta = store.readMeta('broken-meta');
  assert.ok(meta, '不该返回 null —— 那会让它从列表里静默消失');
  assert.equal(meta.corrupted, true);
  assert.equal(meta.id, 'broken-meta');
  assert.ok(meta.createdAt, '要有个时间戳才能参与排序');

  assert.ok(store.listSessions().some((s) => s.id === 'broken-meta'),
    '损坏的会话也要出现在列表里，让用户看得见');
});

test('meta.json 真的不存在 → 仍然返回 null（两种情况不能混为一谈）', () => {
  assert.equal(store.readMeta('never-existed'), null);
});

test('events.jsonl 有坏行：如实上报条数，而不是静默返回空', () => {
  const dir = path.join(process.env.AGENT_DUET_WORKBENCH_SESSIONS_DIR, 'broken-events');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), [
    JSON.stringify({ type: 'a', ts: 1 }),
    '{ 坏行',
    JSON.stringify({ type: 'b', ts: 2 }),
  ].join('\n') + '\n');

  const r = store.readEventsWithStats('broken-events');
  assert.equal(r.events.length, 2, '好行要保留');
  assert.equal(r.badLines, 1, '坏行数要如实上报');
  assert.equal(r.missing, false);
});

test('会话目录不存在 → missing 标记为 true', () => {
  const r = store.readEventsWithStats('never-existed');
  assert.deepEqual(r.events, []);
  assert.equal(r.missing, true);
  assert.equal(r.badLines, 0);
});

test('readEvents 与 readEventsWithStats 给出的一致（含 afterTs 过滤）', () => {
  const id = make('completed', 'stats-1');
  store.appendEvent(id, { type: 'x', ts: 1000 });
  store.appendEvent(id, { type: 'y', ts: 2000 });
  store.appendEvent(id, { type: 'z', ts: 3000 });

  assert.equal(store.readEvents(id).length, 3);
  assert.equal(store.readEventsWithStats(id).events.length, 3);
  assert.equal(store.readEvents(id, { afterTs: 2000 }).length, 2, 'afterTs 过滤仍要生效');
});

test('rollback rejects a live session and succeeds after it stops', async () => {
  const project = fs.mkdtempSync(path.join(tmp, 'rollback-proj-'));
  const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
  const original = path.join(project, 'index.html');
  fs.writeFileSync(original, 'before session\n');
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');

  const id = store.createSession({
    id: 'rollback-live', requirement: '测试运行中回滚保护', projectDir: project,
    settings: { maxRounds: 1, minRounds: 1, allowWrite: false, leadAgent: 'claude' },
    status: 'created',
  }).id;
  let releaseReady;
  const ready = new Promise((resolve) => { releaseReady = resolve; });
  const adapter = {
    async run({ signal }) {
      if (signal.aborted) return { ok: false, aborted: true, error: 'aborted' };
      return new Promise((resolve) => signal.addEventListener(
        'abort', () => resolve({ ok: false, aborted: true, error: 'aborted' }), { once: true },
      ));
    },
  };
  const server = createServer({ port: 0 });
  let run;
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    run = runSession({
      sessionId: id, requirement: '测试运行中回滚保护', projectDir: project,
      settings: { maxRounds: 1, minRounds: 1, allowWrite: false, leadAgent: 'claude' },
      adapters: { claude: adapter, codex: adapter },
      onEvent: (event) => { if (event.type === 'turn.start') releaseReady(); },
    });
    await ready;
    const baseSha = store.readMeta(id).baseSha;
    assert.ok(baseSha, '会话启动时应建立 git 基线');

    fs.writeFileSync(original, 'agent is still writing\n');
    const blocked = await fetch(`${base}/api/sessions/${id}/rollback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: baseSha }),
    });
    assert.equal(blocked.status, 409);
    assert.equal(fs.readFileSync(original, 'utf8'), 'agent is still writing\n', '运行中的文件不能被回滚改写');

    stopSession(id);
    await run;
    const allowed = await fetch(`${base}/api/sessions/${id}/rollback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: baseSha }),
    });
    assert.equal(allowed.status, 200, await allowed.text());
    assert.equal(fs.readFileSync(original, 'utf8'), 'before session\n', '停止后应能恢复到检查点');
  } finally {
    stopSession(id);
    if (run) await run.catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
test('追加需求与验收：运行中一律 409，停止后才放行', async () => {
  const project = fs.mkdtempSync(path.join(tmp, 'continue-proj-'));
  const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(project, 'index.html'), 'base\n');
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');

  const id = store.createSession({
    id: 'continue-guard', requirement: '第一轮需求', projectDir: project,
    settings: { maxRounds: 1, minRounds: 1, allowWrite: false, leadAgent: 'claude' },
    status: 'created',
  }).id;

  let releaseReady;
  const ready = new Promise((resolve) => { releaseReady = resolve; });
  const adapter = {
    async run({ signal }) {
      if (signal.aborted) return { ok: false, aborted: true, error: 'aborted' };
      return new Promise((resolve) => signal.addEventListener(
        'abort', () => resolve({ ok: false, aborted: true, error: 'aborted' }), { once: true },
      ));
    },
  };
  const server = createServer({ port: 0 });
  let run;
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body) => fetch(`${base}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });

    run = runSession({
      sessionId: id, requirement: '第一轮需求', projectDir: project,
      settings: { maxRounds: 1, minRounds: 1, allowWrite: false, leadAgent: 'claude' },
      adapters: { claude: adapter, codex: adapter },
      onEvent: (event) => { if (event.type === 'turn.start') releaseReady(); },
    });
    await ready;

    // 还在跑的时候既不能追加需求也不能验收：否则用户会写到一个写到一半的状态上
    assert.equal((await post(`/api/sessions/${id}/continue`, { text: '新需求' })).status, 409);
    assert.equal((await post(`/api/sessions/${id}/complete`)).status, 409);

    stopSession(id);
    await run;

    // 路由确实存在（不是被通用 404 兜住）：未知会话给出的是「会话不存在」
    const missing = await post('/api/sessions/does-not-exist/continue', { text: 'x' });
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /不存在/);

    // 空需求要被挡住，而且不该顺手把会话改成 running
    const empty = await post(`/api/sessions/${id}/continue`, { text: '   ' });
    assert.equal(empty.status, 400);
    assert.equal(store.readMeta(id).status, 'stopped');

    // 验收：这是「已完成」唯一的来源。
    // （追加需求的成功路径会真的去调 CLI、烧额度，所以只在这里验证它的守卫；
    //   续跑的编排行为由 orchestrator.test.mjs 的用例覆盖。）
    const done = await post(`/api/sessions/${id}/complete`);
    assert.equal(done.status, 200, await done.text());
    const meta = store.readMeta(id);
    assert.equal(meta.status, 'completed');
    assert.equal(meta.awaitingUser, false);
    assert.equal(meta.confirmedBy, 'user');
    assert.ok(meta.confirmedAt, '要记录是谁在什么时候验收的');
    assert.equal(store.readEvents(id).some((e) => e.type === 'session.confirmed'), true);
  } finally {
    stopSession(id);
    if (run) await run.catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
test('插话在会话停下时也会被收下（不再返回「未在运行」）', async () => {
  const project = fs.mkdtempSync(path.join(tmp, 'guidance-proj-'));
  const id = store.createSession({
    id: 'guidance-queue', requirement: '需求', projectDir: project,
    settings: {}, status: 'interrupted',
  }).id;
  const server = createServer({ port: 0 });
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body) => fetch(`${base}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });

    const r = await post(`/api/sessions/${id}/guidance`, { text: '上线前先备份' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).queued, true);
    assert.deepEqual(store.readMeta(id).pendingGuidance, ['上线前先备份']);
    assert.equal(store.readEvents(id).some((e) => e.type === 'guidance.queued'), true);

    assert.equal((await post(`/api/sessions/${id}/guidance`, { text: '   ' })).status, 400);
    const missing = await post('/api/sessions/nope/guidance', { text: 'x' });
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /不存在/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
