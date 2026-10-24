/* 沙箱硬闸：在 vm 里用假引擎真跑载荷，正向都配负向对照，判据 id 从表里现取。
   用法：node dryrun.js [--table table.json] [--payload payload.js] */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const NL = String.fromCharCode(10);

function arg(name, dft) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dft;
}
const HERE = __dirname;
const TABLE_PATH = arg('--table', path.join(HERE, 'table.json'));
const PAYLOAD_PATH = arg('--payload', path.join(HERE, 'payload.js'));
if (!fs.existsSync(TABLE_PATH)) { console.log('RED 找不到表：' + TABLE_PATH); process.exit(1); }
if (!fs.existsSync(PAYLOAD_PATH)) { console.log('RED 找不到载荷：' + PAYLOAD_PATH); process.exit(1); }

const INPUT_TABLE = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf-8'));
// 旧行为使用随源码保存的真实旧表作回归样本；D64 另查实际输入的仅卡牌表。
const TABLE = INPUT_TABLE.mode === 'cards_only' ? JSON.parse(fs.readFileSync(path.join(HERE, 'table.json'), 'utf-8')) : INPUT_TABLE;
const VB = '/* ==== SKINRENDER-BEGIN @V@ ==== */', VE = '/* ==== SKINRENDER-END @V@ ==== */';
const TEMPLATE = fs.readFileSync(PAYLOAD_PATH, 'utf-8')
  .replace(VB, '').replace(VE, '').split('@V@').join('dry');
const RAW = TEMPLATE.replace('__SKIN_TABLE__', JSON.stringify(TABLE));

const FAKE_DIR = '/writ' + 'able/';
const BRANDS = ['cz' + 'n', 'CZ' + 'NSKIN', 'v' + '14', 'LE' + 'GION', 'Chaos' + 'Zero'].join('|');
const ck = [], lines = [];
function T(n, c, i) { ck.push([n, !!c]); lines.push((c ? 'OK   ' : 'RED  ') + n + (i === undefined ? '' : '  → ' + String(i).slice(0, 150))); }
const MAP = TABLE.map || {}, ROWS = (TABLE.rows || {}).char_base || {};
const IDS = Object.keys(ROWS);
const pick = (t, pre) => Object.keys(MAP).filter(k => MAP[k].t === t && (!pre || k.indexOf(pre) === 0))[0];
const L_KEY = pick('L', 'model/'), A_KEY = pick('A', 'model/'), T_KEY = pick('T'), S_KEY = pick('S', 'model_data/');
const P_KEY = Object.keys(MAP).filter(k => k.indexOf('face/portrait/') === 0 && 'AB'.indexOf(MAP[k].t) >= 0)[0];
const want = (key, ext) => key.split('/').slice(0, -1).join('/') + '/' + MAP[key].v + '.' + ext;

