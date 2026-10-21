import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile
from contextlib import ExitStack

import bundle
import engine


class BundleTests(unittest.TestCase):
    def load(self, archives):
        blobs, leaves = {}, []
        for index, files in enumerate(archives):
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, 'w') as archive:
                for name, content in files.items():
                    archive.writestr(name, content)
            blob = bundle.xor(b'prefix' + buf.getvalue())
            blobs[index] = blob
            data = SimpleNamespace(struct=SimpleNamespace(OffsetToData=index, Size=len(blob)))
            leaves.append(((242, 241, index), data))
        pe = SimpleNamespace(DIRECTORY_ENTRY_RESOURCE=None, close=lambda: None,
                             get_data=lambda rva, size: blobs[rva],
                             get_physical_by_rva=lambda rva: 32)
        with patch.object(bundle.os.path, 'isfile', return_value=True), \
                patch.object(bundle.os.path, 'getsize', return_value=4096), \
                patch.object(bundle, '_open_pe', return_value=pe), \
                patch.object(bundle, '_walk', return_value=leaves):
            return bundle.Bundle('fixture.exe')

    def test_compiled_script_explained(self):
        with self.assertRaisesRegex(bundle.BundleError, r'编译脚本（.jbin）'):
            self.load([{'pre/bin/x86_64/init.jbin': b'compiled'}])

    def test_missing_entry_is_distinct(self):
        with self.assertRaisesRegex(bundle.BundleError, '脚本层入口对不上'):
            self.load([{'pre/ui/icon.sct': b'asset'}])

    def test_later_plaintext_resource_wins(self):
        container = self.load([{'pre/bin/x86_64/init.jbin': b'compiled'},
                               {bundle.INIT_NAME: b'actual script'}])
        self.assertEqual(container.init_bytes, b'actual script')

    def test_unrelated_archive_does_not_hide_compiled_script(self):
        with self.assertRaisesRegex(bundle.BundleError, '编译脚本'):
            self.load([{'unrelated.txt': b'asset'},
                       {'pre/bin/x86_64/init.jbin': b'compiled'}])


class CardsOnlyTableTests(unittest.TestCase):
    def setUp(self):
        (Path(__file__).resolve().parent / 'work').mkdir(exist_ok=True)

    def check_table(self, table):
        with tempfile.TemporaryDirectory(prefix='card-table-', dir=Path(__file__).resolve().parent / 'work') as work:
            path = Path(work) / 'table.json'
            path.write_text(json.dumps(table), encoding='utf-8')
            return engine.load_table(str(path))

    def test_explicit_cards_only_table_accepts_no_legacy_maps(self):
        table = {'mode': 'cards_only', 'map': {}, 'rows': {}, 'atlases': {}, 'revision': 'test',
                 'selection': {'schema': 1, 'routes': [], 'card_overrides': {}, 'use_builtin': False}}
        self.assertEqual(self.check_table(table)[2], {})
        for field in ('rows', 'atlases'):
            with self.assertRaisesRegex(engine.EngineError, '仅卡牌模式'):
                self.check_table(dict(table, **{field: {'char_base': {'1': {}}}}))

    def test_empty_legacy_table_still_rejected(self):
        with self.assertRaisesRegex(engine.EngineError, '分层表是空的'):
            self.check_table({'map': {}, 'rows': {}, 'revision': 'test'})

    def test_embedded_card_resources_checked_against_manifest(self):
        with tempfile.TemporaryDirectory(prefix='card-manifest-', dir=Path(__file__).resolve().parent / 'work') as work:
            manifest = Path(work) / 'manifest.ssra'
            manifest.write_bytes(b'card/present.scsp\0card/present.atlas\0card/present.sct\0')
            results = []
            table = {'mode': 'cards_only', 'map': {}, 'selection': {'card_overrides': {
                'card_a': {'resources': ['card/present.scsp', 'card/missing.atlas']}}}}
            report = engine.manifest_check(table, str(manifest), lambda *args: results.append(args))
            self.assertEqual(report['missing'], ['card/missing.atlas'])
            self.assertFalse(results[-1][1])


