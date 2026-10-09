"""Build a standalone native analysis engine and bundle the CalculiX solver
with the shared libraries it needs, beside it in runtime/solver.

The solver is the one find_ccx finds: the one scripts/build-solver.py
builds into solver/, else an installed CalculiX (SPRUNG_FEA_CCX).
solverlibs.relocate copies its libraries. What the solver was built with
(calculix.built_capabilities) is written beside it as ccx.json. On Linux
and Windows, sprung-solve, the separate program that runs PARDISO with
Intel oneMKL, goes into runtime/solver/sprung-solve with its licenses."""
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
sys.path.insert(0,str(root/'scripts'));from solverlibs import relocate
from calculix import built_capabilities, HELPER_BANNER
import json
solver=runtime/'solver'
shutil.rmtree(solver,ignore_errors=True);solver.mkdir()
source=Path(find_ccx())
# A conda environment's libraries sit apart from its executables on Windows.
prefix=source.parent.parent.parent if source.parent.parent.name.lower()=='library' else source.parent
relocate(source,solver,[prefix/'Library'/'bin',prefix/'Library'/'mingw-w64'/'bin',prefix] if sys.platform=='win32' else [])
built=built_capabilities(source)
helper=built.get('pardisoHelper')
if helper:
    helper=source.parent/helper
    place=solver/'sprung-solve'
    relocate(helper,place,[helper.parent],check=('--version',HELPER_BANNER))
    for license in helper.parent.glob('*.txt'): shutil.copy2(license,place/license.name)
(solver/'ccx.json').write_text(json.dumps(built,indent=1)+'\n')
if not built.get('pardiso'):
    print('Warning: this solver has no PARDISO, only SPOOLES. Build it with scripts/build-solver.py.')
print('Standalone engine:',runtime/'sprung-fea-engine','with solver',sorted(str(p.relative_to(solver)) for p in solver.rglob('*') if p.is_file()))
