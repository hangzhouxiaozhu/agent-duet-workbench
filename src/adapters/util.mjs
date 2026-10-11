import { spawn } from 'node:child_process';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';

/**
 * 正在运行中的 agent 子进程登记表。
 *
 * 存在的唯一理由是：**保证服务死掉时它们也一起死。**
 * node 被杀（Ctrl-C、崩溃、kill）不会自动带走 spawn 出来的子进程，
 * 它们会被 launchd 收养、继续跑下去 —— 继续连模型、继续消耗订阅额度，
 * 而输出已经没有任何人在读了。
 */
const LIVE_CHILDREN = new Set();

/** 结束所有在跑的 agent 子进程。进程退出钩子里调用。 */
export function killAllChildren(signal = 'SIGTERM') {
  const killed = [];
  for (const child of [...LIVE_CHILDREN]) {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, signal);   // 整组带走
        } catch {
          child.kill(signal);
        }
        killed.push(child.pid);
      }
    } catch { /* 已经退了 */ }
    LIVE_CHILDREN.delete(child);
  }
  return killed;
}

export function liveChildCount() {
  return LIVE_CHILDREN.size;
}

/**
 * 启动一个 CLI 子进程，逐行回调 stdout，并在超时/中断时确保进程被真正杀掉。
 *
 * 之所以不用 execFile：两个 agent 的单轮输出都可能很长且持续几分钟，
 * 必须边跑边把事件推给前端，而不是等结束后一次性返回。
 */
export function runStreaming({
  cmd,
  args,
  cwd,
  stdin,
  env,
  onLine,
  onStderr,
  onHandlerError,
  timeoutMs = 25 * 60 * 1000,
  signal,
  label = 'process',
}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        // 保证子进程能找到 claude / codex（原生安装装到 ~/.local/bin）
        PATH: [path.join(os.homedir(), '.local', 'bin'), process.env.PATH].filter(Boolean).join(':'),
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      // 自成进程组。agent 会频繁跑 shell，`sh -c "cmd & other"` 会产生**孙进程**；
      // 只杀直接子进程的话，孙进程继续持有 stdout 管道，'close' 永远不触发，
      // 于是超时/中止形同虚设 —— 实测 700ms 的超时等了 60 秒才返回。
      // 自成一组之后可以用负 pid 一次性带走整组。
      detached: true,
    });
    LIVE_CHILDREN.add(child);

    const handlerErrors = [];
    let stderrBuf = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killTimer = null;

    /** 杀整个进程组，连孙进程一起。 */
    const killTree = (sig) => {
      try {
        process.kill(-child.pid, sig);   // 负 pid = 进程组
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* 进程可能已退出 */
        }
      }
    };

    const hardKill = () => killTree('SIGKILL');

    const finish = (result) => {
      if (settled) return;
      settled = true;
      LIVE_CHILDREN.delete(child);
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      resolve({ ...result, stderr: stderrBuf, timedOut, aborted, handlerErrors });
    };

    const terminate = (why) => {
      if (why === 'timeout') timedOut = true;
      if (why === 'abort') aborted = true;
      // 可能被调两次（abort + timeout）：先清掉上一个定时器，
      // 否则它会泄漏到触发为止（打到已退出的 pid，无害但没必要）
      if (killTimer) clearTimeout(killTimer);
      killTree('SIGTERM');
      // 有些 agent 会忽略 SIGTERM，兜底强杀
      killTimer = setTimeout(hardKill, 5000);
    };

    const onAbort = () => terminate('abort');
    if (signal) {
      if (signal.aborted) terminate('abort');
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => terminate('timeout'), timeoutMs);

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (line.trim()) {
        try {
          onLine?.(line);
        } catch (err) {
          // 这里吞掉的异常意味着**这条事件没能落盘**：onLine 链路最终会写
          // events.jsonl，磁盘满 / 权限问题都会让它抛。只降级成 stderr 的话
          // 会被当成噪音，而这一轮仍被判定成功、用户毫无察觉。
          handlerErrors.push(err.message);
          onHandlerError?.(err);
          onStderr?.(`[${label}] 事件处理失败: ${err.message}`);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      // 防止无限增长
      if (stderrBuf.length > 200_000) stderrBuf = stderrBuf.slice(-100_000);
      onStderr?.(text);
    });

    child.on('error', (err) => {
      stderrBuf += `\n[spawn error] ${err.message}`;
      finish({ code: -1, spawnError: err.message });
    });

    child.on('close', (code, sig) => {
      finish({ code: code ?? -1, signal: sig });
    });

    if (stdin != null) {
      child.stdin.on('error', () => {
        /* 子进程可能先退出，忽略 EPIPE */
      });
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * 把 tool_use 的入参压成人类一眼能看懂的一行。
 * 直接 JSON.stringify 会把整坨参数糊在界面上，看不出这个 agent 到底在干嘛。
 */
export function describeToolInput(name, input) {
  if (!input || typeof input !== 'object') return oneLine(input);
  const pick = (...keys) => {
    for (const k of keys) {
      if (typeof input[k] === 'string' && input[k]) return input[k];
    }
    return null;
  };

  switch (name) {
    case 'Bash':
      return oneLine(pick('command', 'description'));
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return oneLine(pick('file_path', 'notebook_path', 'path'));
    case 'Glob':
      return oneLine(pick('pattern', 'path'));
    case 'Grep':
      return oneLine([pick('pattern'), pick('path')].filter(Boolean).join('  in  '));
    case 'WebFetch':
    case 'WebSearch':
      return oneLine(pick('url', 'query'));
    case 'Task':
      return oneLine(pick('description', 'prompt'));
    default:
      return oneLine(input);
  }
}

/** 尽力把任意值压成一行可读文本，用于工具活动展示。 */
export function oneLine(value, max = 300) {
  if (value == null) return '';
  let text;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
