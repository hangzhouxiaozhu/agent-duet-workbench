/* Agent Duet Workbench 前端 —— 无构建、无依赖。 */

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** openSession 的请求序号，用来丢弃「过期的慢响应」。 */
let openReqSeq = 0;

const PHASES = ['propose', 'discuss', 'finalize', 'execute', 'review'];

const state = {
  health: null,
  sessionId: null,
  meta: null,
  es: null,
  reached: new Set(),  // 到过哪些阶段（路线要如实显示，不能把没跑过的打上勾）
  lastRound: null,
  consensusHistory: [],// 每轮的一致/分歧/阻塞计数，用来画收敛曲线
  stats: { calls: 0, rounds: 0, inTok: 0, outTok: 0, cost: 0 },
  drafts: {},          // agent -> 正在流式的 turn 元素
  agentModels: {},     // agent -> CLI 自己上报的模型（Claude 会给，Codex 不给）
  modelConfig: {},     // agent -> 用户配置的模型
  modelInfo: null,     // /api/models 的结果：建议列表 + 默认值
  turns: {},           // agent -> 已完成的轮次计数
  plan: '',
  running: false,
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('toastWrap').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 5000);
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 极简 Markdown 渲染：够用于方案、讨论正文，不追求完整规范。 */
function renderMarkdown(src) {
  if (!src) return '';
  const blocks = [];
  // 先把围栏代码块摘出来，避免内部内容被后续规则破坏
  let text = String(src).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = blocks.length;
    blocks.push(`<pre><code data-lang="${escapeHtml(lang)}">${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000BLOCK${i}\u0000`;
  });

  text = escapeHtml(text);

  const lines = text.split('\n');
  const out = [];
  let listType = null;

  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  for (const raw of lines) {
    const line = raw;
    const fence = line.match(/^\u0000BLOCK(\d+)\u0000$/);
    if (fence) { closeList(); out.push(blocks[Number(fence[1])]); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    if (/^\s*[-*+]\s+/.test(line)) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
      continue;
    }

    if (/^\s*&gt;\s?/.test(line)) { closeList(); out.push(`<blockquote>${inline(line.replace(/^\s*&gt;\s?/, ''))}</blockquote>`); continue; }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    if (!line.trim()) { closeList(); continue; }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function renderDiff(diff) {
  if (!diff) return '<span class="empty">尚未产生改动。</span>';
  return diff.split('\n').map((line) => {
    const t = escapeHtml(line);
    if (line.startsWith('+++') || line.startsWith('---')) return `<span class="meta">${t}</span>`;
    if (line.startsWith('@@')) return `<span class="hunk">${t}</span>`;
    if (line.startsWith('+')) return `<span class="add">${t}</span>`;
    if (line.startsWith('-')) return `<span class="del">${t}</span>`;
    if (line.startsWith('diff ') || line.startsWith('index ')) return `<span class="meta">${t}</span>`;
    return t;
  }).join('\n');
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

const AGENT_LABEL = { claude: 'Claude', codex: 'Codex' };
const PHASE_LABEL = {
  propose: '独立作答', discuss: '交叉讨论', finalize: '方案定稿',
  execute: '动手实现', review: '交叉验收',
};

/* ------------------------------------------------------------------ */
/* 环境状态                                                            */
/* ------------------------------------------------------------------ */

async function loadHealth() {
  try {
    const h = await api('/api/health');
    state.health = h;

    for (const agent of ['claude', 'codex']) {
      const chip = document.querySelector(`.chip[data-agent="${agent}"]`);
      const note = chip.querySelector('.chip-note');
      const info = h.auth[agent];
      const binOk = Boolean(h.bins[agent]);
      if (binOk && info.loggedIn) {
        chip.classList.add('ok');
        note.textContent = info.authMethod || '已就绪';
      } else {
        chip.classList.add('bad');
        note.textContent = binOk ? '未登录' : '未安装';
      }
    }

    $('startHint').textContent = h.ready
      ? '环境就绪'
      : '有 agent 未就绪，先修好再开始（可运行 agent-duet-workbench doctor 查看）';
    $('btnStart').disabled = !h.ready;

    if (!h.ready) {
      const missing = [];
      if (!h.bins.claude) missing.push('claude CLI 未安装');
      else if (!h.auth.claude.loggedIn) missing.push('claude 未登录（终端执行 claude auth login）');
      if (!h.bins.codex) missing.push('codex CLI 未找到');
      else if (!h.auth.codex.loggedIn) missing.push('codex 未登录');
      toast(missing.join('；'), 'error');
    }
  } catch (err) {
    toast(`无法连接后端：${err.message}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* 历史会话                                                            */
/* ------------------------------------------------------------------ */

async function loadSessions() {
  try {
    const { sessions } = await api('/api/sessions');
    const list = $('sessionList');
    list.innerHTML = '';
    if (!sessions.length) {
      list.innerHTML = '<div class="empty" style="padding:10px">还没有记录</div>';
      return;
    }
    for (const s of sessions) {
      const el = document.createElement('div');
      el.className = `session-item${s.id === state.sessionId ? ' active' : ''}`;
      // live 才是真的在跑；落盘 status 可能是上个进程留下的 running
      const key = s.live ? 'running' : s.status;
      const when = new Date(s.createdAt).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      el.innerHTML = `
        <div class="si-req">${escapeHtml(s.requirement.slice(0, 90))}</div>
        <div class="si-meta">
          <span class="si-status ${statusStyle(key)}">${statusText(key)}</span>
          <span class="si-when">${when}</span>
          <button class="si-del" title="删除这条记录">删除</button>
        </div>`;
      // 之前只有 div + onclick：键盘 Tab 不到、回车打不开，
      // 行内唯一能聚焦的反而是「删除」按钮 —— 键盘用户按回车就把记录删了。
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', `打开会话：${s.requirement.slice(0, 60)}`);
      el.onclick = () => openSession(s.id);
      el.onkeydown = (e) => {
        // 行内删除按钮是独立操作：键盘事件会冒泡到行，不能因此打开会话。
        if (e.target !== el) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSession(s.id); }
      };
      el.querySelector('.si-del').onclick = async (e) => {
        e.stopPropagation();   // 否则会顺带把会话打开
        const okDel = await askConfirm(
          `删除这条会话记录？\n\n${s.requirement.slice(0, 80)}\n\n只删本地记录，项目目录里的文件不动。`,
          { title: '删除记录', danger: true },
        );
        if (!okDel) return;
        try {
          await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
          toast('已删除', 'ok');
          if (state.sessionId === s.id) showSetup();
          await loadSessions();
        } catch (err) {
          toast(err.message, 'error');
        }
      };
      list.appendChild(el);
    }
  } catch { /* 侧栏失败不影响主流程 */ }
}

/* ------------------------------------------------------------------ */
/* 会话视图                                                            */
/* ------------------------------------------------------------------ */

function showSetup() {
  if (state.es) { state.es.close(); state.es = null; }
  state.sessionId = null;
  state.meta = null;
  state.drafts = {};
  state.turns = {};
  state.plan = '';
  state.running = false;

  $('setupView').hidden = false;
  $('sessionView').hidden = true;
  // 没有会话可插话，直接禁用比打开一个发不出去的弹窗更清楚
  $('btnGuidance').disabled = true;
  $('btnContinue').disabled = true;
  $('btnComplete').hidden = true;
  clearBusyStates();
  if (location.hash) history.replaceState(null, '', location.pathname);
  resetBoard();
  loadSessions();
}

function resetBoard() {
  $('colClaude').innerHTML = '';
  $('colCodex').innerHTML = '';
  $('statusClaude').textContent = '';
  $('statusCodex').textContent = '';
  $('consensusBody').innerHTML = '<div class="empty">双方给出第一轮结论后会显示在这里。</div>';
  $('consensusBadge').textContent = '等待中';
  $('consensusBadge').className = 'badge';
  $('planBody').innerHTML = '<div class="empty">讨论收敛后生成。</div>';
  $('diffBody').innerHTML = '<span class="empty">尚未产生改动。</span>';
  $('fileList').innerHTML = '';
  $('diffBadge').textContent = '';
  $('btnRollback').hidden = true;
  $('reqStrip').innerHTML = '';
  $('reqStrip').hidden = true;
  // 复位时这些操作按钮都该是禁用的；真正可用与否由 openSession 按 running / status 决定
  $('btnStop').disabled = true;
  $('btnGuidance').disabled = true;
  $('btnContinue').disabled = true;
  $('btnComplete').hidden = true;
  $('sessionLog').innerHTML = '';
  $('sessionLog').hidden = true;
  state.reached = new Set();
  state.lastRound = null;
  state.consensusHistory = [];
  state.stats = { calls: 0, rounds: 0, inTok: 0, outTok: 0, cost: 0 };
  state.agentModels = {};
  state.modelConfig = {};
  $('convergence').hidden = true;
  $('convergence').innerHTML = '';
  $('sessionStats').hidden = true;
  $('sessionStats').innerHTML = '';
  setPhase(null);
}

/**
 * 往会话日志里追加一行。
 *
 * 编排器的 log（为什么停、追加了几轮）和 agent 的 stderr 原本**完全没有界面出口**，
 * 只存在于事件文件里。出问题时用户看到界面停住却不知道为什么。
 */
function appendLog(text, kind = '', ts) {
  const box = $('sessionLog');
  if (!box || !text) return;
  box.hidden = false;
  const t = new Date(ts || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
  const body = String(text).slice(0, 400);
  const key = `${kind}|${body}`;

  // 连续完全相同的行折叠成一条并计数。
  // codex 每一轮都会打同一段启动横幅，不折叠的话日志区会被它刷满，
  // 真正有用的「为什么停了」反而被挤得看不见。
  const last = box.lastElementChild;
  if (last && last.dataset.key === key) {
    const count = Number(last.dataset.count || 1) + 1;
    last.dataset.count = String(count);
    last.textContent = `${t}  ${body}  (×${count})`;
    box.scrollTop = box.scrollHeight;
    return;
  }

  const line = document.createElement('div');
  line.className = `log-line ${kind}`;
  line.dataset.key = key;
  line.dataset.count = '1';
  line.textContent = `${t}  ${body}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

/**
 * 更新阶段路线。
 * `done` 是已完成的阶段，`round` 只显示在当前阶段上 —— 讨论会循环，
 * 不标轮次就看不出它已经来回几轮了。
 */
function setPhase(active, done = [], round = null) {
  for (const el of document.querySelectorAll('.phase')) {
    const p = el.dataset.phase;
    const isActive = p === active;
    el.classList.toggle('active', isActive);
    el.classList.remove('halted');
    // 当前阶段不重复标"已完成"，否则节点会同时是勾又是脉冲
    el.classList.toggle('done', !isActive && done.includes(p));
    const badge = el.querySelector('.phase-round');
    if (badge) badge.textContent = isActive && round ? `第 ${round} 轮` : '';
  }
}

/* ------------------------------------------------------------------ */
/* 会话状态显示                                                        */
/* ------------------------------------------------------------------ */

/**
 * 会话状态的**唯一**文案来源。
 *
 * 这里曾经散着两份独立的映射（侧栏一份、finishSession 一份）。
 * 后来给「已中断」补中文时只改了侧栏那份，于是会话结束时弹出的提示
 * 是原始的英文 `interrupted` —— 用户看到一摞英文状态名的弹窗。
 * 现在只保留这一份，任何地方要显示状态都必须走 statusText / statusStyle。
 */
const STATUS_TEXT = {
  running: '进行中',
  // delivered = 这一轮自动化流程做完了，但**任务算不算完成由用户判定**。
  // 所以它不叫「已完成」，也不锁死操作 —— 用户随时可以接着提需求。
  delivered: '已交付 · 待你确认',
  completed: '已完成',
  stopped: '已中止',
  interrupted: '已中断',
  failed: '已失败',
  corrupted: '记录损坏',
};

const STATUS_STYLE = {
  running: 'run',
  delivered: 'warn',
  completed: 'ok',
  stopped: 'dim',
  interrupted: 'warn',
  failed: 'bad',
  corrupted: 'bad',
};

function statusText(key) { return STATUS_TEXT[key] || key; }
function statusStyle(key) { return STATUS_STYLE[key] || 'dim'; }

function sessionStatusHtml(meta, running) {
  const key = running ? 'running' : (meta?.status || 'completed');
  // 中断是最容易被误解的一种状态（看起来像还在跑），所以把原因挂在 title 上
  const title = key === 'interrupted'
    ? ` title="${escapeHtml(meta?.interruptedReason || '服务重启导致会话中断')}"`
    : '';
  return `<span class="status-pill ${statusStyle(key)}"${title}>${statusText(key)}</span>`;
}

function renderSessionMeta() {
  const meta = state.meta;
  if (!meta) return;
  $('sessionMeta').innerHTML = [
    sessionStatusHtml(meta, state.running),
    `<span>目录 <code>${escapeHtml(meta.projectDir)}</code></span>`,
    meta.cycle > 1 ? `<span>第 ${meta.cycle} 次需求</span>` : '',
    `<span>开始于 ${new Date(meta.createdAt).toLocaleString('zh-CN')}</span>`,
    meta.confirmedAt ? `<span>你已验收 ${new Date(meta.confirmedAt).toLocaleString('zh-CN')}</span>` : '',
    meta.baseSha ? `<span>基线 <code>${String(meta.baseSha).slice(0, 8)}</code></span>` : '',
    meta.scopeNotice
      ? `<span class="scope-notice" title="${escapeHtml(meta.scopeNotice)}">⚠ 仓库子目录，改动已限定范围</span>`
      : '',
  ].filter(Boolean).join('');
}

/* ------------------------------------------------------------------ */
/* 模型                                                                */
/* ------------------------------------------------------------------ */

/**
 * 下拉/弹窗该显示哪个模型。
 *
 * **你明确选过的优先**，没选过才回落到 CLI 上报的实际值 —— 那正好回答「默认到底是哪个模型」。
 * 反过来（实际优先）会出问题：刚改完、CLI 还没按新模型跑过，界面却还显示上一个，
 * 看着就像没改成功。两者不一致时的差异由 tooltip 说明。
 */
function modelSelectedValue(agent) {
  return state.modelConfig[agent] ?? state.agentModels[agent] ?? null;
}

/** 显示用的模型名：与下拉同一套优先级，避免弹窗和列头各说一套。 */
function modelLabel(agent) {
  const selected = modelSelectedValue(agent);
  if (selected) return selected;
  const dflt = agent === 'codex' ? state.modelInfo?.codex?.default : null;
  return dflt ? `${dflt}（配置）` : '默认';
}

function modelTitle(agent) {
  const lines = [];
  if (state.agentModels[agent]) lines.push(`CLI 实际上报：${state.agentModels[agent]}`);
  lines.push(`你选的：${state.modelConfig[agent] || '默认'}`);
  const dflt = agent === 'codex' ? state.modelInfo?.codex?.default : null;
  if (dflt) lines.push(`config.toml 里的默认：${dflt}`);
  lines.push('点击可以改，下一个发言起生效');
  return lines.join(String.fromCharCode(10));
}

/**
 * 列头下拉的选项：真实候选 + 「你选的 / 正在用」兜底项 + 自定义。
 *
 * 选中项 = 你选的那个；没选过才显示 CLI 上报的实际值。所以它既回答了「现在用的哪个」，
 * 本身又是换模型的入口。
 */
function colModelOptionsHtml(agent) {
  const info = state.modelInfo?.[agent] || {};
  const list = [...(info.options || [{ id: null, label: '默认' }])];
  const known = new Set(list.map((o) => o.id));
  const configured = state.modelConfig[agent] ?? null;
  const actual = state.agentModels[agent] || null;
  if (configured && !known.has(configured)) {
    list.push({ id: configured, label: `${configured}（你选的）` });
    known.add(configured);
  }
  if (actual && !known.has(actual)) {
    // 会话没在跑时说「正在用」是假话，那是上一轮跑的那个
    list.push({ id: actual, label: `${actual}（${state.running ? '正在用' : '上次用的'}）` });
    known.add(actual);
  }
  const selected = modelSelectedValue(agent);
  const html = list.map((o) => {
    const value = o.id == null ? '' : String(o.id);
    const isSel = (o.id ?? null) === (selected ?? null) ? ' selected' : '';
    return `<option value="${escapeHtml(value)}"${isSel}>${escapeHtml(o.label || o.id || '默认')}</option>`;
  }).join('');
  return html + '<option value="__custom__">自定义…</option>';
}

function renderModelChips() {
  for (const agent of ['claude', 'codex']) {
    const el = $(agent === 'claude' ? 'modelClaude' : 'modelCodex');
    if (!el) continue;
    el.innerHTML = colModelOptionsHtml(agent);
    el.title = modelTitle(agent);
    el.classList.toggle('configured', Boolean(state.modelConfig[agent]));
  }
}

/**
 * 下拉选项：默认 + 自动带进来的候选 + 自定义。
 *
 * 候选不一定列全（claude 就没有列模型的子命令），所以必须允许手填；
 * 用户手填过的值不在候选里，也要能选中并显示出来。
 */
function modelOptionsHtml(agent, configured) {
  const info = state.modelInfo?.[agent] || {};
  const options = info.options || [{ id: null, label: '默认' }];
  const known = new Set(options.map((o) => o.id));
  const html = options.map((o) => {
    const selected = (configured ?? null) === (o.id ?? null) ? ' selected' : '';
    const label = o.label || o.id || '默认';
    return `<option value="${escapeHtml(o.id ?? '')}"${selected}>${escapeHtml(label)}</option>`;
  }).join('');
  const extra = configured && !known.has(configured)
    ? `<option value="${escapeHtml(configured)}" selected>${escapeHtml(configured)}（手填）</option>`
    : '';
  return html + extra + '<option value="__custom__">自定义…</option>';
}

/** 「高级设置」里选中的模型（手填档取输入框的值）。空 = 用默认。 */
function pickedModel(agent) {
  const sel = $(agent === 'claude' ? 'claudeModel' : 'codexModel');
  const custom = $(agent === 'claude' ? 'claudeModelCustom' : 'codexModelCustom');
  const value = sel.value === '__custom__' ? custom.value.trim() : sel.value;
  return value || null;
}

/** 拉一次可选模型填进下拉。拉不到也不致命：还有「默认」和手填两条路。 */
async function loadModelInfo() {
  try {
    state.modelInfo = (await api('/api/models')).models || null;
  } catch {
    state.modelInfo = null;
  }
  for (const agent of ['claude', 'codex']) {
    const sel = $(agent === 'claude' ? 'claudeModel' : 'codexModel');
    if (!sel) continue;
    const info = state.modelInfo?.[agent] || {};
    const configured = info.configured ?? null;
    sel.innerHTML = modelOptionsHtml(agent, configured);
    const isCustom = Boolean(configured) && !(info.options || []).some((o) => o.id === configured);
    const custom = $(agent === 'claude' ? 'claudeModelCustom' : 'codexModelCustom');
    custom.hidden = !isCustom;
    custom.value = isCustom ? configured : '';
    const hint = $(agent === 'claude' ? 'claudeModelHint' : 'codexModelHint');
    if (hint && info.note) hint.textContent = info.note;
    // 服务端记住的偏好比 localStorage 里的旧表单值权威
    state.modelConfig[agent] = configured;
  }
  renderModelChips();
}

/**
 * 清掉「正在跑」的视觉残留。
 *
 * turn.start 会挂上转圈、turn.end 才摘掉。但进程被杀时（服务重启、崩溃、
 * kill -9）turn.end 根本不会被写进事件流 —— 于是界面会**永远转圈**，
 * 看起来 agent 还在干活。实际上什么都没有在跑，用户会一直等下去。
 * 这是真实发生过的：一个会话断在 03:45，界面转到用户来问「他们还在跑啊」。
 */
function clearBusyStates() {
  for (const el of document.querySelectorAll('.col-status')) {
    el.textContent = '';
    el.classList.remove('busy');
  }
  for (const el of document.querySelectorAll('.msg.draft')) {
    const body = el.querySelector('.msg-body');
    // 已经有内容的草稿是真产出，保留；只有空转圈的才删
    if (!body || !body.textContent.trim()) el.remove();
    else el.classList.remove('draft');
  }
  state.drafts = {};
}

async function openSession(id) {
  // 请求序号：快速连点两个会话时，先发的那次若响应更慢，
  // 会在后点的那次渲染完之后把它整个覆盖掉 —— 用户看到的是自己没点的会话。
  const myReq = ++openReqSeq;
  try {
    const data = await api(`/api/sessions/${id}`);
    if (myReq !== openReqSeq) return;   // 期间又打开了别的会话，这次结果作废
    state.sessionId = id;
    state.meta = data.meta;
    state.running = data.running;
    state.drafts = {};
    state.turns = {};
    state.plan = data.plan || '';

    $('setupView').hidden = true;
    $('sessionView').hidden = false;
    // 写进地址栏：刷新后还停在这个会话，也方便直接把链接发给别人
    history.replaceState(null, '', `#/s/${id}`);
    resetBoard();
    // 这个会话配置的模型；重放 session 事件时会补上 CLI 实际上报的那个
    state.modelConfig = {
      claude: data.meta.settings?.claudeModel ?? null,
      codex: data.meta.settings?.codexModel ?? null,
    };
    renderModelChips();

    $('sessionReq').textContent = data.meta.requirement;
    renderSessionMeta();

    $('btnStop').disabled = !data.running;
    // 插话在有会话时永远可用：会话停了也要能收下（会先记下来，下次继续时交给他们）
    $('btnGuidance').disabled = false;
    $('btnRollback').hidden = !data.meta.baseSha || data.running;
    updateSessionActions(data.meta.status);

    // 重放历史事件，然后再挂实时流。
    // server 返回的是**合并过 delta** 的事件（一个 7000 事件的会话合并后只剩几百条），
    // 所以这里的重放成本很低；eventCount 用来告诉 SSE 别再发一遍。
    for (const ev of data.events) applyEvent(ev, true);
    if (state.plan) renderPlan(state.plan);
    // 会话已经不在跑了，就不该留下任何"正在跑"的视觉残留 —— 见 clearBusyStates 的说明
    if (!data.running) clearBusyStates();
    renderStats();
    renderConvergence();   // 容器现在可见了，能量到真实宽度
    refreshDiff();

    if (data.running) {
      setPhase(data.meta.phase);
      connectStream(id, data.lastSeq ?? 0);
    } else {
      // 历史状态，不是刚刚发生的事 —— replay=true 才不会每开一个会话就弹一次提示。
      // 正常情况下上面重放 session.end 时已经走过一遍，这里只是没有该事件时的兜底。
      finishSession(data.meta.status, data.meta.outcome, true);
    }
    loadSessions();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/**
 * 挂上实时事件流。
 *
 * `after` = 已经处理过的最大事件 seq。服务端只补发 seq 更大的，所以不会重复渲染。
 *
 * 重连必须**自己管**：EventSource 按规范会用同一个 URL 重连，那个 URL 里的 after
 * 是建连时烘死的、不会前进。交给它自动重连的话，服务端会把已经处理过的历史全发一遍
 * —— 消息重复渲染，而且每重放一个 turn.start 就多一个气泡，留下一堆永远转圈的幽灵。
 * 所以 onerror 里主动 close，带上推进后的游标重开。
 */
function connectStream(id, after = 0) {
  if (state.es) { state.es.close(); state.es = null; }
  const es = new EventSource(`/api/sessions/${id}/stream?after=${after}`);
  state.es = es;
  let cursor = after;

  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; /* 忽略坏帧 */ }
    // 双重保险：即使服务端把边界那条又发了一次，这里也会丢掉
    if (Number.isFinite(ev.seq)) {
      if (ev.seq <= cursor) return;
      cursor = ev.seq;
    }
    applyEvent(ev);
  };

  es.onerror = () => {
    es.close();
    if (state.es === es) state.es = null;
    // 已经切到别的会话就别重连了，否则新会话会被旧会话的事件污染
    if (state.sessionId !== id) return;
    setTimeout(() => {
      if (state.sessionId === id && !state.es) connectStream(id, cursor);
    }, 1500);
  };
}

/* ------------------------------------------------------------------ */
/* 事件渲染                                                            */
/* ------------------------------------------------------------------ */

function colBody(agent) {
  return agent === 'claude' ? $('colClaude') : $('colCodex');
}

function colStatusEl(agent) {
  return agent === 'claude' ? $('statusClaude') : $('statusCodex');
}

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

function autoscroll(el, wasNear) {
  if (wasNear) el.scrollTop = el.scrollHeight;
}

function applyEvent(ev, replay = false) {
  switch (ev.type) {
    case 'session': {
      // CLI 自己上报的模型，比「你选的」可信：CLI 可能没接受这个参数，
      // 也可能把别名解析成了别的模型。所以显示时以它为准。
      if (ev.model) {
        state.agentModels[ev.agent] = String(ev.model);
        renderModelChips();
      }
      break;
    }

    case 'model.changed': {
      // 换模型不一定马上生效（跑着的时候要等下一个发言），所以如实写清时机
      state.modelConfig[ev.agent] = ev.model ?? null;
      renderModelChips();
      appendLog(
        `${ev.agent} 换成 ${ev.model || '默认模型'}（${ev.effective === 'next-turn' ? '下一个发言' : '下次继续'}起生效）`,
        'warn',
        ev.ts,
      );
      break;
    }

    case 'session.start':
      state.running = true;
      renderModelChips();
      $('btnContinue').disabled = true;
      $('btnComplete').hidden = true;
      break;

    case 'requirement': {
      // 用户追加的需求。标题只放得下第一次的需求，这里把后续的列出来。
      const strip = $('reqStrip');
      strip.hidden = false;
      const card = document.createElement('div');
      card.className = 'req-card';
      const head = document.createElement('div');
      head.className = 'req-card-head';
      head.textContent = '第 ' + (ev.cycle || 2) + ' 次需求 · ' + fmtTime(ev.ts || Date.now());
      const body = document.createElement('div');
      body.className = 'req-card-body';
      body.textContent = ev.text || '';
      card.append(head, body);
      strip.appendChild(card);
      if (!replay) toast('已追加第 ' + (ev.cycle || 2) + ' 次需求，他们接着做', 'ok');
      break;
    }

    case 'session.confirmed': {
      // 用户自己宣布任务结束 —— 这是「已完成」唯一的来源
      if (state.meta) {
        state.meta.status = 'completed';
        state.meta.awaitingUser = false;
        state.meta.confirmedAt = ev.at;
        renderSessionMeta();
      }
      $('btnComplete').hidden = true;
      if (!replay) toast('你已验收，这个会话标记为已完成', 'ok');
      break;
    }

    case 'phase': {
      const idx = PHASES.indexOf(ev.phase);
      setPhase(ev.phase, PHASES.slice(0, Math.max(idx, 0)), ev.round);
      if (ev.round) state.stats.rounds = Math.max(state.stats.rounds, ev.round);
      state.reached.add(ev.phase);
      state.lastRound = ev.round || state.lastRound;
      break;
    }

    case 'turn.start': {
      const body = colBody(ev.agent);
      if (!body) break;
      const wasNear = nearBottom(body);

      // 追加需求后的轮次要标出是第几次需求，否则「第 1 轮」会在同一条时间线上出现两次
      const cycleTag = ev.cycle > 1 ? '第 ' + ev.cycle + ' 次需求 · ' : '';
      const card = document.createElement('div');
      card.className = 'msg draft';
      card.innerHTML = `
        <div class="msg-head">
          <span class="msg-round">${cycleTag}第 ${ev.round} 轮 · ${PHASE_LABEL[ev.phase] || ev.phase}</span>
          <span class="msg-time">${fmtTime(ev.ts || Date.now())}</span>
        </div>
        <div class="tools"></div>
        <div class="msg-body"><span class="spinner"></span></div>`;
      body.appendChild(card);
      state.drafts[ev.agent] = card;

      const st = colStatusEl(ev.agent);
      st.textContent = '思考中…';
      st.classList.add('busy');
      autoscroll(body, wasNear);
      break;
    }

    case 'delta': {
      const card = state.drafts[ev.agent];
      if (!card) break;
      const body = colBody(ev.agent);
      const wasNear = nearBottom(body);
      const target = card.querySelector('.msg-body');
      if (target.querySelector('.spinner')) target.textContent = '';
      target.append(ev.text);
      autoscroll(body, wasNear);
      break;
    }

    case 'thinking': {
      const card = state.drafts[ev.agent];
      if (!card || !ev.text) break;
      const box = document.createElement('div');
      box.className = 'thinking';
      box.textContent = ev.text.slice(0, 1500);
      card.querySelector('.tools').appendChild(box);
      break;
    }

    case 'tool': {
      const card = state.drafts[ev.agent];
      if (!card) break;
      const body = colBody(ev.agent);
      const wasNear = nearBottom(body);
      const row = document.createElement('div');
      const cls = ev.exitCode != null && ev.exitCode !== 0 ? 'err' : (ev.state === 'done' ? 'ok' : '');
      row.className = `tool ${cls}`;
      row.innerHTML = `<span class="tool-name">${escapeHtml(ev.name || 'tool')}</span><span class="tool-detail">${escapeHtml(ev.detail || '')}</span>`;
      card.querySelector('.tools').appendChild(row);
      autoscroll(body, wasNear);
      break;
    }

    case 'message': {
      const card = state.drafts[ev.agent];
      if (!card) break;
      const body = colBody(ev.agent);
      const wasNear = nearBottom(body);
      card.classList.remove('draft');
      card.querySelector('.msg-body').innerHTML = `<div class="markdown">${renderMarkdown(ev.text)}</div>`;
      delete state.drafts[ev.agent];
      autoscroll(body, wasNear);
      break;
    }

    case 'status': {
      const st = colStatusEl(ev.agent);
      if (!st) break;
      const map = { running: '启动中…', thinking: '思考中…', done: '完成', error: '出错', aborted: '已中止' };
      st.textContent = map[ev.status] || ev.status;
      st.classList.toggle('busy', ev.status === 'running' || ev.status === 'thinking');
      break;
    }

    case 'turn.end': {
      const st = colStatusEl(ev.agent);
      if (st) st.classList.remove('busy');
      const card = state.drafts[ev.agent];
      if (card && !ev.ok) {
        card.classList.remove('draft');
        const bodyEl = card.querySelector('.msg-body');
        // 被中断时，agent 已经流式产出的内容必须**留着**：立即执行的意思是
        // 「在这个基础上调整」，不是把它擦掉，更不该用一行错误信息把它盖住。
        if (ev.aborted && bodyEl.textContent.trim()) {
          card.classList.add('interrupted');
          const note = document.createElement('div');
          note.className = 'interrupt-note';
          note.textContent = '这一轮被中断，上面的内容已保留，接下来会在它的基础上继续调整';
          bodyEl.appendChild(note);
        } else {
          card.classList.add('error');
          bodyEl.innerHTML = `<div class="markdown">${renderMarkdown(ev.error || '失败')}</div>`;
        }
        delete state.drafts[ev.agent];
      }
      if (ev.usage && !replay) {
        const tok = ev.usage.output_tokens ?? ev.usage.outputTokens;
        const cost = ev.costUsd ? ` · $${ev.costUsd.toFixed(3)}` : '';
        if (st && tok != null) st.textContent = `${tok} tok${cost}`;
      }
      // 重放历史时也要累计，否则打开旧会话看不到总账
      if (ev.usage || ev.costUsd) {
        const u = ev.usage || {};
        state.stats.calls += 1;
        state.stats.inTok += (u.input_tokens ?? u.inputTokens ?? 0);
        state.stats.outTok += (u.output_tokens ?? u.outputTokens ?? 0);
        state.stats.cost += ev.costUsd || 0;
        renderStats();
      }
      break;
    }

    case 'consensus': {
      // 累积每一轮的计数，供收敛曲线使用
      state.consensusHistory.push({
        round: ev.round,
        converged: Boolean(ev.converged),
        agreements: (ev.agreements || []).length,
        // 新协议下未决项就是账本大小；老会话没有 openCount，回退到旧的算法
        open: ev.openCount != null
          ? ev.openCount
          : (ev.disagreements || []).length + (ev.blocking || []).length,
      });
      renderConsensus(ev);
      renderConvergence();
      break;
    }

    case 'review.verdict':
      // 同样是历史事件，重放时不该弹
      if (!replay) {
        toast(ev.rejected ? `第 ${ev.round} 轮验收：打回，需要返工` : `第 ${ev.round} 轮验收：放行`,
          ev.rejected ? '' : 'ok');
      }
      break;

    case 'plan':
      state.plan = ev.markdown;
      renderPlan(ev.markdown);
      break;

    case 'diff':
      renderDiffPanel(ev.diff, ev.files);
      break;

    case 'checkpoint':
      if (!replay) toast(`已建立 git 检查点 ${String(ev.sha).slice(0, 8)}`, 'ok');
      if (ev.sha && !state.running) $('btnRollback').hidden = false;
      break;

    case 'guidance.queued': {
      // 会话停下时插的话：也放进需求区，否则用户看不到自己说过什么
      const strip = $('reqStrip');
      strip.hidden = false;
      const card = document.createElement('div');
      card.className = 'req-card note';
      const head = document.createElement('div');
      head.className = 'req-card-head';
      head.textContent = '你说的一句话（已记下）· ' + fmtTime(ev.ts || Date.now());
      const body = document.createElement('div');
      body.className = 'req-card-body';
      body.textContent = ev.text || '';
      card.append(head, body);
      strip.appendChild(card);
      break;
    }

    case 'guidance.delivered':
      // 用户最需要知道的就是"我的话到底送出去没有"，所以这里明确回执
      if (!replay) toast(`补充要求已传达给双方（${ev.phase} 阶段）`, 'ok');
      break;

    case 'rate_limit':
      if (!replay && ev.windows?.five_hour) {
        const pct = Math.round(ev.windows.five_hour.utilization * 100);
        if (pct >= 80) toast(`Claude 5 小时额度已用 ${pct}%`, 'error');
      }
      break;

    case 'warning':
      if (!replay) toast(ev.text, '');
      appendLog(ev.text, 'warn', ev.ts);
      break;

    case 'log':
      // 区分两类来源：适配器转发上来的原始输出带 agent 字段，多半是 codex 的杂项文本，
      // 太吵，不进日志区；编排器发的（没有 agent 字段）才是用户要知道的，比如
      // 「第 3 轮达成一致，停止讨论」「达到轮数上限，按当前状态定稿」。
      if (!ev.agent && ev.text) appendLog(ev.text, '', ev.ts);
      break;

    case 'stderr':
      // agent 的报错原本完全不可见 —— 出问题时用户只看到界面停住，不知道发生了什么
      if (ev.text) appendLog(ev.text, 'err', ev.ts);
      break;

    case 'error':
      if (!replay) toast(ev.text, 'error');
      appendLog(ev.text, 'err', ev.ts);
      break;

    case 'session.end':
      finishSession(ev.status, ev.outcome, replay);
      break;
  }
}

function renderConsensus(ev) {
  const badge = $('consensusBadge');
  const sec = (title, items, cls) => {
    if (!items?.length) return '';
    return `<div class="consensus-sec ${cls}"><h4>${title}</h4><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>`;
  };
  const head = `<div class="consensus-sec"><h4>第 ${ev.round} 轮判定</h4><div style="font-size:12.5px;color:var(--text-dim)">${escapeHtml(ev.reason || '')}</div></div>`;

  // 新协议：判据是「还有几条待定」，不是「双方是否满意」。
  // 方案能开工只需要没有问题悬着 —— 那比全体一致容易达到得多。
  if (ev.openCount != null) {
    const open = ev.openCount;
    badge.textContent = open === 0 ? '无待定项' : `待定 ${open} 项`;
    badge.className = `badge ${open === 0 ? 'ok' : 'warn'}`;

    const ledgerItems = (ev.ledger || []).map((i) => `#${i.id}（第 ${i.raisedRound} 轮）${i.text}`);
    const decisionItems = (ev.decisions || []).map((d) => `#${d.id} → ${d.how}${d.why ? `（${d.why}）` : ''}`);
    $('consensusBody').innerHTML = [
      head,
      sec(`待定 (${open})`, ledgerItems, open ? 'disagree' : 'agree'),
      sec(`已裁决 (${decisionItems.length})`, decisionItems, 'agree'),
      sec(`已一致 (${ev.agreements?.length || 0})`, ev.agreements, 'agree'),
    ].join('') || '<div class="empty">暂无信息</div>';
    return;
  }

  // 老会话（没有账本字段）沿用旧判定，不要在翻历史时显示成空
  const softCount = ev.disagreements?.length || 0;
  badge.textContent = ev.converged
    ? (softCount ? `已一致（${softCount} 条非阻塞分歧）` : '已达成一致')
    : '仍有分歧';
  badge.className = `badge ${ev.converged ? 'ok' : 'warn'}`;
  $('consensusBody').innerHTML = [
    head,
    sec(`已一致 (${ev.agreements?.length || 0})`, ev.agreements, 'agree'),
    sec(
      ev.converged ? `非阻塞分歧 (${softCount})` : `分歧 (${softCount})`,
      ev.disagreements,
      ev.converged ? 'agree' : 'disagree',
    ),
    sec(`阻塞项 (${ev.blocking?.length || 0})`, ev.blocking, 'blocking'),
  ].join('') || '<div class="empty">暂无信息</div>';
}

/**
 * 收敛曲线：把「他们从分歧走向一致」这个过程画出来。
 *
 * 光看文字列表看不出轨迹 —— 一致项在一轮轮涨、待定项在一轮轮掉，
 * 这条线本身就是这个工具在做的事。横轴是轮次，虚线是待定项（还没结案的议题），
 * 实线是一致项；如果某一轮达成一致，会有一条竖线标出来。
 */
function renderConvergence() {
  const box = $('convergence');
  if (!box) return;
  const hist = state.consensusHistory || [];
  if (hist.length < 2) { box.hidden = true; return; }
  box.hidden = false;

  const W = Math.max(160, Math.round(box.clientWidth || 240));
  const H = 42;
  const PAD = 5;
  const maxV = Math.max(1, ...hist.map((h) => Math.max(h.agreements, h.open)));
  const step = hist.length > 1 ? (W - PAD * 2) / (hist.length - 1) : 0;
  const x = (i) => PAD + i * step;
  const y = (v) => H - PAD - (v / maxV) * (H - PAD * 2);

  const pts = (get) => hist.map((h, i) => `${x(i).toFixed(1)},${y(get(h)).toFixed(1)}`).join(' ');
  const dots = (get, cls) => hist
    .map((h, i) => `<circle class="${cls}" cx="${x(i).toFixed(1)}" cy="${y(get(h)).toFixed(1)}" r="1.7"/>`)
    .join('');

  const conv = hist.findIndex((h) => h.converged);
  const mark = conv >= 0
    ? `<line class="conv-line" x1="${x(conv).toFixed(1)}" y1="${PAD - 2}" x2="${x(conv).toFixed(1)}" y2="${H - PAD + 2}"/>`
    : '';

  const last = hist[hist.length - 1];
  box.innerHTML = `
    <svg class="conv-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      ${mark}
      <polyline class="conv-open" points="${pts((h) => h.open)}"/>
      <polyline class="conv-agree" points="${pts((h) => h.agreements)}"/>
      ${dots((h) => h.open, 'dot-open')}
      ${dots((h) => h.agreements, 'dot-agree')}
    </svg>
    <div class="conv-legend">
      <span class="lg-agree">一致 <b>${last.agreements}</b></span>
      <span class="lg-open">待定 <b>${last.open}</b></span>
      <span class="lg-note">${hist.length} 轮${conv >= 0 ? ` · 第 ${hist[conv].round} 轮收敛` : ''}</span>
    </div>`;
}

/** 成本看板：这场讨论跑了多少、烧了多少。 */
function renderStats() {
  const box = $('sessionStats');
  if (!box) return;
  const st = state.stats;
  if (!st || !st.calls) { box.hidden = true; return; }
  box.hidden = false;
  const fmt = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const item = (label, value, cls = '') =>
    `<span class="stat ${cls}">${label} <b>${value}</b></span>`;
  box.innerHTML = [
    st.rounds ? item('讨论', `${st.rounds} 轮`) : '',
    item('模型调用', `${st.calls} 次`),
    item('输入', fmt(st.inTok)),
    item('输出', fmt(st.outTok)),
    st.cost > 0 ? item('花费', `$${st.cost.toFixed(3)}`, 'cost') : '',
  ].filter(Boolean).join('');
}

function renderPlan(md) {
  $('planBody').innerHTML = `<div class="markdown">${renderMarkdown(md)}</div>`;
}

function renderDiffPanel(diff, files) {
  if (files) {
    $('fileList').innerHTML = files
      .map((f) => `<span class="filechip ${String(f.status)[0]}">${escapeHtml(f.path)}</span>`)
      .join('');
    $('diffBadge').textContent = files.length ? `${files.length} 个文件` : '无改动';
    $('diffBadge').className = `badge ${files.length ? 'warn' : ''}`;
  }
  $('diffBody').innerHTML = renderDiff(diff);
}

async function refreshDiff() {
  const id = state.sessionId;
  if (!id) return;
  try {
    const data = await api(`/api/sessions/${id}/changes`);
    // await 期间可能已经切到别的会话了，那就别把旧会话的改动画到新面板上
    if (state.sessionId !== id) return;
    // 查询失败时不要动已有内容：
    // 事件流里已经渲染过一份可靠的 diff，用一次失败的查询把它清空是倒退。
    if (data.error) return;
    renderDiffPanel(data.diff, data.files);
  } catch { /* 静默保留已渲染的内容 */ }
}

function finishSession(status, outcome, replay = false) {
  state.running = false;
  // 「正在用 / 上次用的」取决于在不在跑，这里状态刚变，标签得跟着重画
  renderModelChips();
  $('btnRollback').hidden = !state.meta?.baseSha;
  $('btnStop').disabled = true;
  // 停下来了也留着插话：那颗按钮变灰等于把用户刚打的话丢掉
  $('btnGuidance').disabled = !state.sessionId;
  // 跑完不等于任务结束：按钮一直留着，让用户接着提需求或自己宣布完成
  updateSessionActions(status);
  if (state.es) { state.es.close(); state.es = null; }
  // 结束就把转圈全部摘掉，别留下"还在跑"的假象
  clearBusyStates();
  if (state.meta) { state.meta.status = status; renderSessionMeta(); }

  /* 路线要如实反映去过哪。
   * 原来这里无条件 setPhase(null, PHASES) —— 把没跑过的阶段也打上勾。
   * 实测：一个只走到「交叉讨论」就被中断的会话，五个阶段全是绿色对勾。 */
  // 按**到达的最远阶段**推导，而不是看记录里有哪些 phase 事件：
  // 走进了 discuss 就意味着 propose 已经结束，哪怕当年没写那条事件。
  const lastIdx = PHASES.reduce((m, p, i) => (state.reached.has(p) ? Math.max(m, i) : m), -1);
  const reached = lastIdx >= 0 ? PHASES.slice(0, lastIdx + 1) : [];
  if (status === 'completed') {
    setPhase(null, reached);
  } else if (reached.length) {
    // 停在哪个阶段就把它标出来（琥珀色），而不是假装它完成了
    const last = reached[reached.length - 1];
    setPhase(null, reached.slice(0, -1));
    const el = document.querySelector(`.phase[data-phase="${last}"]`);
    if (el) {
      el.classList.add('halted');
      const b = el.querySelector('.phase-round');
      if (b) b.textContent = '停在这里';
    }
  } else {
    setPhase(null, []);
  }

  // 重放历史时不要弹提示：否则每点开一个已结束的会话就弹一个，很快堆成一摞。
  // （其他事件类型早就写了 if (!replay)，这里一直漏着。）
  if (!replay) {
    const issues = outcome === 'done-with-issues';
    const label = status === 'delivered'
      ? (issues ? '这一轮做完了，但仍有遗留问题 —— 算不算完成由你决定' : '这一轮做完了，等你验收或接着提需求')
      : (status === 'completed' && issues) ? '已完成（仍有遗留问题）' : statusText(status);
    // 交付不是「完成」，所以不用成功色的口气；只有用户自己确认过才给 ok
    toast(label, status === 'completed' ? 'ok' : '');
  }
  refreshDiff();
  if (!replay) {
    loadSessions();
    loadHealth();
  }
}

/* ------------------------------------------------------------------ */
/* 交互                                                                */
/* ------------------------------------------------------------------ */

$('btnStart').onclick = async () => {
  const requirement = $('requirement').value.trim();
  const projectDir = $('projectDir').value.trim();
  if (!requirement) return toast('请先写清楚要做什么', 'error');
  if (!projectDir) return toast('请选择项目目录', 'error');

  const settings = {
    maxRounds: Number($('maxRounds').value),
    leadAgent: $('leadAgent').value,
    allowWrite: $('allowWrite').value === 'true',
    sandbox: $('sandbox').value,
    maxFixRounds: Number($('maxFixRounds').value),
    claudeModel: pickedModel('claude'),
    codexModel: pickedModel('codex'),
  };

  localStorage.setItem('agent-duet-workbench.projectDir', projectDir);
  localStorage.setItem('agent-duet-workbench.settings', JSON.stringify(settings));

  $('btnStart').disabled = true;
  $('btnStart').textContent = '启动中…';
  try {
    const { id, warning } = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ requirement, projectDir, settings }),
    });
    if (warning) toast(warning, 'error');
    await openSession(id);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    $('btnStart').disabled = false;
    $('btnStart').textContent = '开始讨论';
  }
};

$('btnPickFolder').onclick = async () => {
  const btn = $('btnPickFolder');
  btn.disabled = true;
  btn.textContent = '选择中…';
  try {
    const r = await api('/api/pick-folder', { method: 'POST' });
    if (r.path) $('projectDir').value = r.path;
    else if (r.error) toast(r.error, 'error');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '选择…';
  }
};

$('btnNew').onclick = () => {
  showSetup();
  if (state.es) { state.es.close(); state.es = null; }
  $('setupView').hidden = false;
  $('sessionView').hidden = true;
};

$('btnToggleHistory').onclick = () => {
  const sb = $('sidebar');
  sb.hidden = !sb.hidden;
  if (!sb.hidden) loadSessions();
};

$('btnStop').onclick = async () => {
  // 整个流程都锁在这个 id 上：轮询要跑几十秒，期间用户完全可能切到别的会话，
  // 那时再去动按钮和弹提示，说的就是别的会话了。
  const id = state.sessionId;
  if (!id) return;
  if (!(await askConfirm('确定中止这次讨论？已经产生的改动会保留，可以之后回滚。',
    { title: '中止讨论', danger: true }))) return;
  if (state.sessionId !== id) return;
  const btn = $('btnStop');
  const label = btn.textContent;
  // 点了之后立刻禁用并改文案：否则用户看不出有没有生效，会反复点
  btn.disabled = true;
  btn.textContent = '中止中…';
  try {
    const r = await api(`/api/sessions/${id}/stop`, { method: 'POST' });
    if (!r.ok) {
      // 服务端明确说没在跑（多半是上个进程留下的残留状态），如实告诉用户
      toast(r.error || '中止失败：会话未在运行', 'error');
      return;
    }
    toast('已发送中止指令');
    // 轮询到它真的停下为止，给一个确定的结论而不是"已发送"就完事
    for (let i = 0; i < 40; i += 1) {
      await sleep(500);
      const d = await api(`/api/sessions/${id}`).catch(() => null);
      if (state.sessionId !== id) return;   // 切走了就别再动按钮/弹提示
      if (!d || !d.running) { toast('已中止', 'ok'); return; }
    }
    toast('指令已发送，但会话仍在响应，请稍候…', 'error');
  } catch (err) {
    if (state.sessionId === id) toast(err.message, 'error');
  } finally {
    if (state.sessionId === id) {
      btn.textContent = label;
      const d = await api(`/api/sessions/${id}`).catch(() => null);
      if (state.sessionId === id) btn.disabled = !d?.running;
    }
  }
};

/**
 * 自绘确认框。
 *
 * 不能用原生 `confirm()`：Chrome 在用户勾选「阻止此页面创建更多对话框」之后，
 * `confirm()` 会直接返回 false 且**不显示任何东西** —— 中止/删除/回滚三颗按钮
 * 看起来点了没反应，也没有提示。这正是之前「按钮点了没用」那类体验。
 * 自绘的还能顺便支持 Escape 关闭和焦点管理。
 */
function askConfirm(text, { title = '确认', danger = false } = {}) {
  return new Promise((resolve) => {
    const box = $('confirmModal');
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    const yes = $('btnConfirmYes');
    const no = $('btnConfirmNo');
    yes.className = danger ? 'btn danger' : 'btn primary';

    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      box.hidden = true;
      yes.onclick = null;
      no.onclick = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
    };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    document.addEventListener('keydown', onKey, true);
    box.hidden = false;
    yes.focus();
  });
}

