"""Heat transfer and thermal stress, settled (steady) or over time.

Thermal conditions act on faces (fixed temperature, heat flow, convection,
radiation) or the whole part (heat generation). Units: temperatures in °C,
heat in W, film coefficients in W/(m²·K), conductivity in W/(m·K),
expansion in µm/(m·°C), specific heat in J/(kg·K). In the deck's mm–N–s
system 1 W = 1000 N·mm/s, conductivity keeps its number, film coefficients
are multiplied by 1e-3, specific heat by 1e6 (N·mm/(tonne·K)), and the
Stefan–Boltzmann constant is 5.670374e-11 N·mm/(s·mm²·K⁴)."""
import numpy as np
import calculix
from model import (Model, finite, check_faces, check_table, fixed_dofs, rigid_motions, check_loads,
                   check_masses, build_loads, triangle_weights, triangle_shape,
                   QUAD, BODY_LOADS)
from analyses import (Analysis, nodal, von_mises, mass_check, static_checks, measures, STRESS_FIELDS)

THERMAL_KINDS={'temperature','heat','convection','radiation','generation'}
REFERENCE=20.
STEFAN_BOLTZMANN=5.670374419e-11
ABSOLUTE_ZERO=-273.15
# Time stepping over a duration D: fixed increments, finest at the start
# where temperatures change fastest. (end as a fraction of D, increments,
# output every n increments) for each stage. A sudden temperature at time
# zero defeats CalculiX's automatic incrementation, so it is not used.
STAGES=[(.01,25,2),(.1,25,2),(1.,75,3)]


def reference(study):
    return finite(study.get('referenceTemperature',REFERENCE),'Stress-free temperature')


def transient(study):
    """(duration in s, starting temperature in °C) when temperatures are
    followed over time, or None for the settled state."""
    t=study.get('transient') or {}
    if not t.get('on'): return None
    return finite(t.get('duration'),'Duration',True),finite(t.get('start',REFERENCE),'Starting temperature')


def check_material(material, expansion, timed):
    if not material:
        raise ValueError('Choose a material first.')
    finite(material['young'],'Elastic modulus',True)
    nu=finite(material['poisson'],'Poisson ratio')
    if not -1<nu<.499:
        raise ValueError('Poisson ratio must lie between -1 and 0.499. Nearly incompressible materials need a different formulation.')
    finite(material['density'],'Density',True)
    check_table(material)
    if material.get('conductivity') is None:
        raise ValueError('Enter the material’s thermal conductivity.')
    finite(material['conductivity'],'Thermal conductivity',True)
    if expansion:
        if material.get('expansion') is None:
            raise ValueError('Enter the material’s thermal expansion coefficient.')
        finite(material['expansion'],'Thermal expansion')
    if timed:
        if material.get('specificHeat') is None:
            raise ValueError('Enter the material’s specific heat. Temperatures over time depend on it.')
        finite(material['specificHeat'],'Specific heat',True)


def check_thermal(conditions, mesh, timed):
    check_faces([c for c in conditions if c.get('kind')!='generation'],mesh)
    for c in conditions:
        kind=c.get('kind')
        if kind not in THERMAL_KINDS: raise ValueError('Unsupported thermal condition.')
        if kind=='temperature': finite(c.get('value'),'Temperature')
        elif kind=='heat': finite(c.get('value'),'Heat flow')
        elif kind=='generation': finite(c.get('value'),'Heat generation')
        elif kind=='radiation':
            if not 0<finite(c.get('value'),'Emissivity')<=1:
                raise ValueError('Emissivity must lie between 0 and 1.')
            if finite(c.get('ambient'),'Surroundings temperature')<=ABSOLUTE_ZERO:
                raise ValueError('The surroundings temperature must be above absolute zero.')
        else:
            finite(c.get('value'),'Film coefficient',True)
            finite(c.get('ambient'),'Ambient temperature')
    # Over a finite time heat can stay in the part; to settle it must leave.
    if not timed and not any(c['kind'] in ('temperature','convection','radiation') for c in conditions):
        raise ValueError('Add a fixed temperature, convection or radiation. Heat must be able to leave the part for its temperature to settle.')
    if timed and not conditions:
        raise ValueError('Add a thermal condition: a temperature, heat flow, convection, radiation or heat generation.')


class Heat:
    """Thermal loading. `temperatures`: fixed node temperatures (where
    faces with different temperatures meet, the later condition wins);
    `fluxes`: element-face heat flux in N·mm/s per mm²; `films`: element
    face → (ambient, coefficient in deck units); `radiation`: element face
    → (surroundings, emissivity); `generation`: N·mm/s per mm³. Applied
    heat totals are in W."""
    def __init__(self):
        self.temperatures={};self.fluxes={};self.films={};self.radiation={};self.generation=0.
        self.heat_in=0.;self.film_faces=[];self.radiation_faces=[];self.flux_faces={}


