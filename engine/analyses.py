"""Analysis types. Each one validates a study, writes its CalculiX step, and
turns the solver's frames into Sprung FEA's result schema.

Result schema (version 2), shared by every analysis:
  analysis    analysis type id
  frames      one entry per result frame (load step, mode, increment or
              frequency): {label, value, unit}
  fields      nodal arrays stored for every frame in view.bin
  summary     analysis-specific numbers; always includes `seconds`
  checks      rows for the Checks tab: {label, values, unit}
  charts      x–y series for plots: {id, title, x: {label, unit, values},
              series: [{label, unit, values}]}
  warnings    plain-language limits of this result
  keys        the few numbers that characterize it (peak displacement, a
              first frequency…): {id, label, unit, value, peak?}; mesh
              convergence follows these
  convergence optional mesh convergence history, see convergence.py
Frame k > 0 stores its arrays in view.bin as `name@k`."""
import json, math, time
import numpy as np
import calculix, contact
from cad import emit, threads, mesh_view, write_view
from model import Model, finite, validate, build_loads, validate_vibration, rbe3, fixed_dofs

SCHEMA=2


def von_mises(s):
    """Von Mises stress of one stress tensor (SXX, SYY, SZZ, SXY, SYZ, SZX),
    or of each row of an array of them."""
    s=np.asarray(s,float)
    xx,yy,zz,xy,yz,zx=(s[...,i] for i in range(6))
    return np.sqrt(np.maximum(0,((xx-yy)**2+(yy-zz)**2+(zz-xx)**2)/2+3*(xy*xy+yz*yz+zx*zx)))


def stress_fields(tensors):
    """Stress measures at each node from the averaged tensors (SXX, SYY,
    SZZ, SXY, SYZ, SZX): von Mises, the largest and smallest principal
    stress, and the largest shear stress (Tresca), (σ1 − σ3)/2."""
    t=np.asarray(tensors,float)[:,:6]
    xx,yy,zz,xy,yz,zx=t.T
    matrix=np.stack([np.stack([xx,xy,zx],-1),np.stack([xy,yy,yz],-1),np.stack([zx,yz,zz],-1)],-2)
    principal=np.linalg.eigvalsh(matrix)
    return {'vonMises':von_mises(t),'principalMax':principal[:,2],
            'principalMin':principal[:,0],'shear':(principal[:,2]-principal[:,0])/2}


def strain_fields(tensors):
    """Total strain measures in µm/m from CalculiX's strain tensors (EXX,
    EYY, EZZ, EXY, EYZ, EZX; shear as tensor components, ε = γ/2): the
    largest and smallest principal strain, and the von Mises equivalent
    strain √(2/3 e:e) of the deviatoric part e."""
    t=np.asarray(tensors,float)[:,:6]
    xx,yy,zz,xy,yz,zx=t.T
    matrix=np.stack([np.stack([xx,xy,zx],-1),np.stack([xy,yy,yz],-1),np.stack([zx,yz,zz],-1)],-2)
    principal=np.linalg.eigvalsh(matrix)
    dev=principal-principal.mean(axis=1,keepdims=True)
    return {'strain':np.sqrt(2/3*(dev**2).sum(1))*1e6,'strainMax':principal[:,2]*1e6,'strainMin':principal[:,0]*1e6}


def measures(frame, ids):
    """Stress and strain fields of a static-type frame."""
    out=stress_fields(nodal(frame,'STRESS',ids,6,'displacement and stress'))
    if frame['fields'].get('TOSTRAIN'):
        out.update(strain_fields(nodal(frame,'TOSTRAIN',ids,6,'strain')))
    return out


STRESS_FIELDS=['vonMises','principalMax','principalMin','shear','strain','strainMax','strainMin']


def nodal(frame, label, ids, count, what):
    """Values of one FRD field at the mesh's nodes, first `count` components."""
    data=frame['fields'].get(label)
    rows=data.at(ids) if data else None
    if rows is None or rows.shape[1]<count:
        raise ValueError(f'CalculiX did not produce complete {what} results. Inspect the solver log.')
    return rows[:,:count]


def mass_check(study, model):
    """Mass of the meshed part plus point masses, so density and units can be
    checked at a glance."""
    # Element volumes (mm³) × densities (tonne/mm³), in kg.
    part=float(np.dot(model.volumes(),model.densities(study)))*1e3
    extra=sum(float(m['mass']) for m in study.get('masses') or [])
    label='Mass, part + point masses' if extra else 'Mass'
    return {'label':label,'values':[part+extra],'unit':'kg','digits':4}


