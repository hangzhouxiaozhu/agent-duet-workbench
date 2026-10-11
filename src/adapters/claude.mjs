import { runStreaming, describeToolInput } from './util.mjs';

/**
 * Claude 适配器 —— 驱动 `claude -p`（Claude Code）。
 *
 * 已验证的接口（claude 2.1.287）：
 *   claude -p --output-format stream-json --verbose --include-partial-messages \
 *          --permission-mode <mode> [--resume <sessionId>]     # prompt 走 stdin
 *
 * stream-json 关键事件：
 *   {"type":"system","subtype":"init","session_id":"…","model":"…","tools":[…]}
 *   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"…"}|{"type":"tool_use",…}]}}
 *   {"type":"result","subtype":"success","result":"…","is_error":false,"usage":{…}}
 *
 * 只读阶段用 --disallowedTools 摘掉写文件能力，写入阶段用 bypassPermissions。
 */

const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];

/**
 * claude 在额度耗尽时会把提示**当作普通正文**返回，进程退出码仍然是 0：
 *   "You've hit your session limit · resets 6:50am (Asia/Shanghai)"
 * 不识别的话这一轮会被判成成功，而且后果很隐蔽 ——
 * 搭档看到的是垃圾输入，只好回答「没有可评议的方案」，
 * 于是"零条分歧"被当成了"没有分歧"，讨论会在毫无产出的情况下宣布完成。
 *
 * 用长度做保险：真正的回答提到这句话通常很长，短到几十字符的基本就是限额提示。
 */
const LIMIT_HINT = /hit your (session|usage) limit|usage limit reached|rate limit exceeded|resets?\s+\d{1,2}:\d{2}/i;

/** 判断本轮是不是"额度用尽"这种假成功。 */
export function looksLikeLimitNotice(text) {
  const t = String(text || '').trim();
  return t.length > 0 && t.length < 400 && LIMIT_HINT.test(t);
}

