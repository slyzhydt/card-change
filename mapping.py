"""从实际表和资源清单编译卡牌自选映射；不修改游戏文件。"""
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import tempfile
from runtime_paths import APP_DIR


class MappingError(ValueError):
    pass


def read_manifest(path):
    data = Path(path).read_bytes()
    if len(data) < 64:
        raise MappingError('资源清单太短')
    header = struct.unpack_from('<4s5I5Q', data)
    if header[0] != b'SSRA' or header[1] != 4:
        raise MappingError('仅支持已核对的 SSRA 第 4 版清单')
    count, string_offset, string_size, file_offset = header[4], header[6], header[7], header[9]
    if string_offset + string_size > len(data) or file_offset + count * 40 > len(data):
        raise MappingError('资源清单表范围越界')
    strings = data[string_offset:string_offset + string_size]
    names = set()
    for i in range(count):
        row = struct.unpack_from('<IIQIIIIBBHI', data, file_offset + i * 40)
        if row[10] & 1:
            continue
        offset = row[6]
        end = strings.find(b'\0', offset)
        if offset >= len(strings) or end < 0:
            raise MappingError('资源名称偏移无效')
        names.add(strings[offset:end].decode('utf-8').replace('\\', '/').lstrip('/'))
    return names, hashlib.sha256(data).hexdigest()


def atomic_json(path, document):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.mapping-', suffix='.json', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            json.dump(document, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.remove(temp)


def discover_inputs():
    here = APP_DIR
    active = here / 'data' / 'active.json'
    if active.is_file():
        try:
            entry = json.loads(active.read_text(encoding='utf-8'))
            tables, manifest = Path(entry['tables']), Path(entry['manifest'])
            if (tables / 'card.json').is_file() and manifest.is_file():
                return tables, manifest
        except (OSError, ValueError, KeyError, TypeError):
            pass
    tables = sorted((here.parent / 'extracted').glob('*/tables/card.json'))
    manifests = sorted(here.parent.parent.glob('Games/*/bin/appdata/*/gameres/manifest.ssra'))
    return (tables[-1].parent if tables else None, manifests[0] if manifests else None)


