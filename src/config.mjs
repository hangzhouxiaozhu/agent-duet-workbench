import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
// 允许用环境变量把会话数据挪到别处：测试跑在临时目录，不污染真实记录
export const SESSIONS_DIR = process.env.AGENT_DUET_WORKBENCH_SESSIONS_DIR
  ? path.resolve(process.env.AGENT_DUET_WORKBENCH_SESSIONS_DIR)
  : path.join(ROOT, 'sessions');
export const HOME = os.homedir();

/** 运行期默认参数。UI 可以逐项覆盖。 */
export const DEFAULTS = {
  maxRounds: 4,          // 讨论轮数上限（含第 1 轮独立作答）
  minRounds: 2,          // 至少互评一次才允许判停
  allowWrite: true,      // 用户已选择：允许直接改代码
  // 实现阶段给 agent 多大权限：
  //   'workspace' = 能写项目目录 + 能联网装依赖（默认，推荐）
  //   'full'      = 完全不限（能改项目之外的任何文件）
  // 讨论阶段始终只读，不受这个设置影响。
  sandbox: 'workspace',
  autoExecute: true,     // 收敛后自动进入实现阶段
  codexModel: null,      // null = 用 ~/.codex/config.toml 里的默认模型
  claudeModel: null,     // null = 用 claude 默认模型
  turnTimeoutMs: 25 * 60 * 1000,
  port: 8787,
};

/* ------------------------------------------------------------------ */
/* 可执行文件发现                                                       */
/* ------------------------------------------------------------------ */

function isExecutable(p) {
  try {
    const st = fs.statSync(p); // 解引用软链：断链会抛错
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(cmd) {
  try {
    const out = execFileSync('/usr/bin/which', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out && isExecutable(out) ? out : null;
  } catch {
    return null;
  }
}

/** 返回最新的 Claude 桌面版内置 CLI（作为兜底）。 */
function findClaudeDesktopBin() {
  const base = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code');
  let versions = [];
  try {
    versions = fs.readdirSync(base);
  } catch {
    return null;
  }
  // 版本目录名排序（2.1.295 > 2.1.287）
  versions.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
  );
  for (const v of versions.reverse()) {
    const vdir = path.join(base, v);
    let hashes = [];
    try {
      hashes = fs.readdirSync(vdir);
    } catch {
      continue;
    }
    for (const h of hashes) {
      const bin = path.join(vdir, h, 'claude.app', 'Contents', 'MacOS', 'claude');
      if (isExecutable(bin)) return bin;
    }
  }
  return null;
}

function firstExecutable(candidates) {
  for (const c of candidates) {
    if (c && isExecutable(c)) return { path: c, source: 'found' };
  }
  return null;
}

export function resolveCodexBin() {
  const hit = firstExecutable([
    process.env.AGENT_DUET_WORKBENCH_CODEX_BIN,
    path.join(HOME, '.local', 'bin', 'codex'), // 常见软链；断链会被跳过
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    which('codex'),
  ]);
  return hit ? hit.path : null;
}

export function resolveClaudeBin() {
  const hit = firstExecutable([
    process.env.AGENT_DUET_WORKBENCH_CLAUDE_BIN,
    path.join(HOME, '.local', 'bin', 'claude'),
    which('claude'),
    findClaudeDesktopBin(),
  ]);
  return hit ? hit.path : null;
}

export function getBins() {
  return { codex: resolveCodexBin(), claude: resolveClaudeBin() };
}

/* ------------------------------------------------------------------ */
/* 认证状态探测                                                         */
/* ------------------------------------------------------------------ */

/**
 * 异步版的登录状态探测。
 *
 * 为什么需要它：`execFileSync` 会**阻塞整个事件循环** —— 探测期间 SSE 推送、
 * 中止按钮、其它会话全部停摆。实测并发请求被卡住 4.6 秒，最坏情况是 timeout 的 20 秒。
 * 登录状态这种东西完全可以在等待子进程的同时继续服务其它请求。
 */
export function claudeAuthStatusAsync(claudeBin) {
  if (!claudeBin) return Promise.resolve({ loggedIn: false, reason: 'claude CLI 未找到' });
  return new Promise((resolve) => {
    execFile(claudeBin, ['auth', 'status'], { encoding: 'utf8', timeout: 20000 }, (err, stdout) => {
      if (err) return resolve({ loggedIn: false, reason: `检测失败: ${err.message}` });
      try {
        const parsed = JSON.parse(stdout);
        resolve({
          loggedIn: Boolean(parsed.loggedIn),
          authMethod: parsed.authMethod,
          configDirectory: parsed.configDirectory,
          reason: parsed.loggedIn ? null : '未登录，需要执行一次 claude auth login',
        });
      } catch (e) {
        resolve({ loggedIn: false, reason: `检测失败: ${e.message}` });
      }
    });
  });
}

export function claudeAuthStatus(claudeBin) {
  if (!claudeBin) return { loggedIn: false, reason: 'claude CLI 未找到' };
  try {
    const raw = execFileSync(claudeBin, ['auth', 'status'], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(raw);
    return {
      loggedIn: Boolean(parsed.loggedIn),
      authMethod: parsed.authMethod,
      configDirectory: parsed.configDirectory,
      reason: parsed.loggedIn ? null : '未登录，需要执行一次 claude auth login',
    };
  } catch (err) {
    return { loggedIn: false, reason: `检测失败: ${err.message}` };
  }
}

export function codexAuthStatus(codexBin) {
  if (!codexBin) return { loggedIn: false, reason: 'codex CLI 未找到' };
  const authFile = path.join(HOME, '.codex', 'auth.json');
  try {
    const data = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    const mode = data.auth_mode || (data.OPENAI_API_KEY ? 'api_key' : 'unknown');
    const hasTokens = Boolean(data.tokens && data.tokens.access_token);
    const ok = hasTokens || Boolean(data.OPENAI_API_KEY);
    return {
      loggedIn: ok,
      authMethod: mode,
      accountId: data.tokens?.account_id || null,
      reason: ok ? null : 'auth.json 中没有可用令牌',
    };
  } catch (err) {
    return { loggedIn: false, reason: `读取 auth.json 失败: ${err.message}` };
  }
}

/* ------------------------------------------------------------------ */
/* 可用模型（用于 UI 下拉；失败时回退到静态建议值）                        */
/* ------------------------------------------------------------------ */

export const FALLBACK_CODEX_MODELS = [
  { id: null, label: '默认（跟随 config.toml）' },
  { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' },
  { id: 'gpt-5.1-codex', label: 'gpt-5.1-codex' },
  { id: 'o3', label: 'o3' },
];

export const FALLBACK_CLAUDE_MODELS = [
  { id: null, label: '默认' },
  { id: 'opus', label: 'opus' },
  { id: 'sonnet', label: 'sonnet' },
  { id: 'fable', label: 'fable' },
  { id: 'haiku', label: 'haiku' },
];

/**
 * Codex 的**真实**可用模型目录。
 *
 * `codex debug models` 会吐一份 JSON 目录（slug / 显示名 / visibility / 优先级）。
 * 加 `--bundled` 是用随二进制发布的那份：跳过联网刷新，因此不会撞上
 * `codex_models_manager ... request timed out` 那个超时（实测 48ms）。
 * 联网刷新那份可能多出账号特有的模型，但代价是可能挂住 —— 手填可以兜住这种情况。
 */
export function listCodexCatalogAsync(codexBin) {
  if (!codexBin) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      codexBin,
      ['debug', 'models', '--bundled'],
      { encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const parsed = JSON.parse(stdout);
          // visibility=hide 的是内部用途（自动评审之类），不作为常规选项
          resolve((parsed.models || [])
            .filter((m) => m && m.slug && m.visibility !== 'hide')
            .map((m) => ({ id: m.slug, label: m.display_name || m.slug })));
        } catch {
          resolve([]);
        }
      },
    );
  });
}

