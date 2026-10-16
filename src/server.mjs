import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  PUBLIC_DIR, DEFAULTS, getBins, claudeAuthStatus, claudeAuthStatusAsync, codexAuthStatus,
  readCodexConfigModel, isSafeModelId, FALLBACK_CLAUDE_MODELS, FALLBACK_CODEX_MODELS,
  listCodexCatalogAsync, listClaudeModelAliasesAsync,
} from './config.mjs';
import { readPrefs, writePrefs, pickModelPrefs } from './prefs.mjs';
import { createClaudeAdapter } from './adapters/claude.mjs';
import { createCodexAdapter } from './adapters/codex.mjs';
import * as store from './session.mjs';
import * as gitguard from './gitguard.mjs';
import { runSession, stopSession, injectGuidance, getRuntime, activeSessionIds } from './orchestrator.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** 会话 id -> SSE 连接集合 */
const subscribers = new Map();

/** /api/health 的短缓存：探测登录要 spawn 子进程，约 400ms，不值得每次重算。 */
const HEALTH_TTL = 30_000;
let healthCache = { at: 0, data: null };

function broadcast(event) {
  const set = subscribers.get(event.sessionId);
  if (!set) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      set.delete(res);
    }
  }
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/**
 * 取某个会话某个 agent 当前该用的模型。
 *
 * 每次 spawn 前现读 meta：会话跑着的时候也能改，改完下一个发言就生效。
 * 不在建会话时把模型烧进适配器，是因为模型选错（没开通、额度不够、权限不匹配）时
 * 唯一合理的补救就是换一个，而不是要求用户把整场讨论杀掉重开。
 */
function modelGetter(sessionId, agent) {
  const key = agent === 'claude' ? 'claudeModel' : 'codexModel';
  return () => {
    try {
      const settings = (store.readMeta(sessionId) || {}).settings || {};
      const value = settings[key];
      return value == null || value === '' ? null : String(value);
    } catch {
      return null;
    }
  };
}

/**
 * 可选模型列表。
 *
 * 诚实说明：claude / codex 都没有「列出可用模型」的子命令 —— codex 的模型目录
 * 刷新还会超时（就是日志里那条 codex_models_manager）。所以这里给的是**建议值**，
 * 界面允许手填任意 id；codex 的默认模型直接读 ~/.codex/config.toml，
 * 读不到就说「默认」，不编一个模型名冒充。
 */
const MODELS_TTL = 10 * 60 * 1000;
let modelsCache = { at: 0, data: null };

