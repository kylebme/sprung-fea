"""Contact between bodies of an assembly, and bolt pretension.

Touching bodies share nodes where they meet, which bonds them. A contact
gives the two sides of an interface their own nodes, so they can separate
and slide; CalculiX then enforces contact between the two sides' element
faces."""
import numpy as np
from calculix import equation_lines


class Split:
    """The mesh with interfaces separated. `mesh` is a copy whose elements,
    faces and surface use the new nodes; `sides` maps each separated
    interface face to {body: triangles} for both sides; `copies` maps a new
    node to the node it copies."""
    def __init__(self, mesh, sides, copies):
        self.mesh=mesh;self.sides=sides;self.copies=copies


def body_of_elements(mesh):
    return {e:int(b) for b,es in mesh['bodies'].items() for e in es}


def separate(mesh, faces):
    """Gives the bodies on either side of the interface `faces` their own
    nodes there. At a node, bodies stay joined (share the node) only through
    interfaces that remain bonded."""
    faces=[str(f) for f in faces]
    shared=mesh.get('interfaces') or {}
    on=set(n for f in faces for n in shared[f]['nodes'])
    owner=body_of_elements(mesh)
    # Bodies meeting at each node on a separated face.
    present={n:set() for n in on}
    for e,c in zip(mesh['elementIds'],mesh['elements']):
        for n in c:
            if n in present: present[n].add(owner[e])
    # Union bodies joined at a node by a bonded interface through it.
    parent={(n,b):(n,b) for n,bs in present.items() for b in bs}
    def root(k):
        while parent[k]!=k: k=parent[k]
        return k
    for f,data in shared.items():
        if f in faces: continue
        a,b=data['bodies']
        for n in data['nodes']:
            if n in present and a in present[n] and b in present[n]: parent[root((n,a))]=root((n,b))
    # One node per group of joined bodies: the group with the lowest body
    # keeps the original.
    nodes=mesh['surface']['nodeIds'];positions=np.asarray(mesh['surface']['positions']).reshape(-1,3)
    index={n:i for i,n in enumerate(nodes)}
    next_id=max(nodes)+1;renamed={};copies={};extra=[]
    for n in sorted(present):
        groups={}
        for b in sorted(present[n]): groups.setdefault(root((n,b)),[]).append(b)
        for k,(_,bs) in enumerate(sorted(groups.items(),key=lambda g:min(g[1]))):
            if k==0: continue
            for b in bs: renamed[(n,b)]=next_id
            copies[next_id]=n;extra.append(positions[index[n]]);next_id+=1
    rename=lambda n,b:renamed.get((n,b),n)
    out={**mesh}
    out['elements']=[[rename(n,owner[e]) for n in c] for e,c in zip(mesh['elementIds'],mesh['elements'])]
    out['faces']={f:{**d,'nodes':sorted({rename(n,d['body']) for n in d['nodes']}),
                     'triangles':[[rename(n,d['body']) for n in t] for t in d['triangles']]}
                  for f,d in mesh['faces'].items()}
    sides={}
    for f in faces:
        d=shared[f]
        sides[f]={b:[[rename(n,b) for n in t] for t in d['triangles']] for b in d['bodies']}
    # Bonded interfaces keep one set of nodes: their first body's.
    out['interfaces']={f:{**d,'nodes':sorted({rename(n,d['bodies'][0]) for n in d['nodes']}),
                          'triangles':[[rename(n,d['bodies'][0]) for n in t] for t in d['triangles']]}
                       for f,d in shared.items() if f not in faces}
    # The viewer's surface: copies appended; outer triangles of each body
    # point at that body's nodes.
    new_ids=list(nodes)+sorted(copies)
    new_index={n:i for i,n in enumerate(new_ids)}
    surface={**mesh['surface'],'nodeIds':new_ids,
             'positions':np.vstack([positions,np.asarray(extra).reshape(-1,3)]).flatten().tolist()}
    surface['faces']=[{**f,'indices':[new_index[rename(nodes[i],f['body'])] for i in f['indices']]} for f in mesh['surface']['faces']]
    out['surface']=surface
    out['nodeCount']=len(new_ids)
    return Split(out,sides,copies)


def element_faces(mesh, body):
    """CalculiX face numbers of one body's tetrahedra by sorted corners."""
    tet_faces=[(0,1,2),(0,3,1),(1,3,2),(2,3,0)]
    elements=set(mesh['bodies'][str(body)])
    out={}
    for eid,c in zip(mesh['elementIds'],mesh['elements']):
        if eid not in elements: continue
        for num,ids in enumerate(tet_faces,1): out[tuple(sorted(c[i] for i in ids))]=(eid,num)
    return out


