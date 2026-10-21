"""Build a portable distribution from explicit tool/dependency inputs."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--ripper', type=Path, required=True)
    parser.add_argument('--node-license', type=Path, required=True)
    parser.add_argument('--ripper-license', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('dist'))
    parser.add_argument('--version', default='0.2.1')
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    output = args.output.resolve()
    target = output / 'card-change'
    if target.exists():
        raise SystemExit('Output exists; choose a new --output directory to preserve it.')
    subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--onedir', '--windowed',
                    '--name', 'card-change', '--distpath', str(output),
                    '--workpath', str(here / 'build' / ('portable-' + args.version)),
                    '--specpath', str(here / 'build'), '--hidden-import', 'pefile',
                    '--exclude-module', 'unittest', '--exclude-module', 'test',
                    '--add-data', str(here / 'payload.js') + ';.',
                    '--add-data', str(here / 'table.json') + ';.',
                    '--add-data', str(here / 'dryrun.js') + ';.',
                    '--add-data', str(here / 'assets' / 'db-format-xor.hex') + ';assets',
                    '--log-level', 'WARN', str(here / 'portable_main.py')], cwd=here, check=True)
    for source, destination in (
            (args.node, target / 'runtime' / 'node.exe'),
            (args.ripper, target / 'tools' / 'asset-ripper' / 'ChaosZeroNightmareRipper-CLI.exe'),
            (args.node_license, target / 'licenses' / 'Node.js.txt'),
            (args.ripper_license, target / 'licenses' / 'ASSet-Ripper.txt'),
            (here / 'LICENSE', target / 'LICENSE'),
            (here / 'REDIRECTS.md', target / '使用说明.md')):
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    notices = here / 'THIRD_PARTY_NOTICES.md'
    if notices.is_file():
        shutil.copy2(notices, target / notices.name)
    for name in ('README.md', 'CHANGELOG.md', 'RELEASE_CHECKS.json'):
        path = here / name
        if path.is_file():
            shutil.copy2(path, target / name)
    for folder in ('licenses',):
        source = here / folder
        if source.is_dir():
            shutil.copytree(source, target / folder, dirs_exist_ok=True)
    inventory = {str(p.relative_to(target)).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in target.rglob('*') if p.is_file()}
    (target / 'SHA256.json').write_text(json.dumps(inventory, indent=2) + '\n', encoding='utf-8')
    archive = output / ('card-change-' + args.version + '-windows-x64.zip')
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for path in sorted(target.rglob('*')):
            if path.is_file():
                z.write(path, 'card-change/' + str(path.relative_to(target)).replace('\\', '/'))
    print(json.dumps({'archive': str(archive), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                      'bytes': archive.stat().st_size, 'files': len(inventory)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
