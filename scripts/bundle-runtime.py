"""Build a standalone native analysis engine and bundle the CalculiX solver
with the shared libraries it needs, beside it in runtime/solver.

macOS bundles the solver scripts/build-solver.py builds, relocating its
Homebrew dylibs; Windows and Linux bundle the solver found by find_ccx (CI
uses conda-forge calculix, via SPRUNG_FEA_CCX). What the solver can do
(calculix.capabilities) is written beside it as ccx.json."""
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
from calculix import capabilities
import json
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
    # the solver needs, transitively, from the folders of its (conda)
    # environment: imports, and exports forwarded to another DLL (conda's
    # libblas/liblapack forward to openblas.dll). The rest belong to Windows.
    import pefile
    exe=solver/'ccx.exe';shutil.copy2(source,exe)
    prefix=source.parent.parent.parent if source.parent.parent.name.lower()=='library' else source.parent
    folders=[source.parent,prefix/'Library'/'bin',prefix/'Library'/'mingw-w64'/'bin',prefix]
    system=Path(os.environ.get('SystemRoot','C:/Windows'))/'System32'
    seen=set();queue=[source];missing=[]
    while queue:
        pe=pefile.PE(str(queue.pop(0)),fast_load=True)
        pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY[d] for d in ('IMAGE_DIRECTORY_ENTRY_IMPORT','IMAGE_DIRECTORY_ENTRY_EXPORT')])
        names=[entry.dll.decode() for entry in getattr(pe,'DIRECTORY_ENTRY_IMPORT',[])]
        export=getattr(pe,'DIRECTORY_ENTRY_EXPORT',None)
        # A forwarder reads "target.symbol" or "target.dll.symbol".
        for symbol in export.symbols if export else []:
            if not symbol.forwarder:continue
            target=symbol.forwarder.decode().rsplit('.',1)[0]
            names.append(target if target.lower().endswith('.dll') else target+'.dll')
        pe.close()
        for name in names:
            key=name.lower()
            # API sets and the universal CRT always resolve inside Windows.
            if key in seen or key.startswith(('api-ms-','ext-ms-')) or key=='ucrtbase.dll':continue
            seen.add(key)
            dep=next((f/name for f in folders if (f/name).is_file()),None)
            if dep:shutil.copy2(dep,solver/dep.name);queue.append(dep)
            elif not (system/name).is_file():missing.append(name)
    if missing:sys.exit('Solver libraries not found: '+', '.join(missing))


{'darwin':bundle_mac,'win32':bundle_windows}.get(sys.platform,bundle_linux)()
# The bundled solver must start from its own folder alone. A missing library
# fails here, silently, with no version banner (ccx -v exits nonzero anyway).
check=subprocess.run([str(solver/('ccx.exe' if sys.platform=='win32' else 'ccx')),'-v'],capture_output=True,text=True,
                     env={k:v for k,v in os.environ.items() if k not in ('PATH','LD_LIBRARY_PATH','DYLD_LIBRARY_PATH')})
if 'This is Version' not in check.stdout:
    sys.exit(f'The bundled solver does not start (exit {check.returncode}): {check.stdout}{check.stderr}')
(solver/'ccx.json').write_text(json.dumps(capabilities(source),indent=1)+'\n')
if sys.platform=='darwin' and not capabilities(source).get('pardiso'):
    print('Warning: this solver has neither the Accelerate direct solver nor thread-safe SPOOLES. Build it with scripts/build-solver.py.')
print('Standalone engine:',runtime/'sprung-fea-engine','with solver',sorted(p.name for p in solver.iterdir()))
