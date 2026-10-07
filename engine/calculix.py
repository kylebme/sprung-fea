"""CalculiX adapter: equation solvers, execution, and reading its output files."""
import os, re, sys, shutil, subprocess, errno, time, json, functools, ctypes
import numpy as np
from collections import deque
from pathlib import Path
from cad import threads, emit

# Linear equation solvers a study can choose. `direct` is the fastest exact
# solver of the CalculiX in use (direct_solver); studies saved before there
# was a choice of direct solver name SPOOLES.
SOLVERS={'direct':None,
         'iterative-scaling':('ITERATIVE SCALING','iterative, diagonal scaling'),
         'iterative-cholesky':('ITERATIVE CHOLESKY','iterative, incomplete Cholesky')}
ALIASES={'spooles':'direct'}


def solver_of(study):
    name=study.get('solver') or 'direct'
    name=ALIASES.get(name,name)
    if name not in SOLVERS:
        raise ValueError('Choose the direct solver or one of the iterative solvers.')
    return name


def solver(study):
    """(deck keyword, description) of the study's equation solver."""
    return SOLVERS[solver_of(study)] or direct_solver()


# CalculiX's direct solvers by the name SPRUNG_FEA_DIRECT_SOLVER takes,
# fastest first, with their deck keywords.
DIRECT={'pardiso':'PARDISO','pastix':'PASTIX','spooles':'SPOOLES'}


def direct_solvers():
    """{name: description} of the direct solvers this CalculiX can run,
    fastest first. All factor exactly. PARDISO is Apple Accelerate on macOS
    and an Intel MKL the user installed elsewhere (find_mkl); PaStiX ships
    with the solver build (scripts/build-solver.py); SPOOLES is always
    there."""
    c=capabilities();found={}
    if c.get('pardiso'): found['pardiso']=f"{c['pardiso']} PARDISO"
    if c.get('pastix'): found['pastix']=f"{c['pastix']} sparse direct"
    found['spooles']='SPOOLES direct'
    return found


def direct_solver(eigenvalues=False):
    """(deck keyword, description) of the direct solver: the fastest this
    CalculiX has, or the one SPRUNG_FEA_DIRECT_SOLVER names. For eigenvalue
    analyses (frequency, buckling), PaStiX is passed over: CalculiX built
    with PARDISO too sends their PaStiX factorizations to PARDISO, whose
    pivoting suits shifted indefinite systems."""
    available=direct_solvers()
    if eigenvalues: available.pop('pastix',None)
    choice=os.environ.get('SPRUNG_FEA_DIRECT_SOLVER')
    if choice and choice not in available and not (eigenvalues and choice=='pastix'):
        raise ValueError(f'SPRUNG_FEA_DIRECT_SOLVER={choice}: this CalculiX has {", ".join(available)}.')
    name=choice if choice in available else next(iter(available))
    return DIRECT[name],available[name]


def capabilities(ccx=None):
    """What the CalculiX executable can do here (built_capabilities), with
    PARDISO only where its library is present: an MKL build needs MKL
    installed."""
    found=dict(built_capabilities(ccx))
    if found.pop('pardisoNeedsMkl',False) and not find_mkl(): found.pop('pardiso',None)
    return found


def built_capabilities(ccx=None):
    """What the CalculiX executable was built with: {'pardiso': backend name;
    'pardisoNeedsMkl': PARDISO loads an installed MKL; 'pastix': PaStiX
    version; 'threadSafeSpooles': whether SPOOLES may run threaded}, each
    absent when not so. SPOOLES 2.2 as released loses updates between
    threads and returns wrong answers, often on Apple silicon and
    occasionally elsewhere, so it is threaded only in builds known to carry
    the fixes: those that say so in a ccx.json beside the executable
    (scripts/build-solver.py, bundle-runtime.py), and conda-forge calculix
    build 5 or later, which requires the fixed spooles."""
    return _capabilities(str(Path(ccx or find_ccx()).resolve()))