function scenario(cfgText, opts) {
  opts = opts || {};
  const LOGS = [], INNER = [], CREATED = [], APPLIED = [], ABS = {}, CALLS = [], SPRITES = [], CREATEARGS = [];
  const BASE = {};
  IDS.forEach(id => { BASE[String(id)] = { id: Number(id), model: Number(id), portrait_ani: 'none', standing_portrait_ani: 'none' }; });
  const OV = {};
  const FU = {
    getWritablePath: () => '/writable/',   /* 假引擎的沙箱路径，故意不带盘符 */
    writeStringToFile: (s, p) => { ABS[String(p)] = String(s); },
    getStringFromFile: (p) => {
      const k = String(p);
      if (k.indexOf('skin_probe.txt') >= 0) return ABS[k] || '';
      if (k.indexOf('skin.cfg') >= 0) return cfgText || '';
      if (k.indexOf('skin_redirects.json') >= 0) return opts.selection || '';
      return '{}';
    },
    isFileExist: (p) => {
      INNER.push(String(p));
      if (String(p).indexOf('skin_redirects.json') >= 0) return Object.prototype.hasOwnProperty.call(opts, 'selection');
      return opts.missingFile === String(p) ? false : (opts.missing ? String(p).indexOf('_01') < 0 : true);
    },
  };
  const gr = {
    clientOverrides: {},
    get: function (t, k) {
      if (t === 'card') return opts.cardRows ? (opts.cardRows[String(k)] || null) : (opts.cardRow === undefined ? { spine_model: 'unique_1' } : opts.cardRow);
      if (t !== 'char_base') return null;
      const b = BASE[String(k)]; if (!b) return null;
      const o = (OV.char_base || {})[String(k)];
      return o ? Object.assign({}, b, o, { id: b.id }) : Object.assign({}, b);
    },
    applyClientOverrides: function (a) { APPLIED.push(a); OV.char_base = (a.tables || {}).char_base || {}; },
    getCache: function (table, key) { return key === undefined ? (opts.cardRows || {}) : this.get(table, key); },
    getAllCache: function () { return opts.cacheArray ? Object.values(opts.cardRows || {}) : (opts.cardRows || {}); },
  };
  const ctx = {
    _speedLog: (m) => LOGS.push(String(m)),
    cc: { FileUtils: { getInstance: () => FU }, Sprite: { create: function (p) {
      SPRITES.push(String(p)); return opts.spriteNull === p ? null : { path: p };
    } } },
    sp: {
      SkeletonAnimation: {
        create: (a, b, c) => {
          CREATED.push(String(a));
          CREATEARGS.push([a, b, c]);
          if (opts.skeletonNull === a) return null;
          return {
            setAnimation(t, n) { return ['idle', 'touch', 'move', 'stop'].indexOf(n) >= 0 ? {} : null; },
            addAnimation(t, n) { return n === 'idle' ? {} : null; },
            setSkin(n) { return n === 'normal'; },
            setName() { }, setToSetupPose() { }, update() { }, setPosition() { }, setScale() { },
          };
        },
      },
    },
    __gr: gr,
    console, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Function,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, TypeError, SyntaxError,
  };
  vm.createContext(ctx);
  vm.runInContext(opts.baked ? TEMPLATE.replace('__SKIN_TABLE__', JSON.stringify(opts.baked)) : RAW, ctx);
  vm.runInContext('GameResDB = __gr', ctx);          // 真机顺序：先跑载荷，DB 之后才被赋值
  if (opts.noCardUtil) return finish();
  ctx.__cu = {
    getCardAnimation: function (id) {
      CALLS.push(String(id));
      return opts.cardOwned === undefined ? 0 : opts.cardOwned;   // 0 = 这角色的卡面动画没买
    }
  };
  vm.runInContext('CharacterUtil = __cu', ctx);      // 赋值即触发载荷装的 trap
  return finish();

  function finish() {
    const api = ctx.skinRender;
    if (api && P_KEY && !opts.noFirstCreate) ctx.sp.SkeletonAnimation.create(P_KEY + '.scsp', 'x', 1);
    return { ctx, LOGS, INNER, CREATED, APPLIED, api, FU, CALLS, SPRITES, CREATEARGS };
  }
}

const A = scenario('');
const LOG = () => A.LOGS.join(NL);
const READY = (A.LOGS.filter(x => /READY/.test(x))[0] || '');
const ALIVE = (A.LOGS.filter(x => /ALIVE/.test(x))[0] || '');

T('D1 缺省放行层是 ABTSL', /放行层=ABTSL/.test(READY), READY.slice(0, 120));
T('D2 日志目录取运行期可写目录',
  ALIVE.indexOf('目录=' + FAKE_DIR) >= 0);
T('D3 表真的进了载荷',
  new RegExp('路径表=' + Object.keys(MAP).length).test(ALIVE), Object.keys(MAP).length);
T('D4 行覆盖走官方通道且回读全对',
  /ROW 走官方通道 applyClientOverrides/.test(LOG()) &&
  (() => { const m = LOG().match(/ROW 回读\(抽样 (\d+)\) 对=(\d+) 不对=(\d+)/);
    return !!m && Number(m[1]) >= 1 && m[2] === m[1] && m[3] === '0'; })(),
  A.LOGS.filter(x => /ROW 回读/.test(x))[0]);
T('D5 官方通道被调用', A.APPLIED.length >= 1, 'APPLIED=' + A.APPLIED.length);
const R6 = (() => {
  if (!A.APPLIED.length) return '假 DB 没收到调用';
  const tb = A.APPLIED[A.APPLIED.length - 1].tables.char_base;
  const ids = Object.keys(tb);
  if (ids.length !== IDS.length) return '行数 ' + ids.length + ' 与表的 ' + IDS.length + ' 不符';
  for (const id of ids) {
    const fam = MAP['face/portrait/' + id];
    if (!fam) return '表里没有这个立绘族 ' + id;
    if (tb[id].portrait_ani !== 'face/portrait/' + fam.v) return id + ' 的 portrait_ani 不对';
    if (tb[id].standing_portrait_ani !== tb[id].portrait_ani) return id + ' 两个字段不一致';
  }
  return true;
})();
T('D6 每行都指向该角色自己的皮肤族', R6 === true,
  R6 === true ? JSON.stringify(A.APPLIED[A.APPLIED.length - 1].tables.char_base[IDS[0]]) : R6);

