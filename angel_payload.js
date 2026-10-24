/* Single-character appearance routing. No account, network or process APIs. */
function installAngelSkin(profile, options) {
  'use strict';
  var routes = Object.create(null), ready = false, failed = false, hits = 0;
  var hooked = [], missing = [], events = [];
  var fu = cc.FileUtils.getInstance(), exists = options.exists;
  var character = String(profile && profile.character), skin = String(profile && profile.skin);
  var daily = profile && profile.battle_model, dailyPath = null;
  var jsonFactory = typeof sp !== 'undefined' && sp.SkeletonAnimation &&
    (sp.SkeletonAnimation.createWithJsonFile || sp.SkeletonAnimation.create);
  var supported = ['30084_01', '30113_01', '30093_01', '30115_01', '1056_01', '30097_01', '30075_01', '30117_01', '30134_02'];
  function note(message) {
    events.push(message);
    if (events.length > 30) events.shift();
    options.log('SKIN[' + skin + '] ' + message);
  }
  function validRoute(source, target) {
    if (new RegExp('^(model|face/portrait)/' + character + '(_battle_ready|_front)?\\.(scsp|atlas|sct)$').test(source) ||
        new RegExp('^model_data/' + character + '(_battle_ready)?\\.(srcs|srmd|brmd)$').test(source)) {
      return target === source.replace('/' + character, '/' + skin);
    }
    if (new RegExp('^face/character/[a-z_]+' + character + '\\.sct$').test(source)) {
      return target === source.replace(character + '.sct', skin + '.sct');
    }
    if (skin === '30134_02' && /^effect\/rossweisse_30134_ux_attack_[A-Za-z0-9_]+\.(scsp|atlas|sct)$/.test(source)) {
      return target === source.replace(/\.(scsp|atlas|sct)$/, '_skin.$1');
    }
    return new RegExp('^effect/[A-Za-z0-9_]+_' + character + '_[A-Za-z0-9_]+\\.cfx$').test(source) &&
      target === source.replace('.cfx', '_skin.cfx');
  }
  try {
    if (!profile || profile.schema !== 1 || supported.indexOf(skin) < 0 || skin.split('_')[0] !== character ||
        profile.id !== (skin === '30075_01' ? 'sereniel-beach-1' : 'character-skin-' + skin) ||
        !profile.routes || !Array.isArray(profile.required) || !profile.required.length ||
        profile.required.length > 3000 || typeof exists !== 'function') throw new Error('invalid profile');
    var fallback = profile.portrait_fallbacks || {};
    ['animations', 'skins'].forEach(function (kind) {
      Object.keys(fallback[kind] || {}).forEach(function (name) {
        if (!/^[A-Za-z0-9_]+$/.test(name) || fallback[kind][name] !== (kind === 'skins' ? 'normal' : 'idle')) {
          throw new Error('invalid portrait fallback');
        }
      });
    });
    profile.required.forEach(function (path) {
      if (typeof path !== 'string' || path.indexOf('..') >= 0 ||
          !/^(effect|model|model_data|face\/portrait|face\/character|particle)\/[A-Za-z0-9_-]+\.(scsp|atlas|sct|srcs|srmd|brmd|cfx|particle)$/.test(path)) {
        throw new Error('invalid resource');
      }
    });
    Object.keys(profile.routes).forEach(function (source) {
      var target = profile.routes[source];
      if (!validRoute(source, target) || profile.required.indexOf(target) < 0) throw new Error('invalid route');
      routes[source] = target;
      // Atlas page names use PNG aliases while the archive contains SCT textures.
      if (/\.sct$/.test(source)) routes[source.replace(/\.sct$/, '.png')] = target.replace(/\.sct$/, '.png');
    });
    if (!routes['face/portrait/' + character + '.scsp'] || !routes['face/portrait/' + character + '.atlas'] ||
        !routes['face/portrait/' + character + '.sct']) throw new Error('incomplete profile');
    ready = profile.required.every(function (path) { return !!exists.call(fu, path); });
    if (ready && daily) {
      if (!new RegExp('^skinrender-models/' + skin + '-[0-9a-f]{16}\\.json$').test(daily.file) ||
          !/^[0-9a-f]{8}$/.test(daily.fnv1a) || typeof jsonFactory !== 'function' ||
          !exists.call(fu, daily.file)) throw new Error('daily model unavailable');
      var text = fu.getStringFromFile(daily.file), hash = 2166136261;
      if (typeof text !== 'string' || text.length !== daily.bytes) throw new Error('daily model size mismatch');
      for (var i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
      }
      if (('00000000' + hash.toString(16)).slice(-8) !== daily.fnv1a) throw new Error('daily model checksum mismatch');
      dailyPath = fu.fullPathForFilename(daily.file);
      if (!dailyPath) throw new Error('daily model path unresolved');
      note('日常战斗模型已校验；使用原动作名、时长与事件');
    }
    if (!ready) note('资源不完整，整套保留原样');
  } catch (error) {
    failed = true;
    note('拒绝配置：' + String(error.message || error));
  }
  function rewrite(path) {
    if (!ready || failed || !options.enabled() || typeof path !== 'string') return path;
    var normal = path.replace(/\\/g, '/'), result = null;
    Object.keys(routes).some(function (source) {
      if (normal === source || normal === './' + source ||
          normal.slice(-(source.length + 1)) === '/' + source) {
        result = normal.slice(0, normal.length - source.length) + routes[source];
        return true;
      }
      return false;
    });
    if (result !== null) {
      hits++;
      if (hits <= 12) note(path + ' -> ' + result);
    }
    return result === null ? path : result;
  }
  function wrap(owner, name, indices, nullable, label) {
    if (!owner || typeof owner[name] !== 'function') { missing.push(label); return; }
    var original = owner[name];
    try {
      owner[name] = function () {
        var args = Array.prototype.slice.call(arguments), changed = false;
        indices.forEach(function (index) {
          var value = rewrite(args[index]);
          if (value !== args[index]) changed = true;
          args[index] = value;
        });
        if (!changed) return original.apply(this, arguments);
        try {
          var result;
          if (dailyPath && label.indexOf('SkeletonAnimation.') === 0 &&
              typeof args[0] === 'string' && args[0].replace(/\\/g, '/').endsWith('model/' + skin + '.scsp')) {
            args[0] = dailyPath;
            result = jsonFactory.apply(typeof sp !== 'undefined' ? sp.SkeletonAnimation : this, args);
          } else result = original.apply(this, args);
          if (nullable && !result) throw new Error('resource creation returned empty');
          return adaptPortrait(result, args[0], label);
        } catch (error) {
          failed = true;
          note('加载失败，停止整套替换；回落原资源：' + label);
          return original.apply(this, arguments);
        }
      };
      if (owner[name] === original) throw new Error('read only');
      hooked.push(label);
    } catch (error) { missing.push(label); }
  }
  function adaptPortrait(instance, file, label) {
    if (label.indexOf('SkeletonAnimation.') !== 0 || !instance || typeof file !== 'string' ||
        !file.replace(/\\/g, '/').endsWith('face/portrait/' + skin + '.scsp')) return instance;
    var fallback = profile.portrait_fallbacks || {};
    [['setAnimation', 'animations', 1], ['addAnimation', 'animations', 1], ['setSkin', 'skins', 0]].forEach(function (spec) {
      var original = instance[spec[0]], aliases = fallback[spec[1]] || {};
      if (typeof original !== 'function' || !Object.keys(aliases).length) return;
      instance[spec[0]] = function () {
        var args = Array.prototype.slice.call(arguments), name = args[spec[2]];
        if (!failed && options.enabled() && Object.prototype.hasOwnProperty.call(aliases, name)) {
          args[spec[2]] = aliases[name];
          note('立绘缺少 ' + name + '，使用 ' + aliases[name]);
        }
        return original.apply(this, args);
      };
    });
    return instance;
  }
  if (ready && !failed) {
    // File readers cover model settings, effect scripts and resource lookup.
    ['getStringFromFile', 'getDataFromFile', 'isFileExist', 'fullPathForFilename'].forEach(function (name) {
      wrap(fu, name, [0], name === 'getStringFromFile', 'FileUtils.' + name);
    });
    var skeleton = typeof sp !== 'undefined' ? sp.SkeletonAnimation : null;
    ['create', 'createWithBinaryFile', 'createWithJsonFile'].forEach(function (name) {
      wrap(skeleton, name, [0, 1], true, 'SkeletonAnimation.' + name);
    });
    wrap(cc.Sprite, 'create', [0], true, 'Sprite.create');
    wrap(cc.Sprite && cc.Sprite.prototype, 'initWithFile', [0], true, 'Sprite.initWithFile');
    wrap(cc.Sprite && cc.Sprite.prototype, 'setTexture', [0], false, 'Sprite.setTexture');
    ['addImage', 'addImageAsync'].forEach(function (name) {
      wrap(cc.textureCache, name, [0], name === 'addImage', 'textureCache.' + name);
    });
    wrap(cc.spriteFrameCache, 'addSpriteFrames', [0, 1], false, 'spriteFrameCache.addSpriteFrames');
    if (typeof ccui !== 'undefined') {
      wrap(ccui.ImageView, 'create', [0], true, 'ImageView.create');
      wrap(ccui.ImageView && ccui.ImageView.prototype, 'loadTexture', [0], false, 'ImageView.loadTexture');
    }
    if (hooked.indexOf('SkeletonAnimation.create') < 0 || hooked.indexOf('FileUtils.getStringFromFile') < 0) {
      failed = true;
      note('关键加载入口不可用，整套保留原样');
    }
  }
  var api = {
    status: function () { return { id: profile && profile.id, skin: skin, ready: ready, failed: failed,
      enabled: ready && !failed && options.enabled(), hits: hits, hooked: hooked.slice(),
      unavailable: missing.slice(), events: events.slice(),
      preserved: profile && profile.preserved || ['face/portrait/' + character + '_front', 'model/' + character + '_battle_ready'] }; },
    off: function () { failed = true; note('手动停止，后续加载保留原样；已显示的资源需重新进入场景'); }
  };
  if (!globalThis.characterSkins) globalThis.characterSkins = Object.create(null);
  globalThis.characterSkins[skin] = api;
  if (skin === '30075_01') globalThis.angelSkin = api;
  note('READY ' + JSON.stringify(api.status()));
}
