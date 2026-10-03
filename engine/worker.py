"""Isolated Gmsh / CalculiX worker. JSON protocol; stdout is reserved for result.

Modules: cad (STEP import, meshing, view file), model (validation and loads,
solver-independent), calculix (solver adapter), analyses (analysis types and
the result schema)."""
import sys, json
from pathlib import Path
import gmsh
from cad import (emit, threads, initialize, surface_data, write_view, mesh_view,
                 mesh_info, import_part, mesh_part, TET10_ORDER)
from model import (QUAD, triangle_weights, triangle_vector_weights, tetra_weights,
                   finite, Model)
from calculix import SOLVERS, solver_of, find_ccx, read_log, parse_frd
from analyses import ANALYSES, analysis_of, write_deck, solve


def validate(study, mesh):
    return analysis_of(study).validate(study, mesh)


# Nodal arrays reach the viewer through view.bin, not the JSON response.
FIELDS=('displacements','stress','movement')


def main():
    command=sys.argv[1]; folder=Path(sys.argv[2]).resolve()
    study=json.loads(sys.stdin.read() or '{}')
    try:
        if command=='import': result=import_part(folder)
        elif command=='mesh': result=mesh_info(mesh_part(folder,study))
        elif command=='solve':
            mesh=mesh_info(mesh_part(folder,study))
            result={'mesh':mesh,'result':{k:v for k,v in solve(folder,study).items() if k not in FIELDS}}
        else: raise ValueError('Unknown worker command.')
        print(json.dumps({'ok':True,'data':result}))
    except Exception as error:
        if gmsh.isInitialized(): gmsh.finalize()
        print(json.dumps({'ok':False,'error':str(error)}))
        sys.exit(1)

if __name__=='__main__': main()
