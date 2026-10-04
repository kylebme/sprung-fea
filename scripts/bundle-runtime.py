"""Build a standalone native macOS analysis engine and relocate solver dylibs."""
import os, sys, subprocess, shutil, importlib.util, re
from pathlib import Path
root=Path(__file__).resolve().parents[1]
runtime=root/'runtime';runtime.mkdir(exist_ok=True)
subprocess.run([sys.executable,str(root/'scripts/collect-licenses.py')],check=True)
lib=root/'.venv/lib/libgmsh.4.15.dylib'
if not lib.exists():
    import gmsh
    lib=Path(gmsh.libpath)
subprocess.run([sys.executable,'-m','PyInstaller','--noconfirm','--clean','--onefile','--name','sprung-fea-engine',
                '--distpath',str(runtime),'--workpath',str(root/'.sprung-fea/pyinstaller'),'--specpath',str(root/'.sprung-fea'),
                '--add-binary',str(lib)+':.','--exclude-module','tkinter','--exclude-module','matplotlib',str(root/'engine/worker.py')],check=True,
                env={**os.environ,'PYINSTALLER_CONFIG_DIR':str(root/'.sprung-fea/pyinstaller-cache')})
sys.path.insert(0,str(root/'engine'));from worker import find_ccx
solver=runtime/'solver';solver.mkdir(exist_ok=True)
exe=solver/'ccx';shutil.copy2(find_ccx(),exe);exe.chmod(0o755)
copied={};queue=[exe]
while queue:
    binary=queue.pop(0)
    output=subprocess.check_output(['otool','-L',str(binary)],text=True)
    for line in output.splitlines()[1:]:
        dep=line.strip().split(' (')[0]
        if not dep.startswith('/opt/homebrew/') and not dep.startswith('/usr/local/'):continue
        dest=solver/Path(dep).name
        if dep not in copied:
            shutil.copy2(dep,dest);dest.chmod(0o755);copied[dep]=dest;queue.append(dest)
        subprocess.run(['install_name_tool','-change',dep,'@loader_path/'+dest.name,str(binary)],check=True)
    if binary!=exe:subprocess.run(['install_name_tool','-id','@loader_path/'+binary.name,str(binary)],check=True)
for binary in [*copied.values(),exe]:subprocess.run(['codesign','--force','--sign','-',str(binary)],check=True)
print('Standalone engine:',runtime/'sprung-fea-engine')