/**
 * Claude 这边**没有**列模型的子命令（拿别的词去试会被它当成 prompt 真跑一轮），
 * 所以只能从 `claude --help` 里把 CLI 自己写明的别名抓出来：
 *   --model <model>   Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')
 * 别名指向「最新」那个版本，恰好也是最稳的选择。抓不到就退回静态列表。
 */
export function listClaudeModelAliasesAsync(claudeBin) {
  if (!claudeBin) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      claudeBin,
      ['--help'],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        const m = String(stdout).match(/alias for the latest model \(e\.g\.([^)]*)\)/i);
        if (!m) return resolve([]);
        const aliases = [...m[1].matchAll(/'([a-z0-9._-]+)'/gi)].map((x) => x[1]);
        resolve([...new Set(aliases)].map((id) => ({ id, label: id })));
      },
    );
  });
}

/* ------------------------------------------------------------------ */
/* 模型                                                                */
/* ------------------------------------------------------------------ */

/**
 * 读 ~/.codex/config.toml 里顶层写的 `model = "..."`。
 *
 * codex 不带 -m 时用的就是这个值，而它没法从 CLI 问出来（没有 `codex models` 这种子命令，
 * 它的模型目录刷新还会超时）。读配置文件是唯一诚实的来源；
 * 读不到就返回 null，界面显示「默认」，不编一个模型名糊弄用户。
 */
export function readCodexConfigModel() {
  const file = path.join(HOME, '.codex', 'config.toml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  for (const raw of text.split(String.fromCharCode(10))) {
    const line = raw.trim();
    if (line.startsWith('[')) break;   // 到 [profile.x] 段就说明顶层已经结束了
    if (line.startsWith('#')) continue;
    const m = line.match(/^model\s*=\s*["']([^"']+)["']/);
    if (m) return m[1];
  }
  return null;
}

/**
 * 模型 id 是否合法。
 *
 * **必须挡住以 `-` 开头的东西**：这个值会被原样塞到 `--model` / `-m` 后面，
 * 若允许 `--dangerously-...` 这类字符串，就等于借「改模型」这个口子
 * 给 CLI 注入任意参数。
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@\/+\-]{0,79}$/;
export function isSafeModelId(value) {
  return typeof value === 'string' && MODEL_ID.test(value);
}

export function ensureSessionsDir() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}
