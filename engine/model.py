"""The meshed part with a study applied: physical validation and loads.

Everything here is solver-independent. Loads become equivalent nodal forces,
element-face pressures and body accelerations; the solver adapter writes
them in its own syntax. The equivalent nodal contributions of every load
are kept, because support reactions are recovered from the solver's nodal
forces by subtracting them."""
import math
import numpy as np

# Seven-point degree-5 quadrature on a reference triangle, weights sum to 1/2.
QUAD = [(1/3,1/3,.1125)]
for a,b,w in [(.470142064105115,.059715871789770,.066197076394253),(.101286507323456,.797426985353087,.062969590272414)]:
    QUAD.extend([(a,a,w),(a,b,w),(b,a,w)])


def triangle_shape(r, s):
    """Quadratic triangle shape functions and their parametric derivatives."""
    t=1-r-s
    N=np.array([t*(2*t-1),r*(2*r-1),s*(2*s-1),4*t*r,4*r*s,4*s*t])
    dr=np.array([1-4*t,4*r-1,0,4*(t-r),4*s,-4*s])
    ds=np.array([1-4*t,0,4*s-1,-4*r,4*r,4*(t-s)])
    return N,dr,ds


def triangle_weights(points):
    out=np.zeros(6)
    for r,s,w in QUAD:
        N,dr,ds=triangle_shape(r,s)
        jac=np.linalg.norm(np.cross(dr@points,ds@points))
        out += w*jac*N
    return out


def triangle_vector_weights(points, outward):
    out=np.zeros((6,3))
    for r,s,w in QUAD:
        N,dr,ds=triangle_shape(r,s)
        normal=np.cross(dr@points,ds@points)
        if np.dot(normal,outward)<0: normal=-normal
        out += w*N[:,None]*normal
    return out


# Four-point tetrahedron rule, the one CalculiX uses for C3D10 body loads.
TET_POINTS=[]
for k in range(4):
    lam=np.full(4,.1381966011250105);lam[k]=.5854101966249685
    TET_POINTS.append(lam)
TET_EDGES=[(0,1),(1,2),(2,0),(0,3),(2,3),(1,3)]
TET_DLAM=np.array([[-1,-1,-1],[1,0,0],[0,1,0],[0,0,1]])


def tetra_points(points):
    """(shape functions, position, weight × |J|) at each quadrature point of a
    ten-node tetrahedron in Gmsh node order."""
    out=[]
    for lam in TET_POINTS:
        N=list(lam*(2*lam-1));dN=list((4*lam-1)[:,None]*TET_DLAM)
        for i,j in TET_EDGES:
            N.append(4*lam[i]*lam[j]);dN.append(4*(lam[i]*TET_DLAM[j]+lam[j]*TET_DLAM[i]))
        N=np.asarray(N)
        jac=np.asarray(dN).T@points
        out.append((N,N@points,abs(np.linalg.det(jac))/24))
    return out


def tetra_weights(points):
    return sum(N*w for N,_,w in tetra_points(points))


def finite(value, name, positive=False):
    n = float(value)
    if not math.isfinite(n) or (positive and n <= 0):
        raise ValueError(f'{name} must be a finite' + (' positive number.' if positive else ' number.'))
    return n


def vector(value, name):
    if not isinstance(value,(list,tuple)) or len(value)!=3:
        raise ValueError(f'Enter all three {name} components.')
    return np.array([finite(v,name.capitalize()+' component') for v in value])


