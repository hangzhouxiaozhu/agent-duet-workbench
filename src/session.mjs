import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR, ensureSessionsDir } from './config.mjs';

/**
 * 会话持久化。每个会话一个目录：
 *   sessions/<id>/meta.json       基本信息与状态
 *   sessions/<id>/events.jsonl    追加式事件流（前端重放用）
 *   sessions/<id>/plan.md         定稿方案
 *   sessions/<id>/transcript.md   人类可读的完整讨论记录
 */

export function newSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function sessionDir(id) {
  return path.join(SESSIONS_DIR, id);
}

export function createSession(meta) {
  ensureSessionsDir();
  const id = meta.id || newSessionId();
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const full = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'created',
    phase: 'idle',
    round: 0,
    ...meta,
  };
  writeMeta(id, full);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
  return full;
}

export function writeMeta(id, meta) {
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const next = { ...meta, updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(next, null, 2));
  return next;
}

export function readMeta(id) {
  const file = path.join(sessionDir(id), 'meta.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;   // 真的不存在
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // 文件在、但读不出内容（半截写、磁盘损坏）。
    // 返回 null 会让它从列表里**静默消失**、详情接口报 404 ——
    // 用户看到的是"从来没有这个会话"，而不是"这个会话坏了"。
    // 这正是之前那类「界面在骗你」的问题，所以这里如实标出来。
    let createdAt = new Date(0).toISOString();
    try { createdAt = fs.statSync(file).mtime.toISOString(); } catch { /* 忽略 */ }
    return { id, corrupted: true, corruptReason: err.message, status: 'corrupted', createdAt };
  }
}

export function patchMeta(id, patch) {
  const cur = readMeta(id);
  if (!cur) return null;
  return writeMeta(id, { ...cur, ...patch });
}

/**
 * 每个会话的事件序号计数器。
 *
 * 为什么要给事件编号：SSE 断线重连时，EventSource 会**用同一个 URL** 重连。
 * 如果"从哪继续"是按条数算的（skip=N），重连时 N 不会前进，
 * 服务端就会把已经处理过的事件**全部重发一遍** —— 消息重复渲染，
 * 而且 turn.start 会再建一个气泡，留下永远转圈的幽灵。
 * 用一个单调递增、与合并无关的 seq 才能精确表达"这条我收过了"。
 */
const seqCounters = new Map();

function nextSeq(id) {
  let n = seqCounters.get(id);
  if (n === undefined) {
    // 首次接触这个会话：数一下已有多少行（只在本题进程内做一次）
    try {
      const raw = fs.readFileSync(path.join(sessionDir(id), 'events.jsonl'), 'utf8');
      n = raw.split('\n').filter(Boolean).length;
    } catch {
      n = 0;
    }
  }
  n += 1;
  seqCounters.set(id, n);
  return n;
}

export function appendEvent(id, event) {
  // 事件自带的 seq 优先（回放/测试用），否则现分配一个
  const seq = Number.isFinite(event.seq) ? event.seq : nextSeq(id);
  const record = { ts: Date.now(), ...event, seq };
  fs.appendFileSync(path.join(sessionDir(id), 'events.jsonl'), `${JSON.stringify(record)}\n`);
  return record;
}

/**
 * 读事件，并如实报告有多少行是坏的。
 *
 * 坏行原先被逐条丢弃、返回一个空数组 —— 调用方无法区分「文件坏了」和「本来就没有」，
 * 界面于是把一个损坏的会话显示成正常但空白。
 */
export function readEventsWithStats(id) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(sessionDir(id), 'events.jsonl'), 'utf8');
  } catch {
    return { events: [], badLines: 0, missing: true };
  }
  let badLines = 0;
  const events = raw
      .split('\n')
      .filter(Boolean)
      .map((line, i) => {
        try {
          const e = JSON.parse(line);
          // 加序号之前写下的老事件没有 seq，按行号补一个。
          // 文件只追加，而 appendEvent 的计数器正是从"已有行数"起算的，
          // 所以补出来的号不会和之后新分配的号撞上。
          if (!Number.isFinite(e.seq)) e.seq = i + 1;
          return e;
        } catch {
          badLines += 1;
          return null;
        }
      })
      .filter(Boolean);   // 按时间过滤是调用方的事，这里只负责读和统计坏行
  return { events, badLines, missing: false };
}

