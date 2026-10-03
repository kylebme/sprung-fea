"""Analysis types. Each one validates a study, writes its CalculiX step, and
turns the solver's frames into BetterSim's result schema.

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
Frame k > 0 stores its arrays in view.bin as `name@k`."""
import json, math, time
import numpy as np
import calculix
from cad import emit, threads, mesh_view, write_view
from model import Model, validate, build_loads

SCHEMA=2


def von_mises(s):
    xx,yy,zz,xy,yz,zx=s[:6]
    return math.sqrt(max(0,((xx-yy)**2+(yy-zz)**2+(zz-xx)**2)/2+3*(xy*xy+yz*yz+zx*zx)))


def nodal(frame, label, ids, count, what):
    """Values of one FRD field at the mesh's nodes, first `count` components."""
    data=frame['fields'].get(label)
    if not data or any(n not in data for n in ids):
        raise ValueError(f'CalculiX did not produce complete {what} results. Inspect the solver log.')
    return np.array([data[n][:count] for n in ids])


def mass_check(study, model):
    """Mass of the meshed part plus point masses, so density and units can be
    checked at a glance."""
    part=model.volume()*study['material']['density']*1e-9
    extra=sum(float(m['mass']) for m in study.get('masses') or [])
    label='Mass, part + point masses' if extra else 'Mass'
    return {'label':label,'values':[part+extra],'unit':'kg','digits':4}


class Analysis:
    id=''
    name=''

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


class Static(Analysis):
    id='static'
    name='Linear static'

    def deck(self, folder, study, mesh):
        nodes, fixed = self.validate(study, mesh)
        model=Model(mesh)
        m=study['material']
        loading=build_loads(study, model, m['density']*1e-12)
        lines=calculix.mesh_lines(model, 'linear static study')
        lines+=calculix.material_lines(m)+calculix.boundary_lines(fixed)
        lines+=['*STEP','*STATIC, SOLVER='+calculix.SOLVERS[calculix.solver_of(study)][0]]
        lines+=calculix.load_lines(loading)
        lines+=['*NODE FILE','U, RF','*EL FILE','S','*NODE PRINT, NSET=HELD, TOTALS=YES','RF','*END STEP']
        (folder/'analysis.inp').write_text('\n'.join(lines)+'\n')
        (folder/'applied.json').write_text(json.dumps({n:v.tolist() for n,v in loading.applied.items()}))
        return {'fixed':fixed,'loading':loading}

    def results(self, folder, study, model, frames, context):
        frame=frames[-1]
        ids=model.ids
        displacements=nodal(frame,'DISP',ids,3,'displacement and stress')
        stress=np.array([von_mises(s) for s in nodal(frame,'STRESS',ids,6,'displacement and stress')])
        movement=np.linalg.norm(displacements,axis=1)
        loading=context['loading']
        reactions=np.zeros(3)
        # CCX RF includes applied loads: subtract them to obtain support reactions.
        forces=frame['fields'].get('FORC',{})
        for n,a in context['fixed']:
            reactions[a]+=forces.get(n,[0,0,0])[a]-loading.applied.get(n,np.zeros(3))[a]
        total_load=loading.total()
        # Resultants can cancel for pressure around a bore. Normalize by the
        # larger of the resultant and absolute equivalent nodal loading.
        load_scale=max(np.linalg.norm(total_load),sum(np.linalg.norm(v) for v in loading.applied.values()),1e-9)
        balance=float(np.linalg.norm(reactions+total_load)/load_scale)
        dims=np.ptp(model.coords,axis=0)
        max_stress=float(stress.max()); max_move=float(movement.max())
        yield_strength=study['material'].get('yield')
        warnings=['Peak stress at sharp corners or support edges may increase with refinement. Check a finer mesh before relying on a result.']
        if yield_strength and max_stress>yield_strength: warnings.append('Stress exceeds the material yield strength. The elastic model cannot predict permanent deformation.')
        if max_move>.05*min(dims): warnings.append('Movement is large relative to the smallest part dimension. A small-deformation analysis may not be appropriate.')
        summary={'maxStress':max_stress,'maxMovement':max_move,
                 'minSafety':yield_strength/max_stress if yield_strength and max_stress else None,'reactions':reactions.tolist(),
                 'appliedForce':total_load.tolist(),'forceBalanceError':balance,
                 'stressNode':ids[int(np.argmax(stress))],'movementNode':ids[int(np.argmax(movement))]}
        result={'frames':[{'label':'Static load','value':None,'unit':''}],'fields':['displacement','vonMises'],
                'summary':summary,'warnings':warnings,'charts':[],
                'checks':[mass_check(study,model),
                          {'label':'Applied force X, Y, Z','values':total_load.tolist(),'unit':'N'},
                          {'label':'Reaction X, Y, Z','values':reactions.tolist(),'unit':'N'},
                          {'label':'Force balance error','values':[balance*100],'unit':'%'}],
                'displacements':displacements.tolist(),'stress':stress.tolist(),'movement':movement.tolist()}
        return result,[{'displacement':displacements,'vonMises':stress}]

    def key_results(self, result):
        s=result['summary']
        return [{'id':'maxMovement','label':'Maximum displacement','unit':'mm','value':s['maxMovement']},
                {'id':'maxStress','label':'Peak stress','unit':'MPa','value':s['maxStress'],'peak':True}]


ANALYSES={a.id:a for a in [Static()]}


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
    result,view=analysis.results(folder,study,Model(mesh),frames,context)
    result['summary']['seconds']=time.monotonic()-start
    result.update({'version':SCHEMA,'analysis':analysis.id,'solver':'CalculiX, '+calculix.SOLVERS[calculix.solver_of(study)][1],
                   'iterations':iterative['iterations'] if iterative else None,'threads':threads(),
                   'meshSize':mesh['size'],'nodeCount':mesh['nodeCount'],'elementCount':mesh['elementCount']})
    (folder/'result.json').write_text(json.dumps(result))
    write_result_view(folder,mesh,view)
    return result
