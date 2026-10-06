"""CAD import and meshing with Gmsh/OpenCASCADE, and the viewer's binary file."""
import sys, os, json, math, hashlib
import numpy as np
import gmsh


def emit(stage, message):
    print(json.dumps({'stage': stage, 'message': message}), file=sys.stderr, flush=True)


def threads():
    """Thread count chosen by the service (SPRUNG_FEA_THREADS), else all cores."""
    value=os.environ.get('SPRUNG_FEA_THREADS','')
    return max(1,int(value)) if value.isdigit() else (os.cpu_count() or 1)


def initialize(step):
    # Start from an empty model, even after an earlier failure left one.
    if gmsh.isInitialized(): gmsh.finalize()
    gmsh.initialize()
    gmsh.option.setNumber('General.Terminal', 0)
    gmsh.option.setNumber('General.NumThreads', threads())
    gmsh.option.setString('Geometry.OCCTargetUnit', 'MM')
    gmsh.model.occ.importShapes(str(step))
    gmsh.model.occ.synchronize()
    solids = gmsh.model.getEntities(3)
    if not solids:
        raise ValueError('This STEP contains no solids. Export the part as a solid body, not surfaces.')
    if any(gmsh.model.occ.getMass(*s) <= 0 for s in solids):
        raise ValueError('A body has no solid volume. Export closed solids as STEP.')
    if len(solids) > 1:
        # A bonded assembly: fragmenting makes touching bodies share their
        # contact faces, so the mesh is continuous across them. A single
        # solid skips this, which keeps its face numbers.
        _, parts = gmsh.model.occ.fragment(solids, [])
        gmsh.model.occ.synchronize()
        if any(len(p) != 1 for p in parts) or len(gmsh.model.getEntities(3)) != len(solids):
            raise ValueError('Some bodies overlap. Bonded bodies must touch without overlapping: check your CAD model for interference.')
        solids = gmsh.model.getEntities(3)
    return solids


def topology():
    """Bodies and how faces join them: {face: [volume tags]}. A face with one
    volume is on the outside; one with two is a bonded contact."""
    return {tag: [int(v) for v in gmsh.model.getAdjacencies(2, tag)[0]] for _, tag in gmsh.model.getEntities(2)}


def bodies(solids, adjacency):
    """Body list and the groups of bodies bonded to each other."""
    out = [{'id': tag, 'name': f'Body {i+1}', 'volume': gmsh.model.occ.getMass(3, tag)} for i, (_, tag) in enumerate(solids)]
    return out, groups([b['id'] for b in out], adjacency)


def groups(ids, adjacency):
    """Groups of bodies joined by faces they share."""
    group = {b: b for b in ids}
    def root(b):
        while group[b] != b: b = group[b]
        return b
    for volumes in adjacency.values():
        if len(volumes) == 2: group[root(volumes[0])] = root(volumes[1])
    components = {}
    for b in ids: components.setdefault(root(b), []).append(b)
    return sorted(components.values())


def interfaces(adjacency):
    """Faces where two bodies touch: [{id, bodies, area, center}]. They are
    bonded unless a study gives them contact."""
    return [{'id':tag,'bodies':sorted(v),'area':gmsh.model.occ.getMass(2,tag),
             'center':list(gmsh.model.occ.getCenterOfMass(2,tag))}
            for tag,v in sorted(adjacency.items()) if len(v)==2]


def size_settings(size):
    gmsh.option.setNumber('Mesh.MeshSizeMax', size)
    gmsh.option.setNumber('Mesh.MeshSizeMin', size / 5)
    gmsh.option.setNumber('Mesh.MeshSizeFromCurvature', 16)
    gmsh.option.setNumber('Mesh.MeshSizeExtendFromBoundary', 1)
    gmsh.option.setNumber('Mesh.Algorithm', 6)
    gmsh.option.setNumber('Mesh.Algorithm3D', 1)
    gmsh.option.setNumber('Mesh.Optimize', 1)
    gmsh.model.mesh.setSize(gmsh.model.getEntities(0), size)


def preview_settings(dims):
    # Display triangulation for setup only; analysis meshes use size_settings.
    # Curved faces get about 36 segments per full turn; flat faces stay coarse.
    gmsh.option.setNumber('Mesh.MeshSizeMax', max(dims) / 50)
    gmsh.option.setNumber('Mesh.MeshSizeMin', max(dims) / 300)
    gmsh.option.setNumber('Mesh.MeshSizeFromCurvature', 36)
    gmsh.option.setNumber('Mesh.MeshSizeExtendFromBoundary', 0)
    gmsh.option.setNumber('Mesh.Algorithm', 6)


