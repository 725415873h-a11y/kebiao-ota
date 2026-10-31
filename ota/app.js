/* 年级课表 App —— 零依赖前端 */
(function () {
  'use strict';

  // ---------- 常量与默认配置 ----------
  var DEFAULT_DOC_ID = (window.DOC_ID || 'DRHB4Y3VJVktWak5S');
  // 学院作息时间安排（福州学院：早、中、晚三个时段各 4 节）
  var DEFAULT_PERIODS = {
    1: ['08:30', '09:15'], 2: ['09:20', '10:05'], 3: ['10:25', '11:10'], 4: ['11:15', '12:00'],
    5: ['13:30', '14:15'], 6: ['14:20', '15:05'], 7: ['15:25', '16:10'], 8: ['16:15', '17:00'],
    9: ['18:30', '19:15'], 10: ['19:20', '20:05'], 11: ['20:10', '20:55'], 12: ['21:00', '21:45']
  };
  var OTA_URL = 'https://fastly.jsdelivr.net/gh/725415873h-a11y/kebiao-ota@main'; // 内置更新源（fastly 节点缓存刷新最快）
  var DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  var LS = 'gradeSchedule.';

  // ---------- 状态 ----------
  var state = {
    data: null,          // {weeks, classes, meta}
    dataTs: 0,
    week: null,          // 当前查看的周
    tab: 'timetable',
    mode: 'grade',       // grade=年级课程 | mine=我的课程
    mine: {},            // key -> true，我的课程集合
    docId: DEFAULT_DOC_ID,
    remindOn: false,
    remindLead: 15,
    icsAllday: true,
    notified: {},        // 提醒去重
    otaUrl: OTA_URL      // 软件更新源（内置）
  };

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(LS + 'settings') || '{}');
      if (s.remindOn !== undefined) state.remindOn = s.remindOn;
      if (s.remindLead) state.remindLead = s.remindLead;
      if (s.icsAllday !== undefined) state.icsAllday = s.icsAllday;
      if (s.docId) state.docId = s.docId;
      if (s.mode === 'mine' || s.mode === 'grade') state.mode = s.mode;
      if (s.todayMode === 'mine' || s.todayMode === 'grade') state.todayMode = s.todayMode;
      if (s.mine) state.mine = s.mine;
    } catch (e) { /* 忽略损坏的本地设置 */ }
    var cached = localStorage.getItem(LS + 'data');
    if (cached) {
      try { var c = JSON.parse(cached); state.data = c.data; state.dataTs = c.ts; dataSource = 'cache'; } catch (e) { /* noop */ }
    }
    // 内嵌快照 vs 缓存：谁的时间新用谁（在线抓取/导入后的缓存总是比构建期快照新）
    if (window.EMBEDDED_SCHEDULE && window.EMBEDDED_SCHEDULE.weeks) {
      var snapTs = Date.parse(window.EMBEDDED_SCHEDULE.meta && window.EMBEDDED_SCHEDULE.meta.fetchedAt || '') || 0;
      if (!state.data || snapTs > state.dataTs) {
        state.data = window.EMBEDDED_SCHEDULE;
        state.dataTs = snapTs || Date.now();
        dataSource = 'snapshot';
      }
    }
  }
  function saveSettings() {
    localStorage.setItem(LS + 'settings', JSON.stringify({
      mode: state.mode, todayMode: state.todayMode || 'grade', mine: state.mine,
      remindOn: state.remindOn, remindLead: state.remindLead, icsAllday: state.icsAllday, docId: state.docId
    }));
  }
  function saveDataCache() {
    try {
      localStorage.setItem(LS + 'data', JSON.stringify({ ts: state.dataTs, data: state.data }));
    } catch (e) { /* 存储超限时忽略 */ }
  }

  // ---------- 工具 ----------
  function $(id) { return document.getElementById(id); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayStr(d) { d = d || new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function hashHue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h >>> 0; }
  // 低饱和课程色板（借鉴 west2-online/fzuhelper）
  // 仅深色（白字对比度充足，亮度均 < 125）
  var PALETTE = ['#7A6068', '#8D5270', '#3A82A8', '#2E7377', '#8B7396', '#527F98', '#4C8376', '#B0656F', '#96687E', '#58779E', '#C0747E', '#8C5A4A', '#6B5E8C', '#8C6E56', '#A05C74', '#5B7A56', '#7E5D74', '#4E6E78', '#98576B', '#6E5E50'];
  function courseColor(c) { return PALETTE[hashHue(c.name + (c.className || '')) % PALETTE.length]; }
  function textOn(hex) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 190 ? '#33404f' : '#ffffff';
  }

  function periodStart(p) { var t = DEFAULT_PERIODS[p]; return t ? t[0] : null; }
  function periodEnd(p) { var t = DEFAULT_PERIODS[p]; return t ? t[1] : null; }
  function courseTimes(c) {
    if (!c.periods) return null;
    var s = periodStart(c.periods[0]), e = periodEnd(c.periods[1]);
    return s && e ? { start: s, end: e } : null;
  }
  function minutesOf(hm) { var a = hm.split(':'); return (+a[0]) * 60 + (+a[1]); }

  // 模式独立：课表页与今天页各自记忆（mode=课表页, todayMode=今天页）
  function modeFor(tab) { return tab === 'today' ? (state.todayMode || 'grade') : (state.mode || 'grade'); }
  function setModeFor(tab, m) {
    if (tab === 'today') { state.todayMode = m; saveSettings(); renderTodayNav(); renderToday(); }
    else { state.mode = m; saveSettings(); renderAll(); }
  }
  // 可见性：年级课程全显示；我的课程仅显示已选（按当前页面的模式判定）
  function courseKey(c) { return c.name + '|' + (c.className || ''); }
  function isVisible(c) {
    var m = modeFor(state.tab);
    if (m === 'mine') return !!state.mine[courseKey(c)];
    return true;
  }

  function findTodayLocation() {
    if (!state.data) return null;
    var t = todayStr();
    for (var i = 0; i < state.data.weeks.length; i++) {
      var w = state.data.weeks[i];
      for (var d = 0; d < 7; d++) {
        if (w.dates[d] && w.dates[d].date === t) return { week: w, dayIdx: d };
      }
    }
    return null;
  }

  // ---------- 数据加载 ----------
  // 来源：内嵌快照（data.js）/ localStorage 缓存；在线更新仅两条通道：
  // App 内原生抓取（openDoc）与网页版书签脚本导入，不使用局域网
  var dataSource = 'none'; // snapshot | cache
  var pendingRefreshResolve = null; // APK 后台抓取期间挂起的下拉刷新回调
  var slideDir = 0; // 周切换动画方向：+1 下一周（右入），-1 上一周（左入）
  var cycTimer = null;   // 重叠轮播定时器（模块级防泄漏）
  var cycleState = {};   // 各重叠卡当前显示序号

  function applyData(j, source) {
    state.data = { weeks: j.weeks, classes: j.classes, meta: j.meta || {} };
    state.dataTs = Date.now();
    dataSource = source;
    saveDataCache();
    renderAll();
  }

  function fetchSchedule(force) {
    if (state.data && dataSource === 'snapshot' && !force) { renderAll(); return Promise.resolve(); }
    // APK：原生后台抓取，结果经 __autoImport/__refreshFail 闭环
    if (window.KebiaoAndroid) {
      toast('正在后台刷新课表…', 3000);
      window.KebiaoAndroid.openDoc(state.docId);
      return new Promise(function (resolve) { pendingRefreshResolve = resolve; });
    }
    // 网页版：使用内嵌快照/缓存
    renderAll();
    if (force) toast('网页版请用「在线更新（书签脚本）」导入最新数据', 6000);
    return Promise.resolve();
  }

  // ---------- 渲染 ----------
  function renderAll() {
    var isTT = state.tab === 'timetable';
    var isTD = state.tab === 'today';
    $('topbar-title').hidden = isTT || isTD;
    $('weeknav').hidden = !isTT;
    $('todaynav').hidden = !isTD;
    $('main').classList.toggle('fit', isTT);
    $('modename').textContent = (state.mode || 'grade') === 'mine' ? '我的课程' : '年级课程';
    $('modename2').textContent = (state.todayMode || 'grade') === 'mine' ? '我的课程' : '年级课程';
    renderWeekNav();
    if (isTD) renderTodayNav();
    renderTimetable();
    renderToday();
    renderSettings();
    renderDataStatus();
  }

  function currentWeekObj() {
    if (!state.data) return null;
    var ws = state.data.weeks;
    if (state.week == null) {
      var loc = findTodayLocation();
      return loc ? loc.week : (ws.find(function (w) { return w.days.some(function (d) { return d.length; }); }) || ws[0]);
    }
    return ws.find(function (w) { return w.week === state.week; }) || ws[0];
  }

  function renderWeekNav() {
    var w = currentWeekObj();
    if (!w) { $('weeknum').textContent = '-'; return; }
    state.week = w.week;
    $('weeknum').textContent = w.week;
    if (state.data && state.data.weeks.length) {
      $('prevweek').disabled = state.data.weeks[0].week >= w.week;
      $('nextweek').disabled = state.data.weeks[state.data.weeks.length - 1].week <= w.week;
    }
    // 非“本周”时显示右侧回位按钮
    var loc = findTodayLocation();
    $('backtoday-week').hidden = !loc || loc.week.week === w.week;
  }

  // 课程模式选择：标题下方下拉菜单（年级课程 / 我的课程）
  function showModePicker(anchorId) {
    var anchor = $(anchorId || 'pagetitle');
    var forToday = anchorId === 'pagetitle2';
    var curMode = forToday ? (state.todayMode || 'grade') : (state.mode || 'grade');
    var mineN = Object.keys(state.mine).length;
    var menu = $('modemenu');
    var panel = menu.querySelector('.mm-panel');
    panel.innerHTML = [
      { m: 'grade', ico: '📅', bg: '#5A9DBD', name: '年级课程', desc: '全年级课表' },
      { m: 'mine', ico: '⭐', bg: '#E0B092', name: '我的课程', desc: mineN ? '已选 ' + mineN + ' 门课程' : '还未添加课程' }
    ].map(function (it) {
      return '<button class="mm-item' + (curMode === it.m ? ' cur' : '') + '" data-m="' + it.m + '">' +
        '<span class="mm-ico" style="background:' + it.bg + '">' + it.ico + '</span>' +
        '<span class="mm-body"><span class="mm-name">' + it.name + '</span><span class="mm-desc">' + it.desc + '</span></span>' +
        '<span class="mm-check">✓</span></button>';
    }).join('');
    menu.hidden = false;
    anchor.classList.add('open');
    var r = anchor.getBoundingClientRect();
    panel.style.left = Math.max(10, r.left - 8) + 'px';
    panel.style.top = (r.bottom + 8) + 'px';
    panel.querySelectorAll('.mm-item').forEach(function (b) {
      b.onclick = function () {
        setModeFor(forToday ? 'today' : 'timetable', b.getAttribute('data-m'));
        hideModePicker();
      };
    });
  }
  function hideModePicker() {
    $('modemenu').hidden = true;
    $('pagetitle').classList.remove('open');
    $('pagetitle2') && $('pagetitle2').classList.remove('open');
  }

  // 周次下拉选择（移植 fzuhelper 的周切换交互）
  function showWeekPicker() {
    if (!state.data) return;
    var html = state.data.weeks.map(function (w) {
      var d0 = w.dates[0], d6 = w.dates[6];
      return '<button class="witem' + (w.week === state.week ? ' cur' : '') + '" data-w="' + w.week + '">' +
        '<span>第' + w.week + '周</span><span class="wd">' +
        (d0 && d6 ? d0.month + '.' + d0.day + ' - ' + d6.month + '.' + d6.day : '') + '</span></button>';
    }).join('');
    openModal(html, '', null);
    $('modal-body').querySelectorAll('.witem').forEach(function (b) {
      b.onclick = function () {
        var target = +b.getAttribute('data-w');
        slideDir = target > state.week ? 1 : -1;
        state.week = target;
        closeModal();
        renderWeekNav();
        renderTimetable();
      };
    });
  }

  function visibleCourses(w) {
    var out = [];
    for (var d = 0; d < 7; d++) {
      for (var k = 0; k < (w.days[d] || []).length; k++) {
        var c = w.days[d][k];
        if (isVisible(c)) out.push({ d: d, c: c });
      }
    }
    return out;
  }

  function rowOf(p) { return p; } // 网格行 = 节次（无时段占位行，对齐 fzuhelper）

  function currentPeriod() {
    // 当前所处时间段：最后一个已开始的节次持续高亮到下一节开始（课间不灭灯）
    var now = new Date();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var active = 0;
    for (var p = 1; p <= 12; p++) {
      var s = periodStart(p);
      if (s && nowMin >= minutesOf(s)) active = p;
    }
    return active;
  }

  function renderTimetable() {
    var body = $('gridbody');
    body.innerHTML = '';
    var w = currentWeekObj();
    if (!w) { $('tt-empty').hidden = false; return; }

    // 日期行：大号日期数字，今天蓝圈白字
    var today = todayStr();
    var todayIdx = -1;
    for (var d = 0; d < 7; d++) {
      var el = document.querySelector('#gridheader .daycol.date[data-d="' + d + '"]');
      var head = document.querySelector('#gridheader .daycol.head[data-d="' + d + '"]');
      var dt = w.dates[d];
      var isToday = !!(dt && dt.date === today);
      if (isToday) todayIdx = d;
      el.innerHTML = isToday && dt ? '<span class="todaydot">' + dt.day + '</span>' : (dt ? dt.day : '');
      el.classList.toggle('today', isToday);
      head.classList.toggle('today', isToday);
      var wkend = d >= 5 && !isToday;
      el.classList.toggle('wkend', wkend);
      head.classList.toggle('wkend', wkend);
    }
    // 左上角月份徽章
    var mb = document.getElementById('monthbadge');
    if (mb) mb.innerHTML = (w.dates[0] ? w.dates[0].month : '') + '<small>月</small>';

    var items = visibleCourses(w);
    // 仅在「我的课程」完全为空时给出引导；普通空周不提示、不改动布局
    var mineEmpty = state.mode === 'mine' && !Object.keys(state.mine).length;
    $('tt-empty').hidden = !mineEmpty;
    if (mineEmpty) $('tt-empty').textContent = '我的课程还是空的，点头部的「年级课程」切回后点课程卡片加入，或在设置中按班级生成';

    var activeP = currentPeriod();
    var html = '';
    // 左侧节次列：节次号 + 起止时间，当前节高亮
    for (var p = 1; p <= 12; p++) {
      var t0 = periodStart(p), t1 = periodEnd(p);
      var active = p === activeP;
      html += '<div class="plabel' + (active ? ' active' : '') + '" style="grid-row:' + rowOf(p) + '">' +
        p + (t0 ? '<small>' + t0 + '</small>' : '') + (t1 ? '<small>' + t1 + '</small>' : '') + '</div>';
    }

    // 非节次事件（不排课等）放到事件带
    var eventsByDay = {};
    items.forEach(function (it) {
      if (!it.c.periods) { (eventsByDay[it.d] = eventsByDay[it.d] || []).push(it.c); }
    });

    // 课程：按 (天,起始节) 全量收集；重叠课聚簇，主卡全宽 + 右上角标（重叠数），点击弹列表（fzuhelper 方式）
    var groups = {};
    items.forEach(function (it) {
      var c = it.c;
      if (!c.periods) return;
      var key = it.d + '@' + c.periods[0] + '#' + courseKey(c);
      groups[key] = { d: it.d, p1: c.periods[0], c: c };
    });
    var byDay = {};
    Object.keys(groups).forEach(function (key) {
      var g = groups[key];
      (byDay[g.d] = byDay[g.d] || []).push({ p1: g.p1, p2: g.c.periods[1], key: key });
    });
    var clusterOf = {}; // key -> { members, primary }
    Object.keys(byDay).forEach(function (d) {
      var list = byDay[d].sort(function (a, b) { return a.p1 - b.p1 || a.p2 - b.p2; });
      var clusters = [], cur = null, curEnd = -1;
      list.forEach(function (it) {
        if (!cur || it.p1 > curEnd) { cur = [it]; clusters.push(cur); curEnd = it.p2; }
        else { cur.push(it); curEnd = Math.max(curEnd, it.p2); }
      });
      clusters.forEach(function (cl) {
        var primary = cl.slice().sort(function (a, b) {
          return (b.p2 - b.p1) - (a.p2 - a.p1) || a.p1 - b.p1;
        })[0];
        // 我的课程成员优先当主卡（锁定显示，不轮播）
        var mineKey = null;
        cl.forEach(function (it) { if (!mineKey && state.mine[courseKey(groups[it.key].c)]) mineKey = it.key; });
        if (mineKey) primary = { key: mineKey };
        cl.forEach(function (it) { clusterOf[it.key] = { members: cl, primary: primary.key, mineLock: !!mineKey }; });
      });
    });
    Object.keys(groups).forEach(function (key) {
      var g = groups[key];
      if (clusterOf[key].primary !== key) return; // 非主卡不渲染（重叠课由主卡轮播展示）
      var c = g.c;
      var col = courseColor(c);
      var n = clusterOf[key].members.length;
      var badge = n > 1 ? '<i class="ovbadge">' + n + '</i>' : '';
      html += '<div class="course' + (n > 1 ? ' cyc' : '') + '" data-k="' + esc(clusterOf[key].primary) + '" style="grid-column:' + (g.d + 2) +
        ';grid-row:' + rowOf(g.p1) + '/' + (rowOf(c.periods[1]) + 1) + ';background-color:' + col + ';color:#fff;">' +
        badge +
        '<div class="cname">' + esc(c.name) + (c.className ? '<br>@' + esc(c.className) : '') + '</div>' +
        (c.location ? '<div class="croom">' + esc(c.location.replace(/[（）/]/g, '')) + '</div>' : '') +
        '</div>';
    });
    body.innerHTML = html;

    // 重叠簇轮播：主卡每 2 秒切换显示下一门被折叠课程；锁定我的课程成员的簇不轮播。
    // 直接换内容不做透明过渡（半透明叠白底会被看成浅色）
    function startCycle() {
      if (cycTimer) { clearInterval(cycTimer); cycTimer = null; }
      cycTimer = setInterval(function () {
        var cards = body.querySelectorAll('.course.cyc');
        if (!cards.length) return;
        cards.forEach(function (el) {
          var key = el.getAttribute('data-k');
          var cl = clusterOf[key];
          if (cl.mineLock) return; // 我的课程锁定，不轮播
          var cur = cycleState[key] || 0;
          var next = (cur + 1) % cl.members.length;
          cycleState[key] = next;
          var c = groups[cl.members[next].key].c;
          el.style.backgroundColor = courseColor(c);
          el.querySelector('.cname').innerHTML = esc(c.name) + (c.className ? '<br>@' + esc(c.className) : '');
          el.querySelector('.croom').textContent = c.location ? c.location.replace(/[（）/]/g, '') : '';
        });
      }, 2000);
    }
    startCycle();

    // 事件卡片（不排课等）：纵向铺满当天整列，多个事件时均分
    Object.keys(eventsByDay).forEach(function (d) {
      var evs = eventsByDay[d];
      var n = evs.length;
      evs.forEach(function (ev, i) {
        var r1 = Math.floor(12 * i / n) + 1;
        var r2 = Math.floor(12 * (i + 1) / n);
        var div = document.createElement('div');
        div.className = 'course no-class';
        div.style.gridColumn = (+d) + 2;
        div.style.gridRow = r1 + '/' + (r2 + 1);
        div.textContent = ev.name;
        div.onclick = function () { showEventModal(ev); };
        body.appendChild(div);
      });
    });

    // 课程点击：重叠簇弹列表（角标卡），普通课弹详情
    body.querySelectorAll('.course:not(.no-class)').forEach(function (el) {
      el.onclick = function () {
        var key = el.getAttribute('data-k');
        var g = groups[key];
        if (!g) return;
        var cl = clusterOf[key];
        if (cl && cl.members.length > 1) {
          var list = cl.members.map(function (m) { return groups[m.key].c; });
          showCourseListModal(list, g.d, w);
        } else {
          showCourseModal(g.c, g.d, w);
        }
      };
    });

    // 周切换滑动动画（方向由 slideDir 指定，用后即清）
    body.classList.remove('slide-next', 'slide-prev');
    if (slideDir) {
      void body.offsetWidth; // 强制 reflow 重启动画
      body.classList.add(slideDir > 0 ? 'slide-next' : 'slide-prev');
      slideDir = 0;
    }
  }

  function showCourseListModal(list, dayIdx, w) {
    var dt = w.dates[dayIdx];
    var html = '<div class="hint" style="margin:0 0 6px">' + DAY_NAMES[dayIdx] + (dt ? ' ' + dt.date : '') + ' 该时段有 ' + list.length + ' 门课程</div>';
    list.forEach(function (c) {
      var t = courseTimes(c);
      var inMine = !!state.mine[courseKey(c)];
      var col = courseColor(c);
      html += '<div class="clist-item">' +
        '<h4 style="color:' + col + ';margin:0">' + esc(c.name) + (c.className ? ' <span class="tag">@' + esc(c.className) + '</span>' : '') + '</h4>' +
        '<div class="meta">' + (t ? t.start + '-' + t.end + ' ' : '') + (c.periods ? '第' + c.periods[0] + '-' + c.periods[1] + '节　' : '') +
        [c.location, c.teacher].filter(Boolean).map(esc).join(' · ') + '</div>' +
        '<button class="linkbtn" style="font-size:13px;padding:2px 0" data-k="' + esc(courseKey(c)) + '">' +
        (inMine ? '－ 从我的课程移除' : '＋ 加入我的课程') + '</button></div>';
    });
    $('modal-body').innerHTML = html;
    $('modal-toggle').style.display = 'none';
    $('modal-body').querySelectorAll('.linkbtn').forEach(function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-k');
        if (state.mine[k]) delete state.mine[k]; else state.mine[k] = true;
        saveSettings(); closeModal(); renderAll();
      };
    });
    $('modal').hidden = false;
  }

  function todayCourses() {
    var loc = findTodayLocation();
    if (!loc) return { week: null, dayIdx: -1, list: [] };
    var list = [];
    (loc.week.days[loc.dayIdx] || []).forEach(function (c) {
      if (isVisible(c)) list.push({ c: c, t: courseTimes(c) });
    });
    list.sort(function (a, b) {
      if (!a.t && !b.t) return 0;
      if (!a.t) return 1;
      if (!b.t) return -1;
      return minutesOf(a.t.start) - minutesOf(b.t.start);
    });
    return { week: loc.week, dayIdx: loc.dayIdx, list: list };
  }

  // 今天页查看日期偏移（0=今天）
  state.todayOffset = state.todayOffset || 0;

  function offsetName(off) {
    return off === 0 ? '今天' : off === -1 ? '昨天' : off === 1 ? '明天' : off === -2 ? '前天' : '后天';
  }

  // 今天页顶栏：左标题 + ‹ 标签 ›（与课表页周切换同版式）
  function renderTodayNav() {
    var off = state.todayOffset || 0;
    $('modename2').textContent = (state.todayMode || 'grade') === 'mine' ? '我的课程' : '年级课程';
    $('daylabel').textContent = offsetName(off);
    $('prevday').disabled = off <= -2;
    $('nextday').disabled = off >= 2;
    // 非“今天”时显示右侧回位按钮
    $('backtoday-day').hidden = off === 0;
  }

  // 日期选择弹层（点顶栏中间标签，同周次列表样式）
  function showDayPicker() {
    var now = new Date();
    var html = '';
    for (var i = -2; i <= 2; i++) {
      var d = new Date(now.getTime());
      d.setDate(d.getDate() + i);
      html += '<button class="witem' + ((state.todayOffset || 0) === i ? ' cur' : '') + '" data-off="' + i + '">' +
        '<span>' + offsetName(i) + '</span><span class="wd">' + (d.getMonth() + 1) + '.' + d.getDate() + ' · ' + DAY_NAMES[(d.getDay() + 6) % 7] + '</span></button>';
    }
    openModal(html, '', null);
    $('modal-body').querySelectorAll('.witem').forEach(function (b) {
      b.onclick = function () {
        state.todayOffset = +b.getAttribute('data-off');
        closeModal();
        renderTodayNav();
        renderToday();
      };
    });
  }

  function renderToday() {
    var now = new Date();
    var prevOffset = state._todayPrevOffset;
    var curOffset = state.todayOffset || 0;
    state._todayPrevOffset = curOffset;
    // 切天滑动动画（方向由偏移变化决定）
    if (prevOffset !== undefined && prevOffset !== curOffset) {
      var vw = $('view-today');
      vw.classList.remove('slide-next', 'slide-prev');
      void vw.offsetWidth;
      vw.classList.add(curOffset > prevOffset ? 'slide-next' : 'slide-prev');
    }
    var viewDate = new Date(now.getTime());
    viewDate.setDate(viewDate.getDate() + curOffset);

    var tc = dateCourses(viewDate);
    if (!tc) {
      $('next-card').style.display = 'none';
      $('today-list').innerHTML = '<div class="empty">不在课表范围内</div>';
      return;
    }
    var isToday = (state.todayOffset || 0) === 0;
    var weekInfo = '第' + tc.week.week + '周';

    // 下节课卡片（仅看今天时显示实时状态；其他日期只列课程）
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var next = null, current = null;
    if (isToday) {
      tc.list.forEach(function (it) {
        if (!it.t) return;
        var s = minutesOf(it.t.start), e = minutesOf(it.t.end);
        if (nowMin >= s && nowMin < e) current = it;
        if (!next && nowMin < s) next = it;
      });
    }
    var nc = $('next-card');
    var focus = current || next;
    if (focus && isToday) {
      nc.className = '';
      nc.style.display = '';
      nc.innerHTML = '<div class="label">' + (current ? '正在进行' : '下一节课') + ' · ' + weekInfo + '</div>' +
        '<div class="main">' + esc(focus.c.name) + (focus.c.className ? ' @' + esc(focus.c.className) : '') + '</div>' +
        '<div class="sub">' + focus.t.start + ' - ' + focus.t.end + (focus.c.location ? ' · ' + esc(focus.c.location) : '') +
        (focus.c.teacher ? ' · ' + esc(focus.c.teacher) : '') + '</div>' +
        '<div class="sub">' + (current
          ? '还有 ' + (minutesOf(focus.t.end) - nowMin) + ' 分钟下课'
          : (function () { var m = minutesOf(focus.t.start) - nowMin; return m >= 60 ? Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分钟后上课' : m + ' 分钟后上课'; })()) + '</div>';
    } else {
      // 无实时课程：不显示占位模块
      nc.style.display = 'none';
    }

    // 列表
    var html = '';
    tc.list.forEach(function (it) {
      var cls = 'titem';
      if (it.t && isToday) {
        var s = minutesOf(it.t.start), e = minutesOf(it.t.end);
        if (nowMin >= e) cls += ' past';
        else if (nowMin >= s) cls += ' now';
      }
      html += '<div class="' + cls + '">' +
        '<div class="time">' + (it.t ? it.t.start + '<br>' + it.t.end : '全天') + '</div>' +
        '<div class="info"><div class="name">' + esc(it.c.name) + (it.c.className ? ' <span class="tag">@' + esc(it.c.className) + '</span>' : '') + '</div>' +
        '<div class="meta">' + [it.c.location, it.c.teacher, it.c.slot].filter(Boolean).map(esc).join(' · ') + '</div></div></div>';
    });
    $('today-list').innerHTML = html || '<div class="empty">' +
      ((state.todayMode || 'grade') === 'mine' && !Object.keys(state.mine).length ? '我的课程还是空的<br>点课表卡片「加入我的课程」或在设置中按班级生成' : '当天没有课程') + '</div>';
  }

  // 按任意日期取课程（返回 { week, dayIdx, list } 或 null）
  function dateCourses(date) {
    if (!state.data) return null;
    var t = todayStr(date);
    for (var i = 0; i < state.data.weeks.length; i++) {
      var w = state.data.weeks[i];
      for (var d = 0; d < 7; d++) {
        if (w.dates[d] && w.dates[d].date === t) {
          var list = [];
          (w.days[d] || []).forEach(function (c) {
            if (isVisible(c)) list.push({ c: c, t: courseTimes(c) });
          });
          list.sort(function (a, b) {
            if (!a.t && !b.t) return 0;
            if (!a.t) return 1;
            if (!b.t) return -1;
            return minutesOf(a.t.start) - minutesOf(b.t.start);
          });
          return { week: w, dayIdx: d, list: list };
        }
      }
    }
    return null;
  }

  // ---------- 本周课表快照图（canvas 绘制） ----------
  function drawWeekSnapshot() {
    var w = currentWeekObj();
    if (!w) return null;
    var W = 1000, timeW = 74, headerH = 150, rowH = 118;
    var H = headerH + 12 * rowH + 24;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    var colW = (W - timeW) / 7;
    var DAYS2 = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

    // 表头
    ctx.fillStyle = '#1c2733'; ctx.font = 'bold 36px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('第' + w.week + '周课表', 24, 50);
    var d0 = w.dates[0], d6 = w.dates[6];
    ctx.fillStyle = '#6b7a8c'; ctx.font = '22px sans-serif';
    ctx.fillText((d0 ? d0.date : '') + ' ~ ' + (d6 ? d6.date : ''), 24, 84);
    ctx.textAlign = 'center';
    for (var d = 0; d < 7; d++) {
      var hx = timeW + d * colW;
      var dt = w.dates[d];
      ctx.fillStyle = '#6b7a8c'; ctx.font = 'bold 24px sans-serif';
      ctx.fillText(DAYS2[d], hx + colW / 2, 40);
      ctx.fillStyle = '#1c2733'; ctx.font = '26px sans-serif';
      ctx.fillText(dt ? String(dt.day) : '', hx + colW / 2, 76);
      ctx.strokeStyle = '#e6eaf0'; ctx.beginPath();
      ctx.moveTo(hx, 0); ctx.lineTo(hx, H); ctx.stroke();
      if (d < 6) { ctx.beginPath(); ctx.moveTo(timeW + (d + 1) * colW, 0); ctx.lineTo(timeW + (d + 1) * colW, H); ctx.stroke(); }
    }

    // 节次列 + 横线 + 时段标签
    ctx.textAlign = 'center';
    for (var p = 1; p <= 12; p++) {
      var y = headerH + (p - 1) * rowH;
      if (p > 1) { ctx.strokeStyle = '#eef1f5'; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
      ctx.fillStyle = '#6b7a8c'; ctx.font = 'bold 20px sans-serif';
      ctx.fillText(String(p), timeW / 2, y + 26);
      ctx.font = '13px sans-serif';
      ctx.fillText(periodStart(p) || '', timeW / 2, y + 48);
      ctx.fillText(periodEnd(p) || '', timeW / 2, y + 66);
    }
    var slotY = { '上午': headerH + rowH / 2, '下午': headerH + 5 * rowH, '晚上': headerH + 9 * rowH };
    ctx.fillStyle = '#98a3b1'; ctx.font = '18px sans-serif';
    Object.keys(slotY).forEach(function (k) { ctx.fillText(k, timeW / 2, slotY[k]); });

    // 课程（只画每簇主卡，与 App 显示一致）
    var items = [];
    for (var dd = 0; dd < 7; dd++) {
      (w.days[dd] || []).forEach(function (c) {
        if (c.periods && isVisible(c)) items.push({ d: dd, c: c });
      });
    }
    items.sort(function (a, b) { return a.c.periods[0] - b.c.periods[0]; });
    var seenSlot = {};
    items.forEach(function (it) {
      var c = it.c;
      if (seenSlot[it.d + '@' + c.periods[0]]) return; // 同格只画第一门
      seenSlot[it.d + '@' + c.periods[0]] = true;
      var col = courseColor(c);
      var x = timeW + it.d * colW + 5;
      var y = headerH + (c.periods[0] - 1) * rowH + 5;
      var hh = (c.periods[1] - c.periods[0] + 1) * rowH - 10;
      var ww = colW - 10;
      ctx.fillStyle = col;
      ctx.beginPath();
      var r = 8;
      ctx.moveTo(x + r, y); ctx.arcTo(x + ww, y, x + ww, y + hh, r);
      ctx.arcTo(x + ww, y + hh, x, y + hh, r); ctx.arcTo(x, y + hh, x, y, r);
      ctx.arcTo(x, y, x + ww, y, r); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center';
      // 名称换行（每行 6 字，最多 3 行）
      var name = c.name + (c.className ? ' @' + c.className : '');
      var lines = [];
      for (var i = 0; i < name.length && lines.length < 3; i += 6) lines.push(name.slice(i, i + 6));
      var ly = y + hh / 2 - (lines.length - 1) * 12;
      if (c.location) ly -= 8;
      ctx.font = 'bold 20px sans-serif';
      lines.forEach(function (ln, li) { ctx.fillText(ln, x + ww / 2, ly + li * 24); });
      if (c.location) {
        ctx.font = '16px sans-serif';
        ctx.fillText(c.location.replace(/[（）/]/g, ''), x + ww / 2, y + hh - 16);
      }
    });

    // 底部生成时间
    ctx.fillStyle = '#98a3b1'; ctx.font = '18px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('生成时间 ' + todayStr() + ' · 天大福州', 16, H - 12);
    return cv;
  }

  // ---------- 设置 ----------
  function renderSettings() {
    // 顶部：显示最近一次腾讯文档真实截图
    var last = localStorage.getItem(LS + 'docsnap');
    if (last) {
      $('shotimg').hidden = false;
      $('shotimg').src = last;
      $('snapcap').textContent = '最近一次文档截图（已存入相册 Pictures/天大福州）';
    } else {
      $('shotimg').hidden = true;
      $('snapcap').textContent = '尚未截图，点下方「自动截图当周」获取';
    }

    // 打开腾讯文档原文（APK 走系统浏览器；网页版开新标签）
    $('opendoc2').onclick = function () {
      var url = 'https://docs.qq.com/sheet/' + state.docId + '?tab=000001';
      if (window.KebiaoAndroid && window.KebiaoAndroid.openBrowser) window.KebiaoAndroid.openBrowser(url);
      else window.open(url, '_blank');
    };

    // 自动截图当周（隐形 WebView 加载腾讯文档原生页面，真实截图）
    $('snapauto').onclick = function () {
      var row = weekRowFor(state.week);
      if (window.KebiaoAndroid) window.KebiaoAndroid.docSnapAuto(state.docId, String(row));
      else toast('自动截图需在 App 内使用（网页版请直接截取课表页或用系统截图）');
    };

    // 手动模式：打开文档原文（主 WebView + 浮动截图按钮）
    $('opendocsnap').onclick = function () {
      var row = weekRowFor(state.week);
      if (window.KebiaoAndroid) window.KebiaoAndroid.openDocSnap(state.docId, String(row));
      else toast('手动截图需在 App 内使用');
    };
    var catalog = {};
    if (state.data) {
      state.data.weeks.forEach(function (w) {
        w.days.forEach(function (arr) {
          arr.forEach(function (c) {
            var k = courseKey(c);
            if (!catalog[k]) catalog[k] = { name: c.name, className: c.className || '', count: 0 };
            catalog[k].count++;
          });
        });
      });
    }
    var keys = Object.keys(catalog).sort(function (a, b) { return catalog[a].name.localeCompare(catalog[b].name, 'zh'); });

    $('courselist').innerHTML = keys.map(function (k) {
      var it = catalog[k];
      var on = !!state.mine[k];
      var color = courseColor({ name: it.name, className: it.className });
      return '<label class="citem"><span class="dot" style="background:' + color + '"></span>' +
        '<span class="cname2">' + esc(it.name) + (it.className ? ' <span class="tag">@' + esc(it.className) + '</span>' : ' <span class="tag">公共</span>') + '</span>' +
        '<input type="checkbox" data-k="' + esc(k) + '" ' + (on ? 'checked' : '') + '></label>';
    }).join('');
    $('courselist').querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      cb.onchange = function () {
        var k = cb.getAttribute('data-k');
        if (cb.checked) state.mine[k] = true; else delete state.mine[k];
        saveSettings(); renderAll();
      };
    });

    $('remindon').checked = state.remindOn;
    $('remindlead').value = String(state.remindLead);
    $('icsallday').checked = state.icsAllday;
    if (window.KebiaoAndroid) {
      var vinfo = (window.KebiaoAndroid.getVersion() || '1|1').split('|');
      $('otastatus').textContent = '当前 UI v' + vinfo[0] + ' · APK v' + vinfo[1];
    } else {
      $('otastatus').textContent = '浏览器环境：更新页面文件后刷新即可，无需此功能';
    }
  }

  // 周次 → 腾讯文档内的起始行号（用于打开原文时自动定位）
  function weekRowFor(weekNo) {
    if (!state.data || !state.data.meta || !state.data.meta.weekRows) return 0;
    var m = state.data.meta.weekRows.find(function (x) { return x.week === weekNo; });
    return m ? m.row : 0;
  }

  function renderDataStatus() {
    var srcName = { snapshot: '内嵌快照', api: '本地服务器', cache: '历史缓存' }[dataSource] || '无';
    if (!state.data) { $('datastatus').textContent = '尚未获取到数据'; return; }
    var age = Math.round((Date.now() - state.dataTs) / 60000);
    $('datastatus').textContent = '来源：' + srcName + ' · ' + state.data.weeks.length + ' 个周块 · ' +
      state.data.classes.length + ' 个班级 · 更新于 ' + (age < 1 ? '刚刚' : age + ' 分钟前') +
      (state.data.meta && state.data.meta.firstWeekMonday ? ' · 第一周周一 ' + state.data.meta.firstWeekMonday : '');
  }

  // ---------- 弹层 ----------
  function openModal(html, toggleText, onToggle) {
    $('modal-body').innerHTML = html;
    var btn = $('modal-toggle');
    btn.textContent = toggleText;
    btn.style.display = onToggle ? '' : 'none';
    btn.onclick = function () { onToggle(); };
    $('modal').hidden = false;
  }
  function closeModal() { $('modal').hidden = true; }

  function showCourseModal(c, dayIdx, w) {
    var t = courseTimes(c);
    var inMine = !!state.mine[courseKey(c)];
    var dt = w.dates[dayIdx];
    var col = courseColor(c);
    openModal(
      '<h4 style="color:' + col + '">' + esc(c.name) + '</h4>' +
      '<div class="meta">时间：' + DAY_NAMES[dayIdx] + (dt ? ' ' + dt.date : '') + (c.slot ? ' ' + c.slot : '') +
      (t ? ' ' + t.start + '-' + t.end : '') + (c.periods ? '（第' + c.periods[0] + '-' + c.periods[1] + '节）' : '') + '</div>' +
      (c.location ? '<div class="meta">地点：' + esc(c.location) + '</div>' : '') +
      (c.teacher ? '<div class="meta">教师：' + esc(c.teacher) + '</div>' : '') +
      (c.className ? '<div class="meta">班级：' + esc(c.className) + '</div>' : '') +
      (c.extra.length ? '<div class="meta">备注：' + esc(c.extra.join('；')) + '</div>' : ''),
      inMine ? '从我的课程移除' : '加入我的课程',
      function () {
        if (state.mine[courseKey(c)]) delete state.mine[courseKey(c)];
        else state.mine[courseKey(c)] = true;
        saveSettings(); closeModal(); renderAll();
      }
    );
  }
  function showEventModal(c) {
    openModal('<h4>' + esc(c.name) + '</h4>' +
      '<div class="meta">' + (c.extra.length ? esc(c.extra.join('；')) : '全天事件') + '</div>',
      '', null);
  }

  // ---------- ICS 导出 ----------
  function icsEscape(s) {
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }
  function toUtcLine(dateStr, hm, isEnd) {
    var d = dateStr.split('-');
    var t = (hm || '00:00').split(':');
    var local = new Date(+d[0], +d[1] - 1, +d[2], +t[0], +t[1]);
    return local.getUTCFullYear() + pad2(local.getUTCMonth() + 1) + pad2(local.getUTCDate()) +
      'T' + pad2(local.getUTCHours()) + pad2(local.getUTCMinutes()) + '00Z';
  }
  function stampNow() {
    var n = new Date();
    return n.getUTCFullYear() + pad2(n.getUTCMonth() + 1) + pad2(n.getUTCDate()) + 'T' +
      pad2(n.getUTCHours()) + pad2(n.getUTCMinutes()) + pad2(n.getUTCSeconds()) + 'Z';
  }

  function buildIcs() {
    if (!state.data) return null;
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//grade-schedule//CN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:' + icsEscape('年级课表'), 'X-WR-TIMEZONE:Asia/Shanghai'];
    var n = 0;
    state.data.weeks.forEach(function (w) {
      for (var d = 0; d < 7; d++) {
        (w.days[d] || []).forEach(function (c) {
          if (!isVisible(c)) return;
          var dt = w.dates[d] && w.dates[d].date;
          if (!dt) return;
          var t = courseTimes(c);
          var desc = [c.teacher ? '教师: ' + c.teacher : '', c.className ? '班级: ' + c.className : '', c.extra.join(' / ')].filter(Boolean).join('\\n');
          if (t) {
            lines.push('BEGIN:VEVENT',
              'UID:gs-' + w.week + '-' + d + '-' + n + '@grade-schedule',
              'DTSTAMP:' + stampNow(),
              'DTSTART:' + toUtcLine(dt, t.start),
              'DTEND:' + toUtcLine(dt, t.end),
              'SUMMARY:' + icsEscape(c.name + (c.className ? ' @' + c.className : '')),
              c.location ? 'LOCATION:' + icsEscape(c.location) : 'LOCATION:',
              desc ? 'DESCRIPTION:' + desc : 'DESCRIPTION:',
              'BEGIN:VALARM', 'TRIGGER:-PT' + state.remindLead + 'M', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEscape(c.name + ' 15分钟后上课'), 'END:VALARM',
              'END:VEVENT');
          } else if (state.icsAllday) {
            var dd = dt.split('-');
            var nd = new Date(+dd[0], +dd[1] - 1, +dd[2] + 1);
            var nds = nd.getFullYear() + pad2(nd.getMonth() + 1) + pad2(nd.getDate());
            lines.push('BEGIN:VEVENT',
              'UID:gs-' + w.week + '-' + d + '-' + n + 'd@grade-schedule',
              'DTSTAMP:' + stampNow(),
              'DTSTART;VALUE=DATE:' + dt.replace(/-/g, ''),
              'DTEND;VALUE=DATE:' + nds,
              'SUMMARY:' + icsEscape(c.name),
              'DESCRIPTION:' + (desc || icsEscape('全天事件')),
              'END:VEVENT');
          }
          n++;
        });
      }
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  function exportIcs() {
    var ics = buildIcs();
    if (!ics) { toast('暂无数据'); return; }
    var blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.mode === 'mine' ? '我的课程' : '年级课表') + '.ics';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  // ---------- 提醒 ----------
  function toast(msg, ms) {
    var b = $('banner');
    b.textContent = msg;
    b.hidden = false;
    clearTimeout(b._t);
    b._t = setTimeout(function () { b.hidden = true; }, ms || 6000);
  }

  function checkReminders() {
    if (!state.remindOn || !state.data) return;
    var tc = todayCourses();
    var now = new Date();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    tc.list.forEach(function (it) {
      if (!it.t) return;
      var k = todayStr() + '@' + courseKey(it.c) + '@' + it.t.start;
      if (state.notified[k]) return;
      var s = minutesOf(it.t.start);
      if (nowMin >= s - state.remindLead && nowMin <= s + 5) {
        state.notified[k] = true;
        var msg = it.c.name + ' ' + it.t.start + ' 上课' + (it.c.location ? ' @' + it.c.location : '');
        toast('⏰ ' + msg, 15000);
        if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
        if (window.Notification && Notification.permission === 'granted') {
          try { new Notification('上课提醒', { body: msg }); } catch (e) { /* noop */ }
        }
      }
    });
  }

  // ---------- 事件绑定 ----------
  function bind() {
    document.querySelectorAll('#tabbar .tab').forEach(function (b) {
      b.onclick = function () {
        document.querySelectorAll('#tabbar .tab').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        state.tab = b.getAttribute('data-tab');
        ['timetable', 'today', 'settings'].forEach(function (t) {
          $('view-' + t).hidden = t !== state.tab;
        });
        $('topbar-title').hidden = state.tab === 'timetable' || state.tab === 'today';
        $('weeknav').hidden = state.tab !== 'timetable';
        $('todaynav').hidden = state.tab !== 'today';
        $('main').classList.toggle('fit', state.tab === 'timetable');
        if (state.tab === 'today') { renderTodayNav(); renderToday(); }
        // 点「课表」「今天」页签 = 一次隐式刷新（带冷却）；离开课表页时停轮播
        if (cycTimer) { clearInterval(cycTimer); cycTimer = null; }
        if (state.tab === 'timetable') renderTimetable();
        if (state.tab === 'timetable' || state.tab === 'today') {
          window.__doRefresh && window.__doRefresh(false);
        }
      };
    });
    // fzuhelper 风格：标题切换课程模式（课表页/今天页共用菜单）+ 周次切换
    $('pagetitle').onclick = function () {
      if ($('modemenu').hidden) showModePicker('pagetitle'); else hideModePicker();
    };
    $('pagetitle2').onclick = function () {
      if ($('modemenu').hidden) showModePicker('pagetitle2'); else hideModePicker();
    };
    $('modemenu').querySelector('.mm-mask').onclick = hideModePicker;
    $('weeklabel').onclick = showWeekPicker;
    $('prevweek').onclick = function () {
      if (!state.data) return;
      var i = state.data.weeks.findIndex(function (x) { return x.week === state.week; });
      if (i > 0) { slideDir = -1; state.week = state.data.weeks[i - 1].week; renderWeekNav(); renderTimetable(); }
    };
    $('nextweek').onclick = function () {
      if (!state.data) return;
      var i = state.data.weeks.findIndex(function (x) { return x.week === state.week; });
      if (i < state.data.weeks.length - 1) { slideDir = 1; state.week = state.data.weeks[i + 1].week; renderWeekNav(); renderTimetable(); }
    };
    // 今天页顶栏日期切换（箭头步进 / 点标签弹日期列表）
    $('daylabel').onclick = showDayPicker;
    $('prevday').onclick = function () {
      if ((state.todayOffset || 0) > -2) { state.todayOffset = (state.todayOffset || 0) - 1; renderTodayNav(); renderToday(); }
    };
    $('nextday').onclick = function () {
      if ((state.todayOffset || 0) < 2) { state.todayOffset = (state.todayOffset || 0) + 1; renderTodayNav(); renderToday(); }
    };
    // 回位按钮：课表回本周 / 今天页回本天
    $('backtoday-week').onclick = function () {
      var loc = findTodayLocation();
      if (loc) { slideDir = loc.week.week > state.week ? 1 : -1; state.week = loc.week.week; renderWeekNav(); renderTimetable(); }
    };
    $('backtoday-day').onclick = function () {
      state.todayOffset = 0; renderTodayNav(); renderToday();
    };
    $('modal-close').onclick = closeModal;
    document.querySelector('.modal-mask').onclick = closeModal;
    $('exportics').onclick = exportIcs;
    $('remindon').onchange = function () {
      state.remindOn = $('remindon').checked;
      saveSettings();
      if (state.remindOn && window.Notification && Notification.permission !== 'granted') {
        Notification.requestPermission();
      }
    };
    $('remindlead').onchange = function () { state.remindLead = +$('remindlead').value; saveSettings(); };
    $('icsallday').onchange = function () { state.icsAllday = $('icsallday').checked; saveSettings(); };
    $('testnotify').onclick = function () {
      if (window.Notification && Notification.permission !== 'granted') {
        Notification.requestPermission().then(function (p) { toast(p === 'granted' ? '通知已授权' : '通知被拒绝，仅应用内提醒'); });
      } else {
        toast('✅ 通知通道正常', 3000);
      }
    };
    $('selall').onclick = function () {
      if (!state.data) return;
      state.data.weeks.forEach(function (w) { w.days.forEach(function (arr) { arr.forEach(function (c) { state.mine[courseKey(c)] = true; }); }); });
      saveSettings(); renderAll();
    };
    $('selnone').onclick = function () { state.mine = {}; saveSettings(); renderAll(); };
    // ---------- 在线更新（书签脚本 / APK 一键） ----------
    // 打开腾讯文档原文（APK 走系统浏览器；网页版开新标签）
    $('opendoc2').onclick = function () {
      var url = 'https://docs.qq.com/sheet/' + state.docId + '?tab=000001';
      if (window.KebiaoAndroid && window.KebiaoAndroid.openBrowser) window.KebiaoAndroid.openBrowser(url);
      else window.open(url, '_blank');
    };
    $('copybm').onclick = function () {
      var bm = buildBookmarklet();
      copyText(bm).then(function (ok) {
        toast(ok ? '书签脚本已复制，去腾讯文档页面执行' : '复制失败，请手动复制文本框内容', 6000);
        if (!ok) {
          var ta = $('importbox');
          ta.value = bm;
          ta.focus(); ta.select();
        }
      });
    };
    $('importbtn').onclick = function () {
      var raw = $('importbox').value.trim();
      if (!raw) { toast('请先粘贴书签脚本复制的内容'); return; }
      importPayloadText(raw);
    };
    // ---------- 软件在线更新（OTA，内置更新源） ----------
    $('otacheck').onclick = function () {
      if (!window.KebiaoAndroid) { toast('请在 App 内使用在线更新（浏览器直接刷新页面即可）'); return; }
      window.KebiaoAndroid.otaCheck(OTA_URL);
    };
  }

  // ---------- 导入载荷（书签粘贴 / APK 原生桥共用），返回 Promise ----------
  function importPayloadText(raw) {
    var payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      var m = raw.match(/^[^(]*\((.*)\)\s*;?\s*$/s);
      try { payload = JSON.parse(m ? m[1] : raw); } catch (e2) { toast('内容不是有效 JSON'); return Promise.resolve(false); }
    }
    if (!payload || !payload.blocks) { toast('内容格式不对（需要抓取导出的载荷）'); return Promise.resolve(false); }
    toast('正在解析…', 4000);
    return ScheduleCore.importPayload(payload).then(function (sched) {
      applyData(sched, 'snapshot');
      state.dataTs = Date.now();
      saveDataCache();
      toast('导入成功：' + sched.weeks.length + ' 个周块', 2500);
      $('importbox').value = '';
      return true;
    }).catch(function (e) {
      toast('解析失败：' + e.message, 8000);
      return false;
    });
  }

  // APK 原生桥回传：成功导入后闭环下拉刷新
  window.__autoImport = function (raw) {
    if (typeof raw !== 'string' || !raw.trim()) return;
    importPayloadText(raw.trim()).then(function () {
      if (pendingRefreshResolve) { var r = pendingRefreshResolve; pendingRefreshResolve = null; r(true); }
    });
  };

  // APK 原生桥回传：失败闭环
  window.__refreshFail = function (msg) {
    if (pendingRefreshResolve) { var r = pendingRefreshResolve; pendingRefreshResolve = null; r(false); }
    if (msg) toast('刷新失败：' + msg, 6000);
  };

  // OTA 状态回调（App 原生）
  window.__otaStatus = function (type, msg) {
    var st = $('otastatus');
    if (type === 'checking') { st.textContent = '正在检查更新…'; return; }
    if (type === 'downloading') { st.textContent = '正在下载更新（' + msg + '）…'; return; }
    if (type === 'latest') { st.textContent = '当前已是最新（UI v' + msg + '）'; return; }
    if (type === 'done') { toast('软件已更新到 v' + msg + '，即将重载'); st.textContent = '已更新到 v' + msg; return; }
    if (type === 'apk-perm') { toast('请先在系统设置中允许本应用安装未知应用，然后再次检查更新', 8000); st.textContent = '需要安装权限'; return; }
    if (type === 'apk-confirm') { toast('已下载新版 APK，请在系统弹窗中确认安装', 8000); st.textContent = '已拉起安装'; return; }
    if (type === 'fail') { toast('更新失败：' + msg, 8000); st.textContent = '更新失败：' + msg; return; }
  };

  // ---------- 书签脚本 ----------
  function bookmarkletBody() {
    // 在 docs.qq.com 页面内执行：同源 JSONP/fetch 拉全部分块，精简后复制到剪贴板
    return '(async()=>{try{' +
      'var m=location.pathname.match(/sheet\\/([A-Za-z0-9]+)/);if(!m){alert("请先打开腾讯文档表格页");return;}' +
      'var ID=m[1],TAB=(location.search.match(/tab=([0-9a-fA-F]+)/)||[0,"000001"])[1];' +
      'var cb="gsbk"+Date.now();' +
      'var jsonp=function(u){return new Promise(function(res,rej){window[cb]=function(d){res(d);delete window[cb];};var s=document.createElement("script");s.src=u+"&callback="+cb;s.onerror=function(){rej(new Error("加载失败"))};document.head.appendChild(s);});};' +
      'alert("① 正在拉取数据，请稍候…");' +
      'var od=await jsonp("/dop-api/opendoc?tab="+TAB+"&u=&noEscape=1&enableSmartsheetSplit=1&startrow=0&endrow=60&needSheetState=1&sliceStates=1&block_end_col=63&block_end_row=255&block_start_col=0&block_start_row=0&id="+ID+"&normal=1&outformat=1&wb=1&nowb=0&xsrf=");' +
      'var cv=od.clientVars.collab_client_vars;var maxRow=cv.maxRow,padId=cv.globalPadId,rev=cv.rev;' +
      'var blocks=cv.initialAttributedText.text.map(function(t){return{max_row:t.max_row,max_col:t.max_col,b:t.block_datas.map(function(x){return x.related_sheet;})};});' +
      'var covered=255;' +
      'while(covered<maxRow){var start=covered+1,end=Math.min(covered+256,maxRow+1);' +
      'var r=await fetch("/dop-api/get/sheet?padId="+encodeURIComponent(padId)+"&subId="+TAB+"&startrow="+start+"&xsrf=&outformat=1&normal=1&preview_token=&nowb=1&endrow="+end+"&needSheetState=2&sliceStates=1&block_end_col=63&block_end_row="+end+"&block_start_col=0&block_start_row="+start+"&rev="+rev,{credentials:"include"});' +
      'var j=await r.json();var iat=(j.data&&j.data.initialAttributedText)||j.initialAttributedText;' +
      'if(iat)blocks=blocks.concat(iat.text.map(function(t){return{max_row:t.max_row,max_col:t.max_col,b:t.block_datas.map(function(x){return x.related_sheet;})};}));' +
      'covered=end-1;}' +
      'var payload=JSON.stringify({v:1,doc:ID,blocks:blocks});' +
      'var done=function(){alert("② 已复制 "+payload.length+" 字符。请回到课表App粘贴导入。");};' +
      'try{await navigator.clipboard.writeText(payload);done();}' +
      'catch(e){var ta=document.createElement("textarea");ta.value=payload;document.body.appendChild(ta);ta.select();document.execCommand("copy");ta.remove();done();}' +
      '}catch(e){alert("失败："+e.message)}})();';
  }
  function buildBookmarklet() {
    return 'javascript:' + encodeURIComponent(bookmarkletBody());
  }
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).then(function () { return true; }).catch(function () { return false; });
    }
    return Promise.resolve(false);
  }

  // ---------- 下拉刷新 ----------
  function setupPullToRefresh() {
    var main = $('main');
    var ind = document.createElement('div');
    ind.id = 'pullind';
    ind.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg><span>下拉刷新</span>';
    document.body.appendChild(ind);
    var svg = ind.querySelector('svg');
    var label = ind.querySelector('span');
    var startY = 0, startX = 0, pulling = false, armed = false, ready = false, safety = null, lastRefreshAt = 0;

    var hideInd = function () {
      ind.style.opacity = 0; ind.style.transform = 'translateY(0)'; svg.style.transform = '';
    };
    var onStart = function (x, y) {
      armed = false;
      if (main.scrollTop > 0 || ind.classList.contains('busy')) { pulling = false; return; }
      startX = x; startY = y; pulling = true; ready = false;
    };
    var onMove = function (x, y) {
      if (!pulling) return;
      var dx = x - startX, dy = y - startY;
      if (!armed) {
        // 防误触裁决：纵向明显占优才进入下拉状态（横滑/斜滑不触发）
        if (dy > 12 && Math.abs(dy) > Math.abs(dx) * 1.2) armed = true;
        else if (dy < -10 || Math.abs(dx) > 55) { pulling = false; hideInd(); return; }
        else return;
      }
      if (dy < -10) { pulling = false; armed = false; hideInd(); return; } // 反向推走，交还滚动
      if (dy <= 0) { hideInd(); ready = false; return; }
      var d = Math.min(dy * 0.45, 90); // 阻尼
      ind.style.opacity = Math.min(1, d / 42);
      ind.style.transform = 'translateY(' + d + 'px)';
      svg.style.transform = 'rotate(' + (d / 60) * 180 + 'deg)';
      ready = d >= 56;
      label.textContent = ready ? '释放刷新' : '下拉刷新';
      ind.classList.toggle('ready', ready);
    };
    var onEnd = function () {
      if (!pulling) return;
      pulling = false;
      var go = ready;
      ready = false;
      armed = false;
      hideInd();
      if (go) doRefresh(true);
    };

    // 触摸：touchmove 非被动 + 确认下拉后 preventDefault，顶住浏览器接管手势
    main.addEventListener('touchstart', function (e) {
      if (e.touches.length) onStart(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    main.addEventListener('touchmove', function (e) {
      if (!pulling || !e.touches.length) return;
      if (armed && e.cancelable) e.preventDefault();
      onMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    main.addEventListener('touchend', onEnd);
    main.addEventListener('touchcancel', onEnd);

    // 鼠标（桌面/测试环境）
    main.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') return;
      onStart(e.clientX, e.clientY);
    });
    window.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch') return;
      onMove(e.clientX, e.clientY);
    });
    window.addEventListener('pointerup', function (e) {
      if (e.pointerType === 'touch') return;
      onEnd();
    });

    function doRefresh(fromGesture) {
      var now = Date.now();
      // 非手势触发（点页签等）15 秒冷却，防止频繁抓取
      if (!fromGesture && now - lastRefreshAt < 15000) return;
      lastRefreshAt = now;
      ind.classList.add('busy');
      ind.classList.remove('ready');
      ind.style.opacity = 1;
      ind.style.transform = 'translateY(50px)';
      svg.style.transform = '';
      label.textContent = '正在刷新…';
      var ts0 = state.dataTs;
      // 兜底：任何异常 45 秒后强制复位，避免指示器永久卡住
      safety = setTimeout(function () {
        if (ind.classList.contains('busy')) {
          pendingRefreshResolve = null;
          label.textContent = '刷新失败';
          setTimeout(reset, 800);
        }
      }, 45000);
      fetchSchedule(true).then(function (ok) {
        if (ok === false) label.textContent = '刷新失败';
        else label.textContent = state.dataTs !== ts0 ? '已更新' : '当前已是最新';
        setTimeout(reset, 900);
      }).catch(function () {
        label.textContent = '刷新失败';
        setTimeout(reset, 1200);
      });
    }
    function reset() {
      clearTimeout(safety);
      ind.classList.remove('busy');
      ind.style.opacity = 0;
      ind.style.transform = 'translateY(0)';
      svg.style.transform = '';
    }
    // 暴露给页签点击等隐式刷新入口（带冷却）
    window.__doRefresh = doRefresh;
  }

  // ---------- 左右滑动切换（课表页=切周，今天页=切天；touch 事件；鼠标走 pointer） ----------
  function setupWeekSwipe() {
    var main = $('main');
    var x0 = 0, y0 = 0, on = false, consumed = false;
    var check = function (x, y) {
      if (!on || consumed) return;
      var dx = x - x0, dy = y - y0;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        consumed = true;
        if (state.tab === 'timetable') {
          if (dx < 0) $('nextweek').click(); else $('prevweek').click();
        } else if (state.tab === 'today') {
          if (dx < 0) $('nextday').click(); else $('prevday').click();
        }
      }
    };
    var end = function () { on = false; consumed = false; };
    main.addEventListener('touchstart', function (e) {
      if (!e.touches.length) return;
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; on = true; consumed = false;
    }, { passive: true });
    main.addEventListener('touchmove', function (e) {
      if (e.touches.length) check(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    main.addEventListener('touchend', end);
    main.addEventListener('touchcancel', end);
    main.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') return;
      x0 = e.clientX; y0 = e.clientY; on = true; consumed = false;
    });
    window.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch') return;
      check(e.clientX, e.clientY);
    });
    window.addEventListener('pointerup', function (e) {
      if (e.pointerType === 'touch') return;
      end();
    });
  }

  // ---------- 启动 ----------
  window.__buildIcs = buildIcs; // 调试/测试钩子
  setupPullToRefresh();
  setupWeekSwipe();
  loadSettings();
  bind();
  if (state.data) { renderAll(); }
  fetchSchedule(false).catch(function (e) {
    if (!state.data) toast('数据加载失败：' + e.message, 10000);
  });
  setInterval(function () {
    if (state.tab === 'today') renderToday();
    if (state.tab === 'timetable') renderTimetable(); // 刷新当前节次高亮
    checkReminders();
  }, 20000);
  checkReminders();
})();
