import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as gitguard from '../src/gitguard.mjs';

/**
 * gitguard 的回归测试。
 *
 * 核心保命用例：当项目目录是**更大仓库的子目录**时，checkpoint 和 rollback
 * 绝不能碰到子目录之外的任何文件。
 * 之前的实现用不带 pathspec 的 `git add -A`（等价于整个仓库）+ `git reset --hard`，
 * 会把用户无关的改动一起提交、并且在回滚时直接删掉 —— 这是会丢数据的那种 bug。
 */

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
}

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-duet-workbench-git-'));
  return fs.realpathSync(dir);
}

/** 造一个含 app/ 与 other/ 两个子目录的仓库，返回仓库根。 */
function makeRepo() {
  const root = tmpRepo();
  fs.mkdirSync(path.join(root, 'app'));
  fs.mkdirSync(path.join(root, 'other'));
  sh(root, 'git', ['init', '-q']);
  fs.writeFileSync(path.join(root, 'app', 'index.js'), 'original\n');
  fs.writeFileSync(path.join(root, 'other', 'unrelated.txt'), 'original\n');
  sh(root, 'git', ['add', '-A']);
  sh(root, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
  return root;
}

test('仓库根目录：正确识别为非子目录', () => {
  const root = makeRepo();
  const st = gitguard.status(root);
  assert.equal(st.isRepo, true);
  assert.equal(st.isSubdir, false, '仓库根不应被判为子目录');
  assert.equal(gitguard.scopeNotice(root), null, '仓库根不应产生作用域提示');
});

test('子目录：正确识别并给出作用域提示', () => {
  const root = makeRepo();
  const app = path.join(root, 'app');
  const st = gitguard.status(app);
  assert.equal(st.isSubdir, true, '子目录应被识别');
  assert.ok(gitguard.scopeNotice(app)?.includes('子目录'), '应产生提示');
});

test('checkpoint 只提交项目子目录，不吞掉仓库其它改动', () => {
  const root = makeRepo();
  const app = path.join(root, 'app');

  // 两边同时被改：app 内是 agent-duet-workbench 该管的，other 里是用户无关的工作
  fs.appendFileSync(path.join(app, 'index.js'), 'changed by agent-duet-workbench\n');
  fs.appendFileSync(path.join(root, 'other', 'unrelated.txt'), 'USER WORK IN PROGRESS\n');

  const res = gitguard.checkpoint(app, '会话前检查点');
  assert.equal(res.ok, true, `checkpoint 失败: ${res.error}`);
  assert.equal(res.created, true);

  // 提交里只能有 app/index.js
  const committed = sh(app, 'git', ['show', '--name-only', '--pretty=format:', 'HEAD']);
  assert.equal(committed, 'app/index.js', `提交内容越界了: ${committed}`);

  // 用户无关的改动必须还是未提交状态，且内容完好
  const dirty = sh(root, 'git', ['status', '--porcelain', 'other/unrelated.txt']);
  assert.match(dirty, /unrelated\.txt/, '用户的无关改动被提交了（应该保持未提交）');
  assert.match(
    fs.readFileSync(path.join(root, 'other', 'unrelated.txt'), 'utf8'),
    /USER WORK IN PROGRESS/,
  );
});

test('rollback 恢复项目子目录，且绝不销毁子目录之外的改动', () => {
  const root = makeRepo();
  const app = path.join(root, 'app');

  const base = gitguard.checkpoint(app, '基线');
  assert.equal(base.ok, true);

  // agent-duet-workbench 改了 app，用户同时在别处干活
  fs.writeFileSync(path.join(app, 'index.js'), 'BROKEN BY AGENT\n');
  fs.writeFileSync(path.join(root, 'other', 'unrelated.txt'), 'USER WORK IN PROGRESS\n');
  fs.writeFileSync(path.join(root, 'other', 'brand-new.txt'), 'user new file\n');

  const rb = gitguard.rollbackTo(app, base.sha);
  assert.equal(rb.ok, true, `回滚失败: ${rb.error}`);

  // app 恢复原状
  assert.equal(fs.readFileSync(path.join(app, 'index.js'), 'utf8'), 'original\n');

  // 用户别处的改动必须原封不动 —— 这是最关键的断言
  assert.equal(
    fs.readFileSync(path.join(root, 'other', 'unrelated.txt'), 'utf8'),
    'USER WORK IN PROGRESS\n',
    '回滚把子目录之外的用户文件改掉了！',
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'other', 'brand-new.txt'), 'utf8'),
    'user new file\n',
    '回滚把子目录之外的用户新文件删掉了！',
  );
});

test('diffFrom / changedFiles 不包含子目录之外的改动', () => {
  const root = makeRepo();
  const app = path.join(root, 'app');
  const base = gitguard.headSha(app);

  fs.appendFileSync(path.join(app, 'index.js'), 'in scope\n');
  fs.appendFileSync(path.join(root, 'other', 'unrelated.txt'), 'out of scope\n');

  const files = gitguard.changedFiles(app, base).map((f) => f.path);
  assert.deepEqual(files, ['index.js'], `越界: ${JSON.stringify(files)}`);

  const diff = gitguard.diffFrom(app, base);
  assert.match(diff, /in scope/);
  assert.doesNotMatch(diff, /out of scope/, 'diff 里出现了子目录之外的内容');
});