class ProduceTests(unittest.TestCase):
    def setUp(self):
        work = Path(__file__).resolve().parent / 'work'
        work.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='reliability-test-', dir=work)
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.src = root / 'input' / 'source.exe'
        self.dst = root / 'output' / 'result.exe'
        self.src.parent.mkdir()
        self.dst.parent.mkdir()
        self.src.write_bytes(b'source')
        self.dst.write_bytes(b'previous output')
        self.proof = Path(str(self.dst) + '.proof.json')
        self.proof.write_bytes(b'previous proof')
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        det = {'ok': True, 'table': {'text': '{}', 'counts': {}, 'table': {'rows': {}}},
               'payload': 'payload', 'init_bytes': b'init', 'container': None}
        info = {'anchor_line': 1, 'orig': 4, 'new': 5, 'window': (1, 4)}
        for name, value in [('detect', det), ('node_gate', (28, '')), ('syntax_gate', None),
                            ('assemble', (b'final', info))]:
            self.stack.enter_context(patch.object(engine, name, return_value=value))
        self.stack.enter_context(patch.object(engine, 'rebuild', side_effect=self.rebuild))
        self.reader = self.stack.enter_context(patch.object(engine, 'read_back', side_effect=self.read_back))

    def rebuild(self, container, content, destination, **kwargs):
        self.assertNotEqual(Path(destination), self.dst)
        Path(destination).write_bytes(b'checked output')
        return {'grow': 1}

    def read_back(self, source, destination, *args):
        self.assertEqual(self.dst.read_bytes(), b'previous output')
        self.assertEqual(Path(destination).read_bytes(), b'checked output')
        return [('fixture check', True)], {'sha_dst': 'hash', 'size': 14, 'padding_left': 100}

    def produce(self):
        return engine.produce(str(self.src), str(self.dst), engine.res('table.json'),
                              engine.res('payload.js'), log=lambda *args: None)

    def assert_preserved(self):
        self.assertEqual(self.dst.read_bytes(), b'previous output')
        self.assertEqual(self.proof.read_bytes(), b'previous proof')
        self.assertFalse(list(self.dst.parent.glob('.skinrender-*')))
        self.assertEqual(self.src.read_bytes(), b'source')

    def test_success_publishes_checked_result(self):
        self.produce()
        self.assertEqual(self.dst.read_bytes(), b'checked output')
        proof = json.loads(self.proof.read_text(encoding='utf-8'))
        self.assertEqual(proof['out'], self.dst.name)
        self.assertTrue(proof['checks']['fixture check'])
        self.assertFalse(list(self.dst.parent.glob('.skinrender-*')))

    def test_readback_exception_preserves_previous_result(self):
        self.reader.side_effect = OSError('readback failure')
        with self.assertRaises(OSError):
            self.produce()
        self.assert_preserved()

    def test_rejected_checks_preserve_previous_result(self):
        self.reader.side_effect = None
        self.reader.return_value = ([('fixture check', False)],
                                   {'sha_dst': 'hash', 'size': 14, 'padding_left': 100})
        with self.assertRaises(engine.EngineError):
            self.produce()
        self.assert_preserved()
        self.assertTrue(Path(str(self.dst) + '.rejected.json').is_file())

    def test_proof_write_failure_preserves_previous_result(self):
        real_open = io.open
        def fail_proof(path, *args, **kwargs):
            if Path(path).name == 'proof.json':
                raise PermissionError('proof write failure')
            return real_open(path, *args, **kwargs)
        with patch.object(engine.io, 'open', side_effect=fail_proof):
            with self.assertRaises(PermissionError):
                self.produce()
        self.assert_preserved()

    def test_output_replace_failure_restores_previous_proof(self):
        real_replace = os.replace
        def fail_output(source, destination):
            if Path(destination) == self.dst:
                raise PermissionError('output busy')
            return real_replace(source, destination)
        with patch.object(engine.os, 'replace', side_effect=fail_output):
            with self.assertRaises(PermissionError):
                self.produce()
        self.assert_preserved()

    def test_output_replace_failure_without_previous_proof(self):
        self.proof.unlink()
        real_replace = os.replace
        def fail_output(source, destination):
            if Path(destination) == self.dst:
                raise PermissionError('output busy')
            return real_replace(source, destination)
        with patch.object(engine.os, 'replace', side_effect=fail_output):
            with self.assertRaises(PermissionError):
                self.produce()
        self.assertEqual(self.dst.read_bytes(), b'previous output')
        self.assertFalse(self.proof.exists())
        self.assertFalse(list(self.dst.parent.glob('.skinrender-*')))


if __name__ == '__main__':
    unittest.main()
