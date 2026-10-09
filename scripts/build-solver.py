"""Build CalculiX 2.23 with its fastest direct solvers, on Apple silicon,
Linux x64 and Windows x64.

Writes solver/ccx (ccx.exe) with the libraries it needs beside it
(solverlibs.py), which the engine and bundle-runtime.py use before any
installed CalculiX, and solver/ccx.json, which tells the engine what the
build can do. The compilers and libraries come from a conda-forge
environment, native/calculix/solver-env-<platform>.yml: pass its folder
with --prefix, or run with it active (CONDA_PREFIX). macOS also needs the
Xcode command line tools, and Windows Visual Studio's C++ build tools.

The build carries two direct solvers, both multithreaded:
- SPOOLES 2.2. Its threaded factor and solve hand work between threads
  through plain loads and stores, which lose updates and return wrong
  answers (often on Apple silicon). The patches in
  native/calculix/spooles-patches, from conda-forge's spooles feedstock
  (build 1006), order those hand-offs.
- PARDISO: Apple Accelerate's sparse factorizations on macOS, through
  native/calculix/accelerate_pardiso.c. On Linux and Windows it is Intel
  oneMKL's, which is not free software, so CalculiX does not link it:
  native/calculix/pardiso_client.c hands CalculiX's PARDISO calls through
  a pipe to sprung-solve (native/sprung-solve, MIT), a program of its own
  that links MKL statically, written to solver/sprung-solve/. With
  --without-mkl, sprung-solve is not built and the solver has SPOOLES
  only.

sprung-solve also links hypre (Apache-2.0 or MIT), built from source here
without MPI, for an iterative solver on Linux and Windows: conjugate
gradients preconditioned by BoomerAMG algebraic multigrid, which CalculiX
reaches through the same PARDISO calls (SPRUNG_FEA_SOLVE_METHOD=amg).
--cuda also builds a second sprung-solve, whose hypre runs on NVIDIA GPUs,
into solver/sprung-solve-gpu/, from native/calculix/solver-env-linux-cuda.yml
or solver-env-windows-cuda.yml, for the app's NVIDIA builds. Without an
NVIDIA GPU it runs PARDISO alone, and the engine offers the GPU only where
it solves with it."""
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
    'hypre':(['https://github.com/hypre-space/hypre/archive/refs/tags/v3.2.0.tar.gz'],
             '5273205a310fb6aa3ae506ce216760fb67b30e02024874f3cdb8b811e4801de7'),
}
HYPRE_VERSION='3.2.0'
# What `sprung-solve --version` starts with when it works: the protocol
# version it speaks (native/sprung-solve/protocol.h).
HELPER_BANNER='sprung-solve 2: '
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
# What GCC 14 and clang 16 made errors, and CalculiX's older C still relies
# on.
LENIENT=[f'-Wno-error={w}' for w in ('implicit-function-declaration','implicit-int','int-conversion','incompatible-pointer-types')]
jobs=os.cpu_count() or 4
# --hypre-cache: where built hypres are kept and found again (build_hypre).
hypre_cache=None


def fetch(name):
    urls,digest=SOURCES[name]
    # GitHub's archives are named by their tag alone.
    path=downloads/(f'hypre-{HYPRE_VERSION}.tar.gz' if name=='hypre' else Path(urls[0]).name)
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
            # C++ only for a CUDA build of hypre (--cuda).
            self.cxx=self.bin/'x86_64-conda-linux-gnu-g++'

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


def msvc_environment():
    """Visual Studio's 64-bit C build environment (its vcvars64.bat), for
    sprung-solve on Windows: Intel oneMKL's static libraries are made for
    Microsoft's compiler."""
    vswhere=Path(os.environ.get('ProgramFiles(x86)','C:/Program Files (x86)'))/'Microsoft Visual Studio'/'Installer'/'vswhere.exe'
    found=subprocess.run([str(vswhere),'-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
                          '-find','VC\\Auxiliary\\Build\\vcvars64.bat'],capture_output=True,text=True).stdout.split('\n')[0].strip() if vswhere.is_file() else ''
    if not found: sys.exit("Visual Studio's C++ build tools were not found; sprung-solve needs them (or pass --without-mkl).")
    # A batch file of its own: cmd's quoting of a command line is unreliable.
    script=work/'msvc-environment.bat'
    script.write_text(f'@call "{found}" >nul\r\n@set\r\n')
    listing=subprocess.check_output(['cmd','/d','/c',str(script)],text=True)
    # Upper case, as os.environ has them on Windows: no name twice.
    return {k.upper():v for k,v in (line.split('=',1) for line in listing.splitlines() if '=' in line[1:])}


