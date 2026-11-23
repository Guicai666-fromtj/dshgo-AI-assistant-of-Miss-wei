#!/usr/bin/env node
// 记忆流水：add / recall / stats
import * as L from './lib.mjs';

const KINDS = ['progress', 'note', 'health', 'preference', 'plan', 'rule', 'todo', 'sleep', 'score', 'other'];
const BANNED = ['heartbeat', 'noop', 'ping', 'debug'];

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

function parseArgs(rest) {
  const o = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[++i] : true;
      o[k] = v;
    } else (o._ ||= []).push(a);
  }
  return o;
}

const [cmd, ...rest] = process.argv.slice(2);
const a = parseArgs(rest);

if (cmd === 'add') {
  const text = String(a.text ?? '').trim();
  if (!text) die('用法：mem.mjs add --src app --kind note --text "一句话"');
  const kind = String(a.kind ?? 'note');
  if (BANNED.includes(kind)) die(`kind=${kind} 是无用消息，不记`);
  if (!KINDS.includes(kind)) die(`kind 只能是：${KINDS.join(' / ')}`);
  const src = String(a.src ?? 'app');
  const len = [...text].length;
  const forced = a.force === true || a.force === 'true';
  if (len > L.TEXT_MAX && !forced) die(`太长（${len} 字，上限 ${L.TEXT_MAX}）；真需要加 --force`);
  if (len > 1000) die('超过 1000 字，拆成几条再记');
  const today = L.day(new Date());
  if (L.readStream().some((e) => e.text === text && L.dayOf(e.t) === today)) {
    console.log('今天记过同样的话，跳过');
    process.exit(0);
  }
  const entry = { t: L.nowISO(), src, kind, text };
  if (forced) entry.forced = true;
  L.appendStream(entry);
  const n = L.writeBoard();
  console.log(`记下：${kind} · ${L.cut(text, 40)}（看板 ${n} 字）`);
} else if (cmd === 'recall') {
  const kw = String(a._?.[0] ?? '').trim();
  if (!kw) die('用法：mem.mjs recall 关键词 [--days 30]');
  const days = a.days ? Number(a.days) : 0;
  const cutoff = days ? Date.now() - days * 86400000 : 0;
  const hits = [...L.readStream(), ...L.readArchive()]
    .filter((e) => String(e.text || '').includes(kw) && Date.parse(e.t) >= cutoff)
    .sort((x, y) => Date.parse(y.t) - Date.parse(x.t));
  if (!hits.length) {
    console.log(`没搜到「${kw}」`);
    process.exit(0);
  }
  console.log(`搜到 ${hits.length} 条（列前 ${Math.min(20, hits.length)}）`);
  for (const e of hits.slice(0, 20)) console.log(`${L.dayOf(e.t)} ${L.hm(e.t)} [${e.src}/${e.kind}] ${e.text}`);
} else if (cmd === 'stats') {
  const hot = L.readStream();
  const cold = L.readArchive();
  const all = [...cold, ...hot].sort((x, y) => Date.parse(x.t) - Date.parse(y.t));
  console.log(`流水：热存 ${hot.length} 条 · 归档 ${cold.length} 条`);
  if (all.length) console.log(`时间跨度：${all[0].t.slice(0, 10)} ~ ${all[all.length - 1].t.slice(0, 10)}`);
  const facts = L.readFacts().filter((f) => !f.removed).length;
  const open = L.readThreads().filter((t) => t.status !== 'closed').length;
  console.log(`事实：${facts} 条 · 未办：${open} 条`);
} else {
  console.log(`用法：mem.mjs <add|recall|stats>

  add      --src app|qq|manual --kind <${KINDS.join('|')}> --text "一句话" [--force]
  recall   关键词 [--days 30]
  stats    看流水/事实/未办计数`);
}