def surface_lines(name, mesh, body, triangles):
    lookup=element_faces(mesh,body)
    lines=[f'*SURFACE, NAME={name}, TYPE=ELEMENT']
    for t in triangles:
        eid,face=lookup[tuple(sorted(t[:3]))]
        lines.append(f'{eid}, S{face}')
    return lines


def section_plane(mesh, cut):
    """Point on a bolt's section and its unit normal toward the far half."""
    index={n:i for i,n in enumerate(mesh['surface']['nodeIds'])}
    xyz=np.asarray(mesh['surface']['positions']).reshape(-1,3)
    points=xyz[[index[n] for n in cut['nodes']]]
    center=points.mean(0)
    normal=np.linalg.svd(points-center)[2][2]
    far=set(cut['far'])
    inside=np.mean([xyz[[index[n] for n in c[:4]]].mean(0) for e,c in zip(mesh['elementIds'],mesh['elements']) if e in far],axis=0)
    return center,(normal if np.dot(inside-center,normal)>0 else -normal)


def open_cut(mesh, cut):
    """Gives the far half of a cut bolt its own nodes on the section.
    Returns (mesh, {node: its copy}, section normal toward the far half)."""
    on=set(cut['nodes']);far=set(cut['far'])
    center,normal=section_plane(mesh,cut)
    nodes=mesh['surface']['nodeIds'];positions=np.asarray(mesh['surface']['positions']).reshape(-1,3)
    index={n:i for i,n in enumerate(nodes)}
    start=max(nodes)+1
    pairs={n:start+k for k,n in enumerate(sorted(on))}
    beyond=lambda points:np.dot(np.mean(points,axis=0)-center,normal)>0
    out={**mesh}
    out['elements']=[[pairs.get(n,n) for n in c] if e in far else c for e,c in zip(mesh['elementIds'],mesh['elements'])]
    # Outer triangles touching the section belong to the half they lie in.
    def triangle(t):
        if not on.intersection(t) or not beyond(positions[[index[n] for n in t]]): return t
        return [pairs.get(n,n) for n in t]
    out['faces']={}
    for f,d in mesh['faces'].items():
        tris=[triangle(t) for t in d['triangles']]
        out['faces'][f]={**d,'triangles':tris,'nodes':sorted({n for t in tris for n in t})}
    new_ids=list(nodes)+[pairs[n] for n in sorted(on)]
    new_index={n:i for i,n in enumerate(new_ids)}
    surface={**mesh['surface'],'nodeIds':new_ids,
             'positions':np.vstack([positions,positions[[index[n] for n in sorted(on)]]]).flatten().tolist()}
    faces=[]
    for f in mesh['surface']['faces']:
        idx=list(f['indices'])
        for k in range(0,len(idx),3):
            idx[k:k+3]=[new_index[n] for n in triangle([nodes[i] for i in idx[k:k+3]])]
        faces.append({**f,'indices':idx})
    surface['faces']=faces
    out['surface']=surface;out['nodeCount']=len(new_ids)
    return out,pairs,normal


# ---- Study settings ----

KINDS=('bonded','frictional','frictionless')
# Normal penalty stiffness: K = STIFFNESS × E / h for the softer body's
# modulus E and the element size h, so penetration relative to an element
# is about p / (STIFFNESS × E). The stick slope is K / 100, as the CalculiX
# manual advises (and as its defaults, 50 E and E / 2, imply).
STIFFNESS=20.
STICK=.01
# Face-to-face contact converges when the number of contact elements
# changes by less than this share between iterations. Surfaces that touch
# at zero pressure flip on and off at round-off level; CalculiX's default,
# 0.1%, then never converges.
DELCON=.05
# Weak springs across each contact, between each node and its copy on the
# other side, as a fraction of E × h: they keep bodies that only contact
# holds from drifting before the contact closes, without resisting how the
# part deflects as a whole. Their total force is reported.
SPRING=1e-8


def contact_on(study):
    return (study.get('analysis') or 'static')=='static' and study.get('contact') is True


def pairs_of(mesh):
    """{pair id: (bodies, interface faces)} of touching body pairs."""
    out={}
    for f,d in (mesh.get('interfaces') or {}).items():
        a,b=sorted(int(x) for x in d['bodies'])
        out.setdefault(f'{a}-{b}',((a,b),[]))[1].append(f)
    return out


