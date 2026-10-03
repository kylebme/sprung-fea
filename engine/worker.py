"""Isolated Gmsh / CalculiX worker. JSON protocol; stdout is reserved for result."""
import sys, os, json, math, hashlib, shutil, subprocess, re, time
from pathlib import Path
import numpy as np
import gmsh


def emit(stage, message):
    print(json.dumps({'stage': stage, 'message': message}), file=sys.stderr, flush=True)


def initialize(step):
    gmsh.initialize()
    gmsh.option.setNumber('General.Terminal', 0)
    gmsh.option.setNumber('General.NumThreads', 2)
    gmsh.option.setString('Geometry.OCCTargetUnit', 'MM')
    gmsh.model.occ.importShapes(str(step))
    gmsh.model.occ.synchronize()
    solids = gmsh.model.getEntities(3)
    if len(solids) != 1:
        raise ValueError(f'Import one solid part. This STEP contains {len(solids)} solids. Export a single solid from your CAD tool.')
    if gmsh.model.occ.getMass(*solids[0]) <= 0:
        raise ValueError('The part has no solid volume. Export a closed solid as STEP.')
    return solids[0]


def size_settings(size):
    gmsh.option.setNumber('Mesh.MeshSizeMax', size)
    gmsh.option.setNumber('Mesh.MeshSizeMin', size / 5)
    gmsh.option.setNumber('Mesh.MeshSizeFromCurvature', 16)
    gmsh.option.setNumber('Mesh.MeshSizeExtendFromBoundary', 1)
    gmsh.option.setNumber('Mesh.Algorithm', 6)
    gmsh.option.setNumber('Mesh.Algorithm3D', 1)
    gmsh.option.setNumber('Mesh.Optimize', 1)
    gmsh.model.mesh.setSize(gmsh.model.getEntities(0), size)


def surface_data(quadratic=False):
    tags, coords, _ = gmsh.model.mesh.getNodes()
    coords = np.asarray(coords).reshape(-1, 3)
    node_index = {int(t): i for i, t in enumerate(tags)}
    faces = []
    for _, tag in gmsh.model.getEntities(2):
        et, _, en = gmsh.model.mesh.getElements(2, tag)
        tris = []
        for typ, nodes in zip(et, en):
            _, _, _, count, _, _ = gmsh.model.mesh.getElementProperties(typ)
            for n in np.asarray(nodes).reshape(-1, count):
                if count == 3:
                    tris.extend(node_index[int(t)] for t in n)
                elif count == 6:
                    for sub in [(0,3,5), (3,1,4), (5,4,2), (3,4,5)]:
                        tris.extend(node_index[int(n[i])] for i in sub)
                else:
                    raise ValueError('Unsupported surface element. Expected triangular faces.')
        # Anchor annotations on an actual surface point, including curved faces.
        center=np.asarray(gmsh.model.occ.getCenterOfMass(2,tag))
        triangles=np.asarray(tris).reshape(-1,3)
        centroids=coords[triangles].mean(axis=1)
        anchor=centroids[np.argmin(np.linalg.norm(centroids-center,axis=1))]
        closest,param=gmsh.model.getClosestPoint(2,tag,anchor)
        normal=gmsh.model.getNormal(tag,param)
        faces.append({'anchor':closest.tolist(),'normal':normal.tolist(),'id': tag, 'name': f'Face {tag}', 'type': gmsh.model.getType(2, tag),
                      'area': gmsh.model.occ.getMass(2, tag), 'center': list(gmsh.model.occ.getCenterOfMass(2, tag)), 'indices': tris})
    return {'positions': coords.flatten().tolist(), 'nodeIds': [int(t) for t in tags], 'faces': faces}


def import_part(folder):
    emit('importing', 'Reading STEP geometry')
    solid = initialize(folder / 'part.step')
    bbox = gmsh.model.getBoundingBox(*solid)
    dims = [bbox[i+3]-bbox[i] for i in range(3)]
    default = max(min(dims) / 2.5, max(dims) / 60)
    size_settings(max(min(dims)/2, max(dims)/45))
    gmsh.model.mesh.generate(2)
    geometry = surface_data()
    geometry.update({'bounds': list(bbox), 'dimensions': dims, 'volume': gmsh.model.occ.getMass(*solid),
                     'recommendedSize': default, 'hash': hashlib.sha256((folder/'part.step').read_bytes()).hexdigest(), 'units': 'mm'})
    (folder/'geometry.json').write_text(json.dumps(geometry))
    gmsh.finalize()
    return geometry