if (L_KEY) {
  A.ctx.sp.SkeletonAnimation.create(L_KEY + '.scsp', 'a', 1);
  T('D7 L 层换成皮肤骨架',
    A.CREATED[A.CREATED.length - 1] === want(L_KEY, 'scsp'), A.CREATED.slice(-2).join(' | '));
  A.ctx.sp.SkeletonAnimation.create(L_KEY + '.scsp', 'x', 1).setAnimation(0, 'zz_absent_anim', true);
  T('D8 放不出的动画如实记 MISS', A.api.made().made.animMiss >= 1,
    JSON.stringify(A.api.made().anim));
  A.ctx.sp.SkeletonAnimation.create(L_KEY + '.scsp', 'y', 1);
  T('D9 缺省不自愈回落',
    A.api.made().made.heal === 0 && /自愈回落=关/.test(READY), A.CREATED.slice(-2).join(' | '));
  const H = scenario('heal' + NL);
  H.ctx.sp.SkeletonAnimation.create(L_KEY + '.scsp', 'a', 1);
  H.ctx.sp.SkeletonAnimation.create(L_KEY + '.scsp', 'b', 1).setAnimation(0, 'zz_absent_anim', true);
  H.ctx.sp.SkeletonAnimation.create(L_KEY + '.scsp', 'c', 1);
  T('D10 heal 一开安全网就回来',
    H.api.made().made.heal === 1 && H.CREATED[H.CREATED.length - 1] === L_KEY + '.scsp',
    H.CREATED.join(' | '));
  const B = scenario('tier ABTS' + NL);
  B.ctx.sp.SkeletonAnimation.create(L_KEY + '.scsp', 'a', 1);
  T('D11 tier 去掉 L 就不换',
    B.CREATED[B.CREATED.length - 1] === L_KEY + '.scsp' &&
    Object.keys(B.api.made().refuse).some(k => /层级 L 未放行/.test(k)),
    JSON.stringify(B.api.made().refuse).slice(0, 140));
  const DP = scenario('drop ' + L_KEY.split('/')[0] + '/' + NL);
  DP.ctx.sp.SkeletonAnimation.create(L_KEY + '.scsp', 'a', 1);
  T('D12 drop 能收回整目录',
    DP.CREATED[DP.CREATED.length - 1] === L_KEY + '.scsp' &&
    Object.keys(DP.api.made().refuse).some(k => /cfg drop/.test(k)),
    JSON.stringify(DP.api.made().refuse).slice(0, 140));
} else {
  T('表里必须有 L 层', false, '缺 L 层，6 条判据无从谈起');
}

if (A_KEY && S_KEY) {
  A.ctx.sp.SkeletonAnimation.create(A_KEY + '.scsp', 'x', 1);
  T('D13 A 层整族换',
    A.CREATED[A.CREATED.length - 1] === want(A_KEY, 'scsp'), A.CREATED.slice(-2).join(' | '));
  const base = S_KEY.split('/')[1], varn = MAP[S_KEY].v;
  A.FU.isFileExist('model_data/' + base + '.' + MAP[S_KEY].e[0]);
  T('D14 model_data 兄弟表随骨架同源换',
    A.INNER[A.INNER.length - 1] === 'model_data/' + varn + '.' + MAP[S_KEY].e[0],
    A.INNER.slice(-1)[0]);
} else {
  T('表里必须有 A 层与 S 层', false,
    'A=' + String(A_KEY) + ' S=' + String(S_KEY));
}

if (T_KEY) {
  A.FU.isFileExist(T_KEY + '.sct');
  T('D15 T 层纯贴图族只换贴图', A.INNER[A.INNER.length - 1] === want(T_KEY, 'sct'), A.INNER.slice(-1)[0]);
  A.FU.isFileExist(T_KEY + '.scsp');
  T('D16 表里没给的扩展名不换',
    A.INNER[A.INNER.length - 1] === T_KEY + '.scsp', A.INNER.slice(-1)[0]);
} else {
  T('表里必须有 T 层', false, '没有 T 层条目');
}

const MG = scenario('', { missing: true });
if (P_KEY) {
  MG.FU.isFileExist(P_KEY + '.scsp');
  T('D17 变体不在盘上就保持基名',
    MG.INNER[MG.INNER.length - 1] === P_KEY + '.scsp' &&
    Object.keys(MG.api.made().refuse).some(k => /变体不在盘上/.test(k)),
    JSON.stringify(MG.api.made().refuse).slice(0, 140));
} else {
  T('表里必须有立绘族', false, '没有 A/B 层立绘条目');
}

