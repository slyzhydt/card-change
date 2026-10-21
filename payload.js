/* ==== SKINRENDER-BEGIN @V@ ==== */
/* 皮肤渲染载荷 @V@：只改客户端本地的资源指向，所有权数据不动。
   三条通道，全部查离线生成的分层表，运行时不推断：
     行覆盖 applyClientOverrides / 路径整族重定向（先验目标存在）/ spine 实例观测
   层级 A B T S L M，运行期同目录 skin.cfg 可改：
     off nomap nofu nocreate norow noatl heal tier drop add row */
(function () {
  var BUILD = '@V@';
  var BAKED = __SKIN_TABLE__;
  var CARD_ONLY = BAKED.mode === 'cards_only';
  var M = CARD_ONLY ? {} : (BAKED.map || {});
  var ROWS = CARD_ONLY ? {} : (BAKED.rows || {});
  var REV = BAKED.revision || 'skinrender-1';
  var ATL = CARD_ONLY ? {} : (BAKED.atlases || {});
  var ATLKEYS = Object.keys(ATL);
  var made = { create: 0, fu: 0, hit: 0, refuse: 0, animAsk: 0, animMiss: 0, skinAsk: 0, skinMiss: 0, fail: 0, autooff: 0, rowApplied: 0, rowReadOk: 0, rowReadBad: 0, bridge: 0, heal: 0, atlas: 0, cardAsk: 0, cardForced: 0, cardSkip: 0, cardNoGet: 0 };
  var logHit = {}, logRef = {}, animStem = {}, skinStem = {}, extra = {};
  var cfg = { off: false, nomap: false, nofu: false, nocreate: false, norow: false, noatl: false, tier: 'ABTSL', drop: [], heal: false };
  if (CARD_ONLY) { cfg.onlyselected = true; cfg.norow = true; cfg.noatl = true; }
  var GOOD = '', LINES = [], REDIR_ON = true, RAW_EXIST = null, FU = null, DBQ = null, TRAP = false, BRIDGEWRAP = false, SURF = null;
  var ROWSTATE = '未开始', ROWLOG = [], SAMPLED = [], BLOCKED = {};
  var CARD_PATCHES = Object.create(null), CARD_DB = null, CARD_ROW_LOG = {};

  function say(m) { try { if (typeof globalThis._speedLog === 'function') globalThis._speedLog('[' + BUILD + '] ' + m); } catch (e) { } }
  function bump(d, k) { d[k] = (d[k] || 0) + 1; }
  function log(m) {
    say(m); LINES.push(Math.round(Date.now() / 1000) + ' | ' + m);
    /* 关键行立刻落盘，攒批会让判据滞后 */
    var key = /^(HIT|SKINMISS|ANIMMISS|CREATE FAIL|FALLBACK|AUTO-OFF|ROW|READY|DB |FU 已包|FU 按|HOOK|BRIDGE|SPINE面|ALIVE|SKIN)/.test(m.replace(/^\[[^\]]*\] /, ''));
    if (key || LINES.length % 10 === 0) flush();
  }
  function type_(e) { try { return String(e && e.name ? e.name : e).slice(0, 30); } catch (x) { return '?'; } }
  function wr(f, s) { if (!GOOD || !FU) return false; try { FU.writeStringToFile(s, GOOD + f); return true; } catch (e) { return false; } }
  function pickDir() {
    var D = [];
    try {
      var wp = String(cc.FileUtils.getInstance().getWritablePath());
      if (wp) { D.push(wp); }
      for (var up = 0; up < 3; up++) {
        wp = wp.replace(/[\\/][^\\/]*$/, '');
        if (!wp) break;
        D.push(wp + '/');
      }
    } catch (e) { }
    D.push('./');
    for (var i = 0; i < D.length; i++) {
      var p = D[i] + 'skin_probe.txt', tok = 'SKINP' + Date.now(), w = '', rd = '';
      try { cc.FileUtils.getInstance().writeStringToFile(tok, p); w = 'ok'; } catch (e) { w = 'THROW:' + e; }
      try { rd = String(cc.FileUtils.getInstance().getStringFromFile(p)); } catch (e) { rd = 'THROW:' + e; }
      say('DIR探测 ' + D[i] + ' 写=' + w + ' 回读匹配=' + (rd === tok));
      if (w === 'ok' && rd === tok) return D[i];
    }
    return '';
  }
  function flush() { return wr('skin.log', LINES.join('\r\n') + '\r\n'); }
  function dump(why) {
    var o = ['[' + why + '] made=' + JSON.stringify(made), 'cfg=' + JSON.stringify(cfg), '行覆盖=' + ROWSTATE,
      '采样（游戏实际问过的前几条路径）---'];
    for (var q = 0; q < SAMPLED.length; q++) o.push('  ' + SAMPLED[q]);
    o.push('--- 行覆盖逐条 ---');
    for (var i = 0; i < ROWLOG.length; i++) o.push('  ' + ROWLOG[i]);
    o.push('--- 命中 ---');
    for (var k in logHit) if (logHit.hasOwnProperty(k)) o.push('  ' + logHit[k] + 'x  ' + k);
    o.push('--- 拒绝/未改 ---');
    for (var r in logRef) if (logRef.hasOwnProperty(r)) o.push('  ' + logRef[r] + 'x  ' + r);
    o.push('--- 按茎名的动画请求 ---');
    for (var a in animStem) if (animStem.hasOwnProperty(a)) o.push('  ' + animStem[a] + 'x  ' + a);
    o.push('--- 按茎名的皮肤请求 ---');
    for (var s in skinStem) if (skinStem.hasOwnProperty(s)) o.push('  ' + skinStem[s] + 'x  ' + s);
    wr('skin_seen.txt', o.join('\r\n') + '\r\n');
    var t = [], g = [];
    for (var k2 in extra) if (extra.hasOwnProperty(k2)) {
      if (k2.indexOf('DBROW ') === 0) g.push(k2 + ' => ' + extra[k2]); else t.push(extra[k2] + 'x  ' + k2);
    }
    t.push('=== 表行里像路径/皮肤字段的抽样 ===');
    wr('skin_stemreq.txt', t.join('\r\n') + '\r\n' + g.join('\r\n') + '\r\n');
    return !!GOOD;
  }
  function dropped(full) {
    for (var i = 0; i < cfg.drop.length; i++) if (full.indexOf(cfg.drop[i]) === 0) return true;
    return false;
  }
  function readCfg() {
    var txt = '';
    try { txt = String(FU.getStringFromFile(GOOD + 'skin.cfg')); } catch (e) { return '无 cfg(' + type_(e) + ')'; }
    if (!txt || txt.length < 1) return 'cfg 空';
    var ls = txt.replace(/\r/g, '').split('\n'), applied = [];
    for (var i = 0; i < ls.length; i++) {
      var l = ls[i].replace(/^\s+|\s+$/g, '');
      if (!l || l.charAt(0) === '#') continue;
      var sp = l.split(/\s+/), k = sp[0];
      if (CARD_ONLY && ['row', 'add', 'heal', 'tier'].indexOf(k) >= 0) continue;
      if (k === 'off' || k === 'record_only') { cfg.off = true; applied.push('off'); }
      else if (k === 'nomap') { cfg.nomap = true; applied.push('nomap'); }
      else if (k === 'nofu') { cfg.nofu = true; applied.push('nofu'); }
      else if (k === 'nocreate') { cfg.nocreate = true; applied.push('nocreate'); }
      else if (k === 'norow') { cfg.norow = true; applied.push('norow'); }
      else if (k === 'noatl') { cfg.noatl = true; applied.push('noatl'); }
      else if (k === 'heal') { cfg.heal = true; applied.push('heal'); }
      else if (k === 'tier' && sp[1]) { cfg.tier = sp[1]; applied.push('tier=' + sp[1]); }
      else if (k === 'drop' && sp[1]) { cfg.drop.push(sp[1]); applied.push('drop=' + sp[1]); }
      else if (k === 'add' && sp[1] && sp[2]) {
        M[sp[1]] = { v: sp[2], e: (sp[3] || 'scsp,atlas,sct').split(','), t: 'A', src: 'cfg' };
        applied.push('add=' + sp[1] + '->' + sp[2]);
      }
      else if (k === 'row' && sp[1] && sp[2]) {
        ROWS['char_base'] = ROWS['char_base'] || {};
        try { ROWS['char_base'][sp[1]] = JSON.parse(sp[2]); applied.push('row=' + sp[1]); }
        catch (e) { applied.push('row语法错:' + sp[1]); }
      }
    }
    return applied.length ? applied.join(' ') : 'cfg 无可应用行';
  }

  function readSelection() {
    var txt = '';
    try {
      var path = GOOD + 'skin_redirects.json';
      if (CARD_ONLY) {
        txt = JSON.stringify(BAKED.selection || { schema: 1, use_builtin: false, routes: [], card_overrides: {} });
      } else if (typeof FU.isFileExist === 'function' && !FU.isFileExist(path)) {
        return '无选择配置';
      } else { txt = String(FU.getStringFromFile(path) || ''); }
      if (!txt.replace(/\s/g, '')) throw new Error('选择配置为空或无法读取');
      if (txt.length > 1048576) throw new Error('配置超过 1 MB');
      var doc = JSON.parse(txt), picked = {}, count = 0, cardPicked = Object.create(null);
      if (!doc || doc.schema !== 1 || !Array.isArray(doc.routes) || doc.routes.length > 1000 ||
          (doc.use_builtin !== undefined && typeof doc.use_builtin !== 'boolean')) throw new Error('配置结构不符');
      if (CARD_ONLY && (doc.use_builtin !== false || doc.routes.length)) throw new Error('此程序仅支持卡牌编号映射，旧角色换肤配置不适用');
      var stem = /^(?:face\/(?:portrait|character)|model|model_data|card|card_illustration)\/[A-Za-z0-9_-]+$/;
      doc.routes.forEach(function (r) {
        if (!r || typeof r.enabled !== 'boolean' || typeof r.source !== 'string' ||
            typeof r.target !== 'string' || !stem.test(r.source) || !stem.test(r.target) ||
            r.source.length > 160 || r.target.length > 160 || !Array.isArray(r.extensions) ||
            !r.extensions.length) throw new Error('映射字段不符');
        var exts = r.extensions;
        if (exts.some(function (e, i) { return ['scsp', 'atlas', 'sct', 'srmd', 'srcs', 'srue'].indexOf(e) < 0 || exts.indexOf(e) !== i; }) ||
            (exts.indexOf('scsp') >= 0 && (exts.indexOf('atlas') < 0 || exts.indexOf('sct') < 0))) throw new Error('扩展名不符或骨架资源不完整');
        if (!r.enabled) return;
        if (Object.prototype.hasOwnProperty.call(picked, r.source)) throw new Error('同一来源启用了多个目标');
        picked[r.source] = { v: r.target.split('/').pop(), to: r.target, e: exts.slice(), t: 'A', src: 'selection' };
        count++;
      });
      var cards = doc.card_overrides || {};
      if (typeof cards !== 'object' || Array.isArray(cards) || Object.keys(cards).length > 1000) throw new Error('卡牌映射结构不符');
      Object.keys(cards).forEach(function (id) {
        var p = cards[id], expected = [];
        if (!/^[A-Za-z0-9_-]{1,160}$/.test(id) || !p || typeof p !== 'object' ||
            Object.keys(p).some(function (k) { return ['sct_name', 'spine_model', 'resources', 'spine_directory', 'spine_layers', 'spine_cfx'].indexOf(k) < 0; })) throw new Error('卡牌显示字段不符');
        ['sct_name', 'spine_model'].forEach(function (field) {
          if (typeof p[field] !== 'string' || !/^(?:none|[A-Za-z0-9_-]+)$/.test(p[field])) throw new Error('卡牌资源名不符');
        });
        var directory = p.spine_directory === undefined ? 'card' : p.spine_directory;
        var layers = p.spine_layers === undefined ? [] : p.spine_layers;
        if (['card', 'effect'].indexOf(directory) < 0 || !Array.isArray(layers) || layers.length > 2 ||
            layers.some(function (s, i) { return ['bg', 'eff'].indexOf(s) < 0 || layers.indexOf(s) !== i; }) ||
            (p.spine_cfx !== undefined && typeof p.spine_cfx !== 'boolean') ||
            (p.spine_model === 'none' && (directory !== 'card' || layers.length || p.spine_cfx))) throw new Error('卡牌骨架目录或配套层不符');
        if (p.sct_name !== 'none') expected.push('card_illustration/' + p.sct_name + '.sct');
        var exts = ['scsp', 'atlas', 'sct'];
        if (p.spine_model !== 'none') {
          [''].concat(layers.map(function (s) { return '_' + s; })).forEach(function (suffix) {
            exts.forEach(function (e) { expected.push(directory + '/' + p.spine_model + suffix + '.' + e); });
          });
          if (p.spine_cfx) expected.push(directory + '/' + p.spine_model + '.cfx');
        }
        if (!expected.length || !Array.isArray(p.resources) || p.resources.length !== expected.length ||
            expected.some(function (name) { return p.resources.indexOf(name) < 0; })) throw new Error('卡牌资源清单不完整');
        cardPicked[id] = { sct_name: p.sct_name, spine_model: p.spine_model, resources: expected, relocated: directory === 'effect' };
        if (directory === 'effect') {
          [''].concat(layers.map(function (s) { return '_' + s; })).forEach(function (suffix) {
            var source = 'card/' + p.spine_model + suffix, target = 'effect/' + p.spine_model + suffix;
            if (picked[source] && picked[source].to !== target) throw new Error('卡牌路径冲突');
            if (!picked[source]) count++;
            picked[source] = { v: p.spine_model + suffix, to: target, e: suffix || !p.spine_cfx ? exts.slice() : exts.concat(['cfx']),
              t: 'A', src: 'selection', required: expected.slice() };
          });
        }
      });
      if (doc.use_builtin === false) { M = {}; ROWS = {}; cfg.onlyselected = true; }
      Object.keys(picked).forEach(function (k) { M[k] = picked[k]; });
      CARD_PATCHES = cardPicked;
      return (CARD_ONLY ? '内嵌选择 ' : '') + '路径 ' + count + ' 项，卡牌 ' + Object.keys(cardPicked).length + ' 项，内置映射=' + (doc.use_builtin !== false);
    } catch (e) {
      REDIR_ON = false; cfg.norow = true; cfg.noatl = true;
      log('SELECT 拒绝配置，已停止改路：' + String(e.message || e));
      return '配置无效，已停止改路';
    }
  }

  try {
    GOOD = pickDir();
    FU = cc.FileUtils.getInstance();
    RAW_EXIST = typeof FU.isFileExist === 'function' ? FU.isFileExist : null;
    var cfgr = readCfg();
    var selection = readSelection();
    if (cfg.off) REDIR_ON = false;
    say('ALIVE ' + BUILD + ' 目录=' + (GOOD || '无') + ' 路径表=' + Object.keys(M).length +
      ' 行覆盖=' + Object.keys(ROWS['char_base'] || {}).length + ' cfg:' + cfgr + ' 选择:' + selection +
      ' 改路=' + (REDIR_ON && !cfg.nomap && !cfg.nofu) + ' 包create=' + (!cfg.nocreate));

    function shadowProbe() {
      var mark = 'SKINSHADOW' + Date.now(), rel = 'model/skin_shadow.atlas', abs = '';
      try { abs = String(FU.getWritablePath()) + rel; } catch (e) { return '无 getWritablePath(' + type_(e) + ')'; }
      var lines = [mark, 'size: 8,8', 'format: RGBA8888', 'filter: Linear,Linear', 'repeat: none', 'skin_region',
        '  rotate: false', '  xy: 0, 0', '  size: 8, 8', '  orig: 8, 8', '  offset: 0, 0', '  index: -1'];
      var w = '';
      try { FU.writeStringToFile(lines.join(String.fromCharCode(10)), abs); w = 'ok'; } catch (e) { w = 'THROW:' + type_(e); }
      var viaAbs = '', rd = '', ex = '?';
      try { viaAbs = String(FU.getStringFromFile(abs)); } catch (e) { viaAbs = 'THROW'; }
      try { rd = String(FU.getStringFromFile(rel)); } catch (e) { rd = 'THROW'; }
      try { ex = !!FU.isFileExist(rel); } catch (e) { ex = 'THROW'; }
      return '写=' + w + ' 绝对路径读回命中=' + (viaAbs.indexOf('SKINSHADOW') >= 0) +
        ' 相对名 isFileExist=' + ex + ' 相对名读回命中=' + (rd.indexOf('SKINSHADOW') >= 0);
    }
    function stemOf(p) {
      var m = String(p).match(/^(.*?)\/([A-Za-z0-9_.]+)\.(scsp|atlas|sct|srmd|srcs|srue|cfx)$/);
      return m ? { dir: m[1], stem: m[2], ext: m[3], full: m[1] + '/' + m[2] } : null;
    }
    function atlasFor(p) {
      if (cfg.noatl || !ATLKEYS.length) return null;
      if (cfg.tier.indexOf('M') < 0) return null;   /* 官方 16453 个图集抽样 1200 个：页数只有 1，双页文本会让模型整个消失 */
      var s = String(p);
      if (!/\.atlas$/.test(s)) return null;
      for (var i = 0; i < ATLKEYS.length; i++) {
        var k = ATLKEYS[i];
        if (s.length >= k.length && s.slice(-k.length) === k) {
          made.atlas++;
          if (made.atlas <= 8 || made.atlas % 20 === 0) log('ATLAS 合成 ' + s + ' 文本=' + ATL[k].length + ' B 第' + made.atlas + ' 次');
          return ATL[k];
        }
      }
      return null;
    }
    function rewrite(p) {
      made.fu++;
      if (made.fu <= 8 || made.fu % 200 === 0) {
        var tag = 'FU#' + made.fu + ' ' + String(p).slice(0, 110);
        SAMPLED.push(tag); if (made.fu % 200 === 0) log(tag);
      }
      if (cfg.nomap || cfg.nofu || !REDIR_ON) return p;
      var s = stemOf(p);
      if (!s) return p;
      var m = Object.prototype.hasOwnProperty.call(M, s.full) ? M[s.full] : null;
      if (!m) {
        if (/^(face\/portrait|face\/character|model)\//.test(s.dir) && made.refuse < 40) {
          bump(logRef, '名单外 ' + s.dir); made.refuse++;
        }
        return p;
      }
      if (BLOCKED[s.full]) { bump(logRef, '自愈拉黑 ' + s.full); return p; }
      if (dropped(s.full)) { bump(logRef, 'cfg drop ' + s.full); return p; }
      if (cfg.tier.indexOf(m.t) < 0) { bump(logRef, '层级 ' + m.t + ' 未放行 ' + s.full); return p; }
      if (m.e.indexOf(s.ext) < 0) { bump(logRef, '变体无此扩展 ' + s.ext + ' @' + s.full); return p; }
      var target = m.to || s.dir + '/' + m.v;
      var out = target + '.' + s.ext;
      if (m.src === 'selection') {
        var complete = !!RAW_EXIST;
        var required = m.required || m.e.map(function (e) { return target + '.' + e; });
        for (var ei = 0; complete && ei < required.length; ei++) {
          try { complete = !!RAW_EXIST.call(FU, required[ei]); }
          catch (e) { complete = false; }
        }
        if (!complete) { bump(logRef, '选择目标资源不完整 ' + target); return p; }
      }
      /* 存在性闸：目标不在盘上就绝不指过去 */
      if (RAW_EXIST) {
        var ok = false;
        try { ok = !!RAW_EXIST.call(FU, out); } catch (e) { ok = false; }
        if (!ok) { bump(logRef, '变体不在盘上 ' + out); bump(extra, '缺文件 ' + out); return p; }
      }
      bump(logHit, s.full + '.' + s.ext + ' -> ' + m.v);
      made.hit++;
      if (m.src === 'cfg' || made.hit % 12 === 1) log('HIT ' + (m.src === 'cfg' ? '[cfg加] ' : '') + p + ' -> ' + out);
      return out;
    }

    if (!cfg.nofu) {
      try {
        RAW_EXIST = (typeof FU.isFileExist === 'function') ? FU.isFileExist : null;
        ['getStringFromFile', 'isFileExist'].forEach(function (nm) {
          if (typeof FU[nm] !== 'function') { log('FU 无 ' + nm); return; }
          var old = FU[nm];
          FU[nm] = function (p) {
            if (nm === 'getStringFromFile') { var a = atlasFor(p); if (a !== null) return a; }
            return old.call(FU, rewrite(p));
          };
          log('FU 已包 ' + nm + (cfg.nomap ? '（只观测，不改路径）' : '（参与重定向' + (cfg.noatl ? '' : '+合成图集') + '）'));
        });
      } catch (e) { log('FU 包装抛 ' + e); }
    } else log('FU 按 cfg nofu 完全没包');
    if (!cfg.noatl) { try { log('SHADOW ' + shadowProbe()); } catch (e) { log('SHADOW 抛 ' + type_(e)); } }

    /* 启动桥：纯直通记录前 12 次，日志本身包在 try 里，绝不影响返回值 */
    function armBridge() {
      if (BRIDGEWRAP) return;
      var f = globalThis._external_interface_handler_call;
      if (typeof f !== 'function') return;
      BRIDGEWRAP = true;
      globalThis._external_interface_handler_call = function (type, jstr) {
        made.bridge++;
        if (made.bridge <= 12) { try { bump(extra, 'BRIDGE type=' + String(type) + ' len=' + (jstr ? String(jstr).length : 0)); } catch (e) { } }
        return f.apply(globalThis, arguments);
      };
      log('BRIDGE 已包（直通）');
    }

    /* 卡面动画：官方按已购清单回答，没买回 0；只对有 spine_model 的卡代答，否则纯静态卡会去加载 card/none.scsp */
    var CARD_ARMED = false, CARDGET = null, CARD_ANSWER = 1, CARD_TRAP = false, CARD_HOST = null;
    function hasRig(id) {
      if (!CARDGET) {
        var gs = DBQ ? findFns(DBQ, ['get']) : [];
        if (!gs.length) { if (!made.cardNoGet) log('CARDMOTION 取不到 get ⇒ 一律不代答'); made.cardNoGet++; return false; }
        CARDGET = gs[0];
      }
      try {
        var row = CARDGET.fn.call(CARDGET.host, 'card', String(id));
        if (!row || typeof row !== 'object') return false;
        var s = row.spine_model;
        return !!s && s !== 'none';
      } catch (e) { return false; }
    }
    function wrapCardAnim(host) {
      if (!host || (CARD_ARMED && CARD_HOST === host)) return;
      var f = host.getCardAnimation;
      if (typeof f !== 'function') return;
      try {
        host.getCardAnimation = function () {
          var v = f.apply(this, arguments);
          made.cardAsk++;
          var chosen = CARD_PATCHES[String(arguments[0])];
          if (REDIR_ON && chosen && cardResourcesReady(chosen)) {
            if (chosen.spine_model === 'none') { if (v) made.cardForced++; return 0; }
            if (hasRig(arguments[0])) { if (!v) made.cardForced++; return v || CARD_ANSWER; }
          }
          if (v || !REDIR_ON || cfg.onlyselected) return v;
          if (!hasRig(arguments[0])) { made.cardSkip++; return v; }
          made.cardForced++;
          if (made.cardForced <= 6) log('CARDMOTION 代答 ' + String(arguments[0]) + ' -> ' + CARD_ANSWER);
          return CARD_ANSWER;
        };
        CARD_ARMED = true;
        CARD_HOST = host;
        log('CARDMOTION 已装（只代答有 spine_model 的卡）');
      } catch (e) { log('CARDMOTION 装不上 ' + type_(e)); }
    }
    function armCardMotion() {
      if (CARD_TRAP) { wrapCardAnim(globalThis.CharacterUtil); return; }
      var pd = null, hold;
      try { pd = Object.getOwnPropertyDescriptor(globalThis, 'CharacterUtil'); } catch (e) { }
      hold = (pd && 'value' in pd) ? pd.value : (pd && pd.get ? undefined : globalThis.CharacterUtil);
      if (hold) wrapCardAnim(hold);
      try {
        Object.defineProperty(globalThis, 'CharacterUtil', {
          configurable: true, enumerable: !(pd && pd.enumerable === false),
          get: function () { return hold; },
          set: function (v) { hold = v; wrapCardAnim(v); }
        });
        CARD_TRAP = true;
        log('CARDMOTION trap=' + (CARD_ARMED ? '已装钩子' : '空位等赋值'));
      } catch (e) { log('CARDMOTION trap 装不上 ' + type_(e)); }
    }

    /* ---------- GameResDB：无条件装 trap；观察与行覆盖都推到第一次 create ---------- */
    function armTrap() {
      if (TRAP) return;
      var pd = null;
      try { pd = Object.getOwnPropertyDescriptor(globalThis, 'GameResDB'); } catch (e) { }
      var hold = (pd && 'value' in pd) ? pd.value : (pd && pd.get ? undefined : globalThis.GameResDB);
      if (hold) DBQ = hold;
      try {
        Object.defineProperty(globalThis, 'GameResDB', {
          configurable: true, enumerable: !(pd && pd.enumerable === false),
          get: function () { return hold; },
          set: function (v) { hold = v; DBQ = v; armCardRows(); }
        });
        TRAP = true;
        log('DB trap 装上=' + (typeof globalThis.GameResDB !== 'undefined' ? '可读写' : '空位等赋值') + ' 现值=' + (hold ? '有' : '无'));
      } catch (e) { log('DB trap 装不上 ' + type_(e)); }
    }
    armTrap();
    armCardRows();
    armCardMotion();

    function cardResourcesReady(patch) {
      if (!RAW_EXIST) return false;
      if (patch.relocated && (cfg.nomap || cfg.nofu || cfg.nocreate)) return false;
      try { return patch.resources.every(function (path) { return !!RAW_EXIST.call(FU, path); }); }
      catch (e) { return false; }
    }
    function cardRow(row, key) {
      if (!REDIR_ON || !row || typeof row !== 'object' || Array.isArray(row)) return row;
      var id = String(row.id === undefined ? key : row.id), patch = CARD_PATCHES[id];
      if (!patch || !cardResourcesReady(patch)) return row;
      if (!CARD_ROW_LOG[id]) { CARD_ROW_LOG[id] = true; log('SELECT CARD ' + id + ' sct=' + patch.sct_name + ' spine=' + patch.spine_model); }
      return Object.assign({}, row, { sct_name: patch.sct_name, spine_model: patch.spine_model });
    }
    function armCardRows() {
      if (!DBQ || CARD_DB === DBQ || !Object.keys(CARD_PATCHES).length) return;
      var wrapped = 0;
      ['get', 'getCache', 'getAllCache'].forEach(function (name) {
        var old = DBQ[name];
        if (typeof old !== 'function') return;
        try {
          DBQ[name] = function (table, key) {
            var result = old.apply(this, arguments);
            if (table !== 'card' || !result || typeof result !== 'object' || !REDIR_ON) return result;
            if (result.id !== undefined) return cardRow(result, key);
            if (Array.isArray(result)) return result.map(function (row) { return cardRow(row); });
            var copy = null;
            Object.keys(CARD_PATCHES).forEach(function (id) {
              if (!Object.prototype.hasOwnProperty.call(result, id)) return;
              var replacement = cardRow(result[id], id);
              if (replacement !== result[id]) { if (!copy) copy = Object.assign({}, result); copy[id] = replacement; }
            });
            return copy || result;
          };
          wrapped++;
        } catch (e) { log('SELECT CARD 无法包装 ' + name); }
      });
      if (wrapped) { CARD_DB = DBQ; CARDGET = null; log('SELECT CARD 数据读取入口已包 ' + wrapped); }
    }

    function dbNames(v) {
      var seen = {}, list = [], pr = v, lv = 0;
      while (pr && lv < 4) {
        var pn;
        try { pn = Object.getOwnPropertyNames(pr); } catch (e) { break; }
        for (var i = 0; i < pn.length; i++) if (!seen[pn[i]]) { seen[pn[i]] = 1; list.push(pn[i]); }
        pr = Object.getPrototypeOf(pr); lv++;
      }
      return list;
    }
    function findFns(v, nameList) {
      var names = dbNames(v), pr = v, lv = 0, got = [];
      while (pr && lv < 4) {
        for (var q = 0; q < nameList.length; q++) {
          var want = nameList[q];
          if (names.indexOf(want) < 0) continue;
          var f;
          try { f = pr[want]; } catch (e) { continue; }
          if (typeof f === 'function') got.push({ host: pr, name: want, fn: f });
        }
        pr = Object.getPrototypeOf(pr); lv++;
      }
      return got;
    }
    function readBack(id) {
      var gs = findFns(DBQ, ['get']);
      if (!gs.length) return '取不到 get';
      try {
        var row = gs[0].fn.call(gs[0].host, 'char_base', Number(id));
        if (!row || typeof row !== 'object') return 'get 回来空';
        return 'portrait_ani=' + String(row.portrait_ani) + ' standing=' + String(row.standing_portrait_ani) + ' model=' + String(row.model);
      } catch (e) { return 'get 抛 ' + type_(e); }
    }
    function applyRows() {
      if (cfg.norow) { ROWSTATE = 'cfg norow 关闭'; return; }
      var tb = ROWS['char_base'] || {}, ids = Object.keys(tb);
      if (!ids.length) { ROWSTATE = '没有要覆盖的行'; return; }
      var ap = findFns(DBQ, ['applyClientOverrides'])[0];
      if (ap) {
        try {
          ap.fn.call(ap.host, { revision: REV, tables: { char_base: tb } });
          ROWSTATE = '官方 applyClientOverrides 已调用（' + ids.length + ' 行）';
          log('ROW 走官方通道 ' + ap.name + ' revision=' + REV);
        } catch (e) { ROWSTATE = '官方通道抛 ' + type_(e); log('ROW 官方通道失败 ⇒ 转 get 包装兜底'); }
      }
      if (ROWSTATE.indexOf('已调用') < 0) {
        ROWSTATE = '兜底：包 get 系';
        log('ROW 方法面=' + dbNames(DBQ).slice(0, 50).join(' '));
        var wrapped = {}, gs = findFns(DBQ, ['get', 'getCache', 'getAllCache']);
        gs.forEach(function (g) {
          if (wrapped[g.name]) return; wrapped[g.name] = 1;
          var oldg = g.fn, tbx = tb;
          g.host[g.name] = function (table, key) {
            var row = oldg.apply(g.host, arguments);
            try {
              if (table === 'char_base' && row && typeof row === 'object') {
                var p = tbx[String(key)];
                if (p) { made.rowApplied++; return Object.assign({}, row, p, { id: row.id }); }
              }
            } catch (e) { }
            return row;
          };
          log('ROW 兜底已包 ' + g.name);
        });
        if (!gs.length) ROWSTATE = '既没有 applier 也没有可包的 get ⇒ 只剩路径重定向';
      }
      for (var i = 0; i < ids.length && i < 3; i++) {     /* 只回读 3 条：不在启动期拿表狂问 */
        var rb = readBack(ids[i]); made.rowApplied++;
        var want = 'face/portrait/' + tb[ids[i]].portrait_ani.split('/').pop();
        if (rb.indexOf(want) >= 0) { made.rowReadOk++; ROWLOG.push('OK  char_base[' + ids[i] + '] ' + rb); }
        else { made.rowReadBad++; ROWLOG.push('RED char_base[' + ids[i] + '] 期望含 ' + want + ' 实得 ' + rb); }
      }
      log('ROW 回读(抽样 3) 对=' + made.rowReadOk + ' 不对=' + made.rowReadBad + ' 状态=' + ROWSTATE);
      dump('rows');
    }

    var SPRITE = (cc.Sprite && typeof cc.Sprite.create === 'function') ? cc.Sprite.create : null;
    if (SPRITE) {
      cc.Sprite.create = function (path) {
        var s = stemOf(path), route = s && M[s.full];
        var target = route && route.src === 'selection' && s.ext === 'sct' ? rewrite(path) : path;
        if (target === path) return SPRITE.apply(this, arguments);
        var args = Array.prototype.slice.call(arguments); args[0] = target;
        try {
          var sprite = SPRITE.apply(this, args);
          if (sprite) return sprite;
        } catch (e) { log('SELECT 贴图创建失败，回落原图 ' + path); }
        return SPRITE.apply(this, arguments);
      };
      log('SELECT 静态入口 cc.Sprite.create 已包');
    } else log('SELECT 静态入口不可用，静态改路需核对实际加载入口');
    var ORIG = (typeof sp !== 'undefined' && sp.SkeletonAnimation) ? sp.SkeletonAnimation.create : null;
    function spy(inst, stem, redirected, vaList) {
      if (!inst || inst.__skinHook) return inst;
      inst.__skinHook = 1;
      if (!SURF) {
        try {
          var pr = Object.getPrototypeOf(inst), pn = pr ? Object.getOwnPropertyNames(pr) : [];
          SURF = 1;
          log('SPINE面 自身=' + Object.keys(inst).slice(0, 30).join(' '));
          log('SPINE面 原型=' + pn.slice(0, 70).join(' '));
        } catch (e) { log('SPINE面 读不到 ' + type_(e)); }
      }
      ['setAnimation', 'addAnimation'].forEach(function (nm) {
        if (typeof inst[nm] !== 'function') { bump(extra, '实例无 ' + nm + ' @' + stem); return; }
        var old = inst[nm];
        inst[nm] = function (track, name) {
          var r;
          try { r = old.apply(this, arguments); }
          catch (e) { made.animMiss++; bump(animStem, stem + '|' + (redirected ? '换' : '本') + ' THROW ' + nm + ':' + name); return r; }
          made.animAsk++;
          var bad = (r === undefined || r === null);
          bump(animStem, stem + '|' + (redirected ? '换' : '本') + ' ' + (bad ? 'MISS ' : 'ok ') + nm + ':' + String(name));
          if (bad) {
            made.animMiss++;
            if (cfg.heal && redirected && vaList && vaList.length && String(name) !== 'undefined' && vaList.indexOf(String(name)) < 0) {
              var kk = String(stem).replace(/\.[a-z]+$/, '');
              if (!BLOCKED[kk]) { BLOCKED[kk] = 1; made.heal = (made.heal || 0) + 1;
                log('自愈 拉黑 ' + kk + '：皮肤骨架没有 ' + String(name) + '（它的动画只有 ' + vaList.join(',') + '），后续实例回落本体');
                dump('heal'); flush(); }
            }
            bump(extra, 'ANIMMISS ' + stem + ' 要 ' + String(name) + (redirected ? '（换过的那套里没有）' : '（本体的也没有）'));
            if (made.animMiss < 40) log('ANIMMISS ' + stem + ' ' + nm + '(' + name + ') redirected=' + redirected);
          }
          return r;
        };
      });
      if (typeof inst.setSkin === 'function') {
        var osk = inst.setSkin;
        inst.setSkin = function (n) {
          var r; made.skinAsk++;
          try { r = osk.apply(this, arguments); } catch (e) { made.skinMiss++; bump(skinStem, stem + ' THROW ' + String(n)); return r; }
          var miss = (r === undefined || r === false);
          bump(skinStem, stem + ' ' + (miss ? 'MISS ' : 'ok ') + String(n));
          if (miss) { made.skinMiss++; if (made.skinMiss < 40) log('SKINMISS ' + stem + ' 皮肤名不存在: ' + String(n)); }
          return r;
        };
      }
      return inst;
    }
    var didInit = false;
    function onSafeMoment() {
      armCardRows();
      if (didInit) return;
      didInit = true;
      try { armBridge(); } catch (e) { log('BRIDGE 装不上 ' + type_(e)); }
      try { armCardMotion(); } catch (e) { log('CARDMOTION 装不上 ' + type_(e)); }
      if (DBQ) {
        try {
          var own = Object.keys(DBQ), o = [];
          for (var i = 0; i < own.length && i < 30; i++) o.push(own[i] + ':' + typeof DBQ[own[i]]);
          log('DB面 自身(' + own.length + ')=' + o.join(' '));
          log('DB面 全链=' + dbNames(DBQ).slice(0, 60).join(' '));
        } catch (e) { log('DB 观察抛 ' + type_(e)); }
        try { applyRows(); } catch (e) {
          ROWSTATE = 'applyRows 抛 ' + type_(e);
          log(ROWSTATE + ' | ' + String(e && e.message) + ' | ' + String((e && e.stack) || '').split('\n').slice(0, 3).join(' << '));
        }
      } else log('DB 还没就位（这次 create 时 GameResDB 仍空）⇒ 行覆盖留到下次 create');
    }
    if (ORIG && !cfg.nocreate) {
      function autoOff() {
        if (REDIR_ON) {
          REDIR_ON = false; made.autooff++;
          log('AUTO-OFF 连续 ' + made.fail + ' 次创建失败 ⇒ 只观测不改路径');
        }
      }
      sp.SkeletonAnimation.create = function (a, b, c) {
        if (!DBQ) { armTrap(); if (DBQ) didInit = false; }
        onSafeMoment();
        var s = stemOf(a);
        var na = rewrite(a), nb = rewrite(b);
        var redirected = (na !== a);
        var inst;
        try {
          inst = ORIG.call(sp.SkeletonAnimation, na, nb, c);
          if (!inst && redirected) throw new Error('重定向骨架创建为空');
          made.fail = 0;
        }
        catch (e) {
          made.fail++;
          log('CREATE FAIL ' + na + ' ' + type_(e) + (redirected ? ' ⇒ 回落基名' : ''));
          if (made.fail >= 5) autoOff();
          if (redirected) {
            try { inst = ORIG.call(sp.SkeletonAnimation, a, b, c); log('FALLBACK OK ' + a); bump(logRef, '回落基名 ' + a); }
            catch (e2) { log('FALLBACK 也抛 ' + type_(e2)); throw e; }
          } else throw e;
        }
        made.create++;
        spy(inst, s ? s.full + '.' + s.ext : String(a), redirected, (Object.prototype.hasOwnProperty.call(M, s ? s.full : '') && M[s.full].va) ? M[s.full].va : null);
        if (made.create % 40 === 0) { dump('create'); flush(); }
        return inst;
      };
      log('HOOK create 装上=' + (sp.SkeletonAnimation.create !== ORIG));
    } else if (cfg.nocreate) log('create 按 cfg nocreate 没包');
    else log('HOOK RED 无 sp.SkeletonAnimation.create');

    globalThis.skinRender = {
      build: BUILD,
      made: function () { return { made: made, hit: logHit, refuse: logRef, anim: animStem, skin: skinStem, extra: extra, sampled: SAMPLED, dir: GOOD, cfg: cfg, on: REDIR_ON, rowstate: ROWSTATE, trap: TRAP }; },
      safe: function () { return M; },
      rows: function () { return ROWS; },
      atlases: function () { return ATLKEYS; },
      reApply: function () { made.rowReadOk = 0; made.rowReadBad = 0; ROWLOG.length = 0; if (!DBQ) return 'DB 还没就位'; applyRows(); return ROWSTATE; },
      clearRows: function () {
        var ap = DBQ ? findFns(DBQ, ['applyClientOverrides'])[0] : null;
        if (!ap) return '没有官方 applier';
        try { ap.fn.call(ap.host, { revision: REV + '-off', tables: {} }); return '已清'; } catch (e) { return '清时抛 ' + type_(e); }
      },
      on: function () { REDIR_ON = true; return REDIR_ON; },
      cardmotion: function () { return { armed: CARD_ARMED, ask: made.cardAsk, forced: made.cardForced, skip: made.cardSkip, redir: REDIR_ON }; },
      off: function () {
        REDIR_ON = false; dump('off'); flush();
        if (ORIG && !cfg.nocreate && sp.SkeletonAnimation.create !== ORIG) { try { sp.SkeletonAnimation.create = ORIG; } catch (e) { } }
        return !REDIR_ON;
      },
      dump: function () { return dump('manual') ? '已写 ' + GOOD : '无目录' }
    };
    var cnt = {};
    for (var kk in M) if (M.hasOwnProperty(kk)) cnt[M[kk].t] = (cnt[M[kk].t] || 0) + 1;
    log('READY 路径表=' + Object.keys(M).length + ' 分层=' + JSON.stringify(cnt) + ' 放行层=' + cfg.tier +
      ' 行覆盖=' + Object.keys(ROWS['char_base'] || {}).length + ' 行 合成图集=' + ATLKEYS.length + ' 条 trap=' + TRAP +
      ' 图集合成=' + (cfg.tier.indexOf('M') >= 0 ? '开' : '关(官方图集只支持单页)') + ' 自愈回落=' + (cfg.heal ? '开' : '关(皮肤模型常驻)') +
      ' 卡面动画=' + (CARD_ARMED ? '开' : '等赋值'));
    flush();
  } catch (F) { say(BUILD.toUpperCase() + ' FATAL ' + F + ' | ' + String((F && F.stack) || '').split('\n').slice(0, 3).join(' << ')); }
})();
/* ==== SKINRENDER-END @V@ ==== */
