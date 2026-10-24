'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const tablePath = arg('--table', null), payloadPath = arg('--payload', null);
const provided = tablePath ? JSON.parse(fs.readFileSync(tablePath, 'utf8')) : null;
const routes = {};
for (const folder of ['model', 'face/portrait']) for (const ext of ['scsp', 'atlas', 'sct']) routes[`${folder}/30075.${ext}`] = `${folder}/30075_01.${ext}`;
for (const ext of ['srmd', 'srcs']) routes[`model_data/30075.${ext}`] = `model_data/30075_01.${ext}`;
routes['face/character/face_character_30075.sct'] = 'face/character/face_character_30075_01.sct';
const fixture = { schema: 1, id: 'sereniel-beach-1', character: '30075', skin: '30075_01', routes, required: Object.values(routes) };
const profile = provided && provided.angel_skin || fixture;
const extension = fs.readFileSync(path.join(__dirname, 'angel_payload.js'), 'utf8');
let count = 0, failed = 0;
function test(name, ok) { count++; if (!ok) failed++; console.log((ok ? 'OK ' : 'RED ') + name); }
function scenario(opts = {}) {
  const calls = [], files = {}, logs = [];
  const fu = {
    getWritablePath: () => '/writable/',
    writeStringToFile: (value, file) => { files[file] = value; return true; },
    getStringFromFile: file => {
      if (file.endsWith('skin.cfg')) return opts.cfg || '';
      if (file.endsWith('skin_probe.txt')) return files[file] || '';
      if (opts.throwFile === file) throw new Error('read failure');
      return file;
    },
    getDataFromFile: file => file,
    isFileExist: file => file !== opts.missing,
    fullPathForFilename: file => '/archive/' + file,
  };
  const create = function (...args) { calls.push(args); if (args[0] === opts.nullFile) return null; return { args }; };
  function Sprite() {}
  Sprite.create = create;
  Sprite.prototype.setTexture = function (file) { this.file = file; };
  Sprite.prototype.initWithFile = function (file) { this.file = file; return true; };
  const cc = { FileUtils: { getInstance: () => fu }, Sprite,
    textureCache: { addImage: create, addImageAsync: create }, spriteFrameCache: { addSpriteFrames: create } };
  const ctx = { cc, sp: { SkeletonAnimation: { create } }, console,
    _speedLog: message => logs.push(message), opts, options: { exists: fu.isFileExist,
      log: message => logs.push(message), enabled: () => !opts.off } };
  ctx.profile = opts.profile || JSON.parse(JSON.stringify(profile));
  vm.createContext(ctx);
  if (opts.combined) {
    const baked = opts.baked || provided || {mode: 'cards_only', map: {}, rows: {}, atlases: {}, revision: 'test',
      selection: {schema: 1, use_builtin: false, routes: [], card_overrides: {}}, angel_skin: ctx.profile};
    let code = fs.readFileSync(payloadPath, 'utf8').replace('__SKIN_TABLE__', JSON.stringify(baked)).split('@V@').join('test');
    vm.runInContext(code, ctx);
  } else {
    vm.runInContext(extension + '\ninstallAngelSkin(profile, options);', ctx);
  }
  return { ctx, fu, cc, calls, logs, state: () => ctx.angelSkin.status(),
    skeleton: (...args) => ctx.sp.SkeletonAnimation.create(...args) };
}
let s = scenario();
test('首页骨架和图集一起替换', s.skeleton('face/portrait/30075.scsp', 'face/portrait/30075.atlas', 0.7).args.join('|') === 'face/portrait/30075_01.scsp|face/portrait/30075_01.atlas|0.7');
test('战斗骨架替换', s.skeleton('model/30075.scsp', 'model/30075.atlas').args[0] === 'model/30075_01.scsp');
test('动作与技能配置替换', s.fu.getStringFromFile('model_data/30075.srmd') === 'model_data/30075_01.srmd');
test('动作组合配置替换', s.fu.getDataFromFile('model_data/30075.srcs') === 'model_data/30075_01.srcs');
test('静态头像替换', s.cc.Sprite.create('face/character/face_character_30075.sct').args[0] === 'face/character/face_character_30075_01.sct');
test('纹理缓存入口替换', s.cc.textureCache.addImage('model/30075.png').args[0] === 'model/30075_01.png');
test('已有Sprite换贴图保留this', (() => { const x = new s.cc.Sprite(); x.setTexture('face/character/face_character_30075.sct'); return x.file.endsWith('_01.sct'); })());
test('绝对路径和反斜杠可识别', s.fu.getDataFromFile('C:\\game\\model\\30075.sct') === 'C:/game/model/30075_01.sct');
test('其他角色不变', s.skeleton('model/30084.scsp', 'model/30084.atlas').args[0] === 'model/30084.scsp');
test('战前特殊演出不变', s.skeleton('model/30075_battle_ready.scsp').args[0] === 'model/30075_battle_ready.scsp');
test('正面特殊立绘不变', s.skeleton('face/portrait/30075_front.scsp').args[0] === 'face/portrait/30075_front.scsp');
test('卡面资源不变', s.fu.getDataFromFile('card/unique_30075_01.sct') === 'card/unique_30075_01.sct');
test('非字符串纹理对象不变', (() => { const texture = {}; return s.cc.textureCache.addImage(texture).args[0] === texture; })());
s = scenario({missing: profile.required[0]});
test('缺任意配套资源整套不应用', !s.state().enabled && s.fu.getDataFromFile('model_data/30075.srmd') === 'model_data/30075.srmd');
s = scenario({off: true});
test('关闭时全部直通', s.skeleton('model/30075.scsp').args[0] === 'model/30075.scsp');
s = scenario({nullFile: 'model/30075_01.scsp'});
test('骨架创建失败回落原模型', s.skeleton('model/30075.scsp').args[0] === 'model/30075.scsp' && s.state().failed);
test('失败后配置也回落', s.fu.getDataFromFile('model_data/30075.srmd') === 'model_data/30075.srmd');
s = scenario({throwFile: 'model_data/30075_01.srmd'});
test('配置读取失败回落', s.fu.getStringFromFile('model_data/30075.srmd') === 'model_data/30075.srmd' && s.state().failed);
const bad = JSON.parse(JSON.stringify(profile)); bad.routes['model/30084.scsp'] = 'model/30075_01.scsp';
s = scenario({profile: bad});
test('拒绝跨角色或任意路径配置', s.state().failed && s.skeleton('model/30075.scsp').args[0] === 'model/30075.scsp');
s = scenario(); s.ctx.angelSkin.off();
test('手动停止后直通', s.fu.getDataFromFile('model_data/30075.srcs') === 'model_data/30075.srcs');
test('声明两个保留场景', s.state().preserved.length === 2);
if (payloadPath) {
  s = scenario({combined: true});
  test('实际合并载荷已安装天使入口', !!s.ctx.angelSkin && s.state().enabled);
  test('实际合并载荷可读皮肤技能配置', s.fu.getStringFromFile('model_data/30075.srmd') === 'model_data/30075_01.srmd');
  s = scenario({combined: true, cfg: 'off'});
  test('实际合并载荷遵守原off开关', !s.state().enabled && s.fu.getStringFromFile('model_data/30075.srmd') === 'model_data/30075.srmd');
  const mixed = {mode: 'cards_only', map: {}, rows: {}, atlases: {}, revision: 'mixed', angel_skin: profile,
    selection: {schema: 1, use_builtin: false, routes: [], card_overrides: {
      c_1003_srt1: {sct_name: 'new_art', spine_model: 'none', resources: ['card_illustration/new_art.sct']}}}};
  s = scenario({combined: true, baked: mixed});
  s.ctx.GameResDB = {get: (table, id) => ({id, cost: '7', sct_name: 'old_art', spine_model: 'none'})};
  const card = s.ctx.GameResDB.get('card', 'c_1003_srt1');
  test('卡面和皮肤同时生效且保留玩法字段', card.sct_name === 'new_art' && card.cost === '7' &&
    s.fu.getDataFromFile('model_data/30075.srcs') === 'model_data/30075_01.srcs');
}
console.log(`合计 ${count} 条（应有 ${payloadPath ? 25 : 21}），RED ${failed}`);
process.exitCode = failed ? 1 : 0;
