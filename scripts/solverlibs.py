"""Gathers the CalculiX solver, or sprung-solve, and the shared libraries it
needs into one folder that it runs from alone. Used by build-solver.py,
which leaves a self-contained solver/, and bundle-runtime.py, which copies
a solver into the application.

Libraries of the operating system stay with it: glibc and the base system
on Linux, /usr/lib and the system frameworks (Accelerate) on macOS, Windows'
own DLLs. Everything else (gfortran's runtime, OpenMP, OpenBLAS, ARPACK) is
copied beside the executable and found there:
through $ORIGIN on Linux, @loader_path on macOS, and the executable's folder
on Windows."""
import os, re, shutil, subprocess, sys
from pathlib import Path


def relocate(source, dest, folders=(), check=('-v','This is Version')):
    """Copies the executable `source` into the folder `dest` with the
    libraries it needs, found where the executable finds them or in
    `folders`, checks that it starts from there (run with the argument
    check[0], it prints check[1]), and returns the copy."""
    source,dest=Path(source),Path(dest)
    dest.mkdir(parents=True,exist_ok=True)
    exe=dest/source.name
    shutil.copy2(source,exe);exe.chmod(0o755)
    folders=[Path(f) for f in folders]
    {'darwin':_mac,'win32':_windows}.get(sys.platform,_linux)(source,exe,folders)
    # A missing library fails here, silently, with no banner (ccx -v exits
    # nonzero anyway).
    started=subprocess.run([str(exe),check[0]],capture_output=True,text=True,
                           env={k:v for k,v in os.environ.items() if k not in ('PATH','LD_LIBRARY_PATH','DYLD_LIBRARY_PATH')})
    if check[1] not in started.stdout:
        sys.exit(f'{exe} does not start (exit {started.returncode}): {started.stdout}{started.stderr}')
    return exe


def _linux(source, exe, folders):
    # Each library's own list of the libraries it needs (DT_NEEDED), found
    # through its run path as the loader would. ldd's listing is not enough:
    # it names a library once, though several names can lead to it (conda's
    # liblapacke.so.3 is libopenblas.so.0). Such a library is copied once,
    # under its own name (soname), and every reference renamed to that.
    patchelf=shutil.which('patchelf')
    if not patchelf: sys.exit('patchelf was not found.')
    system=[Path(p) for p in ('/lib64','/lib','/usr/lib64','/usr/lib','/lib/x86_64-linux-gnu','/usr/lib/x86_64-linux-gnu')]
    def output(*args):
        return subprocess.check_output([patchelf,*map(str,args)],text=True).split()
    queue=[(exe,source)];copied={}
    while queue:
        binary,original=queue.pop()
        rpath=':'.join(output('--print-rpath',binary))
        search=[Path(r.replace('$ORIGIN',str(original.parent))) for r in rpath.split(':') if r]+folders
        for name in output('--print-needed',binary):
            path=next((d/name for d in search if (d/name).is_file()),None)
            if path is None or path.parent in system:
                if any((d/name).exists() for d in system): continue
                sys.exit(f'{original} needs {name}, which was not found.')
            real=path.resolve()
            if real not in copied:
                own=output('--print-soname',real)
                dest=exe.parent/(own[0] if own else name)
                shutil.copy2(real,dest);dest.chmod(0o755)
                copied[real]=dest;queue.append((dest,path))
            if copied[real].name!=name:
                subprocess.run([patchelf,'--replace-needed',name,copied[real].name,str(binary)],check=True)
    for binary in [*copied.values(),exe]: subprocess.run([patchelf,'--set-rpath','$ORIGIN',str(binary)],check=True)