class Model:
    """Node coordinates, elements and CAD face mappings of a mesh."""
    def __init__(self, mesh):
        self.mesh=mesh
        self.ids=mesh['surface']['nodeIds']
        coords=np.asarray(mesh['surface']['positions']).reshape(-1,3)
        self.nodes=dict(zip(self.ids,coords))
        self.coords=coords
        self._faces=None

    def volumes(self):
        """Volume of each element in mm³, by the four-point rule."""
        return np.array([sum(w for _,_,w in tetra_points(np.array([self.nodes[n] for n in c]))) for c in self.mesh['elements']])

    def volume(self):
        return float(self.volumes().sum())

    def body_elements(self):
        """{body id: element ids}; a mesh from before assemblies is one body."""
        return self.mesh.get('bodies') or {'1':self.mesh['elementIds']}

    def components(self):
        """Groups of bonded bodies, as lists of body ids (strings)."""
        groups=self.mesh.get('components')
        return [[str(b) for b in g] for g in groups] if groups else [list(self.body_elements())]

    def materials(self, study):
        """[(body ids, material, element ids)]: the part material, with any
        body that has its own material split off."""
        own=study.get('bodyMaterials') or {}
        bodies=self.body_elements()
        out=[];rest=[]
        for b,elements in bodies.items():
            if b in own: out.append(([b],own[b],elements))
            else: rest+=[(b,elements)]
        if rest: out.insert(0,([b for b,_ in rest],study['material'],[e for _,es in rest for e in es]))
        return out

    def densities(self, study):
        """Density of each element in tonne/mm³ (kg/m³ × 1e-12)."""
        index={e:i for i,e in enumerate(self.mesh['elementIds'])}
        out=np.zeros(len(index))
        for _,m,elements in self.materials(study):
            for e in elements: out[index[e]]=m['density']*1e-12
        return out

    def body_number(self, body):
        return list(self.body_elements()).index(str(body))+1

    def face_triangles(self, face):
        return self.mesh['faces'][str(face)]['triangles']

    def face_nodes(self, face):
        return self.mesh['faces'][str(face)]['nodes']

    def element_faces(self):
        """CalculiX tetrahedron face numbers by sorted corner nodes, with the
        element centroid to orient outward normals. Faces: 123, 142, 243, 341."""
        if self._faces is None:
            self._faces={}
            tet_faces=[(0,1,2),(0,3,1),(1,3,2),(2,3,0)]
            for eid,c in zip(self.mesh['elementIds'],self.mesh['elements']):
                center=np.mean([self.nodes[int(n)] for n in c[:4]],axis=0)
                for num,ids in enumerate(tet_faces,1):
                    self._faces[tuple(sorted(c[i] for i in ids))]=(eid,num,center)
        return self._faces

    def face_quadrature(self, faces):
        """Points on the selected faces: (triangle nodes, N, position, outward
        unit normal, weight × area Jacobian) for each quadrature point."""
        lookup=self.element_faces();out=[]
        for f in faces:
            for tri in self.face_triangles(f):
                points=np.array([self.nodes[n] for n in tri])
                _,_,center=lookup[tuple(sorted(tri[:3]))]
                outward=points[:3].mean(axis=0)-center
                for r,s,w in QUAD:
                    N,dr,ds=triangle_shape(r,s)
                    normal=np.cross(dr@points,ds@points)
                    area=np.linalg.norm(normal)
                    if np.dot(normal,outward)<0: normal=-normal
                    out.append((tri,N,N@points,normal/area,w*area))
        return out


def check_material(material):
    if not material:
        raise ValueError('Choose a material first.')
    finite(material['young'], 'Elastic modulus', True)
    nu = finite(material['poisson'], 'Poisson ratio')
    if not -1 < nu < .499:
        raise ValueError('Poisson ratio must lie between -1 and 0.499. Nearly incompressible materials need a different formulation.')
    finite(material['density'], 'Density', True)
    if material.get('yield') is not None:
        finite(material['yield'], 'Yield strength', True)
    check_table(material)


# Properties a material's temperature table can give, and whether they must
# be positive.
TABLE={'young':('Elastic modulus',True),'conductivity':('Thermal conductivity',True),'expansion':('Thermal expansion',False)}


def check_table(material):
    """Rows of {temperature, and any of young, conductivity, expansion}, at
    distinct temperatures."""
    rows=material.get('byTemperature') or []
    if not isinstance(rows,list) or len(rows)>50:
        raise ValueError('The temperature table of a material is invalid.')
    temperatures=[finite(r.get('temperature'),'Table temperature') for r in rows]
    if len(set(temperatures))!=len(temperatures):
        raise ValueError('Each row of a material’s temperature table needs its own temperature.')
    for r in rows:
        for key,(name,positive) in TABLE.items():
            if r.get(key) is not None: finite(r[key],name,positive)