def mesh_part(folder, study):
    emit('meshing', 'Meshing')
    initialize(folder/'part.step')
    geo = json.loads((folder/'geometry.json').read_text())
    size = float(study.get('meshSize') or geo['recommendedSize'])
    if not math.isfinite(size) or size <= 0:
        raise ValueError('Mesh size must be a positive number in mm.')
    # Avoid accidentally allocating millions of elements with a typo.
    if size < max(geo['dimensions']) / 500:
        raise ValueError('Mesh size is too small for this part. Start above one five-hundredth of its longest dimension.')
    size_settings(size)
    gmsh.model.mesh.generate(3)
    gmsh.model.mesh.setOrder(2)
    gmsh.model.mesh.optimize('HighOrder')
    types = list(gmsh.model.mesh.getElementTypes(3))
    if types != [11]:
        raise ValueError('This part did not produce a quadratic tetrahedral mesh.')
    tags, conn = gmsh.model.mesh.getElementsByType(11)
    conn = np.asarray(conn).reshape(-1, 10)
    if len(tags) > 150000:
        raise ValueError('This mesh exceeds the first-version limit of 150,000 elements. Use a larger mesh size.')
    surface = surface_data(True)
    faces = {}
    for _, tag in gmsh.model.getEntities(2):
        nt, _, _ = gmsh.model.mesh.getNodes(2, tag, includeBoundary=True)
        _, tn = gmsh.model.mesh.getElementsByType(9, tag)
        faces[str(tag)] = {'nodes': [int(n) for n in nt], 'triangles': np.asarray(tn).reshape(-1,6).tolist()}
    quality = np.asarray(gmsh.model.mesh.getElementQualities(tags, 'minSICN'))
    mesh = {'surface': surface, 'elementIds': [int(t) for t in tags], 'elements': conn.tolist(),
            'faces': faces, 'size': size, 'nodeCount': len(surface['nodeIds']), 'elementCount': len(tags),
            'minQuality': float(quality.min())}
    if mesh['minQuality'] <= 0:
        raise ValueError('The mesh contains inverted elements. Try another mesh size or repair tiny CAD features.')
    (folder/'mesh.json').write_text(json.dumps(mesh))
    gmsh.write(str(folder/'part.msh'))
    gmsh.finalize()
    return mesh


def finite(value, name, positive=False):
    n = float(value)
    if not math.isfinite(n) or (positive and n <= 0):
        raise ValueError(f'{name} must be a finite' + (' positive number.' if positive else ' number.'))
    return n


def validate(study, mesh):
    material = study.get('material')
    if not material:
        raise ValueError('Choose a material first.')
    finite(material['young'], 'Elastic modulus', True)
    nu = finite(material['poisson'], 'Poisson ratio')
    if not -1 < nu < .499:
        raise ValueError('Poisson ratio must lie between -1 and 0.499. Nearly incompressible materials need a different formulation.')
    finite(material['density'], 'Density', True)
    if material.get('yield') is not None:
        finite(material['yield'], 'Yield strength', True)
    supports = study.get('supports', [])
    loads = study.get('loads', [])
    if not supports:
        raise ValueError('Add a support to hold the part in place.')
    if not loads:
        raise ValueError('Add a force, pressure, or gravity load.')
    valid_faces = set(mesh['faces'])
    for condition in supports + loads:
        if condition.get('kind') == 'gravity':
            continue
        face_ids = condition.get('faces', [])
        if not face_ids or any(str(f) not in valid_faces for f in face_ids) or len(face_ids) != len(set(face_ids)):
            raise ValueError('A condition references missing or repeated faces. Select faces from this part.')
    nodes = dict(zip(mesh['surface']['nodeIds'], np.asarray(mesh['surface']['positions']).reshape(-1,3)))
    fixed = set()
    for s in supports:
        axes = s.get('axes', [True,True,True])
        if len(axes) != 3 or not any(axes) or any(type(a) is not bool for a in axes):
            raise ValueError('A support must block at least one X, Y, or Z direction.')
        for f in s['faces']:
            for node in mesh['faces'][str(f)]['nodes']:
                for a in range(3):
                    if axes[a]: fixed.add((node,a))
    coords = np.asarray(list(nodes.values()))
    center = coords.mean(axis=0)
    scale = max(np.ptp(coords,axis=0))
    rows=[]
    for node,a in fixed:
        x,y,z = (nodes[node]-center)/scale
        rows.append([[1,0,0,0,z,-y],[0,1,0,-z,0,x],[0,0,1,y,-x,0]][a])
    rank = np.linalg.matrix_rank(np.asarray(rows), tol=1e-8)
    if rank < 6:
        raise ValueError(f'The part can still move freely ({6-rank} rigid motions). Block additional directions or choose another support face.')
    nonzero = False
    for l in loads:
        if l['kind'] in ['force', 'gravity']:
            v=l.get('vector', [])
            if len(v)!=3: raise ValueError('Enter all three load components.')
            nonzero |= any(finite(n,'Load component') != 0 for n in v)
        elif l['kind']=='pressure':
            nonzero |= finite(l['magnitude'],'Pressure') != 0
        else:
            raise ValueError('Unsupported load type.')
    if not nonzero:
        raise ValueError('All loads are zero. Enter a nonzero load.')
    return nodes, fixed