const ADD = scenario('add model/999999 999999_01 scsp' + NL);
ADD.ctx.sp.SkeletonAnimation.create('model/999999.scsp', 'a', 1);
T('D18 add 能现场补映射',
  ADD.CREATED[ADD.CREATED.length - 1] === 'model/999999_01.scsp', ADD.CREATED.slice(-2).join(' | '));

const OFF = scenario('off' + NL);
OFF.ctx.sp.SkeletonAnimation.create(L_KEY || P_KEY || 'model/1', 'a', 1);
T('D19 off 之后一个都不改',
  OFF.api.made().on === false && OFF.api.made().made.hit === 0,
  'on=' + OFF.api.made().on + ' hit=' + OFF.api.made().made.hit);

const NOROW = scenario('norow' + NL);
T('D20 norow 之后不调官方通道',
  NOROW.APPLIED.length === 0, 'APPLIED=' + NOROW.APPLIED.length);

T('D21 令牌全展开、无残留',
  !/@V@|__SKIN_TABLE__/.test(RAW) && /skin\.cfg/.test(RAW) &&
  !(new RegExp(BRANDS, 'i').test(RAW)),
  '载荷 ' + RAW.length + ' B');
const R22 = (() => {
  for (const k of Object.keys(MAP)) {
    const m = MAP[k];
    if ('ABTSLM'.indexOf(m.t) < 0 || m.t.length !== 1) return '层级非法 ' + k;
    if (!Array.isArray(m.e) || !m.e.length) return '没有扩展名 ' + k;
    if (!/^[A-Za-z0-9_.]+$/.test(m.v)) return '变体名非法 ' + k;
    if (k.indexOf('/') < 0) return '基名没有目录 ' + k;
    if (m.t === 'L' && (!Array.isArray(m.va) || !m.va.length)) return 'L 层缺 va ' + k;
  }
  return true;
})();
T('D22 表结构自洽', R22 === true,
  R22 === true ? '条目 ' + Object.keys(MAP).length : R22);
T('D23 合成图集缺省不开',
  /图集合成=关/.test(READY) && !/ATLAS 合成/.test(LOG()), READY.slice(0, 130));

/* 卡面动画：没买回 0，只对有骨架的卡代答 */
const CM1 = scenario('');
const CM1Q = CM1.api.cardmotion();
T('D24 CharacterUtil 一赋值钩子就装上', CM1Q.armed === true, JSON.stringify(CM1Q));
const CM1V = CM1.ctx.CharacterUtil.getCardAnimation('c_1057_srt4_rsp5', 1057);
T('D25 没买的卡被代答成有动画',
  CM1V === 1 && CM1.api.cardmotion().forced === 1, '返回 ' + CM1V + ' 状态 ' + JSON.stringify(CM1.api.cardmotion()));
const CM2 = scenario('', { cardOwned: 7 });
const CM2V = CM2.ctx.CharacterUtil.getCardAnimation('c_30117_uni1', 30117);
T('D26 已购的真值原样放行', CM2V === 7 && CM2.api.cardmotion().forced === 0,
  '返回 ' + CM2V + ' 代答次数 ' + CM2.api.cardmotion().forced);
const CM3 = scenario('off' + NL);
const CM3V = CM3.ctx.CharacterUtil.getCardAnimation('c_1057_srt4_rsp5', 1057);
T('D27 cfg off 时代答也不生效（负控）',
  CM3.api.cardmotion().armed === true && CM3V === 0 && CM3.api.cardmotion().forced === 0,
  'armed=' + CM3.api.cardmotion().armed + ' 返回 ' + CM3V + ' 代答次数 ' + CM3.api.cardmotion().forced);
const CM5 = scenario('', { cardRow: { spine_model: 'none' } });
const CM5V = CM5.ctx.CharacterUtil.getCardAnimation('c_1069_srt1', 1069);
const CM5Q = CM5.api.cardmotion();
T('D28 没有动态骨架的卡不被代答',
  CM5V === 0 && CM5Q.forced === 0 && CM5Q.skip === 1, JSON.stringify(CM5Q) + ' 返回 ' + CM5V);