def check_materials(study, mesh):
    check_material(study.get('material'))
    bodies=set(mesh.get('bodies') or {'1':None})
    for b,m in (study.get('bodyMaterials') or {}).items():
        if b not in bodies: raise ValueError('A body material refers to a body this part does not have.')
        check_material(m)


def validate(study, mesh, require_loads=True):
    """Checks the material, face references and support directions, and that
    the supports remove all six rigid motions. Returns node coordinates and
    the blocked directions (Held)."""
    check_materials(study, mesh)
    supports = study.get('supports', [])
    loads = study.get('loads', [])
    if not supports:
        raise ValueError('Add a support to hold the part in place.')
    if not loads and require_loads:
        raise ValueError('Add a force, pressure, or gravity load.')
    masses = study.get('masses') or []
    check_faces(supports+[l for l in loads if l.get('kind') not in BODY_LOADS]+masses, mesh)
    check_masses(masses)
    model=Model(mesh)
    fixed=fixed_dofs(supports,model)
    rigid_motions(fixed,model)
    if loads: check_loads(loads, required=require_loads)
    return model.nodes, fixed


BODY_LOADS={'gravity','rotation'}


def check_faces(conditions, mesh):
    valid_faces = set(mesh['faces'])
    for condition in conditions:
        face_ids = condition.get('faces', [])
        if not face_ids or any(str(f) not in valid_faces for f in face_ids) or len(face_ids) != len(set(face_ids)):
            raise ValueError('A condition references missing or repeated faces. Select faces from this part.')


class Held:
    """Directions the supports block at each node. `dofs` holds (node, axis)
    pairs for directions along the global axes; `directions` maps a node to
    the orthonormal blocked directions (one or two rows) that are not, which
    the solver adapter writes as linear constraints."""
    def __init__(self):
        self.dofs=set();self.directions={}

    def __bool__(self):
        return bool(self.dofs or self.directions)

    def nodes(self):
        return {n for n,_ in self.dofs}|set(self.directions)


# Two blocked directions at a node count as distinct when they differ by more
# than about 10°: tan(θ/2) is the ratio of the singular values of the pair.
# Faces meeting at a smoother edge share one averaged direction.
DISTINCT=math.tan(math.radians(5))
# A blocked subspace within this of the global axes is written as such.
# Snapping a direction that is only nearly aligned would constrain motions
# the support leaves free, by that much.
ALIGNED=1e-9
# Frames a support's `axes` refer to: global X, Y, Z; the face normal
# (frictionless); radial, tangential and axial for a cylinder.
FRAMES=('global','normal','cylinder')


def face_normals(model, face):
    """Unit outward normal of a CAD face at each of its nodes, averaged over
    the face's triangles. A CAD face is smooth, so the average is the
    surface normal; triangles of other faces never mix in."""
    lookup=model.element_faces();sums={}
    # Parametric positions of the six triangle nodes.
    at=[(0,0),(1,0),(0,1),(.5,0),(.5,.5),(0,.5)]
    for tri in model.face_triangles(face):
        points=np.array([model.nodes[n] for n in tri])
        _,_,center=lookup[tuple(sorted(tri[:3]))]
        outward=points[:3].mean(axis=0)-center
        for n,(r,s) in zip(tri,at):
            _,dr,ds=triangle_shape(r,s)
            normal=np.cross(dr@points,ds@points)
            if np.dot(normal,outward)<0: normal=-normal
            sums[n]=sums.get(n,0)+normal
    return {n:v/np.linalg.norm(v) for n,v in sums.items()}


def cylinder_axis(points):
    """Axis direction of cylindrical faces from their quadrature points, or
    None if the faces are not cylindrical: the direction no surface normal
    has (to the mesh's faceting, about 2°), with the others well spread."""
    normals=np.array([q[3] for q in points]);weights=np.array([q[4] for q in points])
    values,vectors=np.linalg.eigh((normals*weights[:,None]).T@normals)
    if values[0]>1e-3*values[2] or values[1]<1e-3*values[2]: return None
    return vectors[:,0]


