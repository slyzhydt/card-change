"""选择器的单图导出与独立测试副本生成。"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from mapping import MappingError, atomic_json
from runtime_paths import APP_DIR, ripper_executable, resource

HERE = APP_DIR


def compose_payload(text):
    marker = '/* ANGEL_SKIN_EXTENSION */'
    if text.count(marker) != 1:
        raise MappingError('天使皮肤加载位置不唯一，不能生成')
    extension = resource('angel_payload.js').read_text(encoding='utf-8')
    return text.replace(marker, extension + '\nif (BAKED.angel_skin) installAngelSkin(BAKED.angel_skin, {\n'
                        '  exists: RAW_EXIST, log: log,\n'
                        '  enabled: function () { return REDIR_ON && !cfg.off && !cfg.nomap && !cfg.nofu && !cfg.nocreate; }\n'
                        '});\n(BAKED.character_skins || []).forEach(function (profile) { installAngelSkin(profile, {\n'
                        '  exists: RAW_EXIST, log: log,\n'
                        '  enabled: function () { return REDIR_ON && !cfg.off && !cfg.nomap && !cfg.nofu && !cfg.nocreate; }\n'
                        '}); });\n')


def extract_preview(manifest, stem):
    if not isinstance(stem, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', stem):
        raise MappingError('图片名称不合法')
    tool = ripper_executable()
    digest = hashlib.sha256(Path(manifest).read_bytes()).hexdigest()[:12]
    output = HERE / 'work' / 'previews' / digest
    image = output / 'card_illustration' / (stem + '.png')
    if image.is_file() and image.read_bytes()[:8] == b'\x89PNG\r\n\x1a\n':
        return image
    output.mkdir(parents=True, exist_ok=True)
    result = subprocess.run([str(tool), '--pack', str(manifest), '--out', str(output),
                             '--folder', 'card_illustration/' + stem + '.sct', '--quiet'],
                            capture_output=True, text=True, encoding='utf-8', errors='replace',
                            cwd=output, timeout=60,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode or not image.is_file() or image.read_bytes()[:8] != b'\x89PNG\r\n\x1a\n':
        raise MappingError('图片未成功导出，请查看导出目录中的日志：' + str(output))
    return image


def build_trial(source, document, manifest, log=print):
    runtime = HERE / 'work' / 'selector-runtime'
    if runtime.is_dir() and str(runtime) not in sys.path:
        sys.path.insert(0, str(runtime))
    import engine
    try:
        import pefile  # noqa: F401
    except ImportError as exc:
        raise MappingError('缺少 pefile 读取组件；配置保存与选择界面仍可使用') from exc
    if document.get('manifest_sha256') != hashlib.sha256(Path(manifest).read_bytes()).hexdigest():
        raise MappingError('资源清单在选择后发生变化，请刷新数据再生成')
    output = HERE / 'out'
    output.mkdir(exist_ok=True)
    trial = Path(tempfile.mkdtemp(prefix='trial-', dir=output))
    configuration = trial / 'skin_redirects.json'
    executable = trial / 'game-mapped.exe'
    atomic_json(configuration, document)
    baked_table = trial / 'cards-only-table.json'
    try:
        from angel_skin import build_profile, selected_skins
        skins = selected_skins(document.get('_editor', {}))
        angel = '30075_01' in skins
        table = {'mode': 'cards_only', 'map': {}, 'rows': {}, 'atlases': {},
                 'revision': 'cards-only-1', 'selection': document}
        payload = resource('payload.js')
        for skin in skins:
            profile = build_profile(manifest, trial / 'skin-check' / skin, log, skin_id=skin,
                                    models_directory=trial / 'skinrender-models')
            if profile['manifest_sha256'] != document['manifest_sha256']:
                raise MappingError('皮肤检查与卡牌配置的清单版本不同，请刷新后重新生成')
            if skin == '30075_01':
                table['angel_skin'] = profile
            else:
                table.setdefault('character_skins', []).append(profile)
        if skins:
            payload = trial / 'combined-payload.js'
            payload.write_text(compose_payload(resource('payload.js').read_text(encoding='utf-8')), encoding='utf-8')
        atomic_json(baked_table, table)
        if angel:
            count, _ = engine.node_gate(str(resource('angel_dryrun.js')), str(baked_table), str(payload), log)
            log('天使皮肤沙箱检查通过：%d 项' % count)
        if skins:
            count, _ = engine.node_gate(str(resource('skins_dryrun.js')), str(baked_table), str(payload), log)
            log('多皮肤沙箱检查通过：%d 项' % count)
        result = engine.produce(str(source), str(executable), str(baked_table),
                                str(payload), manifest=str(manifest), log=log)
        atomic_json(trial / 'mapping-proof.json', {
            'manifest_sha256': document['manifest_sha256'],
            'config_sha256': hashlib.sha256(configuration.read_bytes()).hexdigest(),
            'program_sha256': engine.sha16(str(executable)),
            'source_sha256': result['proof']['src_sha256'],
            'selected_cards': sum(item.get('enabled') is True for item in document.get('_editor', {}).get('selections', [])),
            'expanded_card_ids': len(document['card_overrides']),
            'selected_resource_routes': len(document['routes']),
            'mode': 'cards_only',
            'angel_skin_enabled': angel,
            'character_skins': skins,
            'configuration_baked': True,
            'real_game_tested': False,
            'installed': False,
            'companion_models': [p['battle_model'] for p in
                ([table['angel_skin']] if angel else []) + table.get('character_skins', [])
                if p.get('battle_model')],
        })
    except Exception as exc:
        atomic_json(trial / 'FAILED.json', {'error': str(exc), 'installed': False})
        raise MappingError('测试副本未完成：%s；记录目录：%s' % (exc, trial)) from exc
    return '测试副本已生成：%s。已包含卡牌选择%s，无需另放配置。%s尚未安装。' % (
        trial, '和 %d 套角色皮肤外观' % len(skins) if skins else '',
        '请将 skinrender-models 文件夹与游戏程序一起放置。' if (trial / 'skinrender-models').exists() else '')
