"""Build whitelisted character appearance profiles from local assets."""
import json
import copy
import hashlib
from pathlib import Path
import plistlib
import re
import struct
import subprocess

from mapping import MappingError, atomic_json, read_manifest
from runtime_paths import ripper_executable

PROFILE_ID = 'sereniel-beach-1'
EXCEPTIONS = ['face/portrait/30075_front', 'model/30075_battle_ready']
SKINS = {
    '30084_01': '正义后的逗号', '30113_01': '阳光下的青春',
    '30093_01': '为所有人的服务', '30115_01': '波涛中的红色贪婪',
    '1056_01': '愉快的暑假', '30097_01': '枷锁留下的伤口',
    '30075_01': '降临沙滩的天使', '30117_01': '夜海的涟漪',
    '30134_02': '夜空下的金色光芒',
}


def selected_skins(editor):
    values = editor.get('character_skins', [])
    if not isinstance(values, list) or any(not isinstance(v, str) or v not in SKINS for v in values):
        raise MappingError('角色皮肤选择不合法')
    angel = editor.get('angel_skin', False)
    if type(angel) is not bool:
        raise MappingError('天使皮肤开关必须是布尔值')
    return sorted(set(values) | ({'30075_01'} if angel else set()))


def routes_for(paths, character='30075', skin='30075_01'):
    routes = {}
    for folder, extensions in (('face/portrait', ('scsp', 'atlas', 'sct')),
                               ('model', ('scsp', 'atlas', 'sct')),
                               ('model_data', ('srmd', 'srcs'))):
        for ext in extensions:
            target = f'{folder}/{skin}.{ext}'
            if ext == 'srcs' and target not in paths:
                continue
            routes[f'{folder}/{character}.{ext}'] = target
    for target in sorted(paths):
        if re.fullmatch(r'face/character/[a-z_]+' + re.escape(skin) + r'\.sct', target):
            source = target.replace(skin + '.sct', character + '.sct')
            if source in paths:
                routes[source] = target
    return routes


def skeleton_check(root, stem):
    obj = json.loads((root / (stem + '.json')).read_text(encoding='utf-8-sig'))
    atlas = (root / (stem + '.atlas')).read_text(encoding='utf-8-sig')
    regions = {s for s in atlas.splitlines() if s and not s[0].isspace()
               and ':' not in s and not s.endswith('.png')}
    missing = []
    for skin in obj.get('skins', []):
        for slot in skin.get('attachments', {}).values():
            for name, attachment in slot.items():
                if attachment.get('type', 'region') in ('region', 'mesh'):
                    image = attachment.get('path', name)
                    if image not in regions:
                        missing.append(image)
    if missing:
        raise MappingError('皮肤图集缺骨架贴图片段：' + ', '.join(missing[:3]))
    image = (root / (stem + '.png')).read_bytes()
    if image[:8] != b'\x89PNG\r\n\x1a\n':
        raise MappingError('皮肤贴图转换失败：' + stem)
    width, height = struct.unpack_from('>II', image, 16)
    size = re.search(r'^size:\s*(\d+),(\d+)', atlas, re.M)
    if not size or int(size[1]) > width or int(size[2]) > height:
        raise MappingError('皮肤图集尺寸超出贴图：' + stem)
    return obj


def animation_duration(value):
    if isinstance(value, dict):
        return max([float(value.get('time', 0))] +
                   [animation_duration(v) for v in value.values() if isinstance(v, (dict, list))])
    if isinstance(value, list):
        return max([0.0] + [animation_duration(v) for v in value])
    return 0.0