@functools.lru_cache(maxsize=None)
def find_mkl():
    """The runtime library (mkl_rt) of an Intel MKL installed on this
    computer, which the solver loads for PARDISO on Linux and Windows; None
    when there is none. SPRUNG_FEA_MKL names the library or its folder;
    otherwise Intel oneAPI's default folder, the conda and Python prefixes
    (`pip install mkl`), and the library search path are looked through.
    MKL is not free software, so it is never bundled."""
    windows=os.name=='nt'
    names=(['mkl_rt.3.dll','mkl_rt.2.dll','mkl_rt.1.dll'] if windows else
           ['libmkl_rt.so.3','libmkl_rt.so.2','libmkl_rt.so.1','libmkl_rt.so'])
    given=os.environ.get('SPRUNG_FEA_MKL')
    if given:
        folders=[Path(given).parent] if Path(given).is_file() else [Path(given)]
        if Path(given).is_file(): names=[Path(given).name]
    else:
        prefixes=[p for p in (os.environ.get('CONDA_PREFIX'),sys.prefix,sys.base_prefix) if p]
        search=os.environ.get('PATH' if windows else 'LD_LIBRARY_PATH','').split(os.pathsep)
        if windows:
            program=Path(os.environ.get('ProgramFiles(x86)','C:/Program Files (x86)'))
            folders=[program/'Intel'/'oneAPI'/'mkl'/'latest'/'bin',*(Path(p)/'Library'/'bin' for p in prefixes)]
        else:
            folders=[Path('/opt/intel/oneapi/mkl/latest/lib'),Path('/opt/intel/oneapi/mkl/latest/lib/intel64'),
                     *(Path(p)/'lib' for p in prefixes),Path.home()/'.local'/'lib',
                     Path('/usr/lib/x86_64-linux-gnu'),Path('/usr/lib64'),Path('/usr/local/lib')]
        folders+=[Path(p) for p in search if p]
    for folder in folders:
        for name in names:
            library=folder/name
            if library.is_file() and _has_pardiso(library): return str(library)
    return None


def _has_pardiso(library):
    try:
        # LOAD_WITH_ALTERED_SEARCH_PATH: MKL's DLLs load from its folder.
        loaded=ctypes.CDLL(str(library),**({'winmode':0x8} if os.name=='nt' else {}))
        return hasattr(loaded,'pardiso_')
    except OSError:
        return False


@functools.lru_cache(maxsize=None)
def _capabilities(path):
    path=Path(path)
    sidecar=path.parent/'ccx.json'
    if sidecar.is_file(): return json.loads(sidecar.read_text())
    for prefix in (path.parent.parent,path.parent.parent.parent):
        for record in (prefix/'conda-meta').glob('calculix-*.json'):
            build=json.loads(record.read_text()).get('build_number',0)
            return {'threadSafeSpooles':build>=5}
    return {}


def find_ccx():
    candidates=[os.environ.get('SPRUNG_FEA_CCX'),shutil.which('ccx'),shutil.which('ccx_2.23'),
                '/opt/homebrew/opt/calculix-ccx/bin/ccx_2.23','/usr/local/opt/calculix-ccx/bin/ccx_2.23']
    bundled=Path(__file__).resolve().parent.parent/'solver'/('ccx.exe' if os.name=='nt' else 'ccx')
    candidates.insert(0,str(bundled))
    for p in candidates:
        if p and Path(p).is_file() and os.access(p,os.X_OK): return p
    raise ValueError('CalculiX was not found. Install costerwi/calculix/calculix-ccx with Homebrew, or set SPRUNG_FEA_CCX to the solver executable.')


def read_log(path):
    """Errors, the last lines, and the final conjugate-gradient residual of a
    CalculiX log. Read line by line: iterative solves log every iteration."""
    error=False;tail=deque(maxlen=40);last=None
    pattern=re.compile(r'iteration=\s*(\d+), error=\s*(\S+), limit=\s*(\S+)')
    with open(path) as log:
        for line in log:
            error|='*ERROR' in line
            tail.append(line)
            match=pattern.match(line.strip())
            if match: last=match
    iterative=None
    if last:
        iterative={'iterations':int(last[1]),'error':float(last[2]),'limit':float(last[3])}
    return error,''.join(tail),iterative


