"""Steady heat transfer and thermal stress.

Thermal conditions act on faces (fixed temperature, heat flow, convection)
or the whole part (heat generation). Units: temperatures in °C, heat in W,
film coefficients in W/(m²·K), conductivity in W/(m·K), expansion in
µm/(m·°C). In the deck's mm–N–s system 1 W = 1000 N·mm/s, conductivity keeps
its number, and film coefficients are multiplied by 1e-3."""
import numpy as np
import calculix
from model import (Model, finite, check_faces, fixed_dofs, rigid_motions, check_loads,
                   check_masses, build_loads, triangle_weights, triangle_shape, tetra_points,
                   QUAD, BODY_LOADS)
from analyses import (Analysis, nodal, von_mises, mass_check, static_checks, measures, STRESS_FIELDS)

THERMAL_KINDS={'temperature','heat','convection','generation'}
REFERENCE=20.


def reference(study):
    return finite(study.get('referenceTemperature',REFERENCE),'Stress-free temperature')


def check_material(material, expansion):
    if not material:
        raise ValueError('Choose a material first.')
    finite(material['young'],'Elastic modulus',True)
    nu=finite(material['poisson'],'Poisson ratio')
    if not -1<nu<.499:
        raise ValueError('Poisson ratio must lie between -1 and 0.499. Nearly incompressible materials need a different formulation.')
    finite(material['density'],'Density',True)
    if material.get('conductivity') is None:
        raise ValueError('Enter the material’s thermal conductivity.')
    finite(material['conductivity'],'Thermal conductivity',True)
    if expansion:
        if material.get('expansion') is None:
            raise ValueError('Enter the material’s thermal expansion coefficient.')
        finite(material['expansion'],'Thermal expansion')


def check_thermal(conditions, mesh):
    check_faces([c for c in conditions if c.get('kind')!='generation'],mesh)
    for c in conditions:
        kind=c.get('kind')
        if kind not in THERMAL_KINDS: raise ValueError('Unsupported thermal condition.')
        if kind=='temperature': finite(c.get('value'),'Temperature')
        elif kind=='heat': finite(c.get('value'),'Heat flow')
        elif kind=='generation': finite(c.get('value'),'Heat generation')
        else:
            finite(c.get('value'),'Film coefficient',True)
            finite(c.get('ambient'),'Ambient temperature')
    if not any(c['kind'] in ('temperature','convection') for c in conditions):
        raise ValueError('Add a fixed temperature or convection. Heat must be able to leave the part for its temperature to settle.')


class Heat:
    """Thermal loading. `temperatures`: fixed node temperatures (where
    faces with different temperatures meet, the later condition wins);
    `fluxes`: element-face heat flux in N·mm/s per mm²; `films`: element
    face → (ambient, coefficient in deck units); `generation`: N·mm/s per mm³.
    Applied heat totals are in W."""
    def __init__(self):
        self.temperatures={};self.fluxes={};self.films={};self.generation=0.
        self.heat_in=0.;self.film_faces=[];self.flux_faces={}


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
                    else:
                        heat.films[(eid,face)]=(float(c['ambient']),value*1e-3)
                        heat.film_faces.append((tri,float(c['ambient']),value*1e-3))
            if kind=='heat': heat.heat_in+=value
    return heat


def heat_lines(heat):
    """Step lines: fixed temperatures, surface and body flux, films."""
    lines=['*BOUNDARY']+[f'{n}, 11, 11, {calculix.number(t)}' for n,t in sorted(heat.temperatures.items())] if heat.temperatures else []
    flux=[f'{eid}, S{face}, {calculix.number(q)}' for (eid,face),q in heat.fluxes.items()]
    if heat.generation: flux.append(f'PART, BF, {calculix.number(heat.generation)}')
    if flux: lines+=['*DFLUX']+flux
    if heat.films:
        lines+=['*FILM']+[f'{eid}, F{face}, {calculix.number(t)}, {calculix.number(h)}' for (eid,face),(t,h) in heat.films.items()]
    return lines