# Seven-point degree-5 quadrature on a reference triangle, weights sum to 1/2.
QUAD = [(1/3,1/3,.1125)]
for a,b,w in [(.470142064105115,.059715871789770,.066197076394253),(.101286507323456,.797426985353087,.062969590272414)]:
    QUAD.extend([(a,a,w),(a,b,w),(b,a,w)])


def triangle_weights(points):
    out=np.zeros(6)
    for r,s,w in QUAD:
        t=1-r-s
        N=np.array([t*(2*t-1),r*(2*r-1),s*(2*s-1),4*t*r,4*r*s,4*s*t])
        dr=np.array([1-4*t,4*r-1,0,4*(t-r),4*s,-4*s])
        ds=np.array([1-4*t,0,4*s-1,-4*r,4*r,4*(t-s)])
        jac=np.linalg.norm(np.cross(dr@points,ds@points))
        out += w*jac*N
    return out


def triangle_vector_weights(points, outward):
    out=np.zeros((6,3))
    for r,s,w in QUAD:
        t=1-r-s
        N=np.array([t*(2*t-1),r*(2*r-1),s*(2*s-1),4*t*r,4*r*s,4*s*t])
        dr=np.array([1-4*t,4*r-1,0,4*(t-r),4*s,-4*s])
        ds=np.array([1-4*t,0,4*s-1,-4*r,4*r,4*(t-s)])
        normal=np.cross(dr@points,ds@points)
        if np.dot(normal,outward)<0: normal=-normal
        out += w*N[:,None]*normal
    return out


def tetra_weights(points):
    out=np.zeros(10);dlam=np.array([[-1,-1,-1],[1,0,0],[0,1,0],[0,0,1]])
    for k in range(4):
        lam=np.full(4,.1381966011250105);lam[k]=.5854101966249685
        N=list(lam*(2*lam-1));dN=list((4*lam-1)[:,None]*dlam)
        for i,j in [(0,1),(1,2),(2,0),(0,3),(2,3),(1,3)]:
            N.append(4*lam[i]*lam[j]);dN.append(4*(lam[i]*dlam[j]+lam[j]*dlam[i]))
        jac=np.asarray(dN).T@points
        out += np.asarray(N)*abs(np.linalg.det(jac))/24
    return out