def build_heat(study, model):
    heat=Heat();lookup=model.element_faces()
    for c in study.get('thermal') or []:
        kind=c['kind'];value=float(c['value'])
        if kind=='temperature':
            for f in c['faces']:
                for n in model.face_nodes(f): heat.temperatures[n]=value
        elif kind=='generation':
            heat.generation+=value*1000/model.volume()
            heat.heat_in+=value
        else:
            area=sum(q[4] for q in model.face_quadrature(c['faces']))
            for f in c['faces']:
                for tri in model.face_triangles(f):
                    eid,face,_=lookup[tuple(sorted(tri[:3]))]
                    if kind=='heat':
                        heat.fluxes[(eid,face)]=heat.fluxes.get((eid,face),0)+value*1000/area
                        heat.flux_faces.setdefault(id(c),([],value*1000/area))[0].append(tri)
                    elif kind=='radiation':
                        heat.radiation[(eid,face)]=(float(c['ambient']),value)
                        heat.radiation_faces.append((tri,float(c['ambient']),value))
                    else:
                        heat.films[(eid,face)]=(float(c['ambient']),value*1e-3)
                        heat.film_faces.append((tri,float(c['ambient']),value*1e-3))
            if kind=='heat': heat.heat_in+=value
    return heat


def heat_lines(heat):
    """Step lines: fixed temperatures, surface and body flux, films and
    radiation."""
    lines=['*BOUNDARY']+[f'{n}, 11, 11, {calculix.number(t)}' for n,t in sorted(heat.temperatures.items())] if heat.temperatures else []
    flux=[f'{eid}, S{face}, {calculix.number(q)}' for (eid,face),q in heat.fluxes.items()]
    if heat.generation: flux.append(f'PART, BF, {calculix.number(heat.generation)}')
    if flux: lines+=['*DFLUX']+flux
    if heat.films:
        lines+=['*FILM']+[f'{eid}, F{face}, {calculix.number(t)}, {calculix.number(h)}' for (eid,face),(t,h) in heat.films.items()]
    if heat.radiation:
        lines+=['*RADIATE']+[f'{eid}, R{face}, {calculix.number(t)}, {calculix.number(e)}' for (eid,face),(t,e) in heat.radiation.items()]
    return lines


def constant_lines(heat):
    """Model lines radiation needs: absolute zero and Stefan–Boltzmann."""
    if not heat.radiation: return []
    return [f'*PHYSICAL CONSTANTS, ABSOLUTE ZERO={ABSOLUTE_ZERO}, STEFAN BOLTZMANN={STEFAN_BOLTZMANN}']


def thermal_material(model, study, expansion, zero, timed):
    """Materials with *CONDUCTIVITY (and *EXPANSION, *SPECIFIC HEAT) for
    each body group. Properties with a temperature table follow it."""
    def extra(material):
        k=calculix.temperature_table(material,'conductivity')
        out=['*CONDUCTIVITY']+([f'{calculix.number(v)}, {calculix.number(t)}' for v,t in k] if k
                               else [calculix.number(material['conductivity'])])
        if expansion:
            a=calculix.temperature_table(material,'expansion',1e-6)
            out+=[f'*EXPANSION, ZERO={calculix.number(zero)}']+([f'{calculix.number(v)}, {calculix.number(t)}' for v,t in a] if a
                                                                else [calculix.number(material['expansion']*1e-6)])
        if timed:
            out+=['*SPECIFIC HEAT',calculix.number(material['specificHeat']*1e6)]
        return out
    return calculix.section_lines(model,study,extra,temperatures=True)


def check_materials(study, expansion, timed):
    check_material(study.get('material'),expansion,timed)
    for m in (study.get('bodyMaterials') or {}).values(): check_material(m,expansion,timed)


def initial_lines(model, temperature):
    return ['*NSET, NSET=NALL']+calculix.rows(model.ids)+['*INITIAL CONDITIONS, TYPE=TEMPERATURE',f'NALL, {calculix.number(temperature)}']