def run(folder, name='analysis'):
    """Runs CalculiX on folder/name.inp. Returns the iterative-solver summary,
    or None for direct solves; raises with the log tail on failure."""
    # CalculiX threads stiffness assembly, the direct solver and stress
    # recovery itself; NUMBER_OF_CPUS caps all three, and at 1 left every
    # stage serial. Assembly and stress recovery give the same answer to
    # round-off at any thread count. SPOOLES is threaded only where it is
    # safe (capabilities). PaStiX threads itself with the equation solver
    # count, over single-threaded OpenBLAS; Accelerate follows
    # VECLIB_MAXIMUM_THREADS, and MKL MKL_NUM_THREADS. OpenMP stays at one
    # thread. CalculiX's iterative solvers iterate on one thread regardless.
    n=str(threads())
    equations=n if capabilities().get('threadSafeSpooles') else '1'
    env={k:v for k,v in os.environ.items() if not k.startswith('CCX_NPROC')}
    env.update(OMP_NUM_THREADS='1',NUMBER_OF_CPUS=n,OPENBLAS_NUM_THREADS='1',VECLIB_MAXIMUM_THREADS=n,MKL_NUM_THREADS=n,
               GFORTRAN_UNBUFFERED_PRECONNECTED='1',
               CCX_NPROC_RESULTS=n,CCX_NPROC_STIFFNESS=n,CCX_NPROC_EQUATION_SOLVER=equations)
    if built_capabilities().get('pardisoNeedsMkl') and find_mkl(): env['SPRUNG_FEA_MKL']=find_mkl()
    # No time limit: large models can solve for a long time, and the user can
    # cancel the job.
    log_path=folder/'solver.log'
    # A terminal makes native C stdout line buffered on macOS/Linux: a pipe
    # otherwise holds stage messages until a buffer fills or the solve ends.
    # Windows uses a pipe; Fortran output is unbuffered through the env above.
    master=slave=None
    with open(log_path,'w') as log:
        if os.name=='posix': master,slave=os.openpty()
        try:
            process=subprocess.Popen([find_ccx(),'-i',name],cwd=folder,stdin=subprocess.DEVNULL,
                                     stdout=slave if slave is not None else subprocess.PIPE,
                                     stderr=subprocess.STDOUT,env=env,text=True,errors='replace')
        except BaseException:
            if master is not None: os.close(master)
            raise
        finally:
            if slave is not None: os.close(slave)
        stream=os.fdopen(master,'r',errors='replace') if master is not None else process.stdout
        reporting=False;last_iteration=None;sent_iteration=None;last_update=-float('inf')
        try:
            with stream:
                while True:
                    try: line=stream.readline()
                    except OSError as error:
                        # Linux PTYs end with EIO instead of an empty read.
                        if master is not None and error.errno==errno.EIO: break
                        raise
                    if not line: break
                    log.write(line)
                    message=line.strip()
                    if not message or not message.strip('_*=- '): continue
                    if message.startswith('STEP') or '*ERROR' in message or '*WARNING' in message:
                        reporting=True
                    if message.startswith('iteration='):
                        last_iteration=message
                        if time.monotonic()-last_update<.5: continue
                        last_update=time.monotonic();sent_iteration=message
                    elif last_iteration!=sent_iteration:
                        emit('solving',last_iteration,'CalculiX')
                        sent_iteration=last_iteration
                    if reporting or message.startswith('CalculiX Version'):
                        emit('solving',message,'CalculiX')
                if last_iteration!=sent_iteration:
                    emit('solving',last_iteration,'CalculiX')
            process.wait()
        finally:
            if process.poll() is None:
                process.terminate();process.wait()
    error,tail,iterative=read_log(log_path)
    if process.returncode != 0 or error or not (folder/f'{name}.frd').exists():
        raise ValueError(failure(tail)+'\n'+tail[-2500:])
    # CalculiX returns its last iterate without an error when conjugate
    # gradients stop short of the tolerance, so check the final residual.
    if iterative and not iterative['error']<=iterative['limit']:
        raise ValueError(f"The iterative solver did not converge: residual {iterative['error']:.3g} is above the limit {iterative['limit']:.3g} after {iterative['iterations']} iterations. Use the direct solver, or check that the supports hold the part.\n"+tail[-2500:])
    return iterative


