"""Prepare a version-checked local catalogue without shipping game data."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

from mapping import MappingError, atomic_json, read_manifest
from runtime_paths import APP_DIR, resource, ripper_executable


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def text_labels(raw, wanted, key):
    """PLPcK reader adapted from the MIT-licensed ASSet Ripper DB parser."""
    if len(raw) < 38 or len(key) != 256:
        raise MappingError('名称数据库头不完整')
    rotations = [i for i in range(256) if all(raw[j] ^ key[(j + i) % 256] == b'PLPcK'[j] for j in range(5))]
    if len(rotations) != 1:
        raise MappingError('名称数据库格式无法识别')
    data = bytes(v ^ key[(i + rotations[0]) % 256] for i, v in enumerate(raw))
    def uint(pos, size):
        if pos < 0 or pos + size > len(data):
            raise MappingError('名称数据库范围越界')
        return int.from_bytes(data[pos:pos + size], 'little')
    def uint40(pos):
        return (uint(pos, 1) << 32) + uint(pos + 1, 4)
    if uint(6, 2) != 38:
        raise MappingError('名称数据库版本不支持')
    count, offset = uint(21, 4), uint40(25)
    if offset + 5 * (count + 1) > len(data) or uint(offset, 4) != 5 * (count + 1) or uint(offset + 4, 1) != 1:
        raise MappingError('名称数据库索引范围错误')
    labels, seen = {}, set()
    for index in range(count):
        pos = uint40(offset + 5 + index * 5)
        while pos:
            if pos in seen:
                raise MappingError('名称数据库存在循环引用')
            seen.add(pos)
            name_size, value_size = uint(pos + 5, 1), uint(pos + 6, 4)
            start, end = pos + 15, pos + 15 + name_size + value_size
            if end > len(data):
                raise MappingError('名称条目范围越界')
            name = data[start:start + name_size].decode('utf-8')
            if name in wanted:
                value = data[start + name_size:end].decode('utf-8').rstrip('\0')
                labels[name] = value[len(name) + 1:] if value.startswith(name + '\0') else value
            pos = uint40(pos + 10)
    return labels


def run_export(tool, manifest, output, names, log, raw=False):
    args = [str(tool), '--pack', str(manifest), '--out', str(output), '--quiet']
    for name in names:
        args += ['--folder', name]
    if raw:
        args += ['--no-json']
    result = subprocess.run(args, cwd=output.parent, capture_output=True, text=True,
                            encoding='utf-8', errors='replace', timeout=180,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    (output.parent / ('text-export.txt' if raw else 'table-export.txt')).write_text(
        result.stdout + result.stderr, encoding='utf-8')
    if result.returncode:
        raise MappingError('资源导出未完成，请确认资源已下载齐全。记录：' + str(output.parent))
    log('资源导出完成，正在核对内容……')


def prepare_catalog(manifest, log=lambda message: None, data_root=None):
    manifest = Path(manifest).resolve()
    paths, manifest_sha = read_manifest(manifest)
    tool = ripper_executable()
    data_root = Path(data_root) if data_root is not None else APP_DIR / 'data'
    data_root.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix='catalog-' + manifest_sha[:12] + '-', dir=data_root))
    names = sorted(p for p in paths if re.fullmatch(r'db/[^/]+@(card|card_skin|char_base)\.db', p))
    if not names:
        raise MappingError('当前资源清单没有找到支持的卡牌分表')
    log('正在从本地游戏资源准备卡牌数据……')
    run_export(tool, manifest, output / 'converted', names, log)
    receipt = {'manifest_sha256': manifest_sha, 'tables': {}, 'ripper_sha256': digest(tool)}
    wanted = set()
    for table in ('card', 'card_skin', 'char_base'):
        rows, seen, columns = [], set(), None
        for name in names:
            if not name.endswith('@' + table + '.db'):
                continue
            path = output / 'converted' / Path(name).with_suffix('.json')
            contents = json.loads(path.read_text(encoding='utf-8-sig'))
            if not isinstance(contents, list) or not contents:
                raise MappingError('分表为空或转换失败：' + name)
            for row in contents:
                if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not row['id'] or row['id'] in seen:
                    raise MappingError('分表编号缺失或重复：' + name)
                if columns is None:
                    columns = set(row)
                if set(row) != columns:
                    raise MappingError('分表字段不一致：' + name)
                seen.add(row['id'])
                wanted.add(row.get('name', ''))
                rows.append(row)
        if not rows:
            raise MappingError('缺少实际数据表：' + table)
        destination = output / 'tables' / (table + '.json')
        atomic_json(destination, rows)
        receipt['tables'][table] = {'rows': len(rows), 'sha256': digest(destination)}
    language = next((name for name in ('text/zht/text.db', 'text/en/text.db') if name in paths), None)
    if language:
        try:
            run_export(tool, manifest, output / 'localization', [language], log, raw=True)
            text_file = output / 'localization' / language
            key = bytes.fromhex(resource('assets/db-format-xor.hex').read_text(encoding='ascii').strip())
            labels = text_labels(text_file.read_bytes(), wanted, key)
            atomic_json(output / 'tables' / 'labels.zht.json', {'language': language, 'source_sha256': digest(text_file), 'labels': labels})
            receipt['labels'] = len(labels)
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            receipt['labels_warning'] = type(exc).__name__
            log('名称未准备齐全，暂按编号显示；卡牌数据仍可使用。')
    if digest(manifest) != manifest_sha:
        raise MappingError('提取期间游戏清单变化，请等待下载结束后重新准备')
    atomic_json(output / 'verification.json', receipt)
    atomic_json(data_root / 'active.json', {'tables': str((output / 'tables').resolve()), 'manifest': str(manifest)})
    return output / 'tables', manifest
