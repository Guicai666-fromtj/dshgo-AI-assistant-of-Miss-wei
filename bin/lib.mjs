// 记忆系统公共件：路径、读写、看板生成。mem.mjs / memcore.mjs 共用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = process.env.MEM_ROOT
  ? path.resolve(process.env.MEM_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MEM = path.join(ROOT, 'mem');
export const BOARD = path.join(MEM, 'index.md');
export const FACTS = path.join(MEM, 'facts.json');
export const THREADS = path.join(MEM, 'threads.json');
export const STREAM = path.join(MEM, 'stream.jsonl');
export const ARCHIVE = path.join(MEM, 'archive');
export const WEEKLY = path.join(MEM, 'weekly');
export const HOT_DAYS = Number(process.env.MEM_HOT_DAYS || 7);
export const BOARD_MAX = 1200;
export const TEXT_MAX = 200;

const p2 = (n) => String(n).padStart(2, '0');

export function ensureDirs() {
  for (const d of [MEM, ARCHIVE, WEEKLY]) fs.mkdirSync(d, { recursive: true });
}

export function nowISO(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`;
}

export const day = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const dayOf = (iso) => day(new Date(iso));
export const hm = (iso) => `${p2(new Date(iso).getHours())}:${p2(new Date(iso).getMinutes())}`;
export const mmdd = (iso) => `${p2(new Date(iso).getMonth() + 1)}-${p2(new Date(iso).getDate())}`;

export function isoWeek(iso) {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const w = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(w).padStart(2, '0')}`;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureDirs();
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export const readFacts = () => readJson(FACTS, { facts: [] }).facts || [];
export const saveFacts = (list) => writeJson(FACTS, { facts: list });
export const readThreads = () => readJson(THREADS, { threads: [] }).threads || [];
export const saveThreads = (list) => writeJson(THREADS, { threads: list });

export function readStream() {
  ensureDirs();
  if (!fs.existsSync(STREAM)) return [];
  const out = [];
  for (const line of fs.readFileSync(STREAM, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 坏行留给 check 报 */
    }
  }
  return out;
}

export function appendStream(entry) {
  ensureDirs();
  fs.appendFileSync(STREAM, JSON.stringify(entry) + '\n', 'utf8');
}

export function readArchive() {
  ensureDirs();
  const out = [];
  for (const f of fs.readdirSync(ARCHIVE).filter((x) => x.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(ARCHIVE, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 跳过 */
      }
    }
  }
  return out;
}

export const cut = (s, n) => {
  const a = [...String(s ?? '')];
  return a.length > n ? a.slice(0, n).join('') + '…' : a.join('');
};

// 看板：只放「现在 + 核心事实 + 未办 + 近三天」，控制字数
export function buildBoard() {
  const facts = readFacts().filter((f) => !f.removed);
  const threads = readThreads();
  const stream = readStream();
  const core = facts.filter((f) => f.core).slice(0, 12);
  const open = threads
    .filter((t) => t.status !== 'closed')
    .sort((a, b) => String(a.due || '9999-99-99').localeCompare(String(b.due || '9999-99-99')));

  const lines = [];
  lines.push('# 魏老师的AI助理 · 记忆看板', '');
  lines.push('> 自动生成，别手改。重建：`node bin/memcore.mjs index`', '');

  const last = stream.length ? stream[stream.length - 1] : null;
  const todayStr = day(new Date());
  const todayCount = stream.filter((e) => dayOf(e.t) === todayStr).length;
  lines.push('## 现在');
  lines.push(
    `- 最近活动：${last ? `${mmdd(last.t)} ${hm(last.t)} · ${last.kind} · ${cut(last.text, 30)}` : '暂无'}`
  );
  lines.push(`- 今天：${todayCount} 条流水`);

  lines.push('', '## 核心事实');
  if (!core.length) lines.push('- （空）');
  for (const f of core) lines.push(`- ${f.key}：${cut(f.value, 60)}`);

  lines.push('', `## 未办（${open.length}）`);
  if (!open.length) lines.push('- （空）');
  for (const t of open.slice(0, 10)) lines.push(`- [${t.id}] ${cut(t.text, 60)}${t.due ? `（due ${t.due}）` : ''}`);
  if (open.length > 10) lines.push(`- ……还有 ${open.length - 10} 条，查：\`node bin/memcore.mjs thread-list\``);

  lines.push('', '## 近三天');
  for (let i = 2; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const ds = day(d);
    const n = stream.filter((e) => dayOf(e.t) === ds).length;
    lines.push(`- ${ds.slice(5)}：${n} 条`);
  }

  lines.push('', '## 入口');
  lines.push('- 决议：mem/facts.json · mem/threads.json');
  lines.push('- 流水：mem/stream.jsonl（热存 7 天）· 归档：mem/archive/');
  lines.push('- 查：`node bin/memcore.mjs fact-list` / `thread-list` · `node bin/mem.mjs recall 关键词`');
  return lines.join('\n') + '\n';
}

export function writeBoard() {
  ensureDirs();
  const s = buildBoard();
  fs.writeFileSync(BOARD, s, 'utf8');
  return [...s].length;
}
