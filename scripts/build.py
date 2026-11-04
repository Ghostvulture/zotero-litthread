"""Build a self-contained Zotero XPI and complete source archive. Python 3.8+."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'dist'
OUT.mkdir(exist_ok=True)
manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
version = manifest['version']
assert manifest['applications']['zotero']['strict_min_version'] == '7.0'
assert manifest['applications']['zotero']['strict_max_version'] == '10.0.*'
assert version == json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
assert manifest['applications']['zotero']['update_url'].startswith('https://')
runtime_roots = ['manifest.json', 'bootstrap.js', 'style.css', 'LICENSE', 'THIRD_PARTY_NOTICES.md']
runtime_directories = ('modules', 'icons', 'locale', 'vendor')
source_directories = runtime_directories + ('scripts', 'tests', 'docs', '.github')
source_roots = runtime_roots + ['package.json', 'CHANGELOG.md', 'CONTRIBUTING.md', '.gitignore', '.gitattributes']
excluded_directories = {
    'dist', '.git', '__pycache__', 'node_modules', '.pytest_cache', '.cache', '.venv', 'venv',
    '.idea', '.vscode', '.tox', '.mypy_cache', '.ruff_cache',
    'work', 'tmp', 'profile', 'data', 'zotero-profile', 'research-companion',
}
excluded_suffixes = {
    '.xpi', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
    '.pyc', '.pyo', '.tmp', '.temp', '.log', '.bak', '.swp', '.swo',
    '.sqlite', '.sqlite-wal', '.sqlite-shm',
}

def distributable(path):
    relative = path.relative_to(ROOT)
    return (path.is_file() and not path.is_symlink()
            and not any(part in excluded_directories for part in relative.parts)
            and path.suffix.lower() not in excluded_suffixes
            and path.name not in {'.DS_Store', 'Thumbs.db', '.env'}
            and not path.name.startswith('.env.') and not path.name.endswith('~'))

def directory_files(folders):
    return [path.relative_to(ROOT).as_posix() for folder in folders
            for path in (ROOT / folder).rglob('*') if distributable(path)]

runtime = runtime_roots + directory_files(runtime_directories)

def archive(destination, names):
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as target:
        for name in sorted(names):
            data = (ROOT / name).read_bytes()
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            target.writestr(info, data, compresslevel=9)
    with zipfile.ZipFile(destination) as target:
        assert target.testzip() is None
    print(destination)

xpi = OUT / ('zotero-litthread-' + version + '.xpi')
source = OUT / ('zotero-litthread-' + version + '-source.zip')
archive(xpi, runtime)
# Deliberately do not glob the whole repository. A developer may keep private
# work, Zotero profiles or knowledge files beside the checked-in source, and
# .gitignore does not affect Python's filesystem traversal.
source_files = directory_files(source_directories)
source_files.extend(name for name in source_roots if distributable(ROOT / name))
source_files.extend(path.name for path in ROOT.glob('README*.md') if distributable(path))
source_files = sorted(set(source_files))
archive(source, source_files)
(OUT / 'SHA256SUMS.txt').write_text('\n'.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name for p in (xpi, source)) + '\n', encoding='utf-8')