def write_deck(folder, study, mesh):
    nodes, fixed = validate(study,mesh)
    m=study['material']
    lines=['*HEADING','BetterSim linear static study; mm N MPa tonne s','*NODE']
    lines += [f'{n}, '+', '.join(f'{v:.12g}' for v in xyz) for n,xyz in nodes.items()]
    lines += ['*ELEMENT, TYPE=C3D10, ELSET=PART']
    # Gmsh and Abaqus/CalculiX use opposite order for the last two midside nodes.
    order=[0,1,2,3,4,5,6,7,9,8]
    lines += [f'{eid}, '+', '.join(str(c[i]) for i in order) for eid,c in zip(mesh['elementIds'],mesh['elements'])]
    lines += ['*MATERIAL, NAME=MAT','*ELASTIC',f"{m['young']:.12g}, {m['poisson']:.12g}", '*DENSITY',f"{m['density']*1e-12:.12g}",'*SOLID SECTION, ELSET=PART, MATERIAL=MAT','*BOUNDARY']
    lines += [f'{n}, {a+1}, {a+1}, 0' for n,a in sorted(fixed)]
    lines += ['*NSET, NSET=HELD']
    held=sorted(set(n for n,_ in fixed))
    lines += [', '.join(map(str,held[i:i+16])) for i in range(0,len(held),16)]
    lines += ['*STEP','*STATIC']
    cload={}
    dload=[]
    applied={}
    pressures={}
    gravity=np.zeros(3)
    def add_applied(n,vector):
        applied[n]=applied.get(n,np.zeros(3))+vector
    # CCX tetrahedral pressure faces: 123, 142, 243, 341.
    face_map={}
    tet_faces=[(0,1,2),(0,3,1),(1,3,2),(2,3,0)]
    for eid,c in zip(mesh['elementIds'],mesh['elements']):
        for num,ids in enumerate(tet_faces,1): face_map[tuple(sorted(c[i] for i in ids))]=(eid,num,np.mean([nodes[int(n)] for n in c[:4]],axis=0))
    for l in study['loads']:
        if l['kind']=='gravity':
            gravity+=np.asarray(l['vector'],float)*1000
        elif l['kind']=='pressure':
            for f in l['faces']:
                for tri in mesh['faces'][str(f)]['triangles']:
                    eid,face,center=face_map[tuple(sorted(tri[:3]))]
                    pressures[(eid,face)]=pressures.get((eid,face),0)+float(l['magnitude'])
                    points=np.array([nodes[n] for n in tri])
                    outward=points[:3].mean(axis=0)-center
                    forces=-float(l['magnitude'])*triangle_vector_weights(points,outward)
                    for n,f in zip(tri,forces): add_applied(n,f)
        else:
            weights={}
            for f in l['faces']:
                for tri in mesh['faces'][str(f)]['triangles']:
                    w=triangle_weights(np.array([nodes[n] for n in tri]))
                    for n,weight in zip(tri,w): weights[n]=weights.get(n,0)+weight
            area=sum(weights.values())
            if area<=0: raise ValueError('The loaded face has no usable area.')
            for n,w in weights.items():
                for a,v in enumerate(l['vector']): cload[(n,a)]=cload.get((n,a),0)+float(v)*w/area
    for (n,a),v in cload.items():
        vec=np.zeros(3);vec[a]=v;add_applied(n,vec)
    mag=float(np.linalg.norm(gravity))
    if mag:
        dload.append(f"PART, GRAV, {mag:.12g}, "+', '.join(f'{x:.12g}' for x in gravity/mag))
        for c in mesh['elements']:
            weights=tetra_weights(np.array([nodes[n] for n in c]))
            for n,w in zip(c,weights): add_applied(n,w*m['density']*1e-12*gravity)
    dload += [f'{eid}, P{face}, {pressure:.12g}' for (eid,face),pressure in pressures.items()]
    (folder/'applied.json').write_text(json.dumps({n:v.tolist() for n,v in applied.items()}))
    if cload:
        lines+=['*CLOAD']+[f'{n}, {a+1}, {v:.12g}' for (n,a),v in sorted(cload.items()) if abs(v)>1e-14]
    if dload: lines+=['*DLOAD']+dload
    lines += ['*NODE FILE','U, RF','*EL FILE','S','*NODE PRINT, NSET=HELD, TOTALS=YES','RF','*END STEP']
    (folder/'analysis.inp').write_text('\n'.join(lines)+'\n')
    return fixed


def find_ccx():
    candidates=[os.environ.get('BETTERSIM_CCX'),shutil.which('ccx'),shutil.which('ccx_2.23'),
                '/opt/homebrew/opt/calculix-ccx/bin/ccx_2.23','/usr/local/opt/calculix-ccx/bin/ccx_2.23']
    bundled=Path(__file__).resolve().parent.parent/'solver'/'ccx'
    candidates.insert(0,str(bundled))
    for p in candidates:
        if p and Path(p).is_file() and os.access(p,os.X_OK): return p
    raise ValueError('CalculiX was not found. Install costerwi/calculix/calculix-ccx with Homebrew, or set BETTERSIM_CCX to the solver executable.')


def parse_frd(path):
    fields={}; active=None
    for line in path.read_text().splitlines():
        if line.startswith(' -4'):
            label=line[5:17].strip()
            active=label if label in ['DISP','STRESS','FORC'] else None
            if active: fields[active]={}
        elif line.startswith(' -3'): active=None
        elif active and line.startswith(' -1'):
            node=int(line[3:13])
            values=[float(x) for x in re.findall(r'[+-]?\d*\.\d+(?:[Ee][+-]?\d+)?',line[13:])]
            fields[active][node]=values
    if not fields.get('DISP') or not fields.get('STRESS'):
        raise ValueError('CalculiX did not produce complete displacement and stress results. Inspect the solver log.')
    return fields


