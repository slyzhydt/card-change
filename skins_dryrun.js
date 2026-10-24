'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const tablePath = arg('--table', null), payloadPath = arg('--payload', null);
const table = tablePath ? JSON.parse(fs.readFileSync(tablePath, 'utf8')) : null;
const ids = ['30084_01','30113_01','30093_01','30115_01','1056_01','30097_01','30075_01','30117_01','30134_02'];
const fixtureFiles = {};
function fnv(text) { let h=2166136261;for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619)>>>0;return h.toString(16).padStart(8,'0'); }
function fixture(skin) {
  const character = skin.split('_')[0], routes = {};
  for (const ext of ['scsp','atlas','sct']) routes[`face/portrait/${character}.${ext}`] = `face/portrait/${skin}.${ext}`;
  routes[`face/character/face_character_${character}.sct`] = `face/character/face_character_${skin}.sct`;
  const battle = ['30075_01','30134_02'].includes(skin);
  for (const ext of ['scsp','atlas','sct']) routes[`model/${character}.${ext}`] = `model/${skin}.${ext}`;
  if (battle) {
    routes[`model_data/${character}.srmd`] = `model_data/${skin}.srmd`;
  }
  let battle_model=null;
  if(!battle) {
    const file=`skinrender-models/${skin}-0123456789abcdef.json`,text=JSON.stringify({animations:{idle:{duration:1.25},hit:{duration:0.2},move:{duration:1},stop:{duration:8}}});
    fixtureFiles[file]=text;battle_model={file,bytes:text.length,fnv1a:fnv(text),aliases:{idle:{motion:'stop',duration:1.25},hit:{motion:'stop',duration:0.2}}};
  }
  return {schema:1, id:skin === '30075_01' ? 'sereniel-beach-1' : 'character-skin-' + skin,
    character, skin, battle, battle_model,routes, required:Object.values(routes), preserved:[], portrait_fallbacks:{animations:{},skins:{}}};
}
const profiles = table ? [table.angel_skin].filter(Boolean).concat(table.character_skins || []) : ids.map(fixture);
const extension = fs.readFileSync(path.join(__dirname,'angel_payload.js'),'utf8');
let count=0, failures=0;
function test(name, passed) {count++;if(!passed)failures++;console.log((passed?'OK ':'RED ')+name);}
function scenario(selected, opts={}) {
  const saved={}, logs=[], calls=[];
  const files={};
  for(const p of selected)if(p.battle_model)files[p.battle_model.file]=fixtureFiles[p.battle_model.file]!==undefined?fixtureFiles[p.battle_model.file]:fs.readFileSync(path.join(path.dirname(tablePath),p.battle_model.file),'ascii');
  if(opts.corrupt)for(const n of Object.keys(files))files[n]=files[n].replace('idle','xxxx');
  const fu={getWritablePath:()=>'/writable/',writeStringToFile:(s,p)=>{saved[p]=s;return true;},
    isFileExist:p=>p!==opts.missing,
    getStringFromFile:p=>files[p]!==undefined?files[p]:p.endsWith('skin_probe.txt')?(saved[p]||''):p.endsWith('skin.cfg')?'':p,
    getDataFromFile:p=>p, fullPathForFilename:p=>p};
  const create=(...args)=>{calls.push(args);return {args,setSkin:n=>n,setAnimation:(t,n)=>n,addAnimation:(t,n)=>n};};
  const createJson=(...args)=>{
    if(opts.jsonFailure)throw Error('native JSON loading failed');
    const data=JSON.parse(files[args[0]]),instance=create(...args);
    function play(trackIndex,name,loop,delay){
      if(!data.animations[name])throw Error('missing native animation '+name);
      return {trackIndex,animation:{name,duration:data.animations[name].duration},loop,delay};
    }
    instance.setAnimation=play;instance.addAnimation=play;return instance;
  };
  const ctx={cc:{FileUtils:{getInstance:()=>fu},Sprite:{create}},sp:{SkeletonAnimation:{create,createWithBinaryFile:create,createWithJsonFile:createJson}},
    _speedLog:s=>logs.push(s), console, profiles:selected,
    options:{exists:fu.isFileExist,enabled:()=>true,log:s=>logs.push(s)}};
  if(opts.unifiedFactory)ctx.sp.SkeletonAnimation={create:(...args)=>files[args[0]]!==undefined?createJson(...args):create(...args)};
  vm.createContext(ctx);
  if(opts.combined) {
    vm.runInContext(fs.readFileSync(payloadPath,'utf8').replace('__SKIN_TABLE__',JSON.stringify(table)).split('@V@').join('test'),ctx);
  } else vm.runInContext(extension+'\nprofiles.forEach(function(p){ installAngelSkin(p,options); });',ctx);
  return {ctx,fu,create:(...a)=>ctx.sp.SkeletonAnimation.create(...a)};
}
for(const p of profiles) {
  const s=scenario([p]), c=p.character;
  test(p.skin+' 可独立启用',s.ctx.characterSkins[p.skin].status().enabled);
  test(p.skin+' 首页立绘',s.create(`face/portrait/${c}.scsp`).args[0]===`face/portrait/${p.skin}.scsp`);
  test(p.skin+' 不改其他角色',s.fu.getDataFromFile('model/99999.scsp')==='model/99999.scsp');
  const source=Object.keys(p.routes).find(n=>n.startsWith('face/character/'));
  test(p.skin+' 静态头像',!source||s.ctx.cc.Sprite.create(source).args[0]===p.routes[source]);
  test(p.skin+' 战斗模型入口',s.create(`model/${c}.scsp`).args[0]===(p.battle_model?p.battle_model.file:p.battle?`model/${p.skin}.scsp`:`model/${c}.scsp`));
}
let s=scenario(profiles);
test('所有选中项同时安装且不覆盖状态',Object.keys(s.ctx.characterSkins).length===profiles.length);
s=scenario(profiles,{missing:profiles[0].required[0]});
test('单套缺资源不拖累其他皮肤',!s.ctx.characterSkins[profiles[0].skin].status().enabled &&
  profiles.slice(1).every(p=>s.ctx.characterSkins[p.skin].status().enabled));
