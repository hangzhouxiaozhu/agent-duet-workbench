import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Git 保护层（作用域限定版）。
 *
 * 用户选择了「允许两个 agent 直接改代码」，所以必须有回滚能力：
 *   - 会话开始前打一个检查点，保证任何时刻都能回到起点
 *   - 每次动手写代码之前再打一个，粒度到「轮」
 *   - 前端可以一键回滚
 *
 * ⚠️ 作用域是这里最关键的设计约束。
 * `git add -A`（不带 pathspec）从 Git 2.0 起等同于 `git add -A :/`，会暂存**整个仓库**。
 * 如果用户把项目目录指向 monorepo 的一个子包，那就会：
 *   1. 把仓库里其它地方的无关改动一起提交进 agent-duet-workbench 的检查点
 *   2. 让「回滚」执行 `git reset --hard` 时删掉用户那些无关的工作
 * 因此下面所有 git 操作都显式带路径限定（`-- .`），并且都从项目目录为 cwd 执行。
 * 提交用 `git commit -- .`（局部提交），保证不碰索引里其它已暂存的内容。
 */

function git(dir, args, { allowFail = true } = {}) {
  try {
    const stdout = execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });
    return { ok: true, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    if (!allowFail) throw err;
    return {
      ok: false,
      stdout: (err.stdout || '').toString().trim(),
      stderr: (err.stderr || '').toString().trim() || err.message,
    };
  }
}

const IDENTITY = [
  '-c', 'user.name=Agent Duet Workbench',
  '-c', 'user.email=agent-duet-workbench@localhost',
  '-c', 'commit.gpgsign=false',
];

/** 路径限定：所有操作只看项目目录这一棵子树。 */
const SCOPE = ['--', '.'];

export function isRepo(dir) {
  return git(dir, ['rev-parse', '--is-inside-work-tree']).stdout === 'true';
}

export function repoRoot(dir) {
  return git(dir, ['rev-parse', '--show-toplevel']).stdout || null;
}

export function headSha(dir) {
  const r = git(dir, ['rev-parse', 'HEAD']);
  return r.ok ? r.stdout : null;
}

export function currentBranch(dir) {
  const r = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? r.stdout : null;
}

/** 只看项目目录范围内的改动，避免把仓库其它地方的变化算进来。 */
export function isDirty(dir) {
  const r = git(dir, ['status', '--porcelain', ...SCOPE]);
  return r.ok ? r.stdout.length > 0 : false;
}

export function status(dir) {
  const root = repoRoot(dir);
  const inRepo = isRepo(dir);
  return {
    isRepo: inRepo,
    repoRoot: root,
    // 项目目录位于某个更大仓库的子目录里 —— 需要提示用户
    isSubdir: Boolean(inRepo && root && !samePath(root, dir)),
    branch: currentBranch(dir),
    head: headSha(dir),
    dirty: isDirty(dir),
  };
}

/**
 * 路径比较必须先解析真实路径：
 * macOS 上 /tmp 是 /private/tmp 的软链，而 `git rev-parse --show-toplevel` 返回的是
 * 解析后的路径，直接字符串比较会把根目录误判成「仓库的子目录」。
 */
function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function samePath(a, b) {
  const norm = (s) => realpath(s).replace(/\/+$/, '');
  return norm(a) === norm(b);
}

/**
 * 作用域提示：项目目录是更大仓库的子目录时，明确告诉用户我们只动这一棵子树。
 * 返回 null 表示无需提示。
 */
export function scopeNotice(dir) {
  const root = repoRoot(dir);
  if (!root || samePath(root, dir)) return null;
  return `项目目录是仓库 ${root} 的子目录。Agent Duet Workbench 的检查点与回滚已限定在此子目录内，` +
    `不会触碰仓库其它地方的改动。`;
}

/** 确保是一个有 HEAD 的 git 仓库，否则无法做检查点。 */
export function ensureRepo(dir) {
  if (!isRepo(dir)) {
    const r = git(dir, ['init'], { allowFail: false });
    if (!r.ok) return { ok: false, error: r.stderr };
  }
  if (!headSha(dir)) {
    // 空仓库：先造一个空提交当基线，这样后面任何人都能 reset 回来
    const r = git(dir, [...IDENTITY, 'commit', '--allow-empty', '-m', 'agent-duet-workbench: 空基线（会话开始）']);
    if (!r.ok) return { ok: false, error: r.stderr };
  }
  return { ok: true };
}

/**
 * 打检查点：把项目目录内的当前改动提交成一个 commit。
 * 工作区干净时不会产生多余提交，直接返回当前 HEAD。
 */
export function checkpoint(dir, label) {
  const ensured = ensureRepo(dir);
  if (!ensured.ok) return { ok: false, error: ensured.error };

  if (!isDirty(dir)) {
    return { ok: true, created: false, sha: headSha(dir) };
  }

  // 只暂存项目目录这一棵子树
  const add = git(dir, ['add', '-A', ...SCOPE]);
  if (!add.ok) return { ok: false, error: `git add 失败: ${add.stderr}` };

  // 局部提交：只提交该路径范围，索引里其它已暂存内容原样保留
  const commit = git(dir, [...IDENTITY, 'commit', '-m', `agent-duet-workbench: ${label}`, ...SCOPE]);
  if (!commit.ok) {
    return { ok: false, error: `git commit 失败: ${commit.stderr}` };
  }
  return { ok: true, created: true, sha: headSha(dir) };
}

