"""Frozen GUI entry point with repeatable, non-interactive delivery checks."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

from mapping import atomic_json
from runtime_paths import node_executable, resource, ripper_executable


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--selfcheck', action='store_true')
    parser.add_argument('--prepare-data')
    parser.add_argument('--build')
    parser.add_argument('--config')
    parser.add_argument('--manifest')
    parser.add_argument('--report')
    args = parser.parse_args()
    result = {}
    try:
        if args.selfcheck:
            import tkinter as tk
            import pefile
            import engine
            from selector import Selector
            count, _ = engine.node_gate(str(resource('dryrun.js')), str(resource('table.json')),
                                        str(resource('payload.js')), lambda message: None)
            root = tk.Tk()
            root.withdraw()
            try:
                app = Selector(root)
                result = {'passed': True, 'javascript_checks': count, 'gui_created': True,
                          'card_tabs': len(app.notebook.tabs()), 'node': node_executable(),
                          'ripper': str(ripper_executable()), 'pefile': pefile.__version__,
                          'frozen': bool(getattr(sys, 'frozen', False))}
                root.after_cancel(app.poll_id)
            finally:
                root.destroy()
        elif args.prepare_data:
            from prepare_data import prepare_catalog
            tables, manifest = prepare_catalog(args.prepare_data)
            result = {'passed': True, 'tables': str(tables), 'manifest': str(manifest)}
        elif args.build:
            if not args.config or not args.manifest:
                raise ValueError('--build 需要 --config 与 --manifest')
            from selector_jobs import build_trial
            document = json.loads(Path(args.config).read_text(encoding='utf-8-sig'))
            message = build_trial(args.build, document, args.manifest, lambda message: None)
            result = {'passed': True, 'result': message, 'installed': False}
        else:
            from selector import main as gui_main
            gui_main()
            return 0
    except Exception as exc:
        result = {'passed': False, 'error': str(exc)}
    if args.report:
        atomic_json(args.report, result)
    elif sys.stdout is not None:
        print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get('passed') else 1


if __name__ == '__main__':
    raise SystemExit(main())
