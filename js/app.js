/*
 * app.js — 餐饮后厨 界面与交互
 * 纯原生 JS，无框架。性能策略：
 *   1. 表格输入/选择事件只更新 store + 局部 DOM，禁止整表重渲（防止键盘消失）
 *   2. 长列表分块渲染（chunkTable），滚动到临近底部再追加
 *   3. 页面切换使用 CSS transform 硬件加速（tab-track translate3d）
 *   4. localStorage 读写经 store.js 防抖 + 缓存
 */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var uid = function () { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); };

  var ALL_SEASONS = ['春', '夏', '秋', '冬'];
  var ALL_MONTHS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

  var LIB_SORT_OPTIONS = [
    { key: 'default', label: '默认顺序' },
    { key: 'name-asc', label: '名称 A→Z' },
    { key: 'name-desc', label: '名称 Z→A' },
    { key: 'price-asc', label: '价格 低→高' },
    { key: 'price-desc', label: '价格 高→低' },
    { key: 'category', label: '按种类' }
  ];

  // 原料库「显示列」配置（单位列跟随单价列显隐）
  var LIB_COLS = [
    { key: 'common', label: '常用' },
    { key: 'name', label: '名称' },
    { key: 'price', label: '单价' },
    { key: 'category', label: '种类' },
    { key: 'season', label: '季节' },
    { key: 'month', label: '月份' }
  ];
  var DEFAULT_LIB_COLS = ['common', 'name', 'price', 'category'];

  var State = {
    tabIndex: 0,
    catalog: { cat: '全部', search: '' },
    library: { cat: '全部', season: '全部', month: '全部', search: '' },
    ordersDate: null,
    ordersOid: null,
    ordersEditMode: false,
    editorId: null,
    searchFrom: null,
    libraryEditMode: false,
    libSelectedIds: {},
    librarySort: 'default',
    libScrollPos: 0,
    libRowOffset: 0
  };

  var track, searchOverlay, editorPanel;

  // ============ 工具 ============
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtMoney(n) { return '¥' + (typeof n === 'number' ? n.toFixed(2) : '0.00'); }

  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }

  // 原料库移动：轻点=移动一格；按住=连续移动。
  // 关键修复（之前「松手后一直移动停不下来 / 点完成没反应 / 切页面仍显示原料库」）：
  // 1) 按住期间只做「相邻两行轻量 DOM 交换」，不重建整表、不销毁被按住的按钮，
  //    保证按钮的 pointer 事件持续有效，松手一定能收到停止信号。
  // 2) 用 Pointer 事件 + 失焦/页面隐藏 多重停止信号；即使某浏览器不派发 touchend 也能停止。
  // 3) 安全兜底：连续移动超过上限自动停止，绝不卡死。
  var holdTimer = null, holdInterval = null, holdCount = 0;
  var HOLD_MAX = 80; // 连续移动上限（约 80 格），兜底防卡死

  function libIsFiltered() {
    var f = State.library;
    return (f.cat && f.cat !== '全部') || (f.season && f.season !== '全部') ||
      (f.month && f.month !== '全部') || (f.search || '').trim() ||
      (State.librarySort && State.librarySort !== 'default');
  }

  function stopHold() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (holdInterval) { clearInterval(holdInterval); holdInterval = null; }
    holdCount = 0;
    document.removeEventListener('pointerup', stopHold, true);
    document.removeEventListener('pointercancel', stopHold, true);
    document.removeEventListener('blur', stopHold);
    document.removeEventListener('visibilitychange', stopHold);
  }

  function startHold(btn, id, dir) {
    if (!btn) return;
    stopHold();
    moveProduct(id, dir, true); // 立即移动一格（轻量交换，不重建整表）
    holdTimer = setTimeout(function () {
      holdTimer = null;
      holdCount = 0;
      holdInterval = setInterval(function () {
        holdCount++;
        moveProduct(id, dir, true);
        if (holdCount >= HOLD_MAX) stopHold(); // 安全兜底
      }, 170);
    }, 350);
    // 全局停止信号：松手 / 取消 / 失焦 / 切后台 都能停
    document.addEventListener('pointerup', stopHold, true);
    document.addEventListener('pointercancel', stopHold, true);
    document.addEventListener('blur', stopHold);
    document.addEventListener('visibilitychange', stopHold);
    // 被按住按钮自身松手：停止并归一化一次（整表重渲染，清理状态）
    var finalize = function () {
      btn.removeEventListener('pointerup', finalize);
      btn.removeEventListener('pointercancel', finalize);
      btn.removeEventListener('lostpointercapture', finalize);
      stopHold();
      renderLibrary();
    };
    btn.addEventListener('pointerup', finalize);
    btn.addEventListener('pointercancel', finalize);
    btn.addEventListener('lostpointercapture', finalize);
  }

  function bindLongPress(el, ms, cb) {
    var timer = null;
    function start() { timer = setTimeout(function () { timer = null; cb(); }, ms); }
    function cancel() { if (timer) { clearTimeout(timer); timer = null; } }
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchend', cancel);
    el.addEventListener('touchmove', cancel);
    el.addEventListener('mousedown', start);
    el.addEventListener('mouseup', cancel);
    el.addEventListener('mouseleave', cancel);
  }

  // 让获得焦点的输入框自动滚入可视区（键盘上下箭头切换时也能看到当前行）
  function ensureVisible(el) {
    setTimeout(function () {
      var sc = el.closest('.list-scroll');
      if (!sc) { try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {} return; }
      var r = el.getBoundingClientRect();
      var cr = sc.getBoundingClientRect();
      if (r.top < cr.top + 4 || r.bottom > cr.bottom - 4) {
        // 不在可视区域时，滚动使其居中
        sc.scrollTop += (r.top + r.height / 2) - (cr.top + cr.height / 2);
      }
    }, 120);
  }

  // ============ 主题 ============
  function applyTheme() {
    var s = Store.getSettings();
    document.documentElement.style.setProperty('--theme', s.themeColor || '#FF2442');
    document.documentElement.style.setProperty('--font', (s.fontSize || 15) + 'px');
  }

  // ============ Tab 切换（CSS transform 硬件加速）============
  function switchTab(i) {
    stopHold(); // 切换页面时停止任何正在进行的长按重复，避免卡在原料库
    State.tabIndex = i;
    track.style.transform = 'translate3d(' + (-i * 25) + '%,0,0)';
    $$('[data-track]').forEach(function (b) {
      b.classList.toggle('active', +b.dataset.track === i);
    });
    if (i === 0) renderCatalog();
    else if (i === 1) renderOrders();
    else if (i === 2) renderLibrary();
    else if (i === 3) renderSettings();
  }

  // ============ 分块渲染 ============
  // 全量渲染（一次性加载所有行，避免 iOS 惯性滚动时 onscroll 不触发导致"到底了"的问题）
  function chunkTable(tbody, items, rowFn, chunk) {
    tbody.innerHTML = '';
    var frag = document.createDocumentFragment();
    for (var i = 0; i < items.length; i++) frag.appendChild(rowFn(items[i], i));
    tbody.appendChild(frag);
    var sc = tbody.closest('.list-scroll');
    if (sc) sc.onscroll = null; // 不再需要滚动监听
  }

  // ============ Tab1 常用目录 ============
  function getCatalogList() {
    var list = Store.getProducts().filter(function (p) { return p.common; });
    var c = State.catalog.cat;
    if (c && c !== '全部') list = list.filter(function (p) { return p.category === c; });
    var q = (State.catalog.search || '').trim().toLowerCase();
    if (q) list = list.filter(function (p) { return p.name.toLowerCase().indexOf(q) >= 0; });
    return list;
  }

  function renderCatalog() {
    var tbody = $('#catalog-body');
    if (!tbody) return;
    var list = getCatalogList();
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">在「原料库」勾选「常用」即可加入这里</td></tr>';
      $('#catalog-count').textContent = '0 项';
      return;
    }
    var sel = Store.getCommonSel();
    chunkTable(tbody, list, function (p) {
      var tr = document.createElement('tr');
      tr.dataset.id = p.id;
      var cs = sel[p.id] || { qty: 0, selected: false };
      tr.innerHTML =
        '<td class="c-name">' + esc(p.name) + '</td>' +
        '<td class="c-price">' + fmtMoney(p.price) + '</td>' +
        '<td class="c-unit">' + esc(p.unit) + '</td>' +
        '<td class="c-qty"><input type="number" inputmode="decimal" step="1" min="0" value="' + (cs.qty || 0) + '" placeholder="0"></td>' +
        '<td class="c-sel"><input type="checkbox"' + (cs.selected ? ' checked' : '') + '></td>';
      // 局部更新：只写 store，不重渲整表（防止键盘消失）
      var qtyInput = tr.querySelector('input[type=number]');
      qtyInput.addEventListener('focus', function () {
        // 进入输入时若仍是占位的 0，自动清空，省去先删 0 再输的操作
        if (this.value === '0') this.value = '';
        // 键盘上下箭头切换时自动滚入可视区
        ensureVisible(this);
      });
      qtyInput.addEventListener('input', function () {
        var v = parseFloat(this.value) || 0;
        var s = Store.getCommonSel();
        s[p.id] = s[p.id] || { qty: 0, selected: false };
        s[p.id].qty = v;
        // 输入数量即自动选中该项；数量为 0 时取消选中
        s[p.id].selected = v > 0;
        Store.setCommonSel(s);
        var cb = tr.querySelector('input[type=checkbox]');
        if (cb) cb.checked = v > 0;
      });
      tr.querySelector('input[type=checkbox]').addEventListener('change', function () {
        var s = Store.getCommonSel();
        s[p.id] = s[p.id] || { qty: 0, selected: false };
        s[p.id].selected = this.checked;
        Store.setCommonSel(s);
      });
      return tr;
    }, 30);
    $('#catalog-count').textContent = list.length + ' 项';
  }

  // 下单 / 盘存（生成单据 + 清零数量）
  function doOrder(type) {
    var sel = Store.getCommonSel();
    var products = Store.getProducts();
    var pm = {};
    products.forEach(function (p) { pm[p.id] = p; });
    var items = [];
    Object.keys(sel).forEach(function (id) {
      var s = sel[id];
      if (s && s.qty > 0 && pm[id]) {
        var p = pm[id];
        items.push({ productId: id, name: p.name, unit: p.unit, price: p.price, category: p.category, qty: s.qty });
      }
    });
    if (!items.length) { toast('请输入数量'); return; }
    var date = Store.nowDateStr();
    var orders = Store.getOrders();
    orders.unshift({
      id: uid(),
      date: date,
      type: type || 'order',
      title: date + (type === 'inventory' ? ' 盘存' : ' 订单'),
      items: items
    });
    Store.setOrders(orders);
    State.ordersOid = orders[0].id;
    // 清零数量，并取消所有选中状态
    Object.keys(sel).forEach(function (id) { if (sel[id]) { sel[id].qty = 0; sel[id].selected = false; } });
    Store.setCommonSel(sel);
    renderCatalog();
    renderOrders();
    toast(type === 'inventory' ? '已生成盘存单' : '已下单');
  }



  // ============ Tab2 订单记录 ============
  function countOrders(map) {
    var n = 0;
    Object.keys(map).forEach(function (m) {
      Object.keys(map[m]).forEach(function (d) { n += map[m][d].length; });
    });
    return n;
  }

  // 仅当顶部「编辑」开关打开时，才显示各时段的「导出/删除」按钮
  function periodActs() {
    if (!State.ordersEditMode) return '';
    return '<span class="tree-acts"><button class="ta-exp">导出</button><button class="ta-del">删除</button></span>';
  }

  function renderOrders() {
    var tree = $('#orders-tree');
    if (!tree) return;
    var orders = Store.getOrders();
    // 三级分组 年 > 月 > 日
    var byY = {};
    orders.forEach(function (o) {
      var p = (o.date || '').split('-');
      var y = p[0] || '?', m = p[1] || '?', d = p[2] || '?';
      byY[y] = byY[y] || {}; byY[y][m] = byY[y][m] || {};
      (byY[y][m][d] = byY[y][m][d] || []).push(o);
    });
    tree.innerHTML = '';
    Object.keys(byY).sort().reverse().forEach(function (y) {
      var yEl = document.createElement('div'); yEl.className = 'tree-y';
      var yHead = document.createElement('div'); yHead.className = 'tree-head tree-y-head';
      yHead.innerHTML = '<span class="tw">▾</span><span class="tt">' + y + ' 年 <span class="cnt">' + countOrders(byY[y]) + '</span></span>' + periodActs();
      var yBody = document.createElement('div'); yBody.className = 'tree-body';
      yHead.addEventListener('click', function () { yEl.classList.toggle('collapsed'); });
      var ye = yHead.querySelector('.ta-exp'), yd = yHead.querySelector('.ta-del');
      if (ye) ye.addEventListener('click', function (e) { e.stopPropagation(); exportPeriod(function (o) { return (o.date || '').indexOf(y + '-') === 0; }, y + '年'); });
      if (yd) yd.addEventListener('click', function (e) { e.stopPropagation(); deletePeriod(function (o) { return (o.date || '').indexOf(y + '-') === 0; }, y + ' 年'); });
      Object.keys(byY[y]).sort().reverse().forEach(function (m) {
        var mEl = document.createElement('div'); mEl.className = 'tree-m';
        var mHead = document.createElement('div'); mHead.className = 'tree-head tree-m-head';
        mHead.innerHTML = '<span class="tw">▾</span><span class="tt">' + m + ' 月</span>' + periodActs();
        var mBody = document.createElement('div'); mBody.className = 'tree-body';
        mHead.addEventListener('click', function () { mEl.classList.toggle('collapsed'); });
        var me = mHead.querySelector('.ta-exp'), md = mHead.querySelector('.ta-del');
        if (me) me.addEventListener('click', function (e) { e.stopPropagation(); exportPeriod(function (o) { return (o.date || '').indexOf(y + '-' + m + '-') === 0; }, y + '年' + m + '月'); });
        if (md) md.addEventListener('click', function (e) { e.stopPropagation(); deletePeriod(function (o) { return (o.date || '').indexOf(y + '-' + m + '-') === 0; }, y + ' 年 ' + m + ' 月'); });
        Object.keys(byY[y][m]).sort().reverse().forEach(function (d) {
          var dayKey = y + '-' + m + '-' + d;
          var dEl = document.createElement('div'); dEl.className = 'tree-d';
          var dHead = document.createElement('div'); dHead.className = 'tree-head tree-d-head';
          dHead.innerHTML = '<span class="tw">▾</span>' + d + ' 日' + periodActs();
          var dBody = document.createElement('div'); dBody.className = 'tree-body';
          dHead.addEventListener('click', function () { dEl.classList.toggle('collapsed'); });
          var de = dHead.querySelector('.ta-exp'), dd = dHead.querySelector('.ta-del');
          if (de) de.addEventListener('click', function (e) { e.stopPropagation(); exportPeriod(function (o) { return o.date === dayKey; }, y + '年' + m + '月' + d + '日'); });
          if (dd) dd.addEventListener('click', function (e) { e.stopPropagation(); deletePeriod(function (o) { return o.date === dayKey; }, y + ' 年 ' + m + ' 月 ' + d + ' 日'); });
          bindLongPress(dHead, 600, function () { exportDateCSV(dayKey); });
          byY[y][m][d].forEach(function (o) {
            var node = document.createElement('div');
            node.className = 'tree-order' + (State.ordersOid === o.id ? ' active' : '');
            node.dataset.oid = o.id;
            var label = (o.type === 'inventory' ? '盘存 · ' : '订单 · ') + o.title;
            node.innerHTML = '<span class="to-label">' + esc(label) + '</span>';
            node.addEventListener('click', function () {
              State.ordersOid = o.id;
              $$('.tree-order', tree).forEach(function (n) { n.classList.remove('active'); });
              node.classList.add('active');
              showOrderDetail(o.id);
            });
            bindLongPress(node, 600, function () { exportOrderCSV(o.id); });
            dBody.appendChild(node);
          });
          dEl.appendChild(dHead); dEl.appendChild(dBody);
          mBody.appendChild(dEl);
        });
        mEl.appendChild(mHead); mEl.appendChild(mBody);
        yBody.appendChild(mEl);
      });
      yEl.appendChild(yHead); yEl.appendChild(yBody);
      tree.appendChild(yEl);
    });
    if (!State.ordersOid || !orders.some(function (o) { return o.id === State.ordersOid; })) {
      State.ordersOid = orders.length ? orders[0].id : null;
    }
    if (State.ordersOid) showOrderDetail(State.ordersOid);
    else $('#orders-detail').innerHTML = '<div class="empty">暂无订单</div>';
    // 反映价格开关状态
    var s = Store.getSettings();
    var tp = $('#tog-price'); if (tp) tp.checked = !!s.orderShowPrice;
    updateEditToggle();
  }

  // 顶部「编辑」开关：开启后，记录列表与详情里的复制/导出/删除操作才显示
  function updateEditToggle() {
    var et = $('#orders-edit-toggle');
    if (!et) return;
    et.textContent = State.ordersEditMode ? '完成' : '编辑';
    et.classList.toggle('active', State.ordersEditMode);
  }

  // 订单详情：按类目分组，编辑模式下数量可修改、可复制 / 导出 / 删除
  function showOrderDetail(orderId) {
    var detail = $('#orders-detail');
    var o = Store.getOrders().find(function (x) { return x.id === orderId; });
    if (!o) { detail.innerHTML = '<div class="empty">暂无订单</div>'; return; }
    var s = Store.getSettings();
    var showPrice = !!s.orderShowPrice;
    var editing = State.ordersEditMode;
    var html = '<div class="order-block">';
    html += '<div class="order-title">' + esc(o.title) + '</div>';
    var groups = {};
    o.items.forEach(function (it, idx) { (groups[it.category] = groups[it.category] || []).push({ it: it, idx: idx }); });
    Object.keys(groups).forEach(function (cat) {
      html += '<div class="order-cat-row"><span class="order-cat">' + esc(cat) + '</span>' +
        '<button class="btn-copy cat" data-oid="' + o.id + '" data-cat="' + esc(cat) + '">复制本类</button></div>';
      groups[cat].forEach(function (g) {
        var it = g.it, sub = it.price * it.qty;
        html += '<div class="order-item">';
        if (editing) html += '<button class="od-del-btn" data-oid="' + o.id + '" data-idx="' + g.idx + '">删除</button>';
        html += '<span class="oi-name">' + esc(it.name) + '</span>';
        // 编辑模式下数量可修改
        if (editing) {
          html += '<span class="oi-qty"><input type="number" inputmode="decimal" step="0.1" min="0" value="' + it.qty + '" class="oi-qty-input" data-oid="' + o.id + '" data-idx="' + g.idx + '">' + esc(it.unit) + '</span>';
        } else {
          html += '<span class="oi-qty">' + it.qty + esc(it.unit) + '</span>';
        }
        if (showPrice) {
          html += '<span class="oi-price">' + fmtMoney(it.price) + '</span>';
          html += '<span class="oi-sub">' + fmtMoney(sub) + '</span>';
        }
        html += '</div>';
      });
    });
    if (editing) {
      html += '<div class="order-actions">';
      html += '<button class="btn-copy" data-oid="' + o.id + '">复制全部</button>';
      html += '<button class="btn-copy export" data-oid="' + o.id + '">导出文件</button>';
      html += '<button class="btn-copy xlsx" data-oid="' + o.id + '">导出Excel</button>';
      html += '<button class="btn-order-del danger" data-oid="' + o.id + '">删除订单</button>';
      html += '</div>';
    } else {
      html += '<div class="edit-hint">点上方「编辑」可修改数量 / 复制 / 导出 / 删除记录</div>';
    }
    html += '</div>';
    detail.innerHTML = html;
    // 数量修改：实时保存到 store 并更新小计
    $$('.oi-qty-input', detail).forEach(function (inp) {
      inp.addEventListener('click', function (e) { e.stopPropagation(); });
      inp.addEventListener('focus', function () {
        // 自动全选原有数字，直接输入即可覆盖，无需手动删除
        this.select();
        // 键盘上下箭头切换时自动滚入可视区
        ensureVisible(this);
      });
      inp.addEventListener('input', function () {
        var oid = this.dataset.oid, idx = +this.dataset.idx;
        var v = parseFloat(this.value) || 0;
        var orders = Store.getOrders();
        var oi = orders.findIndex(function (x) { return x.id === oid; });
        if (oi >= 0 && orders[oi].items[idx]) {
          orders[oi].items[idx].qty = v;
          Store.setOrders(orders);
          var subSpan = this.closest('.order-item').querySelector('.oi-sub');
          if (subSpan) subSpan.textContent = fmtMoney(orders[oi].items[idx].price * v);
        }
      });
    });
    $$('.od-del-btn', detail).forEach(function (b) {
      b.addEventListener('click', function () { deleteOrderItem(b.dataset.oid, +b.dataset.idx); });
    });
    $$('.btn-order-del', detail).forEach(function (b) {
      b.addEventListener('click', function () { deleteOrderWhole(b.dataset.oid); });
    });
    $$('.btn-copy', detail).forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.classList.contains('xlsx')) exportOrderXLSX(b.dataset.oid);
        else if (b.classList.contains('export')) exportOrderFile(b.dataset.oid);
        else if (b.classList.contains('cat')) copyOrderCSV(b.dataset.oid, b.dataset.cat);
        else copyOrderCSV(b.dataset.oid);
      });
    });
  }

  // 删除整条记录（二次确认）
  function deleteOrderWhole(orderId) {
    if (!confirm('确定删除这条记录吗？此操作不可恢复。')) return;
    var orders = Store.getOrders();
    var rest = orders.filter(function (o) { return o.id !== orderId; });
    Store.setOrders(rest);
    if (State.ordersOid === orderId) State.ordersOid = null;
    renderOrders();
    toast('已删除记录');
  }

  // 删除订单项；空订单自动移除
  function deleteOrderItem(orderId, idx) {
    var orders = Store.getOrders();
    var oi = orders.findIndex(function (o) { return o.id === orderId; });
    if (oi < 0) return;
    orders[oi].items.splice(idx, 1);
    if (!orders[oi].items.length) orders.splice(oi, 1);
    Store.setOrders(orders);
    renderOrders();
  }

  // 按年/月导出：把匹配的全部单据（订单+盘存）导出为一个 Excel(.xlsx)；无 XLSX 时回退 CSV
  function exportPeriod(match, label) {
    var orders = Store.getOrders().filter(match);
    if (!orders.length) { toast('该时段暂无记录'); return; }
    if (typeof XLSX !== 'undefined') {
      var aoa = [['记录导出 · ' + label], ['单据', '名称', '单价(元)', '数量', '单位', '小计(元)', '种类']];
      var total = 0;
      orders.forEach(function (o) {
        o.items.forEach(function (it) {
          var sub = it.price * it.qty; total += sub;
          aoa.push([o.title, it.name, it.price, it.qty, it.unit, sub, it.category]);
        });
      });
      aoa.push(['合计', '', '', '', '', total.toFixed(2), '']);
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '记录');
      XLSX.writeFile(wb, '记录_' + label + '.xlsx');
      toast('已导出 Excel：' + label);
    } else {
      var headers = ['单据', '名称', '单价', '数量', '单位', '小计', '种类'];
      var rows = [];
      orders.forEach(function (o) {
        o.items.forEach(function (it) { rows.push([o.title, it.name, it.price, it.qty, it.unit, (it.price * it.qty), it.category]); });
      });
      Store.downloadCSV('记录_' + label + '.csv', rows, headers);
      toast('已导出 ' + label);
    }
  }

  // 按年/月删除：删除匹配的全部单据（二次确认）
  function deletePeriod(match, label) {
    var all = Store.getOrders();
    var hit = all.filter(match);
    if (!hit.length) { toast('该时段暂无记录'); return; }
    if (!confirm('确定删除「' + label + '」的全部 ' + hit.length + ' 条记录吗？此操作不可恢复。')) return;
    var rest = all.filter(function (o) { return !match(o); });
    Store.setOrders(rest);
    if (State.ordersOid && !rest.some(function (o) { return o.id === State.ordersOid; })) State.ordersOid = null;
    renderOrders();
    toast('已删除「' + label + '」');
  }

  // 复制为 TSV（制表符分隔）→ 直接粘进 Excel / WPS / 在线表格会自动分列
  function copyOrderCSV(orderId, cat) {
    var o = Store.getOrders().find(function (x) { return x.id === orderId; });
    if (!o) return;
    var items = cat ? o.items.filter(function (i) { return i.category === cat; }) : o.items;
    var rows = items.map(function (it) { return [it.name, it.unit, it.qty]; });
    Store.copyTSV(rows).then(function () { toast(cat ? '已复制「' + cat + '」' : '已复制全部'); }).catch(function () { toast('复制失败'); });
  }

  // 长按单个订单/盘存单 → 复制为 TSV 到剪贴板
  function exportOrderCSV(orderId) {
    var o = Store.getOrders().find(function (x) { return x.id === orderId; });
    if (!o) return;
    var headers = ['单据', '名称', '单价', '数量', '单位', '小计', '种类'];
    var rows = o.items.map(function (it) { return [o.title, it.name, it.price, it.qty, it.unit, (it.price * it.qty), it.category]; });
    Store.copyTSV(rows, headers).then(function () { toast('已复制 ' + (o.type === 'inventory' ? '盘存' : '订单')); }).catch(function () { toast('复制失败'); });
  }

  // 长按日期 → 复制当天全部单据为 TSV 到剪贴板
  function exportDateCSV(date) {
    var orders = Store.getOrders().filter(function (o) { return o.date === date; });
    var headers = ['单据', '名称', '单价', '数量', '单位', '小计', '种类'];
    var rows = [];
    orders.forEach(function (o) {
      o.items.forEach(function (it) {
        rows.push([o.title, it.name, it.price, it.qty, it.unit, (it.price * it.qty), it.category]);
      });
    });
    Store.copyTSV(rows, headers).then(function () { toast('已复制 ' + date); }).catch(function () { toast('复制失败'); });
  }

  // 导出当前单据为 CSV 文件（Excel / WPS 直接打开）
  function exportOrderFile(orderId) {
    var o = Store.getOrders().find(function (x) { return x.id === orderId; });
    if (!o) return;
    var headers = ['单据', '名称', '单价', '数量', '单位', '小计', '种类'];
    var rows = o.items.map(function (it) { return [o.title, it.name, it.price, it.qty, it.unit, (it.price * it.qty), it.category]; });
    var fname = '记录_' + (o.date || 'export') + (o.type === 'inventory' ? '_盘存' : '') + '.csv';
    Store.downloadCSV(fname, rows, headers);
    toast('已导出 ' + fname);
  }

  // 导出当前单据（订单/盘存）为真正的 Excel(.xlsx) 文件（离线可用，依赖内置 SheetJS）
  function exportOrderXLSX(orderId) {
    var o = Store.getOrders().find(function (x) { return x.id === orderId; });
    if (!o) return;
    if (typeof XLSX === 'undefined') { toast('Excel 组件未加载'); return; }
    var kind = (o.type === 'inventory') ? '盘存' : '订单';
    var aoa = [[kind + ' · ' + (o.date || '') + ' · ' + o.title],
               ['名称', '单价(元)', '数量', '单位', '小计(元)', '种类']];
    o.items.forEach(function (it) {
      aoa.push([it.name, it.price, it.qty, it.unit, it.price * it.qty, it.category]);
    });
    var total = o.items.reduce(function (s, it) { return s + it.price * it.qty; }, 0);
    aoa.push(['合计', '', '', '', total.toFixed(2), '']);
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, kind);
    XLSX.writeFile(wb, kind + '_' + (o.date || 'export') + '_' + o.title + '.xlsx');
    toast('已导出 Excel：' + kind);
  }

  // ============ Tab3 原料库 ============
  function getLibraryList() {
    var list = Store.getProducts().slice();
    var f = State.library;
    if (f.cat && f.cat !== '全部') list = list.filter(function (p) { return p.category === f.cat; });
    if (f.season && f.season !== '全部') list = list.filter(function (p) { return (p.seasons || []).indexOf(f.season) >= 0; });
    if (f.month && f.month !== '全部') list = list.filter(function (p) { return (p.months || []).indexOf(f.month) >= 0; });
    var q = (f.search || '').trim().toLowerCase();
    if (q) list = list.filter(function (p) { return p.name.toLowerCase().indexOf(q) >= 0; });
    var sort = State.librarySort;
    if (sort === 'name-asc') list.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh'); });
    else if (sort === 'name-desc') list.sort(function (a, b) { return b.name.localeCompare(a.name, 'zh'); });
    else if (sort === 'price-asc') list.sort(function (a, b) { return a.price - b.price; });
    else if (sort === 'price-desc') list.sort(function (a, b) { return b.price - a.price; });
    else if (sort === 'category') list.sort(function (a, b) { return a.category.localeCompare(b.category, 'zh'); });
    return list;
  }

  // 当前需要显示的列（读 settings.libCols，缺省用默认）
  function getLibCols() {
    var s = Store.getSettings();
    var cols = s.libCols;
    if (!cols || !cols.length) cols = DEFAULT_LIB_COLS.slice();
    return cols;
  }
  function libColOn(key, on) { return (on || getLibCols()).indexOf(key) >= 0; }

  // 依据显示列动态渲染表头（单位列跟随单价列）
  function renderLibraryHead() {
    var head = $('#library-head');
    if (!head) return;
    var on = getLibCols();
    var editing = State.libraryEditMode;
    var html = '';
    if (editing) html += '<th>选</th>';
    if (libColOn('common', on)) html += '<th>常用</th>';
    if (libColOn('name', on)) html += '<th>名称</th>';
    if (libColOn('price', on)) html += '<th>单价</th><th>单位</th>';
    if (libColOn('category', on)) html += '<th>种类</th>';
    if (libColOn('season', on)) html += '<th>季节</th>';
    if (libColOn('month', on)) html += '<th>月份</th>';
    if (editing) html += '<th>移动</th>';
    else html += '<th></th>';
    head.innerHTML = html;
  }

  function renderLibrary() {
    var tbody = $('#library-body');
    if (!tbody) return;
    renderLibraryHead();
    var on = getLibCols();
    var list = getLibraryList();
    var editing = State.libraryEditMode;
    chunkTable(tbody, list, function (p) {
      var tr = document.createElement('tr');
      tr.dataset.id = p.id;
      var html = '';
      if (editing) html += '<td class="c-sel"><input type="checkbox" class="lib-edit-check"' + (State.libSelectedIds[p.id] ? ' checked' : '') + '></td>';
      if (libColOn('common', on)) html += '<td class="c-sel"><input type="checkbox" class="lib-common"' + (p.common ? ' checked' : '') + '></td>';
      if (libColOn('name', on)) html += '<td class="c-name">' + esc(p.name) + '</td>';
      if (libColOn('price', on)) html += '<td>' + fmtMoney(p.price) + '</td><td>' + esc(p.unit) + '</td>';
      if (libColOn('category', on)) html += '<td>' + esc(p.category) + '</td>';
      if (libColOn('season', on)) html += '<td>' + (p.seasons || []).join('/') + '</td>';
      if (libColOn('month', on)) html += '<td>' + (p.months || []).join('/') + '</td>';
      if (editing) html += '<td class="c-acts"><button class="lib-move-up" title="上移">↑</button><button class="lib-move-down" title="下移">↓</button></td>';
      else html += '<td class="c-acts"><button class="lib-edit-icon" title="编辑">✏️</button></td>';
      tr.innerHTML = html;
      var cb = tr.querySelector('.lib-common');
      if (cb) cb.addEventListener('change', function () {
        var products = Store.getProducts();
        var pr = products.find(function (x) { return x.id === p.id; });
        if (pr) { pr.common = this.checked; Store.setProducts(products); }
      });
      var ec = tr.querySelector('.lib-edit-check');
      if (ec) ec.addEventListener('change', function () {
        if (this.checked) State.libSelectedIds[p.id] = true;
        else delete State.libSelectedIds[p.id];
        updateLibEditCount();
      });
      var ei = tr.querySelector('.lib-edit-icon');
      if (ei) ei.addEventListener('click', function (e) { e.stopPropagation(); openEditor(p.id); });
      var upBtn = tr.querySelector('.lib-move-up');
      var downBtn = tr.querySelector('.lib-move-down');
      // 轻点=移动一格；按住=连续移动（见 startHold，已修复停不下来的 bug）
      if (upBtn) upBtn.addEventListener('pointerdown', function (e) { e.preventDefault(); startHold(upBtn, p.id, -1); });
      if (downBtn) downBtn.addEventListener('pointerdown', function (e) { e.preventDefault(); startHold(downBtn, p.id, 1); });
      return tr;
    }, 30);
    $('#library-count').textContent = list.length + ' 项';
    updateLibToolbar();
  }

  // 「显示列」多选菜单：勾选/取消即时生效并持久化
  function renderColMenu() {
    var menu = $('#lib-cols-menu');
    if (!menu) return;
    var on = getLibCols();
    menu.innerHTML = LIB_COLS.map(function (c) {
      return '<label class="col-opt"><input type="checkbox" data-col="' + c.key + '"' +
        (on.indexOf(c.key) >= 0 ? ' checked' : '') + '> ' + c.label + '</label>';
    }).join('');
    $$('input[data-col]', menu).forEach(function (cbx) {
      cbx.addEventListener('change', function () {
        var cur = getLibCols().slice();
        var key = this.getAttribute('data-col');
        var i = cur.indexOf(key);
        if (this.checked) { if (i < 0) cur.push(key); }
        else { if (i >= 0) cur.splice(i, 1); }
        if (!cur.length) { cur = [key]; this.checked = true; toast('至少保留一列'); }
        var s = Store.getSettings(); s.libCols = cur; Store.setSettings(s);
        renderLibrary();
      });
    });
  }
  function toggleColMenu() {
    var menu = $('#lib-cols-menu'), btn = $('#lib-cols-btn');
    if (!menu || !btn) return;
    if (menu.style.display === 'block') { menu.style.display = 'none'; return; }
    renderColMenu();
    menu.style.display = 'block';
    var rect = btn.getBoundingClientRect();
    var mw = menu.offsetWidth || 150;
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - mw - 8)) + 'px';
  }

  // 原料库编辑模式：切换、全选、删除选中
  function toggleLibEditMode() {
    stopHold(); // 点「完成/编辑」时停止任何长按重复
    State.libraryEditMode = !State.libraryEditMode;
    if (!State.libraryEditMode) State.libSelectedIds = {};
    renderLibrary();
  }
  function selectAllLib() {
    var list = getLibraryList();
    var allSelected = list.every(function (p) { return State.libSelectedIds[p.id]; });
    if (allSelected) {
      // 取消全选
      State.libSelectedIds = {};
    } else {
      list.forEach(function (p) { State.libSelectedIds[p.id] = true; });
    }
    renderLibrary();
  }
  function deleteSelectedLib() {
    var ids = Object.keys(State.libSelectedIds);
    if (!ids.length) { toast('请先选择要删除的项'); return; }
    if (!confirm('确定删除选中的 ' + ids.length + ' 项吗？此操作不可恢复。')) return;
    var products = Store.getProducts().filter(function (p) { return !State.libSelectedIds[p.id]; });
    Store.setProducts(products);
    State.libSelectedIds = {};
    renderLibrary();
    renderCatalog();
    toast('已删除 ' + ids.length + ' 项');
  }
  function updateLibToolbar() {
    var normal = $('#lib-toolbar-normal');
    var editBar = $('#lib-toolbar-edit');
    var editBtn = $('#lib-edit-btn');
    if (!normal || !editBar) return;
    if (State.libraryEditMode) {
      normal.style.display = 'none';
      editBar.style.display = 'flex';
      if (editBtn) editBtn.textContent = '编辑';
    } else {
      normal.style.display = 'flex';
      editBar.style.display = 'none';
      if (editBtn) editBtn.textContent = '编辑';
    }
    updateLibEditCount();
  }
  function updateLibEditCount() {
    var span = $('#lib-selected-count');
    if (span) span.textContent = Object.keys(State.libSelectedIds).length;
  }

  // 原料库排序菜单
  function renderSortMenu() {
    var menu = $('#lib-sort-menu');
    if (!menu) return;
    menu.innerHTML = LIB_SORT_OPTIONS.map(function (o) {
      return '<div class="sort-opt' + (State.librarySort === o.key ? ' on' : '') + '" data-sort="' + o.key + '">' + o.label + '</div>';
    }).join('');
    $$('.sort-opt', menu).forEach(function (el) {
      el.addEventListener('click', function () {
        State.librarySort = el.dataset.sort;
        menu.style.display = 'none';
        renderLibrary();
        scrollPanelTop('#panel-library');
      });
    });
  }
  function toggleSortMenu() {
    var menu = $('#lib-sort-menu'), btn = $('#lib-sort-btn');
    if (!menu || !btn) return;
    if (menu.style.display === 'block') { menu.style.display = 'none'; return; }
    renderSortMenu();
    menu.style.display = 'block';
    var rect = btn.getBoundingClientRect();
    var mw = menu.offsetWidth || 150;
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - mw - 8)) + 'px';
  }

  // 原料库上下移动
  // lightweight=true 时仅做相邻两行 DOM 交换（不重建整表，保留被按住的按钮，使长按可停）
  function moveProduct(id, dir, lightweight) {
    var products = Store.getProducts();
    var idx = products.findIndex(function (p) { return p.id === id; });
    if (idx < 0) return;
    var newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= products.length) return;
    var temp = products[idx];
    products[idx] = products[newIdx];
    products[newIdx] = temp;
    Store.setProducts(products);
    State.librarySort = 'default';
    var sc = $('#panel-library .lib-scroll');
    if (sc) State.libScrollPos = sc.scrollTop;
    var useLight = !!lightweight && !libIsFiltered();
    if (useLight) {
      var row = document.querySelector('#library-body [data-id="' + id + '"]');
      if (row) {
        if (dir < 0 && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
        else if (dir > 0 && row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
      }
    } else {
      renderLibrary();
    }
    // 恢复滚动位置并定位到移动项
    if (sc) {
      sc.scrollTop = State.libScrollPos;
      var r2 = $('[data-id="' + id + '"]', sc);
      if (r2) r2.scrollIntoView({ block: 'nearest' });
    }
  }

  function showCtxMenu(tr, id) {
    var m = $('#ctx-menu');
    m.style.display = 'block';
    var rect = tr.getBoundingClientRect();
    m.style.top = Math.min(rect.top, window.innerHeight - 130) + 'px';
    m.style.left = Math.min(rect.left, window.innerWidth - 170) + 'px';
    m.innerHTML = '<button data-act="edit">编辑</button><button data-act="del" class="danger">删除</button>';
    m.querySelector('[data-act=edit]').onclick = function () { m.style.display = 'none'; openEditor(id); };
    m.querySelector('[data-act=del]').onclick = function () { m.style.display = 'none'; deleteProduct(id); };
  }

  function deleteProduct(id) {
    var products = Store.getProducts().filter(function (p) { return p.id !== id; });
    Store.setProducts(products);
    renderLibrary();
    renderCatalog();
  }

  // ============ 单位下拉（自定义，点 ▼ 始终显示全部预设）============
  var UNIT_PRESETS = ['斤', '个', '把', '瓶', '包', '盒', '桶', '块', '条', '份', '克', '千克', '升', '只', '根', '串', '尾', '瓣'];
  function renderUnitMenu() {
    var menu = $('#ed-unit-menu');
    if (!menu) return;
    menu.innerHTML = '';
    UNIT_PRESETS.forEach(function (u) {
      var d = document.createElement('div');
      d.className = 'unit-item';
      d.textContent = u;
      d.onclick = function (e) {
        e.stopPropagation();
        var inp = $('#ed-unit'); if (inp) inp.value = u;
        menu.style.display = 'none';
      };
      menu.appendChild(d);
    });
  }
  function toggleUnitMenu() {
    var menu = $('#ed-unit-menu');
    if (!menu) return;
    if (menu.style.display === 'block') menu.style.display = 'none';
    else { renderUnitMenu(); menu.style.display = 'block'; }
  }

  // ============ Tab3 添加/编辑（侧滑入）============
  function openEditor(id) {
    // 保存当前原料库滚动位置和编辑行相对视口偏移，以便保存后恢复
    var sc = $('#panel-library .lib-scroll');
    if (sc) {
      State.libScrollPos = sc.scrollTop;
      if (id) {
        var row = $('[data-id="' + id + '"]', sc);
        State.libRowOffset = row ? (row.getBoundingClientRect().top - sc.getBoundingClientRect().top) : 0;
      } else {
        State.libRowOffset = 0;
      }
    }
    State.editorId = id || null;
    var p = id ? Store.getProducts().find(function (x) { return x.id === id; }) : null;
    $('#ed-name').value = p ? p.name : '';
    $('#ed-unit').value = p ? p.unit : '';
    $('#ed-price').value = p ? p.price : '';
    fillSelect($('#ed-cat'), Store.getCategories(), p ? p.category : '');
    setSeasonChips(p ? (p.seasons || []) : []);
    setMonthChips(p ? (p.months || []) : []);
    $('#ed-common').checked = p ? !!p.common : true;
    var um = $('#ed-unit-menu'); if (um) um.style.display = 'none';
    editorPanel.classList.add('open');
  }
  function closeEditor() { editorPanel.classList.remove('open'); State.editorId = null; }

  function fillSelect(sel, opts, val) {
    sel.innerHTML = '';
    opts.forEach(function (o) {
      var op = document.createElement('option');
      op.value = o; op.textContent = o;
      if (o === val) op.selected = true;
      sel.appendChild(op);
    });
  }

  function setSeasonChips(arr) {
    var c = $('#ed-seasons'); c.innerHTML = '';
    ALL_SEASONS.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (arr.indexOf(s) >= 0 ? ' on' : '');
      b.textContent = s;
      b.onclick = function () { b.classList.toggle('on'); updateMonthsFromSeasons(); };
      c.appendChild(b);
    });
  }
  function setMonthChips(arr) {
    var c = $('#ed-months'); c.innerHTML = '';
    ALL_MONTHS.forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (arr.indexOf(m) >= 0 ? ' on' : '');
      b.textContent = m + '月';
      b.dataset.m = m;
      b.onclick = function () { b.classList.toggle('on'); };
      c.appendChild(b);
    });
  }
  function getSeasonChips() { return $$('#ed-seasons .chip.on').map(function (b) { return b.textContent; }); }
  function getMonthChips() { return $$('#ed-months .chip.on').map(function (b) { return b.dataset.m; }); }
  function updateMonthsFromSeasons() {
    var ms = Store.monthsFromSeasons(getSeasonChips());
    $$('#ed-months .chip').forEach(function (b) {
      b.classList.toggle('on', ms.indexOf(b.dataset.m) >= 0);
    });
  }

  function saveEditor() {
    var name = $('#ed-name').value.trim();
    if (!name) { toast('请输入名称'); return; }
    var unit = $('#ed-unit').value.trim() || '份';
    var price = parseFloat($('#ed-price').value) || 0;
    var category = $('#ed-cat').value || '其他';
    var seasons = getSeasonChips();
    var months = getMonthChips();
    var common = $('#ed-common').checked;
    var products = Store.getProducts();
    if (State.editorId) {
      var pr = products.find(function (x) { return x.id === State.editorId; });
      if (pr) Object.assign(pr, { name: name, unit: unit, price: price, category: category, seasons: seasons, months: months, common: common });
    } else {
      products.push({ id: uid(), name: name, unit: unit, price: price, category: category, seasons: seasons, months: months, common: common });
    }
    Store.setProducts(products);
    var savedId = State.editorId;
    var savedScroll = State.libScrollPos;
    var savedOffset = State.libRowOffset;
    closeEditor();
    renderCatalog();
    renderLibrary();
    fillCatFilter();
    // iOS 修复：等编辑面板关闭动画(280ms)结束后再恢复滚动
    // 用纯计算定位，不操作 webkitOverflowScrolling（会导致复选框渲染延迟）
    setTimeout(function () {
      var sc = $('#panel-library .lib-scroll');
      if (sc) {
        if (savedId) {
          var row = $('[data-id="' + savedId + '"]', sc);
          if (row) {
            // 计算行在内容中的绝对位置，减去原来的视口偏移 = 目标 scrollTop
            var rowTop = row.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
            sc.scrollTop = Math.max(0, rowTop - savedOffset);
          } else {
            sc.scrollTop = savedScroll;
          }
        } else {
          sc.scrollTop = savedScroll;
        }
      }
    }, 320);
    toast('已保存');
  }

  // ============ Tab5 设置 ============
  function renderSettings() {
    var cats = Store.getCategories();
    var cw = $('#cat-list');
    if (cw) {
      cw.innerHTML = '';
      cats.forEach(function (c) {
        var li = document.createElement('div');
        li.className = 'cat-item';
        li.innerHTML = '<span>' + esc(c) + '</span><button class="cat-del" aria-label="删除">×</button>';
        li.querySelector('.cat-del').onclick = function () { removeCategory(c); };
        cw.appendChild(li);
      });
    }
    var s = Store.getSettings();
    var fs = $('#set-font'); if (fs) fs.value = s.fontSize;
    var tc = $('#set-theme'); if (tc) tc.value = s.themeColor;
    // 价格更新：新发地免费源配置 + 按钮 + 最近更新说明
    var wk = $('#set-price-worker');
    if (wk) { wk.value = s.priceWorker || ''; wk.oninput = function () { var st = Store.getSettings(); st.priceWorker = wk.value.trim(); Store.setSettings(st); }; }
    var pa = $('#set-price-all');
    if (pa) { pa.checked = s.priceScope === 'all'; pa.onchange = function () { var st = Store.getSettings(); st.priceScope = pa.checked ? 'all' : 'common'; Store.setSettings(st); }; }
    var pu = $('#set-price-syncunit');
    if (pu) { pu.checked = s.priceSyncUnit !== false; pu.onchange = function () { var st = Store.getSettings(); st.priceSyncUnit = pu.checked; Store.setSettings(st); }; }
    var ub = $('#btn-update-price');
    if (ub) {
      ub.onclick = updatePrices;
      var note = $('#price-update-note');
      if (note) note.textContent = s.priceUpdated ? ('最近更新：' + s.priceUpdated + (s.priceSource ? '（' + s.priceSource + '）' : '')) : '尚未更新价格（直接点「更新价格」即可，免费拉当天新发地价）';
    }
  }

  function addCategory() {
    var v = $('#cat-input').value.trim();
    if (!v) return;
    var cats = Store.getCategories().slice();
    if (cats.indexOf(v) < 0) cats.push(v);
    Store.setCategories(cats);
    $('#cat-input').value = '';
    renderSettings();
    fillCatFilter();
    renderCatalog();
    renderLibrary();
  }
  function removeCategory(c) {
    var cats = Store.getCategories().filter(function (x) { return x !== c; });
    Store.setCategories(cats);
    renderSettings();
    fillCatFilter();
    renderCatalog();
    renderLibrary();
  }
  function restoreBuiltin() {
    Store.setProducts(Store.BUILTIN_PRODUCTS.map(function (p) { return Object.assign({}, p); }));
    toast('已恢复原料库数据');
    renderCatalog();
    renderLibrary();
    fillCatFilter();
  }
  function exportJSON() {
    var data = { products: Store.getProducts(), categories: Store.getCategories(), settings: Store.getSettings() };
    var json = '﻿' + JSON.stringify(data, null, 2).trim();
    var blob = new Blob([json], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'kitchen-library.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function importJSON(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result).replace(/^﻿/, '').trim();
      try {
        var data = JSON.parse(text);
        if (data.products) Store.setProducts(data.products);
        if (data.categories) Store.setCategories(data.categories);
        if (data.settings) Store.setSettings(Object.assign(Store.getSettings(), data.settings));
        applyTheme();
        renderSettings();
        fillCatFilter();
        renderCatalog();
        renderLibrary();
        toast('导入成功');
      } catch (e) { toast('JSON 解析失败'); }
    };
    reader.readAsText(file);
  }
  // ============ 价格更新（新发地免费源：Worker 实时 / 内置当天快照回退） ============

  // 把新发地行情数组应用到库内原料（精确匹配 + 模糊兜底）
  function applyXinfadi(arr, opts) {
    opts = opts || {};
    var syncUnit = opts.syncUnit !== false;
    if (!arr || !arr.length) { toast('未获取到价格数据'); return; }
    var map = {};
    arr.forEach(function (it) { if (it && it.name) map[it.name] = it; });
    var products = Store.getProducts();
    var updated = 0, skipped = 0;
    products.forEach(function (p) {
      if (opts.onlyCommon && !p.common) return;
      var ref = map[p.name];
      if (!ref) {
        for (var k in map) {
          if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
          if (p.name && k && (p.name.indexOf(k) >= 0 || k.indexOf(p.name) >= 0) && k.length >= 2) { ref = map[k]; break; }
        }
      }
      if (ref && ref.avg && parseFloat(ref.avg) > 0) {
        p.price = parseFloat(ref.avg);
        if (syncUnit && ref.unit) p.unit = ref.unit;
        updated++;
      } else skipped++;
    });
    Store.setProducts(products);
    var st = Store.getSettings();
    st.priceUpdated = new Date().toLocaleString('zh-CN');
    st.priceSource = opts.source || '内置快照';
    Store.setSettings(st);
    renderLibrary();
    var note = $('#price-update-note');
    if (note) note.textContent = '最近更新：' + st.priceUpdated + '（' + st.priceSource + '，已更新 ' + updated + ' 项，跳过 ' + skipped + ' 项）';
    toast('已更新 ' + updated + ' 项价格' + (skipped ? '，' + skipped + ' 项无匹配' : ''));
  }

  // 新发地行情 GET 地址（一页取最新一批；前端只保留最新一天）
  var XF_PRICE_URL = 'http://www.xinfadi.com.cn/getPriceData.html?current=1&limit=500';

  // 把新发地原始数组（prodName/avgPrice/unitInfo/pubDate）归一化为 {name,avg,unit}，并只留最新一天
  function normXinfadi(list) {
    if (!list || !list.length) return [];
    var latest = ('' + (list[0].pubDate || '')).split(' ')[0];
    return list
      .filter(function (it) { return ('' + (it.pubDate || '')).split(' ')[0] === latest; })
      .map(function (it) {
        return {
          name: it.prodName != null ? it.prodName : it.name,
          avg: it.avgPrice != null ? it.avgPrice : it.avg,
          unit: it.unitInfo != null ? it.unitInfo : it.unit
        };
      });
  }
  function extractXinfadi(raw) {
    var list = Array.isArray(raw) ? raw : (raw && raw.list ? raw.list : []);
    return normXinfadi(list);
  }

  function updatePrices() {
    var btn = $('#btn-update-price');
    if (btn) { btn.disabled = true; btn.textContent = '更新中…'; }
    var s = Store.getSettings();
    var worker = (s.priceWorker || 'https://cors.eu.org/').trim();
    if (worker && worker.slice(-1) !== '/') worker += '/';
    var scope = s.priceScope === 'all' ? 'all' : 'common';
    var syncUnit = s.priceSyncUnit !== false;
    function restore() { if (btn) { btn.disabled = false; btn.textContent = '更新价格'; } }

    // 走内置免费代理实时拉取当天新发地行情（失败自动回退内置快照）
    fetch(worker + XF_PRICE_URL, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (raw) {
        var arr = extractXinfadi(raw);
        if (!arr.length) throw new Error('无数据');
        applyXinfadi(arr, { onlyCommon: scope === 'common', syncUnit: syncUnit, source: '实时·新发地' });
      })
      .catch(function (e) {
        toast('实时拉取失败（' + e.message + '），改用内置当天快照');
        applyXinfadi(window.PRICE_REF || [], { onlyCommon: scope === 'common', syncUnit: syncUnit, source: '内置快照(实时失败)' });
      })
      .then(restore);
  }
  function resetData() {
    if (!confirm('确定要重置所有数据吗？此操作不可恢复。')) return;
    if (!confirm('再次确认：所有订单、菜品、设置将被清空并恢复默认。')) return;
    Store.resetAll();
    location.reload();
  }

  // ============ 全屏搜索 ============
  function openSearch(from) {
    State.searchFrom = from;
    searchOverlay.classList.add('open');
    $('#search-input').value = '';
    $('#search-input').focus();
    runSearch('');
  }
  function closeSearch() {
    searchOverlay.classList.remove('open');
    // 返回时刷新底层 Tab
    if (State.searchFrom === 'catalog') renderCatalog();
    else if (State.searchFrom === 'library') renderLibrary();
  }
  function runSearch(q) {
    var res = $('#search-results');
    var list;
    if (State.searchFrom === 'library') {
      list = Store.getProducts();
    } else {
      list = Store.getProducts().filter(function (p) { return p.common; });
    }
    q = (q || '').trim().toLowerCase();
    if (q) list = list.filter(function (p) { return p.name.toLowerCase().indexOf(q) >= 0; });
    res.innerHTML = '';
    list.slice(0, 200).forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'search-item';
      d.innerHTML = '<span class="si-name">' + esc(p.name) + '</span>' +
        '<span class="muted">' + esc(p.category) + ' · ' + fmtMoney(p.price) + '/' + esc(p.unit) + '</span>';
      d.onclick = function () {
        if (State.searchFrom === 'library') openEditor(p.id);
        closeSearch();
      };
      res.appendChild(d);
    });
    if (!list.length) res.innerHTML = '<div class="empty">无结果</div>';
  }

  // ============ 筛选下拉填充 ============
  function fillCatFilter() {
    var cats = Store.getCategories();
    var sel = $('#cat-filter');
    if (sel) {
      sel.innerHTML = '<option value="全部">全部种类</option>';
      cats.forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
      sel.value = State.catalog.cat;
    }
    var ls = $('#lib-cat');
    if (ls) {
      ls.innerHTML = '<option value="全部">全部</option>';
      cats.forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = c; ls.appendChild(o); });
      ls.value = State.library.cat;
    }
  }
  function fillLibFilters() {
    var ls = $('#lib-season');
    if (ls) {
      ls.innerHTML = '<option value="全部">全部季节</option>';
      ALL_SEASONS.forEach(function (s) { var o = document.createElement('option'); o.value = s; o.textContent = s; ls.appendChild(o); });
    }
    var lm = $('#lib-month');
    if (lm) {
      lm.innerHTML = '<option value="全部">全部月份</option>';
      ALL_MONTHS.forEach(function (m) { var o = document.createElement('option'); o.value = m; o.textContent = m + '月'; lm.appendChild(o); });
    }
  }

  // 切换筛选后，将对应面板的滚动容器回到顶部（无论当前下拉到哪）
  function scrollPanelTop(panelSel) {
    var sc = $(panelSel + ' .list-scroll');
    if (sc) sc.scrollTop = 0;
  }

  // ============ 全局事件绑定 ============
  function bindGlobal() {
    $$('[data-track]').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(+b.dataset.track); });
    });
    $('#nav-add').addEventListener('click', function () { openEditor(null); });

    // catalog
    $('#cat-filter').addEventListener('change', function (e) { State.catalog.cat = e.target.value; renderCatalog(); scrollPanelTop('#panel-catalog'); });
    $('#catalog-search-btn').addEventListener('click', function () { openSearch('catalog'); });
    $('#btn-order').addEventListener('click', function () { doOrder('order'); });
    $('#btn-inventory').addEventListener('click', function () { doOrder('inventory'); });

    // orders
    $('#tog-price').addEventListener('change', function () {
      var s = Store.getSettings(); s.orderShowPrice = this.checked; Store.setSettings(s);
      showOrderDetail(State.ordersOid);
    });
    var etBtn = $('#orders-edit-toggle');
    if (etBtn) etBtn.addEventListener('click', function () {
      State.ordersEditMode = !State.ordersEditMode;
      updateEditToggle();
      renderOrders();
    });

    // library —— 三筛选联动：
    //  选分类 → 季节、月份都重置全部；选季节 → 月份重置全部；选月份 → 季节重置全部
    $('#lib-cat').addEventListener('change', function (e) {
      State.library.cat = e.target.value;
      State.library.season = '全部'; State.library.month = '全部';
      $('#lib-season').value = '全部'; $('#lib-month').value = '全部';
      renderLibrary(); scrollPanelTop('#panel-library');
    });
    $('#lib-season').addEventListener('change', function (e) {
      State.library.season = e.target.value;
      State.library.month = '全部'; $('#lib-month').value = '全部';
      renderLibrary(); scrollPanelTop('#panel-library');
    });
    $('#lib-month').addEventListener('change', function (e) {
      State.library.month = e.target.value;
      State.library.season = '全部'; $('#lib-season').value = '全部';
      renderLibrary(); scrollPanelTop('#panel-library');
    });
    $('#lib-cols-btn').addEventListener('click', function (e) { e.stopPropagation(); toggleColMenu(); });
    $('#lib-sort-btn').addEventListener('click', function (e) { e.stopPropagation(); toggleSortMenu(); });
    $('#lib-edit-btn').addEventListener('click', function () { toggleLibEditMode(); });
    $('#lib-select-all').addEventListener('click', function () { selectAllLib(); });
    $('#lib-delete-selected').addEventListener('click', function () { deleteSelectedLib(); });
    $('#lib-edit-done').addEventListener('click', function () { toggleLibEditMode(); });
    $('#lib-search-input').addEventListener('input', function (e) { State.library.search = e.target.value; renderLibrary(); });
    $('#lib-search-btn').addEventListener('click', function () {
      var w = $('#lib-search-wrap');
      if (!w) return;
      if (w.style.display === 'none') { w.style.display = 'block'; $('#lib-search-input').focus(); }
      else { w.style.display = 'none'; }
    });

    // editor
    $('#ed-save').addEventListener('click', saveEditor);
    $('#ed-cancel').addEventListener('click', closeEditor);
    var ubt = $('#ed-unit-btn');
    if (ubt) ubt.addEventListener('click', function (e) { e.stopPropagation(); toggleUnitMenu(); });

    // search
    $('#search-input').addEventListener('input', function (e) { runSearch(e.target.value); });
    $('#search-close').addEventListener('click', closeSearch);

    // settings
    $('#cat-add').addEventListener('click', addCategory);
    $('#btn-restore').addEventListener('click', restoreBuiltin);
    $('#btn-export').addEventListener('click', exportJSON);
    $('#btn-import').addEventListener('click', function () { $('#file-input').click(); });
    $('#file-input').addEventListener('change', function (e) { if (e.target.files[0]) importJSON(e.target.files[0]); });
    $('#set-font').addEventListener('input', function (e) {
      var s = Store.getSettings(); s.fontSize = +e.target.value; Store.setSettings(s); applyTheme();
    });
    $('#set-theme').addEventListener('input', function (e) {
      var s = Store.getSettings(); s.themeColor = e.target.value; Store.setSettings(s); applyTheme();
    });
    $('#btn-reset').addEventListener('click', resetData);

    // 关闭右键菜单 / 显示列菜单 / 排序菜单（点击空白处）
    document.addEventListener('click', function (e) {
      var m = $('#ctx-menu');
      if (m && m.style.display === 'block' && !m.contains(e.target)) m.style.display = 'none';
      var cm = $('#lib-cols-menu'), cb = $('#lib-cols-btn');
      if (cm && cm.style.display === 'block' && !cm.contains(e.target) && e.target !== cb) cm.style.display = 'none';
      var sm = $('#lib-sort-menu'), sb = $('#lib-sort-btn');
      if (sm && sm.style.display === 'block' && !sm.contains(e.target) && e.target !== sb) sm.style.display = 'none';
      var um = $('#ed-unit-menu'), ub2 = $('#ed-unit-btn');
      if (um && um.style.display === 'block' && !um.contains(e.target) && e.target !== ub2) um.style.display = 'none';
    });

    // 落盘
    window.addEventListener('beforeunload', function () { Store.flush(); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) Store.flush(); });
  }

  // ============ 初始化（try-catch 包裹，确保闭合安全）============
  // 注册 Service Worker，使 PWA 可离线、可「添加到主屏幕」
  function registerSW() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(function () {});
      });
    }
  }

  // 请求持久化存储：授权后浏览器承诺不自动清理本站点数据（Cache API + localStorage）
  // 否则在设备存储吃紧时，浏览器可能静默回收，导致原料库编辑/订单等丢失
  function requestPersistentStorage() {
    try {
      if (navigator.storage && typeof navigator.storage.persist === 'function') {
        navigator.storage.persist().then(function (granted) {
          console.log('[persist] 持久化存储授权 =', granted);
        }).catch(function () {});
      }
    } catch (e) {}
  }

  function init() {
    try {
      track = $('#tab-track');
      searchOverlay = $('#search-overlay');
      editorPanel = $('#editor-panel');
      applyTheme();
      // 申请持久化存储，避免浏览器在存储紧张时自动清理站点数据
      requestPersistentStorage();
      // 合并内置原料（含新增「调味品」）：按菜名去重，保留用户已编辑项
      var _st = Store.getSettings();
      Store.mergeBuiltin();
      // 确保分类列表包含产品里出现的种类（如「调味品」）
      var cats = Store.getCategories().slice();
      var catChanged = false;
      Store.getProducts().forEach(function (p) {
        if (p && p.category && cats.indexOf(p.category) < 0) { cats.push(p.category); catChanged = true; }
      });
      if (catChanged) Store.setCategories(cats);
      if (!_st.dataV2) {
        _st.dataV2 = true;
        Store.setSettings(_st);
        toast('已载入原料库数据');
      }
      fillCatFilter();
      fillLibFilters();
      bindGlobal();
      registerSW();
      switchTab(0);
    } catch (e) {
      console.error('[init] error', e);
      var app = $('#app');
      if (app) app.insertAdjacentHTML('afterbegin',
        '<div class="fatal">初始化异常：' + esc(e && e.message) + '</div>');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
