"""Build a standalone native analysis engine and bundle the CalculiX solver
with the shared libraries it needs, beside it in runtime/solver.

macOS relocates the Homebrew solver's dylibs; Windows and Linux bundle the
solver found by find_ccx (CI uses conda-forge calculix, via SPRUNG_FEA_CCX)."""
import os, sys, subprocess, shutil
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
                '--add-binary',str(lib)+os.pathsep+'.','--exclude-module','tkinter','--exclude-module','matplotlib',str(root/'engine/worker.py')],check=True,
                env={**os.environ,'PYINSTALLER_CONFIG_DIR':str(root/'.sprung-fea/pyinstaller-cache')})
sys.path.insert(0,str(root/'engine'));from worker import find_ccx
solver=runtime/'solver'
shutil.rmtree(solver,ignore_errors=True);solver.mkdir()
source=Path(find_ccx())


def bundle_mac():
    exe=solver/'ccx';shutil.copy2(source,exe);exe.chmod(0o755)
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


def bundle_linux():
    # ldd lists the whole dependency closure. glibc, the loader and other
    # base-system libraries stay with the system; everything else (gfortran,
    # gomp, quadmath, BLAS, ARPACK) is copied and found through $ORIGIN.
    exe=solver/'ccx';shutil.copy2(source,exe);exe.chmod(0o755)
    system=('/lib/','/lib64/','/usr/lib/','/usr/lib64/')
    copied=[]
    for line in subprocess.check_output(['ldd',str(source)],text=True).splitlines():
        if '=>' not in line:continue
        dep=line.split('=>')[1].split(' (')[0].strip()
        if not dep or dep.startswith(system):continue
        dest=solver/Path(line.split('=>')[0].strip()).name
        shutil.copy2(dep,dest);dest.chmod(0o755);copied.append(dest)
    for binary in [*copied,exe]:subprocess.run(['patchelf','--set-rpath','$ORIGIN',str(binary)],check=True)


def bundle_windows():
    # Windows loads DLLs from the executable's folder first. Copy every DLL
    # the solver imports, transitively, that ships beside it; the rest
    # (kernel32, the universal CRT) belong to Windows.
    import pefile
    exe=solver/'ccx.exe';shutil.copy2(source,exe)
    seen=set();queue=[source]
    while queue:
        pe=pefile.PE(str(queue.pop(0)),fast_load=True)
        pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_IMPORT']])
        for entry in getattr(pe,'DIRECTORY_ENTRY_IMPORT',[]):
            name=entry.dll.decode().lower()
            dep=source.parent/entry.dll.decode()
            # API-set names (api-ms-win-crt-*) always resolve inside Windows.
            if name in seen or name.startswith(('api-ms-','ext-ms-')) or not dep.is_file():continue
            seen.add(name);shutil.copy2(dep,solver/dep.name);queue.append(dep)
        pe.close()


{'darwin':bundle_mac,'win32':bundle_windows}.get(sys.platform,bundle_linux)()
# The bundled solver must start from its own folder alone. A missing library
# fails here, silently, with no version banner (ccx -v exits nonzero anyway).
check=subprocess.run([str(solver/('ccx.exe' if sys.platform=='win32' else 'ccx')),'-v'],capture_output=True,text=True,
                     env={k:v for k,v in os.environ.items() if k not in ('PATH','LD_LIBRARY_PATH','DYLD_LIBRARY_PATH')})
if 'This is Version' not in check.stdout:
    sys.exit(f'The bundled solver does not start (exit {check.returncode}): {check.stdout}{check.stderr}')
print('Standalone engine:',runtime/'sprung-fea-engine','with solver',sorted(p.name for p in solver.iterdir()))