def failure(tail):
    """A plain explanation of the most common CalculiX failures."""
    if 'increment size smaller than minimum' in tail or 'too many cutbacks' in tail:
        return ('The nonlinear solve stopped: the load could not be applied in small enough steps. '
                'The part may collapse or yield through under this load. Reduce the load, add supports, '
                'or check the material.')
    return 'CalculiX could not solve this study. Check supports, mesh quality, and the solver log.'


# FRD blocks this reader keeps, by their CalculiX label.
FIELDS={'DISP','DISPI','PDISP','STRESS','STRESSI','TOSTRAIN','FORC','NDTEMP','PE','FLUX','RFL','ERROR','CONTACT'}


class NodalField:
    """One FRD result block: node ids and a row of values per node. It reads
    like the {node: values} mapping it stands for; `at` gathers many nodes'
    rows at once."""
    def __init__(self, ids, values):
        self.ids=ids;self.values=values
        self.row=np.full(int(ids.max())+1 if len(ids) else 0,-1,np.int64)
        self.row[ids]=np.arange(len(ids))

    def index(self, node):
        return self.row[node] if 0<=node<len(self.row) else -1

    def __len__(self): return len(self.ids)
    def __contains__(self, node): return self.index(node)>=0
    def __getitem__(self, node):
        i=self.index(node)
        if i<0: raise KeyError(node)
        return self.values[i]
    def get(self, node, default=None):
        i=self.index(node)
        return self.values[i] if i>=0 else default

    def at(self, nodes):
        """Rows of the given nodes, or None if any is missing."""
        nodes=np.asarray(nodes,np.int64)
        if len(nodes) and (nodes.min()<0 or nodes.max()>=len(self.row)): return None
        rows=self.row[nodes]
        return None if (rows<0).any() else self.values[rows]