def static_checks(frame, held, loading, extra=np.zeros(3), floor=0.):
    """Support reactions and force balance. CalculiX's RF includes applied
    loads, so their equivalent nodal forces are subtracted at supported
    nodes; in a node's free directions the two cancel. Returns (check rows,
    reactions, applied resultant, balance). `extra` is a further external
    force (stabilizing springs) and `floor` a further scale for the balance
    (bolt preloads, which load the part without a resultant)."""
    reactions=np.zeros(3)
    forces=frame['fields'].get('FORC',{})
    held_nodes=held.nodes()
    for n in held_nodes:
        reactions+=np.asarray(forces.get(n,[0,0,0])[:3])-loading.applied.get(n,np.zeros(3))
    total=loading.total()
    # Resultants can cancel for pressure around a bore. Normalize by the
    # larger of the resultant and absolute equivalent nodal loading; a
    # purely thermal study has neither, and its reactions must cancel.
    scale=max(np.linalg.norm(total),sum(np.linalg.norm(v) for v in loading.applied.values()),floor)
    # Without applied loads (thermal stress alone) the reactions must cancel:
    # judge them against their own size, above a 1 µN floor of round-off.
    if scale<1e-9: scale=max(sum(np.abs(forces.get(n,[0,0,0])[:3]).sum() for n in held_nodes),1e-6)
    balance=float(np.linalg.norm(reactions+total+extra)/scale)
    checks=[{'label':'Applied force X, Y, Z','values':total.tolist(),'unit':'N'},
            {'label':'Reaction X, Y, Z','values':reactions.tolist(),'unit':'N'},
            {'label':'Force balance error','values':[balance*100],'unit':'%'}]
    return checks,reactions,total,balance


class Analysis:
    id=''
    name=''
    # Whether the study's equation-solver choice applies; other analyses
    # use the direct solver.
    study_solver=False

    def solver(self, study):
        """(deck keyword, description) of the equation solver this analysis uses."""
        return calculix.solver(study) if self.study_solver else calculix.direct_solver()

    def validate(self, study, mesh):
        calculix.solver_of(study)
        return validate(study, mesh)

    def deck(self, folder, study, mesh):
        """Writes analysis.inp and returns what results() needs."""
        raise NotImplementedError

    def results(self, folder, study, model, frames, context):
        """Returns (result, view frames)."""
        raise NotImplementedError

    def key_results(self, result):
        """The few numbers a mesh convergence study follows: {id, label,
        unit, value}, with `peak` set for local peaks that may not converge."""
        raise NotImplementedError


def plasticity(study):
    value=study.get('plasticity',False)
    if not isinstance(value,bool): raise ValueError('Plasticity must be on or off.')
    return value


def unloading(study):
    value=study.get('unload',False)
    if not isinstance(value,bool): raise ValueError('Unloading must be on or off.')
    return value


def check_plastic(m):
    """An elastic–plastic material needs a yield strength and a hardening
    curve beyond it: points of stress (MPa) and total strain (%) from a
    tensile test, or the ultimate strength at the elongation at break."""
    name=m.get('name','The material')
    if not m.get('yield'):
        raise ValueError(f'Enter the yield strength of {name} for plasticity.')
    if m.get('hardening'):
        points=m['hardening']
        if not isinstance(points,list) or any(not isinstance(p,(list,tuple)) or len(p)!=2 for p in points):
            raise ValueError(f'The stress–strain points of {name} are invalid.')
        for strain,stress in points:
            finite(strain,'Strain',True);finite(stress,'Stress',True)
        plastic=[p for _,p in hardening(m)]
        stresses=[m['yield']]+[s for _,s in points]
        if any(b<a for a,b in zip(stresses,stresses[1:])):
            raise ValueError(f'The stress–strain points of {name} must not fall below the yield strength or each other.')
        if not plastic[1]>0 or any(b<=a for a,b in zip(plastic[1:],plastic[2:])):
            raise ValueError(f'The stress–strain points of {name} need increasing strain beyond the elastic strain at their stress.')
        return
    if m.get('ultimate') is None or m.get('elongation') is None:
        raise ValueError(f'Enter the ultimate strength and elongation at break of {name} for plasticity.')
    if not m['ultimate']>m['yield']:
        raise ValueError(f'The ultimate strength of {name} must be above its yield strength.')
    if not m['elongation']/100>m['ultimate']/m['young']:
        raise ValueError(f'The elongation at break of {name} is smaller than its elastic strain at ultimate strength.')


def hardening(m):
    """(stress, plastic strain) points of isotropic hardening, starting at
    yield with no plastic strain: the material's stress–strain points
    (plastic strain = total strain − stress / E), or a straight line to the
    ultimate strength at the elongation at break. Flat beyond the last."""
    points=m.get('hardening') or [[m['elongation'],m['ultimate']]]
    return [(m['yield'],0.)]+[(stress,strain/100-stress/m['young']) for strain,stress in points]


