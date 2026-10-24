import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

from angel_skin import SKINS, animation_duration, daily_model, fnv1a, routes_for, selected_skins, skeleton_check, write_daily_model
from mapping import Catalog, MappingError, atomic_json


class AngelSkinChecks(unittest.TestCase):
    def setUp(self):
        work = Path(__file__).resolve().parent / 'work'
        work.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='angel-test-', dir=work)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_routes_do_not_consume_special_scenes_or_other_characters(self):
        paths = {'face/character/face_character_30075.sct', 'face/character/face_character_30075_01.sct',
                 'face/character/face_character_30084_01.sct', 'model/30075_battle_ready.scsp',
                 'face/portrait/30075_front.scsp'}
        routes = routes_for(paths)
        self.assertEqual(routes['face/character/face_character_30075.sct'],
                         'face/character/face_character_30075_01.sct')
        self.assertFalse(any('30084' in source or 'battle_ready' in source or 'front' in source for source in routes))

    def skeleton(self, region='body', size='16,16'):
        atomic_json(self.root / 'test.json', {'skins': [{'name': 'default', 'attachments': {
            'body': {'body': {'path': region}}}}]})
        (self.root / 'test.atlas').write_text('\ntest.png\nsize: ' + size + '\nbody\n  rotate: false\n', encoding='utf-8')
        (self.root / 'test.png').write_bytes(b'\x89PNG\r\n\x1a\n' + b'\0' * 8 + struct.pack('>II', 16, 16))

    def test_missing_atlas_region_blocks_skin(self):
        self.skeleton(region='missing')
        with self.assertRaisesRegex(MappingError, '贴图片段'):
            skeleton_check(self.root, 'test')

    def test_atlas_larger_than_texture_blocks_skin(self):
        self.skeleton(size='32,16')
        with self.assertRaisesRegex(MappingError, '尺寸'):
            skeleton_check(self.root, 'test')

    def test_invalid_texture_blocks_skin(self):
        self.skeleton()
        (self.root / 'test.png').write_bytes(b'not a PNG')
        with self.assertRaisesRegex(MappingError, '贴图转换'):
            skeleton_check(self.root, 'test')

    def test_failed_profile_does_not_produce_executable(self):
        import selector_jobs
        manifest = self.root / 'manifest.ssra'
        manifest.write_bytes(b'stable manifest')
        import hashlib
        doc = {'manifest_sha256': hashlib.sha256(manifest.read_bytes()).hexdigest(),
               'card_overrides': {}, 'routes': [], '_editor': {'angel_skin': True}}
        source = self.root / 'source.exe'
        source.write_bytes(b'original')
        with patch.object(selector_jobs, 'HERE', self.root), \
                patch.dict(sys.modules, {'pefile': object()}), \
                patch('angel_skin.build_profile', side_effect=MappingError('missing companion')):
            with self.assertRaisesRegex(MappingError, 'missing companion'):
                selector_jobs.build_trial(source, doc, manifest, lambda line: None)
        self.assertEqual(source.read_bytes(), b'original')
        self.assertFalse(list((self.root / 'out').glob('*/game-mapped.exe')))
        self.assertTrue(list((self.root / 'out').glob('*/FAILED.json')))

    def test_composed_payload_uses_single_removable_block_and_table(self):
        import selector_jobs
        from runtime_paths import resource
        text = selector_jobs.compose_payload(resource('payload.js').read_text(encoding='utf-8'))
        self.assertEqual(text.count('SKINRENDER-BEGIN'), 1)
        self.assertEqual(text.count('SKINRENDER-END'), 1)
        self.assertEqual(text.count('__SKIN_TABLE__'), 1)
        self.assertIn('if (BAKED.angel_skin) installAngelSkin', text)

    def test_option_roundtrip_and_invalid_type(self):
        from test_mapping import fixture
        tables, manifest = fixture(self.root)
        catalog = Catalog(tables, manifest)
        path = self.root / 'choice.json'
        atomic_json(path, catalog.compile([], angel_skin=True))
        catalog.load_selection(path)
        self.assertTrue(catalog.loaded_angel_skin)
        with self.assertRaisesRegex(MappingError, '布尔值'):
            catalog.compile([], angel_skin='yes')

    def test_all_skin_selection_roundtrip_preserves_independent_disabled_states(self):
        from test_mapping import fixture
        tables, manifest = fixture(self.root)
        catalog = Catalog(tables, manifest)
        choices = ['30134_02', '30113_01']
        path = self.root / 'multiple.json'
        atomic_json(path, catalog.compile([], character_skins=choices))
        catalog.load_selection(path)
        self.assertEqual(catalog.loaded_character_skins, sorted(choices))
        self.assertFalse(catalog.loaded_angel_skin)

    def test_legacy_angel_config_migrates_without_enabling_other_skins(self):
        self.assertEqual(selected_skins({'angel_skin': True}), ['30075_01'])
        self.assertEqual(selected_skins({'angel_skin': False}), [])

    def test_arbitrary_skin_or_invalid_selection_type_is_rejected(self):
        for value in [['../other'], ['30084_02'], False, '', {'30075_01': True}]:
            with self.subTest(value=value), self.assertRaises(MappingError):
                selected_skins({'character_skins': value})

    def test_gui_option_is_saved_loaded_and_passed_to_builder(self):
        import tkinter as tk
        import selector
        from test_mapping import fixture
        tables, manifest = fixture(self.root)
        root = tk.Tk()
        root.withdraw()
        self.addCleanup(root.destroy)
        path = self.root / 'gui.json'
        with patch.object(selector, 'discover_inputs', return_value=(tables, manifest)):
            app = selector.Selector(root)
        self.addCleanup(lambda: root.after_cancel(app.poll_id))
        self.assertFalse(app.angel_var.get())
        app.set_skin_choices(True)
        self.assertEqual(set(app.selected_skins()), set(SKINS))
        app.set_skin_choices(False)
        app.angel_var.set(True)
        with patch.object(selector.filedialog, 'asksaveasfilename', return_value=str(path)):
            app.save_config()
        app.angel_var.set(False)
        with patch.object(selector.filedialog, 'askopenfilename', return_value=str(path)):
            app.open_config()
        self.assertTrue(app.angel_var.get())
        with patch.object(selector.filedialog, 'askopenfilename', return_value='input.exe'), \
                patch.object(app, 'start_job', side_effect=lambda work: work()), \
                patch('selector_jobs.build_trial', return_value='done') as build:
            app.build_copy()
        self.assertTrue(build.call_args.args[1]['_editor']['angel_skin'])

    def model_fixture(self):
        base = {'events': {'damage': {'int': 1}}, 'animations': {
            'idle': {'bones': {'root': {'rotate': [{'time': 0}, {'time': 1.5}]}}},
            'hit': {'events': [{'time': 0.2, 'name': 'damage'}]},
            'instant': {}, 'move': {'duration': 1}}}
        target = {'bones': [{'name': 'root'}], 'events': {}, 'animations': {
            'move': {'bones': {'root': {'rotate': [{'time': 0}, {'time': 1}]}}},
            'stop': {'duration': 8, 'bones': {'root': {'rotate': [
                {'time': 0, 'angle': 1}, {'time': 0.5, 'angle': 2}, {'time': 8, 'angle': 1}]}}}}}
        return base, target

    def test_daily_aliases_preserve_names_duration_and_events(self):
        base, target = self.model_fixture()
        result, aliases = daily_model(base, target)
        for name in aliases:
            self.assertAlmostEqual(animation_duration(result['animations'][name]),
                                   animation_duration(base['animations'][name]))
        self.assertEqual(result['animations']['hit']['events'], base['animations']['hit']['events'])
        self.assertEqual(result['events'], base['events'])
        self.assertEqual(result['animations']['instant'], {})

    def test_daily_motion_uses_natural_speed_segment_and_keeps_movement(self):
        base, target = self.model_fixture()
        result, _ = daily_model(base, target)
        frames = result['animations']['idle']['bones']['root']['rotate']
        self.assertEqual(frames[1], {'time': 0.5, 'angle': 2})
        self.assertEqual(frames[-1]['time'], 1.5)
        self.assertEqual(result['animations']['move'], target['animations']['move'])
        self.assertEqual(result['animations']['stop'], target['animations']['stop'])

    def test_daily_generation_does_not_mutate_inputs(self):
        base, target = self.model_fixture()
        before = json.dumps([base, target])
        daily_model(base, target)
        self.assertEqual(json.dumps([base, target]), before)

    def test_invalid_daily_motion_is_rejected(self):
        base, target = self.model_fixture()
        target['animations']['stop'] = {}
        with self.assertRaisesRegex(MappingError, 'stop'):
            daily_model(base, target)

    def test_daily_companion_is_content_named_and_checksum_verified(self):
        base, target = self.model_fixture()
        info = write_daily_model(base, target, '30113_01', self.root / 'skinrender-models')
        path = self.root / info['file']
        text = path.read_text(encoding='ascii')
        import hashlib
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), info['sha256'])
        self.assertEqual(len(path.read_bytes()), info['bytes'])
        self.assertEqual(fnv1a(text), info['fnv1a'])
        self.assertIn(info['sha256'][:16], path.name)

    def test_fnv_compatible_with_runtime_reference_vector(self):
        self.assertEqual(fnv1a('hello'), '4f9f2cab')


if __name__ == '__main__':
    unittest.main()
