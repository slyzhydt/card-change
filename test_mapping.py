import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from mapping import Catalog, MappingError, atomic_json, read_manifest


def fixture(root):
    tables = root / 'tables'
    tables.mkdir()
    paths = ['card_illustration/source_image.sct', 'card_illustration/target_image.sct',
             'card_illustration/rare_image.sct']
    paths.append('card/unique_2_skin.scsp')  # 不完整的动态资源应被隐藏、拒绝启用
    paths.extend('effect/unique_2_sr_1_skin' + suffix + '.' + ext
                 for suffix in ('', '_bg', '_eff') for ext in ('scsp', 'atlas', 'sct'))
    paths.append('effect/unique_2_sr_1_skin.cfx')
    paths.extend('effect/unique_3_sr_1_skin.' + ext for ext in ('scsp', 'atlas', 'sct'))
    paths.append('effect/unique_3_sr_1_skin_bg.scsp')
    for stem in ('card/target_rig', 'card/unique_1_skin', 'card/unique_1_skin_bg'):
        paths.extend(stem + '.' + ext for ext in ('scsp', 'atlas', 'sct'))
    strings, records = bytearray(), bytearray()
    for path in paths:
        offset = len(strings)
        strings.extend(path.encode() + b'\0')
        records.extend(struct.pack('<IIQIIIIBBHI', 0, 0, 0, 1, 1, 0, offset, 0, 0, 0, 0))
    manifest = root / 'manifest.ssra'
    manifest.write_bytes(struct.pack('<4s5I5Q', b'SSRA', 4, 0, 0, len(paths), 0,
                                     64 + len(records), len(strings), 64, 64, 0) + records + strings)
    data = {
        'card': [dict(id='original', name='label.original', cost='7', sct_name='source_image', spine_model='none'),
                 dict(id='target', name='label.target', cost='99', sct_name='target_image', spine_model='target_rig'),
                 dict(id='c_1_srt1', name='label.one', sct_name='source_image', spine_model='none'),
                 dict(id='c_1_uni1_rsp2', name='label.variant', sct_name='none', spine_model='target_rig'),
                 dict(id='c_2_srt1', name='label.two', sct_name='target_image', spine_model='none'),
                 dict(id='c_999_srt1', name='label.unknown', sct_name='source_image', spine_model='none')],
        'card_skin': [dict(id='rare', name='label.rare', sct_name='rare_image', spine_model='none'),
                      dict(id='missing', name='label.missing', sct_name='absent_image', spine_model='none'),
                      dict(id='guardian', name='label.guardian', sct_name='none', spine_model='unique_2_sr_1_skin'),
                      dict(id='partial_guardian', name='label.partial', sct_name='none', spine_model='unique_3_sr_1_skin')],
        'char_base': [dict(id='1', name='label.character', model='1', standing_portrait_ani='none',
                           char_type='CHAR_COMBATANT', char_use_playable='YES'),
                      dict(id='2', name='label.character_two', model='2', standing_portrait_ani='none',
                           char_type='CHAR_COMBATANT', char_use_playable='YES')],
    }
    for name, rows in data.items():
        atomic_json(tables / (name + '.json'), rows)
    atomic_json(root / 'verification.json', {
        'manifest_sha256': hashlib.sha256(manifest.read_bytes()).hexdigest(),
        'tables': {name: {'sha256': hashlib.sha256((tables / (name + '.json')).read_bytes()).hexdigest()}
                   for name in data}})
    atomic_json(tables / 'labels.zht.json', {'labels': {
        'label.original': '原卡', 'label.target': '目标动态卡', 'label.rare': '目标异画',
        'label.missing': '资源缺失卡面', 'label.character': '角色甲', 'label.character_two': '角色乙',
        'label.one': '甲的起始牌', 'label.variant': '甲的变体牌', 'label.two': '乙的起始牌'}})
    return tables, manifest


