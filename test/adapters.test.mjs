import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { runStreaming, killAllChildren, liveChildCount, describeToolInput, oneLine } from '../src/adapters/util.mjs';
import { isBenignCodexError, isModelRefreshTimeout, buildNewArgs, buildResumeArgs } from '../src/adapters/codex.mjs';
import { looksLikeLimitNotice } from '../src/adapters/claude.mjs';

/**
 * 适配器底层工具的测试。
 *
 * 这里最要紧的是子进程清理：node 被杀不会自动带走 spawn 出来的 agent 子进程，
 * 它们会被 launchd 收养、**继续连模型烧额度**，而输出没有任何人读。
 * 真实发生过：用户看到界面还在转圈，以为 agent 还在跑。
 */

test('子进程登记：运行中登记，正常结束后注销', async () => {
  assert.equal(liveChildCount(), 0);

  const p = runStreaming({ cmd: 'true', args: [], timeoutMs: 5000 });
  assert.equal(liveChildCount(), 1, '启动后应登记在册');

  const r = await p;
  assert.equal(r.code, 0);
  assert.equal(liveChildCount(), 0, '结束后应注销，否则登记表会一直涨');
});

test('killAllChildren 能真的结束在跑的子进程', async () => {
  const p = runStreaming({ cmd: 'sleep', args: ['60'], timeoutMs: 60000 });
  await sleep(300);
  assert.equal(liveChildCount(), 1);

  const killed = killAllChildren('SIGTERM');
  assert.equal(killed.length, 1, `应结束 1 个进程，实际 ${killed.length}`);
  assert.ok(killed[0] > 0, '应返回被结束的 pid');

  await p; // 不该挂住
  assert.equal(liveChildCount(), 0);
});

test('没有子进程时 killAllChildren 是安全的空操作', () => {
  assert.deepEqual(killAllChildren(), []);
  assert.deepEqual(killAllChildren('SIGKILL'), []);
});

test('超时会杀掉子进程并标记 timedOut', async () => {
  const r = await runStreaming({ cmd: 'sleep', args: ['30'], timeoutMs: 400 });
  assert.equal(r.timedOut, true);
  assert.equal(liveChildCount(), 0, '超时后也必须注销');
});

test('AbortSignal 会杀掉子进程并标记 aborted', async () => {
  const ac = new AbortController();
  const p = runStreaming({ cmd: 'sleep', args: ['30'], timeoutMs: 60000, signal: ac.signal });
  await sleep(200);
  ac.abort();
  const r = await p;
  assert.equal(r.aborted, true);
  assert.equal(liveChildCount(), 0);
});

test('stdout 按行回调', async () => {
  const lines = [];
  await runStreaming({
    cmd: 'printf', args: ['a\\nb\\nc\\n'], timeoutMs: 5000,
    onLine: (l) => lines.push(l),
  });
  assert.deepEqual(lines, ['a', 'b', 'c']);
});

test('stderr 会被收集', async () => {
  const r = await runStreaming({ cmd: 'sh', args: ['-c', 'echo oops >&2'], timeoutMs: 5000 });
  assert.match(r.stderr, /oops/);
});

/* --------------------------- 展示辅助函数 --------------------------- */

test('describeToolInput：从各种工具入参里挑出最有信息量的字段', () => {
  assert.equal(describeToolInput('Bash', { command: 'ls -la' }), 'ls -la');
  assert.equal(describeToolInput('Read', { file_path: '/a/b.js' }), '/a/b.js');
  assert.equal(describeToolInput('Write', { file_path: '/a/b.js' }), '/a/b.js');
  assert.equal(describeToolInput('Edit', { file_path: '/a/b.js' }), '/a/b.js');
  assert.equal(describeToolInput('Grep', { pattern: 'foo' }), 'foo');
  // 认不出来的工具不该崩，回落成压缩后的 JSON（比输出 [object Object] 或空有用）
  assert.equal(describeToolInput('Mystery', { foo: 1 }), '{"foo":1}');
  assert.equal(describeToolInput('Bash', undefined), '');
  assert.equal(describeToolInput('Bash', null), '');
});

test('oneLine：折叠换行并截断超长内容', () => {
  assert.equal(oneLine('a\nb'), 'a b');
  assert.equal(oneLine('  spaced  '), 'spaced');
  const long = oneLine('x'.repeat(300), 40);
  assert.ok(long.length <= 41, `应被截断，实际 ${long.length}`);
  assert.match(long, /…$/);
});

/* ---------------- codex 的「假错误」分类 ---------------- */

/**
 * codex 会把自己的启动告警当成 `error` item 上报。
 * 实际踩过：服务被杀时，那一轮报出来的错误就是这条横幅，
 * 真正的原因（被信号终止）完全看不到 —— 误导性比没有错误信息更糟。
 */