def breaking_strain(m):
    """Plastic strain at which the material tears: at the elongation at
    break, or at the last stress–strain point."""
    return m['elongation']/100 if m.get('elongation') else hardening(m)[-1][1]


def plastic_lines(m):
    return ['*PLASTIC']+[f'{calculix.number(s)}, {calculix.number(e)}' for s,e in hardening(m)]


def large_deformation(study):
    value=study.get('largeDeformation',False)
    if not isinstance(value,bool):
        raise ValueError('Large deformation must be on or off.')
    return value


# Phases of a stepped static solve, one CalculiX step each.
PHASE_LABELS={'tighten':'Tightening','load':'Load','unload':'Unloading, load'}


def phase_of(time, phases):
    """(phase, fraction done) of a frame at total step time `time`."""
    k=min(len(phases)-1,max(0,math.ceil(time-1e-9)-1))
    return phases[k],time-k


class Static(Analysis):
    id='static'
    study_solver=True
    name='Linear static'

    def validate(self, study, mesh):
        calculix.solver_of(study)
        bolts=contact.bolts_of(study)
        if contact.contact_on(study):
            if not mesh.get('interfaces'):
                raise ValueError('Contact needs bodies that touch. This part has none: turn contact off.')
            contact.contacts_of(study,mesh)
        nodes,fixed=validate(study,mesh,require_loads=not bolts)
        if plasticity(study):
            for m in [study['material'],*(study.get('bodyMaterials') or {}).values()]: check_plastic(m)
        unloading(study)
        return nodes,fixed

    def deck(self, folder, study, mesh):
        self.validate(study, mesh)
        setup=contact.Setup(study,mesh)
        model=Model(setup.mesh)
        fixed=fixed_dofs(study['supports'],model)
        loading=build_loads(study, model)
        large=large_deformation(study);plastic=plasticity(study)
        stepped=large or plastic or bool(setup)
        phases=(['tighten'] if setup.bolts else [])+(['load'] if study['loads'] or not setup.bolts else [])
        if plastic and unloading(study) and 'load' in phases: phases.append('unload')
        title='static study'+(', large deformation' if large else '')+(', elastic–plastic' if plastic else '')+(', contact' if setup else '')
        lines=calculix.mesh_lines(model, title if stepped else 'linear static study')
        lines+=calculix.section_lines(model,study,plastic_lines if plastic else (lambda m:[]))
        lines+=calculix.boundary_lines(fixed)
        lines+=setup.model_lines(model,study,fixed,calculix.number)
        solver='*STATIC, SOLVER='+self.solver(study)[0]
        output=['*NODE FILE','U, RF','*EL FILE','S, E'+(', PEEQ' if plastic else ''),'*NODE PRINT, NSET=HELD, TOTALS=YES','RF']
        if setup.contacts:
            output+=['*CONTACT FILE','CDIS, CSTR']
            for k in range(1,len(setup.contacts)+1): output+=[f'*CONTACT PRINT, SLAVE=CS{k}, MASTER=CM{k}','CF']
        if setup.bolts: output+=['*NODE PRINT, NSET=BOLTS','RF']
        step='*STEP'+(', NLGEOM' if large else '')+', INC=200'
        # Automatic load steps: start at 10%, at most 25% (50% while only
        # bolts tighten), results at each.
        loads=calculix.load_lines(loading)
        for phase in phases:
            if not stepped:
                lines+=['*STEP',solver]+loads
            elif phase=='tighten':
                lines+=[step,solver,'0.25, 1.0, 1e-5, 1.0','*CLOAD']+[f'{n}, 1, {calculix.number(float(b["preload"]))}' for n,(b,_,_) in zip(setup.refs,setup.sections)]
            elif phase=='load':
                lines+=[step,solver,'0.2, 1.0, 1e-5, 0.5' if setup else '0.1, 1.0, 1e-5, 0.25']
                if setup.bolts:
                    # Bolts keep the length they were tightened to; their
                    # pretension force gives way to the loads.
                    lines+=['*BOUNDARY, FIXED']+[f'{n}, 1, 1' for n in setup.refs]
                    lines+=[l if l!='*CLOAD' else '*CLOAD, OP=NEW' for l in loads] if '*CLOAD' in loads else ['*CLOAD, OP=NEW']+loads
                else: lines+=loads
            else:
                # Removing every load: what stays is permanent.
                lines+=[step,solver,'0.25, 1.0, 1e-5, 0.5','*CLOAD, OP=NEW','*DLOAD, OP=NEW']
            lines+=output+['*END STEP']
        (folder/'analysis.inp').write_text('\n'.join(lines)+'\n')
        (folder/'applied.json').write_text(json.dumps({n:v.tolist() for n,v in loading.applied.items()}))
        return {'held':fixed,'loading':loading,'setup':setup,'phases':phases,'stepped':stepped,'mesh':setup.mesh}

    def results(self, folder, study, model, frames, context):
        large=large_deformation(study);plastic=plasticity(study)
        setup=context['setup'];phases=context['phases'];stepped=context['stepped']
        steps=frames if stepped else frames[-1:]
        ids=model.ids
        view=[]
        for f in steps:
            u=nodal(f,'DISP',ids,3,'displacement and stress')
            fields={'displacement':u,**measures(f,ids),'force':nodal(f,'FORC',ids,3,'nodal force')}
            # Averaging integration points to nodes can dip below zero.
            if plastic: fields['peeq']=np.maximum(0,nodal(f,'PE',ids,1,'plastic strain')[:,0])
            if setup.contacts:
                pressure=f['fields'].get('CONTACT',{})
                fields['contactPressure']=np.array([max(0.,pressure.get(n,[0,0,0,0])[3]) for n in ids])
            view.append(fields)
        kinds=[phase_of(f['value'],phases) if stepped else ('load',1.) for f in steps]
        # The fully loaded state: the last frame of the load (else the
        # tightening) phase.
        last=next(p for p in ('load','tighten') if p in phases)
        full=max(i for i,(p,_) in enumerate(kinds) if p==last)
        frame=steps[full]
        displacements=view[full]['displacement'];stress=view[full]['vonMises']
        movement=np.linalg.norm(displacements,axis=1)
        checks,reactions,total_load,balance=static_checks(frame,context['held'],context['loading'],
                                                          floor=sum(float(b['preload']) for b in setup.bolts))
        follower=large and any(l['kind'] in ('pressure','rotation') for l in study['loads'])
        if follower:
            # Pressure and rotation follow the deformed shape, so their
            # resultant is no longer the undeformed one checked against.
            checks=[c for c in checks if c['label']!='Force balance error']
        dims=np.ptp(model.coords,axis=0)
        max_stress=float(stress.max()); max_move=float(movement.max())
        yield_strength=study['material'].get('yield')
        warnings=['Peak stress at sharp corners or support edges may increase with refinement. Check a finer mesh before relying on a result.']
        if plastic:
            peeq=max(float(v['peeq'].max()) for v in view)
            curve=any(m.get('hardening') for m in [study['material'],*(study.get('bodyMaterials') or {}).values()])
            warnings.append(('Elastic–plastic material: stress beyond yield follows the stress–strain points, and stays flat beyond the last.' if curve else
                             'Elastic–plastic material: stress beyond yield follows a straight hardening line up to the ultimate strength at the elongation at break, and stays flat beyond it.')+
                            ' Unloading is elastic. Repeated loading and fatigue are not modeled.')
            if peeq==0: warnings.append('The part does not yield under these loads: the elastic result applies.')
            breaking=[m for m in [study['material'],*(study.get('bodyMaterials') or {}).values()] if peeq>breaking_strain(m)]
            if breaking: warnings.append('Plastic strain exceeds the elongation at break somewhere: the material would tear there.')
        elif yield_strength and max_stress>yield_strength:
            warnings.append('Stress exceeds the material yield strength. The elastic model cannot predict permanent deformation: turn on Plasticity in the Analysis settings.')
        if calculix.solver_of(study)!='direct' and balance>.005 and not follower:
            # CalculiX's incomplete-Cholesky solver occasionally stops early.
            warnings.append(f'The iterative solver stopped with a {balance*100:.2g}% force balance error. Use the direct solver for a tighter answer.')
        if large:
            warnings.append('Large deformation: stiffness follows the deformed shape, so results are not proportional to the loads.')
            if follower: warnings.append('Pressure follows the deformed surface and rotation the deformed shape, so their resultant changes with deformation: force balance is not checked.')
        elif max_move>.05*min(dims):
            warnings.append('Movement is large relative to the smallest part dimension, so the small-deformation assumption may not hold. Turn on Large deformation in the Analysis settings.')
        summary={'maxStress':max_stress,'maxMovement':max_move,
                 'minSafety':yield_strength/max_stress if yield_strength and max_stress else None,'reactions':reactions.tolist(),
                 'appliedForce':total_load.tolist(),'forceBalanceError':balance,
                 'stressNode':ids[int(np.argmax(stress))],'movementNode':ids[int(np.argmax(movement))]}
        if plastic:
            summary['maxPlastic']=peeq
            if 'unload' in phases:
                summary['permanentSet']=float(np.linalg.norm(view[-1]['displacement'],axis=1).max())
                checks.append({'label':'Permanent displacement after unloading','values':[summary['permanentSet']],'unit':'mm','digits':4})
            checks.append({'label':'Largest plastic strain','values':[peeq*100],'unit':'%','digits':3})
        charts=[]
        if stepped:
            labels=[]
            for i,(p,x) in enumerate(kinds):
                pct=100*(1-x if p=='unload' else x)
                text='Unloaded' if p=='unload' and i==len(kinds)-1 else f'{PHASE_LABELS[p]} {pct:.4g}%'
                labels.append({'label':text,'value':pct,'unit':'%'})
            peaks=[float(np.linalg.norm(v['displacement'],axis=1).max()) for v in view]
            # The load path: frames of loading and unloading, against load.
            path=[i for i,(p,_) in enumerate(kinds) if p!='tighten']
            if path:
                loads=[labels[i]['value'] for i in path]
                series=[{'label':'Elastic–plastic' if plastic and not large and not setup else 'Large deformation' if large and not plastic and not setup else 'Nonlinear',
                         'unit':'mm','values':[peaks[i] for i in path]}]
                if not setup.bolts:
                    # The straight line through the first load step: what a
                    # linear elastic analysis would predict.
                    series.append({'label':'Linear','unit':'mm','values':[peaks[path[0]]/loads[0]*x for x in loads]})
                charts.append({'id':'loadPath','title':'Load and displacement','frames':path,
                               'x':{'label':'Load','unit':'%','values':loads},'series':series})
        else:
            labels=[{'label':'Static load','value':None,'unit':''}]
        if setup:
            self.contact_results(folder,study,model,steps,view,kinds,full,context,summary,checks,warnings,charts)
        result={'frames':labels,'fields':['displacement',*STRESS_FIELDS]+(['peeq'] if plastic else [])+(['contactPressure'] if setup.contacts else []),
                'summary':summary,'warnings':warnings,'charts':charts,
                'checks':[mass_check(study,model)]+checks,
                'displacements':displacements.tolist(),'stress':stress.tolist(),'movement':movement.tolist()}
        if plastic: result['peeq']=view[full]['peeq'].tolist()
        return result,view

    def contact_results(self, folder, study, model, steps, view, kinds, full, context, summary, checks, warnings, charts):
        """Bolt forces, contact forces and the stabilizing springs' share."""
        setup=context['setup'];loading=context['loading'];held=context['held']
        geometry=json.loads((folder/'geometry.json').read_text()) if (folder/'geometry.json').exists() else {}
        names={b['id']:b['name'] for b in geometry.get('bodies') or []}
        names.update({int(k):names.get(int(k),f'Body {k}') for k in setup.mesh['bodies']})
        scale=max(np.linalg.norm(loading.total()),sum(np.linalg.norm(v) for v in loading.applied.values()),
                  sum(float(b['preload']) for b in setup.bolts),1e-9)
        if setup.contacts:
            contacts=setup.contact_forces(calculix.read_dat(folder/'analysis.dat'),steps[full]['value'],steps[full],model)
            summary['contacts']=contacts
            for c in contacts:
                pair=c['label']=' · '.join(names[b] for b in c['bodies'])
                checks.append({'label':f'Contact {pair}: normal, shear force','values':[c['normal'],c['shear']],'unit':'N'})
                checks.append({'label':f'Contact {pair}: peak pressure','values':[c['peak']],'unit':'MPa'})
                checks.append({'label':f'Contact {pair}: area in contact','values':[c['touching']*100],'unit':'%','digits':0})
            summary['maxContactPressure']=max(c['peak'] for c in contacts)
            sliding=[c['label'] for c in contacts if c['state']=='sliding']
            if sliding:
                warnings.append(f"Sliding: friction can no longer hold {', '.join(sliding)}; the shear there has reached the friction coefficient times the clamping force. Other paths, such as a bolt in bending, carry the rest.")
            warnings.append('Contact: touching bodies can separate'+(' and slide; friction holds them until the shear reaches the friction coefficient times the pressure. The friction coefficient is uncertain: check how a lower value changes the result.' if any(c[3]=='frictional' for c in setup.contacts) else ' and slide freely.'))
        if setup.springs:
            force=setup.spring_force(steps[full])
            checks.append({'label':'Steadying springs across contacts, total force','values':[force],'unit':'N','digits':4})
            if force>.01*scale:
                warnings.append(f'Contact alone does not hold some bodies in place: the weak springs that steady them carry {force:.3g} N, more than 1% of the loads. Add supports, or use friction or bonded contact where those bodies should be held.')
        if setup.bolts:
            dat=calculix.read_dat(folder/'analysis.dat')
            history=contact.bolt_forces(dat,setup.refs)
            times=sorted(history)
            at=lambda t:history[min(times,key=lambda s:abs(s-t))] if times else [0.]*len(setup.refs)
            tightened=at(1.)
            loaded=at(steps[full]['value'])
            bolts=[{'name':b['name'],'preload':float(b['preload']),'tightened':tightened[k],'loaded':loaded[k]} for k,(b,_,_) in enumerate(setup.sections)]
            summary['bolts']=bolts
            for b in bolts:
                checks.append({'label':f'{b["name"]}: force tightened, loaded','values':[b['tightened'],b['loaded']],'unit':'N'})
            warnings.append('Bolts are pulled to their preload, then hold that length while the loads act: a load that pulls the joint apart raises the bolt force a little and lowers the clamping force. Real preload from a tightening torque scatters by ±25% or more.')
            path=[i for i,(p,_) in enumerate(kinds) if p=='load']
            if path:
                # The joint's response: bolt force against load, from the
                # tightened state.
                start=max(i for i,(p,_) in enumerate(kinds) if p=='tighten')
                pts=[start]+path
                charts.append({'id':'boltForce','title':'Bolt force','frames':pts,
                               'x':{'label':'Load','unit':'%','values':[0.]+[100*kinds[i][1] for i in path]},
                               'series':[{'label':b['name'],'unit':'N','values':[at(steps[i]['value'])[k] for i in pts]} for k,b in enumerate(bolts)]})
            low=[b for b in bolts if b['loaded']<.05*b['tightened']]
            if low: warnings.append('A bolt has lost nearly all its force under the loads: the joint has opened.')

    def key_results(self, result):
        s=result['summary']
        keys=[{'id':'maxMovement','label':'Maximum displacement','unit':'mm','value':s['maxMovement']},
              {'id':'maxStress','label':'Peak stress','unit':'MPa','value':s['maxStress'],'peak':True}]
        if 'maxPlastic' in s and s['maxPlastic']>0:
            keys.append({'id':'maxPlastic','label':'Largest plastic strain','unit':'mm/mm','value':s['maxPlastic'],'peak':True})
        for k,b in enumerate(s.get('bolts') or []):
            keys.append({'id':f'bolt{k}','label':f"{b['name']} force",'unit':'N','value':b['loaded']})
        return keys