def _mac(source, exe, folders):
    system=('/usr/lib/','/System/')
    def lines(*args):
        return subprocess.check_output(['otool',*args],text=True).splitlines()[1:]
    def rpaths(binary, original):
        found=re.findall(r'^\s*path (.+?) \(offset',subprocess.check_output(['otool','-l',str(binary)],text=True),re.M)
        here=str(original.parent)
        return found,[Path(r.replace('@loader_path',here).replace('@executable_path',str(source.parent))) for r in found]
    def resolve(dep, original, search):
        name=Path(dep).name
        if dep.startswith('@rpath/'): candidates=[r/dep[7:] for r in search]
        elif dep.startswith('@loader_path/'): candidates=[original.parent/dep[13:]]
        elif dep.startswith('@executable_path/'): candidates=[source.parent/dep[17:]]
        else: candidates=[Path(dep)]
        return next((c for c in [*candidates,*(f/name for f in folders)] if c.is_file()),None)

    origin={exe:source};queue=[exe];copied={}
    while queue:
        binary=queue.pop(0);original=origin[binary]
        own=lines('-D',str(binary))
        own=own[0].strip() if own else None
        raw,search=rpaths(binary,original)
        for line in lines('-L',str(binary)):
            dep=line.strip().split(' (')[0]
            if dep==own or dep.startswith(system): continue
            path=resolve(dep,original,search)
            if not path: sys.exit(f'{original} needs {dep}, which was not found.')
            # Several names can lead to one library (conda's liblapack is
            # OpenBLAS): one copy, under the name of the file itself.
            real=path.resolve()
            if real not in copied:
                dest=exe.parent/real.name
                shutil.copy2(real,dest);dest.chmod(0o755)
                copied[real]=dest;origin[dest]=path;queue.append(dest)
            subprocess.run(['install_name_tool','-change',dep,'@loader_path/'+copied[real].name,str(binary)],check=True)
        if binary!=exe: subprocess.run(['install_name_tool','-id','@loader_path/'+binary.name,str(binary)],check=True)
        for r in raw: subprocess.run(['install_name_tool','-delete_rpath',r,str(binary)],check=True)
    # Editing invalidates the signatures that Apple silicon requires.
    for binary in [*copied.values(),exe]: subprocess.run(['codesign','--force','--sign','-',str(binary)],check=True)


def _windows(source, exe, folders):
    # Windows loads DLLs from the executable's folder first. Copy every DLL
    # the solver needs, transitively: imports, and exports forwarded to
    # another DLL (conda's libblas/liblapack forward to openblas.dll).
    import pefile
    folders=[source.parent,*folders]
    system=Path(os.environ.get('SystemRoot','C:/Windows'))/'System32'
    seen=set();queue=[source];missing=[]
    while queue:
        pe=pefile.PE(str(queue.pop(0)),fast_load=True)
        pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY[d] for d in ('IMAGE_DIRECTORY_ENTRY_IMPORT','IMAGE_DIRECTORY_ENTRY_EXPORT')])
        names=[entry.dll.decode() for entry in getattr(pe,'DIRECTORY_ENTRY_IMPORT',[])]
        export=getattr(pe,'DIRECTORY_ENTRY_EXPORT',None)
        # A forwarder reads "target.symbol" or "target.dll.symbol".
        for symbol in export.symbols if export else []:
            if not symbol.forwarder: continue
            target=symbol.forwarder.decode().rsplit('.',1)[0]
            names.append(target if target.lower().endswith('.dll') else target+'.dll')
        pe.close()
        for name in names:
            key=name.lower()
            # API sets and the universal CRT always resolve inside Windows.
            if key in seen or key.startswith(('api-ms-','ext-ms-')) or key=='ucrtbase.dll': continue
            seen.add(key)
            dep=next((f/name for f in folders if (f/name).is_file()),None)
            if dep:
                if dep.resolve()!=(exe.parent/dep.name).resolve(): shutil.copy2(dep,exe.parent/dep.name)
                queue.append(dep)
            elif not (system/name).is_file(): missing.append(name)
    if missing: sys.exit('Solver libraries not found: '+', '.join(missing))
