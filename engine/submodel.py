"""Submodeling: re-solve a box-shaped region of a solved part on a finer mesh.

The region is cut from the part's CAD geometry and meshed finely. Its faces
are either surfaces of the original part, which keep the study's supports
and loads, or cut faces, where CalculiX imposes the displacements of the
global solution (*SUBMODEL). By Saint-Venant's principle the region's
stress is accurate away from its cut faces, so the check that matters is
whether stress on the cut faces agrees with the global solution."""
import json, math, shutil, time
import numpy as np
import gmsh
import calculix
from cad import emit, threads, terminal_output, mesh_model, write_view, mesh_view
from model import Model, finite, vector, fixed_dofs, build_loads, check_masses
from analyses import SCHEMA, von_mises, nodal, mass_check, write_result_view, measures, STRESS_FIELDS

# Loads whose distribution depends on all of their faces. A region that
# contains part of their faces cannot reproduce them.
WHOLE_FACE_LOADS={'remote','moment','bearing'}


def check_region(region, bounds):
    center=vector(region.get('center'),'region center')
    size=vector(region.get('size'),'region size')
    if np.any(size<=0):
        raise ValueError('The region needs a positive size in X, Y and Z.')
    finite(region.get('meshSize'),'Region element size',True)
    lo,hi=center-size/2,center+size/2
    if np.any(hi<=np.asarray(bounds[:3])) or np.any(lo>=np.asarray(bounds[3:])):
        raise ValueError('The region does not overlap the part. Move it over the area of interest.')
    return lo,hi


def cut(step, lo, hi):
    """Loads the part and replaces it with its intersection with the box."""
    if gmsh.isInitialized(): gmsh.finalize()
    gmsh.initialize()
    terminal_output()
    gmsh.option.setNumber('General.NumThreads',threads())
    gmsh.option.setString('Geometry.OCCTargetUnit','MM')
    gmsh.model.occ.importShapes(str(step))
    gmsh.model.occ.synchronize()
    solids=gmsh.model.getEntities(3)
    box=gmsh.model.occ.addBox(*lo,*(hi-lo))
    out,_=gmsh.model.occ.intersect(solids,[(3,box)])
    gmsh.model.occ.synchronize()
    if not [t for d,t in out if d==3]:
        raise ValueError('The region does not overlap the part. Move it over the area of interest.')