def step_lines(procedure, loads, outputs, timing):
    """The solution steps: one steady step, or the stages of a transient
    over the duration with the loads applied from time zero."""
    solver=calculix.direct_solver()[0]
    if timing is None:
        return ['*STEP',procedure+', STEADY STATE, SOLVER='+solver,'1., 1.']+loads+[l for o in outputs for l in o]+['*END STEP']
    duration=timing[0];lines=[];start=0.
    for k,(fraction,count,every) in enumerate(STAGES):
        end=fraction*duration;period=end-start
        lines+=['*STEP, INC=1000',procedure+', DIRECT, SOLVER='+solver,f'{calculix.number(period/count)}, {calculix.number(period)}']
        if k==0: lines+=loads
        for keyword,names in outputs: lines+=[f'{keyword}, FREQUENCY={every}',names]
        lines+=['*END STEP'];start=end
    return lines


def heat_balance(heat, frame, model, temperature):
    """Heat flowing in and out (W) and the balance error. Heat flows,
    generation, convection and radiation are integrated here (convection
    and radiation from nodal temperatures with the quadratic face shape
    functions). Fixed temperatures supply CalculiX's RFL at their nodes,
    which, like force reactions, also contains the share of distributed
    heat landing on those nodes; that share is subtracted."""
    index={n:i for i,n in enumerate(model.ids)}
    fixed=set(heat.temperatures)
    applied={}
    def add(n,q):
        applied[n]=applied.get(n,0.)+q
    gains=[heat.heat_in] if heat.heat_in>0 else [];losses=[-heat.heat_in] if heat.heat_in<0 else []
    if heat.generation:
        q=model.integrate_elements(lambda x:np.ones(len(x)),np.full(len(model.mesh['elements']),heat.generation))[:,0]
        for n in np.flatnonzero(q): add(model.ids[n],q[n])
    # Heat into the part per unit area at a surface temperature T.
    exchanges=[(tri,lambda T,a=ambient,h=h:h*(a-T)) for tri,ambient,h in heat.film_faces]
    exchanges+=[(tri,lambda T,a=ambient,e=e:e*STEFAN_BOLTZMANN*((a-ABSOLUTE_ZERO)**4-(T-ABSOLUTE_ZERO)**4))
                for tri,ambient,e in heat.radiation_faces]
    for tri,flux in exchanges:
        points=np.array([model.nodes[n] for n in tri])
        T=temperature[[index[n] for n in tri]]
        for r,s_,w in QUAD:
            N,dr,ds=triangle_shape(r,s_)
            area=np.linalg.norm(np.cross(dr@points,ds@points))
            q=w*area*flux(np.dot(N,T))
            (gains if q>0 else losses).append(abs(q)/1000)
            for n,Ni in zip(tri,N): add(n,Ni*q)
    for f,(tris,q) in heat.flux_faces.items():
        for tri in tris:
            for n,w in zip(tri,triangle_weights(np.array([model.nodes[n] for n in tri]))): add(n,w*q)
    rfl=frame['fields'].get('RFL',{})
    for n in fixed:
        q=(rfl.get(n,[0])[0]-applied.get(n,0.))/1000
        (gains if q>0 else losses).append(abs(q))
    heat_in=sum(gains);heat_out=sum(losses)
    scale=max(heat_in,heat_out)
    error=abs(heat_in-heat_out)/scale if scale>1e-9 else 0.
    return {'in':heat_in,'out':heat_out,'error':error}


def heat_checks(balance):
    return [{'label':'Heat flowing in, out','values':[balance['in'],balance['out']],'unit':'W','digits':4},
            {'label':'Heat balance error','values':[balance['error']*100],'unit':'%'}]


def flux_magnitude(frame, ids):
    """Heat flux magnitude at nodes in W/m² (N/(mm·s) × 1000)."""
    data=frame['fields'].get('FLUX',{})
    return np.array([np.linalg.norm(data.get(n,[0,0,0])[:3]) for n in ids])*1000


def time_frames(frames):
    """Frame labels of a transient: the time of each stored increment."""
    return [{'label':f"{f['value']:.4g} s",'value':f['value'],'unit':'s'} for f in frames]


def time_notes(temperatures, times, timing):
    """Warnings, checks, and the highest and lowest temperature of each
    frame, for temperatures over time. `temperatures` holds each frame's
    nodal temperatures."""
    duration,start=timing
    peaks=[float(T.max()) for T in temperatures];lows=[float(T.min()) for T in temperatures]
    warnings=[f'Temperatures over {duration:.4g} s, starting from {start:.4g} °C everywhere, with every condition switched on at time zero.']
    # Not settled: over the last tenth of the time, some temperature changes
    # by more than 1% of the largest change from the start.
    total=max(max(peaks)-start,start-min(lows),1e-9)
    late=min(range(len(times)),key=lambda i:abs(times[i]-.9*duration))
    if late<len(times)-1 and float(np.abs(temperatures[-1]-temperatures[late]).max())>.01*total:
        warnings.append('Temperatures are still changing at the end. Use a longer duration to see where they settle.')
    checks=[{'label':'Time simulated','values':[duration],'unit':'s','digits':4},
            {'label':'Highest, lowest temperature at the end','values':[peaks[-1],lows[-1]],'unit':'°C','digits':2}]
    return warnings,checks,peaks,lows