test('isBenignCodexError：认得启动横幅这类告警', () => {
  const banner = 'Under-development features enabled: chronicle, respect_system_proxy. '
    + 'Under-development features are incomplete and may behave unpredictably. '
    + 'To suppress this warning, set `suppress_unstable_features_warning = true` in ~/.codex/config.toml.';
  assert.equal(isBenignCodexError(banner), true, '启动横幅不该被当成失败原因');
  assert.equal(isBenignCodexError('suppress_unstable_features_warning = true'), true);
});

test('Codex 模型目录刷新超时能与本轮生成失败区分', () => {
  assert.equal(isModelRefreshTimeout('ERROR codex_models_manager::manager: failed to refresh available models: request timed out'), true);
  assert.equal(isModelRefreshTimeout('request timed out while generating response'), false);
  assert.equal(isModelRefreshTimeout('authentication failed: invalid token'), false);
});

test('isBenignCodexError：真正的错误不能被误判成告警', () => {
  for (const real of [
    'failed to initialize in-process app-server client: Operation not permitted',
    'stream error: unexpected end of JSON input',
    'authentication failed: invalid token',
    'permission denied: /etc/hosts',
    'panic: runtime error',
    '',
    null,
  ]) {
    assert.equal(isBenignCodexError(real), false, `不该把 ${JSON.stringify(real)} 当成告警`);
  }
});

/* --------------- codex 沙箱：workspace-write 必须开网络 --------------- */

/**
 * codex 的 workspace-write 沙箱默认禁网，于是 `npm install` / `pip install` 必然失败 ——
 * agent 会把「需要安装依赖」列成阻塞项，用户还以为是自己没授权。
 * 实测加上 network_access=true 后沙箱内能联网（curl example.com 返回 200），
 * 而写入仍被限制在项目目录里，比直接给 danger-full-access 安全得多。
 */
test('codex 参数：workspace-write 必须带上开网开关', () => {
  const args = buildNewArgs({ cwd: '/tmp/x', sandbox: 'workspace-write', model: null, outFile: '/tmp/o' });
  const i = args.indexOf('-c');
  assert.ok(i > 0, '应注入 -c 覆盖项');
  assert.match(args[i + 1], /sandbox_workspace_write\.network_access=true/,
    `workspace-write 下必须开网，否则装不了依赖；实际参数：${args.join(' ')}`);
  assert.ok(args.includes('workspace-write'), '沙箱模式本身也要在');
});

test('codex 参数：read-only 与 danger-full-access 不注入开网项（它们不需要）', () => {
  for (const mode of ['read-only', 'danger-full-access']) {
    const args = buildNewArgs({ cwd: '/tmp/x', sandbox: mode, model: null, outFile: '/tmp/o' });
    assert.ok(!args.some((a) => String(a).includes('network_access')),
      `${mode} 不该注入 network_access：${args.join(' ')}`);
    assert.ok(args.includes(mode));
  }
});

test('codex 参数：resume 路径同样带开网开关（否则续聊那一轮又装不了依赖）', () => {
  const args = buildResumeArgs({ resumeId: 'th_1', sandbox: 'workspace-write', model: null, outFile: '/tmp/o' });
  assert.ok(args.some((a) => String(a).includes('network_access')),
    `resume 也要开网：${args.join(' ')}`);
  assert.ok(args.some((a) => String(a).includes('sandbox_mode="workspace-write"')));
});

/* ---------------- 额度用尽不能被当成"这一轮成功" ---------------- */

/**
 * claude 额度耗尽时会把提示当普通正文返回，退出码仍是 0。
 * 不识别的话后果很隐蔽：搭档看到垃圾输入，只能回答「没有可评议的方案」，
 * 于是"零条分歧"被当成了"没有分歧"，讨论在毫无产出的情况下宣布完成。
 * 实测踩过：一轮 61 字符的 "You've hit your session limit" 骗过了整条链路。
 */
test('额度提示会被识别为假成功', () => {
  const hits = [
    "You've hit your session limit · resets 6:50am (Asia/Shanghai)",
    'You have hit your usage limit. Resets 3:00pm',
    'rate limit exceeded, please retry',
    'usage limit reached',
  ];
  for (const t of hits) {
    assert.equal(looksLikeLimitNotice(t), true, `该识别为额度提示：${JSON.stringify(t)}`);
  }
});

test('正常回答不会被误判成额度提示', () => {
  const misses = [
    '',
    '这是一份正常的实施方案，包含三个改动点。',
    // 真正的长回答里提到限额：长度保险应该挡住误判
    `关于额度：${'x'.repeat(500)} you've hit your session limit`,
  ];
  for (const t of misses) {
    assert.equal(looksLikeLimitNotice(t), false, `不该误判：${JSON.stringify(t.slice(0, 40))}`);
  }
});
