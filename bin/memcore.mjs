#!/usr/bin/env node
// 记忆四柜：看板生成 / 校验 / 事实 / 欠账 / 归档 / 周报
import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';

const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

function parseArgs(rest) {
  const o = {};
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    if (x.startsWith('--')) {
      const k = x.slice(2);
      const v = rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[++i] : true;
      o[k] = v;
    } else (o._ ||= []).push(x);
  }
  return o;
}

const [cmd, ...rest] = process.argv.slice(2);
const a = parseArgs(rest);

function cmdIndex() {
  const n = L.writeBoard();
  console.log(`看板已重建：mem/index.md（${n} 字）`);
  if (n > L.BOARD_MAX) console.warn(`警告：看板 ${n} 字超过 ${L.BOARD_MAX} 字上限，该砍核心事实或未办条数`);
}

function cmdFactSet() {
  const key = String(a.key ?? '').trim();
  const value = String(a.value ?? '').trim();
  if (!key || !value) die('用法：memcore.mjs fact-set --key "教学进度.当前章节" --value "椭圆" [--core]');
  if ([...key].length > 40) die(`key 太长（${[...key].length} 字，上限 40）`);
  if ([...value].length > L.TEXT_MAX) die(`value 太长（${[...value].length} 字，上限 ${L.TEXT_MAX}）`);
  const list = L.readFacts();
  const found = list.find((f) => f.key === key);
  const core = a.core === true || a.core === 'true' || (a['no-core'] ? false : found?.core ?? false);
  if (found) {
    Object.assign(found, { value, core, removed: false, updated: L.nowISO() });
  } else {
    list.push({ key, value, core, removed: false, updated: L.nowISO() });
  }
  L.saveFacts(list);
  const n = L.writeBoard();
  console.log(`事实已记：${key} = ${L.cut(value, 40)}${core ? '［核心］' : ''}（看板 ${n} 字）`);
}

function cmdFactRm() {
  const key = String(a.key ?? '').trim();
  if (!key) die('用法：memcore.mjs fact-rm --key "…"');
  const list = L.readFacts();
  const found = list.find((f) => f.key === key);
  if (!found) die(`没这条事实：${key}`);
  found.removed = true;
  found.updated = L.nowISO();
  L.saveFacts(list);
  L.writeBoard();
  console.log(`已作废「${key}」；要恢复就 fact-set 同 key 重新写`);
}

function cmdFactList() {
  const list = L.readFacts().filter((f) => !f.removed);
  if (!list.length) {
    console.log('（还没有事实）');
    return;
  }
  for (const f of list) console.log(`- ${f.core ? '［核心］' : ''}${f.key}：${f.value}（${L.mmdd(f.updated || L.nowISO())}）`);
}

function cmdThreadAdd() {
  const text = String(a.text ?? '').trim();
  if (!text) die('用法：memcore.mjs thread-add --text "…" [--due 2026-11-30]');
  if ([...text].length > L.TEXT_MAX) die(`text 太长（上限 ${L.TEXT_MAX} 字）`);
  const due = a.due ? String(a.due) : null;
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) die(`due 要写成 2026-11-30 这种：${due}`);
  const list = L.readThreads();
  const id = `t-${Date.now().toString(36)}`;
  list.push({ id, text, due, status: 'open', created: L.nowISO() });
  L.saveThreads(list);
  L.writeBoard();
  console.log(`欠账已记：[${id}] ${L.cut(text, 40)}${due ? `（due ${due}）` : ''}`);
}

function cmdThreadClose() {
  const id = String(a.id ?? '').trim();
  if (!id) die('用法：memcore.mjs thread-close --id t-xxx');
  const list = L.readThreads();
  const t = list.find((x) => x.id === id);
  if (!t) die(`没这条欠账：${id}`);
  if (t.status === 'closed') {
    console.log('这条已经关过了');
    return;
  }
  t.status = 'closed';
  t.closedAt = L.nowISO();
  L.saveThreads(list);
  L.writeBoard();
  console.log(`已关：[${id}] ${L.cut(t.text, 40)}`);
}

function cmdThreadList() {
  const all = L.readThreads();
  const show = a.all ? all : all.filter((t) => t.status !== 'closed');
  if (!show.length) {
    console.log(a.all ? '（还没有欠账）' : '（没有未办的事）');
    return;
  }
  for (const t of show) {
    console.log(
      `- [${t.status === 'closed' ? '已办' : '未办'}] ${t.id} ${t.text}${t.due ? `（due ${t.due}）` : ''}（建 ${L.mmdd(t.created || L.nowISO())}${t.closedAt ? `，关 ${L.mmdd(t.closedAt)}` : ''}）`
    );
  }
  if (!a.all) console.log(`共 ${show.length} 条未办；看全部加 --all`);
}