def contacts_of(study, mesh):
    """[(pair id, bodies, faces, kind, friction)] for pairs that are not
    bonded."""
    if not contact_on(study): return []
    pairs=pairs_of(mesh);out=[]
    for c in study.get('contacts') or []:
        kind=c.get('kind')
        if kind not in KINDS: raise ValueError('Choose bonded, frictional or frictionless contact.')
        if c.get('id') not in pairs: raise ValueError('A contact refers to bodies that do not touch. Import the part again.')
        if kind=='bonded': continue
        mu=None
        if kind=='frictional':
            mu=float(c.get('friction',.2))
            if not 0<mu<=2: raise ValueError('The friction coefficient must lie between 0 and 2.')
        bodies,faces=pairs[c['id']]
        out.append((c['id'],bodies,faces,kind,mu))
    return out


def bolts_of(study):
    if not contact_on(study): return []
    bolts=study.get('bolts') or []
    for b in bolts:
        if not b.get('faces'): raise ValueError(f"Select the shank of “{b.get('name','a bolt')}”.")
        preload=float(b.get('preload',0))
        if not np.isfinite(preload) or preload<=0:
            raise ValueError(f"Enter the preload of “{b.get('name','a bolt')}” as a positive force.")
    return bolts


class Setup:
    """A static study's contacts and bolts applied to its mesh: the
    separated mesh, contact pairs with both sides' triangles, and bolts
    with their section node pairs and normal."""
    def __init__(self, study, mesh):
        self.contacts=contacts_of(study,mesh)
        self.bolts=bolts_of(study)
        factor=study.get('contactStiffness')
        self.stiffness=1. if factor is None else float(factor)
        if not np.isfinite(self.stiffness) or self.stiffness<=0:
            raise ValueError('The contact stiffness factor must be a positive number.')
        self.original=mesh
        faces=[f for _,_,fs,_,_ in self.contacts for f in fs]
        split=separate(mesh,faces) if faces else Split(mesh,{},{})
        mesh=split.mesh;self.sides=split.sides;self.copies=split.copies
        self.sections=[]
        for b in self.bolts:
            cut=(mesh.get('cuts') or {}).get(str(b['id']))
            if not cut: raise ValueError(f"“{b.get('name','A bolt')}” could not be cut across its shank. Mesh again.")
            mesh,pairs,normal=open_cut(mesh,cut)
            self.sections.append((b,pairs,normal))
        self.mesh=mesh

    def __bool__(self):
        return bool(self.contacts or self.bolts)

    def model_lines(self, model, study, held, numbers):
        """Model lines: bolt reference nodes and section equations, the
        contact surfaces, interactions and pairs, and the stabilizing
        springs. `numbers` formats reals for the deck. Sets self.refs (bolt
        reference nodes) and self.springs ({node: stiffness})."""
        mesh=self.mesh;lines=[]
        moduli={int(b):float(m['young']) for bodies,m,_ in model.materials(study) for b in bodies}
        size=float(mesh['size'])
        # Bolts: the far side follows the near side shortened by the
        # reference node's first DOF along the normal, so a positive force
        # there is tension in the bolt.
        node=max(model.ids);self.refs=[]
        equations=[]
        for b,pairs,normal in self.sections:
            node+=1;self.refs.append(node)
            lines+=['*NODE',f'{node}, 0, 0, 0']
            for near,far in sorted(pairs.items()):
                for k in range(3):
                    terms=[(far,k+1,1.0),(near,k+1,-1.0)]
                    if abs(normal[k])>1e-12: terms.append((node,1,float(normal[k])))
                    equations.append(terms)
        if self.refs:
            lines+=equation_lines(equations)
            lines+=['*NSET, NSET=BOLTS']+[str(n) for n in self.refs]
            lines+=['*BOUNDARY']+[f'{n}, 2, 3, 0' for n in self.refs]
        # Contact: one interaction per pair, as friction differs.
        for k,(pid,(a,b),faces,kind,mu) in enumerate(self.contacts,1):
            E=min(moduli[a],moduli[b])
            K=self.stiffness*STIFFNESS*E/size
            # The higher-numbered body's side is the slave, where CalculiX
            # stores contact pressure.
            lines+=surface_lines(f'CS{k}',mesh,b,[t for f in faces for t in self.sides[f][b]])
            lines+=surface_lines(f'CM{k}',mesh,a,[t for f in faces for t in self.sides[f][a]])
            lines+=[f'*SURFACE INTERACTION, NAME=CI{k}','*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=LINEAR',numbers(K)]
            if kind=='frictional': lines+=['*FRICTION',f'{numbers(mu)}, {numbers(STICK*K)}']
            lines+=[f'*CONTACT PAIR, INTERACTION=CI{k}, TYPE=SURFACE TO SURFACE',f'CS{k}, CM{k}']
        # Springs across contacts: SPRING2 elements joining a node and its
        # copy in each direction.
        self.springs=sorted((n,c) for c,n in self.copies.items())
        self.spring=SPRING*min(moduli.values())*size
        if self.springs:
            eid=max(mesh['elementIds'])
            for d in range(3):
                lines+=[f'*ELEMENT, TYPE=SPRING2, ELSET=STEADY{d+1}']
                for n,c in self.springs:
                    eid+=1;lines.append(f'{eid}, {n}, {c}')
                # CalculiX tells the spring constant from the DOF line by
                # its decimal point.
                lines+=[f'*SPRING, ELSET=STEADY{d+1}',f'{d+1}, {d+1}',f'{self.spring:.6e}']
        if self.contacts: lines+=['*CONTROLS, PARAMETERS=CONTACT',numbers(DELCON)]
        return lines

    def contact_forces(self, dat, time, frame, model):
        """Per contact at a step time: the force on the slave (higher
        numbered) body, as CalculiX totals it from its integration points
        (normal force, compression positive, and shear force), the area in
        contact as a share of the interface, and the peak pressure at slave
        nodes."""
        from model import triangle_weights
        totals=contact_totals(dat,time)
        stresses=frame['fields'].get('CONTACT',{})
        index={n:i for i,n in enumerate(model.ids)}
        out=[]
        for k,(pid,(a,b),faces,kind,mu) in enumerate(self.contacts,1):
            triangles=[t for f in faces for t in self.sides[f][b]]
            area=sum(float(triangle_weights(model.coords[[index[n] for n in t]]).sum()) for t in triangles)
            touching,normal,shear=totals.get(k,(0.,0.,0.))
            peak=max((stresses.get(n,[0]*6)[3] for t in triangles for n in t),default=0.)
            share=min(1.,touching/area) if area else 0.
            # Open: hardly any area pressed. Frictional contact slides once
            # its shear reaches the friction limit.
            state=('open' if share<.01 or -normal<=0 else
                   'pressed' if kind=='frictionless' else
                   'sliding' if shear>=.98*mu*(-normal) else 'stuck')
            out.append({'id':pid,'bodies':[a,b],'kind':kind,'normal':-normal,'shear':shear,'peak':float(peak),
                        'touching':share,'state':state})
        return out

    def spring_force(self, frame):
        """Total size of the forces the steadying springs carry, N."""
        disp=frame['fields'].get('DISP',{})
        return float(sum(self.spring*np.linalg.norm(np.subtract(disp.get(c,[0,0,0])[:3],disp.get(n,[0,0,0])[:3]))
                         for n,c in self.springs))