def daily_model(base, target):
    """Keep native names, durations and events; use the skin's stop motion for missing actions."""
    stop = target.get('animations', {}).get('stop')
    stop_duration = animation_duration(stop)
    if not stop_duration or 'move' not in target['animations']:
        raise MappingError('日常小人缺少有效 stop / move 动作')
    result = copy.deepcopy(target)
    aliases = {}
    def trim(value, duration, timelines):
        if isinstance(value, dict):
            for item in value.values():
                if isinstance(item, (dict, list)):
                    trim(item, duration, timelines)
        elif isinstance(value, list):
            if value and all(isinstance(v, dict) and 'time' in v for v in value):
                value[:] = [v for v in value if v['time'] <= duration]
                if value:
                    timelines.append(value)
                return
            for item in value:
                trim(item, duration, timelines)
    for name, original in base['animations'].items():
        if name in result['animations']:
            continue
        duration = animation_duration(original)
        replacement = copy.deepcopy(stop) if duration > 0 else {}
        replacement.pop('events', None)
        timelines = []
        trim(replacement, duration, timelines)
        if duration > 0:
            if not timelines:
                raise MappingError('日常动作缺少有效时间线')
            tail = copy.deepcopy(timelines[0][-1])
            tail['time'] = duration
            timelines[0].append(tail)
            if 'duration' in replacement:
                replacement['duration'] = duration
        if original.get('events'):
            replacement['events'] = copy.deepcopy(original['events'])
        result['animations'][name] = replacement
        aliases[name] = {'motion': 'stop', 'duration': duration}
    result['events'] = dict(target.get('events', {}), **base.get('events', {}))
    return result, aliases


def fnv1a(text):
    value = 2166136261
    for byte in text.encode('ascii'):
        value = ((value ^ byte) * 16777619) & 0xffffffff
    return format(value, '08x')


def write_daily_model(base, target, skin, directory):
    model, aliases = daily_model(base, target)
    text = json.dumps(model, ensure_ascii=True, separators=(',', ':'))
    digest = hashlib.sha256(text.encode('ascii')).hexdigest()
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    filename = skin + '-' + digest[:16] + '.json'
    (directory / filename).write_bytes(text.encode('ascii'))
    return {'file': 'skinrender-models/' + filename, 'sha256': digest,
            'bytes': len(text), 'fnv1a': fnv1a(text), 'aliases': aliases}