def solve(folder, study):
    mesh=json.loads((folder/'mesh.json').read_text())
    emit('checking','Checking supports and loads')
    fixed=write_deck(folder,study,mesh)
    emit('solving','Solving with CalculiX')
    start=time.monotonic()
    # The native SPOOLES MT build can produce nondeterministic factorization.
    # Pin every CCX/BLAS stage to one thread for reproducible results.
    env={k:v for k,v in os.environ.items() if not k.startswith('CCX_NPROC')}
    env.update(OMP_NUM_THREADS='1',NUMBER_OF_CPUS='1',OPENBLAS_NUM_THREADS='1',
               CCX_NPROC_RESULTS='1',CCX_NPROC_STIFFNESS='1',CCX_NPROC_EQUATION_SOLVER='1')
    process=subprocess.run([find_ccx(),'-i','analysis'],cwd=folder,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,env=env,timeout=240)
    (folder/'solver.log').write_text(process.stdout)
    if process.returncode != 0 or '*ERROR' in process.stdout or not (folder/'analysis.frd').exists():
        raise ValueError('CalculiX could not solve this study. Check supports, mesh quality, and the solver log.\n'+process.stdout[-2500:])
    emit('reading','Reading results')
    fields=parse_frd(folder/'analysis.frd')
    ids=mesh['surface']['nodeIds']
    if any(n not in fields['DISP'] or n not in fields['STRESS'] for n in ids):
        raise ValueError('The solver returned incomplete nodal results.')
    displacements=[fields['DISP'][n][:3] for n in ids]
    stress=[]
    for n in ids:
        xx,yy,zz,xy,yz,zx=fields['STRESS'][n][:6]
        stress.append(math.sqrt(max(0,((xx-yy)**2+(yy-zz)**2+(zz-xx)**2)/2+3*(xy*xy+yz*yz+zx*zx))))
    movement=np.linalg.norm(displacements,axis=1).tolist()
    reactions=np.zeros(3)
    applied=json.loads((folder/'applied.json').read_text())
    # CCX RF includes applied loads: subtract them to obtain support reactions.
    for n,a in fixed: reactions[a]+=fields.get('FORC',{}).get(n,[0,0,0])[a]-applied.get(str(n),[0,0,0])[a]
    total_load=np.sum(list(applied.values()),axis=0) if applied else np.zeros(3)
    # Resultants can cancel for pressure around a bore. Normalize by the
    # larger of the resultant and absolute equivalent nodal loading.
    load_scale=max(np.linalg.norm(total_load),sum(np.linalg.norm(v) for v in applied.values()),1e-9)
    balance=np.linalg.norm(reactions+total_load)/load_scale
    geo=json.loads((folder/'geometry.json').read_text())
    max_stress=max(stress); max_move=max(movement)
    yield_strength=study['material'].get('yield')
    warnings=['Peak stress at sharp corners or support edges may increase with refinement. Check a finer mesh before relying on a result.']
    if yield_strength and max_stress>yield_strength: warnings.append('Stress exceeds the material yield strength. The elastic model cannot predict permanent deformation.')
    if max_move>.05*min(geo['dimensions']): warnings.append('Movement is large relative to the smallest part dimension. A small-deformation analysis may not be appropriate.')
    result={'displacements':displacements,'stress':stress,'movement':movement,'summary':{'maxStress':max_stress,'maxMovement':max_move,
            'minSafety':yield_strength/max_stress if yield_strength and max_stress else None,'reactions':reactions.tolist(),
            'appliedForce':total_load.tolist(),'forceBalanceError':float(balance),'stressNode':ids[int(np.argmax(stress))],'movementNode':ids[int(np.argmax(movement))], 'seconds':time.monotonic()-start},
            'warnings':warnings,'solver':'CalculiX','meshSize':mesh['size'], 'nodeCount':mesh['nodeCount'],'elementCount':mesh['elementCount']}
    (folder/'result.json').write_text(json.dumps(result))
    return result


def main():
    command=sys.argv[1]; folder=Path(sys.argv[2]).resolve()
    study=json.loads(sys.stdin.read() or '{}')
    try:
        if command=='import': result=import_part(folder)
        elif command=='mesh': result=mesh_part(folder,study)
        elif command=='solve':
            mesh_part(folder,study)
            result={'mesh':json.loads((folder/'mesh.json').read_text()),'result':solve(folder,study)}
        else: raise ValueError('Unknown worker command.')
        print(json.dumps({'ok':True,'data':result}))
    except Exception as error:
        if gmsh.isInitialized(): gmsh.finalize()
        print(json.dumps({'ok':False,'error':str(error)}))
        sys.exit(1)

if __name__=='__main__': main()