$('btnGuidance').onclick = () => {
  if (!state.sessionId) return;
  // 文案跟着运行状态走：没在跑的时候要说清这句话什么时候才会生效，
  // 否则用户会以为按下就立刻有人看。
  if (state.running) {
    $('guidanceHint').textContent = '这句话会交给双方。等不及就选「立即执行」，不想打断当前这一轮就选「排队」。';
    $('btnGuidanceSend').textContent = '发送';
  } else {
    $('guidanceHint').textContent = '这个会话已经没在跑了：这句话会先记下来，等你点「接着提需求」时第一件事就交给双方。';
    $('btnGuidanceSend').textContent = '记下来';
  }
  // 没在跑就没有"打断当前这一轮"这回事，整个选择器收起来
  $('guidanceModes').hidden = !state.running;
  $('guidanceModal').hidden = false;
  $('guidanceText').focus();
};
$('btnGuidanceCancel').onclick = () => { $('guidanceModal').hidden = true; };
// Escape 关掉插话弹窗（确认框有自己的 Escape 处理，见 askConfirm）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('guidanceModal').hidden) $('guidanceModal').hidden = true;
  if (!$('continueModal').hidden) $('continueModal').hidden = true;
  if (!$('modelModal').hidden) { $('modelModal').hidden = true; renderModelChips(); }
});
$('btnGuidanceSend').onclick = async () => {
  const text = $('guidanceText').value.trim();
  if (!text) return;
  if (!state.sessionId) { toast('先开始一次讨论', 'error'); return; }
  const mode = document.querySelector('input[name="guidanceMode"]:checked')?.value === 'now' ? 'now' : 'queue';
  try {
    const r = await api(`/api/sessions/${state.sessionId}/guidance`, {
      method: 'POST',
      body: JSON.stringify({ text, mode }),
    });
    if (!r.ok) { toast(r.error || '发送失败', 'error'); return; }
    // 如实说明送达时机：正在跑的那一轮没法中途插进去，下一个发言机会才生效；
    // 没在跑则要说清它只是被记下了，需要用户去点「接着提需求」。
    toast(
      r.queued
        ? '已记下。这个会话没在跑，等你点「接着提需求」时第一件事就交给他们'
        : r.interrupted > 0
          ? `已打断当前这一轮（${r.interrupted} 个发言），他们会在已有的基础上接着调整`
          : r.immediate
            ? '这会儿没有正在跑的轮次，新要求会在下一个发言机会交给他们'
            : r.pending > 1
              ? `已排队 ${r.pending} 条，会在下一个发言机会一起传达`
              : `已排队，会在下一个发言机会传达（当前：${r.phase || '准备中'}）`,
      'ok',
    );
    $('guidanceText').value = '';
    $('guidanceModal').hidden = true;
  } catch (err) {
    toast(err.message, 'error');
  }
};