def history_chart(times, peaks, lows):
    return {'id':'history','title':'Temperature over time','x':{'label':'Time','unit':'s','values':times},
            'series':[{'label':'Highest','unit':'°C','values':peaks},{'label':'Lowest','unit':'°C','values':lows}]}


class Thermal(Analysis):
    """Heat transfer: the settled temperature field, or temperatures over
    time from a uniform start."""
    id='thermal'
    name='Heat transfer'

    def validate(self, study, mesh):
        timed=transient(study) is not None
        check_materials(study,False,timed)
        check_thermal(study.get('thermal') or [],mesh,timed)
        return Model(mesh).nodes,set()

    def deck(self, folder, study, mesh):
        self.validate(study,mesh)
        model=Model(mesh);heat=build_heat(study,model);timing=transient(study)
        lines=calculix.mesh_lines(model,'transient heat transfer study' if timing else 'steady heat transfer study')
        lines+=thermal_material(model,study,False,REFERENCE,timing is not None)
        lines+=initial_lines(model,timing[1] if timing else reference(study))+constant_lines(heat)
        lines+=step_lines('*HEAT TRANSFER',heat_lines(heat),[('*NODE FILE','NT, RFL'),('*EL FILE','HFL')],timing)
        (folder/'analysis.inp').write_text('\n'.join(lines)+'\n')
        return {'heat':heat,'timing':timing}

    def results(self, folder, study, model, frames, context):
        ids=model.ids;timing=context['timing']
        stored=frames if timing else frames[-1:]
        view=[{'temperature':nodal(f,'NDTEMP',ids,1,'temperature')[:,0],'heatFlux':flux_magnitude(f,ids)} for f in stored]
        temperature=view[-1]['temperature'];flux=view[-1]['heatFlux']
        summary={'maxTemperature':max(float(v['temperature'].max()) for v in view),
                 'minTemperature':min(float(v['temperature'].min()) for v in view),
                 'maxHeatFlux':max(float(v['heatFlux'].max()) for v in view)}
        radiation=' Radiation follows the fourth power of absolute temperature.' if context['heat'].radiation else ''
        if timing:
            labels=time_frames(stored);times=[f['value'] for f in labels]
            warnings,checks,peaks,lows=time_notes([v['temperature'] for v in view],times,timing)
            warnings[0]+=radiation
            charts=[history_chart(times,peaks,lows)]
            summary['duration']=timing[0]
        else:
            balance=heat_balance(context['heat'],stored[-1],model,temperature)
            summary['heatBalance']=balance
            warnings=['Steady state: temperatures after the part has fully settled.'+
                      (radiation if radiation else ' Radiation is not modeled unless you add it to faces.')]
            checks=heat_checks(balance);labels=[{'label':'Steady state','value':None,'unit':''}];charts=[]
        result={'frames':labels,'fields':['temperature','heatFlux'],
                'summary':summary,'warnings':warnings,'charts':charts,'checks':checks}
        return result,view

    def key_results(self, result):
        s=result['summary']
        return [{'id':'maxTemperature','label':'Highest temperature','unit':'°C','value':s['maxTemperature']},
                {'id':'minTemperature','label':'Lowest temperature','unit':'°C','value':s['minTemperature']}]