def cylinder(model, faces):
    """Axis point, unit direction and radius of faces on one cylinder. The
    axis passes closest to every normal line."""
    points=model.face_quadrature(faces)
    axis=cylinder_axis(points)
    if axis is None:
        raise ValueError('A cylindrical support needs cylindrical faces, such as a hole or a shaft.')
    A=np.zeros((3,3));b=np.zeros(3);center=np.zeros(3);area=0
    for _,_,x,n,w in points:
        # Distance from the normal line through x, across the axis.
        P=np.eye(3)-np.outer(n,n)-np.outer(axis,axis)
        A+=w*P;b+=w*P@x;center+=w*x;area+=w
    # Along the axis, place the point at the faces' centroid.
    A+=area*np.outer(axis,axis);b+=np.outer(axis,axis)@center
    point=np.linalg.solve(A,b)
    radius=sum(w*np.linalg.norm((x-point)-np.dot(x-point,axis)*axis) for _,_,x,_,w in points)/area
    return point,axis,radius


def cylinders(model, faces):
    """[(faces, axis point, direction)]: the selected faces grouped by the
    cylinder they lie on, so each hole or shaft keeps its own axis. Faces of
    one cylinder (a hole split into halves) share an axis line."""
    groups=[]
    for f in faces:
        point,axis,radius=cylinder(model,[f])
        for g in groups:
            d=point-g[1];offset=np.linalg.norm(d-np.dot(d,g[2])*g[2])
            if abs(np.dot(axis,g[2]))>.999 and offset<.05*radius:
                g[0].append(f);break
        else:
            groups.append(([f],point,axis))
    return [(fs,*cylinder(model,fs)[:2]) for fs,_,_ in groups]


def blocked_directions(support, model):
    """{node: [unit vectors]} that one support blocks."""
    axes=support.get('axes',[True,True,True])
    frame=support.get('frame','global')
    if frame not in FRAMES: raise ValueError('Unsupported support type.')
    if len(axes)!=3 or not any(axes) or any(type(a) is not bool for a in axes):
        raise ValueError('A support must block at least one direction.')
    out={}
    if frame=='global':
        for f in support['faces']:
            for n in model.face_nodes(f): out.setdefault(n,[]).extend(np.eye(3)[[a for a in range(3) if axes[a]]])
    elif frame=='normal':
        # One normal per face at each node: at an edge between two selected
        # faces both normals are blocked.
        for f in support['faces']:
            for n,v in face_normals(model,f).items(): out.setdefault(n,[]).append(v)
    else:
        for faces,point,axis in cylinders(model,support['faces']):
            for n in {n for f in faces for n in model.face_nodes(f)}:
                r=model.nodes[n]-point;r-=np.dot(r,axis)*axis
                radial=r/np.linalg.norm(r)
                frame_vectors=[radial,np.cross(axis,radial),axis]
                out.setdefault(n,[]).extend(v for v,on in zip(frame_vectors,axes) if on)
    return out


def fixed_dofs(supports, model):
    """The directions all supports block, combined at nodes they share."""
    gathered={}
    for s in supports:
        for n,vectors in blocked_directions(s,model).items(): gathered.setdefault(n,[]).extend(vectors)
    held=Held()
    for n,vectors in gathered.items():
        _,values,rows=np.linalg.svd(np.asarray(vectors))
        rank=int(np.sum(values>DISTINCT*values[0]))
        if rank==3:
            held.dofs.update((n,a) for a in range(3));continue
        basis=rows[:rank]
        # Share of each global axis inside the blocked subspace.
        share=np.linalg.norm(basis,axis=0)
        if np.all((share<ALIGNED)|(share>1-ALIGNED)):
            held.dofs.update((n,a) for a in range(3) if share[a]>.5)
        else:
            held.directions[n]=basis
    return held


def component_nodes(model):
    """Node sets of each group of bonded bodies, with the groups' bodies."""
    bodies=model.body_elements()
    index={e:i for i,e in enumerate(model.mesh['elementIds'])}
    out=[]
    for group in model.components():
        nodes=set()
        for b in group:
            for e in bodies[b]: nodes.update(model.mesh['elements'][index[e]])
        out.append((group,nodes))
    return out


