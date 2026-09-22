"""Local check of the deployment file list and rsync backup behaviour; no SSH."""
from pathlib import Path
from tempfile import TemporaryDirectory
import subprocess

root = Path(__file__).resolve().parents[1]
files = (root / 'deploy/public-files.txt').read_text().splitlines()
assert files == ['api.php', 'assets/app.js', 'assets/favicon.svg', 'assets/style.css', 'index.html']
with TemporaryDirectory(prefix='kourage-transfer-check-') as folder:
    site = Path(folder) / 'courage'
    target = site / 'public_html'
    (target / 'assets').mkdir(parents=True)
    (site / 'private/uploads').mkdir(parents=True)
    (site / '.code-backups/test').mkdir(parents=True)
    protected = {
        site / 'private/kourage.sqlite': b'live student data',
        site / 'private/uploads/student.txt': b'live submission',
        target / '.htaccess': b'custom web server settings',
        target / '.user.ini': b'custom PHP settings',
        target / 'extra.html': b'existing extra page',
    }
    for file, content in protected.items():
        file.write_bytes(content)
    for name in files:
        (target / name).write_text('previous code: ' + name)
    subprocess.run([
        'rsync', '--recursive', '--times', '--checksum', '--omit-dir-times',
        '--delay-updates', '--chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r', '--backup',
        '--backup-dir=../.code-backups/test',
        '--files-from=' + str(root / 'deploy/public-files.txt'),
        str(root / 'public_html') + '/', str(target) + '/',
    ], check=True)
    for name in files:
        assert (target / name).read_bytes() == (root / 'public_html' / name).read_bytes()
        assert (site / '.code-backups/test' / name).read_text() == 'previous code: ' + name
    for file, content in protected.items():
        assert file.read_bytes() == content, str(file)
print('PASS: only the five listed code files changed; old code backed up; database, uploads, configuration and other pages preserved. This is a local transfer test, not a live deployment.')