export function readEvents(id, { afterTs = 0 } = {}) {
  return readEventsWithStats(id).events.filter((e) => (e.ts ?? 0) >= afterTs);
}

/**
 * 把连续的同 agent delta 合并成一条。
 *
 * delta 是流式输出的碎片。实测一个 7494 事件的会话里有 7282 条是 delta（97%），
 * 而前端处理 delta 的动作就是「往同一个气泡里追加文本」—— 所以把连续的同 agent
 * delta 拼起来**语义完全等价**，却能把重放的 DOM 操作从几千次降到十几次。
 *
 * 注意 push 的是浅拷贝：合并时改的是副本，不会污染调用方拿到的对象。
 * thinking 不合并 —— 前端的 thinking 处理是「每条新建一个盒子」，不能拼。
 */
export function compactEvents(events) {
  const out = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (
      e.type === 'delta'
      && last && last.type === 'delta'
      && last.agent === e.agent
      && last.phase === e.phase
      && last.round === e.round
    ) {
      last.text += e.text;
      // 保留组内最大的 seq：这样刚才消费掉的整组都会被 "seq > after" 正确排除
      if (Number.isFinite(e.seq)) last.seq = Math.max(last.seq ?? 0, e.seq);
      continue;
    }
    out.push({ ...e });
  }
  return out;
}

export function listSessions() {
  ensureSessionsDir();
  let ids = [];
  try {
    ids = fs.readdirSync(SESSIONS_DIR).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
  return ids
    .map((id) => readMeta(id))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * 删除一个会话的本地记录（meta / 事件流 / 方案 / transcript）。
 *
 * 只删 duet 自己产出的那些文件所在的目录；**不碰项目目录里的任何东西**。
 * 调用方必须先确认会话没在跑 —— 删一个正在写的目录会留下半截状态。
 */
export function deleteSession(id) {
  const dir = sessionDir(id);
  // 防目录穿越：只有 id 恰好等于某个直接子目录名时才允许删
  if (!id || id.includes('/') || id.includes('\\') || id.startsWith('.')) {
    return { ok: false, error: `非法会话 id: ${id}` };
  }
  if (path.dirname(path.resolve(dir)) !== path.resolve(SESSIONS_DIR)) {
    return { ok: false, error: '拒绝删除 sessions 目录之外的路径' };
  }
  if (!fs.existsSync(dir)) return { ok: false, error: '会话不存在' };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, id };
}

export function savePlan(id, markdown) {
  fs.writeFileSync(path.join(sessionDir(id), 'plan.md'), markdown);
}

export function readPlan(id) {
  try {
    return fs.readFileSync(path.join(sessionDir(id), 'plan.md'), 'utf8');
  } catch {
    return '';
  }
}

export function saveTranscript(id, markdown) {
  fs.writeFileSync(path.join(sessionDir(id), 'transcript.md'), markdown);
}

/** 把讨论轮次渲染成人类可读的 Markdown，会话结束时落盘。 */
export function renderTranscript(meta, turns) {
  const lines = [
    `# ${meta.requirement.split('\n')[0].slice(0, 80)}`,
    '',
    `- 会话：\`${meta.id}\``,
    `- 项目目录：\`${meta.projectDir}\``,
    `- 开始时间：${meta.createdAt}`,
    `- 轮数上限：${meta.settings?.maxRounds ?? '-'}`,
    `- 检查点基线：\`${meta.baseSha || '（无）'}\``,
    '',
    '---',
    '',
  ];
  let lastRound = null;
  for (const t of turns) {
    if (t.round !== lastRound) {
      lines.push(`## 第 ${t.round} 轮`, '');
      lastRound = t.round;
    }
    lines.push(`### ${t.agent === 'claude' ? 'Claude' : 'Codex'}`, '', t.text, '');
  }
  return lines.join('\n');
}