def free_motions(held, model, nodes):
    """Rigid motions (0 to 6) that the blocked directions on `nodes` leave.
    Blocking direction d at offset r removes the motions with
    d·(t + ω × r) = d·t + ω·(r × d) = 0."""
    coords=np.array([model.nodes[n] for n in nodes])
    center=coords.mean(axis=0);scale=max(np.ptp(coords,axis=0))
    rows=[]
    blocked=[(n,np.eye(3)[a]) for n,a in held.dofs]+[(n,d) for n,ds in held.directions.items() for d in ds]
    for node,d in blocked:
        if node not in nodes: continue
        r=(model.nodes[node]-center)/scale
        rows.append([*d,*np.cross(r,d)])
    # A motion resisted only at round-off (fitted cylinder axes are exact to
    # about 1e-6) is free.
    return int(6-(np.linalg.matrix_rank(np.asarray(rows),tol=1e-6) if rows else 0))


def rigid_motions(fixed, model):
    """Raises unless the blocked directions remove all six rigid motions of
    every group of bonded bodies."""
    groups=component_nodes(model)
    for group,nodes in groups:
        free=free_motions(fixed,model,nodes)
        if free:
            if len(groups)==1:
                raise ValueError(f'The part can still move freely ({free} rigid motions). Block additional directions or choose another support face.')
            names=', '.join(f'Body {model.body_number(b)}' for b in group)
            raise ValueError(f'{names} can still move freely ({free} rigid motions). Bodies are bonded only where their faces touch, so each separate group needs its own supports.')


def check_masses(masses):
    for m in masses:
        finite(m.get('mass'),'Point mass',True)
        vector(m.get('point'),'center of mass')


def check_loads(loads, required=True):
    nonzero = False
    for l in loads:
        kind=l['kind']
        if kind in ['force', 'gravity', 'bearing']:
            nonzero |= bool(np.any(vector(l.get('vector'),'load')))
        elif kind=='remote':
            nonzero |= bool(np.any(vector(l.get('vector'),'load')))
            vector(l.get('point'),'position')
        elif kind=='moment':
            nonzero |= bool(np.any(vector(l.get('vector'),'moment')))
        elif kind=='pressure':
            nonzero |= finite(l['magnitude'],'Pressure') != 0
        elif kind=='rotation':
            nonzero |= finite(l['magnitude'],'Rotational speed') != 0
            if not np.any(vector(l.get('axis'),'axis')):
                raise ValueError('Choose the direction of the rotation axis.')
            vector(l.get('point'),'axis position')
        else:
            raise ValueError('Unsupported load type.')
    if required and not nonzero:
        raise ValueError('All loads are zero. Enter a nonzero load.')


class Loading:
    """Equivalent loads of a study. `nodal` holds concentrated forces by
    (node, direction); `pressures` element-face pressures by (element,
    face); `gravity` the summed acceleration in mm/s²; `rotation` the
    angular velocity (rad/s), axis point and unit direction, or None.
    `applied` collects the equivalent nodal force of everything, for
    reaction recovery."""
    def __init__(self):
        self.nodal={};self.pressures={};self.gravity=np.zeros(3);self.applied={}
        self.rotation=None

    def add_applied(self, node, force):
        self.applied[node]=self.applied.get(node,np.zeros(3))+force

    def add_nodal(self, node, force):
        for a,v in enumerate(force):
            self.nodal[(node,a)]=self.nodal.get((node,a),0)+float(v)

    def total(self):
        return np.sum(list(self.applied.values()),axis=0) if self.applied else np.zeros(3)


def face_frame(points):
    """Area, centroid and polar inertia tensor J = ∫(|r|²I − r rᵀ)dA of
    quadrature points [(…, position, …, weight)], about the centroid."""
    area=sum(q[4] for q in points)
    if area<=0: raise ValueError('The loaded face has no usable area.')
    center=sum(q[4]*q[2] for q in points)/area
    J=np.zeros((3,3))
    for q in points:
        r=q[2]-center
        J+=q[4]*(np.dot(r,r)*np.eye(3)-np.outer(r,r))
    return area,center,J


