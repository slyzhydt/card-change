import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

import mapping
import prepare_data
import runtime_paths
from test_mapping import fixture


class PortableTests(unittest.TestCase):
    def setUp(self):
        work = Path(__file__).resolve().parent / 'work'
        work.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='portable-test-', dir=work)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def text_fixture(self, loop=False):
        name = b'card@name@one'
        value = name + b'\0' + '示例牌名'.encode() + b'\0'
        u40 = lambda n: bytes([n >> 32]) + struct.pack('<I', n & 0xffffffff)
        header = bytearray(38)
        header[:5] = b'PLPcK'
        struct.pack_into('<H', header, 6, 38)
        struct.pack_into('<I', header, 21, 1)
        header[25:30] = u40(38)
        record = struct.pack('<IBBI', 15 + len(name) + len(value), 2, len(name), len(value))
        data = bytes(header) + struct.pack('<IB', 10, 1) + u40(48) + record + u40(48 if loop else 0) + name + value
        key = bytes(range(256))
        return bytes(v ^ key[i % 256] for i, v in enumerate(data)), key

    def test_localized_text_and_cycle_rejection(self):
        raw, key = self.text_fixture()
        self.assertEqual(prepare_data.text_labels(raw, {'card@name@one'}, key), {'card@name@one': '示例牌名'})
        raw, key = self.text_fixture(loop=True)
        with self.assertRaisesRegex(mapping.MappingError, '循环引用'):
            prepare_data.text_labels(raw, {'card@name@one'}, key)
        with self.assertRaises(mapping.MappingError):
            prepare_data.text_labels(raw[:40], {'card@name@one'}, key)

    def test_successful_preparation_can_be_loaded_by_catalog(self):
        tables, manifest = fixture(self.root)
        names, digest = mapping.read_manifest(manifest)
        names.update('db/' + name + '@' + name + '.db' for name in ('card', 'card_skin', 'char_base'))
        tool = self.root / 'ripper.exe'
        tool.write_bytes(b'fixture-tool')
        def export(tool, manifest, output, names, log, raw=False):
            for name in ('card', 'card_skin', 'char_base'):
                destination = output / 'db' / (name + '@' + name + '.json')
                destination.parent.mkdir(parents=True, exist_ok=True)
                rows = json.loads((tables / (name + '.json')).read_text(encoding='utf-8'))
                columns = set().union(*(set(row) for row in rows))
                mapping.atomic_json(destination, [{key: row.get(key, 'none') for key in columns} for row in rows])
        with patch.object(prepare_data, 'read_manifest', return_value=(names, digest)), \
                patch.object(prepare_data, 'ripper_executable', return_value=tool), \
                patch.object(prepare_data, 'run_export', side_effect=export):
            actual, current = prepare_data.prepare_catalog(manifest, data_root=self.root / 'data')
        self.assertTrue(mapping.Catalog(actual, current).version_verified)
        with patch.object(mapping, 'APP_DIR', self.root):
            self.assertEqual(mapping.discover_inputs(), (actual.resolve(), manifest.resolve()))

    def test_failed_preparation_preserves_previous_active_catalog(self):
        tables, manifest = fixture(self.root)
        data = self.root / 'data'
        mapping.atomic_json(data / 'active.json', {'tables': str(tables), 'manifest': str(manifest)})
        previous = (data / 'active.json').read_bytes()
        with patch.object(prepare_data, 'read_manifest', return_value=({'db/card@card.db'}, 'a' * 64)), \
                patch.object(prepare_data, 'ripper_executable', return_value=manifest), \
                patch.object(prepare_data, 'run_export', side_effect=mapping.MappingError('fixture failure')):
            with self.assertRaises(mapping.MappingError):
                prepare_data.prepare_catalog(manifest, data_root=data)
        self.assertEqual((data / 'active.json').read_bytes(), previous)

    def test_bundled_node_selected_without_path(self):
        binary = self.root / 'runtime' / 'node.exe'
        binary.parent.mkdir()
        binary.write_bytes(b'fixture')
        with patch.object(runtime_paths, 'APP_DIR', self.root), patch.object(runtime_paths.shutil, 'which', return_value=None):
            self.assertEqual(runtime_paths.node_executable(), str(binary))


if __name__ == '__main__':
    unittest.main()