def build_hypre(tc, env, cuda=None):
    """hypre's static library for one process: no MPI, its own BLAS and
    LAPACK (BoomerAMG uses them only on the coarsest level), 32-bit
    indices. Built with sprung-solve's compiler and threaded with OpenMP on
    the runtime MKL's threads use: GCC and GNU's runtime on Linux;
    Microsoft's compiler on Windows (in `env`) with /openmp:llvm, whose code
    calls LLVM's runtime (libiomp5md), where plain /openmp's would call
    Microsoft's own (vcomp). With `cuda` (GPU architectures, as CMake takes
    them), for NVIDIA GPUs (gpu_options). Returns the folder it is installed
    in, with include/ and lib/: under --hypre-cache, a build made before
    with the same options when there is one."""
    found=os.pathsep.join([str(tc.bin),str(tc.prefix/'Library'/'bin')])
    cmake=shutil.which('cmake',path=found)
    if not cmake: sys.exit(f'cmake was not found in {tc.prefix}: create the environment from native/calculix/solver-env-*.yml.')
    options=['-DCMAKE_BUILD_TYPE=Release','-DBUILD_SHARED_LIBS=OFF','-DHYPRE_ENABLE_MPI=OFF','-DHYPRE_ENABLE_OPENMP=ON']
    if WINDOWS:
        # Ninja builds in parallel; NMake, one file at a time.
        ninja=shutil.which('ninja',path=found)
        generator=['-G','Ninja',f'-DCMAKE_MAKE_PROGRAM={ninja}'] if ninja else ['-G','NMake Makefiles']
        # /openmp:llvm: OpenMP on LLVM's runtime, MKL's, rather than vcomp.
        options+=[*generator,'-DCMAKE_C_COMPILER=cl','-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL','-DOpenMP_RUNTIME_MSVC=llvm']
    else: options+=[f'-DCMAKE_C_COMPILER={tc.cc}']
    if cuda: options+=gpu_options(tc,cuda)
    cached=None
    if hypre_cache:
        # The options name the compilers too, so a cache made with others is
        # not taken.
        key=hashlib.sha256('\n'.join([sys.platform,*options]).encode()).hexdigest()[:16]
        cached=Path(hypre_cache).resolve()/f'hypre-{HYPRE_VERSION}-{"cuda" if cuda else "cpu"}-{key}'
        if (cached/'include'/'HYPRE.h').is_file():
            print(f'Using hypre {HYPRE_VERSION} built before, in {cached}',flush=True)
            return cached
    source=work/('hypre-cuda' if cuda else 'hypre');source.mkdir()
    extract(fetch('hypre'),source)
    build,install=source/'build',source/'install'
    print(f'Building hypre {HYPRE_VERSION}'+(f' for CUDA ({cuda})' if cuda else ''),flush=True)
    run(cmake,'-S',source/f'hypre-{HYPRE_VERSION}'/'src','-B',build,*options,f'-DCMAKE_INSTALL_PREFIX={install}',env=env,quiet=True)
    run(cmake,'--build',build,'--parallel',str(jobs),env=env,quiet=True)
    run(cmake,'--install',build,env=env,quiet=True)
    if not cached: return install
    shutil.rmtree(cached,ignore_errors=True);shutil.copytree(install,cached)
    return cached