/**
 * 「任务算不算做完」由用户判定。
 *
 * 自动化流程跑完只代表这一轮交付了，所以「接着提需求」一直可用；
 * 「验收通过」只在真的有东西可验收（delivered）时才出现。
 */
function updateSessionActions(status = state.meta?.status) {
  const hasSession = Boolean(state.sessionId);
  $('btnContinue').disabled = !hasSession || state.running;
  $('btnComplete').hidden = !hasSession || state.running || status !== 'delivered';
}

$('btnContinue').onclick = () => {
  if (!state.sessionId || state.running) return;
  $('continueModal').hidden = false;
  $('continueText').focus();
};
$('btnContinueCancel').onclick = () => { $('continueModal').hidden = true; };
$('btnContinueSend').onclick = async () => {
  const id = state.sessionId;
  const text = $('continueText').value.trim();
  if (!id) { toast('先打开一个会话', 'error'); return; }
  if (!text) return;
  const btn = $('btnContinueSend');
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    await api(`/api/sessions/${id}/continue`, { method: 'POST', body: JSON.stringify({ text }) });
    $('continueText').value = '';
    $('continueModal').hidden = true;
    toast('已追加需求，他们接着做', 'ok');
    // 重新打开一次：新一轮的事件、按钮状态、阶段路线都以服务端为准
    if (state.sessionId === id) await openSession(id);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '继续讨论';
  }
};

