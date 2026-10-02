from pathlib import Path
import json, shutil, sys
from importlib.metadata import distribution, PackageNotFoundError
root=Path(__file__).resolve().parents[1];dest=root/'licenses';dest.mkdir(exist_ok=True)
# Keep licenses for installed production packages, including nested dependencies.
lock=json.loads((root/'package-lock.json').read_text())
for location,metadata in lock['packages'].items():
    if not location or metadata.get('dev'):continue
    package=root/location
    for pattern in ['LICENSE*','license*','COPYING*','OFL*']:
        for file in package.glob(pattern):
            if file.is_file():
                name=location.removeprefix('node_modules/').replace('/','_')+'-'+file.name
                shutil.copy2(file,dest/name)
for file in [Path(sys.base_prefix)/'LICENSE.txt',Path(sys.base_prefix)/'LICENSE']:
    if file.exists():shutil.copy2(file,dest/'Python.txt')

# PyInstaller's redistributed bootloader includes its licensing exception.
try:
    package=distribution('pyinstaller')
    for file in package.files or []:
        if str(file).endswith('licenses/COPYING.txt'):
            shutil.copy2(package.locate_file(file),dest/'PyInstaller.txt')
except PackageNotFoundError:
    pass
