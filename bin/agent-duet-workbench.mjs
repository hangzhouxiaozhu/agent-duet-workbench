#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createServer } from '../src/server.mjs';
import { killAllChildren } from '../src/adapters/util.mjs';
import {
  DEFAULTS,
  getBins,
  claudeAuthStatus,
  codexAuthStatus,
  ROOT,
} from '../src/config.mjs';

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('-') ? args[0] : 'start';

function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const ok = (t) => `${C.green}✔${C.reset} ${t}`;
const bad = (t) => `${C.red}✘${C.reset} ${t}`;
const warn = (t) => `${C.yellow}!${C.reset} ${t}`;

function banner() {
  console.log('');
  console.log(`${C.bold}  Agent Duet Workbench${C.reset} ${C.dim}·  Claude × Codex 双人讨论台${C.reset}`);
  console.log(`${C.dim}  两个 agent 独立作答 → 交叉评议 → 收敛成方案 → 动手实现${C.reset}`);
  console.log('');
}

function reportEnvironment({ exitOnFail = false } = {}) {
  const bins = getBins();
  const claude = claudeAuthStatus(bins.claude);
  const codex = codexAuthStatus(bins.codex);
  let problems = 0;

  if (bins.codex) {
    console.log(ok(`codex   ${C.dim}${bins.codex}${C.reset}`));
    if (codex.loggedIn) {
      console.log(ok(`        ${C.dim}已登录（${codex.authMethod}）${C.reset}`));
    } else {
      problems += 1;
      console.log(bad(`        codex 未登录：${codex.reason}`));
    }
  } else {
    problems += 1;
    console.log(bad('codex   未找到可执行文件'));
    console.log(`${C.dim}        设 AGENT_DUET_WORKBENCH_CODEX_BIN，或确认 ChatGPT.app 已安装${C.reset}`);
  }

  if (bins.claude) {
    console.log(ok(`claude  ${C.dim}${bins.claude}${C.reset}`));
    if (claude.loggedIn) {
      console.log(ok(`        ${C.dim}已登录（${claude.authMethod}）${C.reset}`));
    } else {
      problems += 1;
      console.log(bad(`        claude 未登录，请先执行：claude auth login`));
    }
  } else {
    problems += 1;
    console.log(bad('claude  未找到可执行文件'));
    console.log(`${C.dim}        安装：curl -fsSL https://claude.ai/install.sh | bash${C.reset}`);
  }

  console.log('');
  if (problems === 0) {
    console.log(ok('环境就绪，两个 agent 都可以调用'));
  } else {
    console.log(warn(`有 ${problems} 项待解决`));
    if (exitOnFail) process.exitCode = 1;
  }
  console.log('');
  return { bins, claude, codex, problems };
}

async function main() {
  if (command === 'doctor') {
    banner();
    reportEnvironment({ exitOnFail: true });
    console.log(`${C.dim}  Node ${process.version} · 工程目录 ${ROOT}${C.reset}`);
    console.log('');
    return;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    banner();
    console.log('  用法：');
    console.log(`    ${C.cyan}agent-duet-workbench${C.reset}                启动讨论台（默认端口 ${DEFAULTS.port}）`);
    console.log(`    ${C.cyan}agent-duet-workbench --port 9000${C.reset}    指定端口`);
    console.log(`    ${C.cyan}agent-duet-workbench doctor${C.reset}         检查两个 CLI 是否就绪`);
    console.log('');
    return;
  }

  banner();
  const env = reportEnvironment();
  if (env.problems > 0) {
    console.log(`${C.yellow}  仍会启动界面，但缺失的一方会报错。修好后刷新页面即可。${C.reset}`);
    console.log('');
  }

  const port = Number(flag('port', DEFAULTS.port));
  const server = createServer({ port });
  const url = `http://127.0.0.1:${port}`;

  server.on('listening', () => {
    console.log(`  ${C.bold}界面已启动${C.reset}  ${C.cyan}${url}${C.reset}`);
    console.log(`${C.dim}  按 Ctrl+C 退出${C.reset}`);
    console.log('');
    if (process.platform === 'darwin' && !args.includes('--no-open')) {
      execFile('open', [url], () => {
        /* 打不开浏览器不影响服务 */
      });
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(bad(`端口 ${port} 被占用，换一个：agent-duet-workbench --port ${port + 1}`));
      process.exit(1);
    }
    throw err;
  });

  /**
   * 退出时必须把在跑的 agent 子进程一起带走。
   *
   * 之前这里只关了 HTTP 服务。node 被杀不会自动清理 spawn 出来的子进程，
   * 它们会被 launchd 收养、**继续连模型、继续消耗订阅额度**，而输出没有任何人读 ——
   * 用户只会看到界面还在转圈，以为"他们还在跑"。
   */
  const shutdown = () => {
    console.log(`\n${C.dim}正在关闭…${C.reset}`);
    const killed = killAllChildren('SIGTERM');
    if (killed.length) {
      console.log(`${C.dim}  已结束 ${killed.length} 个 agent 子进程${C.reset}`);
    }
    // SSE 是长连接，会把 server.close() 一直拖住，得主动断开
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    // 给子进程一点善后时间，之后强杀
    setTimeout(() => {
      killAllChildren('SIGKILL');
      process.exit(0);
    }, 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // 兜底：任何异常退出路径都不该留下孤儿进程
  process.on('exit', () => killAllChildren('SIGKILL'));
}

main().catch((err) => {
  console.error(bad(err.stack || err.message));
  process.exit(1);
});