def thermal_material(model, study, expansion, zero):
    """Materials with *CONDUCTIVITY (and *EXPANSION) for each body group."""
    def extra(material):
        out=['*CONDUCTIVITY',calculix.number(material['conductivity'])]
        if expansion:
            out+=[f'*EXPANSION, ZERO={calculix.number(zero)}',calculix.number(material['expansion']*1e-6)]
        return out
    return calculix.section_lines(model,study,extra)


def check_materials(study, expansion):
    check_material(study.get('material'),expansion)
    for m in (study.get('bodyMaterials') or {}).values(): check_material(m,expansion)


def initial_lines(model, temperature):
    return ['*NSET, NSET=NALL']+calculix.rows(model.ids)+['*INITIAL CONDITIONS, TYPE=TEMPERATURE',f'NALL, {calculix.number(temperature)}']


def heat_balance(heat, frame, model, temperature):
    """Heat flowing in and out (W) and the balance error. Heat flows,
    generation and convection are integrated here (convection from nodal
    temperatures with the quadratic face shape functions). Fixed
    temperatures supply CalculiX's RFL at their nodes, which, like force
    reactions, also contains the share of distributed heat landing on those
    nodes; that share is subtracted."""
    index={n:i for i,n in enumerate(model.ids)}
    fixed=set(heat.temperatures)
    applied={}
    def add(n,q):
        applied[n]=applied.get(n,0.)+q
    gains=[heat.heat_in] if heat.heat_in>0 else [];losses=[-heat.heat_in] if heat.heat_in<0 else []
    if heat.generation:
        for c in model.mesh['elements']:
            for N,_,w in tetra_points(np.array([model.nodes[n] for n in c])):
                for n,Ni in zip(c,N): add(n,Ni*w*heat.generation)
    for tri,ambient,h in heat.film_faces:
        points=np.array([model.nodes[n] for n in tri])
        T=temperature[[index[n] for n in tri]]
        for r,s_,w in QUAD:
            N,dr,ds=triangle_shape(r,s_)
            area=np.linalg.norm(np.cross(dr@points,ds@points))
            q=w*area*h*(ambient-np.dot(N,T))
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


class Thermal(Analysis):
    """Steady heat transfer: the settled temperature field."""
    id='thermal'
    name='Heat transfer'

    def validate(self, study, mesh):
        check_materials(study,False)
        check_thermal(study.get('thermal') or [],mesh)
        return Model(mesh).nodes,set()

    def deck(self, folder, study, mesh):
        self.validate(study,mesh)
        model=Model(mesh);heat=build_heat(study,model)
        lines=calculix.mesh_lines(model,'steady heat transfer study')
        lines+=thermal_material(model,study,False,REFERENCE)+initial_lines(model,reference(study))
        lines+=['*STEP','*HEAT TRANSFER, STEADY STATE','1., 1.']+heat_lines(heat)
        lines+=['*NODE FILE','NT, RFL','*EL FILE','HFL','*END STEP']
        (folder/'analysis.inp').write_text('\n'.join(lines)+'\n')
        return {'heat':heat}

    def results(self, folder, study, model, frames, context):
        frame=frames[-1];ids=model.ids
        temperature=nodal(frame,'NDTEMP',ids,1,'temperature')[:,0]
        flux=flux_magnitude(frame,ids)
        balance=heat_balance(context['heat'],frame,model,temperature)
        summary={'maxTemperature':float(temperature.max()),'minTemperature':float(temperature.min()),
                 'maxHeatFlux':float(flux.max()),'heatBalance':balance}
        warnings=['Steady state: temperatures after the part has fully settled. Radiation is not modeled; include it in the convection coefficient if it matters.']
        result={'frames':[{'label':'Steady state','value':None,'unit':''}],'fields':['temperature','heatFlux'],
                'summary':summary,'warnings':warnings,'charts':[],'checks':heat_checks(balance)}
        return result,[{'temperature':temperature,'heatFlux':flux}]

    def key_results(self, result):
        s=result['summary']
        return [{'id':'maxTemperature','label':'Highest temperature','unit':'°C','value':s['maxTemperature']},
                {'id':'minTemperature','label':'Lowest temperature','unit':'°C','value':s['minTemperature']}]


