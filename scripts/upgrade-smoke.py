"""Exercise a real in-process XPI upgrade in a fresh, disposable Zotero profile.

Example (Linux, official Zotero build):
  python3 scripts/upgrade-smoke.py /path/to/zotero \
    --from-xpi ../research-companion-0.2.0.xpi \
    --to-xpi ../research-companion-0.3.0.xpi \
    --work-directory /tmp/rc-upgrade-new-directory

The installed production XPIs are byte-for-byte copies. A separate helper
extension drives AddonManager and the UI; the tested extension is not modified.
No real API key, account, existing Zotero profile, or external API is used.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import platform
import shutil
import signal
import subprocess
import zipfile


HELPER_ID = 'research-companion-upgrade-test@local.zotero'


def package_info(path):
    with zipfile.ZipFile(path) as package:
        manifest = json.loads(package.read('manifest.json'))
        app = manifest['applications']['zotero']
        if not isinstance(app['id'], str) or not app['id'] or any(char in app['id'] for char in '/\\\x00') or app['id'] in ('.', '..'):
            raise ValueError('Unsafe extension ID for an isolated profile')
        if app['id'] == HELPER_ID:
            raise ValueError('The tested extension must not have the helper ID')
        return {
            'name': path.name, 'id': app['id'], 'version': manifest['version'],
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'runtimeSHA256': {name: hashlib.sha256(package.read(name)).hexdigest()
                              for name in ('bootstrap.js', 'modules/app.js', 'style.css')},
        }


def fixture_pdf(path):
    stream = (b'BT /F1 14 Tf 60 760 Td (Synthetic Upgrade Fixture) Tj '
              b'0 -28 Td (Sample size is 42. This is isolated test data.) Tj ET')
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
               b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
               b'/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
               b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream']
    output, offsets = b'%PDF-1.4\n', []
    for number, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output += str(number).encode() + b' 0 obj\n' + obj + b'\nendobj\n'
    start = len(output)
    output += b'xref\n0 6\n0000000000 65535 f \n'
    output += b''.join(('%010d 00000 n \n' % offset).encode() for offset in offsets)
    output += b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + str(start).encode() + b'\n%%EOF\n'
    path.write_bytes(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('zotero', type=Path, help='Official Zotero executable')
    parser.add_argument('--from-xpi', type=Path, required=True, help='Unmodified installed old XPI')
    parser.add_argument('--to-xpi', type=Path, required=True, help='Unmodified replacement XPI')
    parser.add_argument('--work-directory', type=Path, required=True, help='Must not already exist')
    parser.add_argument('--timeout', type=int, default=180, help='Whole process limit in seconds (default 180)')
    parser.add_argument('--startup-only', action='store_true', help='Diagnostic control: create the same fixture and screenshots, then quit without installing the target XPI')
    args = parser.parse_args()
    old, new = package_info(args.from_xpi), package_info(args.to_xpi)
    if old['id'] != new['id']:
        parser.error('Both XPIs must have the same extension ID')
    if old['version'] == new['version']:
        parser.error('Supply distinct source and target manifest versions')
    if args.timeout < 30:
        parser.error('--timeout must be at least 30 seconds')
    executable = args.zotero.resolve(strict=True)
    source = Path(__file__).resolve().parent.parent
    work = args.work_directory.resolve()
    work.mkdir(parents=True, exist_ok=False)
    profile, data = work / 'profile', work / 'data'
    extensions = profile / 'extensions'
    extensions.mkdir(parents=True)
    data.mkdir()
    shutil.copyfile(args.from_xpi, work / 'from.xpi')
    shutil.copyfile(args.to_xpi, work / 'to.xpi')
    shutil.copyfile(work / 'from.xpi', extensions / (old['id'] + '.xpi'))
    fixture_pdf(work / 'fixture.pdf')
    config = {'schemaVersion': 1, 'helperID': HELPER_ID, 'from': old, 'to': new,
              'workDirectory': str(work), 'toXPI': str(work / 'to.xpi'),
              'fixturePDF': str(work / 'fixture.pdf'), 'startupOnly': args.startup_only,
              'reportPath': str(work / 'upgrade-report.json')}
    (work / 'upgrade-config.json').write_text(json.dumps(config, indent=2), encoding='utf-8')
    prefs = {
        'extensions.zotero.dataDir': str(data), 'extensions.zotero.useDataDir': True,
        'extensions.zotero.firstRun2': False, 'extensions.zotero.firstRunGuidance': False,
        'extensions.autoDisableScopes': 0, 'extensions.enabledScopes': 15,
        'extensions.startupScanScopes': 15, 'extensions.update.enabled': False,
        'app.update.auto': False, 'extensions.zotero.automaticUpdates': False,
        'extensions.zotero.automaticScraperUpdates': False,
        'browser.theme.toolbar-theme': 1,
        'extensions.research-companion-upgrade-test.config': str(work / 'upgrade-config.json'),
    }
    (profile / 'user.js').write_text('\n'.join(
        'user_pref(' + json.dumps(key) + ', ' + json.dumps(value) + ');'
        for key, value in prefs.items()), encoding='utf-8')
    manifest = {
        'manifest_version': 2, 'name': 'Research Companion isolated upgrade test helper',
        'version': '1.0.0', 'applications': {'zotero': {
            'id': HELPER_ID, 'strict_min_version': '7.0', 'strict_max_version': '10.0.*',
            'update_url': 'https://research-companion.invalid/upgrade-test-updates.json'}},
    }
    bootstrap = '''var upgradeTestStarted = false;
function startup({ rootURI }) {
  if (upgradeTestStarted) return;
  upgradeTestStarted = true;
  Services.scriptloader.loadSubScript(rootURI + "upgrade-check.js", globalThis);
}
function shutdown() {}
function install() {}
function uninstall() {}
'''
    with zipfile.ZipFile(extensions / (HELPER_ID + '.xpi'), 'w', zipfile.ZIP_DEFLATED) as package:
        package.writestr('manifest.json', json.dumps(manifest))
        package.writestr('bootstrap.js', bootstrap)
        package.writestr('upgrade-check.js', (source / 'tests/upgrade-check.js').read_bytes())
    # Zotero recursively removes TmpD/zotero on exit. Different profiles must
    # also have different temp roots, or concurrent runs delete each other's
    # bundled-translator extraction and PDF work files.
    temporary = work / 'tmp'
    temporary.mkdir()
    environment = dict(os.environ, MOZ_HEADLESS='1', TMPDIR=str(temporary),
                       TMP=str(temporary), TEMP=str(temporary))
    timed_out = False
    with (work / 'runtime.log').open('w') as log:
        process = subprocess.Popen([str(executable), '-no-remote', '-profile', str(profile), '-ZoteroDebugText'],
                                   env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            process.wait(timeout=args.timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            if os.name == 'posix':
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                if os.name == 'posix':
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
                process.wait()
    report_path = work / 'upgrade-report.json'
    if report_path.exists():
        report = json.loads(report_path.read_text(encoding='utf-8'))
    else:
        report = {'schemaVersion': 1, 'from': old, 'to': new, 'checks': [], 'errors': [], 'complete': False}
    report['launcher'] = {'exitCode': process.returncode, 'timedOut': timed_out,
                          'operatingSystem': platform.system(), 'singleProcessLaunch': True,
                          'isolatedTemporaryDirectory': str(temporary)}
    if timed_out:
        report['errors'].append('Zotero exceeded the process timeout; inspect runtime.log and partial snapshots')
    elif not report.get('complete'):
        report['errors'].append('Zotero exited before the helper completed; inspect runtime.log')
    if process.returncode != 0:
        report['errors'].append('Zotero process exited with code ' + str(process.returncode) + '; inspect runtime.log')
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    passed = sum(check['passed'] for check in report['checks'])
    print(f"{passed}/{len(report['checks'])} upgrade checks passed. Report: {report_path}")
    if report['errors'] or not report.get('complete') or not all(check['passed'] for check in report['checks']):
        for failure in [check for check in report['checks'] if not check['passed']]:
            print('FAIL: ' + failure['name'] + ' ' + str(failure.get('detail', '')))
        for error in report['errors']:
            print(error)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