def bolt_forces(dat, refs):
    """{time: [force of each bolt]} from the BOLTS node print of a .dat
    file: the pretension force while tightening, the bolt's force once
    locked."""
    out={};lines=dat.splitlines();k=0
    while k<len(lines):
        line=lines[k]
        if 'for set BOLTS and time' in line:
            time=float(line.split()[-1]);values={}
            k+=1
            while k<len(lines) and (not lines[k].strip() or lines[k].split()[0].isdigit()):
                parts=lines[k].split()
                if parts: values[int(parts[0])]=float(parts[1])
                k+=1
            out[time]=[values.get(n,0.) for n in refs]
            continue
        k+=1
    return out


def contact_totals(dat, time):
    """{contact number: (area in contact, normal force (+ tension), shear
    force)} from the CF contact prints of a .dat file, at the printed time
    nearest `time`."""
    out={};best={};lines=dat.splitlines()
    for k,line in enumerate(lines):
        if 'statistics for slave set CS' not in line: continue
        number=int(line.split('slave set CS')[1].split(',')[0]);t=float(line.split()[-1])
        for j in range(k+1,min(k+20,len(lines))):
            if 'area,  normal force' in lines[j]:
                values=[float(v) for v in lines[j+2].split()]
                if number not in best or abs(t-time)<abs(best[number]-time):
                    best[number]=t;out[number]=tuple(values[:3])
                break
    return out