const route = { enabled: true, source: 'card_illustration/source_card', target: 'card_illustration/target_card', extensions: ['sct'] };
const selection = (routes, useBuiltin) => JSON.stringify({ schema: 1, use_builtin: useBuiltin === undefined ? false : useBuiltin, routes });
const SELECT = scenario('', { selection: selection([route]) });
SELECT.ctx.cc.Sprite.create(route.source + '.sct');
T('D29 选中静态卡面按目标重定向', SELECT.SPRITES.slice(-1)[0] === route.target + '.sct');
SELECT.ctx.cc.Sprite.create('card_illustration/unselected.sct');
T('D30 未选中的卡面保持原路径', SELECT.SPRITES.slice(-1)[0] === 'card_illustration/unselected.sct');
const DISABLED = scenario('', { selection: selection([Object.assign({}, route, { enabled: false })]) });
DISABLED.ctx.cc.Sprite.create(route.source + '.sct');
T('D31 关闭单项后保持原图', DISABLED.SPRITES.slice(-1)[0] === route.source + '.sct');
const ABSENT = scenario('', { selection: selection([route]), missingFile: route.target + '.sct' });
ABSENT.ctx.cc.Sprite.create(route.source + '.sct');
T('D32 目标缺失时保持原图', ABSENT.SPRITES.slice(-1)[0] === route.source + '.sct');
const NULLSPRITE = scenario('', { selection: selection([route]), spriteNull: route.target + '.sct' });
NULLSPRITE.ctx.cc.Sprite.create(route.source + '.sct');
T('D33 目标贴图创建为空时回落原图', NULLSPRITE.SPRITES.slice(-2).join('|') === route.target + '.sct|' + route.source + '.sct');
const rig = { enabled: true, source: 'card/source_rig', target: 'card/target_rig', extensions: ['scsp', 'atlas', 'sct'] };
const RIG = scenario('', { selection: selection([rig]) });
RIG.ctx.sp.SkeletonAnimation.create(rig.source + '.scsp', rig.source + '.atlas', 1);
T('D34 动态卡面骨架和图集同源重定向', RIG.CREATEARGS.slice(-1)[0].slice(0, 2).join('|') === rig.target + '.scsp|' + rig.target + '.atlas');
const PARTIAL = scenario('', { selection: selection([rig]), missingFile: rig.target + '.atlas' });
PARTIAL.ctx.sp.SkeletonAnimation.create(rig.source + '.scsp', rig.source + '.atlas', 1);
T('D35 骨架资源缺一项则整套保留原图', PARTIAL.CREATED.slice(-1)[0] === rig.source + '.scsp');
const NULLRIG = scenario('', { selection: selection([rig]), skeletonNull: rig.target + '.scsp' });
NULLRIG.ctx.sp.SkeletonAnimation.create(rig.source + '.scsp', rig.source + '.atlas', 1);
T('D36 目标骨架创建为空时回落原图', NULLRIG.CREATED.slice(-2).join('|') === rig.target + '.scsp|' + rig.source + '.scsp');
const DUP = scenario('', { selection: selection([route, route]) });
T('D37 同一来源启用多个目标会停止改路', DUP.api.made().on === false && DUP.LOGS.some(x => /SELECT 拒绝/.test(x)));
const INVALID = scenario('', { selection: selection([Object.assign({}, route, { target: '../invalid' })]) });
T('D38 非法路径会停止改路', INVALID.api.made().on === false);
T('D39 仅选择模式不启用内置行覆盖和全卡动画代答', SELECT.APPLIED.length === 0 && SELECT.ctx.CharacterUtil.getCardAnimation('unselected') === 0);
const LEGACY = scenario('', { selection: selection([route], true) });
T('D40 保留内置模式时原有映射仍在', LEGACY.api.safe()[L_KEY] !== undefined && LEGACY.APPLIED.length > 0);
const CROSS = scenario('', { selection: selection([Object.assign({}, route, { target: 'face/character/target_face' })]) });
CROSS.ctx.cc.Sprite.create(route.source + '.sct');
T('D41 静态同类型资源支持跨目录目标', CROSS.SPRITES.slice(-1)[0] === 'face/character/target_face.sct');
const STOPPED = scenario('off' + NL, { selection: selection([route]) });
STOPPED.ctx.cc.Sprite.create(route.source + '.sct');
T('D42 off 时选择配置不改图', STOPPED.SPRITES.slice(-1)[0] === route.source + '.sct');
const ATOMIC = scenario('', { selection: selection([route, Object.assign({}, route, { source: '../invalid' })]) });
ATOMIC.ctx.cc.Sprite.create(route.source + '.sct');
T('D43 配置后项无效时前项也不生效', ATOMIC.SPRITES.slice(-1)[0] === route.source + '.sct' && ATOMIC.api.made().on === false);
const EMPTY = scenario('', { selection: '' });
T('D44 配置文件存在但为空时停止改路', EMPTY.api.made().on === false);
const BROKEN = scenario('', { selection: '{' });
T('D45 配置 JSON 损坏时停止改路', BROKEN.api.made().on === false);

const sourceRows = {
  original: { id: 'original', name: 'original name', cost: '7', link_skill_eff_id: '[original_skill]', sct_name: 'original_image', spine_model: 'none' },
  untouched: { id: 'untouched', sct_name: 'untouched_image', spine_model: 'none' }
};
const displayPatch = { sct_name: 'target_image', spine_model: 'target_rig',
  resources: ['card_illustration/target_image.sct', 'card/target_rig.scsp', 'card/target_rig.atlas', 'card/target_rig.sct'] };
