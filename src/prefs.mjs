/**
 * 跨会话要记住的用户偏好（目前是模型选择）。
 *
 * 为什么单独放一个文件：会话目录是「数据」，这个是「配置」。
 * 写进 sessions/ 会被清理会话时一起删掉；写进 DEFAULTS 又改不动（那是代码）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

/**
 * 惰性求值：测试会在 import 之后才改环境变量，模块加载时就定死路径会写脏真实文件。
 */
function prefsFile() {
  return process.env.AGENT_DUET_WORKBENCH_PREFS_FILE
    ? path.resolve(process.env.AGENT_DUET_WORKBENCH_PREFS_FILE)
    : path.join(ROOT, 'prefs.json');
}

export function readPrefs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writePrefs(patch) {
  const next = { ...readPrefs(), ...patch };
  try {
    fs.writeFileSync(prefsFile(), JSON.stringify(next, null, 2) + String.fromCharCode(10));
  } catch {
    // 记不住偏好不该影响会话本身
  }
  return next;
}

/** 只保留白名单字段：别让请求体里任意键被顺手写进偏好文件。 */
export function pickModelPrefs(source) {
  const out = {};
  for (const key of ['claudeModel', 'codexModel']) {
    if (source && Object.prototype.hasOwnProperty.call(source, key)) {
      out[key] = source[key] == null || source[key] === '' ? null : String(source[key]);
    }
  }
  return out;
}