class ThermalStress(Analysis):
    """Temperatures and the stress and deflection they cause, together with
    any mechanical loads: a coupled steady-state solve."""
    id='thermalStress'
    name='Thermal stress'

    def validate(self, study, mesh):
        calculix.solver_of(study)
        check_materials(study,True)
        reference(study)
        check_thermal(study.get('thermal') or [],mesh)
        supports=study.get('supports',[]);loads=study.get('loads',[])
        if not supports:
            raise ValueError('Add a support to hold the part in place.')
        masses=study.get('masses') or []
        check_faces(supports+[l for l in loads if l.get('kind') not in BODY_LOADS]+masses,mesh)
        check_masses(masses)
        model=Model(mesh)
        fixed=fixed_dofs(supports,model)
        rigid_motions(fixed,model)
        if loads: check_loads(loads,required=False)
        return model.nodes,fixed

    def deck(self, folder, study, mesh):
        nodes,fixed=self.validate(study,mesh)
        model=Model(mesh);m=study['material']
        heat=build_heat(study,model)
        loading=build_loads(study,model,m['density']*1e-12)
        lines=calculix.mesh_lines(model,'steady thermal stress study')
        lines+=thermal_material(model,study,True,reference(study))+initial_lines(model,reference(study))
        lines+=calculix.boundary_lines(fixed)
        lines+=['*STEP','*COUPLED TEMPERATURE-DISPLACEMENT, STEADY STATE','1., 1.']+heat_lines(heat)
        lines+=calculix.load_lines(loading)
        lines+=['*NODE FILE','U, NT, RF, RFL','*EL FILE','S, E, HFL','*END STEP']
        (folder/'analysis.inp').write_text('\n'.join(lines)+'\n')
        return {'heat':heat,'fixed':fixed,'loading':loading}

    def results(self, folder, study, model, frames, context):
        frame=frames[-1];ids=model.ids
        temperature=nodal(frame,'NDTEMP',ids,1,'temperature')[:,0]
        displacements=nodal(frame,'DISP',ids,3,'displacement and stress')
        fields=measures(frame,ids)
        stress=fields['vonMises']
        movement=np.linalg.norm(displacements,axis=1)
        balance=heat_balance(context['heat'],frame,model,temperature)
        checks,reactions,total,force_error=static_checks(frame,context['fixed'],context['loading'])
        max_stress=float(stress.max());max_move=float(movement.max())
        yield_strength=study['material'].get('yield')
        warnings=['Steady state: temperatures after the part has fully settled. Supports that block expansion cause stress, so hold the part only where it is held in reality.',
                  'Peak stress at sharp corners or support edges may increase with refinement. Check a finer mesh before relying on a result.']
        if yield_strength and max_stress>yield_strength:
            warnings.append('Stress exceeds the material yield strength. The elastic model cannot predict permanent deformation.')
        summary={'maxStress':max_stress,'maxMovement':max_move,'minSafety':yield_strength/max_stress if yield_strength and max_stress else None,
                 'reactions':reactions.tolist(),'appliedForce':total.tolist(),'forceBalanceError':force_error,
                 'stressNode':ids[int(np.argmax(stress))],'movementNode':ids[int(np.argmax(movement))],
                 'maxTemperature':float(temperature.max()),'minTemperature':float(temperature.min()),'heatBalance':balance}
        result={'frames':[{'label':'Steady state','value':None,'unit':''}],'fields':['displacement',*STRESS_FIELDS,'temperature'],
                'summary':summary,'warnings':warnings,'charts':[],
                'checks':[mass_check(study,model)]+checks+heat_checks(balance),
                'displacements':displacements.tolist(),'stress':stress.tolist(),'movement':movement.tolist()}
        return result,[{'displacement':displacements,**fields,'temperature':temperature}]

    def key_results(self, result):
        s=result['summary']
        return [{'id':'maxMovement','label':'Maximum displacement','unit':'mm','value':s['maxMovement']},
                {'id':'maxStress','label':'Peak stress','unit':'MPa','value':s['maxStress'],'peak':True},
                {'id':'maxTemperature','label':'Highest temperature','unit':'°C','value':s['maxTemperature']}]