class ThermalStress(Analysis):
    """Temperatures and the stress and deflection they cause, together with
    any mechanical loads: a coupled solve, settled or over time."""
    id='thermalStress'
    name='Thermal stress'

    def validate(self, study, mesh):
        calculix.solver_of(study)
        timed=transient(study) is not None
        check_materials(study,True,timed)
        reference(study)
        check_thermal(study.get('thermal') or [],mesh,timed)
        supports=study.get('supports',[]);loads=study.get('loads',[])
        if not supports:
            raise ValueError('Add a support to hold the part in place.')
        masses=study.get('masses') or []
        check_faces(supports+[l for l in loads if l.get('kind') not in BODY_LOADS]+masses,mesh)
        check_masses(masses)
        model=Model(mesh)
        held=fixed_dofs(supports,model)
        rigid_motions(held,model)
        if loads: check_loads(loads,required=False)
        return model.nodes,held

    def deck(self, folder, study, mesh):
        nodes,held=self.validate(study,mesh)
        model=Model(mesh);m=study['material'];timing=transient(study)
        heat=build_heat(study,model)
        loading=build_loads(study,model,m['density']*1e-12)
        lines=calculix.mesh_lines(model,'transient thermal stress study' if timing else 'steady thermal stress study')
        lines+=thermal_material(model,study,True,reference(study),timing is not None)
        lines+=initial_lines(model,timing[1] if timing else reference(study))+constant_lines(heat)
        lines+=calculix.boundary_lines(held)
        lines+=step_lines('*COUPLED TEMPERATURE-DISPLACEMENT',heat_lines(heat)+calculix.load_lines(loading),
                          [('*NODE FILE','U, NT, RF, RFL'),('*EL FILE','S, E, HFL')],timing)
        (folder/'analysis.inp').write_text('\n'.join(lines)+'\n')
        return {'heat':heat,'held':held,'loading':loading,'timing':timing}

    def results(self, folder, study, model, frames, context):
        ids=model.ids;timing=context['timing']
        stored=frames if timing else frames[-1:]
        view=[]
        for f in stored:
            view.append({'displacement':nodal(f,'DISP',ids,3,'displacement and stress'),**measures(f,ids),
                         'temperature':nodal(f,'NDTEMP',ids,1,'temperature')[:,0],
                         'force':nodal(f,'FORC',ids,3,'nodal force')})
        frame=stored[-1];final=view[-1]
        # The worst moment: the frame with the highest stress.
        worst=max(range(len(view)),key=lambda k:float(view[k]['vonMises'].max()))
        stress=view[worst]['vonMises'];movement=np.linalg.norm(view[worst]['displacement'],axis=1)
        checks,reactions,total,force_error=static_checks(frame,context['held'],context['loading'])
        max_stress=float(stress.max());max_move=max(float(np.linalg.norm(v['displacement'],axis=1).max()) for v in view)
        yield_strength=study['material'].get('yield')
        warnings=['Peak stress at sharp corners or support edges may increase with refinement. Check a finer mesh before relying on a result.']
        if timing:
            labels=time_frames(stored);times=[l['value'] for l in labels]
            notes,time_checks,peaks,lows=time_notes([v['temperature'] for v in view],times,timing)
            warnings=notes+['Supports that block expansion cause stress, so hold the part only where it is held in reality.']+warnings
            charts=[history_chart(times,peaks,lows),
                    {'id':'stressHistory','title':'Stress over time','x':{'label':'Time','unit':'s','values':times},
                     'series':[{'label':'Peak von Mises','unit':'MPa','values':[float(v['vonMises'].max()) for v in view]}]}]
            checks+=time_checks
        else:
            warnings.insert(0,'Steady state: temperatures after the part has fully settled. Supports that block expansion cause stress, so hold the part only where it is held in reality.')
            labels=[{'label':'Steady state','value':None,'unit':''}];charts=[]
            balance=heat_balance(context['heat'],frame,model,final['temperature'])
            checks+=heat_checks(balance)
        if yield_strength and max_stress>yield_strength:
            warnings.append('Stress exceeds the material yield strength. The elastic model cannot predict permanent deformation.')
        summary={'maxStress':max_stress,'maxMovement':max_move,'minSafety':yield_strength/max_stress if yield_strength and max_stress else None,
                 'reactions':reactions.tolist(),'appliedForce':total.tolist(),'forceBalanceError':force_error,
                 'stressNode':ids[int(np.argmax(stress))],'movementNode':ids[int(np.argmax(movement))],
                 'maxTemperature':max(float(v['temperature'].max()) for v in view),
                 'minTemperature':min(float(v['temperature'].min()) for v in view)}
        if timing: summary.update(duration=timing[0],worstFrame=worst)
        else: summary['heatBalance']=balance
        result={'frames':labels,'fields':['displacement',*STRESS_FIELDS,'temperature'],
                'summary':summary,'warnings':warnings,'charts':charts,
                'checks':[mass_check(study,model)]+checks,
                'displacements':final['displacement'].tolist(),'stress':final['vonMises'].tolist(),
                'movement':np.linalg.norm(final['displacement'],axis=1).tolist()}
        return result,view

    def key_results(self, result):
        s=result['summary']
        return [{'id':'maxMovement','label':'Maximum displacement','unit':'mm','value':s['maxMovement']},
                {'id':'maxStress','label':'Peak stress','unit':'MPa','value':s['maxStress'],'peak':True},
                {'id':'maxTemperature','label':'Highest temperature','unit':'°C','value':s['maxTemperature']}]