def classify(mesh, lo, hi, parent, geometry):
    """Each region face: the original part face it lies on, or None for a
    cut face on the box. Faces on a box plane are cut faces unless the part
    itself has a planar face there."""
    size=np.linalg.norm(hi-lo)
    tol=1e-6*size
    coords=dict(zip(mesh['surface']['nodeIds'],np.asarray(mesh['surface']['positions']).reshape(-1,3)))
    pcoords=dict(zip(parent['surface']['nodeIds'],np.asarray(parent['surface']['positions']).reshape(-1,3)))
    centers=[];owners=[]
    for f,data in parent['faces'].items():
        for tri in data['triangles']:
            centers.append(np.mean([pcoords[n] for n in tri[:3]],axis=0));owners.append(int(f))
    centers=np.asarray(centers);owners=np.asarray(owners)
    kind={f['id']:f for f in geometry['faces']}
    out={}
    for f,data in mesh['faces'].items():
        points=np.array([coords[n] for n in data['nodes']])
        tris=data['triangles']
        step=max(1,len(tris)//25)
        samples=np.array([np.mean([coords[n] for n in t[:3]],axis=0) for t in tris[::step]])
        d2=(samples**2).sum(1)[:,None]+(centers**2).sum(1)[None,:]-2*samples@centers.T
        nearest=owners[np.argmin(d2,axis=1)]
        ids,counts=np.unique(nearest,return_counts=True)
        original=int(ids[np.argmax(counts)])
        on_box=None
        for a in range(3):
            for plane in (lo[a],hi[a]):
                if np.all(np.abs(points[:,a]-plane)<tol): on_box=(a,plane)
        if on_box:
            a,plane=on_box
            face=kind.get(original)
            coplanar=face and face['type']=='Plane' and abs(abs(face['normal'][a])-1)<1e-6 and abs(face['center'][a]-plane)<tol*10
            out[int(f)]=original if coplanar else None
        else:
            out[int(f)]=original
    return out


def region_study(study, faces, areas, original_areas):
    """The study's conditions on the region's faces. A total force keeps its
    traction: the region carries the share of its faces' area."""
    def mapped(condition):
        return [f for f,o in faces.items() if o is not None and o in condition['faces']]
    supports=[{**s,'faces':mapped(s)} for s in study['supports']]
    supports=[s for s in supports if s['faces']]
    loads=[]
    for l in study['loads']:
        if l['kind'] in ('gravity','rotation'):
            loads.append(l);continue
        on=mapped(l)
        if not on: continue
        if l['kind'] in WHOLE_FACE_LOADS:
            raise ValueError(f"The region contains faces of “{l.get('name','a load')}”. Remote forces, moments and bearing loads cannot be split by a region yet: move the region away from those faces.")
        if l['kind']=='force':
            share=sum(areas[f] for f in on)/sum(original_areas[o] for o in l['faces'])
            l={**l,'vector':[v*share for v in l['vector']]}
        loads.append({**l,'faces':on})
    for m in study.get('masses') or []:
        if mapped(m):
            raise ValueError(f"The region contains faces carrying the point mass “{m.get('name','')}”. Move the region away from them.")
    return {**study,'supports':supports,'loads':loads,'masses':[]}


def interpolate(mesh, values, queries):
    """Values of a nodal field at points inside a quadratic tetrahedral mesh,
    using the quadratic shape functions of the containing element (straight
    edges assumed for locating it). Points outside take the nearest element."""
    ids=mesh['surface']['nodeIds']
    index={n:i for i,n in enumerate(ids)}
    coords=np.asarray(mesh['surface']['positions']).reshape(-1,3)
    tets=np.array([[index[n] for n in c] for c in mesh['elements']])
    corners=coords[tets[:,:4]]
    lo=corners.min(1);hi=corners.max(1)
    cell=float(np.median(np.max(hi-lo,axis=1)))*1.01
    grid={}
    for e,(a,b) in enumerate(zip(np.floor(lo/cell).astype(int),np.floor(hi/cell).astype(int))):
        for i in range(a[0],b[0]+1):
            for j in range(a[1],b[1]+1):
                for k in range(a[2],b[2]+1): grid.setdefault((i,j,k),[]).append(e)
    values=np.asarray(values)
    out=np.zeros(len(queries))
    for q,p in enumerate(queries):
        key=tuple(np.floor(p/cell).astype(int))
        candidates=np.array(grid.get(key,[]),int)
        if not len(candidates):
            candidates=np.array([int(np.argmin(np.linalg.norm(corners.mean(1)-p,axis=1)))])
        c=corners[candidates]
        T=np.transpose(c[:,1:]-c[:,:1],(0,2,1))
        try:
            lam123=np.linalg.solve(T,(p-c[:,0])[:,:,None])[:,:,0]
        except np.linalg.LinAlgError:
            lam123=np.array([np.linalg.lstsq(t,p-c0,rcond=None)[0] for t,c0 in zip(T,c[:,0])])
        lam=np.concatenate([1-lam123.sum(1,keepdims=True),lam123],axis=1)
        best=int(np.argmax(lam.min(1)))
        l=np.clip(lam[best],0,1);l/=l.sum()
        N=list(l*(2*l-1))+[4*l[i]*l[j] for i,j in [(0,1),(1,2),(2,0),(0,3),(2,3),(1,3)]]
        out[q]=np.dot(N,values[tets[candidates[best]]])
    return out


def submodel(folder, study, region):
    """Solves the region of a solved static study. Writes into folder/region
    and returns (mesh, result, region geometry)."""
    if (study.get('analysis') or 'static')!='static':
        raise ValueError('Region refinement is available for static studies.')
    if not (folder/'analysis.frd').exists() or not (folder/'result.json').exists():
        raise ValueError('Solve the whole part before refining a region.')
    parent=json.loads((folder/'mesh.json').read_text())
    geometry=json.loads((folder/'geometry.json').read_text())
    if len(geometry.get('bodies') or [None])>1:
        raise ValueError('Region refinement works on single parts for now, not assemblies.')
    lo,hi=check_region(region,geometry['bounds'])
    target=folder/'region';target.mkdir(exist_ok=True)
    emit('meshing','Cutting the region from the part')
    cut(folder/'part.step',lo,hi)
    emit('meshing','Meshing the region')
    surface_area={tag:gmsh.model.occ.getMass(2,tag) for _,tag in gmsh.model.getEntities(2)}
    mesh=mesh_model(target,float(region['meshSize']),finalize=False)
    gmsh.finalize()
    faces=classify(mesh,lo,hi,parent,geometry)
    cut_faces=[f for f,o in faces.items() if o is None]
    if not cut_faces:
        raise ValueError('The region contains the whole part. Make it smaller, or refine the whole mesh instead.')
    original_areas={f['id']:f['area'] for f in geometry['faces']}
    local=region_study(study,faces,surface_area,original_areas)
    check_masses(local.get('masses') or [])

    emit('checking','Applying the whole-part solution to the cut faces')
    model=Model(mesh)
    m=local['material']
    fixed=fixed_dofs(local['supports'],model)
    loading=build_loads(local,model,m['density']*1e-12)
    held=fixed.nodes()
    driven=sorted({n for f in cut_faces for n in model.face_nodes(f)}-held)
    shutil.copy(folder/'analysis.frd',target/'global.frd')
    lines=calculix.mesh_lines(model,'region of a linear static study')
    lines+=calculix.material_lines(m)
    if fixed: lines+=calculix.boundary_lines(fixed)
    lines+=['*NSET, NSET=CUT']+calculix.rows(driven)
    lines+=['*SUBMODEL, TYPE=NODE, INPUT=global.frd','CUT']
    lines+=['*STEP','*STATIC, SOLVER='+calculix.solver(study)[0],
            '*BOUNDARY, SUBMODEL, STEP=1','CUT, 1, 3']
    lines+=calculix.load_lines(loading)
    lines+=['*NODE FILE','U','*EL FILE','S, E','*END STEP']
    (target/'analysis.inp').write_text('\n'.join(lines)+'\n')

    emit('solving','Solving the region with CalculiX')
    start=time.monotonic()
    iterative=calculix.run(target,solver=calculix.solver_of(study))
    emit('reading','Reading results')
    frame=calculix.parse_frd(target/'analysis.frd')[-1]
    ids=model.ids
    displacements=nodal(frame,'DISP',ids,3,'displacement and stress')
    fields=measures(frame,ids)
    stress=fields['vonMises']
    movement=np.linalg.norm(displacements,axis=1)

    # The whole-part solution inside the box, and on the cut faces.
    whole=json.loads((folder/'result.json').read_text())
    gcoords=np.asarray(parent['surface']['positions']).reshape(-1,3)
    inside=np.all((gcoords>=lo-1e-9)&(gcoords<=hi+1e-9),axis=1)
    global_peak=float(np.asarray(whole['stress'])[inside].max()) if inside.any() else 0.
    index={n:i for i,n in enumerate(ids)}
    boundary=sorted({n for f in cut_faces for n in model.face_nodes(f)})
    points=np.array([model.nodes[n] for n in boundary])
    expected=interpolate(parent,whole['stress'],points)
    peak=float(stress.max())
    scale=max(peak,global_peak,1e-12)
    # Nodal-averaged stress at the cut faces' edges is noisy in both models,
    # so the agreement measure is the 95th percentile of the difference.
    difference=float(np.percentile(np.abs(stress[[index[n] for n in boundary]]-expected),95)/scale)

    warnings=[]
    if difference>.1:
        warnings.append('Stress on the region’s cut faces differs from the whole-part solution by more than 10% of the peak (95th percentile). The cut faces are too close to the stress concentration: make the region larger.')
    if peak>1.5*global_peak and global_peak>0:
        warnings.append('The refined peak is much higher than the whole-part peak. If it keeps rising with a finer region mesh, it is at a sharp corner or support edge with no finite stress.')
    yield_strength=m.get('yield')
    if yield_strength and peak>yield_strength:
        warnings.append('Stress exceeds the material yield strength. The elastic model cannot predict permanent deformation.')
    summary={'seconds':time.monotonic()-start,'maxStress':peak,'maxMovement':float(movement.max()),
             'minSafety':yield_strength/peak if yield_strength and peak else None,
             'stressNode':ids[int(np.argmax(stress))],'movementNode':ids[int(np.argmax(movement))],
             'globalPeak':global_peak,'boundaryDifference':difference}
    result={'version':SCHEMA,'analysis':'static','region':{'lo':lo.tolist(),'hi':hi.tolist(),'cutFaces':cut_faces},
            'frames':[{'label':'Region','value':None,'unit':''}],'fields':['displacement',*STRESS_FIELDS],
            'summary':summary,'warnings':warnings,'charts':[],
            'checks':[{'label':'Peak stress, whole part in region → refined','values':[global_peak,peak],'unit':'MPa'},
                      {'label':'Cut-face stress difference (95th percentile), share of peak','values':[difference*100],'unit':'%'},
                      {'label':'Region faces: cut, original','values':[len(cut_faces),len(faces)-len(cut_faces)],'unit':'','digits':0}],
            'keys':[{'id':'maxStress','label':'Peak stress','unit':'MPa','value':peak,'peak':True}],
            'solver':'CalculiX, '+calculix.solver_note(calculix.solver(study)[1],iterative),
            'iterations':iterative['iterations'] if iterative else None,'threads':threads(),
            'meshSize':mesh['size'],'nodeCount':mesh['nodeCount'],'elementCount':mesh['elementCount'],
            'displacements':displacements.tolist(),'stress':stress.tolist(),'movement':movement.tolist()}
    (target/'result.json').write_text(json.dumps(result))
    write_result_view(target,mesh,[{'displacement':displacements,**fields}])
    coords=model.coords
    region_geometry={'bounds':[*coords.min(0).tolist(),*coords.max(0).tolist()],
                     'faces':[{**{k:v for k,v in f.items() if k!='indices'},'original':faces.get(f['id']),
                               'cut':faces.get(f['id']) is None} for f in mesh['surface']['faces']]}
    return mesh,result,region_geometry
