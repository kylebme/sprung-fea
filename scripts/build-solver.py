"""Build CalculiX 2.23 with its fastest direct solvers, on Apple silicon,
Linux x64 and Windows x64.

Writes solver/ccx (ccx.exe) with the libraries it needs beside it
(solverlibs.py), which the engine and bundle-runtime.py use before any
installed CalculiX, and solver/ccx.json, which tells the engine what the
build can do. The compilers and libraries come from a conda-forge
environment, native/calculix/solver-env-<platform>.yml: pass its folder
with --prefix, or run with it active (CONDA_PREFIX). macOS also needs the
Xcode command line tools.

The build carries three direct solvers, all multithreaded:
- SPOOLES 2.2. Its threaded factor and solve hand work between threads
  through plain loads and stores, which lose updates and return wrong
  answers (often on Apple silicon). The patches in
  native/calculix/spooles-patches, from conda-forge's spooles feedstock
  (build 1006), order those hand-offs.
- PARDISO: Apple Accelerate's sparse factorizations on macOS, through
  native/calculix/accelerate_pardiso.c. Elsewhere it is Intel MKL's, which
  is not free software and is not linked or shipped:
  native/calculix/mkl_pardiso.c loads an MKL the user has installed, when
  CalculiX first calls PARDISO.
- PaStiX 6, through native/calculix/pastix_ccx.c in place of CalculiX's
  pastix.c, which needs a fork of PaStiX. PaStiX is conda-forge's on
  Linux, and built here from its release archive on macOS and Windows."""
import argparse, concurrent.futures, hashlib, json, os, re, shutil, subprocess, sys, tarfile, urllib.request
from pathlib import Path

root=Path(__file__).resolve().parents[1]
native=root/'native'/'calculix'
work=root/'.sprung-fea'/'solver-build'
downloads=root/'.sprung-fea'/'downloads'
VERSION='2.23'
SOURCES={
    'ccx':(['https://www.dhondt.de/ccx_2.23.src.tar.bz2'],'9c88385c10fb04f5dc6c4e98027a51bebdd8aee3920e05190d6c1dd08357d6e7'),
    # The Debian/Ubuntu archive keeps the identical file.
    'spooles':(['https://www.netlib.org/linalg/spooles/spooles.2.2.tgz',
                'http://archive.ubuntu.com/ubuntu/pool/universe/s/spooles/spooles_2.2.orig.tar.gz'],
               'a84559a0e987a1e423055ef4fdf3035d55b65bbe4bf915efaa1a35bef7f8c5dd'),
    'pastix':(['https://files.inria.fr/pastix/releases/v6/pastix-6.4.0.tar.gz'],'891d426188eed56c1075fb34d2d80132593a1536ffc05cf333567f68a4811e55'),
}
SPOOLES_PATCHES=(
    '0000-transform-ivinit.patch',
    '0001-MT-add-acquire-release-primitives-and-order-the-work.patch',
    '0002-MT-order-the-frontIsDone-p_mtx-publication-in-the-so.patch',
    '0003-MT-make-the-solve-s-three-inter-phase-barriers-actua.patch',
    '0004-MT-stop-losing-updates-on-the-factor-s-entry-counter.patch',
    '0005-MT-give-each-solve-thread-its-own-cpus-vector.patch',
    '0006-I2Ohash-fix-int-overflow-in-the-bucket-index.patch',
)
# Electron's minimum macOS. Accelerate's LU is used where the OS has it.
DEPLOYMENT_TARGET='12.0'
MAC,WINDOWS=sys.platform=='darwin',sys.platform=='win32'
# What GCC 14 and clang 16 made errors, and older C (CalculiX; PaStiX's
# code without hwloc) still relies on.
LENIENT=[f'-Wno-error={w}' for w in ('implicit-function-declaration','implicit-int','int-conversion','incompatible-pointer-types')]
jobs=os.cpu_count() or 4


def fetch(name):
    urls,digest=SOURCES[name]
    path=downloads/Path(urls[0]).name
    def valid():
        return path.exists() and (digest is None or hashlib.sha256(path.read_bytes()).hexdigest()==digest)
    for url in urls:
        if valid(): break
        downloads.mkdir(parents=True,exist_ok=True)
        print('Downloading',url,flush=True)
        try:
            with urllib.request.urlopen(url,timeout=120) as response: path.write_bytes(response.read())
        except OSError as error: print(' ',error)
    if not valid(): sys.exit(f'{path.name} could not be downloaded, or does not match its expected SHA-256.')
    print(f'{path.name}: SHA-256 {hashlib.sha256(path.read_bytes()).hexdigest()}')
    return path


