"""CalculiX adapter: equation solvers, execution, and reading its output files."""
import os, re, shutil, subprocess
import numpy as np
from collections import deque
from pathlib import Path
from cad import threads

# CalculiX linear equation solvers available in the bundled build. PARDISO
# and PaStiX need libraries this build does not link.
SOLVERS={'spooles':('SPOOLES','SPOOLES direct'),
         'iterative-scaling':('ITERATIVE SCALING','iterative, diagonal scaling'),
         'iterative-cholesky':('ITERATIVE CHOLESKY','iterative, incomplete Cholesky')}


def solver_of(study):
    name=study.get('solver') or 'spooles'
    if name not in SOLVERS:
        raise ValueError('Choose the direct solver or one of the iterative solvers.')
    return name


def find_ccx():
    candidates=[os.environ.get('BETTERSIM_CCX'),shutil.which('ccx'),shutil.which('ccx_2.23'),
                '/opt/homebrew/opt/calculix-ccx/bin/ccx_2.23','/usr/local/opt/calculix-ccx/bin/ccx_2.23']
    bundled=Path(__file__).resolve().parent.parent/'solver'/'ccx'
    candidates.insert(0,str(bundled))
    for p in candidates:
        if p and Path(p).is_file() and os.access(p,os.X_OK): return p
    raise ValueError('CalculiX was not found. Install costerwi/calculix/calculix-ccx with Homebrew, or set BETTERSIM_CCX to the solver executable.')


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
    # Assembly, SPOOLES factorization and stress recovery use CalculiX's own
    # thread controls, which gave bit-identical results over 20 repeated
    # solves at 8 threads. OpenMP must stay at one thread: OMP_NUM_THREADS or
    # NUMBER_OF_CPUS above 1 together with any CCX_NPROC above 1 made stress
    # and reactions vary between identical runs, sometimes grossly (a 1000 N
    # reaction reported as 866 N). CalculiX's iterative solvers iterate on
    # one thread regardless.
    n=str(threads())
    env={k:v for k,v in os.environ.items() if not k.startswith('CCX_NPROC')}
    env.update(OMP_NUM_THREADS='1',NUMBER_OF_CPUS='1',OPENBLAS_NUM_THREADS='1',
               CCX_NPROC_RESULTS=n,CCX_NPROC_STIFFNESS=n,CCX_NPROC_EQUATION_SOLVER=n)
    # No time limit: large models can solve for a long time, and the user can
    # cancel the job.
    log_path=folder/'solver.log'
    with open(log_path,'w') as log:
        process=subprocess.run([find_ccx(),'-i',name],cwd=folder,stdout=log,stderr=subprocess.STDOUT,env=env)
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
FIELDS={'DISP','DISPI','PDISP','STRESS','FORC','NDTEMP','PE','HFL','ERROR'}


def parse_frd(path, keep=FIELDS):
    """Result frames of a CalculiX .frd file, in order. A frame is one
    increment, mode, or frequency: consecutive blocks with the same step
    number and value. Each frame holds {'step', 'value', 'meta', 'fields'};
    fields map an FRD label to {node: [values]}. Fixed-width parsing: an
    11-character node field, then 12-character values."""
    frames=[];meta={};active=None;key=None;width=0
    with open(path) as frd:
        for line in frd:
            if line.startswith('    1P'):
                parts=line[6:].split()
                if parts: meta[parts[0]]=parts[1:]
            elif line.startswith('  100C'):
                value=float(line[12:24]);step=int(line[58:63] or 0)
                if not frames or (frames[-1]['step'],frames[-1]['value'])!=(step,value):
                    frames.append({'step':step,'value':value,'meta':meta,'fields':{}})
                meta={}
            elif line.startswith(' -4'):
                label=line[5:13].strip()
                active=frames[-1]['fields'].setdefault(label,{}) if label in keep and frames else None
                width=int(line[13:18])
            elif line.startswith(' -3'):
                active=None
            elif active is not None and line.startswith(' -1'):
                node=int(line[3:13])
                n=(len(line.rstrip('\n'))-13)//12
                active[node]=[float(line[13+12*i:25+12*i]) for i in range(n)]
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
    lines=['*HEADING',f'BetterSim {title}; mm N MPa tonne s','*NODE']
    lines+=[f'{n}, '+', '.join(number(v) for v in xyz) for n,xyz in model.nodes.items()]
    lines+=['*ELEMENT, TYPE=C3D10, ELSET=PART']
    lines+=[f'{eid}, '+', '.join(str(c[i]) for i in TET10_ORDER) for eid,c in zip(model.mesh['elementIds'],model.mesh['elements'])]
    return lines


def material_lines(m, name='MAT', elset='PART'):
    """Material in deck units: density from kg/m³ to tonne/mm³."""
    return [f'*MATERIAL, NAME={name}','*ELASTIC',f"{number(m['young'])}, {number(m['poisson'])}",
            '*DENSITY',number(m['density']*1e-12),f'*SOLID SECTION, ELSET={elset}, MATERIAL={name}']


def boundary_lines(fixed):
    lines=['*BOUNDARY']+[f'{n}, {a+1}, {a+1}, 0' for n,a in sorted(fixed)]
    lines+=['*NSET, NSET=HELD']+rows(sorted(set(n for n,_ in fixed)))
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