def gpu_options(tc, cuda):
    """hypre's CMake options for NVIDIA GPUs of the architectures `cuda`.
    Device memory comes from CUDA's own stream-ordered pool
    (cudaMallocAsync), which hypre keeps from returning memory to the
    device: it starts empty and grows, and needs no other library. (LLNL's
    Umpire, which hypre would otherwise download in whatever version is
    newest, does not build with Microsoft's compiler.) hypre's own kernels
    stand in for cuBLAS (vector operations) and cuSOLVER (the coarsest
    level, a few dozen unknowns), which BoomerAMG with l1 Jacobi does not
    need and which would add 1 GB beside sprung-solve. hypre 3.2.0 does
    not build for CUDA without cuSPARSE or cuRAND, so they stay, with the
    JIT linker cuSPARSE loads (nvJitLink). CUDA's runtime is linked
    statically."""
    options=['-DHYPRE_ENABLE_OPENMP=OFF','-DHYPRE_ENABLE_CUDA=ON',f'-DCMAKE_CUDA_ARCHITECTURES={cuda}',
             f'-DCMAKE_CUDA_COMPILER={tc.tool("nvcc")}','-DHYPRE_ENABLE_UMPIRE=OFF','-DHYPRE_ENABLE_DEVICE_MALLOC_ASYNC=ON',
             '-DHYPRE_ENABLE_CUBLAS=OFF','-DHYPRE_ENABLE_CUSOLVER=OFF']
    if WINDOWS: return options+['-DCMAKE_CXX_COMPILER=cl',f'-DCUDAToolkit_ROOT={tc.prefix/"Library"}']
    return options+[f'-DCMAKE_CXX_COMPILER={tc.cxx}',f'-DCMAKE_CUDA_HOST_COMPILER={tc.cxx}',f'-DCUDAToolkit_ROOT={tc.prefix}']


def build_helper(tc, cuda=None):
    """sprung-solve (native/sprung-solve), the program CalculiX's PARDISO
    calls go to on Linux and Windows, with Intel oneMKL's PARDISO and hypre
    linked statically: one file that holds what they use, and the OpenMP
    runtime beside it (GNU's on Linux, LLVM's libiomp5md on Windows). With
    `cuda`, hypre runs on the GPU (gpu_options), with CUDA's runtime linked
    in and cuSPARSE beside it. Returns the executable and the folders of its
    libraries."""
    source=root/'native'/'sprung-solve'/'sprung_solve.c'
    out=work/('sprung-solve-gpu' if cuda else 'sprung-solve');out.mkdir()
    if not (tc.include/'mkl.h').is_file():
        sys.exit(f'Intel oneMKL was not found in {tc.prefix}: create the environment from native/calculix/solver-env-*.yml, or pass --without-mkl.')
    if WINDOWS:
        env=msvc_environment()
        cl=shutil.which('cl',path=env.get('PATH'))
        if not cl: sys.exit("Visual Studio's C compiler (cl) was not found.")
        hypre=build_hypre(tc,{**env,'PATH':os.pathsep.join([str(tc.prefix/'Library'/'bin'),env.get('PATH','')])},cuda)
        exe=out/'sprung-solve.exe'
        gpu=['cusparse.lib','curand.lib','cudart_static.lib'] if cuda else []
        # hypre's threads (build_hypre), on CPUs: /openmp:llvm asks for
        # LIBOMP, which is the environment's libiomp5md here, as for MKL.
        openmp=[] if cuda else ['/openmp:llvm']
        run(cl,'/nologo','/O2','/MD','/W3','/DSPRUNG_SOLVE_HYPRE',*openmp,f'/I{tc.include}',f'/I{hypre/"include"}',source,
            f'/Fe{exe}',f'/Fo{out}\\','/link',f'/LIBPATH:{tc.lib}',hypre/'lib'/'HYPRE.lib',*gpu,
            'mkl_intel_lp64.lib','mkl_intel_thread.lib','mkl_core.lib','/NODEFAULTLIB:libomp.lib','libiomp5md.lib',cwd=out,env=env)
        return exe,[tc.bin,tc.prefix]
    hypre=build_hypre(tc,tc.env,cuda)
    exe=out/'sprung-solve'
    lib=tc.lib
    gpu=[]
    if cuda:
        # cuSPARSE; CUDA's runtime, statically; hypre's C++ runtime (the link
        # is g++'s).
        cudalib=tc.prefix/'targets'/'x86_64-linux'
        gpu=[f'-I{cudalib/"include"}',f'-L{cudalib/"lib"}','-lcusparse','-lcurand','-lcudart_static','-lrt',f'-Wl,-rpath,{cudalib/"lib"}']
    run(tc.cxx if cuda else tc.cc,'-O2','-DSPRUNG_SOLVE_HYPRE',*([] if cuda else ['-Wall']),f'-I{tc.include}',f'-I{hypre/"include"}',
        *(['-x','c',source,'-x','none'] if cuda else [source]),'-o',exe,
        hypre/'lib'/'libHYPRE.a',*gpu,'-Wl,--start-group',lib/'libmkl_intel_lp64.a',lib/'libmkl_gnu_thread.a',lib/'libmkl_core.a','-Wl,--end-group',
        '-fopenmp','-lpthread','-lm','-ldl','-s',f'-Wl,-rpath,{lib}',env=tc.env)
    return exe,[lib,*([tc.prefix/'targets'/'x86_64-linux'/'lib'] if cuda else [])]