def modes_of(study, default=6):
    n=study.get('modes',default)
    if not isinstance(n,int) or not 1<=n<=50:
        raise ValueError('Ask for 1 to 50 modes.')
    return n


def normalized(displacement, stress=None):
    """A mode shape scaled to a peak displacement of 1 mm, with its stress
    scaled alike (MPa per mm of peak motion)."""
    peak=float(np.linalg.norm(displacement,axis=1).max()) or 1.
    return displacement/peak, None if stress is None else stress/peak


def preloaded(study):
    """Whether a vibration study includes its loads: the stress they cause
    stiffens the part (tension) or softens it (compression)."""
    value=study.get('preload',False)
    if not isinstance(value,bool): raise ValueError('Including loads must be on or off.')
    return value and bool(study.get('loads'))


class Frequency(Analysis):
    """Natural frequencies and mode shapes. Supports are optional: a part
    with none is analyzed free, and its first six modes are rigid motions
    at zero frequency. Point masses add inertia through RBE3 couplings.
    With `preload`, a static step under the loads comes first, and the
    modes include the stiffness of the stress it leaves (a perturbation
    step)."""
    id='frequency'
    name='Natural frequencies'

    def setup(self, study, mesh):
        """(model, blocked directions, free rigid motions)."""
        model,held,rigid=validate_vibration(study,mesh)
        modes_of(study)
        if preloaded(study):
            if rigid:
                raise ValueError('Including the loads needs supports that hold the part still. Add supports, or solve without the loads.')
            _,held=validate(study,mesh)
        return model,held,rigid

    def validate(self, study, mesh):
        model,held,_=self.setup(study,mesh)
        return model.nodes,held

    def deck(self, folder, study, mesh):
        model,held,rigid=self.setup(study,mesh)
        count=modes_of(study)
        masses=study.get('masses') or []
        preload=preloaded(study)
        lines=calculix.mesh_lines(model,'prestressed natural frequency study' if preload else 'natural frequency study')
        lines+=calculix.section_lines(model,study)
        if held: lines+=calculix.boundary_lines(held)
        lines+=calculix.mass_lines(model,masses,[rbe3(model,m['faces'],m['point']) for m in masses],held)
        direct=calculix.direct_solver()[0]
        if preload:
            # No output from the static step: every frame is a mode.
            lines+=['*STEP','*STATIC, SOLVER='+direct]+calculix.load_lines(build_loads(study,model))+['*END STEP',
                    '*STEP, PERTURBATION','*FREQUENCY, SOLVER='+direct,str(count)]
        else:
            # A free part needs a negative shift: its stiffness is singular.
            lines+=['*STEP','*FREQUENCY, SOLVER='+direct,f'{count+rigid}, -1' if rigid else str(count)]
        lines+=['*NODE FILE','U','*EL FILE','S','*END STEP']
        (folder/'analysis.inp').write_text('\n'.join(lines)+'\n')
        return {'rigid':rigid,'preload':preload}

    def results(self, folder, study, model, frames, context):
        ids=model.ids
        dat=calculix.read_dat(folder/'analysis.dat')
        eig=calculix.eigenvalues(dat)
        effective,total=calculix.modal_mass(dat)
        rigid=context['rigid'];preload=context['preload']
        if len(eig)<len(frames):
            raise ValueError('CalculiX did not report every natural frequency. Inspect the solver log.')
        view=[];info=[];frequencies=[];fractions=[];unstable=False
        for k,frame in enumerate(frames):
            shape,stress=normalized(nodal(frame,'DISP',ids,3,'mode shape'),
                                    von_mises(nodal(frame,'STRESS',ids,6,'mode shape')))
            value=eig[k][1]
            hz=max(0.,value[2]) if value[0]>0 else 0.
            unstable|=preload and value[0]<0
            is_rigid=k<rigid
            frequencies.append(hz)
            mass=[e/t if t else 0 for e,t in zip(effective[k],total)] if k<len(effective) and total else [0,0,0]
            fractions.append(mass)
            info.append({'label':'Rigid motion' if is_rigid else f'Mode {k+1-rigid}','value':hz,'unit':'Hz'})
            view.append({'displacement':shape,'vonMises':stress})
        elastic=[f for k,f in enumerate(frequencies) if k>=rigid]
        captured=np.sum(fractions[rigid:],axis=0) if elastic else np.zeros(3)
        if preload:
            warnings=['The loads are included: the stress they cause stiffens the part where it is in tension and softens it where it is in compression. The loads themselves are steady; only small vibrations about the loaded shape are found.']
            if any(l['kind']=='rotation' for l in study['loads']):
                warnings.append('Rotation stiffens the part through centrifugal stress. Spin softening and gyroscopic effects are not modeled, so frequencies of fast-spinning parts are approximate.')
            if unstable:
                warnings.append('A mode has negative stiffness: the loads exceed what the part can carry before buckling. Its frequency is shown as 0 Hz.')
        elif study.get('loads'):
            warnings=['Frequencies of the unloaded part: the loads were not included.']
        else:
            warnings=['Frequencies assume small vibrations about the unloaded shape.']
        if rigid:
            warnings.append(f'The part is free to move in {rigid} way{"s" if rigid>1 else ""}: the first {rigid} mode{"s are" if rigid>1 else " is a"} rigid motion{"s" if rigid>1 else ""} at about 0 Hz, listed separately.')
        summary={'frequencies':frequencies,'rigidModes':rigid,'effectiveMass':fractions,
                 'totalMass':total[0]*1e3 if total else None,'preloaded':preload}
        result={'frames':info,'fields':['displacement','vonMises'],'summary':summary,'warnings':warnings,'charts':[],
                'checks':[mass_check(study,model),
                          {'label':'Natural frequencies found','values':[len(elastic)],'unit':'','digits':0},
                          {'label':'Effective mass captured X, Y, Z','values':(captured*100).tolist(),'unit':'%','digits':1}],
                'solverNote':'eigen'}
        return result,view

    def key_results(self, result):
        s=result['summary'];f=s['frequencies'][s['rigidModes']:]
        return [{'id':'f1','label':'First natural frequency','unit':'Hz','value':f[0]}] if f else []