class MappingTests(unittest.TestCase):
    def setUp(self):
        work = Path(__file__).resolve().parent / 'work'
        work.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='mapping-test-', dir=work)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.tables, self.manifest = fixture(self.root)
        self.catalog = Catalog(self.tables, self.manifest)

    @staticmethod
    def card(target='card:target', enabled=True):
        return {'kind': 'card', 'source': 'original', 'target': target, 'enabled': enabled}

    def test_chinese_labels_and_resource_availability(self):
        self.assertEqual(self.catalog.label(self.catalog.cards['original']), '原卡')
        self.assertTrue(self.catalog.targets['card:target']['available'])
        self.assertFalse(self.catalog.targets['card_skin:missing']['available'])

    def test_card_export_contains_only_visual_fields(self):
        before = dict(self.catalog.cards['original'])
        document = self.catalog.compile([self.card()])
        selected = document['card_overrides']['original']
        self.assertEqual(set(selected), {'sct_name', 'spine_model', 'resources'})
        self.assertEqual(selected['spine_model'], 'target_rig')
        self.assertEqual(self.catalog.cards['original'], before)
        self.assertNotIn('cost', selected)

    def test_character_groups_keep_variants_and_unknowns(self):
        self.assertEqual(self.catalog.card_owners['c_1_srt1'], '1')
        self.assertEqual(self.catalog.card_owners['c_1_uni1_rsp2'], '1')
        self.assertEqual(self.catalog.card_owners['c_2_srt1'], '2')
        self.assertIsNone(self.catalog.card_owners['c_999_srt1'])
        self.assertIsNone(self.catalog.card_owners['original'])
        self.assertEqual(self.catalog.card_groups(), [('1', '角色甲', 2), ('2', '角色乙', 1)])

    def test_missing_target_is_rejected(self):
        with self.assertRaisesRegex(MappingError, '未齐全'):
            self.catalog.compile([self.card('card_skin:missing')])

    def test_disabled_missing_target_can_be_saved_without_activation(self):
        document = self.catalog.compile([self.card('card_skin:missing', False)])
        self.assertEqual(document['card_overrides'], {})
        self.assertEqual(len(document['_editor']['selections']), 1)

    def test_duplicate_enabled_source_rejected(self):
        with self.assertRaisesRegex(MappingError, '多个目标'):
            self.catalog.compile([self.card(), self.card('card_skin:rare')])

    def test_character_skin_selection_removed(self):
        for enabled in (True, False):
            with self.assertRaisesRegex(MappingError, '角色皮肤更换功能已删除'):
                self.catalog.compile([{'kind': 'skin', 'source': '1', 'target': 'old', 'enabled': enabled}])
        self.assertFalse(hasattr(self.catalog, 'skin_options'))

    def test_local_dynamic_card_is_full_family_and_not_background(self):
        document = self.catalog.compile([self.card('local_dynamic:unique_1_skin')])
        self.assertEqual(document['card_overrides']['original']['spine_model'], 'unique_1_skin')
        self.assertEqual(document['card_overrides']['original']['sct_name'], 'none')
        self.assertEqual(len(document['card_overrides']['original']['resources']), 3)
        self.assertEqual(document['routes'], [])
        self.assertFalse(document['use_builtin'])
        self.assertNotIn('local_dynamic:unique_1_skin_bg', self.catalog.targets)
        with self.assertRaisesRegex(MappingError, '未齐全'):
            self.catalog.compile([self.card('local_dynamic:unique_2_skin')])

    def test_old_builtin_or_role_routes_rejected_without_modifying_file(self):
        with self.assertRaisesRegex(MappingError, '旧版内置替换已移除'):
            self.catalog.compile([], True)
        path = self.root / 'mixed.json'
        document = self.catalog.compile([self.card()])
        document['routes'] = [{'source': 'model/1', 'target': 'model/1_02'}]
        atomic_json(path, document)
        before = path.read_bytes()
        with self.assertRaisesRegex(MappingError, '已移除路径换肤'):
            self.catalog.load_selection(path)
        self.assertEqual(path.read_bytes(), before)

    def test_effect_directory_card_includes_all_companion_resources(self):
        document = self.catalog.compile([self.card('card_skin:guardian')])
        display = document['card_overrides']['original']
        self.assertEqual(display['spine_directory'], 'effect')
        self.assertEqual(display['spine_layers'], ['bg', 'eff'])
        self.assertTrue(display['spine_cfx'])
        self.assertEqual(len(display['resources']), 10)
        self.assertTrue(all(name.startswith('effect/unique_2_sr_1_skin') for name in display['resources']))
        self.assertEqual(document['routes'], [])  # 仅卡牌模式不开放任意路径映射
        self.assertNotIn('spine_directory', self.catalog.card_skins['guardian'])

    def test_partial_background_blocks_effect_card_as_a_whole(self):
        self.assertFalse(self.catalog.targets['card_skin:partial_guardian']['available'])
        with self.assertRaisesRegex(MappingError, '未齐全'):
            self.catalog.compile([self.card('card_skin:partial_guardian')])

    def test_config_roundtrip_preserves_disabled_items_and_mode(self):
        items = [self.card('card_skin:rare', False)]
        path = self.root / 'skin_redirects.json'
        atomic_json(path, self.catalog.compile(items))
        self.assertEqual(self.catalog.load_selection(path), (items, False))

    def test_changed_manifest_blocks_export(self):
        self.manifest.write_bytes(self.manifest.read_bytes() + b'changed')
        with self.assertRaisesRegex(MappingError, '版本'):
            self.catalog.compile([self.card()])
        catalog = Catalog(self.tables, self.manifest)
        with self.assertRaisesRegex(MappingError, '版本'):
            catalog.compile([self.card()])

    def test_edited_table_blocks_export(self):
        atomic_json(self.tables / 'card.json', [self.catalog.cards['original']])
        catalog = Catalog(self.tables, self.manifest)
        with self.assertRaisesRegex(MappingError, '版本'):
            catalog.compile([])

    def test_old_path_only_config_not_silently_overwritten(self):
        path = self.root / 'old.json'
        atomic_json(path, {'schema': 1, 'routes': [{'source': 'card/source'}]})
        before = path.read_bytes()
        with self.assertRaises(MappingError):
            self.catalog.load_selection(path)
        self.assertEqual(path.read_bytes(), before)

    def test_atomic_save_failure_preserves_previous_config(self):
        path = self.root / 'saved.json'
        path.write_text('previous', encoding='utf-8')
        with self.assertRaises(TypeError):
            atomic_json(path, {'unsupported': {1, 2}})
        self.assertEqual(path.read_text(encoding='utf-8'), 'previous')
        self.assertFalse(list(self.root.glob('.mapping-*')))

    def test_manifest_bounds_checked(self):
        self.manifest.write_bytes(self.manifest.read_bytes()[:80])
        with self.assertRaises(MappingError):
            read_manifest(self.manifest)

    def test_ui_add_toggle_save_and_load(self):
        import tkinter as tk
        from tkinter import ttk
        import selector
        root = tk.Tk()
        root.withdraw()
        self.addCleanup(root.destroy)
        errors = []
        with patch.object(selector, 'discover_inputs', return_value=(self.tables, self.manifest)), \
                patch.object(selector.messagebox, 'showerror', side_effect=lambda *args: errors.append(args)), \
                patch.object(selector.messagebox, 'askyesno', return_value=True):
            app = selector.Selector(root)
            self.assertEqual(len(app.notebook.tabs()), 1)
            self.assertEqual(set(app.tabs), {'card'})
            self.assertFalse(hasattr(app, 'builtin_var'))
            self.addCleanup(lambda: root.after_cancel(app.poll_id))
            app.tabs['card']['source_search'].set('原卡')
            app.render_lists('card')
            self.assertEqual(app.tabs['card']['source'].get_children(), ('original',))
            app.tabs['card']['source'].selection_set('original')
            app.tabs['card']['target'].selection_set('card_skin:rare')
            def descendants(widget):
                for child in widget.winfo_children():
                    yield child
                    yield from descendants(child)
            buttons = {w.cget('text'): w for w in descendants(root) if isinstance(w, ttk.Button)}
            buttons['添加 / 替换选中映射'].invoke()
            self.assertEqual(len(app.items), 1)
            path = self.root / 'selection.json'
            with patch.object(selector.filedialog, 'asksaveasfilename', return_value=str(path)):
                buttons['保存配置'].invoke()
            self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['card_overrides']['original']['sct_name'], 'rare_image')
            app.mapping_tree.selection_set('0')
            buttons['启用 / 关闭'].invoke()
            self.assertFalse(app.items[0]['enabled'])
            with patch.object(selector.filedialog, 'askopenfilename', return_value=str(path)):
                buttons['载入配置'].invoke()
            self.assertTrue(app.items[0]['enabled'])
            saved_items = [dict(item) for item in app.items]
            tab = app.tabs['card']
            tab['source_search'].set('')
            tab['owner_filter'].current(tab['owner_keys'].index('1'))
            tab['owner_filter'].event_generate('<<ComboboxSelected>>')
            self.assertEqual(tab['source'].get_children(), ('c_1_srt1', 'c_1_uni1_rsp2'))
            self.assertTrue(tab['target'].exists('card_skin:rare'))
            self.assertEqual(app.items, saved_items)
            tab['source'].selection_set('c_1_srt1')
            import selector_jobs
            with patch.object(selector_jobs, 'extract_preview', return_value=Path('original.png')) as export, \
                    patch.object(app, 'start_job', side_effect=lambda work: app.events.put(('done', work()))):
                buttons['查看原卡图片'].invoke()
                event, preview = app.events.get_nowait()
                self.assertEqual(event, 'done')
                self.assertEqual(preview[0:2], ('preview', Path('original.png')))
                self.assertIn('原卡', preview[2])
                export.assert_called_once_with(self.catalog.manifest, 'source_image')
                buttons['查看目标图片'].invoke()
                self.assertIn('目标', app.events.get_nowait()[1][2])
                self.assertEqual(export.call_args.args[1], 'rare_image')
            tab['source'].selection_set('c_1_uni1_rsp2')
            with patch.object(selector.messagebox, 'showinfo') as info, patch.object(app, 'start_job') as job:
                buttons['查看原卡图片'].invoke()
                self.assertIn('动态骨架预览暂未接入', info.call_args.args[1])
                job.assert_not_called()
            tab['owner_filter'].current(tab['owner_keys'].index(None))
            app.render_lists('card')
            self.assertEqual(set(tab['source'].get_children()), {'original', 'target', 'c_999_srt1'})
            tab['owner_filter'].current(0)
            tab['source_search'].set('角色乙')
            app.render_lists('card')
            self.assertEqual(tab['source'].get_children(), ('c_2_srt1',))
            self.assertEqual(app.items, saved_items)
            tab['target_kind'].set('本地动态异画')
            app.render_targets('card')
            self.assertEqual(tab['target'].get_children(), ('local_dynamic:unique_1_skin',))
            tab['source'].selection_set('c_2_srt1')
            tab['target'].selection_set('local_dynamic:unique_1_skin')
            buttons['添加 / 替换选中映射'].invoke()
            self.assertEqual(app.catalog.compile(app.items)['card_overrides']['c_2_srt1']['spine_model'], 'unique_1_skin')
            self.assertFalse(errors)


if __name__ == '__main__':
    unittest.main()
