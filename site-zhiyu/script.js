/* 智语官网 · 活桌与绕桌镜头。零依赖；prefers-reduced-motion / 窄屏自动静置。 */
(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('js');

  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var narrow = matchMedia('(max-width: 860px)');
  var stage = document.getElementById('stage');

  /* ---------- 首屏文字（H1/CTA/释义/示意回合）只属于第一屏 ---------- */
  var ticking = false;
  var syncPast = function () {
    ticking = false;
    stage.classList.toggle('past-hero', window.scrollY > innerHeight * 0.45);
  };
  addEventListener('scroll', function () {
    if (!ticking) { ticking = true; requestAnimationFrame(syncPast); }
  }, { passive: true });
  syncPast();

  /* ---------- 绕桌镜头：章节进中视区，桌面转向那一席 ---------- */
  var FOCUS_DEG = { agent: 60, guest: -60, door: -120, center: 0, host: 0, duty: -24, demo: 24 };
  var applyFocus = function (name) {
    if (narrow.matches || reduce) name = 'center';
    stage.dataset.focus = name;
    stage.style.setProperty('--theta', (FOCUS_DEG[name] || 0) + 'deg');
    stage.classList.toggle('dimmed', name === 'duty' || name === 'demo');
    /* 镜头正对分身席时值守弧自亮：弧是这一段的主角，不依赖鼠标能否落到席上 */
    var arcEl = document.getElementById('duty-arc');
    if (arcEl) arcEl.classList.toggle('auto-lit', name === 'agent');
  };

  if ('IntersectionObserver' in window && !reduce) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) applyFocus(e.target.dataset.focus);
      });
    }, { rootMargin: '-42% 0px -42% 0px' });
    document.querySelectorAll('.chapter').forEach(function (el) { io.observe(el); });

    document.querySelectorAll('.topnav a[href^="#"]').forEach(function (a) {
      a.addEventListener('click', function () {
        var t = document.querySelector(a.getAttribute('href'));
        if (t && t.dataset.focus) applyFocus(t.dataset.focus);
      });
    });

    var onNarrow = function () { applyFocus(stage.dataset.focus || 'center'); };
    if (narrow.addEventListener) narrow.addEventListener('change', onNarrow);
    else if (narrow.addListener) narrow.addListener(onNarrow);
  }

  /* ---------- 值守弧：hover/聚焦 分身席或主办席，亮起主人弧 ---------- */
  var arc = document.getElementById('duty-arc');
  if (arc) {
    ['seat-agent', 'seat-host'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var on = function () { arc.classList.add('lit'); };
      var off = function () { arc.classList.remove('lit'); };
      el.addEventListener('mouseenter', on);
      el.addEventListener('mouseleave', off);
      el.addEventListener('focus', on);
      el.addEventListener('blur', off);
    });
  }

  /* ---------- 发言亮环：一次编排的回合循环（本页唯一环境动效） ---------- */
  var pulse = document.getElementById('pulse');
  var txSeat = document.getElementById('txSeat');
  var txText = document.getElementById('txText');
  var STEPS = [
    { seat: 'guest', name: '访客 · A3F2', text: '「你们在吗？想问下发货规则。」', dwell: 2600, travel: 1300 },
    { seat: 'agent', name: '值守分身', text: '「在。发货规则我直接答你——」', dwell: 3200, travel: 1300 },
    { seat: 'host', name: '主办 · 人', text: '（离线 · 分身代守，随时可召回）', dwell: 2400, travel: 1300 },
    { seat: 'guest', name: '访客 · A3F2', text: '「明白，先这样。」', dwell: 2000, travel: 1300 }
  ];
  var SEAT_DEG = { guest: 150, agent: 30, host: -90 };
  var R = 250;
  var posOn = function (deg) {
    var r = deg * Math.PI / 180;
    return [400 + R * Math.cos(r), 400 + R * Math.sin(r)];
  };
  var easeInOut = function (t) { return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; };

  if (!reduce && pulse && txSeat && txText) {
    var ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    ring.setAttribute('class', 'pulse-ring');
    ring.setAttribute('cx', '400'); ring.setAttribute('cy', '150');
    pulse.parentNode.insertBefore(ring, pulse);

    var i = 0, phase = 'dwell', t0 = performance.now();
    var fromDeg = SEAT_DEG.guest;
    var stageVisible = true;
    var at = function (deg) { return posOn(deg); };
    var place = function (el, p) { el.setAttribute('cx', p[0]); el.setAttribute('cy', p[1]); };
    var setTx = function (s) {
      txSeat.textContent = s.name;
      txSeat.dataset.seat = s.seat;
      txText.textContent = s.text;
    };

    setTx(STEPS[0]);
    place(pulse, at(SEAT_DEG[STEPS[0].seat]));
    place(ring, at(SEAT_DEG[STEPS[0].seat]));
    pulse.classList.add('on');

    var frame = function (now) {
      if (stageVisible && !document.hidden) {
        var step = STEPS[i];
        if (phase === 'dwell') {
          if (now - t0 >= step.dwell) {
            var next = (i + 1) % STEPS.length;
            fromDeg = SEAT_DEG[step.seat];
            i = next;
            phase = 'travel'; t0 = now;
          }
        } else {
          var t = Math.min(1, (now - t0) / step.travel);
          var delta = ((SEAT_DEG[step.seat] - fromDeg + 540) % 360) - 180;
          var p = at(fromDeg + delta * easeInOut(t));
          place(pulse, p); place(ring, p);
          if (t >= 1) { phase = 'dwell'; t0 = now; setTx(step); }
        }
        /* 落席脉冲环：每次抵达扩散一次，不是无限呼吸 */
        var el2 = STEPS[i];
        if (phase === 'dwell') {
          var k = Math.min(1, (now - t0) / 900);
          place(ring, at(SEAT_DEG[el2.seat]));
          ring.setAttribute('r', String(14 + 22 * k));
          ring.style.opacity = String(0.7 * (1 - k));
        }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { stageVisible = es[0].isIntersecting; }, { threshold: 0 }).observe(stage);
    }
  }

  /* ---------- 入场：面板按左右方向落位，值守行次第浮现 ---------- */
  var entrance = document.querySelectorAll('.panel, .duty-row');
  if ('IntersectionObserver' in window && !reduce) {
    var rev = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); rev.unobserve(e.target); }
      });
    }, { threshold: 0.15 });
    entrance.forEach(function (el) { rev.observe(el); });
  } else {
    entrance.forEach(function (el) { el.classList.add('in'); });
  }

  /* ---------- 活演示：真房间以 iframe 内嵌在本节 ---------- */
  /* 用 /zhiyu/embed 直嵌而非浮标 widget.js：浮标是 position:fixed 全局覆盖，
     且白底硬编码，与本页暗夜世界冲突；iframe 落在 room-shell 里，
     「这一页本身就是一间房」这句话才立得住。 */
  var room = document.getElementById('liveRoom');
  if (room) {
    var token = room.getAttribute('data-room');
    if (token) {
      var note = document.getElementById('synNote');
      if (note) note.remove();
      var syn = document.getElementById('synDialog');
      if (syn) syn.remove();
      var f = document.createElement('iframe');
      f.src = 'https://platform.finddatatech.cloud/zhiyu/embed/' + encodeURIComponent(token);
      f.title = '智语 · 现场演示房间';
      f.loading = 'lazy';
      f.setAttribute('allow', 'clipboard-write');
      room.appendChild(f);
    }
  }
})();