/** 从某个检查点开始的 diff，限定在项目目录内，超长则截断。 */
export function diffFrom(dir, fromSha, maxChars = 120_000) {
  if (!fromSha) return '';
  // 注意：`git diff <sha>`（不带 ..HEAD）比较的是工作区 vs 该提交，
  // 已暂存和未暂存的改动都会包含进来 —— 这正是「这个检查点之后改了什么」。
  // --relative 让路径相对项目目录输出，与未跟踪文件保持同一套基准
  // （agent 的工作目录就是项目目录，相对路径能直接用来打开文件）。
  const r = git(dir, ['diff', '--no-color', '--relative', fromSha, ...SCOPE]);
  let text = r.stdout;

  // 新建但未跟踪的文件不在 git diff 里，单独列出来告知（内容让 agent 自己去读）
  const untracked = git(dir, ['ls-files', '--others', '--exclude-standard', ...SCOPE]);
  const newFiles = untracked.stdout.split('\n').filter(Boolean);
  if (newFiles.length) {
    text = `${text}\n\n新增未跟踪文件（内容未包含在 diff 中）：\n${newFiles.map((f) => `  + ${f}`).join('\n')}`.trim();
  }

  if (!text) return '';
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n…（diff 过长已截断，共 ${text.length} 字符）`
    : text;
}

/** 改动文件清单（用于 UI 展示），同样限定作用域。路径一律相对项目目录。 */
export function changedFiles(dir, fromSha) {
  if (!fromSha) return [];
  const files = new Map();

  // 跟踪文件的改动：`git diff <sha>` 覆盖已暂存 + 未暂存
  const tracked = git(dir, ['diff', '--name-status', '--relative', fromSha, ...SCOPE]);
  for (const line of tracked.stdout.split('\n').filter(Boolean)) {
    // 格式：<STATUS>\t<PATH>；重命名是 <R100>\t<OLD>\t<NEW>
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const status = parts[0][0];
    const p = parts[parts.length - 1];
    if (p) files.set(p, status);
  }

  // 新增未跟踪文件
  const untracked = git(dir, ['ls-files', '--others', '--exclude-standard', ...SCOPE]);
  for (const p of untracked.stdout.split('\n').filter(Boolean)) {
    if (!files.has(p)) files.set(p, 'A');
  }

  return [...files.entries()].map(([path, status]) => ({ path, status }));
}

/**
 * 回滚到某个检查点。
 *
 * 破坏性操作，只应由前端显式点击触发。
 * 用 `git checkout <sha> -- .` + `git clean -fd -- .` 而不是 `git reset --hard`：
 * 后者会把整个仓库（含项目目录之外）全部重置，删掉用户无关的改动。
 */
export function rollbackTo(dir, sha) {
  if (!sha) return { ok: false, error: '缺少目标 commit' };
  const verify = git(dir, ['cat-file', '-e', `${sha}^{commit}`]);
  if (!verify.ok) return { ok: false, error: `目标 commit 不存在: ${sha}` };

  /* 1) 先删掉「目标检查点里不存在、但现在被 git 跟踪」的文件。
   *
   * 这是最容易漏、后果又最严重的一步：返工循环会在第 2 轮开头再打一个检查点，
   * 把 agent 第 1 轮**新建**的文件提交掉。于是这些文件
   *   - 不在基线 commit 里 → `git checkout <sha> -- .` 不管它们
   *   - 也不是未跟踪文件   → `git clean -fd` 不管它们
   * 结果回滚后它们原地留着，函数却返回 ok —— 用户以为回到基线了，其实没有。
   *
   * --diff-filter=A 只看「新增」，--relative 拿到相对项目目录的路径。
   */
  const removed = [];
  const added = git(dir, ['diff', '--name-only', '--diff-filter=A', '--relative', sha, 'HEAD', ...SCOPE]);
  for (const rel of added.stdout.split('\n').filter(Boolean)) {
    const target = path.resolve(dir, rel);
    // 双保险：只允许删项目目录内的东西
    if (!target.startsWith(path.resolve(dir) + path.sep)) continue;
    try {
      fs.rmSync(target, { force: true });
      removed.push(rel);
    } catch { /* 删不掉就交给下面的 clean */ }
  }

  // 2) 把项目目录内的已跟踪文件恢复到该检查点的内容
  const restore = git(dir, ['checkout', sha, ...SCOPE]);
  if (!restore.ok) return { ok: false, error: `恢复文件失败: ${restore.stderr}` };

  // 3) 清掉该检查点之后新产生的未跟踪文件（同样只在本目录内）
  const clean = git(dir, ['clean', '-fd', ...SCOPE]);

  // 4) 把恢复后的内容从索引里撤出暂存，回到未暂存的普通改动状态
  git(dir, ['reset', '-q', ...SCOPE]);

  return { ok: true, sha, cleaned: clean.ok, removed };
}