def ccx_sources(src):
    """CalculiX's Fortran and C sources (its Makefile.inc), without its PaStiX
    interface (PaStiX is not built in). The list can name a file the release
    does not have (2.23: mafillmm.c); the link reports anything really
    missing."""
    text=(src/'Makefile.inc').read_text()
    def listed(name):
        block=re.search(rf'^{name}\s*=(.*?)(?:\n\s*\n|\Z)',text,re.M|re.S).group(1)
        files=re.findall(r'[\w.-]+\.[cf]\b',block)
        absent=[f for f in files if not (src/f).is_file()]
        if absent: print('Listed in Makefile.inc but not in the source:',', '.join(absent))
        return [f for f in files if f not in absent]
    c=[f for f in listed('SCCXC') if f!='pastix.c']
    return listed('SCCXF'),c


def check_license(src):
    """CalculiX's own files are GPL version 2 only ("published by the Free
    Software Foundation(version 2)", without "or any later version"), which
    THIRD_PARTY_NOTICES.md and the build's design rely on: nothing under an
    incompatible license (GPL-3, LGPL-3, Intel's) is linked into it. Refuse
    a release whose notices say otherwise."""
    notices=[p for p in src.iterdir() if p.suffix in ('.c','.f','.h') and 'General Public License' in p.read_text(errors='replace')]
    only=[p for p in notices if re.search(r'Foundation\s*\(version 2\)',p.read_text(errors='replace'))]
    later=[p for p in notices if re.search(r'any later\s+version',p.read_text(errors='replace'))]
    print(f'CalculiX license notices: {len(notices)} files, {len(only)} GPL version 2 only, {len(later)} version 2 or later')
    if len(only)<0.9*len(notices):
        sys.exit("CalculiX's license notices are not the GPL version 2 only ones expected: review THIRD_PARTY_NOTICES.md.")


def build_ccx(tc, spooles, spooles_lib):
    extract(fetch('ccx'),work)
    src=work/'CalculiX'/f'ccx_{VERSION}'/'src'
    check_license(src)
    # A void function that returns a value (as Homebrew's formula fixes).
    replace(src/'readnewmesh.c','*iprfnp=iprfn;*konrfnp=konrfn;*ratiorfnp=ratiorfn;\n  \n  return NULL;',
            '*iprfnp=iprfn;*konrfnp=konrfn;*ratiorfnp=ratiorfn;\n  \n  return;')
    # A Windows-only call written outside any function, which GCC 14 rejects;
    # it chose two-digit exponents in the old msvcrt, which the UCRT prints
    # anyway.
    for name in (f'ccx_{VERSION}.c',f'ccx_{VERSION}step.c'):
        replace(src/name,'#ifdef __WIN32\n_set_output_format(_TWO_DIGIT_EXPONENT);\n#endif\n','')
    capabilities={'version':VERSION,'threadSafeSpooles':True}
    defines=['-DARCH=Linux','-DSPOOLES','-DARPACK','-DMATRIXSTORAGE','-DNETWORKOUT','-DUSE_MT=1','-DPARDISO']
    # native/calculix/mkl_service.h stands in for MKL's header: CalculiX
    # never links MKL. native/sprung-solve has the protocol's header.
    includes=[f'-I{spooles}',f'-I{native}',f'-I{root/"native"/"sprung-solve"}',f'-I{tc.include}']
    if MAC:
        extra=[native/'accelerate_pardiso.c']
        capabilities['pardiso']='Apple Accelerate'
        libs=['-framework','Accelerate']
    else:
        # PARDISO is offered once sprung-solve is built beside (main).
        extra=[native/'pardiso_client.c']
        libs=[]
        # Once CalculiX has numbered its equations, the client learns each
        # one's displacement direction, which BoomerAMG coarsens by.
        replace(src/'mastruct.c','void mastruct(ITG *nk,',
                'void sprung_solve_numbering(ITG *nactdof, ITG *nk, ITG *mt, ITG *neq);\n\nvoid mastruct(ITG *nk,')
        numbered='    if((*nmethod==2)||((*nmethod==4)&&(*iperturb<=1))||((*nmethod>=5)&&(*nmethod<=7))){\n      neq[2]=neq[1]+*nboun;'
        replace(src/'mastruct.c',numbered,'    sprung_solve_numbering(nactdof,nk,&mt,neq);\n'+numbered)

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
    common=[objects/'ccx_main.o',library,spooles_lib,*blas]
    if MAC:
        # Link with Xcode's clang, which knows the SDK. gfortran's runtime
        # and OpenMP (LLVM's, which implements gfortran's GOMP calls) come
        # from the environment.
        run(tc.cc,'-o',exe,*common,*libs,'-lgfortran','-lomp',f'-Wl,-rpath,{tc.lib}',cwd=src,env=tc.env)
    elif WINDOWS:
        run(tc.fc,'-o',exe,*common,*libs,'-fopenmp','-lpthread',cwd=src,env=tc.env)
    else:
        run(tc.fc,'-o',exe,*common,*libs,'-fopenmp','-lpthread','-lm',f'-Wl,-rpath,{tc.lib}',cwd=src,env=tc.env)
    folders=[tc.lib,tc.bin,tc.prefix/'Library'/'mingw-w64'/'bin']
    return exe,capabilities,folders


