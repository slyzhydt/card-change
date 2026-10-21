"""本地卡牌选择窗口，使用 Python 自带界面库。"""
from pathlib import Path
import queue
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from mapping import Catalog, MappingError, atomic_json, discover_inputs
from runtime_paths import APP_DIR


class Selector:
    def __init__(self, root):
        self.root = root
        self.catalog = None
        self.items = []
        self.dirty = False
        self.busy = False
        self.events = queue.Queue()
        self.preview_image = None
        self.last_saved = None
        root.title('卡牌自选映射 · 试用版')
        root.geometry('1120x810')
        root.minsize(940, 700)
        tables, manifest = discover_inputs()
        self.tables_var = tk.StringVar(value=str(tables or ''))
        self.manifest_var = tk.StringVar(value=str(manifest or ''))
        self.status = tk.StringVar(value='选择同一版本的数据表和资源清单')
        self.detail = tk.StringVar(value='先选左侧原卡，再选右侧卡面并添加。原卡技能、费用和卡名保持不变。游戏效果待实测。')
        outer = ttk.Frame(root, padding=12)
        outer.pack(fill='both', expand=True)
        for label, variable, command in (('数据表目录', self.tables_var, self.pick_tables),
                                          ('资源清单', self.manifest_var, self.pick_manifest)):
            line = ttk.Frame(outer)
            line.pack(fill='x', pady=2)
            ttk.Label(line, text=label, width=11).pack(side='left')
            ttk.Entry(line, textvariable=variable).pack(side='left', fill='x', expand=True)
            ttk.Button(line, text='浏览', command=command, width=8).pack(side='left', padx=(6, 0))
        top = ttk.Frame(outer)
        top.pack(fill='x', pady=7)
        ttk.Button(top, text='加载 / 刷新数据', command=self.load_data).pack(side='left')
        ttk.Button(top, text='从游戏资源准备数据', command=self.prepare_local_data).pack(side='left', padx=6)
        ttk.Label(top, text='只改卡牌；选择结果随测试副本生成', foreground='#575757').pack(side='right')
        self.notebook = ttk.Notebook(outer)
        self.notebook.pack(fill='both', expand=True)
        self.tabs = {}
        for key, title in (('card', '卡牌 A → 卡面 B'),):
            self.tabs[key] = self.make_tab(key, title)
        ttk.Label(outer, textvariable=self.detail, wraplength=1050).pack(fill='x', pady=8)
        bar = ttk.Frame(outer)
        bar.pack(fill='x')
        ttk.Button(bar, text='添加 / 替换选中映射', command=self.add_mapping).pack(side='left')
        ttk.Button(bar, text='查看原卡图片', command=self.preview_source).pack(side='left', padx=6)
        ttk.Button(bar, text='查看目标图片', command=self.preview_target).pack(side='left', padx=6)
        ttk.Label(bar, text='下方仅列出已选择的项目；每项可关闭。').pack(side='right')
        self.mapping_tree = ttk.Treeview(outer, columns=('enabled', 'source', 'target'),
                                         show='headings', height=6, selectmode='browse')
        for key, label, width in (('enabled', '状态', 65),
                                  ('source', '原卡', 390), ('target', '目标卡面', 460)):
            self.mapping_tree.heading(key, text=label)
            self.mapping_tree.column(key, width=width, minwidth=50, stretch=key in ('source', 'target'))
        self.mapping_tree.pack(fill='x', pady=8)
        controls = ttk.Frame(outer)
        controls.pack(fill='x')
        for label, command in (('启用 / 关闭', self.toggle_mapping), ('删除', self.delete_mapping),
                                ('载入配置', self.open_config), ('保存配置', self.save_config),
                                ('生成测试副本', self.build_copy)):
            ttk.Button(controls, text=label, command=command).pack(side='left', padx=(0, 6))
        ttk.Label(outer, textvariable=self.status, wraplength=1050, foreground='#235d84').pack(fill='x', pady=(9, 0))
        root.protocol('WM_DELETE_WINDOW', self.close)
        self.poll_id = root.after(100, self.pump)
        if tables and manifest:
            self.load_data()

    def make_tab(self, kind, title):
        frame = ttk.Frame(self.notebook, padding=8)
        self.notebook.add(frame, text=title)
        frame.columnconfigure((0, 1), weight=1, uniform=kind)
        list_row = 3
        frame.rowconfigure(list_row, weight=1)
        data = {'frame': frame, 'source_search': tk.StringVar(), 'target_search': tk.StringVar(),
                'target_kind': tk.StringVar(value='异画卡面'), 'available': tk.BooleanVar(value=True)}
        ttk.Label(frame, text='① 选择原卡').grid(row=0, column=0, sticky='w')
        right = ttk.Frame(frame)
        right.grid(row=0, column=1, sticky='ew', padx=(10, 0))
        ttk.Label(right, text='② 选择目标').pack(side='left')
        if kind == 'card':
            chooser = ttk.Combobox(right, state='readonly', width=10, textvariable=data['target_kind'],
                                   values=('异画卡面', '其他卡牌', '本地动态异画'))
            chooser.pack(side='left', padx=8)
            chooser.bind('<<ComboboxSelected>>', lambda event: self.render_targets(kind))
        ttk.Checkbutton(right, text='仅显示清单已匹配项', variable=data['available'],
                        command=lambda: self.render_targets(kind)).pack(side='right')
        if kind == 'card':
            filters = ttk.Frame(frame)
            filters.grid(row=2, column=0, sticky='ew', pady=(0, 6))
            ttk.Label(filters, text='按角色：').pack(side='left')
            data['owner_filter'] = ttk.Combobox(filters, state='readonly')
            data['owner_filter'].pack(side='left', fill='x', expand=True)
            data['owner_filter'].bind('<<ComboboxSelected>>', lambda event: self.render_lists('card'))
            data['owner_keys'] = ['all']
            ttk.Label(frame, text='角色筛选仅影响左侧原卡；目标可跨角色选择。').grid(
                row=2, column=1, sticky='w', padx=(10, 0))
        for column, side in ((0, 'source'), (1, 'target')):
            entry = ttk.Entry(frame, textvariable=data[side + '_search'])
            entry.grid(row=1, column=column, sticky='ew', pady=6, padx=(10 if column else 0, 0))
            entry.bind('<KeyRelease>', lambda event, k=kind: self.render_lists(k))
            container = ttk.Frame(frame)
            container.grid(row=list_row, column=column, sticky='nsew', padx=(10 if column else 0, 0))
            tree = ttk.Treeview(container, columns=('name', 'id', 'state'), show='headings', selectmode='browse')
            for name, label, width in (('name', '名称', 190), ('id', '编号', 190), ('state', '显示类型', 100)):
                tree.heading(name, text=label)
                tree.column(name, width=width, minwidth=50)
            scroll = ttk.Scrollbar(container, orient='vertical', command=tree.yview)
            tree.configure(yscrollcommand=scroll.set)
            scroll.pack(side='right', fill='y')
            tree.pack(fill='both', expand=True)
            data[side] = tree
        data['source'].bind('<<TreeviewSelect>>', lambda event: self.render_targets(kind))
        data['target'].bind('<<TreeviewSelect>>', lambda event: self.show_detail(kind))
        return data

    def active_kind(self):
        return 'card'

    def changed(self):
        self.dirty = True

    def pick_tables(self):
        path = filedialog.askdirectory(title='选择包含 card.json 的表目录')
        if path:
            self.tables_var.set(path)

    def pick_manifest(self):
        path = filedialog.askopenfilename(title='选择资源清单', filetypes=[('资源清单', '*.ssra')])
        if path:
            self.manifest_var.set(path)

    def load_data(self):
        if self.busy:
            return
        if self.items and not messagebox.askyesno('重新加载', '重新加载会清空当前选择，是否继续？'):
            return
        try:
            catalog = Catalog(self.tables_var.get(), self.manifest_var.get())
        except (OSError, ValueError, KeyError) as exc:
            messagebox.showerror('数据加载失败', str(exc))
            return
        self.catalog, self.items, self.dirty, self.last_saved = catalog, [], False, None
        tab = self.tabs['card']
        groups = catalog.card_groups()
        tab['owner_keys'] = ['all'] + [owner for owner, label, count in groups] + [None]
        other_count = sum(owner is None for owner in catalog.card_owners.values())
        tab['owner_filter']['values'] = [f'全部原卡（{len(catalog.cards)}）'] + [
            f'{label} [{owner}]（{count}）' for owner, label, count in groups] + [f'其他／未归类（{other_count}）']
        tab['owner_filter'].current(0)
        for kind in self.tabs:
            self.render_lists(kind)
        self.render_mappings()
        available = sum(row['available'] for row in catalog.targets.values())
        self.status.set('已加载 %d 张卡、%d 张异画；%d 个卡面目标已匹配清单。%s' % (
            len(catalog.cards), len(catalog.card_skins), available,
            '数据版本已核对，游戏效果待实测。' if catalog.version_verified else '数据版本未核对一致，暂不能导出。'))

    @staticmethod
    def matches(query, *parts):
        return query.casefold() in ' '.join(str(p) for p in parts).casefold()

    def render_lists(self, kind):
        if not self.catalog:
            return
        tab = self.tabs[kind]
        tree = tab['source']
        previous = tree.selection()
        tree.delete(*tree.get_children())
        rows = self.catalog.cards
        group = tab['owner_keys'][max(0, tab['owner_filter'].current())] if kind == 'card' else 'all'
        for key, row in rows.items():
            owner = self.catalog.card_owners.get(key) if kind == 'card' else None
            if kind == 'card' and group != 'all' and owner != group:
                continue
            label = self.catalog.label(row)
            owner_label = self.catalog.label(self.catalog.characters[owner]) if owner else ''
            if self.matches(tab['source_search'].get(), label, key, owner_label):
                state = '动态' if row.get('spine_model', 'none') != 'none' else '静态'
                tree.insert('', 'end', iid=key, values=(label, key, state))
        if previous and tree.exists(previous[0]):
            tree.selection_set(previous)
        self.render_targets(kind)

    def render_targets(self, kind):
        if not self.catalog:
            return
        tab = self.tabs[kind]
        tree = tab['target']
        previous = tree.selection()
        tree.delete(*tree.get_children())
        rows = self.catalog.targets
        for key, target in rows.items():
            target_kind = {'异画卡面': 'card_skin', '其他卡牌': 'card', '本地动态异画': 'local_dynamic'}[tab['target_kind'].get()]
            if target['kind'] != target_kind or (tab['available'].get() and not target['available']):
                continue
            label = target['label']
            state = ('动态' if target['row'].get('spine_model', 'none') != 'none' else '静态') if target['available'] else '资源未匹配'
            if self.matches(tab['target_search'].get(), label, key):
                tree.insert('', 'end', iid=key, values=(label, key, state))
        if previous and tree.exists(previous[0]):
            tree.selection_set(previous)

    def show_detail(self, kind):
        selected = self.tabs[kind]['target'].selection()
        if not selected or not self.catalog:
            return
        target = self.catalog.targets[selected[0]]
        row = target['row']
        self.detail.set('目标：%s；图片：%s；动态骨架：%s。%s' % (
            target['label'], row.get('sct_name', 'none'), row.get('spine_directory', 'card') + '/' + row.get('spine_model', 'none'),
            '缺少：' + ', '.join(target['missing']) if target['missing'] else '资源名称已匹配清单；实际加载待实测。'))

    def add_mapping(self):
        if self.busy or not self.catalog:
            return
        kind = self.active_kind()
        source, target = self.tabs[kind]['source'].selection(), self.tabs[kind]['target'].selection()
        if not source or not target:
            messagebox.showinfo('尚未选择', '需要同时选择左侧来源和右侧目标。')
            return
        item = {'kind': kind, 'source': source[0], 'target': target[0], 'enabled': True}
        proposed = [old for old in self.items if old['source'] != item['source']] + [item]
        try:
            self.catalog.compile(proposed)
        except MappingError as exc:
            messagebox.showerror('无法添加', str(exc))
            return
        self.items = proposed
        self.changed()
        self.render_mappings()

    def render_mappings(self):
        self.mapping_tree.delete(*self.mapping_tree.get_children())
        if not self.catalog:
            return
        for index, item in enumerate(self.items):
            source_row = self.catalog.cards[item['source']]
            target = self.catalog.targets[item['target']]
            self.mapping_tree.insert('', 'end', iid=str(index), values=(
                '启用' if item['enabled'] else '关闭',
                self.catalog.label(source_row) + ' [' + item['source'] + ']', target['label'] + ' [' + item['target'] + ']'))

    def toggle_mapping(self):
        selection = self.mapping_tree.selection()
        if selection and not self.busy:
            index = int(selection[0])
            proposed = [dict(item) for item in self.items]
            proposed[index]['enabled'] = not proposed[index]['enabled']
            try:
                self.catalog.compile(proposed)
            except MappingError as exc:
                messagebox.showerror('状态未更改', str(exc))
                return
            self.items = proposed
            self.changed()
            self.render_mappings()

    def delete_mapping(self):
        selection = self.mapping_tree.selection()
        if selection and not self.busy:
            self.items.pop(int(selection[0]))
            self.changed()
            self.render_mappings()

    def open_config(self):
        if self.busy or not self.catalog:
            return
        path = filedialog.askopenfilename(title='载入本选择器保存的配置', filetypes=[('JSON', '*.json')])
        if not path:
            return
        try:
            items, _ = self.catalog.load_selection(path)
        except (OSError, ValueError) as exc:
            messagebox.showerror('配置未载入', str(exc))
            return
        if self.dirty and not messagebox.askyesno('尚未保存', '载入将替换当前未保存的选择，是否继续？'):
            return
        self.items, self.last_saved, self.dirty = items, path, False
        self.render_mappings()
        self.status.set('已载入：' + path)

    def save_config(self):
        if self.busy or not self.catalog:
            return
        try:
            document = self.catalog.compile(self.items)
        except MappingError as exc:
            messagebox.showerror('无法保存', str(exc))
            return
        out = APP_DIR / 'out'
        out.mkdir(exist_ok=True)
        path = filedialog.asksaveasfilename(title='保存自选配置', initialdir=out,
                                           initialfile='skin_redirects.json', defaultextension='.json',
                                           filetypes=[('JSON', '*.json')])
        if not path:
            return
        if Path(path).suffix.lower() != '.json':
            messagebox.showerror('保存未执行', '配置文件需要使用 .json 扩展名。')
            return
        try:
            atomic_json(path, document)
        except OSError as exc:
            messagebox.showerror('保存失败', str(exc))
            return
        self.last_saved, self.dirty = path, False
        self.status.set('已保存：%s。接着点“生成测试副本”，选择结果将包含在副本中；当前未安装到游戏。' % path)

    def start_job(self, work):
        if self.busy:
            return
        self.busy = True
        def worker():
            try:
                self.events.put(('done', work()))
            except Exception as exc:
                self.events.put(('error', str(exc)))
        threading.Thread(target=worker, daemon=True).start()

    def pump(self):
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == 'line':
                    self.status.set(str(payload))
                    continue
                self.busy = False
                if kind == 'error':
                    self.status.set('操作失败：' + payload)
                    messagebox.showerror('操作失败', payload)
                elif isinstance(payload, tuple) and payload[0] == 'preview':
                    self.show_preview(payload[1], payload[2])
                elif isinstance(payload, tuple) and payload[0] == 'prepared':
                    self.tables_var.set(str(payload[1]))
                    self.manifest_var.set(str(payload[2]))
                    self.load_data()
                else:
                    self.status.set(str(payload))
        except queue.Empty:
            pass
        self.poll_id = self.root.after(100, self.pump)

    def preview_source(self):
        self.preview_card('source')

    def preview_target(self):
        self.preview_card('target')

    def prepare_local_data(self):
        if self.busy:
            return
        manifest = self.manifest_var.get()
        if not Path(manifest).is_file():
            manifest = filedialog.askopenfilename(title='选择游戏 gameres 目录里的 manifest.ssra', filetypes=[('资源清单', '*.ssra')])
        if not manifest:
            return
        from prepare_data import prepare_catalog
        self.status.set('正在准备本地数据，游戏文件只读……')
        self.start_job(lambda: ('prepared', *prepare_catalog(manifest, lambda line: self.events.put(('line', line)))))

    def preview_card(self, side):
        if self.busy or not self.catalog:
            return
        kind = self.active_kind()
        selection = self.tabs[kind][side].selection()
        role = '原卡' if side == 'source' else '目标'
        if kind != 'card' or not selection:
            messagebox.showinfo('图片预览', '先选择左侧原卡。' if side == 'source' else '先选择右侧目标卡面。')
            return
        row = self.catalog.cards[selection[0]] if side == 'source' else self.catalog.targets[selection[0]]['row']
        stem = row.get('sct_name', 'none')
        if stem == 'none':
            messagebox.showinfo('图片预览', '这张%s没有单独的静态卡图；动态骨架预览暂未接入。' % role)
            return
        from selector_jobs import extract_preview
        manifest = self.catalog.manifest
        title = role + ' · ' + self.catalog.label(row) + ' [' + row['id'] + ']'
        self.status.set('正在导出%s图片……' % role)
        self.start_job(lambda: ('preview', extract_preview(manifest, stem), title))

    def show_preview(self, path, title='静态卡图'):
        try:
            image = tk.PhotoImage(file=str(path))
            factor = max(1, (image.width() + 559) // 560, (image.height() + 679) // 680)
            image = image.subsample(factor)
            window = tk.Toplevel(self.root)
            window.title(title + ' · 静态卡图')
            label = ttk.Label(window, image=image)
            label.image = image
            label.pack(padx=12, pady=12)
            self.status.set('已导出并打开：' + str(path))
        except tk.TclError as exc:
            messagebox.showerror('图片未打开', str(exc))

    def build_copy(self):
        if self.busy or not self.catalog:
            return
        try:
            document = self.catalog.compile(self.items)
        except MappingError as exc:
            messagebox.showerror('无法生成', str(exc))
            return
        source = filedialog.askopenfilename(title='选择接着加工的游戏程序副本', filetypes=[('程序', '*.exe')])
        if not source:
            return
        from selector_jobs import build_trial
        self.status.set('正在独立输出目录生成测试副本，输入文件保持只读……')
        manifest = self.catalog.manifest
        self.start_job(lambda: build_trial(source, document, manifest, lambda line: self.events.put(('line', line))))

    def close(self):
        if self.busy:
            messagebox.showinfo('操作进行中', '等待当前导出或生成结束后再关闭。')
            return
        if self.dirty and not messagebox.askyesno('尚未保存', '有未保存的修改，是否关闭窗口？'):
            return
        self.root.after_cancel(self.poll_id)
        self.root.destroy()


def main():
    root = tk.Tk()
    try:
        ttk.Style(root).theme_use('vista')
    except tk.TclError:
        pass
    Selector(root)
    root.mainloop()


if __name__ == '__main__':
    main()