class Catalog:
    def __init__(self, tables, manifest):
        self.tables = Path(tables).expanduser().resolve()
        self.manifest = Path(manifest).expanduser().resolve()
        self.paths, self.manifest_sha = read_manifest(manifest)
        self.cards = self._table('card')
        self.card_skins = self._table('card_skin')
        self.characters = self._table('char_base')
        # 编号族用于浏览归类；NPC 可能借用其他角色的整套牌，不按使用者反推归属。
        self.card_owners = {}
        for key in self.cards:
            match = re.match(r'^c_(\d+)_', key)
            self.card_owners[key] = match[1] if match and match[1] in self.characters else None
        self.labels = {}
        label_file = self.tables / 'labels.zht.json'
        if label_file.is_file():
            labels = json.loads(label_file.read_text(encoding='utf-8'))
            if not isinstance(labels, dict) or not isinstance(labels.get('labels'), dict) or not all(
                    isinstance(key, str) and isinstance(value, str) for key, value in labels['labels'].items()):
                raise MappingError('名称对照表格式不合法')
            self.labels = labels['labels']
        receipt = self.tables.parent / 'verification.json'
        expected = json.loads(receipt.read_text(encoding='utf-8')).get('manifest_sha256') if receipt.is_file() else None
        extraction = json.loads(receipt.read_text(encoding='utf-8')) if receipt.is_file() else {}
        hashes_match = all(hashlib.sha256((self.tables / (name + '.json')).read_bytes()).hexdigest() ==
                           extraction.get('tables', {}).get(name, {}).get('sha256')
                           for name in ('card', 'card_skin', 'char_base'))
        self.version_verified = expected == self.manifest_sha and hashes_match
        dynamic_cards = {}
        for path in sorted(self.paths):
            match = re.fullmatch(r'card/(unique_(\d+)_skin)\.scsp', path)
            if match:
                stem, owner = match.groups()
                dynamic_cards[stem] = {'id': stem, 'name': self.characters.get(owner, {}).get('name', stem),
                                       'sct_name': 'none', 'spine_model': stem}
        self.targets = {}
        for kind, rows in (('card', self.cards), ('card_skin', self.card_skins), ('local_dynamic', dynamic_cards)):
            for key, row in rows.items():
                resources = self.visual_resources(row)
                missing = [name for name in resources if name not in self.paths]
                self.targets[kind + ':' + key] = {
                    'kind': kind, 'id': key, 'label': self.label(row) + (' · 本地动态异画（待实测）' if kind == 'local_dynamic' else ''), 'row': row,
                    'resources': resources, 'missing': missing,
                    'available': bool(resources) and not missing,
                }

    def card_groups(self):
        groups = {}
        for owner in self.card_owners.values():
            groups[owner] = groups.get(owner, 0) + 1
        return [(owner, self.label(self.characters[owner]), count)
                for owner, count in sorted(groups.items(), key=lambda item: item[0] or '') if owner]

    def _table(self, name):
        path = self.tables / (name + '.json')
        try:
            rows = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError) as exc:
            raise MappingError('数据表无法读取：%s（%s）' % (name, type(exc).__name__)) from exc
        if not isinstance(rows, list) or not rows:
            raise MappingError('数据表为空或格式不符：' + name)
        result = {}
        for row in rows:
            key = row.get('id') if isinstance(row, dict) else None
            if not isinstance(key, str) or not key or key in result:
                raise MappingError('数据表编号无效或重复：' + name)
            result[key] = row
        return result

    def label(self, row):
        return self.labels.get(row.get('name'), row.get('id', '?'))

    @staticmethod
    def visual_resources(row):
        result = []
        for field, directory, exts in (
                ('sct_name', 'card_illustration', ('sct',)),
                ('spine_model', 'card', ('scsp', 'atlas', 'sct'))):
            stem = row.get(field, 'none')
            if stem in ('', 'none', None):
                continue
            if not isinstance(stem, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', stem):
                raise MappingError('显示资源名不合法：' + str(stem))
            result.extend(directory + '/' + stem + '.' + ext for ext in exts)
        return result

    def compile(self, selections, use_builtin=False):
        if type(use_builtin) is not bool:
            raise MappingError('内置映射开关必须是布尔值')
        if use_builtin:
            raise MappingError('角色换肤与旧版内置替换已移除，请使用仅含卡牌选择的配置')
        if not self.version_verified or hashlib.sha256(self.manifest.read_bytes()).hexdigest() != self.manifest_sha:
            raise MappingError('数据表与清单版本未核对一致，需要使用同一轮提取的数据')
        if not isinstance(selections, list) or len(selections) > 1000:
            raise MappingError('映射列表格式不符或超过 1000 项')
        cards, seen = {}, set()
        for item in selections:
            if not isinstance(item, dict) or type(item.get('enabled')) is not bool:
                raise MappingError('映射启用状态不合法')
            kind, source, target = item.get('kind'), item.get('source'), item.get('target')
            if not isinstance(source, str) or not isinstance(target, str):
                raise MappingError('映射来源和目标编号必须是字符串')
            if kind == 'skin':
                raise MappingError('角色皮肤更换功能已删除；原配置未改动，请另存仅含卡牌的配置')
            if kind != 'card':
                raise MappingError('映射类型不支持')
            if source not in self.cards or target not in self.targets:
                raise MappingError('找不到来源卡或目标卡面')
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', source):
                raise MappingError('来源卡编号不符合运行时格式')
            chosen = self.targets[target]
            if not item['enabled']:
                continue
            if source in seen:
                raise MappingError('同一张卡启用了多个目标')
            seen.add(source)
            if not chosen['available']:
                raise MappingError('目标卡面资源未齐全：' + chosen['label'])
            cards[source] = {field: chosen['row'].get(field, 'none') for field in ('sct_name', 'spine_model')}
            cards[source]['resources'] = chosen['resources']
        return {'schema': 1, 'mode': 'cards_only', 'use_builtin': False, 'routes': [],
                'card_overrides': cards, 'manifest_sha256': self.manifest_sha,
                '_editor': {'version': 1, 'selections': selections}}

    def load_selection(self, path):
        document = json.loads(Path(path).read_text(encoding='utf-8-sig'))
        if not isinstance(document, dict):
            raise MappingError('配置必须是 JSON 对象')
        editor = document.get('_editor', {})
        if not isinstance(editor, dict) or editor.get('version') != 1:
            raise MappingError('该配置不是本选择器保存的格式，原文件保持不变')
        selections = editor.get('selections')
        if document.get('manifest_sha256') != self.manifest_sha:
            raise MappingError('配置对应的资源清单版本不同，需重新选择映射')
        if document.get('routes'):
            raise MappingError('本选择器已移除路径换肤，请另存仅含卡牌选择的配置；原文件未改动')
        self.compile(selections, document.get('use_builtin', False))
        return selections, bool(document.get('use_builtin', False))