def distribute(model, faces, force, moment, point=None):
    """Consistent nodal forces of a force and moment carried by faces, as a
    deformable connection: uniform traction for the force at the centroid,
    plus a traction varying linearly with position for the moment. This is
    the RBE3 / distributing-coupling distribution. A force acting at `point`
    adds the moment of its offset from the centroid. The result has exactly
    the given resultant force and moment."""
    points=model.face_quadrature(faces)
    area,center,J=face_frame(points)
    total=np.asarray(moment,float).copy()
    if point is not None: total+=np.cross(np.asarray(point,float)-center,force)
    try:
        twist=np.linalg.solve(J,total)
    except np.linalg.LinAlgError:
        raise ValueError('These faces cannot carry a moment. Select faces that are not all in one line.')
    out={}
    for tri,N,x,_,w in points:
        traction=np.asarray(force,float)/area+np.cross(twist,x-center)
        for n,Ni in zip(tri,N): out[n]=out.get(n,0)+Ni*w*traction
    return out


def bearing(model, faces, force):
    """Nodal forces of a bearing load: pressure on the half of the cylinder
    facing the load, varying with the cosine of the angle from the load
    direction, scaled so its resultant along the load is the given force."""
    points=model.face_quadrature(faces)
    axis=cylinder_axis(points)
    if axis is None:
        raise ValueError('A bearing load needs cylindrical faces, such as a hole or a shaft.')
    size=np.linalg.norm(force);direction=np.asarray(force,float)/size
    if abs(np.dot(direction,axis))>.02:
        raise ValueError('A bearing load acts across the cylinder. Remove the force component along its axis.')
    out={};resultant=0
    for tri,N,x,n,w in points:
        share=max(0.,-np.dot(n,direction))
        resultant+=w*share**2
        for node,Ni in zip(tri,N): out[node]=out.get(node,0)+Ni*w*share*(-n)
    if resultant<=0:
        raise ValueError('The selected faces do not face the bearing load. Check its direction.')
    return {n:f*size/resultant for n,f in out.items()}


def rpm_to_rad(speed):
    return float(speed)*2*math.pi/60


def build_loads(study, model, density=None):
    """Equivalent loads for the study's load list. Body loads use each
    element's density (tonne/mm³)."""
    densities=model.densities(study)
    loading=Loading()
    lookup=model.element_faces()
    for l in study['loads']:
        kind=l['kind']
        if kind in ('remote','moment','bearing'):
            v=np.asarray(l['vector'],float)
            if kind=='remote': forces=distribute(model,l['faces'],v,np.zeros(3),l['point'])
            elif kind=='moment': forces=distribute(model,l['faces'],np.zeros(3),v)
            else: forces=bearing(model,l['faces'],v)
            for n,f in forces.items(): loading.add_nodal(n,f)
        elif kind=='rotation':
            if loading.rotation is not None:
                raise ValueError('Use one rotation load. A part spins about one axis.')
            axis=np.asarray(l['axis'],float)
            loading.rotation=(rpm_to_rad(l['magnitude']),np.asarray(l['point'],float),axis/np.linalg.norm(axis))
        elif kind=='gravity':
            loading.gravity+=np.asarray(l['vector'],float)*1000
        elif l['kind']=='pressure':
            p=float(l['magnitude'])
            for f in l['faces']:
                for tri in model.face_triangles(f):
                    eid,face,center=lookup[tuple(sorted(tri[:3]))]
                    loading.pressures[(eid,face)]=loading.pressures.get((eid,face),0)+p
                    points=np.array([model.nodes[n] for n in tri])
                    outward=points[:3].mean(axis=0)-center
                    for n,force in zip(tri,-p*triangle_vector_weights(points,outward)): loading.add_applied(n,force)
        else:
            weights={}
            for f in l['faces']:
                for tri in model.face_triangles(f):
                    w=triangle_weights(np.array([model.nodes[n] for n in tri]))
                    for n,weight in zip(tri,w): weights[n]=weights.get(n,0)+weight
            area=sum(weights.values())
            if area<=0: raise ValueError('The loaded face has no usable area.')
            for n,w in weights.items():
                loading.add_nodal(n,np.asarray(l['vector'],float)*w/area)
    for m in study.get('masses') or []:
        # A point mass feels the body loads at its own position.
        point=np.asarray(m['point'],float)
        acceleration=loading.gravity.copy()
        if loading.rotation:
            omega,origin,axis=loading.rotation
            r=point-origin;r-=np.dot(r,axis)*axis
            acceleration+=omega**2*r
        if np.any(acceleration):
            force=float(m['mass'])*1e-3*acceleration
            for n,f in distribute(model,m['faces'],force,np.zeros(3),point).items(): loading.add_nodal(n,f)
    for (n,a),v in loading.nodal.items():
        force=np.zeros(3);force[a]=v;loading.add_applied(n,force)
    if np.any(loading.gravity) or loading.rotation:
        if loading.rotation: omega,origin,axis=loading.rotation
        for c,density in zip(model.mesh['elements'],densities):
            for N,x,w in tetra_points(np.array([model.nodes[n] for n in c])):
                body=loading.gravity.copy()
                if loading.rotation:
                    r=x-origin;r-=np.dot(r,axis)*axis
                    body+=omega**2*r
                for n,Ni in zip(c,N): loading.add_applied(n,Ni*w*density*body)
    return loading


