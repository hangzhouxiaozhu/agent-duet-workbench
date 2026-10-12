import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runStreaming, oneLine } from './util.mjs';

/**
 * Codex 适配器 —— 驱动 `codex exec`。
 *
 * 已验证的接口（codex-cli 0.162.0-alpha.17.2）：
 *   codex exec --json -C <dir> -s <sandbox> -o <file> -            # 新会话，prompt 走 stdin
 *   codex exec resume <threadId> --json -o <file> -c sandbox_mode=… # 续聊
 *
 * --json 输出 JSONL，关键事件：
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
 *   {"type":"turn.completed","usage":{…}}
 */
export const CODEX_DEFAULT_BIN =
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

export function createCodexAdapter({ bin, model }) {
  if (!bin) throw new Error('未找到 codex 可执行文件');

  return {
    id: 'codex',
    label: 'Codex',

    async run({ prompt, cwd, sandbox = 'read-only', resumeId, allowWrite, onEvent, signal, timeoutMs }) {
      const outFile = path.join(
        os.tmpdir(),
        `agent-duet-workbench-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
      );

      const args = resumeId
        ? buildResumeArgs({ resumeId, sandbox, model, outFile })
        : buildNewArgs({ cwd, sandbox, model, outFile });

      let sessionId = resumeId || null;
      let finalFromStream = '';
      let usage = null;
      let errorMessage = null;

      onEvent?.({ type: 'status', status: 'running' });

      const result = await runStreaming({
        cmd: bin,
        args,
        cwd,
        stdin: prompt,
        signal,
        timeoutMs,
        label: 'codex',
        // 事件写盘失败必须让用户看见，不能只当噪音
        onHandlerError: (err) => onEvent?.({ type: 'error', text: `事件未能记录：${err.message}` }),
        onStderr: (text) => {
          const trimmed = text.trim();
          if (!trimmed) return;
          // 这是 Codex CLI 自己刷新模型目录时的网络超时，不等同于本轮生成失败。
          // 单独降级为提示，避免生成仍正常时在会话日志里显示成致命红错。
          if (isModelRefreshTimeout(trimmed)) {
            onEvent?.({
              type: 'warning',
              text: 'Codex CLI 刷新可用模型列表超时，通常与网络/API/代理连接有关；这条提示本身不代表本轮生成失败。若没有后续回复，请检查连接后重试。',
            });
            return;
          }
          // codex 会把 PATH alias 之类的噪音写到 stderr，只在像错误时上报
          if (/error|failed|denied|panic/i.test(trimmed)) {
            onEvent?.({ type: 'stderr', text: trimmed.slice(0, 2000) });
          }
        },
        onLine: (line) => {
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            onEvent?.({ type: 'log', text: line.slice(0, 500) });
            return;
          }

          switch (ev.type) {
            case 'thread.started':
              sessionId = ev.thread_id || sessionId;
              onEvent?.({ type: 'session', sessionId });
              break;

            case 'turn.started':
              onEvent?.({ type: 'status', status: 'thinking' });
              break;

            case 'item.started':
            case 'item.updated':
            case 'item.completed':
              handleItem(ev, onEvent, (text) => {
                finalFromStream = text;
              }, (msg) => {
                errorMessage = msg;
              });
              break;

            case 'turn.completed':
              usage = ev.usage || null;
              onEvent?.({ type: 'usage', usage });
              break;

            case 'turn.failed':
            case 'error':
              errorMessage = ev.error?.message || ev.message || 'codex 报告失败';
              onEvent?.({ type: 'error', text: errorMessage });
              break;

            default:
              // 未知事件类型不致命，降级成日志
              break;
          }
        },
      });

      // -o 文件是权威的最终答复
      let text = '';
      try {
        text = fs.readFileSync(outFile, 'utf8').trim();
      } catch {
        text = finalFromStream;
      } finally {
        try {
          fs.unlinkSync(outFile);
        } catch {
          /* 忽略 */
        }
      }

      if (!text) text = finalFromStream;

      /* 失败判定。**顺序很关键**：中断/超时必须排在「没拿到文本」那条之前，
         否则会被它抢先，把真正的失败原因替换成一条无关的文本。
         实际踩过：服务被杀时，codex 那一轮报的错是启动横幅，
         而"被信号终止"这个真实原因完全看不到。 */
      if (result.aborted) {
        onEvent?.({ type: 'status', status: 'aborted' });
        return { ok: false, error: '已中止', aborted: true, sessionId, usage };
      }
      if (result.timedOut) {
        onEvent?.({ type: 'status', status: 'error' });
        return { ok: false, error: `超时（${Math.round((timeoutMs || 0) / 1000)}s）`, timedOut: true, sessionId, usage };
      }

      if (!text) {
        // 被信号杀死就说清楚，别拿 codex 上报的 error item 顶包
        const killed = result.signal ? `codex 被信号 ${result.signal} 终止` : null;
        const detail = killed
          || result.stderr.trim().slice(-1500)
          || errorMessage
          || `codex 退出码 ${result.code}`;
        onEvent?.({ type: 'status', status: 'error' });
        return { ok: false, error: detail, sessionId, usage };
      }

      onEvent?.({ type: 'message', text });
      onEvent?.({ type: 'status', status: 'done' });
      return { ok: true, text, sessionId, usage };
    },
  };
}

/**
 * codex 的 workspace-write 沙箱**默认禁网**，于是 `npm install` / `pip install` 必然失败 ——
 * agent 会把「需要安装依赖」列成阻塞项，用户还以为是自己没授权。
 * 实测加上这个开关后沙箱内能联网（curl example.com 返回 HTTP 200），
 * 而写入仍被限制在项目目录里，比直接给 danger-full-access 安全得多。
 */
const NETWORK_ON = ['-c', 'sandbox_workspace_write.network_access=true'];

/** 只有 workspace-write 需要显式开网；read-only 和 danger-full-access 不需要。 */
export function sandboxExtras(sandbox) {
  return sandbox === 'workspace-write' ? NETWORK_ON : [];
}

export function buildNewArgs({ cwd, sandbox, model, outFile }) {
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, '-s', sandbox, ...sandboxExtras(sandbox), '-o', outFile];
  if (model) args.push('-m', model);
  args.push('-'); // prompt 从 stdin 读
  return args;
}

export function buildResumeArgs({ resumeId, sandbox, model, outFile }) {
  // resume 子命令不接受 -s/-C，沙箱通过 -c 覆盖注入
  const args = [
    'exec', 'resume', resumeId,
    '--json', '--skip-git-repo-check',
    '-o', outFile,
    '-c', `sandbox_mode="${sandbox}"`,
    ...sandboxExtras(sandbox),
  ];
  if (model) args.push('-m', model);
  args.push('-');
  return args;
}

/** 把 codex 的 item 事件翻译成统一事件。 */
/**
 * codex 会把自己的启动告警也上报成 `error` item（例如
 * "Under-development features enabled: chronicle, respect_system_proxy..."）。
 * 那不是失败原因，不该被当成这一轮的错误 —— 实际踩过：服务被杀时，
 * 这一轮报出来的错就是这条横幅，真正的原因（被信号终止）完全看不到。
 */
const BENIGN_ERROR = /under-development features|suppress_unstable_features_warning/i;

/** 导出来是为了能被单元测试钉住：codex 的"假错误"必须和真错误区分开。 */
export function isBenignCodexError(text) {
  return BENIGN_ERROR.test(String(text || ''));
}

const MODEL_REFRESH_TIMEOUT = /codex_models_manager::manager:\s*failed to refresh available models:\s*request timed out/i;

/** Codex CLI 的模型目录刷新超时只影响模型发现，不必然代表当前生成失败。 */
export function isModelRefreshTimeout(text) {
  return MODEL_REFRESH_TIMEOUT.test(String(text || ''));
}

function handleItem(ev, onEvent, setFinal, setError) {
  const item = ev.item;
  if (!item || !item.type) return;
  const done = ev.type === 'item.completed';

  switch (item.type) {
    case 'agent_message':
      if (done && typeof item.text === 'string') {
        // 只留作兜底（-o 文件读不到时用），**不再单独发事件**：
        // 同样的文本会在本轮结束时通过 message 事件发出，
        // 单独再发一遍等于同一事实两处来源，白白占磁盘和带宽。
        setFinal(item.text);
      }
      break;

    case 'reasoning':
      if (done && item.text) onEvent?.({ type: 'thinking', text: item.text });
      break;

    case 'command_execution':
      onEvent?.({
        type: 'tool',
        name: 'shell',
        detail: oneLine(item.command || item.parsed_cmd || ''),
        state: item.status || (done ? 'done' : 'running'),
        exitCode: item.exit_code,
      });
      break;

    case 'file_change':
      onEvent?.({
        type: 'tool',
        name: 'edit',
        detail: oneLine(
          (item.changes || []).map((c) => `${c.kind || 'update'} ${c.path || ''}`).join(', ') || item.path,
        ),
        state: done ? 'done' : 'running',
      });
      break;

    case 'mcp_tool_call':
      onEvent?.({
        type: 'tool',
        name: item.tool || 'mcp',
        detail: oneLine(item.arguments),
        state: done ? 'done' : 'running',
      });
      break;

    case 'web_search':
      onEvent?.({ type: 'tool', name: 'web_search', detail: oneLine(item.query), state: done ? 'done' : 'running' });
      break;

    case 'error':
      if (item.message) {
        const msg = String(item.message);
        if (BENIGN_ERROR.test(msg)) {
          // 只是启动告警：降级成日志，不占用"这一轮的错误"
          onEvent?.({ type: 'log', text: oneLine(msg) });
        } else {
          setError(msg);
          onEvent?.({ type: 'stderr', text: msg.slice(0, 1000) });
        }
      }
      break;

    default:
      if (done && item.text) onEvent?.({ type: 'log', text: oneLine(item.text) });
      break;
  }
}