def main():
    parser=argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--prefix',help='the conda-forge build environment (default: CONDA_PREFIX)')
    parser.add_argument('--without-mkl',action='store_true',help='do not build sprung-solve: no PARDISO on Linux and Windows')
    parser.add_argument('--hypre-cache',metavar='DIR',
                        help='keep each hypre built in DIR, and use it again while its options are the same (for CI)')
    parser.add_argument('--cuda',nargs='?',const='native',metavar='ARCH',
                        help='Linux and Windows, experimental: also a sprung-solve whose hypre runs on NVIDIA GPUs of these CUDA architectures (default: this computer\'s); needs native/calculix/solver-env-<platform>-cuda.yml')
    args=parser.parse_args()
    global hypre_cache
    hypre_cache=args.hypre_cache
    if not (MAC and os.uname().machine=='arm64' or WINDOWS or sys.platform.startswith('linux')):
        sys.exit('build-solver.py builds for Apple silicon, Linux x64 and Windows x64.')
    if args.cuda and (MAC or args.without_mkl):
        sys.exit('--cuda builds sprung-solve, on Linux and Windows.')
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
    if not MAC and not args.without_mkl:
        # sprung-solve on the CPU, and with --cuda a second one beside it
        # whose hypre runs on the GPU: the engine chooses between them per
        # solve, and offers the GPU only where that one solves with it. The
        # GPU one runs PARDISO alone without an NVIDIA GPU, so it starts here
        # whether or not there is one.
        for cuda,folder in [(None,'sprung-solve'),*([(args.cuda,'sprung-solve-gpu')] if args.cuda else [])]:
            helper,helper_folders=build_helper(tc,cuda)
            # A folder of its own, with its licenses: MIT, Intel's for MKL,
            # and NVIDIA's for the CUDA runtime linked into the GPU one.
            place=target/folder
            relocate(helper,place,helper_folders,check=('--version',HELPER_BANNER))
            for name in ('sprung-solve.txt','Intel-oneMKL.txt','Intel-oneMKL-third-party-programs.txt','hypre.txt',
                         *(['NVIDIA-CUDA.txt'] if cuda else [])):
                shutil.copy2(root/'licenses'/name,place/name)
        capabilities['pardiso']='Intel oneMKL'
        capabilities['pardisoHelper']=f'sprung-solve/{helper.name}'
        capabilities['amg']=f'hypre {HYPRE_VERSION}'
        if args.cuda:
            capabilities['amgGpuHelper']=f'sprung-solve-gpu/{helper.name}'
            capabilities['amgGpu']=f'hypre {HYPRE_VERSION} (CUDA)'
    (target/'ccx.json').write_text(json.dumps(capabilities,indent=1)+'\n')
    print('Solver:',exe,json.dumps(capabilities))
    print('With:',', '.join(sorted(p.name for p in target.rglob('*') if p!=exe and p.is_file())))


if __name__=='__main__': main()