async function modelsPayload({ fresh = false } = {}) {
  if (!fresh && modelsCache.data && Date.now() - modelsCache.at < MODELS_TTL) return modelsCache.data;

  const bins = getBins();
  const prefs = readPrefs();
  const [catalog, aliases] = await Promise.all([
    listCodexCatalogAsync(bins.codex),
    listClaudeModelAliasesAsync(bins.claude),
  ]);

  // 历史里**真的用过**的模型，比任何「建议值」都可靠
  const used = { claude: new Set(), codex: new Set() };
  try {
    for (const meta of store.listSessions()) {
      const models = meta.agentModels || {};
      if (models.claude) used.claude.add(models.claude);
      if (models.codex) used.codex.add(models.codex);
      if (meta.settings?.claudeModel) used.claude.add(meta.settings.claudeModel);
      if (meta.settings?.codexModel) used.codex.add(meta.settings.codexModel);
    }
  } catch { /* 历史读不出来不该影响可用列表 */ }

  const merge = (primary, seen) => {
    const out = [{ id: null, label: '默认' }];
    const known = new Set();
    for (const o of primary) {
      if (o.id == null || known.has(o.id)) continue;
      known.add(o.id);
      out.push(o);
    }
    for (const id of seen) {
      if (known.has(id)) continue;
      known.add(id);
      out.push({ id, label: `${id}（用过的）` });
    }
    return out;
  };

  const codexDefault = readCodexConfigModel();
  const payload = {
    claude: {
      key: 'claudeModel',
      configured: prefs.claudeModel ?? DEFAULTS.claudeModel ?? null,
      default: null,
      source: aliases.length ? 'cli-help' : 'fallback',
      options: merge(
        aliases.length
          ? aliases.map((a) => ({ id: a.id, label: `${a.id}（别名，指向最新）` }))
          : FALLBACK_CLAUDE_MODELS.filter((o) => o.id != null),
        used.claude,
      ),
      note: '留空 = 用 claude 自己的默认模型。claude 没有列模型的子命令，所以这里是它帮助里写明的别名 + 你用过的模型；其它名字可以手填。',
    },
    codex: {
      key: 'codexModel',
      configured: prefs.codexModel ?? DEFAULTS.codexModel ?? null,
      default: codexDefault,
      source: catalog.length ? 'catalog' : 'fallback',
      options: merge(
        catalog.length ? catalog : FALLBACK_CODEX_MODELS.filter((o) => o.id != null),
        used.codex,
      ),
      note: codexDefault
        ? `留空 = 用 ~/.codex/config.toml 里的默认模型（${codexDefault}）`
        : '留空 = 用 ~/.codex/config.toml 里的默认模型',
    },
  };
  modelsCache = { at: Date.now(), data: payload };
  return payload;
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`JSON 解析失败: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

/**
 * 启动时清理僵尸会话。
 *
 * 上一个进程如果被 Ctrl-C 或崩溃，meta 里的 status 会永远停在 `running`，
 * 但内存中已经没有任何 runtime 了。后果有两个，都很难自己排查出来：
 *   1. 界面显示「正在跑」，但中止按钮是禁用的（running 取自内存），于是**无法中止**；
 *   2. 打开页面时会自动跳回这个永远跑不完的会话，甩都甩不掉。
 * 判定很简单：落盘说在跑、内存里却没有 —— 那它一定是上一个进程留下的。
 */
/** 进程是否还活着（信号 0 只做存在性检查，不真的发信号）。 */
function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';   // 进程存在但没权限，仍算活着
  }
}

export function reconcileOrphanSessions() {
  const orphans = [];
  for (const s of store.listSessions()) {
    if (s.status !== 'running') continue;
    if (getRuntime(s.id)) continue;              // 本进程确实在跑
    // 关键：runtime 只存在于**拥有它的那个进程**的内存里。
    // 如果 meta 记的 pid 还活着，说明是**另一个实例**在跑这个会话 —— 不能当孤儿，
    // 否则两个实例会互相把对方正在跑的会话标成「已中断」，还会往事件流里插一条假的
    // session.end（前端重放到它就会结束会话，时间线自相矛盾），而那个会话其实还在烧额度。
    // 这不是假想场景：工具自己在端口被占用时会提示「换一个端口」。
    if (s.pid && s.pid !== process.pid && pidAlive(s.pid)) continue;
    store.patchMeta(s.id, {
      status: 'interrupted',
      phase: 'interrupted',
      finishedAt: new Date().toISOString(),
      interruptedReason: '服务重启导致会话中断',
    });
    store.appendEvent(s.id, {
      sessionId: s.id,
      type: 'session.end',
      status: 'interrupted',
      error: '服务重启，该会话已中断（不是被主动中止）',
    });
    orphans.push(s.id);
  }
  return orphans;
}

export function createServer({ port = DEFAULTS.port } = {}) {
  const orphans = reconcileOrphanSessions();
  if (orphans.length) {
    console.log(`\n  ⚠ 发现 ${orphans.length} 个上次未正常结束的会话，已标记为「已中断」：`);
    for (const id of orphans) console.log(`     ${id}`);
    console.log('    （它们之前会一直显示为"正在运行"，且中止按钮点不动）\n');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const { pathname } = url;

    try {
      if (!pathname.startsWith('/api/')) {
        serveStatic(req, res, pathname);
        return;
      }

      /* 同源校验。
       *
       * 挡的是 CSRF：恶意网页可以用 `Content-Type: text/plain` 发一个 **CORS 简单请求**，
       * 不触发预检，浏览器会直接把它发到 127.0.0.1:8787。攻击者能自选 body，
       * 于是可以替你创建会话（projectDir 任选 + allowWrite:true），
       * 让 agent 在你有权写入的任意目录里改文件，并消耗你的订阅额度。
       * 响应因同源策略读不到，但**副作用本身就是攻击**。
       */
      const fetchSite = req.headers['sec-fetch-site'];
      const origin = req.headers.origin;
      const sameOrigin = (() => {
        // Sec-Fetch-Site 是现代浏览器的直接信号，最可靠
        if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
        if (!origin) return true;   // 非浏览器客户端（curl / 本机脚本）不带 Origin
        try {
          const u = new URL(origin);
          const host = u.hostname.replace(/^\[|\]$/g, '');
          const localHost = host === '127.0.0.1' || host === 'localhost' || host === '::1';
          const originPort = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
          return localHost && originPort === port;
        } catch {
          return false;
        }
      })();
      if (!sameOrigin) return json(res, 403, { error: '拒绝跨站请求' });

      // 第二道防线：写操作必须声明 JSON。
      // 跨站的 JSON 请求一定触发预检，也就根本到不了这里。
      if (req.method === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')) {
        return json(res, 415, { error: 'Content-Type 必须是 application/json' });
      }

      /* ---------------- 环境自检 ---------------- */
      if (pathname === '/api/health' && req.method === 'GET') {
        // 探测登录状态要 spawn 一个 `claude auth status` 子进程，实测约 400ms。
        // 前端在页面加载和每次会话结束时都会问一次，不加缓存的话每次都要等。
        // 登录状态不会秒变，缓存 30 秒足够；要强制刷新就带 ?fresh=1。
        const fresh = url.searchParams.get('fresh') === '1';
        const now = Date.now();
        if (!fresh && healthCache.data && now - healthCache.at < HEALTH_TTL) {
          return json(res, 200, healthCache.data);
        }
        const bins = getBins();
        // 异步探测：execFileSync 会阻塞整个事件循环，探测期间 SSE、中止按钮、
        // 其它会话全部停摆（实测并发请求被卡 4.6 秒，最坏 20 秒）。
        const claude = await claudeAuthStatusAsync(bins.claude);
        const codex = codexAuthStatus(bins.codex);
        // 这里原先写死了两个模型名（claude-opus-5-5 / gpt-6.1-sol），是占位值、
        // 跟实际使用毫无关系，界面却照着显示 —— 属于「看起来有信息」的假信息。
        // 现在只报能真正查证的：用户选的模型，和 codex 配置文件里的默认模型。
        const payload = {
          bins,
          auth: { claude, codex },
          models: await modelsPayload(),
          ready: Boolean(bins.codex && bins.claude && claude.loggedIn && codex.loggedIn),
          defaults: DEFAULTS,
          node: process.version,
        };
        healthCache = { at: now, data: payload };
        return json(res, 200, payload);
      }

      /* ---------------- 可选模型 ---------------- */
      if (pathname === '/api/models' && req.method === 'GET') {
        // 每次都要 spawn 两个 CLI 去问清单，所以带 10 分钟缓存；?fresh=1 强制刷新
        const fresh = url.searchParams.get('fresh') === '1';
        return json(res, 200, { models: await modelsPayload({ fresh }) });
      }

      /* ---------------- 目录选择 ---------------- */
      if (pathname === '/api/pick-folder' && req.method === 'POST') {
        return pickFolder(res);
      }
      if (pathname === '/api/browse' && req.method === 'GET') {
        const dir = url.searchParams.get('dir') || process.env.HOME;
        return json(res, 200, listDirs(dir));
      }

      /* ---------------- 会话列表 ---------------- */
      if (pathname === '/api/sessions' && req.method === 'GET') {
        // live 表示进程里真的在跑。落盘 status 可能残留 running（上个进程留下的），
        // 前端只该自动恢复到 live 的会话，否则会跳进一个永远跑不完的僵尸。
        return json(res, 200, {
          sessions: store.listSessions().map((s) => ({ ...s, live: Boolean(getRuntime(s.id)) })),
        });
      }

      /* ---------------- 新建会话 ---------------- */
      if (pathname === '/api/sessions' && req.method === 'POST') {
        const body = await readBody(req);
        const requirement = String(body.requirement || '').trim();
        const projectDir = path.resolve(String(body.projectDir || '').trim());
        if (!requirement) return json(res, 400, { error: '缺少需求描述' });
        if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
          return json(res, 400, { error: `项目目录不存在: ${projectDir}` });
        }

        const bins = getBins();
        if (!bins.claude || !bins.codex) {
          return json(res, 400, {
            error: `缺少 CLI：${!bins.claude ? 'claude ' : ''}${!bins.codex ? 'codex' : ''}`,
          });
        }

        const settings = { ...DEFAULTS, ...(body.settings || {}) };
        // 记住这次选的模型，下次打开表单直接预填；只写用户真的选了的键
        writePrefs(pickModelPrefs(body.settings || {}));
        const meta = store.createSession({
          requirement,
          projectDir,
          settings,
          status: 'running',
          // 项目目录若是更大仓库的子目录，明确记录提示，前端会常驻显示
          scopeNotice: gitguard.scopeNotice(projectDir) || null,
          git: gitguard.status(projectDir),
        });

        const adapters = {
          claude: createClaudeAdapter({ bin: bins.claude, getModel: modelGetter(meta.id, 'claude') }),
          codex: createCodexAdapter({ bin: bins.codex, getModel: modelGetter(meta.id, 'codex') }),
        };

        // 立刻返回会话 id，编排在后台跑，事件走 SSE
        const others = activeSessionIds();
        json(res, 200, {
          id: meta.id,
          meta,
          // 并发跑会成倍消耗订阅额度，显著加快撞限流 —— 提示但不阻止
          warning: others.length
            ? `已有 ${others.length} 个会话正在跑。并发会更快撞上订阅额度上限，建议等它跑完再开下一个。`
            : null,
        });

        runSession({
          sessionId: meta.id,
          requirement,
          projectDir,
          settings,
          adapters,
          onEvent: broadcast,
        }).catch((err) => {
          broadcast({ sessionId: meta.id, type: 'error', text: err.message });
        });
        return;
      }

      /* ---------------- 单个会话 ---------------- */
      const detail = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (detail && req.method === 'GET') {
        const id = decodeURIComponent(detail[1]);
        const meta = store.readMeta(id);
        if (!meta) return json(res, 404, { error: '会话不存在' });
        // 合并 delta 后再返回：一个 7000+ 事件的会话里 97% 是流式碎片，
        // 前端重放它们只是往同一个气泡追加文本，合并后等价但快两个数量级。
        const read = store.readEventsWithStats(id);
        if (read.badLines > 0) {
          // 坏行原先被静默丢弃，界面会把它显示成"正常但空白"。
          // 如实插一条警告，让用户知道记录不完整。
          read.events.push({
            type: 'warning',
            ts: Date.now(),
            text: `事件文件有 ${read.badLines} 行损坏，已跳过（会话记录不完整）`,
          });
        }
        const events = store.compactEvents(read.events);
        return json(res, 200, {
          meta,
          plan: store.readPlan(id),
          events,
          // 前端把已收到的最大 seq 传回给 SSE，避免连上后又被重放一遍。
          // 用 seq 而不是条数：条数会在 delta 合并后变化，seq 不会。
          eventCount: events.length,
          lastSeq: events.reduce((m, e) => Math.max(m, e.seq || 0), 0),
          running: Boolean(getRuntime(id)),
        });
      }

      /* ---------------- SSE 实时事件 ---------------- */
      const stream = pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
      if (stream && req.method === 'GET') {
        const id = decodeURIComponent(stream[1]);
        if (!store.readMeta(id)) return json(res, 404, { error: '会话不存在' });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');

        // 补发 after 之后的事件。
        // after 是前端已收到的最大 seq —— 用序号而不是条数，
        // 这样 EventSource 断线重连（同一个 URL）时也能精确续传，
        // 不会把已经处理过的历史重发一遍（那会造成消息重复和幽灵转圈）。
        // **先按游标裁掉已消费的事件，再合并 delta。** 顺序不能反：
        // 客户端第一次连上时只看到 seq≤5 的那组（渲染了 "abcde"）；
        // 若重连时把 1..10 整组重新合并成 "abcdefghij" 发过去，
        // 客户端会在已有的 "abcde" 后面再追加一遍 → 重复文本。
        // 裁完再合并，补发的就只是还没看过的 "fghij"。
        const after = Number(url.searchParams.get('after')) || 0;
        const raw = store.readEvents(id);
        const pending = after > 0 ? raw.filter((e) => (e.seq || 0) > after) : raw;
        for (const ev of store.compactEvents(pending)) {
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        }

        if (!subscribers.has(id)) subscribers.set(id, new Set());
        subscribers.get(id).add(res);

        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            /* 连接已断 */
          }
        }, 15000);

        req.on('close', () => {
          clearInterval(ping);
          const set = subscribers.get(id);
          set?.delete(res);
          // 订阅者清空就把这个 key 也删掉，否则 Map 会随会话数一直涨
          if (set && set.size === 0) subscribers.delete(id);
        });
        return;
      }

      /* ---------------- 中止 ---------------- */
      const stop = pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
      if (stop && req.method === 'POST') {
        return json(res, 200, stopSession(decodeURIComponent(stop[1])));
      }
      /* ---------------- 追加需求：同一个会话接着做 ----------------
       *
       * 「任务做完了没有」由用户说了算。所以自动化流程跑完只把会话标成 delivered，
       * 用户随时可以在这里追加新要求，带着上次的方案接着做 —— 而不是被迫新开一个会话、
       * 或者对着一个点不动的界面发愁。
       */
      const cont = pathname.match(/^\/api\/sessions\/([^/]+)\/continue$/);
      if (cont && req.method === 'POST') {
        const id = decodeURIComponent(cont[1]);
        const meta = store.readMeta(id);
        if (!meta) return json(res, 404, { error: '会话不存在' });
        if (getRuntime(id)) return json(res, 409, { error: '这个会话还在跑，等它停下来再追加需求' });
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { error: '缺少需求描述' });
        const bins = getBins();
        if (!bins.claude || !bins.codex) {
          return json(res, 400, {
            error: `缺少 CLI：${!bins.claude ? 'claude ' : ''}${!bins.codex ? 'codex' : ''}`,
          });
        }

        const cycle = (Number(meta.cycle) || 1) + 1;
        const priorContext = {
          cycle,
          previousRequirement: meta.requirement,
          // 上次交付的方案是这次最重要的背景：没有它，追加需求等于从零再来一遍
          previousPlan: store.readPlan(id),
          previousOutcome: meta.outcome || null,
        };
        store.patchMeta(id, {
          cycle,
          continuations: [...(meta.continuations || []), { text, at: new Date().toISOString() }],
        });
        // 时间线里要看得见这次追加了什么，否则标题永远停在第一次的需求上
        const added = store.appendEvent(id, { sessionId: id, cycle, type: 'requirement', text });
        broadcast(added);

        const settings = { ...DEFAULTS, ...(meta.settings || {}) };
        const adapters = {
          claude: createClaudeAdapter({ bin: bins.claude, getModel: modelGetter(id, 'claude') }),
          codex: createCodexAdapter({ bin: bins.codex, getModel: modelGetter(id, 'codex') }),
        };
        // 先回执再开跑：界面立刻能切到这个会话并连上 SSE
        json(res, 200, { ok: true, id, cycle });
        runSession({
          sessionId: id,
          requirement: text,
          projectDir: meta.projectDir,
          settings,
          adapters,
          onEvent: broadcast,
          cycle,
          priorContext,
          resumeIds: meta.agentSessions || null,
        }).catch((err) => {
          broadcast({ sessionId: id, type: 'error', text: err.message });
        });
        return;
      }

      /* ---------------- 用户验收：由用户宣布任务结束 ---------------- */
      const complete = pathname.match(/^\/api\/sessions\/([^/]+)\/complete$/);
      if (complete && req.method === 'POST') {
        const id = decodeURIComponent(complete[1]);
        const meta = store.readMeta(id);
        if (!meta) return json(res, 404, { error: '会话不存在' });
        if (getRuntime(id)) return json(res, 409, { error: '这个会话还在跑，等它停下来再验收' });
        const at = new Date().toISOString();
        store.patchMeta(id, {
          status: 'completed',
          phase: 'completed',
          awaitingUser: false,
          confirmedAt: at,
          confirmedBy: 'user',
        });
        const record = store.appendEvent(id, { sessionId: id, type: 'session.confirmed', at, by: 'user' });
        broadcast(record);
        return json(res, 200, { ok: true, id, confirmedAt: at });
      }

      /* ---------------- 中途插话 ---------------- */
      const guide = pathname.match(/^\/api\/sessions\/([^/]+)\/guidance$/);
      if (guide && req.method === 'POST') {
        const id = decodeURIComponent(guide[1]);
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { error: '缺少 text' });
        /* 会话在跑 → 交给当前编排，下一个发言机会生效。
         * 已经停下 → 存进 meta，下次继续时第一件事就交给双方。
         *
         * 以前这里只会回「会话未在运行」，界面上那颗按钮于是永远是灰的 ——
         * 用户刚打的一段话没有地方去。插话属于「不能被静默丢掉」的那类输入，
         * 所以会话停下也要收下。 */
        const mode = body.mode === 'now' ? 'now' : 'queue';
        // 只有真的在跑时「立即执行」才有意义；停下时一律走下面落盘那条路
        const live = injectGuidance(id, text, { immediate: mode === 'now' });
        if (live.ok) return json(res, 200, live);
        const meta = store.readMeta(id);
        if (!meta) return json(res, 404, { error: '会话不存在' });
        const pending = [...(meta.pendingGuidance || []), text];
        store.patchMeta(id, { pendingGuidance: pending });
        const record = store.appendEvent(id, {
          sessionId: id, type: 'guidance.queued', text, pending: pending.length,
        });
        broadcast(record);
        return json(res, 200, { ok: true, queued: true, pending: pending.length });
      }

      /* ---------------- 换模型 ---------------- */
      const modelRoute = pathname.match(/^\/api\/sessions\/([^/]+)\/model$/);
      if (modelRoute && req.method === 'POST') {
        const id = decodeURIComponent(modelRoute[1]);
        const meta = store.readMeta(id);
        if (!meta) return json(res, 404, { error: '会话不存在' });
        const body = await readBody(req);
        const agent = String(body.agent || '');
        if (agent !== 'claude' && agent !== 'codex') {
          return json(res, 400, { error: 'agent 只能是 claude 或 codex' });
        }
        const raw = body.model == null || String(body.model).trim() === ''
          ? null
          : String(body.model).trim();
        // 这个值会被塞进 `--model` / `-m` 后面，必须挡住以 - 开头的东西，否则等于注入 CLI 参数
        if (raw !== null && !isSafeModelId(raw)) {
          return json(res, 400, {
            error: '模型名不合法：只能用字母数字与 . _ : @ / + -，且不能以 - 开头',
          });
        }
        const key = agent === 'claude' ? 'claudeModel' : 'codexModel';
        store.patchMeta(id, { settings: { ...(meta.settings || {}), [key]: raw } });
        writePrefs({ [key]: raw });
        // 跑着的时候改，从下一个发言起生效（适配器每轮现取模型）；
        // 停下的时候改，下次继续时才生效。两种都如实写进时间线，
        // 否则「我明明换了模型怎么还是老样子」这种问题无从查起。
        const live = Boolean(getRuntime(id));
        const record = store.appendEvent(id, {
          sessionId: id,
          type: 'model.changed',
          agent,
          model: raw,
          effective: live ? 'next-turn' : 'next-run',
        });
        broadcast(record);
        const when = live ? '从下一个发言起生效' : '下次继续时生效';
        return json(res, 200, {
          ok: true,
          agent,
          model: raw,
          effective: record.effective,
          message: raw ? `${agent} 换成 ${raw}，${when}` : `${agent} 恢复默认模型，${when}`,
        });
      }

      /* ---------------- 回滚 ---------------- */
      const rollback = pathname.match(/^\/api\/sessions\/([^/]+)\/rollback$/);
      if (rollback && req.method === 'POST') {
        const id = decodeURIComponent(rollback[1]);
        const meta = store.readMeta(id);
        if (!meta) return json(res, 404, { error: '会话不存在' });
        // Agent 还在写文件时回滚会与后续写入竞争，造成“回滚成功”但工作区又变化。
        if (getRuntime(id)) {
          return json(res, 409, { error: '这个会话还在运行，请先「中止」并等待停止后再回滚' });
        }
        const body = await readBody(req);
        const sha = body.sha || meta.baseSha;
        const result = gitguard.rollbackTo(meta.projectDir, sha);
        if (result.ok) {
          broadcast({ sessionId: id, type: 'rollback', sha, at: new Date().toISOString() });
        }
        return json(res, result.ok ? 200 : 400, result);
      }

      /* ---------------- 删除会话 ---------------- */
      const del = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (del && req.method === 'DELETE') {
        const id = decodeURIComponent(del[1]);
        const meta = store.readMeta(id);
        if (!meta) return json(res, 404, { error: '会话不存在' });
        // 正在跑的会话不能删：进程还在往里写事件，删了会留下半截状态。
        if (getRuntime(id)) {
          return json(res, 409, { error: '这个会话还在运行，请先「中止」，停稳后再删' });
        }
        const r = store.deleteSession(id);
        if (!r.ok) return json(res, 400, r);
        return json(res, 200, { ok: true, id });
      }

      /* ---------------- 会话内改动 ---------------- */
      const files = pathname.match(/^\/api\/sessions\/([^/]+)\/changes$/);
      if (files && req.method === 'GET') {
        const id = decodeURIComponent(files[1]);
        const meta = store.readMeta(id);
        if (!meta) return json(res, 404, { error: '会话不存在' });
        const st = gitguard.status(meta.projectDir);
        // 明确回报失败原因（而不是返回空 diff），前端据此决定不要清空已有内容
        if (!st.isRepo) {
          return json(res, 200, { error: '项目目录不是 git 仓库，无法计算改动', git: st });
        }
        return json(res, 200, {
          git: st,
          baseSha: meta.baseSha,
          files: gitguard.changedFiles(meta.projectDir, meta.baseSha),
          diff: gitguard.diffFrom(meta.projectDir, meta.baseSha),
        });
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('unknown api route');
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });

  server.listen(port, '127.0.0.1');
  return server;
}

/** macOS 原生选目录对话框；非 macOS 或失败时让前端退回手输路径。 */
function pickFolder(res) {
  if (process.platform !== 'darwin') {
    return json(res, 501, { error: '当前系统不支持原生目录选择，请手动输入路径' });
  }
  execFile(
    'osascript',
    ['-e', 'POSIX path of (choose folder with prompt "选择要改造的项目目录")'],
    { timeout: 120000 },
    (err, stdout) => {
      if (err) return json(res, 200, { cancelled: true });
      const picked = stdout.trim().replace(/\/$/, '');
      return json(res, 200, { path: picked });
    },
  );
}

/** 无对话框时的兜底：列出子目录。 */
function listDirs(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => {
        if (!e.isDirectory() && !e.isSymbolicLink()) return false;
        if (e.name.startsWith('.')) return false;
        try {
          return fs.statSync(path.join(dir, e.name)).isDirectory();
        } catch {
          return false;
        }
      })
      .map((e) => e.name)
      .slice(0, 500);
    return { path: dir, parent: path.dirname(dir), dirs };
  } catch (err) {
    return { path: dir, error: err.message, dirs: [] };
  }
}