def surface_data(quadratic=False):
    """Nodes and the outer faces, each with its body. Bonded contact faces
    are inside the assembly and are left out."""
    tags, coords, _ = gmsh.model.mesh.getNodes()
    coords = np.asarray(coords).reshape(-1, 3)
    node_index = {int(t): i for i, t in enumerate(tags)}
    faces = []
    adjacency = topology()
    for _, tag in gmsh.model.getEntities(2):
        if len(adjacency[tag]) != 1: continue
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
        face={'anchor':closest.tolist(),'normal':normal.tolist(),'id': tag, 'name': f'Face {tag}', 'type': gmsh.model.getType(2, tag),
              'body': adjacency[tag][0],
              'area': gmsh.model.occ.getMass(2, tag), 'center': list(gmsh.model.occ.getCenterOfMass(2, tag)), 'indices': tris}
        if face['type'] == 'Cylinder' and not quadratic:
            # Holes and shafts: their radius sizes bolts, and their axis
            # tells a bolt's shank from the holes it passes through.
            try:
                point, axis, radius, lo, hi = cylinder_of([tag])
                face.update(radius=radius, axis=[*point.tolist(), *axis.tolist()], extent=[lo, hi])
            except ValueError: pass
        faces.append(face)
    return {'positions': coords.flatten().tolist(), 'nodeIds': [int(t) for t in tags], 'faces': faces}


# Gmsh and VTK/Abaqus/CalculiX use opposite order for the last two midside
# nodes of a ten-node tetrahedron.
TET10_ORDER=[0,1,2,3,4,5,6,7,9,8]


def write_view(folder, arrays):
    """Binary arrays for the VTK.wasm viewer: 'SFEAVIEW', a uint32 header
    length, a JSON header naming each little-endian array, then the arrays,
    each starting on an 8-byte boundary."""
    entries=[];blobs=[]
    for name,(dtype,data) in arrays.items():
        data=np.ascontiguousarray(data,dtype='<'+dtype)
        entries.append({'name':name,'type':{'f8':'float64','i4':'int32'}[dtype],'shape':list(data.shape)})
        blobs.append(data.tobytes())
    header=json.dumps({'version':1,'arrays':entries}).encode()
    header+=b' '*(-(12+len(header))%8)
    with open(folder/'view.bin.tmp','wb') as out:
        out.write(b'SFEAVIEW'+np.uint32(len(header)).tobytes()+header)
        for blob in blobs: out.write(blob+b'\0'*(-len(blob)%8))
    os.replace(folder/'view.bin.tmp',folder/'view.bin')