def extract(archive, destination):
    with tarfile.open(archive) as tar:
        if hasattr(tarfile,'data_filter'): tar.extractall(destination,filter='data')
        else: tar.extractall(destination)


def replace(path, old, new, count=1):
    text=path.read_text(errors='surrogateescape')
    if text.count(old)!=count: sys.exit(f'{path}: expected {count} occurrence(s) of {old!r}')
    path.write_text(text.replace(old,new),errors='surrogateescape')


def run(*args, cwd=None, env=None, quiet=False):
    result=subprocess.run([str(a) for a in args],cwd=cwd,env={**os.environ,**(env or {})},
                          capture_output=quiet,text=True)
    if result.returncode:
        if quiet: print(result.stdout,result.stderr)
        sys.exit(f'Failed ({result.returncode}): {" ".join(str(a) for a in args)}')


class Toolchain:
    """The environment's compilers and libraries."""
    def __init__(self, prefix):
        self.prefix=prefix
        self.env={}
        if WINDOWS:
            base=prefix/'Library'
            self.bin,self.lib,self.include=base/'bin',base/'lib',base/'include'
            self.cc,self.fc,self.ar=(self.tool('x86_64-w64-mingw32-'+t) for t in ('gcc','gfortran','ar'))
            # The MinGW tools load DLLs from the environment, which is not
            # activated.
            self.env={'PATH':os.pathsep.join([str(self.bin),str(prefix),os.environ.get('PATH','')])}
        elif MAC:
            self.bin,self.lib,self.include=prefix/'bin',prefix/'lib',prefix/'include'
            sdk=subprocess.check_output(['xcrun','--show-sdk-path'],text=True).strip()
            # gfortran runs the environment's clang to assemble.
            self.env={'MACOSX_DEPLOYMENT_TARGET':DEPLOYMENT_TARGET,'SDKROOT':sdk,
                      'PATH':os.pathsep.join([str(self.bin),os.environ.get('PATH','')])}
            # Xcode's clang: its SDK declares Accelerate's sparse LU.
            self.cc,self.ar=shutil.which('clang'),shutil.which('ar')
            self.fc=self.tool('arm64-apple-darwin20.0.0-gfortran')
        else:
            self.bin,self.lib,self.include=prefix/'bin',prefix/'lib',prefix/'include'
            self.cc,self.fc,self.ar=(self.tool('x86_64-conda-linux-gnu-'+t) for t in ('gcc','gfortran','ar'))

    def tool(self, name):
        path=self.bin/(name+('.exe' if WINDOWS else ''))
        if not path.is_file(): sys.exit(f'{path} was not found. Create the build environment from native/calculix/solver-env-*.yml.')
        return path

    def compile(self, sources, objects, flags, cwd, fortran=False):
        """Compiles in parallel; sources and objects pair up."""
        compiler=self.fc if fortran else self.cc
        def one(pair):
            source,obj=pair
            result=subprocess.run([str(compiler),*flags,'-c',str(source),'-o',str(obj)],cwd=cwd,
                                  env={**os.environ,**self.env},capture_output=True,text=True)
            return source,result
        with concurrent.futures.ThreadPoolExecutor(jobs) as pool:
            for source,result in pool.map(one,list(zip(sources,objects))):
                if result.returncode:
                    print(result.stdout,result.stderr)
                    sys.exit(f'Compiling {source} failed (exit {result.returncode:#x}).')

    def archive(self, library, objects):
        library.unlink(missing_ok=True)
        # A response file keeps Windows' command line short.
        listing=library.with_suffix('.txt')
        listing.write_text('\n'.join(str(o).replace('\\','/') for o in objects))
        if MAC: run(self.ar,'rcs',library,*objects,env=self.env)
        else: run(self.ar,'rcs',library,f'@{listing}',env=self.env)


def spooles_patches():
    """The thread fixes, in order. A missing one would still build a solver
    that starts, but whose threaded solves give wrong answers, so refuse."""
    folder=native/'spooles-patches'
    found=sorted(folder.glob('*.patch'))
    missing=[name for name in SPOOLES_PATCHES if not (folder/name).is_file()]
    extra=[path.name for path in found if path.name not in SPOOLES_PATCHES]
    if missing or extra:
        sys.exit(f'{folder} does not hold the expected SPOOLES patches.'
                 +(f'\nMissing: {", ".join(missing)}' if missing else '')
                 +(f'\nUnexpected: {", ".join(extra)} (add them to SPOOLES_PATCHES)' if extra else ''))
    return [folder/name for name in SPOOLES_PATCHES]