def build_profile(manifest, output, log=lambda line: None, skin_id='30075_01', models_directory=None):
    """Export/validate dependencies, never install assets or modify game data."""
    paths, digest = read_manifest(manifest)
    if skin_id not in SKINS:
        raise MappingError('不支持的角色皮肤')
    character = skin_id.split('_')[0]
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    assets = output / 'assets'
    done = set()
    tool = ripper_executable()

    def export(names):
        names = sorted(set(names) - done)
        missing = [n for n in names if n not in paths]
        if missing:
            raise MappingError('天使皮肤缺少资源：' + ', '.join(missing[:3]))
        if not names:
            return
        args = [str(tool), '--pack', str(manifest), '--out', str(assets), '--quiet']
        for name in names:
            args += ['--folder', name]
        result = subprocess.run(args, cwd=output, capture_output=True, text=True,
                                encoding='utf-8', errors='replace', timeout=180,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        with (output / 'exports.txt').open('a', encoding='utf-8') as stream:
            stream.write(result.stdout + result.stderr)
        if result.returncode:
            raise MappingError('天使皮肤资源导出失败，记录：' + str(output))
        done.update(names)

    routes = routes_for(paths, character, skin_id)
    required = set(routes.values())
    initial = set(routes) | required | {'db/combatant_skin_model@combatant_skin_model.db'}
    export(initial)
    rows = json.loads((assets / 'db/combatant_skin_model@combatant_skin_model.json').read_text(encoding='utf-8-sig'))
    row = next((r for r in rows if r.get('id') == skin_id), {})
    if row.get('link_char_base_id') != character or row.get('model') != skin_id:
        raise MappingError('天使皮肤表项与支持的角色不符')
    models = {}
    preserved, configs = [], []
    battle_model = None
    portrait_fallbacks = {'animations': {}, 'skins': {}}
    for folder in ('face/portrait', 'model'):
        base = skeleton_check(assets / folder, character)
        target = skeleton_check(assets / folder, skin_id)
        if base.get('skeleton', {}).get('spine') != target.get('skeleton', {}).get('spine'):
            raise MappingError('默认模型与皮肤骨架版本不同')
        missing_animations = sorted(set(base['animations']) - set(target['animations']))
        if folder == 'face/portrait':
            if not {'idle', 'touch'}.issubset(target['animations']):
                raise MappingError('皮肤缺少首页必要动作：' + skin_id)
            portrait_fallbacks['animations'] = {name: 'idle' for name in missing_animations}
        if missing_animations and folder == 'model':
            battle_model = write_daily_model(base, target, skin_id,
                models_directory or output / 'skinrender-models')
            for source in list(routes):
                if source.startswith('model_data/'):
                    del routes[source]
            preserved.append('model_data/' + character)
        if folder == 'face/portrait':
            if 'normal' not in {s['name'] for s in target['skins']}:
                raise MappingError('皮肤缺少普通表情：' + skin_id)
            portrait_fallbacks['skins'] = {name: 'normal' for name in
                {s['name'] for s in base['skins']} - {s['name'] for s in target['skins']}}
        models[folder] = {'animations': sorted(target['animations']),
                          'skins': [s['name'] for s in target['skins']], 'missing_animations': missing_animations}
        if folder == 'model' and not missing_animations:
            configs.append(('model_data/' + skin_id + '.srmd', target))
    # Only map dedicated special scenes when the paired skeleton supports every base action.
    for folder, suffix, setting_ext in [('model', '_battle_ready', 'brmd'), ('face/portrait', '_front', None)]:
        source, target = folder + '/' + character + suffix, folder + '/' + skin_id + suffix
        family = {stem + '.' + ext for stem in (source, target) for ext in ('scsp', 'atlas', 'sct')}
        if not family.issubset(paths):
            if source + '.scsp' in paths:
                preserved.append(source)
            continue
        export(family)
        a = skeleton_check(assets / folder, character + suffix)
        b = skeleton_check(assets / folder, skin_id + suffix)
        if set(a['animations']) - set(b['animations']):
            preserved.append(source)
            continue
        for ext in ('scsp', 'atlas', 'sct'):
            routes[source + '.' + ext] = target + '.' + ext
        if setting_ext:
            config_source = 'model_data/' + character + suffix + '.' + setting_ext
            config_target = 'model_data/' + skin_id + suffix + '.' + setting_ext
            export([config_target])
            routes[config_source] = config_target
            configs.append((config_target, b))
    required = set(routes.values())
    cfx, direct_skeletons = set(), set()
    for config_name, model in configs:
        bones, slots = {b['name'] for b in model['bones']}, {s['name'] for s in model['slots']}
        settings = json.loads((assets / config_name).read_text(encoding='utf-8-sig'))
        for action in settings['command'].values():
            for entry in action.get('effect', []):
                for field, allowed in (('bone', bones), ('slot', slots)):
                    value = entry.get(field)
                    is_own_attachment = entry.get('type') == 'SELF' and (field == 'slot' or entry.get('bone_type') == 'ATTACH')
                    if is_own_attachment and value and value not in allowed:
                        raise MappingError('皮肤技能配置的挂点不存在：' + str(value))
                if entry.get('file_name'):
                    stem = 'effect/' + entry['file_name']
                    if stem + '.cfx' in paths:
                        cfx.add(stem + '.cfx')
                    else:
                        direct_skeletons.add(stem)
    export(cfx)
    required.update(cfx)
    particles, skeletons = set(), set(direct_skeletons)
    for name in sorted(cfx):
        obj = plistlib.loads((assets / name).read_bytes())
        for primitive in obj.get('primitive', []):
            source, kind = primitive.get('source'), primitive.get('format')
            if not isinstance(source, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', source):
                raise MappingError('技能效果资源名不受支持：' + str(source))
            if kind == 'spine':
                skeletons.add('effect/' + source)
            elif kind == 'particle':
                particles.add('effect/' + source + '.particle')
            else:
                raise MappingError('尚未支持的技能效果类型：' + str(kind))
    dependent = set(particles)
    for stem in skeletons:
        dependent.update(stem + '.' + ext for ext in ('scsp', 'atlas', 'sct'))
    export(dependent)
    required.update(dependent)
    for stem in sorted(skeletons):
        skeleton_check(assets / 'effect', stem.split('/')[-1])
    # Native CFX readers can request the original child skeletons directly.
    effect_aliases = []
    if skin_id == '30134_02':
        pairs, originals = [], set()
        for target in sorted(skeletons):
            if target.startswith('effect/rossweisse_30134_ux_attack_') and target.endswith('_skin'):
                source = target[:-5]
                family = {source + '.' + ext for ext in ('scsp', 'atlas', 'sct')}
                if not family.issubset(paths):
                    raise MappingError('大招分镜缺少原版配套资源：' + source)
                pairs.append((source, target))
                originals.update(family)
        export(originals)
        for source, target in pairs:
            a = skeleton_check(assets / 'effect', source.split('/')[-1])
            b = skeleton_check(assets / 'effect', target.split('/')[-1])
            if a['skeleton']['spine'] != b['skeleton']['spine'] or set(a['animations']) - set(b['animations']):
                raise MappingError('大招分镜骨架不兼容：' + source)
            for ext in ('scsp', 'atlas', 'sct'):
                routes[source + '.' + ext] = target + '.' + ext
            effect_aliases.append(source)
    textures = set()
    for name in particles:
        obj = plistlib.loads((assets / name).read_bytes())
        texture = obj.get('textureFileName')
        if texture and not obj.get('textureImageData'):
            texture = texture.replace('\\', '/')
            if '..' in texture or texture.startswith('/'):
                raise MappingError('粒子贴图路径不受支持：' + texture)
            stem = texture.rsplit('.', 1)[0]
            candidates = [stem + '.sct', 'effect/' + stem + '.sct', 'particle/' + stem + '.sct']
            found = next((n for n in candidates if n in paths), None)
            if not found:
                raise MappingError('粒子效果缺少贴图：' + texture)
            textures.add(found)
    export(textures)
    required.update(textures)
    # Direct effect aliases are for native callers which still request the base effect.
    for target in sorted(cfx):
        if target.endswith('_skin.cfx'):
            source = target.replace('_skin.cfx', '.cfx')
            if source in paths:
                routes[source] = target
    if read_manifest(manifest)[1] != digest:
        raise MappingError('检查期间游戏清单发生变化，请重新生成')
    profile = {'schema': 1, 'id': PROFILE_ID if skin_id == '30075_01' else 'character-skin-' + skin_id,
               'character': character, 'skin': skin_id,
               'manifest_sha256': digest, 'routes': routes, 'required': sorted(required),
               'preserved': preserved, 'battle': not models['model']['missing_animations'],
               'battle_model': battle_model,
               'portrait_fallbacks': portrait_fallbacks}
    atomic_json(output / 'profile.json', profile)
    atomic_json(output / 'offline-proof.json', {'models': models, 'routes': len(routes),
                'cfx': len(cfx), 'effect_skeletons': len(skeletons), 'particles': len(particles),
                'particle_textures': len(textures), 'resources': len(required),
                'bone_and_slot_references_checked': True, 'real_game_tested': False,
                'preserved': preserved, 'battle': profile['battle'], 'portrait_fallbacks': portrait_fallbacks,
                'daily_battle_model': battle_model, 'direct_effect_layers': effect_aliases})
    log('%s：%d 条路径，%d 项资源；%s。' % (SKINS[skin_id], len(routes), len(required),
        '战斗资源兼容' if profile['battle'] else '使用日常小人，保留原动作时长及技能配置'))
    return profile