class Buckling(Analysis):
    """Linear buckling: the factors by which the applied loads can be
    multiplied before the part buckles, and the buckled shapes."""
    id='buckling'
    name='Buckling'

    def validate(self, study, mesh):
        modes_of(study,3)
        return validate(study, mesh)

    def deck(self, folder, study, mesh):
        nodes,fixed=self.validate(study,mesh)
        count=modes_of(study,3)
        model=Model(mesh)
        m=study['material']
        loading=build_loads(study,model,m['density']*1e-12)
        lines=calculix.mesh_lines(model,'linear buckling study')
        lines+=calculix.section_lines(model,study)+calculix.boundary_lines(fixed)
        lines+=['*STEP','*BUCKLE, SOLVER='+calculix.direct_solver()[0],str(count)]
        lines+=calculix.load_lines(loading)
        lines+=['*NODE FILE','U','*EL FILE','S','*END STEP']
        (folder/'analysis.inp').write_text('\n'.join(lines)+'\n')
        return {}

    def results(self, folder, study, model, frames, context):
        ids=model.ids
        factors=[v[0] for _,v in calculix.eigenvalues(calculix.read_dat(folder/'analysis.dat'))]
        # The first frame is the reference state under the applied loads.
        base,modes=frames[0],frames[1:]
        if not factors or len(modes)<len(factors):
            raise ValueError('CalculiX did not report the buckling factors. Inspect the solver log.')
        stress=von_mises(nodal(base,'STRESS',ids,6,'reference stress'))
        view=[];info=[]
        for k,(frame,factor) in enumerate(zip(modes,factors)):
            shape,_=normalized(nodal(frame,'DISP',ids,3,'buckled shape'))
            view.append({'displacement':shape})
            info.append({'label':f'Mode {k+1}','value':factor,'unit':'× loads'})
        first=next((f for f in factors if f>0),None)
        warnings=['Real parts buckle below this load: small imperfections, residual stress and yielding lower it, often a lot for thin walls. Design for a factor of at least 2 to 3 on the first buckling load, more for thin shells.']
        if first is not None and first<1:
            warnings.append('The first buckling factor is below 1: the part buckles under the applied loads.')
        if any(f<0 for f in factors):
            warnings.append('Negative factors mean buckling if the loads were reversed.')
        if first is None:
            warnings.append('No buckling under these loads was found, only under reversed loads. Check the load directions.')
        peak=float(stress.max())
        yield_strength=study['material'].get('yield')
        if first and yield_strength and peak*first>yield_strength:
            warnings.append(f'At the first buckling load the stress would reach {peak*first:.3g} MPa, above the yield strength: the part yields before it buckles, so buckling does not limit it.')
        summary={'factors':factors,'referenceStress':peak,'firstFactor':first}
        result={'frames':info,'fields':['displacement'],'summary':summary,'warnings':warnings,'charts':[],
                'checks':[{'label':'Peak stress under the applied loads','values':[peak],'unit':'MPa'},
                          {'label':'First buckling factor','values':[first if first is not None else 0],'unit':'× loads','digits':4}],
                'solverNote':'eigen'}
        return result,view

    def key_results(self, result):
        f=result['summary']['firstFactor']
        return [{'id':'factor','label':'First buckling factor','unit':'× loads','value':f}] if f else []