def build_spooles(tc):
    """spooles.a: the library modules SPOOLES's own makefile lists, and its
    threaded factor and solve (MT). Every source of each module is
    compiled; the module makefiles' lists are stale, and the linker takes
    only what CalculiX uses. Objects are named per module, as the makefiles
    do, because file names repeat between modules."""
    patches=spooles_patches()
    source=work/'spooles';source.mkdir(parents=True)
    extract(fetch('spooles'),source)
    patch=shutil.which('patch')
    if not patch: sys.exit('patch was not found. On Windows, run the build from Git Bash.')
    for p in patches: run(patch,'-p1','--batch','--forward',*(['--binary'] if WINDOWS else []),'-i',p,cwd=source)
    modules=re.findall(r'^\s*cd (\w+)\s*; make lib',(source/'makefile').read_text(),re.M)
    objects=source/'objects';objects.mkdir()
    for module in [*modules,'MT']:
        files=sorted((source/module/'src').glob('*.c'))
        tc.compile(files,[objects/f'{module}_{f.stem}.o' for f in files],['-O2','-w'],cwd=source/module/'src')
    library=source/'spooles.a'
    tc.archive(library,sorted(objects.glob('*.o')))
    return source,library


def scotch_windows(tc):
    """Scotch as a MinGW DLL. conda-forge's Windows Scotch is a static
    library built by Microsoft's compiler, which MinGW links once given the
    few runtime pieces it expects (native/calculix/msvc_compat.c). Exports
    Scotch's API only; returns a prefix with include, lib and bin."""
    out=work/'scotch-mingw'
    for d in ('include','lib','bin'): (out/d).mkdir(parents=True)
    tool=lambda name: tc.tool('x86_64-w64-mingw32-'+name)
    static=[tc.lib/'scotch.lib',tc.lib/'scotcherr.lib']
    symbols=subprocess.check_output([str(tool('nm')),*map(str,static)],text=True,env={**os.environ,**tc.env},stderr=subprocess.DEVNULL)
    exports=sorted({l.split()[2] for l in symbols.splitlines() if len(l.split())==3 and l.split()[1]=='T' and l.split()[2].startswith('SCOTCH_')})
    (out/'scotch.def').write_text('EXPORTS\n'+'\n'.join(exports)+'\n')
    tc.compile([native/'msvc_compat.c'],[out/'msvc_compat.o'],['-O2'],cwd=out)
    run(tc.cc,'-shared','-o',out/'bin'/'scotch.dll',out/'scotch.def',f'-Wl,--out-implib,{out/"lib"/"libscotch.dll.a"}',
        # MSVC's stack probe is MinGW's ___chkstk_ms under another name.
        '-Wl,--defsym,__chkstk=___chkstk_ms','-Wl,--whole-archive',*static,'-Wl,--no-whole-archive',out/'msvc_compat.o',
        tc.lib/'zlib.lib',tc.lib/'libbz2.lib',tc.lib/'lzma.lib',cwd=out,env=tc.env)
    # PaStiX looks for scotcherr beside scotch: it is inside the same DLL.
    shutil.copy2(out/'lib'/'libscotch.dll.a',out/'lib'/'libscotcherr.dll.a')
    shutil.copy2(tc.include/'scotch.h',out/'include'/'scotch.h')
    return out


