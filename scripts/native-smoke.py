"""Linux native smoke check. Supply an official Zotero executable; uses a new isolated directory."""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
import argparse
import json
import os
import platform
import signal
import subprocess
import threading
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('zotero', type=Path, help='Path to the official Zotero executable')
parser.add_argument('--work-directory', type=Path, required=True, help='New directory for disposable profile, fixture library and logs')
args = parser.parse_args()
source = Path(__file__).resolve().parent.parent
work = args.work_directory.resolve()
work.mkdir(parents=True, exist_ok=False)  # Refuse to reuse any existing user profile.
profile = work / 'profile'
(profile / 'extensions').mkdir(parents=True)
data = work / 'data'
data.mkdir()

def fixture_pdf(path, lines):
    content = 'BT /F1 14 Tf 60 760 Td ' + ' 0 -28 Td '.join('(' + line + ') Tj' for line in lines) + ' ET'
    stream = content.encode('ascii')
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream']
    output = b'%PDF-1.4\n'; offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(output)); output += str(i).encode() + b' 0 obj\n' + obj + b'\nendobj\n'
    start = len(output)
    output += b'xref\n0 6\n0000000000 65535 f \n' + b''.join(('%010d 00000 n \n' % off).encode() for off in offsets[1:])
    output += b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + str(start).encode() + b'\n%%EOF\n'
    path.write_bytes(output)

fixture_pdf(work / 'fixture.pdf', ['Randomization and Causal Inference', 'Sample size is 42. The control group uses random assignment.', 'Synthetic reading material for interface testing.'])
fixture_pdf(work / 'supplement.pdf', ['Supplemental Material', 'Alternative sample size is 99.'])

fixture_reply = r'''## 先看研究设计

这项研究采用**随机分组**，样本量为 **42**。[F001]

随机分组有助于减少选择偏差，让两组在研究开始时更有机会处于可比状态。这是理解因果推断的一个起点。

### 用公式辅助理解

把样本量记作 $n=42$，总体方差记作 \(\sigma^2\)。例如，独立同分布样本均值的方差可写成：

$$
\operatorname{Var}(\bar{Y})
= \frac{\sigma^2}{n}
$$

这个公式用于说明统计记号；当前文献片段没有提供方差估计，不能据此计算实际研究的误差。[F001]

### 阅读时关注两点

- **分组方式**：原文片段明确提到随机分配。[F001]
- **结论边界**：当前材料没有报告效果大小，不能据此判断干预是否有效。

### 接下来怎么读

1. 核对样本的纳入标准，以及随机分组的具体流程。
2. 找到结果表，比较两组的差异与不确定性。

| Measure | 记录 |
| --- | --- |
| 样本量 | 42 |
| 原文依据 | F001 |

可以先用一行代码记下样本量，后续再补充研究设计信息：

```javascript
const sampleSize = 42;
const literalMath = "$x^2$";
console.log(sampleSize);
```

> 这是一段用于界面验收的模拟科研对话，不代表真实发表的研究结论。
'''

network_requests = []
(work / 'network-requests.json').write_text('[]', encoding='utf-8')