$('btnComplete').onclick = async () => {
  const id = state.sessionId;
  if (!id) return;
  if (!(await askConfirm('确认这次任务已经做完？之后还能继续追加需求。', { title: '验收通过' }))) return;
  if (state.sessionId !== id) return;
  try {
    await api(`/api/sessions/${id}/complete`, { method: 'POST' });
    toast('已标记完成', 'ok');
    await openSession(id);
  } catch (err) {
    toast(err.message, 'error');
  }
};

$('btnRollback').onclick = async () => {
  const sha = state.meta?.baseSha;
  if (!sha) return;
  if (!(await askConfirm(`回滚会把项目目录重置到 ${sha.slice(0, 8)}，未提交的改动都会丢失。继续？`,
    { title: '回滚到基线', danger: true }))) return;
  try {
    await api(`/api/sessions/${state.sessionId}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ sha }),
    });
    toast('已回滚到基线', 'ok');
    refreshDiff();
  } catch (err) {
    toast(err.message, 'error');
  }
};

$('btnRefreshDiff').onclick = refreshDiff;

/* ------------------------------------------------------------------ */
/* 主题：自动 / 浅色 / 深色                                            */
/* ------------------------------------------------------------------ */

const THEME_ORDER = ['auto', 'light', 'dark'];
const THEME_ICON = { auto: '◐', light: '☀', dark: '☾' };
const THEME_LABEL = { auto: '自动', light: '浅色', dark: '深色' };
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');

/** auto 直接解析成 light/dark —— 这样 CSS 里只需要两套令牌，不必重复第三套。 */
function resolveTheme(pref) {
  return pref === 'auto' ? (darkMq.matches ? 'dark' : 'light') : pref;
}

function currentThemePref() {
  return document.documentElement.dataset.themePref
    || localStorage.getItem('agent-duet-workbench-theme')
    || 'auto';
}

function applyTheme(pref) {
  document.documentElement.dataset.theme = resolveTheme(pref);
  document.documentElement.dataset.themePref = pref;
  $('themeIcon').textContent = THEME_ICON[pref] || '◐';
  $('btnTheme').title = `主题：${THEME_LABEL[pref] || pref}（点击切换）`;
}

function setupTheme() {
  // index.html 里的内联脚本已经设过一次（防闪烁），这里只是把图标状态同步过来
  applyTheme(currentThemePref());
  $('btnTheme').onclick = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(currentThemePref()) + 1) % THEME_ORDER.length];
    localStorage.setItem('agent-duet-workbench-theme', next);
    applyTheme(next);
  };
  // 选了跟随系统时，系统主题变化要实时生效
  const onSystemChange = () => { if (currentThemePref() === 'auto') applyTheme('auto'); };
  if (darkMq.addEventListener) darkMq.addEventListener('change', onSystemChange);
  else darkMq.addListener(onSystemChange); // 老浏览器
}

setupTheme();

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const savedDir = localStorage.getItem('agent-duet-workbench.projectDir');
if (savedDir) $('projectDir').value = savedDir;
try {
  const s = JSON.parse(localStorage.getItem('agent-duet-workbench.settings') || '{}');
  if (s.maxRounds) $('maxRounds').value = s.maxRounds;
  if (s.leadAgent) $('leadAgent').value = s.leadAgent;
  if (s.allowWrite != null) $('allowWrite').value = String(s.allowWrite);
  if (s.sandbox) $('sandbox').value = s.sandbox;
  if (s.maxFixRounds != null) $('maxFixRounds').value = s.maxFixRounds;
} catch { /* 忽略损坏的本地设置 */ }

/* ---------------------------- 换模型 ---------------------------- */

let modelTarget = null;

function openModelModal(agent) {
  if (!state.sessionId) { toast('先开始一次讨论', 'error'); return; }
  modelTarget = agent;
  const info = state.modelInfo?.[agent] || {};
  const configured = state.modelConfig[agent] ?? info.configured ?? null;
  $('modelTitle').textContent = agent === 'claude' ? 'Claude 用哪个模型' : 'Codex 用哪个模型';
  $('modelHint').textContent = '改完从下一个发言起生效：跑着的会话不用停，停下的话下次继续时生效。';
  const actualNow = state.agentModels[agent] || null;
  const label = modelLabel(agent);
  // CLI 上一轮实际报的是另一个时要说清，否则「我改的到底生效没有」没法判断
  $('modelCurrent').textContent = actualNow && actualNow !== label
    ? `当前显示：${label}；CLI 上一次上报的是 ${actualNow}`
    : `当前显示：${label}`;
  $('modelSelect').innerHTML = modelOptionsHtml(agent, configured);
  const isCustom = Boolean(configured) && !(info.options || []).some((o) => o.id === configured);
  $('modelCustom').hidden = !isCustom;
  $('modelCustom').value = isCustom ? configured : '';
  $('modelNote').textContent = info.note || '';
  $('modelModal').hidden = false;
  $('modelSelect').focus();
}

$('modelSelect').onchange = () => {
  $('modelCustom').hidden = $('modelSelect').value !== '__custom__';
};
$('btnModelCancel').onclick = () => { $('modelModal').hidden = true; renderModelChips(); };
$('modelClaude').onchange = () => pickModelFromHeader('claude');
$('modelCodex').onchange = () => pickModelFromHeader('codex');

/**
 * 直接在列头下拉里换模型。
 *
 * 失败时必须把下拉恢复成真实状态 —— 否则用户看到的是「已经选上了」，实际没生效，
 * 这种「看起来成功了」的假象比报错更糟糕。
 */
async function pickModelFromHeader(agent) {
  const el = $(agent === 'claude' ? 'modelClaude' : 'modelCodex');
  if (el.value === '__custom__') { openModelModal(agent); return; }
  const raw = el.value;
  try {
    const r = await api(`/api/sessions/${state.sessionId}/model`, {
      method: 'POST',
      body: JSON.stringify({ agent, model: raw }),
    });
    state.modelConfig[agent] = r.model ?? null;
    renderModelChips();
    toast(r.message || '已更新模型', 'ok');
  } catch (err) {
    toast(err.message, 'error');
    renderModelChips();
  }
}
$('btnModelSave').onclick = async () => {
  if (!state.sessionId || !modelTarget) return;
  const raw = $('modelSelect').value === '__custom__'
    ? $('modelCustom').value.trim()
    : $('modelSelect').value;
  try {
    const r = await api(`/api/sessions/${state.sessionId}/model`, {
      method: 'POST',
      body: JSON.stringify({ agent: modelTarget, model: raw }),
    });
    state.modelConfig[modelTarget] = r.model ?? null;
    renderModelChips();
    toast(r.message || '已更新模型', 'ok');
    $('modelModal').hidden = true;
  } catch (err) {
    toast(err.message, 'error');
  }
};

// 选到「自定义」就露出输入框
for (const id of ['claudeModel', 'codexModel']) {
  $(id).onchange = () => {
    const customId = id === 'claudeModel' ? 'claudeModelCustom' : 'codexModelCustom';
    $(customId).hidden = $(id).value !== '__custom__';
  };
}

loadModelInfo();
loadHealth();
loadSessions();

// 初始就是"没有会话"的状态：这两个按钮此刻都不该可用。
// 不显式设一次的话，它们会保持 HTML 里的初始状态 —— 看起来能点，点了没用。
$('btnStop').disabled = true;
$('btnGuidance').disabled = true;
$('btnContinue').disabled = true;
$('btnComplete').hidden = true;

// 优先恢复到地址栏指向的会话；否则自动回到正在跑的那个
(async () => {
  const fromHash = location.hash.match(/^#\/s\/(.+)$/);
  if (fromHash) {
    openSession(decodeURIComponent(fromHash[1]));
    return;
  }
  try {
    const { sessions } = await api('/api/sessions');
    // 只恢复到**真的在跑**的会话。落盘的 status 可能是上个进程留下的 running，
    // 那种会话永远跑不完，自动跳进去会让人莫名其妙。
    const running = sessions.find((s) => s.live);
    if (running) openSession(running.id);
  } catch { /* 忽略 */ }
})();

// 曲线是按容器像素宽度生成的，窗口变化要重画
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.sessionId) renderConvergence(); }, 150);
});

window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#\/s\/(.+)$/);
  if (m) openSession(decodeURIComponent(m[1]));
  else showSetup();
});