def build_pastix(tc):
    """PaStiX 6.4 from its release archive, for macOS and Windows: Scotch for
    ordering and OpenBLAS through CBLAS/LAPACKE, from the environment, with
    64-bit indices as conda-forge builds it for Linux. conda-forge has none
    for Windows, and its macOS build pairs PaStiX with a Scotch (7.0.5)
    whose threaded ordering aborts there; Scotch orders on one thread here
    (ordering takes a fraction of a second; the factorization is what PaStiX
    threads). No hwloc, as on Linux. Installs into the build folder; returns
    its prefix."""
    scotch=scotch_windows(tc) if WINDOWS else tc.prefix
    # conda's OpenBLAS is BLAS, CBLAS, LAPACK and LAPACKE in one library;
    # on Windows its headers have their own folder.
    headers=tc.include/'openblas' if WINDOWS else tc.include
    source=work/'pastix-src';source.mkdir()
    extract(fetch('pastix'),source)
    tree=next(source.iterdir())
    # PaStiX's code for running without hwloc does not build: it calls a
    # pastix_warning that 6.4 does not have, and on macOS sysctl without its
    # header. Its one notice goes to stderr, which pastix_ccx.c silences.
    isched=tree/'common'/'isched_nohwloc.c'
    text=isched.read_text()
    if 'pastix_warning(' not in text: sys.exit(f'{isched}: expected pastix_warning calls to replace')
    isched.write_text('#include <stdio.h>\n#ifdef __APPLE__\n#include <sys/types.h>\n#include <sys/sysctl.h>\n#endif\n'
                      +text.replace('pastix_warning(','fprintf(stderr,'))
    build,install=work/'pastix-build',work/'pastix'
    cmake=tc.tool('cmake')
    run(cmake,'-S',tree,'-B',build,'-G','Ninja',f'-DCMAKE_MAKE_PROGRAM={tc.tool("ninja")}',
        '-DCMAKE_BUILD_TYPE=Release',f'-DCMAKE_INSTALL_PREFIX={install}',
        f'-DCMAKE_PREFIX_PATH={scotch};{tc.prefix/"Library" if WINDOWS else tc.prefix}',f'-DSCOTCH_DIR={scotch}',
        f'-DCMAKE_C_COMPILER={tc.cc}',f'-DCMAKE_Fortran_COMPILER={tc.fc}',f'-DPython_EXECUTABLE={sys.executable}',
        *([f'-DCMAKE_OSX_DEPLOYMENT_TARGET={DEPLOYMENT_TARGET}'] if MAC else []),
        f'-DCMAKE_C_FLAGS={" ".join(LENIENT)}','-DBUILD_SHARED_LIBS=ON','-DPASTIX_INT64=ON','-DPASTIX_ORDERING_SCOTCH=ON',
        '-DPASTIX_ORDERING_SCOTCH_MT=OFF','-DPASTIX_ORDERING_METIS=OFF',
        '-DPASTIX_WITH_MPI=OFF','-DPASTIX_WITH_CUDA=OFF','-DPASTIX_WITH_STARPU=OFF','-DPASTIX_WITH_PARSEC=OFF',
        '-DPASTIX_WITH_FORTRAN=OFF','-DSPM_WITH_FORTRAN=OFF','-DSPM_WITH_MPI=OFF','-DBUILD_TESTING=OFF',
        '-DBLA_VENDOR=OpenBLAS',f'-DCBLAS_INCDIR={headers}',f'-DLAPACKE_INCDIR={headers}',
        env=tc.env)
    run(cmake,'--build',build,'--parallel',str(jobs),env=tc.env)
    run(cmake,'--install',build,env=tc.env)
    return install


def ccx_sources(src):
    """CalculiX's Fortran and C sources (its Makefile.inc), CalculiX's PaStiX
    interface replaced by ours. The list can name a file the release does
    not have (2.23: mafillmm.c); the link reports anything really missing."""
    text=(src/'Makefile.inc').read_text()
    def listed(name):
        block=re.search(rf'^{name}\s*=(.*?)(?:\n\s*\n|\Z)',text,re.M|re.S).group(1)
        files=re.findall(r'[\w.-]+\.[cf]\b',block)
        absent=[f for f in files if not (src/f).is_file()]
        if absent: print('Listed in Makefile.inc but not in the source:',', '.join(absent))
        return [f for f in files if f not in absent]
    c=[f for f in listed('SCCXC') if f!='pastix.c']
    return listed('SCCXF'),c