test('路径基准统一为「项目目录相对」，已跟踪与未跟踪一致', () => {
  // 这条守着一个真实踩过的坑：git diff 默认输出「仓库根相对」，
  // 而 git ls-files 输出「当前目录相对」，混用会让 agent 拿到打不开的路径。
  const root = makeRepo();
  const app = path.join(root, 'app');
  const base = gitguard.headSha(app);

  fs.appendFileSync(path.join(app, 'index.js'), 'modified\n');   // 已跟踪
  fs.writeFileSync(path.join(app, 'untracked.js'), 'new\n');      // 未跟踪

  const paths = gitguard.changedFiles(app, base).map((f) => f.path).sort();
  assert.deepEqual(paths, ['index.js', 'untracked.js'],
    `两种来源的路径基准不一致: ${JSON.stringify(paths)}`);
  // 都必须能相对项目目录直接解析
  for (const p of paths) {
    assert.ok(fs.existsSync(path.join(app, p)), `${p} 无法相对项目目录解析`);
  }
});

test('未跟踪的新文件能被识别为新增', () => {
  const root = makeRepo();
  const app = path.join(root, 'app');
  const base = gitguard.headSha(app);

  fs.writeFileSync(path.join(app, 'new-file.js'), 'x\n');
  fs.writeFileSync(path.join(root, 'other', 'out-of-scope-new.js'), 'y\n');

  const files = gitguard.changedFiles(app, base);
  assert.deepEqual(files, [{ path: 'new-file.js', status: 'A' }]);

  const diff = gitguard.diffFrom(app, base);
  assert.match(diff, /new-file\.js/, '新文件应出现在 diff 说明里');
  assert.doesNotMatch(diff, /out-of-scope-new\.js/, '子目录外的新文件不该出现');
});

test('工作区干净时 checkpoint 不产生多余提交', () => {
  const root = makeRepo();
  const app = path.join(root, 'app');
  const before = gitguard.headSha(app);

  const res = gitguard.checkpoint(app, '无事发生');
  assert.equal(res.ok, true);
  assert.equal(res.created, false);
  assert.equal(res.sha, before, '不该产生新提交');
});

test('非 git 目录：ensureRepo 会初始化并建立空基线', () => {
  const dir = tmpRepo(); // 不是 git 仓库
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');

  const res = gitguard.checkpoint(dir, '首轮');
  assert.equal(res.ok, true, `失败: ${res.error}`);
  assert.equal(res.created, true);
  assert.ok(gitguard.headSha(dir), '应该有 HEAD 了');
  assert.equal(gitguard.isDirty(dir), false, '提交后工作区应干净');
});

test('回滚要删掉「中间检查点提交过」的 agent 新建文件（返工路径）', () => {
  // 这是会丢信任的那条路径：返工循环会在第 2 轮开头再打一个检查点，
  // 把 agent 第 1 轮新建的文件**提交**掉。于是它既不在基线 commit 里
  // （git checkout 不管），也不是未跟踪文件（git clean 不管）——
  // 回滚后原地留着，函数却返回 ok。用户以为回到基线了，其实没有。
  const root = makeRepo();
  const base = gitguard.checkpoint(root, '基线');

  // agent 改了已有文件、删了一个、又新建了一个
  fs.writeFileSync(path.join(root, 'app', 'index.js'), 'MODIFIED BY AGENT\n');
  fs.unlinkSync(path.join(root, 'other', 'unrelated.txt'));
  fs.writeFileSync(path.join(root, 'app', 'agent-created.js'), 'console.log(1)\n');

  // 模拟「返工前检查点」：把上面这些提交掉
  gitguard.checkpoint(root, '返工前');

  const rb = gitguard.rollbackTo(root, base.sha);
  assert.equal(rb.ok, true, rb.error);

  assert.equal(fs.readFileSync(path.join(root, 'app', 'index.js'), 'utf8'), 'original\n',
    '被改的文件应还原');
  assert.equal(fs.existsSync(path.join(root, 'other', 'unrelated.txt')), true,
    '被删的文件应恢复');
  assert.equal(fs.existsSync(path.join(root, 'app', 'agent-created.js')), false,
    '中间检查点提交过的新文件必须被删掉，否则「回滚到基线」是假的');
  assert.ok(rb.removed?.includes('app/agent-created.js'), `removed 应记录它，实际 ${JSON.stringify(rb.removed)}`);
});

test('回滚后不残留任何「基线里没有」的文件', () => {
  const root = makeRepo();
  const base = gitguard.checkpoint(root, '基线');

  fs.writeFileSync(path.join(root, 'app', 'x1.js'), '1\n');
  fs.writeFileSync(path.join(root, 'app', 'x2.js'), '2\n');
  gitguard.checkpoint(root, '中间');
  fs.writeFileSync(path.join(root, 'app', '未提交的新文件.js'), '3\n');

  gitguard.rollbackTo(root, base.sha);

  // 断言工作区**实际文件**与基线 commit 完全一致。
  // 注意不能用 git ls-files —— 它列的是索引（=HEAD），而 HEAD 仍是中间检查点，
  // 所以被删掉的文件会以"已删除"的形式留在索引里，那是正确状态而非残留。
  const walk = (d, acc = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, acc);
      else acc.push(path.relative(root, p));
    }
    return acc;
  };
  const inBaseline = sh(root, 'git', ['ls-tree', '-r', '--name-only', base.sha])
    .split('\n').filter(Boolean).sort();
  assert.deepEqual(walk(root).sort(), inBaseline,
    '工作区必须与基线逐文件一致（多了就是回滚没删干净）');
});