def mesh_view(mesh):
    """Points, VTK-ordered quadratic tetrahedra with their body, and
    boundary triangles tagged with their CAD face. Indices refer to the
    surface node order."""
    surface=mesh['surface']
    tags=np.asarray(surface['nodeIds'])
    index=np.full(tags.max()+1,-1,np.int32);index[tags]=np.arange(len(tags))
    tets=index[np.asarray(mesh['elements'])][:,TET10_ORDER]
    triangles=np.concatenate([np.asarray(f['indices'],np.int32) for f in surface['faces']])
    faces=np.concatenate([np.full(len(f['indices'])//3,f['id'],np.int32) for f in surface['faces']])
    owner={e:int(b) for b,es in (mesh.get('bodies') or {}).items() for e in es}
    bodies=np.array([owner.get(e,0) for e in mesh['elementIds']],np.int32)
    return {'nodeIds':('i4',surface['nodeIds']),'points':('f8',np.asarray(surface['positions']).reshape(-1,3)),
            'tets':('i4',tets),'tetBodies':('i4',bodies),'triangles':('i4',triangles.reshape(-1,3)),'triangleFaces':('i4',faces)}


def mesh_info(mesh):
    return {k:mesh[k] for k in ['size','nodeCount','elementCount','minQuality']}


def import_part(folder):
    emit('importing', 'Reading STEP geometry')
    solids = initialize(folder / 'part.step')
    bbox = gmsh.model.getBoundingBox(-1, -1)
    dims = [bbox[i+3]-bbox[i] for i in range(3)]
    # A starting element size: the thinnest body's smallest extent over 2.5,
    # but no finer than 1/60 of the whole. One body: its bounding box.
    thinnest = min(min(b[i+3]-b[i] for i in range(3)) for b in (gmsh.model.getBoundingBox(*s) for s in solids))
    default = max(thinnest / 2.5, max(dims) / 60)
    preview_settings(dims)
    gmsh.model.mesh.generate(2)
    geometry = surface_data()
    adjacency = topology()
    body_list, components = bodies(solids, adjacency)
    geometry.update({'bodies': body_list, 'components': components, 'interfaces': interfaces(adjacency),
                     'bounds': list(bbox), 'dimensions': dims, 'volume': sum(b['volume'] for b in body_list),
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
    bolts = (study.get('bolts') or []) if contact_on(study) else []
    return mesh_model(folder, size, relabel=cut_bolts(bolts) if bolts else None)


def contact_on(study):
    """Contact and bolts apply to static studies that turn them on."""
    return (study.get('analysis') or 'static') == 'static' and study.get('contact') is True


def cylinder_of(faces):
    """Axis point, unit axis, radius and axial extent (lowest and highest
    position along the axis from the point) of cylindrical CAD faces, from
    points sampled on them."""
    points=[];normals=[]
    for tag in faces:
        if gmsh.model.getType(2, tag) != 'Cylinder':
            raise ValueError('Select the bolt’s shank: a cylindrical face.')
        lo, hi = gmsh.model.getParametrizationBounds(2, tag)
        grid = np.array([[a, b] for a in np.linspace(lo[0], hi[0], 13) for b in np.linspace(lo[1], hi[1], 5)]).flatten()
        points.append(np.asarray(gmsh.model.getValue(2, tag, grid)).reshape(-1, 3))
        normals.append(np.asarray(gmsh.model.getNormal(tag, grid)).reshape(-1, 3))
    points=np.vstack(points);normals=np.vstack(normals)
    values, vectors = np.linalg.eigh(normals.T @ normals)
    axis = vectors[:, 0]
    if values[0] > 1e-6 * values[2]:
        raise ValueError('The bolt’s shank faces must share one axis.')
    A = np.zeros((3, 3)); b = np.zeros(3)
    for x, n in zip(points, normals):
        P = np.eye(3) - np.outer(n, n) - np.outer(axis, axis)
        A += P; b += P @ x
    A += len(points) * np.outer(axis, axis); b += np.outer(axis, axis) @ points.sum(0)
    point = np.linalg.solve(A, b)
    along = (points - point) @ axis
    radial = np.linalg.norm((points - point) - np.outer(along, axis), axis=1)
    return point, axis, float(radial.mean()), float(along.min()), float(along.max())


def point_on(tag):
    """A point inside a (trimmed) face, from a grid over its parameters."""
    lo, hi = gmsh.model.getParametrizationBounds(2, tag)
    for a in np.linspace(.5, .05, 10):
        for u in (lo[0] + a * (hi[0] - lo[0]), hi[0] - a * (hi[0] - lo[0])):
            for v in (lo[1] + a * (hi[1] - lo[1]), hi[1] - a * (hi[1] - lo[1])):
                x = np.asarray(gmsh.model.getValue(2, tag, [u, v]))
                if gmsh.model.isInside(2, tag, x): return x
    return np.asarray(gmsh.model.occ.getCenterOfMass(2, tag))


def cut_bolts(bolts):
    """Cuts each bolt across its shank, halfway along the selected shank
    faces, so the mesh has a pretension section there. The cut renumbers the
    bolt's faces and splits its volume; returns how to name them as before:
    {'faces': {new tag: original}, 'volumes': {new: original}, 'cuts':
    {bolt id: (section face, volume on its far side)}}."""
    o = gmsh.model.occ
    faces = {}; volumes = {}; cuts = {}
    for bolt in bolts:
        selected = [int(f) for f in bolt['faces']]
        owners = {int(v) for f in selected for v in gmsh.model.getAdjacencies(2, f)[0]}
        if len(owners) != 1:
            raise ValueError(f"The shank faces of “{bolt.get('name','a bolt')}” must belong to one body, the bolt.")
        body = owners.pop()
        point, axis, radius, lo, hi = cylinder_of(selected)
        center = point + axis * (lo + hi) / 2
        # The bolt's cross section there: a large disk trimmed to the body.
        disk = o.addDisk(*center, 3 * radius, 3 * radius, zAxis=axis.tolist())
        section, _ = o.intersect([(2, disk)], [(3, body)], removeTool=False)
        # Copies of the bolt's faces, to recognize them after the cut.
        boundary = [t for _, t in gmsh.model.getBoundary([(3, body)], oriented=False)]
        copies = {c[1]: f for f, c in zip(boundary, o.copy([(2, f) for f in boundary]))}
        others = [v for v in gmsh.model.getEntities(3)]
        _, pieces = o.fragment(others, section)
        o.synchronize()
        halves = [t for _, t in pieces[others.index((3, body))]]
        if len(halves) != 2:
            raise ValueError(f"“{bolt.get('name','A bolt')}” could not be cut across its shank. Select the plain shank between the head and the nut.")
        original = volumes.get(body, body)
        for h in halves: volumes[h] = original
        # Name every face of the cut bolt after the face it lies on.
        known = set(faces) | set(boundary)
        new_section = [t for t in set(t for _, t in gmsh.model.getBoundary([(3, halves[0])], oriented=False))
                       & set(t for _, t in gmsh.model.getBoundary([(3, halves[1])], oriented=False))]
        if len(new_section) != 1:
            raise ValueError(f"“{bolt.get('name','A bolt')}” could not be cut across its shank. Select the plain shank between the head and the nut.")
        for h in halves:
            for _, t in gmsh.model.getBoundary([(3, h)], oriented=False):
                if t == new_section[0] or t in faces: continue
                closest = point_on(t)
                # Closest points ignore trimming, so coplanar faces also
                # need the point inside the face.
                match = [copies[c] for c in copies
                         if gmsh.model.getType(2, c) == gmsh.model.getType(2, t)
                         and np.linalg.norm(gmsh.model.getClosestPoint(2, c, closest)[0] - closest) < 1e-6 * max(radius, 1)
                         and gmsh.model.isInside(2, c, closest)]
                if match: faces[t] = faces.get(match[0], match[0])
        o.remove([(2, c) for c in copies], recursive=True)
        o.synchronize()
        cuts[str(bolt['id'])] = (new_section[0], halves[1])
    return {'faces': faces, 'volumes': volumes, 'cuts': cuts}


def mesh_model(folder, size, finalize=True, relabel=None):
    """Meshes the solids loaded in the current Gmsh model with quadratic
    tetrahedra and writes mesh.json, view.bin and part.msh to folder.
    `relabel` (from cut_bolts) names cut faces and volumes as before the
    cut."""
    size_settings(size)
    gmsh.model.mesh.generate(3)
    gmsh.model.mesh.setOrder(2)
    gmsh.model.mesh.optimize('HighOrder')
    types = list(gmsh.model.mesh.getElementTypes(3))
    if types != [11]:
        raise ValueError('This part did not produce a quadratic tetrahedral mesh.')
    tags, conn = gmsh.model.mesh.getElementsByType(11)
    conn = np.asarray(conn).reshape(-1, 10)
    relabel = relabel or {'faces': {}, 'volumes': {}, 'cuts': {}}
    face_of = lambda t: relabel['faces'].get(t, t)
    volume_of = lambda v: relabel['volumes'].get(v, v)
    section = {t: bolt for bolt, (t, _) in relabel['cuts'].items()}
    surface = surface_data(True)
    # Pieces of a cut face show as the face they came from.
    merged = {}
    for f in surface['faces']:
        tag = face_of(f['id'])
        if tag in merged: merged[tag]['indices'] += f['indices']
        else: merged[tag] = {**f, 'id': tag, 'name': f'Face {tag}', 'body': volume_of(f['body'])}
    surface['faces'] = list(merged.values())
    faces = {};shared = {};cuts = {}
    adjacency = {t: sorted({volume_of(v) for v in vs}) if t not in section else vs for t, vs in topology().items()}
    for _, tag in gmsh.model.getEntities(2):
        nt, _, _ = gmsh.model.mesh.getNodes(2, tag, includeBoundary=True)
        _, tn = gmsh.model.mesh.getElementsByType(9, tag)
        face = {'nodes': [int(n) for n in nt], 'triangles': np.asarray(tn).reshape(-1,6).tolist()}
        # Outer faces carry conditions; faces between two bodies can carry
        # contact; a bolt's section carries its pretension.
        if tag in section:
            far = relabel['cuts'][section[tag]][1]
            cuts[section[tag]] = {**face, 'far': [int(e) for e in gmsh.model.mesh.getElements(3, far)[1][0]]}
        elif len(adjacency[tag]) == 1:
            key = str(face_of(tag))
            if key in faces:
                faces[key]['nodes'] = sorted(set(faces[key]['nodes']) | set(face['nodes']))
                faces[key]['triangles'] += face['triangles']
            else: faces[key] = {**face, 'body': adjacency[tag][0]}
        else: shared[str(tag)] = {**face, 'bodies': adjacency[tag]}
    quality = np.asarray(gmsh.model.mesh.getElementQualities(tags, 'minSICN'))
    elements = {}
    for _, v in gmsh.model.getEntities(3):
        elements.setdefault(str(volume_of(v)), []).extend(int(e) for e in gmsh.model.mesh.getElements(3, v)[1][0])
    components = groups([int(v) for v in elements], {t: vs for t, vs in adjacency.items() if t not in section})
    mesh = {'bodies': elements, 'components': components, 'interfaces': shared, 'cuts': cuts,
            'surface': surface, 'elementIds': [int(t) for t in tags], 'elements': conn.tolist(),
            'faces': faces, 'size': size, 'nodeCount': len(surface['nodeIds']), 'elementCount': len(tags),
            'minQuality': float(quality.min())}
    if mesh['minQuality'] <= 0:
        raise ValueError('The mesh contains inverted elements. Try another mesh size or repair tiny CAD features.')
    (folder/'mesh.json').write_text(json.dumps(mesh))
    write_view(folder,mesh_view(mesh))
    gmsh.write(str(folder/'part.msh'))
    if finalize: gmsh.finalize()
    return mesh