// 把超过 hotDays 天的流水挪到 mem/archive/YYYY-MM.jsonl
function rotate(hotDays = L.HOT_DAYS) {
  const raw = fs.existsSync(L.STREAM)
    ? fs.readFileSync(L.STREAM, 'utf8').split('\n').filter((l) => l.trim())
    : [];
  const bad = raw.filter((l) => {
    try {
      JSON.parse(l);
      return false;
    } catch {
      return true;
    }
  });
  if (bad.length) die(`流水里有 ${bad.length} 行坏数据，先修掉或删掉再归档（不然归档会把它吞了）`);
  const stream = L.readStream();
  const cutoff = Date.now() - hotDays * 86400000;
  const hot = [];
  const cold = [];
  for (const e of stream) {
    if (Number.isNaN(Date.parse(e.t))) die(`流水里有一条时间不合法：${JSON.stringify(e).slice(0, 80)}`);
    (Date.parse(e.t) < cutoff ? cold : hot).push(e);
  }
  if (!cold.length) return { moved: 0 };
  const byMonth = new Map();
  for (const e of cold) {
    const k = e.t.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(e);
  }
  fs.mkdirSync(L.ARCHIVE, { recursive: true });
  for (const [k, list] of byMonth) {
    fs.appendFileSync(path.join(L.ARCHIVE, `${k}.jsonl`), list.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }
  fs.writeFileSync(L.STREAM, hot.map((e) => JSON.stringify(e)).join('\n') + (hot.length ? '\n' : ''), 'utf8');
  L.writeBoard();
  return { moved: cold.length };
}

function cmdRotate() {
  const days = a.days ? Number(a.days) : L.HOT_DAYS;
  const { moved } = rotate(days);
  console.log(moved ? `已归档 ${moved} 条到 mem/archive/（热存保留 ${days} 天）` : `没有超过 ${days} 天的流水，不用归档`);
}

function cmdWeekly() {
  const { moved } = rotate(L.HOT_DAYS);
  const week = L.isoWeek(L.nowISO());
  const stream = L.readStream();
  const inWeek = stream.filter((e) => L.isoWeek(e.t) === week);
  const byKind = new Map();
  for (const e of inWeek) byKind.set(e.kind, (byKind.get(e.kind) || 0) + 1);
  const facts = L.readFacts().filter((f) => !f.removed);
  const newFacts = facts.filter((f) => f.updated && L.isoWeek(f.updated) === week);
  const threads = L.readThreads();
  const opened = threads.filter((t) => L.isoWeek(t.created) === week);
  const closed = threads.filter((t) => t.closedAt && L.isoWeek(t.closedAt) === week);
  const open = threads.filter((t) => t.status !== 'closed');

  const lines = [];
  lines.push(`# 周报 ${week}`, '');
  lines.push(`- 流水：${inWeek.length} 条（${[...byKind.entries()].map(([k, v]) => `${k} ${v}`).join(' / ') || '无'}）`);
  lines.push(`- 新增事实：${newFacts.length} 条${newFacts.length ? `（${newFacts.map((f) => f.key).join('、')}）` : ''}`);
  lines.push(`- 欠账：新开 ${opened.length} 条，关掉 ${closed.length} 条，还剩 ${open.length} 条未办`);
  lines.push(`- 归档：${moved} 条流水挪到 mem/archive/`);
  if (open.length) {
    lines.push('', '## 未办');
    for (const t of open) lines.push(`- [${t.id}] ${t.text}${t.due ? `（due ${t.due}）` : ''}`);
  }
  if (inWeek.length) {
    lines.push('', '## 本周流水');
    for (const e of inWeek.slice(-30)) lines.push(`- ${L.dayOf(e.t).slice(5)} [${e.kind}] ${L.cut(e.text, 60)}`);
  }
  if (typeof a.note === 'string' && a.note.trim()) {
    lines.push('', '## 本周一句话', '', String(a.note).trim());
  }
  fs.mkdirSync(L.WEEKLY, { recursive: true });
  const file = path.join(L.WEEKLY, `${week}.md`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  console.log(`周报已生成：mem/weekly/${week}.md（本周流水 ${inWeek.length} 条，归档 ${moved} 条，未办 ${open.length} 条）`);
}

function cmdCheck() {
  const blockers = [];
  const warns = [];

  const facts = L.readFacts();
  const threads = L.readThreads();
  const seen = new Set();
  for (const f of facts) {
    if (!f || typeof f !== 'object') {
      blockers.push('facts 里有非对象条目');
      continue;
    }
    if (!f.key) blockers.push('事实缺 key');
    else if (seen.has(f.key)) blockers.push(`事实 key 重复：${f.key}`);
    else seen.add(f.key);
    if (!f.removed && (f.value === undefined || f.value === '')) blockers.push(`事实「${f.key}」空值`);
    if (f.key && [...f.key].length > 40) blockers.push(`事实 key 太长：${f.key}`);
    if (f.value !== undefined && [...String(f.value)].length > L.TEXT_MAX) blockers.push(`事实「${f.key}」超 ${L.TEXT_MAX} 字`);
  }
  const core = facts.filter((f) => f.core && !f.removed);
  if (core.length > 12) blockers.push(`核心事实 ${core.length} 条 > 12`);

  const ids = new Set();
  for (const t of threads) {
    if (!t || !t.id) blockers.push('欠账缺 id');
    else if (ids.has(t.id)) blockers.push(`欠账 id 重复：${t.id}`);
    else ids.add(t.id);
    if (!t.text) blockers.push(`欠账 ${t.id} 缺内容`);
    if (t.text && [...t.text].length > L.TEXT_MAX) blockers.push(`欠账 ${t.id} 超 ${L.TEXT_MAX} 字`);
    if (t.due && !/^\d{4}-\d{2}-\d{2}$/.test(t.due)) blockers.push(`欠账 ${t.id} due 格式不对：${t.due}`);
  }

  const stream = [];
  if (fs.existsSync(L.STREAM)) {
    fs.readFileSync(L.STREAM, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!line.trim()) return;
        try {
          stream.push(JSON.parse(line));
        } catch {
          blockers.push(`流水第 ${i + 1} 行不是合法 JSON`);
        }
      });
  }
  for (const e of stream) {
    if (!e.t || Number.isNaN(Date.parse(e.t))) blockers.push('流水有条目时间不合法');
    if (!e.text) blockers.push('流水有条目缺 text');
    if (e.text && [...e.text].length > L.TEXT_MAX && !e.forced) blockers.push(`流水有条目超 ${L.TEXT_MAX} 字且没 forced 标记`);
  }

  const today = L.day(new Date());
  const open = threads.filter((t) => t.status !== 'closed');
  const overdue = open.filter((t) => t.due && t.due < today);
  if (overdue.length) warns.push(`${overdue.length} 条欠账过期：${overdue.map((t) => t.id).join('、')}`);

  const expected = L.buildBoard();
  const actual = fs.existsSync(L.BOARD) ? fs.readFileSync(L.BOARD, 'utf8') : '';
  if (!actual) warns.push('看板不存在，跑 `node bin/memcore.mjs index`');
  else if (actual !== expected) warns.push('看板过期，跑 `node bin/memcore.mjs index`');
  const boardChars = [...expected].length;
  if (boardChars > L.BOARD_MAX) warns.push(`看板 ${boardChars} 字 > ${L.BOARD_MAX}`);

  const stale = stream.filter((e) => Date.parse(e.t) < Date.now() - L.HOT_DAYS * 86400000).length;
  if (stale) warns.push(`${stale} 条流水超 ${L.HOT_DAYS} 天没归档，跑 \`node bin/memcore.mjs weekly\``);

  console.log(
    `检查：事实 ${facts.filter((f) => !f.removed).length} 条（核心 ${core.length}）· 欠账 ${threads.length} 条（未办 ${open.length}）· 流水 ${stream.length} 条`
  );
  console.log('阻断：' + (blockers.length ? '' : '无'));
  for (const b of blockers) console.log(`  - ${b}`);
  console.log('警告：' + (warns.length ? '' : '无'));
  for (const w of warns) console.log(`  - ${w}`);
  console.log('结论：' + (blockers.length ? '不通过' : '通过'));
  process.exit(blockers.length ? 1 : 0);
}

switch (cmd) {
  case 'index':
    cmdIndex();
    break;
  case 'check':
    cmdCheck();
    break;
  case 'fact-set':
    cmdFactSet();
    break;
  case 'fact-rm':
    cmdFactRm();
    break;
  case 'fact-list':
    cmdFactList();
    break;
  case 'thread-add':
    cmdThreadAdd();
    break;
  case 'thread-close':
    cmdThreadClose();
    break;
  case 'thread-list':
    cmdThreadList();
    break;
  case 'rotate':
    cmdRotate();
    break;
  case 'weekly':
    cmdWeekly();
    break;
  default:
    console.log(`用法：memcore.mjs <命令>

  index                                  重建看板 mem/index.md
  check                                  体检（阻断=必须修，警告=该处理）
  fact-set --key "…" --value "…" [--core]  写长期事实（同 key 覆盖）
  fact-rm  --key "…"                      作废一条事实
  fact-list                              列全部事实
  thread-add --text "…" [--due 2026-11-30] 记一件没办的事
  thread-close --id t-xxx                关掉
  thread-list [--all]                    列未办/全部
  rotate [--days 7]                      把旧流水挪进 mem/archive/
  weekly [--note "一句话周结"]            归档 + 出周报 mem/weekly/`);
}