def build_ccx(tc, spooles, spooles_lib):
    extract(fetch('ccx'),work)
    src=work/'CalculiX'/f'ccx_{VERSION}'/'src'
    # A void function that returns a value (as Homebrew's formula fixes).
    replace(src/'readnewmesh.c','*iprfnp=iprfn;*konrfnp=konrfn;*ratiorfnp=ratiorfn;\n  \n  return NULL;',
            '*iprfnp=iprfn;*konrfnp=konrfn;*ratiorfnp=ratiorfn;\n  \n  return;')
    capabilities={'version':VERSION,'threadSafeSpooles':True}
    defines=['-DARCH=Linux','-DSPOOLES','-DARPACK','-DMATRIXSTORAGE','-DNETWORKOUT','-DUSE_MT=1','-DPARDISO','-DPASTIX']
    # native/calculix/mkl_service.h stands in for MKL's header: no build
    # links MKL.
    includes=[f'-I{spooles}',f'-I{native}',f'-I{tc.include}']
    if MAC:
        extra=[native/'accelerate_pardiso.c']
        capabilities['pardiso']='Apple Accelerate'
        libs=['-framework','Accelerate']
    else:
        extra=[native/'mkl_pardiso.c']
        # Present only where the engine finds an installed MKL.
        capabilities['pardiso']='Intel MKL';capabilities['pardisoNeedsMkl']=True
        libs=[] if WINDOWS else ['-ldl']
    # conda-forge's PaStiX on Linux; built here elsewhere (build_pastix).
    pastix=tc.prefix if not (MAC or WINDOWS) else build_pastix(tc)
    includes.append(f'-I{pastix/"include"}')
    capabilities['pastix']='PaStiX 6.4'
    extra.append(native/'pastix_ccx.c')

    cflags=['-O2','-w',*LENIENT,*includes,*defines]
    fortran,c=ccx_sources(src)
    objects=src/'objects';objects.mkdir()
    print(f'Compiling CalculiX: {len(fortran)} Fortran and {len(c)+len(extra)} C files',flush=True)
    fobj=[objects/(Path(f).stem+'_f.o') for f in fortran]
    tc.compile([src/f for f in fortran],fobj,['-O2','-w','-fopenmp','-cpp','-fallow-argument-mismatch'],cwd=src,fortran=True)
    cfiles=[src/f for f in c]+extra
    cobj=[objects/(f.stem+'_c.o') for f in cfiles]
    tc.compile(cfiles,cobj,cflags,cwd=src)
    main=src/f'ccx_{VERSION}.c'
    tc.compile([main],[objects/'ccx_main.o'],cflags,cwd=src)
    library=src/f'ccx_{VERSION}.a'
    tc.archive(library,fobj+cobj)

    exe=src/('ccx.exe' if WINDOWS else 'ccx')
    if WINDOWS:
        # conda's MinGW-built ARPACK sits apart from the MSVC-style libraries;
        # OpenBLAS's import library carries BLAS and LAPACK.
        blas=[f'-L{tc.prefix/"Library"/"mingw-w64"/"lib"}','-larpack',f'-L{tc.lib}','-lopenblas']
    else:
        blas=[f'-L{tc.lib}','-larpack','-llapack','-lblas']
    common=[objects/'ccx_main.o',library,spooles_lib,f'-L{pastix/"lib"}','-lpastix','-lspm',*blas]
    if MAC:
        # Link with Xcode's clang, which knows the SDK. gfortran's runtime
        # and OpenMP (LLVM's, which implements gfortran's GOMP calls) come
        # from the environment.
        run(tc.cc,'-o',exe,*common,*libs,'-lgfortran','-lomp',f'-Wl,-rpath,{tc.lib}',cwd=src,env=tc.env)
    elif WINDOWS:
        run(tc.fc,'-o',exe,*common,*libs,'-fopenmp','-lpthread',cwd=src,env=tc.env)
    else:
        run(tc.fc,'-o',exe,*common,*libs,'-fopenmp','-lpthread','-lm',f'-Wl,-rpath,{tc.lib}',cwd=src,env=tc.env)
    folders=[tc.lib,tc.bin,pastix/'bin',pastix/'lib',tc.prefix/'Library'/'mingw-w64'/'bin',work/'scotch-mingw'/'bin']
    return exe,capabilities,folders


def main():
    parser=argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--prefix',help='the conda-forge build environment (default: CONDA_PREFIX)')
    args=parser.parse_args()
    if not (MAC and os.uname().machine=='arm64' or WINDOWS or sys.platform.startswith('linux')):
        sys.exit('build-solver.py builds for Apple silicon, Linux x64 and Windows x64.')
    prefix=args.prefix or os.environ.get('CONDA_PREFIX')
    if not prefix: sys.exit('Pass --prefix with the build environment, created from native/calculix/solver-env-*.yml.')
    tc=Toolchain(Path(prefix).resolve())
    shutil.rmtree(work,ignore_errors=True);work.mkdir(parents=True)
    executable,capabilities,folders=build_ccx(tc,*build_spooles(tc))
    target=root/'solver'
    shutil.rmtree(target,ignore_errors=True)
    # patchelf comes with the Linux environment.
    os.environ['PATH']=os.pathsep.join([str(tc.bin),os.environ.get('PATH','')])
    sys.path.insert(0,str(root/'scripts'))
    from solverlibs import relocate
    exe=relocate(executable,target,folders)
    (target/'ccx.json').write_text(json.dumps(capabilities,indent=1)+'\n')
    print('Solver:',exe,json.dumps(capabilities))
    print('With:',', '.join(sorted(p.name for p in target.iterdir() if p!=exe)))


if __name__=='__main__': main()
