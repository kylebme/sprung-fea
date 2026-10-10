"""Isolated Gmsh / CalculiX worker. JSON protocol; stdout is reserved for result.

Modules: cad (STEP import, meshing, view file), model (validation and loads,
solver-independent), calculix (solver adapter), analyses (analysis types and
the result schema)."""
import sys, json, os
from pathlib import Path
import gmsh
from cad import (emit, threads, initialize, surface_data, write_view, mesh_view,
                 mesh_info, import_part, mesh_part, TET10_ORDER)
from model import (QUAD, triangle_weights, triangle_vector_weights, tetra_weights,
                   finite, Model)
from calculix import SOLVERS, solver_of, solver_options, find_ccx, read_log, parse_frd
from analyses import ANALYSES, analysis_of, write_deck, solve
from convergence import converge
from submodel import submodel


def validate(study, mesh):
    return analysis_of(study).validate(study, mesh)


# Nodal arrays reach the viewer through view.bin, not the JSON response.
FIELDS=('displacements','stress','movement')


def main():
    # Gmsh writes through native stdio, so POSIX needs a file descriptor
    # redirect, not just a Python stdout redirect. Keep result JSON separate.
    # Windows DLLs can use different C runtimes: keep native Gmsh output
    # disabled there and report our explicit meshing phases instead.
    result_stream=sys.stdout
    if os.name=='posix':
        sys.stdout.flush()
        result_stream=os.fdopen(os.dup(sys.stdout.fileno()),'w')
        os.dup2(sys.stderr.fileno(),sys.stdout.fileno())
    os.environ['SPRUNG_FEA_PROGRESS']='1' if os.name=='posix' else '0'
    command=sys.argv[1]; folder=Path(sys.argv[2]).resolve()
    payload=json.loads(sys.stdin.read() or '{}')
    try:
        if command=='import': result=import_part(folder)
        # The equation solvers a study can choose here (the folder is unused).
        elif command=='solvers': result=solver_options()
        elif command=='mesh': result=mesh_info(mesh_part(folder,payload))
        elif command=='solve':
            mesh=mesh_info(mesh_part(folder,payload))
            result={'mesh':mesh,'result':{k:v for k,v in solve(folder,payload).items() if k not in FIELDS}}
        elif command=='converge':
            # The payload carries the study and the convergence options.
            mesh,solved=converge(folder,payload['study'],payload.get('options') or {})
            (folder/'result.json').write_text(json.dumps(solved))
            result={'mesh':mesh_info(mesh),'result':{k:v for k,v in solved.items() if k not in FIELDS}}
        elif command=='submodel':
            # The payload carries the solved study and the region box.
            mesh,solved,geometry=submodel(folder,payload['study'],payload['region'])
            result={'mesh':mesh_info(mesh),'result':{k:v for k,v in solved.items() if k not in FIELDS},'geometry':geometry}
        else: raise ValueError('Unknown worker command.')
        print(json.dumps({'ok':True,'data':result}),file=result_stream,flush=True)
    except Exception as error:
        if gmsh.isInitialized(): gmsh.finalize()
        print(json.dumps({'ok':False,'error':str(error)}),file=result_stream,flush=True)
        sys.exit(1)

if __name__=='__main__': main()