export function createClaudeAdapter({ bin, model }) {
  if (!bin) throw new Error('未找到 claude 可执行文件');

  return {
    id: 'claude',
    label: 'Claude',

    async run({ prompt, cwd, allowWrite = false, resumeId, onEvent, signal, timeoutMs }) {
      const args = [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
      ];

      if (allowWrite) {
        // 无头模式下没人能点「允许」，必须显式放行，否则 agent 会被权限拒绝卡死
        args.push('--permission-mode', 'bypassPermissions');
      } else {
        args.push('--permission-mode', 'default');
        args.push('--disallowedTools', ...WRITE_TOOLS);
      }

      if (model) args.push('--model', model);
      if (resumeId) args.push('--resume', resumeId);

      let sessionId = resumeId || null;
      const textParts = [];
      let resultText = '';
      let usage = null;
      let costUsd = null;
      let authError = null;
      let sawError = false;

      onEvent?.({ type: 'status', status: 'running' });

      const result = await runStreaming({
        cmd: bin,
        args,
        cwd,
        stdin: prompt,
        signal,
        timeoutMs,
        label: 'claude',
        // 事件写盘失败必须让用户看见，不能只当噪音
        onHandlerError: (err) => onEvent?.({ type: 'error', text: `事件未能记录：${err.message}` }),
        onStderr: (text) => {
          const trimmed = text.trim();
          if (!trimmed) return;
          if (/error|not logged in|failed|denied/i.test(trimmed)) {
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
            case 'system':
              if (ev.subtype === 'init') {
                sessionId = ev.session_id || sessionId;
                onEvent?.({ type: 'session', sessionId, model: ev.model });
                if (Array.isArray(ev.tools)) onEvent?.({ type: 'capabilities', tools: ev.tools });
              }
              break;

            case 'stream_event': {
              const inner = ev.event;
              if (!inner) break;
              if (inner.type === 'content_block_delta') {
                const d = inner.delta;
                if (d?.type === 'text_delta' && d.text) {
                  onEvent?.({ type: 'delta', text: d.text });
                }
                // thinking_delta 故意不转发：整个 thinking 块结束时（见下面 assistant 分支）
                // 会用 thinking 事件完整发一次，逐条转发等于把同样内容重复写进事件流。
              }
              break;
            }

            case 'assistant': {
              const msg = ev.message;
              if (ev.error) {
                const kind = ev.error;
                const detail = collectText(msg) || kind;
                if (/auth/i.test(String(kind))) authError = detail;
                sawError = true;
                onEvent?.({ type: 'error', text: String(detail).slice(0, 1000) });
                break;
              }
              for (const block of msg?.content || []) {
                if (block.type === 'text' && block.text) {
                  textParts.push(block.text);
                } else if (block.type === 'tool_use') {
                  onEvent?.({ type: 'tool', name: block.name || 'tool', detail: describeToolInput(block.name, block.input), state: 'running' });
                } else if (block.type === 'thinking' && block.thinking) {
                  onEvent?.({ type: 'thinking', text: block.thinking });
                }
              }
              break;
            }

            case 'user': {
              // 工具执行结果：只用来给前端一个「工具跑完了」的信号
              for (const block of ev.message?.content || []) {
                if (block.type === 'tool_result') {
                  onEvent?.({ type: 'tool_result', isError: Boolean(block.is_error) });
                }
              }
              break;
            }

            case 'rate_limit_event': {
              // 订阅额度监控：把剩余额度透传给前端，避免撞限才发现
              const info = ev.rate_limit_info || {};
              onEvent?.({
                type: 'rate_limit',
                status: info.status,
                windows: info.unifiedWindows || null,
                resetsAt: info.resetsAt,
              });
              break;
            }

            case 'result': {
              if (typeof ev.result === 'string') resultText = ev.result;
              usage = ev.usage || usage;
              costUsd = ev.total_cost_usd ?? costUsd;
              if (ev.is_error) {
                sawError = true;
                if (/not logged in|authentication/i.test(String(ev.result || ''))) {
                  authError = ev.result;
                }
              }
              onEvent?.({ type: 'usage', usage, costUsd });
              break;
            }

            default:
              break;
          }
        },
      });

      if (authError) {
        onEvent?.({ type: 'status', status: 'error' });
        return {
          ok: false,
          authError: true,
          error: `Claude 未登录：请在终端执行 \`claude auth login\` 完成一次登录`,
          sessionId,
        };
      }

      if (result.aborted) {
        onEvent?.({ type: 'status', status: 'aborted' });
        return { ok: false, error: '已中止', aborted: true, sessionId, usage };
      }
      if (result.timedOut) {
        onEvent?.({ type: 'status', status: 'error' });
        return { ok: false, error: `超时（${Math.round((timeoutMs || 0) / 1000)}s）`, timedOut: true, sessionId, usage };
      }

      const text = (textParts.join('\n\n').trim() || resultText.trim());

      if (!text) {
        const detail =
          (result.signal ? `claude 被信号 ${result.signal} 终止` : null) ||
          result.stderr.trim().slice(-1500) ||
          (sawError ? 'claude 报告错误且没有输出内容' : `claude 退出码 ${result.code}`);
        onEvent?.({ type: 'status', status: 'error' });
        return { ok: false, error: detail, sessionId, usage };
      }

      // 假成功检测：额度提示不是回答，必须让这一轮失败，
      // 否则"没有内容"会被下游当成"没有分歧"
      if (looksLikeLimitNotice(text)) {
        onEvent?.({ type: 'status', status: 'error' });
        return {
          ok: false,
          rateLimited: true,
          error: `Claude 额度已用尽（${text.slice(0, 120)}）。等额度恢复后重跑这一轮。`,
          sessionId,
        };
      }

      onEvent?.({ type: 'message', text });
      onEvent?.({ type: 'status', status: 'done' });
      return { ok: true, text, sessionId, usage, costUsd };
    },
  };
}

function collectText(msg) {
  return (msg?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
