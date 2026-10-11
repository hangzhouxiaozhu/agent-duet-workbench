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
  { id: 'haiku', label: 'haiku' },
];

export function ensureSessionsDir() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}