const alias=fixture('30113_01');alias.portrait_fallbacks={animations:{xxxx:'idle'},skins:{special5:'normal'}};
s=scenario([alias]);
const instance=s.create('face/portrait/30113.scsp');
test('缺特殊表情和动作回退到皮肤普通状态',instance.setSkin('special5')==='normal'&&instance.setAnimation(0,'xxxx')==='idle'&&instance.setSkin('sad')==='sad');
const bad=fixture('30113_01');bad.routes['model/30075.scsp']='model/30113_01.scsp';
s=scenario([bad]);
test('非法跨角色改路拒绝',!s.ctx.characterSkins[bad.skin].status().enabled);
const daily=fixture('30113_01');
s=scenario([daily]);
let model=s.create('model/30113.scsp','model/30113.atlas',0.8),entry=model.setAnimation(0,'hit',false),queued=model.addAnimation(0,'idle',true,0.3);
test('日常小人使用原生JSON工厂并保留图集与缩放',model.args[0]===daily.battle_model.file&&model.args[1]==='model/30113_01.atlas'&&model.args[2]===0.8);
test('原动作名与单次完成时长保留',entry.animation.name==='hit'&&entry.animation.duration===0.2&&!entry.loop);
test('队列循环与延迟交由原生动画处理',queued.animation.name==='idle'&&queued.loop&&queued.delay===0.3);
test('移动动作保留',model.setAnimation(0,'move',true).animation.name==='move');
s=scenario([daily],{unifiedFactory:true});
test('本机仅有统一create入口时也加载配套JSON',s.create('model/30113.scsp','model/30113.atlas').setAnimation(0,'hit',false).animation.name==='hit');
test('日常小人不替换原技能配置',s.fu.getStringFromFile('model_data/30113.srmd')==='model_data/30113.srmd');
s=scenario([daily],{missing:daily.battle_model.file});
test('缺配套模型保留原版',!s.ctx.characterSkins[daily.skin].status().enabled&&s.create('model/30113.scsp').args[0]==='model/30113.scsp');
s=scenario([daily],{corrupt:true});
test('同长度损坏的模型也拒绝',!s.ctx.characterSkins[daily.skin].status().enabled);
s=scenario([daily],{jsonFailure:true});
test('JSON工厂失败回落原模型并停用',s.create('model/30113.scsp').args[0]==='model/30113.scsp'&&!s.ctx.characterSkins[daily.skin].status().enabled);
const ros=fixture('30134_02');
for(const ext of ['scsp','atlas','sct'])ros.routes['effect/rossweisse_30134_ux_attack_cutin_01_1_1.'+ext]='effect/rossweisse_30134_ux_attack_cutin_01_1_1_skin.'+ext;
ros.required=Object.values(ros.routes);s=scenario([ros]);
test('罗斯薇瑟大招直接分镜骨架映射',s.create('effect/rossweisse_30134_ux_attack_cutin_01_1_1.scsp').args[0]==='effect/rossweisse_30134_ux_attack_cutin_01_1_1_skin.scsp');
test('大招分镜PNG配套映射',s.fu.fullPathForFilename('effect/rossweisse_30134_ux_attack_cutin_01_1_1.png')==='effect/rossweisse_30134_ux_attack_cutin_01_1_1_skin.png');
if(payloadPath) {
  s=scenario(profiles,{combined:true});
  test('实际合并载荷安装全部选中皮肤',profiles.every(p=>s.ctx.characterSkins&&s.ctx.characterSkins[p.skin]&&s.ctx.characterSkins[p.skin].status().enabled));
}
const expected=profiles.length*5+15+(payloadPath?1:0);
console.log(`合计 ${count} 条（应有 ${expected}），RED ${failures}`);
process.exitCode=failures?1:0;