def read_block(lines):
    """A result block's ' -1' lines: an 11-character node field (after the
    record key), then 12-character values. Continuation lines (' -2') of
    fields with more than six values are not read."""
    rows=[l for l in lines if l.startswith(b' -1')]
    if not rows: return NodalField(np.zeros(0,np.int64),np.zeros((0,0)))
    width=len(rows[0])
    count=(width-13)//12
    if all(len(r)==width for r in rows):
        table=np.frombuffer(b''.join(rows),np.uint8).reshape(len(rows),width)
        ids=table[:,3:13].copy().view('S10').ravel().astype(np.int64)
        values=table[:,13:13+12*count].copy().view('S12').reshape(len(rows),count).astype(float)
    else:
        ids=np.array([int(r[3:13]) for r in rows],np.int64)
        count=min((len(r.rstrip(b'\r'))-13)//12 for r in rows)
        values=np.array([[float(r[13+12*i:25+12*i]) for i in range(count)] for r in rows]).reshape(len(rows),count)
    return NodalField(ids,values)


def parse_frd(path, keep=FIELDS):
    """Result frames of a CalculiX .frd file, in order. A frame is one
    increment, mode, or frequency: consecutive blocks with the same step
    number and value. Each frame holds {'step', 'value', 'meta', 'fields'};
    fields map an FRD label to a NodalField, which reads like {node:
    values}. Result blocks are converted whole, not line by line."""
    data=Path(path).read_bytes()
    frames=[];meta={};pos=0;size=len(data)
    while pos<size:
        end=data.find(b'\n',pos)
        if end<0: end=size
        line=data[pos:end].rstrip(b'\r');pos=end+1
        if line.startswith(b'    1P'):
            parts=line[6:].decode(errors='replace').split()
            if parts: meta[parts[0]]=parts[1:]
        elif line.startswith(b'  100C'):
            value=float(line[12:24]);step=int(line[58:63] or 0)
            if not frames or (frames[-1]['step'],frames[-1]['value'])!=(step,value):
                frames.append({'step':step,'value':value,'meta':meta,'fields':{}})
            meta={}
        elif line.startswith(b' -4'):
            label=line[5:13].decode().strip()
            # The block runs to its ' -3' end record.
            stop=data.find(b'\n -3',end)
            if stop<0: stop=size
            if label in keep and frames:
                frames[-1]['fields'][label]=read_block(data[pos:stop].split(b'\n'))
            pos=stop+1
    return frames


def read_dat(path):
    """Text sections of a .dat file keyed by their header line, for values
    CalculiX prints but does not store in the .frd (eigenvalues, buckling
    factors, participation factors)."""
    return path.read_text() if path.exists() else ''


# ---- Input deck ----

def number(v):
    """Bounded significant digits, so fixed-width readers never truncate."""
    return f'{v:.12g}'


def rows(values, per=16):
    values=list(values)
    return [', '.join(map(str,values[i:i+per])) for i in range(0,len(values),per)]


def mesh_lines(model, title):
    from cad import TET10_ORDER
    lines=['*HEADING',f'Sprung FEA {title}; mm N MPa tonne s','*NODE']
    lines+=[f'{n}, '+', '.join(number(v) for v in xyz) for n,xyz in model.nodes.items()]
    lines+=['*ELEMENT, TYPE=C3D10, ELSET=PART']
    lines+=[f'{eid}, '+', '.join(str(c[i]) for i in TET10_ORDER) for eid,c in zip(model.mesh['elementIds'],model.mesh['elements'])]
    return lines


def temperature_table(m, key, scale=1.):
    """[(value × scale, temperature)] of a property that varies with
    temperature: its values at two or more temperatures in the material's
    table. None when the constant value applies."""
    rows=sorted((r['temperature'],r[key]) for r in m.get('byTemperature') or [] if r.get(key) is not None)
    return [(v*scale,t) for t,v in rows] if len(rows)>=2 else None


def material_lines(m, name='MAT', elset='PART', temperatures=False):
    """Material in deck units: density from kg/m³ to tonne/mm³. With
    `temperatures`, the elastic modulus follows the material's temperature
    table if it has one."""
    young=temperature_table(m,'young') if temperatures else None
    elastic=([f"{number(E)}, {number(m['poisson'])}, {number(t)}" for E,t in young] if young
             else [f"{number(m['young'])}, {number(m['poisson'])}"])
    return [f'*MATERIAL, NAME={name}','*ELASTIC',*elastic,
            '*DENSITY',number(m['density']*1e-12),f'*SOLID SECTION, ELSET={elset}, MATERIAL={name}']


def section_lines(model, study, extra=lambda m: [], temperatures=False):
    """Materials and solid sections: one for the part, or one per group of
    bodies with the same material. `extra(material)` adds keyword lines
    (thermal properties) to each material."""
    groups=model.materials(study)
    if len(groups)==1:
        lines=material_lines(groups[0][1],temperatures=temperatures)
        return lines[:-1]+extra(groups[0][1])+lines[-1:]
    out=[]
    for k,(_,m,elements) in enumerate(groups,1):
        out+=[f'*ELSET, ELSET=BODIES{k}']+rows(sorted(elements))
        lines=material_lines(m,f'MAT{k}',f'BODIES{k}',temperatures)
        out+=lines[:-1]+extra(m)+lines[-1:]
    return out


def support_equations(held):
    """Linear constraints d·u = 0 for blocked directions off the global axes,
    as [(node, dof, coefficient)] with the dependent term first. A node's
    blocked rows are reduced to echelon form, so each equation's dependent
    DOF appears in no other equation of that node."""
    out=[]
    for n,basis in sorted(held.directions.items()):
        B=np.array(basis,float);pivots=[]
        for i in range(len(B)):
            free=[j for j in range(3) if j not in pivots]
            p=max(free,key=lambda j:abs(B[i,j]))
            B[i]/=B[i,p]
            for k in range(len(B)):
                if k!=i: B[k]-=B[k,p]*B[i]
            pivots.append(p)
        for row,p in zip(B,pivots):
            out.append([(n,p+1,1.0)]+[(n,j+1,float(row[j])) for j in range(3) if j!=p and abs(row[j])>1e-12])
    return out


def equation_lines(equations):
    lines=['*EQUATION']
    for terms in equations:
        lines.append(str(len(terms)))
        for i in range(0,len(terms),4):
            lines.append(', '.join(f'{n}, {d}, {number(c)}' for n,d,c in terms[i:i+4]))
    return lines if equations else []


def boundary_lines(held):
    """Blocked directions: *BOUNDARY along global axes, *EQUATION otherwise."""
    lines=['*BOUNDARY']+[f'{n}, {a+1}, {a+1}, 0' for n,a in sorted(held.dofs)] if held.dofs else []
    lines+=equation_lines(support_equations(held))
    lines+=['*NSET, NSET=HELD']+rows(sorted(held.nodes()))
    return lines


def load_lines(loading):
    lines=[]
    if loading.nodal:
        lines+=['*CLOAD']+[f'{n}, {a+1}, {number(v)}' for (n,a),v in sorted(loading.nodal.items()) if abs(v)>1e-14]
    dload=[]
    g=float(np.linalg.norm(loading.gravity))
    if g:
        dload.append(f'PART, GRAV, {number(g)}, '+', '.join(number(x) for x in loading.gravity/g))
    if loading.rotation:
        omega,origin,axis=loading.rotation
        dload.append(f'PART, CENTRIF, {number(omega**2)}, '+', '.join(number(x) for x in [*origin,*axis]))
    dload+=[f'{eid}, P{face}, {number(p)}' for (eid,face),p in loading.pressures.items()]
    if dload: lines+=['*DLOAD']+dload
    return lines


def mass_lines(model, masses, couplings, held=None):
    """Point masses as MASS elements on extra nodes, tied to their faces by
    *EQUATION constraints, one per direction. `couplings` holds model.rbe3
    output per mass. Masses in kg.

    CalculiX cannot put mass on the dependent side of an equation in an
    eigenvalue analysis, so the mass node stays independent: each equation
    eliminates the face-node direction with the largest coefficient that is
    neither supported nor already eliminated."""
    lines=[];node=max(model.ids);element=max(model.mesh['elementIds'])
    equations=[];used=set()
    if held:
        # Nodes in support equations keep all their DOFs out of these.
        used={(n,a+1) for n,a in held.dofs}|{(n,a+1) for n in held.directions for a in range(3)}
    for m,terms in zip(masses,couplings):
        node+=1;element+=1
        lines+=['*NODE',f'{node}, '+', '.join(number(v) for v in m['point'])]
        lines+=[f'*ELEMENT, TYPE=MASS, ELSET=M{element}',f'{element}, {node}',
                f'*MASS, ELSET=M{element}',number(float(m['mass'])*1e-3)]
        for k in range(3):
            entries=[(n,j+1,-A[k,j]) for n,A in terms for j in range(3) if abs(A[k,j])>1e-12]
            free=[e for e in entries if (e[0],e[1]) not in used]
            if not free:
                raise ValueError(f"The point mass “{m.get('name','')}” sits on faces that are fully supported. Attach it to faces that can move.")
            first=max(free,key=lambda e:abs(e[2]))
            used.add((first[0],first[1]))
            equations.append([first]+[e for e in entries if e is not first]+[(node,k+1,1.0)])
    return lines+equation_lines(equations)


def eigenvalues(dat):
    """(mode, eigenvalue, frequency in Hz) rows of the first eigenvalue table
    in a .dat file. Negative eigenvalues (rigid motions with round-off, or
    buckling factors) keep their sign."""
    out=[];inside=False
    for line in dat.splitlines():
        if 'E I G E N V A L U E   O U T P U T' in line or 'B U C K L I N G   F A C T O R   O U T P U T' in line:
            inside=True;out=[];continue
        if inside:
            parts=line.split()
            if len(parts)>=2 and parts[0].isdigit():
                values=[float(p) for p in parts[1:]]
                out.append((int(parts[0]),values))
            elif out and not parts: continue
            elif out: break
    return out


def modal_mass(dat):
    """Effective modal mass per mode (X, Y, Z) and the total mass, in tonne."""
    rows=[];total=None;section=None
    for line in dat.splitlines():
        if 'E F F E C T I V E   M O D A L   M A S S' in line: section='modes';continue
        if 'T O T A L   E F F E C T I V E   M A S S' in line: section='total';continue
        parts=line.split()
        if section=='modes' and len(parts)==7 and parts[0].isdigit():
            rows.append([float(p) for p in parts[1:4]])
        elif section=='total' and len(parts)==6 and not parts[0][0].isalpha():
            total=[float(p) for p in parts[:3]];section=None
    return rows,total
