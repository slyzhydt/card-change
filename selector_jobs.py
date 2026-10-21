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
    atomic_json(baked_table, {'mode': 'cards_only', 'map': {}, 'rows': {}, 'atlases': {},
                             'revision': 'cards-only-1', 'selection': document})
    try:
        result = engine.produce(str(source), str(executable), str(baked_table),
                                str(resource('payload.js')), manifest=str(manifest), log=log)
        atomic_json(trial / 'mapping-proof.json', {
            'manifest_sha256': document['manifest_sha256'],
            'config_sha256': hashlib.sha256(configuration.read_bytes()).hexdigest(),
            'program_sha256': engine.sha16(str(executable)),
            'source_sha256': result['proof']['src_sha256'],
            'selected_cards': len(document['card_overrides']),
            'selected_resource_routes': len(document['routes']),
            'mode': 'cards_only',
            'configuration_baked': True,
            'real_game_tested': False,
            'installed': False,
        })
    except Exception as exc:
        atomic_json(trial / 'FAILED.json', {'error': str(exc), 'installed': False})
        raise MappingError('测试副本未完成：%s；记录目录：%s' % (exc, trial)) from exc
    return '测试副本已生成：%s。已包含卡牌选择，无需另放配置，旧外部选择配置不读取。尚未安装。' % trial
