/*
 * store.js — 餐饮后厨 数据层
 * 纯前端 localStorage 封装，key 前缀 ks2_
 * 设计要点：
 *   - 内存缓存 + 防抖写入，减少同步 I/O 阻塞
 *   - 五大数据模型：products / common_sel / orders / categories / settings
 *   - 本地时间三参数格式化（不使用 toISOString，避免时区偏移）
 *   - 表格导出：复制为 TSV（可直接粘进 Excel/WPS/表格）或下载 CSV 文件
 *   - 内置数据全部来自桌面「原材料大全.xlsx」（见 js/rawdata.js），无硬编码菜品
 */
(function (global) {
  'use strict';

  var PREFIX = 'ks2_';
  var KEYS = {
    products: PREFIX + 'products',
    commonSel: PREFIX + 'common_sel',
    orders: PREFIX + 'orders',
    categories: PREFIX + 'categories',
    settings: PREFIX + 'settings'
  };

  // 分类直接对应「原材料大全.xlsx」的工作表
  var DEFAULT_CATEGORIES = ['水产', '蔬菜', '肉禽', '调味品'];
  var DEFAULT_SETTINGS = { fontSize: 15, themeColor: '#FF2442', dataV2: false, orderShowPrice: false, orderShowDelete: false,
    priceWorker: 'https://cors.eu.org/', priceScope: 'common', priceSyncUnit: true };

  // 内存缓存 + 防抖定时器
  var cache = {};
  var timers = {};

  function safeParse(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  function readRaw(key) {
    try {
      var v = localStorage.getItem(key);
      return v == null ? null : v;
    } catch (e) {
      console.warn('[store] read fail', key, e);
      return null;
    }
  }

  function writeRaw(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      console.warn('[store] write fail', key, e);
    }
  }

  function getCache(key) {
    if (!(key in cache)) {
      var raw = readRaw(key);
      cache[key] = raw == null ? undefined : safeParse(raw);
    }
    return cache[key];
  }

  function setCache(key, value, debounce) {
    cache[key] = value;
    if (timers[key]) { clearTimeout(timers[key]); timers[key] = null; }
    if (debounce) {
      timers[key] = setTimeout(function () {
        writeRaw(key, JSON.stringify(value));
        timers[key] = null;
      }, debounce);
    } else {
      writeRaw(key, JSON.stringify(value));
    }
  }

  // 季节 → 月份 联动映射（均可为空）
  var seasonMonths = {
    '春': ['3', '4', '5'],
    '夏': ['6', '7', '8'],
    '秋': ['9', '10', '11'],
    '冬': ['12', '1', '2']
  };

  function monthsFromSeasons(seasons) {
    var set = {};
    (seasons || []).forEach(function (s) {
      (seasonMonths[s] || []).forEach(function (m) { set[m] = 1; });
    });
    return Object.keys(set).sort(function (a, b) { return (+a) - (+b); });
  }

  // 本地时间三参数格式化：YYYY-MM-DD
  function fmtDate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
  function nowDateStr() { return fmtDate(new Date()); }

  // 复制为 TSV（制表符分隔）到剪贴板：粘进 Excel / WPS / 在线表格会自动分列
  function copyTSV(rows, headers) {
    var tsv = '';
    if (headers && headers.length) tsv += headers.join('\t') + '\n';
    (rows || []).forEach(function (r) {
      tsv += r.map(function (cell) { return String(cell == null ? '' : cell); }).join('\t') + '\n';
    });
    var bom = '﻿' + tsv;
    if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(bom);
    }
    return new Promise(function (resolve) {
      try {
        var ta = document.createElement('textarea');
        ta.value = bom; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e) {}
      resolve();
    });
  }

  // 复制为 CSV（逗号，带引号转义 + BOM）到剪贴板
  function copyCSV(rows, headers) {
    var csv = '';
    if (headers && headers.length) csv += headers.join(',') + '\n';
    (rows || []).forEach(function (r) {
      csv += r.map(function (cell) {
        var s = String(cell == null ? '' : cell);
        if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      }).join(',') + '\n';
    });
    var bom = '﻿' + csv;
    if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(bom);
    }
    return new Promise(function (resolve) {
      try {
        var ta = document.createElement('textarea');
        ta.value = bom; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e) {}
      resolve();
    });
  }

  // 触发浏览器下载一个 CSV 文件（UTF-8 BOM，Excel/WPS 直接打开）
  function downloadCSV(filename, rows, headers) {
    var csv = '';
    if (headers && headers.length) csv += headers.join(',') + '\n';
    (rows || []).forEach(function (r) {
      csv += r.map(function (cell) {
        var s = String(cell == null ? '' : cell);
        if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      }).join(',') + '\n';
    });
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------- 原料库数据：全部来自桌面「原材料大全.xlsx」（js/rawdata.js）----------
  var BUILTIN_PRODUCTS = (global.RAWMAT || []).map(function (p) {
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      unit: p.unit || '',
      price: (typeof p.price === 'number' && isFinite(p.price)) ? p.price : 0,
      seasons: p.seasons || [],
      months: p.months || [],
      common: false
    };
  });

  // ---------- 对外 API ----------
  var Store = {
    KEYS: KEYS,
    PREFIX: PREFIX,
    DEFAULT_CATEGORIES: DEFAULT_CATEGORIES,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    seasonMonths: seasonMonths,
    BUILTIN_PRODUCTS: BUILTIN_PRODUCTS,

    getProducts: function () {
      var v = getCache(KEYS.products);
      if (v === undefined) { setCache(KEYS.products, BUILTIN_PRODUCTS.slice()); return BUILTIN_PRODUCTS.slice(); }
      return v;
    },
    setProducts: function (v) { setCache(KEYS.products, v, 300); },

    // 将原料库默认数据合并进当前数据；已存在的（按菜名）不重复添加；返回新增条数
    mergeBuiltin: function () {
      var products = this.getProducts().slice();
      var have = {};
      products.forEach(function (p) { if (p && p.name) have[p.name] = true; });
      var added = 0;
      BUILTIN_PRODUCTS.forEach(function (b) {
        if (!have[b.name]) { products.push(Object.assign({}, b)); have[b.name] = true; added++; }
      });
      this.setProducts(products);
      return added;
    },

    getCommonSel: function () {
      var v = getCache(KEYS.commonSel);
      if (v === undefined) { setCache(KEYS.commonSel, {}); return {}; }
      return v || {};
    },
    setCommonSel: function (v) { setCache(KEYS.commonSel, v || {}, 200); },

    getOrders: function () {
      var v = getCache(KEYS.orders);
      if (v === undefined) { setCache(KEYS.orders, []); return []; }
      return v || [];
    },
    setOrders: function (v) { setCache(KEYS.orders, v || [], 300); },

    getCategories: function () {
      var v = getCache(KEYS.categories);
      if (v === undefined) { setCache(KEYS.categories, DEFAULT_CATEGORIES.slice()); return DEFAULT_CATEGORIES.slice(); }
      return v || DEFAULT_CATEGORIES.slice();
    },
    setCategories: function (v) { setCache(KEYS.categories, v || [], 200); },

    getSettings: function () {
      var v = getCache(KEYS.settings);
      if (v === undefined) { setCache(KEYS.settings, Object.assign({}, DEFAULT_SETTINGS)); return Object.assign({}, DEFAULT_SETTINGS); }
      var base = Object.assign({}, DEFAULT_SETTINGS);
      return Object.assign(base, v || {});
    },
    setSettings: function (v) { setCache(KEYS.settings, v || {}, 200); },

    monthsFromSeasons: monthsFromSeasons,
    fmtDate: fmtDate,
    nowDateStr: nowDateStr,
    copyCSV: copyCSV,
    copyTSV: copyTSV,
    downloadCSV: downloadCSV,

    // 立即落盘所有待写缓存（页面隐藏 / 关闭前调用）
    flush: function () {
      Object.keys(cache).forEach(function (key) {
        if (timers[key]) { clearTimeout(timers[key]); timers[key] = null; }
        if (cache[key] !== undefined) writeRaw(key, JSON.stringify(cache[key]));
      });
    },

    // 清空全部数据（重置前调用）
    resetAll: function () {
      Object.keys(timers).forEach(function (k) { if (timers[k]) clearTimeout(timers[k]); });
      timers = {};
      cache = {};
      Object.keys(KEYS).forEach(function (k) {
        try { localStorage.removeItem(KEYS[k]); } catch (e) {}
      });
    }
  };

  global.Store = Store;
})(window);