def rbe3(model, faces, point, limit=60):
    """Linear constraint making `point` follow the selected faces like an
    RBE3 element: its displacement is the faces' area-weighted mean
    translation plus their mean rotation times its offset. Returns
    [(node, 3×3 coefficient matrix)] with u_point = Σ A·u_node. At most
    `limit` nodes take part (CalculiX recommends short equations): face nodes
    are thinned by farthest-point sampling, each sampled node taking the
    weight of the nodes nearest to it."""
    weights={}
    for tri,N,_,_,w in model.face_quadrature(faces):
        for n,Ni in zip(tri,N): weights[n]=weights.get(n,0)+Ni*w
    nodes=[n for n,w in weights.items() if w>1e-12*sum(weights.values())]
    xyz=np.array([model.nodes[n] for n in nodes]);w=np.array([weights[n] for n in nodes])
    if len(nodes)>limit:
        chosen=[int(np.argmax(w))];far=np.linalg.norm(xyz-xyz[chosen[0]],axis=1)
        while len(chosen)<limit:
            k=int(np.argmax(far));chosen.append(k)
            far=np.minimum(far,np.linalg.norm(xyz-xyz[k],axis=1))
        owner=np.argmin(np.linalg.norm(xyz[:,None,:]-xyz[chosen][None,:,:],axis=2),axis=1)
        w=np.array([w[owner==i].sum() for i in range(len(chosen))])
        nodes=[nodes[k] for k in chosen];xyz=xyz[chosen]
    w=w/w.sum()
    center=w@xyz
    r=xyz-center
    J=sum(wi*(np.dot(ri,ri)*np.eye(3)-np.outer(ri,ri)) for wi,ri in zip(w,r))
    Jinv=np.linalg.pinv(J)
    cross=lambda v:np.array([[0,-v[2],v[1]],[v[2],0,-v[0]],[-v[1],v[0],0]])
    D=cross(np.asarray(point,float)-center)
    return [(n,wi*(np.eye(3)-D@Jinv@cross(ri))) for n,wi,ri in zip(nodes,w,r)]


def rigid_count(fixed, model):
    """How many rigid motions the blocked directions leave free, over all
    groups of bonded bodies."""
    return sum(free_motions(fixed,model,nodes) for _,nodes in component_nodes(model))


def validate_vibration(study, mesh):
    """Material with density, valid supports (optional) and point masses.
    Loads play no part. Returns (model, fixed, free rigid motions)."""
    check_materials(study,mesh)
    masses=study.get('masses') or []
    check_faces(study.get('supports',[])+masses,mesh)
    check_masses(masses)
    model=Model(mesh)
    fixed=fixed_dofs(study.get('supports',[]),model)
    return model,fixed,rigid_count(fixed,model)
