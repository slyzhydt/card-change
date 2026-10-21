"""Separate bundled read-only files from the portable app's local output."""
from pathlib import Path
import shutil
import sys

APP_DIR = Path(sys.executable).resolve().parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent
RESOURCE_DIR = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent))


def resource(name):
    return RESOURCE_DIR / name


def node_executable():
    bundled = APP_DIR / 'runtime' / 'node.exe'
    return str(bundled) if bundled.is_file() else (shutil.which('node') or 'node')


def ripper_executable():
    for root in (APP_DIR / 'tools' / 'asset-ripper', APP_DIR.parent / 'tools' / 'asset-ripper'):
        path = root / 'ChaosZeroNightmareRipper-CLI.exe'
        if path.is_file():
            return path
    raise FileNotFoundError('未找到解包组件，请完整解压发布包后再运行。')
