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
    group = {b['id']: b['id'] for b in out}
    def root(b):
        while group[b] != b: b = group[b]
        return b
    for volumes in adjacency.values():
        if len(volumes) == 2: group[root(volumes[0])] = root(volumes[1])
    components = {}
    for b in out: components.setdefault(root(b['id']), []).append(b['id'])
    return out, sorted(components.values())


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
        faces.append({'anchor':closest.tolist(),'normal':normal.tolist(),'id': tag, 'name': f'Face {tag}', 'type': gmsh.model.getType(2, tag),
                      'body': adjacency[tag][0],
                      'area': gmsh.model.occ.getMass(2, tag), 'center': list(gmsh.model.occ.getCenterOfMass(2, tag)), 'indices': tris})
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
    """Points, VTK-ordered quadratic tetrahedra and boundary triangles tagged
    with their CAD face. Indices refer to the surface node order."""
    surface=mesh['surface']
    tags=np.asarray(surface['nodeIds'])
    index=np.full(tags.max()+1,-1,np.int32);index[tags]=np.arange(len(tags))
    tets=index[np.asarray(mesh['elements'])][:,TET10_ORDER]
    triangles=np.concatenate([np.asarray(f['indices'],np.int32) for f in surface['faces']])
    faces=np.concatenate([np.full(len(f['indices'])//3,f['id'],np.int32) for f in surface['faces']])
    return {'nodeIds':('i4',surface['nodeIds']),'points':('f8',np.asarray(surface['positions']).reshape(-1,3)),
            'tets':('i4',tets),'triangles':('i4',triangles.reshape(-1,3)),'triangleFaces':('i4',faces)}


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
    body_list, components = bodies(solids, topology())
    geometry.update({'bodies': body_list, 'components': components,
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
    return mesh_model(folder, size)


def mesh_model(folder, size, finalize=True):
    """Meshes the solids loaded in the current Gmsh model with quadratic
    tetrahedra and writes mesh.json, view.bin and part.msh to folder."""
    size_settings(size)
    gmsh.model.mesh.generate(3)
    gmsh.model.mesh.setOrder(2)
    gmsh.model.mesh.optimize('HighOrder')
    types = list(gmsh.model.mesh.getElementTypes(3))
    if types != [11]:
        raise ValueError('This part did not produce a quadratic tetrahedral mesh.')
    tags, conn = gmsh.model.mesh.getElementsByType(11)
    conn = np.asarray(conn).reshape(-1, 10)
    surface = surface_data(True)
    faces = {}
    adjacency = topology()
    for _, tag in gmsh.model.getEntities(2):
        if len(adjacency[tag]) != 1: continue
        nt, _, _ = gmsh.model.mesh.getNodes(2, tag, includeBoundary=True)
        _, tn = gmsh.model.mesh.getElementsByType(9, tag)
        faces[str(tag)] = {'nodes': [int(n) for n in nt], 'triangles': np.asarray(tn).reshape(-1,6).tolist()}
    quality = np.asarray(gmsh.model.mesh.getElementQualities(tags, 'minSICN'))
    solids = gmsh.model.getEntities(3)
    elements = {str(v): [int(e) for e in gmsh.model.mesh.getElements(3, v)[1][0]] for _, v in solids}
    body_list, components = bodies(solids, adjacency)
    mesh = {'bodies': elements, 'components': components,
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