from thermal import Thermal, ThermalStress
from harmonic import Harmonic
ANALYSES={a.id:a for a in [Static(),Frequency(),Buckling(),Thermal(),ThermalStress(),Harmonic()]}


def analysis_of(study):
    name=study.get('analysis') or 'static'
    if name not in ANALYSES:
        raise ValueError('This analysis type is not available.')
    return ANALYSES[name]


def write_deck(folder, study, mesh):
    return analysis_of(study).deck(folder, study, mesh)


def write_result_view(folder, mesh, frames):
    view=mesh_view(mesh)
    for k,frame in enumerate(frames):
        for name,data in frame.items():
            view[name if k==0 else f'{name}@{k}']=('f8',np.asarray(data))
    write_view(folder,view)


def solve(folder, study):
    mesh=json.loads((folder/'mesh.json').read_text())
    analysis=analysis_of(study)
    emit('checking','Checking supports and loads')
    context=analysis.deck(folder,study,mesh)
    emit('solving','Solving with CalculiX')
    start=time.monotonic()
    iterative=calculix.run(folder)
    emit('reading','Reading results')
    frames=calculix.parse_frd(folder/'analysis.frd')
    if not frames:
        raise ValueError('CalculiX did not produce any results. Inspect the solver log.')
    # Contact and bolts give the mesh extra nodes where bodies separate.
    mesh=context.get('mesh',mesh) if isinstance(context,dict) else mesh
    result,view=analysis.results(folder,study,Model(mesh),frames,context)
    result['summary']['seconds']=time.monotonic()-start
    result['keys']=analysis.key_results(result)
    eigen=result.pop('solverNote',None)=='eigen'
    result.update({'version':SCHEMA,'analysis':analysis.id,
                   'solver':'CalculiX, '+analysis.solver(study)[1]+(' with ARPACK eigenvalues' if eigen else ''),
                   'iterations':iterative['iterations'] if iterative else None,'threads':threads(),
                   'meshSize':mesh['size'],'nodeCount':mesh['nodeCount'],'elementCount':mesh['elementCount']})
    (folder/'result.json').write_text(json.dumps(result))
    write_result_view(folder,mesh,view)
    return result
