/* 课表解析核心（浏览器版）：protobuf 解码 + zlib 解压（DecompressionStream） + 结构提取
 * 与 functions/schedule-proxy/{parser,extract}.js 逻辑一致；供书签脚本导入数据使用 */
(function (global) {
  'use strict';

  function readVarint(b, i) {
    let v = 0, shift = 0;
    for (;;) {
      if (i >= b.length) return null;
      const byte = b[i++];
      v += (byte & 0x7f) * Math.pow(2, shift);
      if (!(byte & 0x80)) return [v, i];
      shift += 7;
      if (shift > 56) return null;
    }
  }
  function pf(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const out = []; let i = 0;
    for (;;) {
      if (i >= b.length) return out;
      const t = readVarint(b, i); if (!t) return null;
      const tag = Math.floor(t[0] / 8), wt = t[0] % 8; i = t[1];
      if (tag === 0) return null;
      if (wt === 0) {
        const r = readVarint(b, i); if (!r) return null; i = r[1];
        out.push([tag, 0, r[0]]);
      } else if (wt === 1) {
        if (i + 8 > b.length) return null;
        out.push([tag, 1, b.slice(i, i + 8)]); i += 8;
      } else if (wt === 5) {
        if (i + 4 > b.length) return null;
        out.push([tag, 5, b.slice(i, i + 4)]); i += 4;
      } else if (wt === 2) {
        const r = readVarint(b, i); if (!r) return null;
        const L = r[0]; i = r[1];
        if (i + L > b.length) return null;
        out.push([tag, 2, b.slice(i, i + L)]); i += L;
      } else return null;
    }
  }
  function field(fields, tag) { return fields && fields.find(f => f[0] === tag); }

  function parseRich(rec) {
    let text = '';
    const runs = pf(rec);
    if (!runs) return text;
    for (const run of runs.filter(f => f[0] === 3)) {
      const rInner = pf(run[2]);
      const f3 = rInner && field(rInner, 3);
      if (!f3) continue;
      const f3Inner = pf(f3[2]);
      const t = f3Inner && field(f3Inner, 1);
      if (t) text += new TextDecoder().decode(t[2]);
    }
    return text;
  }

  async function inflate(b64) {
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    if (typeof DecompressionStream === 'undefined') throw new Error('浏览器过旧，不支持解压（请改用电脑刷新）');
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bin]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /** 解析单个 related_sheet（已解压）-> {"r,c": text} */
  function parseCellsFromBlob(buf) {
    const lvl1 = pf(pf(buf)[0][2]);
    let payload = null;
    for (const b of lvl1.filter(f => f[0] === 5)) {
      const inner = pf(b[2]);
      const t = field(inner, 1);
      const pl = inner.find(f => f[0] !== 1);
      if (t && t[2] === 18 && pl) payload = pl[2];
    }
    if (!payload) throw new Error('未找到单元格数据块');
    const msg = pf(payload);
    const sec5rec = field(msg, 5);
    const strings = [], rich = [];
    for (const r of pf(sec5rec[2])) {
      if (r[0] === 1) {
        const inner = pf(r[2]);
        const f1 = inner && field(inner, 1);
        strings.push(f1 ? new TextDecoder().decode(f1[2]) : '');
      } else if (r[0] === 2) rich.push(parseRich(r[2]));
    }
    const cells = {};
    for (const f of msg.filter(f => f[0] === 6)) {
      const inner = pf(f[2]);
      const f1 = field(inner, 1), f2 = field(inner, 2), f3 = field(inner, 3);
      const row = f1 ? f1[2] : 0, col = f2 ? f2[2] : 0;
      if (!f3) continue;
      const i3 = pf(f3[2]);
      const sRec = field(i3, 1);
      const style = sRec ? sRec[2] : null;
      const vRec = field(i3, 2);
      if (!vRec) continue;
      const vi = pf(vRec[2]);
      const v1 = vi && field(vi, 1);
      if (!v1 || v1[2] === 0) continue;
      let value = '';
      if (style === 2) value = String(v1[2]);
      else if (style === 4) value = strings[v1[2]] || '';
      else if (style === 6) value = rich[v1[2]] || '';
      else continue;
      if (value && value.trim()) cells[row + ',' + col] = value;
    }
    return cells;
  }

  // ---------- 结构提取（与 extract.js 一致） ----------
  var SLOT_ORDER = ['上午', '下午', '晚上'];
  var LOC_HINTS = ['楼', '厅', '室', '馆', '场', '中心', '基地'];
  var DATE_PTRN = /[（(](\d+)\s*[-–—]\s*(\d+)节[)）]/;

  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function iso(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  function parseCourseText(text) {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return null;
    const course = { name: lines[0], periods: null, location: '', teacher: '', className: '', extra: [] };
    const pm = course.name.match(DATE_PTRN);
    const pm1 = course.name.match(/[（(](\d+)节[)）]/);
    if (pm) { course.periods = [parseInt(pm[1], 10), parseInt(pm[2], 10)]; course.name = course.name.replace(pm[0], '').trim(); }
    else if (pm1) { const n = parseInt(pm1[1], 10); course.periods = [n, n]; course.name = course.name.replace(pm1[0], '').trim(); }
    const rest = lines.slice(1);
    for (let i = rest.length - 1; i >= 0; i--) {
      if (/^[\u4e00-\u9fff·、，,\s]{2,14}$/.test(rest[i]) && !LOC_HINTS.some(h => rest[i].includes(h))) {
        course.teacher = rest[i].replace(/[、，,]/g, ',').replace(/\s/g, '');
        rest.splice(i, 1);
        break;
      }
    }
    for (const line of rest) {
      if (LOC_HINTS.some(h => line.includes(h)) && !/班$/.test(line)) {
        course.location = course.location ? course.location + ' ' + line : line;
      } else if (/^\d+[-－]?\d*班$/.test(line) || (line.endsWith('班') && line.length <= 6)) {
        course.className = line;
      } else course.extra.push(line);
    }
    return course;
  }

  function extractSchedule(cells) {
    const at = (r, c) => cells[r + ',' + c] || '';
    const maxRow = Math.max.apply(null, Object.keys(cells).map(k => +k.split(',')[0]));

    const monthAnchors = [];
    for (let r = 0; r <= maxRow; r++) {
      const m = at(r, 0).replace(/\s+/g, '').match(/^(\d{4})年(\d{1,2})月$/);
      if (m) monthAnchors.push({ row: r, year: +m[1], month: +m[2] });
    }
    const blockStarts = [];
    for (let r = 0; r <= maxRow; r++) if (at(r, 2).trim() === '时间段') blockStarts.push(r);
    if (!blockStarts.length) throw new Error('未找到周块（是否为课表文档？）');

    const rawWeeks = [];
    for (let bi = 0; bi < blockStarts.length; bi++) {
      const start = blockStarts[bi];
      const end = bi + 1 < blockStarts.length ? blockStarts[bi + 1] - 1 : maxRow;
      const dateRow = start + 1;
      let weekNo = null;
      for (let r = start; r <= Math.min(dateRow + 1, end); r++) {
        const m = at(r, 1).match(/第(\d+)周/);
        if (m) { weekNo = +m[1]; break; }
      }
      if (weekNo == null) continue;
      let mondayDay = null;
      for (let c = 3; c <= 9; c++) {
        const dv = at(dateRow, c).trim();
        if (/^\d+$/.test(dv)) { mondayDay = parseInt(dv, 10); break; }
      }
      rawWeeks.push({ weekNo, dateRow, end, mondayDay });
    }
    if (!rawWeeks.length) throw new Error('未找到任何周次');

    // 第一周周一：锚点投票
    let firstMonday = null;
    {
      const votes = new Map();
      for (const a of monthAnchors) {
        const w = rawWeeks.find(w => w.dateRow >= a.row && w.mondayDay != null)
          || rawWeeks.find(w => w.mondayDay != null);
        if (!w) continue;
        let year = a.year, month = a.month;
        if (w.mondayDay > daysInMonth(year, month)) { month -= 1; if (month < 1) { month = 12; year -= 1; } }
        const implied = new Date(year, month - 1, w.mondayDay);
        implied.setDate(implied.getDate() - 7 * (w.weekNo - 1));
        const key = implied.getFullYear() + '-' + (implied.getMonth() + 1) + '-' + implied.getDate();
        votes.set(key, (votes.get(key) || 0) + 1);
      }
      if (votes.size) {
        let best = null, bestN = -1;
        votes.forEach((n, k) => { if (n > bestN) { bestN = n; best = k; } });
        const p = best.split('-').map(Number);
        firstMonday = new Date(p[0], p[1] - 1, p[2]);
      }
    }
    const dateOf = (weekNo, dayIdx) => {
      if (!firstMonday) return null;
      const d = new Date(firstMonday.getTime());
      d.setDate(d.getDate() + 7 * (weekNo - 1) + dayIdx);
      return d;
    };

    const weeks = [], classNames = new Set();
    for (const w of rawWeeks) {
      const days = [[], [], [], [], [], [], []];
      const notes = [];
      let curSlot = null;
      for (let r = w.dateRow + 1; r <= w.end; r++) {
        const slotLabel = at(r, 2).trim();
        if (SLOT_ORDER.includes(slotLabel)) curSlot = slotLabel;
        for (let c = 3; c <= 9; c++) {
          const v = at(r, c);
          if (!v.trim()) continue;
          const course = parseCourseText(v);
          if (!course) continue;
          if (course.className) classNames.add(course.className);
          days[c - 3].push(Object.assign({ slot: curSlot, row: r }, course));
        }
        const note = at(r, 10).trim();
        if (note) notes.push(note);
      }
      // 不做合并遮盖过滤：同列同时段多门课是真实并行课，全量保留（渲染层角标+弹层展示）
      for (let d = 0; d < 7; d++) {
        days[d] = days[d].map(function (c) { const o = Object.assign({}, c); delete o.row; return o; });
      }
      const dates = [];
      for (let i = 0; i < 7; i++) {
        const d = dateOf(w.weekNo, i);
        dates.push(d ? { date: iso(d), month: d.getMonth() + 1, day: d.getDate() } : null);
      }
      weeks.push({ week: w.weekNo, row: w.start, dates, days, notes: Array.from(new Set(notes)) });
    }
    weeks.sort((a, b) => a.week - b.week);
    return {
      weeks, classes: Array.from(classNames),
      meta: {
        firstWeekMonday: firstMonday ? iso(firstMonday) : null,
        maxWeek: weeks.length ? weeks[weeks.length - 1].week : null,
        weekRows: weeks.map(function (w) { return { week: w.week, row: w.row }; }),
        generatedAt: new Date().toISOString(),
      },
    };
  }

  /** 导入书签脚本导出的载荷 {v, doc, blocks:[{max_row,max_col,b:[related_sheet...]}]} */
  async function importPayload(payload) {
    const cells = {};
    for (const t of payload.blocks) {
      for (const b64 of t.b) {
        Object.assign(cells, parseCellsFromBlob(await inflate(b64)));
      }
    }
    if (!Object.keys(cells).length) throw new Error('载荷中没有单元格数据');
    const sched = extractSchedule(cells);
    sched.meta.docId = payload.doc || '';
    sched.meta.importedAt = new Date().toISOString();
    return sched;
  }

  const api = { importPayload, parseCellsFromBlob, extractSchedule, inflate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ScheduleCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