const cardSelection = patch => JSON.stringify({ schema: 1, use_builtin: false, routes: [], card_overrides: { original: patch } });
const CARDS = scenario('', { selection: cardSelection(displayPatch), cardRows: sourceRows });
const patchedRow = CARDS.ctx.GameResDB.get('card', 'original');
T('D46 按卡编号覆盖静态图和动态骨架', patchedRow.sct_name === 'target_image' && patchedRow.spine_model === 'target_rig');
T('D47 保留原卡编号名称费用技能且不改原表', patchedRow.id === 'original' && patchedRow.name === 'original name' && patchedRow.cost === '7' && patchedRow.link_skill_eff_id === '[original_skill]' && sourceRows.original.spine_model === 'none' && patchedRow !== sourceRows.original);
T('D48 仅所选卡启用目标动画', CARDS.ctx.CharacterUtil.getCardAnimation('original') === 1 && CARDS.ctx.CharacterUtil.getCardAnimation('untouched') === 0);
const staticPatch = { sct_name: 'static_target', spine_model: 'none', resources: ['card_illustration/static_target.sct'] };
const STATIC = scenario('', { selection: cardSelection(staticPatch), cardRows: sourceRows, cardOwned: 7 });
T('D49 选择静态目标时不强行加载原卡动画', STATIC.ctx.CharacterUtil.getCardAnimation('original') === 0);
const CARDMISS = scenario('', { selection: cardSelection(displayPatch), cardRows: sourceRows, missingFile: 'card/target_rig.atlas' });
T('D50 卡牌目标资源缺失时整行保持原样', CARDMISS.ctx.GameResDB.get('card', 'original') === sourceRows.original && CARDMISS.ctx.CharacterUtil.getCardAnimation('original') === 0);
const CARDOFF = scenario('off' + NL, { selection: cardSelection(displayPatch), cardRows: sourceRows });
T('D51 off 时不覆盖卡牌显示字段', CARDOFF.ctx.GameResDB.get('card', 'original') === sourceRows.original);
const cachedCards = CARDS.ctx.GameResDB.getAllCache('card');
T('D52 字典缓存只替换选中项且不污染原缓存', cachedCards.original.spine_model === 'target_rig' && cachedCards.untouched === sourceRows.untouched && cachedCards !== sourceRows && sourceRows.original.spine_model === 'none');
const ARRAY = scenario('', { selection: cardSelection(displayPatch), cardRows: sourceRows, cacheArray: true });
T('D53 数组缓存也能读取选中卡面', ARRAY.ctx.GameResDB.getAllCache('card')[0].spine_model === 'target_rig');
const BADFIELD = scenario('', { selection: cardSelection(Object.assign({}, displayPatch, { cost: '0' })), cardRows: sourceRows });
T('D54 配置夹带费用等非显示字段会被拒绝', BADFIELD.api.made().on === false);
const REPLACEDDB = { get: function () { return Object.assign({}, sourceRows.original, { cost: '9' }); } };
CARDS.ctx.GameResDB = REPLACEDDB;
T('D55 数据库重新赋值后重新接入并保留新费用', CARDS.ctx.GameResDB.get('card', 'original').spine_model === 'target_rig' && CARDS.ctx.GameResDB.get('card', 'original').cost === '9');
const EARLY = scenario('', { selection: cardSelection(displayPatch), cardRows: sourceRows, noFirstCreate: true });
T('D56 首次创建骨架之前也能为选中静态卡启用动画', EARLY.CREATED.length === 0 && EARLY.ctx.CharacterUtil.getCardAnimation('original') === 1);
EARLY.ctx.sp.SkeletonAnimation.create('card/target_rig.scsp', 'card/target_rig.atlas', 1);
T('D57 后续初始化不丢失卡面工具对象', typeof EARLY.ctx.CharacterUtil.getCardAnimation === 'function' && EARLY.ctx.CharacterUtil.getCardAnimation('original') === 1);

const embeddedSelection = JSON.parse(cardSelection(displayPatch));
const cardsOnlyTable = { mode: 'cards_only', map: MAP, rows: { char_base: ROWS }, atlases: TABLE.atlases,
  selection: embeddedSelection };