class MockAPI(BaseHTTPRequestHandler):
    def record_request(self, body_size):
        # Record enough to audit method, endpoint, and authentication without
        # persisting an Authorization header or the API key itself.
        network_requests.append({
            'method': self.command, 'path': self.path, 'bodyBytes': body_size,
            'authorizationMatchesFixture': self.headers.get('Authorization') == 'Bearer sk-native-fixture-only',
        })
        (work / 'network-requests.json').write_text(json.dumps(network_requests, indent=2), encoding='utf-8')

    def do_GET(self):
        body_size = int(self.headers.get('Content-Length', '0'))
        if body_size:
            self.rfile.read(body_size)
        self.record_request(body_size)
        if self.path == '/user/balance':
            payload = {'is_available': True, 'balance_infos': [{
                'currency': 'CNY', 'total_balance': '110.00',
                'granted_balance': '10.00', 'topped_up_balance': '100.00',
            }]}
            status = 200
        else:
            payload = {'error': {'message': 'Unknown mock endpoint'}}
            status = 404
        response = json.dumps(payload).encode()
        self.send_response(status); self.send_header('Content-Type', 'application/json')
        self.end_headers(); self.wfile.write(response)

    def do_POST(self):
        body_size = int(self.headers['Content-Length'])
        body = json.loads(self.rfile.read(body_size))
        self.record_request(body_size)
        (work / 'request.json').write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding='utf-8')
        response = json.dumps({'model': 'fixture-model', 'choices': [{'message': {'content': fixture_reply}, 'finish_reason': 'stop'}], 'usage': {'total_tokens': 42}}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(response)
    def log_message(self, *_args):
        pass

server = HTTPServer(('127.0.0.1', 0), MockAPI)
threading.Thread(target=server.serve_forever, daemon=True).start()
prefs = {
    'extensions.zotero.dataDir': str(data), 'extensions.zotero.useDataDir': True,
    'extensions.zotero.firstRun2': False, 'extensions.zotero.firstRunGuidance': False,
    'extensions.autoDisableScopes': 0, 'extensions.enabledScopes': 15,
    'extensions.startupScanScopes': 15, 'app.update.auto': False, 'extensions.update.enabled': False,
    'extensions.zotero.automaticUpdates': False,
    'extensions.zotero.automaticScraperUpdates': False,
    'browser.theme.toolbar-theme': 1,
    'extensions.research-companion.testOutput': str(work / 'native-report.json'),
    'extensions.research-companion.testPDF': str(work / 'fixture.pdf'),
    'extensions.research-companion.testAPI': 'http://127.0.0.1:' + str(server.server_port),
    'extensions.research-companion.testXPI': str(work / 'production.xpi'),
}
(profile / 'user.js').write_text('\n'.join('user_pref(' + json.dumps(k) + ', ' + json.dumps(v) + ');' for k, v in prefs.items()), encoding='utf-8')
runtime = [source / name for name in ('manifest.json', 'bootstrap.js', 'style.css', 'LICENSE', 'THIRD_PARTY_NOTICES.md')]
for folder in ('modules', 'locale', 'icons', 'vendor'):
    runtime.extend(p for p in (source / folder).rglob('*') if p.is_file())
with zipfile.ZipFile(work / 'production.xpi', 'w', zipfile.ZIP_DEFLATED) as package:
    for path in runtime:
        package.writestr(path.relative_to(source).as_posix(), path.read_bytes())
with zipfile.ZipFile(profile / 'extensions/research-companion@local.zotero.xpi', 'w', zipfile.ZIP_DEFLATED) as package:
    for path in runtime:
        contents = path.read_bytes()
        if path.name == 'bootstrap.js':
            contents = contents.replace(b'await companion.start();', b'await companion.start();\nServices.scriptloader.loadSubScript(rootURI + "native-check.js", globalThis);')
        package.writestr(path.relative_to(source).as_posix(), contents)
    package.writestr('native-check.js', (source / 'tests/native-check.js').read_bytes())
task_tmp = work / 'tmp'
task_tmp.mkdir()
environment = dict(os.environ, MOZ_HEADLESS='1', TMPDIR=str(task_tmp), TMP=str(task_tmp), TEMP=str(task_tmp))
timed_out = False
with (work / 'runtime.log').open('w') as log:
    process = subprocess.Popen([str(args.zotero.resolve()), '-no-remote', '-profile', str(profile), '-ZoteroDebugText'], env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        process.wait(timeout=120)
    except subprocess.TimeoutExpired:
        timed_out = True
        if os.name == 'posix': os.killpg(process.pid, signal.SIGTERM)
        else: process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            if os.name == 'posix': os.killpg(process.pid, signal.SIGKILL)
            else: process.kill()
            process.wait()
    finally:
        server.shutdown()
        server.server_close()
report_path = work / 'native-report.json'
try:
    report = json.loads(report_path.read_text(encoding='utf-8'))
except (OSError, json.JSONDecodeError) as error:
    report = {'checks': [], 'errors': ['Native report missing or invalid: ' + str(error)], 'complete': False}
report['launcher'] = {'exitCode': process.returncode, 'timedOut': timed_out, 'operatingSystem': platform.system()}
if timed_out:
    report['errors'].append('Zotero exceeded the process timeout; inspect runtime.log')
elif not report.get('complete'):
    report['errors'].append('Zotero exited before the native test completed; inspect runtime.log')
if process.returncode != 0:
    report['errors'].append('Zotero process exited with code ' + str(process.returncode) + '; inspect runtime.log')
report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
passed = sum(check['passed'] for check in report['checks'])
print(str(passed) + '/' + str(len(report['checks'])) + ' native checks passed. Zotero exit code: ' + str(process.returncode) + '. Report: ' + str(report_path))
if report['errors'] or not report.get('complete') or not all(check['passed'] for check in report['checks']):
    raise SystemExit(json.dumps(report['errors'], ensure_ascii=False))
