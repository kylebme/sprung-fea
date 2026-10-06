"""Build CalculiX 2.23 for macOS with multithreaded SPOOLES that is safe on
Apple silicon and with Apple Accelerate behind its PARDISO interface.

Writes solver/ccx, which the engine and bundle-runtime.py use before any
installed CalculiX, and solver/ccx.json, which tells the engine what the
build can do. Needs Homebrew gcc (gfortran) and arpack, and the Xcode
command line tools.

SPOOLES 2.2's threaded factor and solve hand work between threads through
plain loads and stores. Apple silicon reorders them, so threaded solves
silently lose updates and return wrong answers. The patches in
native/calculix/spooles-patches, from conda-forge's spooles feedstock (build
1006), order those hand-offs. native/calculix/accelerate_pardiso.c answers
CalculiX's PARDISO calls with Accelerate's multithreaded sparse Cholesky,
LDLT and LU, which ship with macOS."""
import hashlib, json, os, shutil, subprocess, sys, tarfile, urllib.request
from pathlib import Path

root=Path(__file__).resolve().parents[1]
native=root/'native'/'calculix'
work=root/'.sprung-fea'/'solver-build'
downloads=root/'.sprung-fea'/'downloads'
SOURCES={
    'ccx':('https://www.dhondt.de/ccx_2.23.src.tar.bz2','9c88385c10fb04f5dc6c4e98027a51bebdd8aee3920e05190d6c1dd08357d6e7'),
    'spooles':('https://www.netlib.org/linalg/spooles/spooles.2.2.tgz','a84559a0e987a1e423055ef4fdf3035d55b65bbe4bf915efaa1a35bef7f8c5dd'),
}
# Electron's minimum macOS. Accelerate's LU is used where the OS has it.
DEPLOYMENT_TARGET='12.0'
jobs=str(os.cpu_count() or 4)


def fetch(name):
    url,digest=SOURCES[name]
    path=downloads/Path(url).name
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:
        downloads.mkdir(parents=True,exist_ok=True)
        print('Downloading',url)
        with urllib.request.urlopen(url) as response: path.write_bytes(response.read())
    if hashlib.sha256(path.read_bytes()).hexdigest()!=digest:
        sys.exit(f'{path.name} does not match its expected SHA-256.')
    return path


def replace(path, old, new):
    text=path.read_text(errors='surrogateescape')
    if text.count(old)!=1: sys.exit(f'{path}: expected one occurrence of {old!r}')
    path.write_text(text.replace(old,new),errors='surrogateescape')


def run(*args, cwd=None, env=None):
    subprocess.run([str(a) for a in args],cwd=cwd,check=True,env={**os.environ,**(env or {})})


def tool(name):
    found=shutil.which(name)
    if not found: sys.exit(f'{name} was not found. Install it with: brew install gcc arpack')
    return found


def build_spooles():
    source=work/'spooles';source.mkdir(parents=True)
    with tarfile.open(fetch('spooles')) as archive: archive.extractall(source)
    for patch in sorted((native/'spooles-patches').glob('*.patch')):
        run('patch','-p1','--batch','--forward','-i',patch,cwd=source)
    # The library's file list names a file the distribution does not have.
    replace(source/'Tree'/'src'/'makeGlobalLib','drawTree.c','tree.c')
    replace(source/'Make.inc','  CC = /usr/lang-4.0/bin/cc','  CC = clang')
    replace(source/'Make.inc','  OPTLEVEL = -O\n','  OPTLEVEL = -O2\n')
    run('make','lib',cwd=source)
    # The threaded factor and solve go into the same library.
    run('make','-C','MT/src','makeLib',cwd=source)
    return source


def build_ccx(spooles):
    with tarfile.open(fetch('ccx')) as archive: archive.extractall(work)
    src=work/'CalculiX'/'ccx_2.23'/'src'
    # A void function that returns a value (as Homebrew's formula fixes).
    replace(src/'readnewmesh.c','*iprfnp=iprfn;*konrfnp=konrfn;*ratiorfnp=ratiorfn;\n  \n  return NULL;',
            '*iprfnp=iprfn;*konrfnp=konrfn;*ratiorfnp=ratiorfn;\n  \n  return;')
    cflags=f'-O2 -I{spooles} -I{native} -DARCH="Linux" -DSPOOLES -DARPACK -DMATRIXSTORAGE -DNETWORKOUT -DUSE_MT=1 -DPARDISO'
    env={'MACOSX_DEPLOYMENT_TARGET':DEPLOYMENT_TARGET}
    run('make',f'-j{jobs}','ccx_2.23.a','CC=clang',f'FC={tool("gfortran")}',f'CFLAGS={cflags}','FFLAGS=-O2 -fopenmp -cpp',cwd=src,env=env)
    run('clang',*cflags.replace('"Linux"','Linux').split(),'-c','ccx_2.23.c','-o','ccx_main.o',cwd=src,env=env)
    run('clang','-O2','-Wall','-c',native/'accelerate_pardiso.c','-o','accelerate_pardiso.o',cwd=src,env=env)
    # Link with clang: gfortran's own SDK can predate Accelerate's LU.
    runtime=Path(subprocess.check_output([tool('gfortran'),'-print-file-name=libgfortran.dylib'],text=True).strip()).parent
    arpack=Path(subprocess.check_output(['brew','--prefix','arpack'],text=True).strip())/'lib'
    run('clang','-o','ccx','ccx_main.o','ccx_2.23.a','accelerate_pardiso.o',spooles/'spooles.a',
        f'-L{arpack}','-larpack','-framework','Accelerate',f'-L{runtime}','-lgfortran','-lgomp','-lquadmath',cwd=src,env=env)
    return src/'ccx'


def main():
    if sys.platform!='darwin':
        sys.exit('build-solver.py builds the macOS solver. Windows and Linux use conda-forge calculix 2.23 (build 8 or later), whose SPOOLES carries the same thread fixes.')
    shutil.rmtree(work,ignore_errors=True);work.mkdir(parents=True)
    executable=build_ccx(build_spooles())
    target=root/'solver';target.mkdir(exist_ok=True)
    shutil.copy2(executable,target/'ccx')
    (target/'ccx.json').write_text(json.dumps({'version':'2.23','threadSafeSpooles':True,'pardiso':'Apple Accelerate'},indent=1)+'\n')
    banner=subprocess.run([str(target/'ccx'),'-v'],capture_output=True,text=True).stdout
    if 'This is Version 2.23' not in banner: sys.exit('The built solver does not start: '+banner)
    print('Solver:',target/'ccx')


if __name__=='__main__': main()