const BAKED = scenario('', { baked: cardsOnlyTable, cardRows: sourceRows, noFirstCreate: true });
T('D58 无外部配置时读取内嵌卡牌选择', BAKED.ctx.GameResDB.get('card', 'original').spine_model === 'target_rig' && BAKED.LOGS.some(x => /内嵌选择/.test(x)));
const STALECFG = scenario('add model/999999 999999_01 scsp' + NL + 'row 1 {"model":"999999"}',
  { baked: cardsOnlyTable, cardRows: sourceRows });
STALECFG.ctx.sp.SkeletonAnimation.create('model/999999.scsp', 'model/999999.atlas', 1);
T('D59 仅卡牌模式屏蔽内置角色换肤及旧配置角色指令', STALECFG.APPLIED.length === 0 && Object.keys(STALECFG.api.safe()).length === 0 && STALECFG.CREATED.slice(-1)[0] === 'model/999999.scsp');
const STALEJSON = scenario('', { baked: cardsOnlyTable, cardRows: sourceRows, selection: selection([route], true) });
T('D60 旧外部选择文件不能覆盖内嵌卡牌或恢复角色换肤', STALEJSON.api.made().on === true && STALEJSON.ctx.GameResDB.get('card', 'original').spine_model === 'target_rig' && STALEJSON.APPLIED.length === 0 && Object.keys(STALEJSON.api.safe()).length === 0);
const BADBAKE = scenario('', { baked: Object.assign({}, cardsOnlyTable, { selection: Object.assign({}, embeddedSelection, { use_builtin: true }) }) });
T('D61 内嵌选择要求明确关闭旧内置映射', BADBAKE.api.made().on === false && BADBAKE.APPLIED.length === 0);
T('D62 仅卡牌模式在首次创建前为选中卡启用目标动画', BAKED.CREATED.length === 0 && BAKED.ctx.CharacterUtil.getCardAnimation('original') === 1 && BAKED.ctx.CharacterUtil.getCardAnimation('untouched') === 0);
const BAKEMISS = scenario('', { baked: cardsOnlyTable, cardRows: sourceRows, missingFile: 'card/target_rig.atlas' });
T('D63 内嵌动态目标缺资源时保留原卡数据', BAKEMISS.ctx.GameResDB.get('card', 'original') === sourceRows.original && BAKEMISS.ctx.CharacterUtil.getCardAnimation('original') === 0);
const actualInput = INPUT_TABLE.mode === 'cards_only' ? INPUT_TABLE : { mode: 'cards_only', map: {}, rows: {}, selection: embeddedSelection };
const ACTUAL = scenario('', { baked: actualInput, cardRows: sourceRows });
const actualMappings = ACTUAL.api.safe();
T('D64 实际输入的仅卡牌表无角色覆盖或任意路径改路', ACTUAL.api.made().on === true && ACTUAL.APPLIED.length === 0 && Object.keys(actualMappings).every(k => /^card\//.test(k) && /^effect\//.test(actualMappings[k].to)));

const effectPatch = { sct_name: 'none', spine_model: 'effect_alternate', spine_directory: 'effect',
  spine_layers: ['bg', 'eff'], spine_cfx: true, resources: [] };
['', '_bg', '_eff'].forEach(s => ['scsp', 'atlas', 'sct'].forEach(e => effectPatch.resources.push('effect/effect_alternate' + s + '.' + e)));
effectPatch.resources.push('effect/effect_alternate.cfx');
const effectTable = Object.assign({}, cardsOnlyTable, { selection: JSON.parse(cardSelection(effectPatch)) });
const EFFECT = scenario('', { baked: effectTable, cardRows: sourceRows });
const effectRow = EFFECT.ctx.GameResDB.get('card', 'original');
T('D65 effect 目录卡面保留原卡非显示字段', effectRow.spine_model === 'effect_alternate' && effectRow.cost === '7' && effectRow.link_skill_eff_id === '[original_skill]' && effectRow.id === 'original' && sourceRows.original.spine_model === 'none' && !Object.prototype.hasOwnProperty.call(effectRow, 'spine_directory'));
EFFECT.ctx.sp.SkeletonAnimation.create('card/effect_alternate.scsp', 'card/effect_alternate.atlas', 1);
T('D66 卡面主骨架与图集一起跨目录加载', EFFECT.CREATEARGS.slice(-1)[0].slice(0, 2).join('|') === 'effect/effect_alternate.scsp|effect/effect_alternate.atlas');
EFFECT.ctx.sp.SkeletonAnimation.create('card/effect_alternate_bg.scsp', 'card/effect_alternate_bg.atlas', 1);
EFFECT.ctx.sp.SkeletonAnimation.create('card/effect_alternate_eff.scsp', 'card/effect_alternate_eff.atlas', 1);
EFFECT.FU.isFileExist('card/effect_alternate.cfx');
T('D67 背景效果层与配套 cfx 都走实际目录', EFFECT.CREATEARGS.slice(-2).map(a => a[0]).join('|') === 'effect/effect_alternate_bg.scsp|effect/effect_alternate_eff.scsp' && EFFECT.INNER.slice(-1)[0] === 'effect/effect_alternate.cfx');
const EFFECTMISS = scenario('', { baked: effectTable, cardRows: sourceRows, missingFile: 'effect/effect_alternate_bg.atlas' });
EFFECTMISS.ctx.sp.SkeletonAnimation.create('card/effect_alternate.scsp', 'card/effect_alternate.atlas', 1);
T('D68 配套资源缺失则原卡数据与跨目录改路一起停用', EFFECTMISS.ctx.GameResDB.get('card', 'original') === sourceRows.original && EFFECTMISS.CREATED.slice(-1)[0] === 'card/effect_alternate.scsp' && EFFECTMISS.ctx.CharacterUtil.getCardAnimation('original') === 0);
const EFFECTROLE = scenario('', { baked: Object.assign({}, effectTable, { selection: JSON.parse(cardSelection(Object.assign({}, effectPatch, { spine_directory: 'model' }))) }) });
T('D69 卡牌目录字段不能用来恢复角色换肤', EFFECTROLE.api.made().on === false && EFFECTROLE.APPLIED.length === 0);
const EFFECTNOFU = scenario('nofu' + NL, { baked: effectTable, cardRows: sourceRows });
T('D70 禁用改路入口时跨目录卡也保持原数据', EFFECTNOFU.ctx.GameResDB.get('card', 'original') === sourceRows.original && EFFECTNOFU.ctx.CharacterUtil.getCardAnimation('original') === 0);
EFFECT.ctx.sp.SkeletonAnimation.create('card/unselected.scsp', 'card/unselected.atlas', 1);
T('D71 非选中卡与其他资源不受跨目录配置影响', EFFECT.ctx.GameResDB.get('card', 'untouched') === sourceRows.untouched && EFFECT.CREATED.slice(-1)[0] === 'card/unselected.scsp' && EFFECT.APPLIED.length === 0);
const EFFECTBAD = scenario('', { baked: Object.assign({}, effectTable, { selection: JSON.parse(cardSelection(Object.assign({}, effectPatch, { spine_layers: ['bg', '../model'] }))) }) });
T('D72 非法配套层停止整个选择配置', EFFECTBAD.api.made().on === false);

const inputPatches = actualInput.selection.card_overrides || {};
const inputRows = {__whole_card_unselected: {id:'__whole_card_unselected',cost:'19',sct_name:'original_image',spine_model:'none'}};
Object.keys(inputPatches).forEach(id=>{inputRows[id]={id,name:'name_'+id,cost:'7',link_skill_eff_id:'[original_skill]',sct_name:'original_image',spine_model:'none'};});
const WHOLE = scenario('', {baked:actualInput,cardRows:inputRows,noFirstCreate:true});
T('D73 实际配置所有展开编号使用各自目标且保留玩法字段',Object.keys(inputPatches).every(id=>{
  const row=WHOLE.ctx.GameResDB.get('card',id), p=inputPatches[id];
  return row.id===id&&row.cost==='7'&&row.link_skill_eff_id==='[original_skill]'&&row.sct_name===p.sct_name&&row.spine_model===p.spine_model&&inputRows[id].spine_model==='none';
}));
T('D74 实际整卡动态状态全部统一且未选卡不变',Object.keys(inputPatches).every(id=>WHOLE.ctx.CharacterUtil.getCardAnimation(id)===(inputPatches[id].spine_model==='none'?0:1))&&WHOLE.ctx.GameResDB.get('card','__whole_card_unselected')===inputRows.__whole_card_unselected);
const largePatches={},largeRows={};
for(let i=0;i<1001;i++){const id='grouped_'+i;largePatches[id]=displayPatch;largeRows[id]={id,cost:'7',spine_model:'none'};}
const LARGE=scenario('',{baked:Object.assign({},cardsOnlyTable,{selection:Object.assign({},embeddedSelection,{card_overrides:largePatches})}),cardRows:largeRows,noFirstCreate:true});
T('D75 整卡展开超过一千编号仍可在容量内加载',LARGE.api.made().on===true&&LARGE.ctx.GameResDB.get('card','grouped_1000').spine_model==='target_rig');

const bad = ck.filter(c => !c[1]).length;
const SHOULD = 75;
console.log(lines.join(NL));
console.log(NL + '合计 ' + ck.length + ' 条（应有 ' + SHOULD + '），RED ' + bad);
process.exit((bad || ck.length !== SHOULD) ? 1 : 0);
