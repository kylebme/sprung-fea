"""Harmonic response: the steady vibration of a part under loads, or base
shaking, that vary sinusoidally over a range of frequencies.

CalculiX first finds natural modes (*FREQUENCY, STORAGE=YES), then sums
their responses at frequencies it spaces between the natural frequencies
(*STEADY STATE DYNAMICS) with modal damping. Results are complex: an
amplitude and phase at each node."""
import numpy as np
import calculix
from model import Model, finite, vector, validate, rbe3, build_loads
from analyses import Analysis, nodal, von_mises, mass_check, modes_of

PHASES=np.linspace(0,np.pi,13)[:-1]
STORED=40


def settings(study):
    h=study.get('harmonic') or {}
    low=finite(h.get('min',10),'Lowest frequency',True)
    high=finite(h.get('max',1000),'Highest frequency',True)
    if high<=low: raise ValueError('The highest frequency must be above the lowest.')
    damping=finite(h.get('damping',.02),'Damping')
    if not 0<damping<1: raise ValueError('Damping must lie between 0 and 100% of critical.')
    excitation=h.get('excitation','loads')
    if excitation not in ('loads','base'): raise ValueError('Choose loads or base shaking.')
    base=None
    if excitation=='base':
        base=vector(h.get('base'),'base acceleration')
        if not np.any(base): raise ValueError('Enter the base acceleration.')
    return low,high,damping,base


def stored_frames(peaks):
    """Up to STORED frame indices: every local maximum of the response,
    the ends, then evenly spaced points."""
    n=len(peaks)
    if n<=STORED: return list(range(n))
    keep={0,n-1}|{i for i in range(1,n-1) if peaks[i]>=peaks[i-1] and peaks[i]>=peaks[i+1]}
    for i in np.linspace(0,n-1,STORED):
        if len(keep)>=STORED: break
        keep.add(int(round(i)))
    return sorted(keep)[:STORED] if len(keep)>STORED else sorted(keep)


class Harmonic(Analysis):
    id='harmonic'
    name='Harmonic response'

    def validate(self, study, mesh):
        low,high,damping,base=settings(study)
        modes_of(study,20)
        if base is not None:
            # Base shaking drives the supports; loads play no part.
            nodes,fixed=validate({**study,'loads':[{'kind':'gravity','vector':[0,0,-1],'faces':[]}]},mesh)
        else:
            nodes,fixed=validate(study,mesh)
        return nodes,fixed

    def deck(self, folder, study, mesh):
        nodes,fixed=self.validate(study,mesh)
        low,high,damping,base=settings(study)
        count=modes_of(study,20)
        model=Model(mesh);masses=study.get('masses') or []
        lines=calculix.mesh_lines(model,'harmonic response study')
        lines+=calculix.section_lines(model,study)+calculix.boundary_lines(fixed)
        lines+=calculix.mass_lines(model,masses,[rbe3(model,m['faces'],m['point']) for m in masses],fixed)
        # Points between natural frequencies: fewer when there are many modes.
        points=max(3,min(12,160//(count+1)))
        direct=self.solver(study)[0]
        lines+=['*STEP',f'*FREQUENCY, SOLVER={direct}, STORAGE=YES',str(count),'*END STEP',
                '*STEP',f'*STEADY STATE DYNAMICS, SOLVER={direct}',f'{calculix.number(low)}, {calculix.number(high)}, {points}, 2.',
                '*MODAL DAMPING',f'1, {count}, {calculix.number(damping)}']
        if base is None:
            lines+=calculix.load_lines(build_loads(study,model))
        else:
            # Shaking the base at acceleration a is, relative to the base, a
            # uniform inertial load −ρa (and −m·a on point masses). Solving
            # it that way keeps damping on relative motion; CalculiX's
            # *BASE MOTION damps absolute motion, which corrupts the
            # response well below resonance.
            inertia={**study,'loads':[{'kind':'gravity','faces':[],'vector':(-np.asarray(base)*9.81).tolist()}]}
            lines+=calculix.load_lines(build_loads(inertia,model))
        lines+=['*NODE FILE','U','*EL FILE','S','*END STEP']
        (folder/'analysis.inp').write_text('\n'.join(lines)+'\n')
        return {'base':base,'count':count}

    def results(self, folder, study, model, frames, context):
        ids=model.ids;base=context['base']
        low,high,damping,_=settings(study)
        modes=[v[2] for _,v in calculix.eigenvalues(calculix.read_dat(folder/'analysis.dat'))]
        hz=[];peak_amp=[];peak_stress=[];shapes=[]
        for f in frames:
            U=nodal(f,'DISP',ids,3,'response')+1j*nodal(f,'DISPI',ids,3,'response')
            S=nodal(f,'STRESS',ids,6,'response')+1j*nodal(f,'STRESSI',ids,6,'response')
            amplitude=np.sqrt((np.abs(U)**2).sum(1))
            # Peak von Mises over a cycle: the largest over sampled phases.
            stress=np.max([von_mises((S*np.exp(1j*p)).real) for p in PHASES],axis=0)
            p=int(np.argmax(amplitude));k=int(np.argmax(np.abs(U[p])))
            # The shape at the instant the most-moving node is at its peak.
            shape=(U*np.exp(-1j*np.angle(U[p,k]))).real
            hz.append(f['value']);peak_amp.append(float(amplitude.max()));peak_stress.append(float(stress.max()))
            shapes.append({'displacement':shape,'amplitude':amplitude,'vonMises':stress})
        keep=stored_frames(peak_amp)
        top=int(np.argmax(peak_amp))
        if top not in keep: keep=sorted(set(keep[:-1])|{top})
        unit='relative to the base' if base is not None else ''
        info=[{'label':f'{hz[i]:.4g} Hz','value':hz[i],'unit':'Hz'} for i in keep]
        in_range=[f for f in modes if low<=f<=high]
        warnings=[f'Steady vibration at each frequency, with {damping*100:.3g}% of critical damping in every mode. Real damping varies: bolted joints add more, a solid casting has less.']
        if base is not None: warnings.append('Displacements are relative to the shaking base.')
        if modes and max(modes)<1.5*high:
            warnings.append(f'The highest mode found ({max(modes):.4g} Hz) is below 1.5 × the top of the range. Find more modes in the Analysis settings for an accurate response near {high:.4g} Hz.')
        yield_strength=(study.get('material') or {}).get('yield')
        if yield_strength and max(peak_stress)>yield_strength:
            warnings.append('The stress amplitude exceeds the yield strength at resonance: the part would yield, and fail by fatigue long before.')
        summary={'frequencies':modes,'responseFrequencies':hz,'peakAmplitude':max(peak_amp),'peakFrequency':hz[top],
                 'peakStress':max(peak_stress),'maxMovement':max(peak_amp),'maxStress':max(peak_stress)}
        charts=[{'id':'response','title':'Displacement response','x':{'label':'Frequency','unit':'Hz','values':hz},
                 'series':[{'label':'Peak displacement'+(' '+unit if unit else ''),'unit':'mm','values':peak_amp}]},
                {'id':'stressResponse','title':'Stress response','x':{'label':'Frequency','unit':'Hz','values':hz},
                 'series':[{'label':'Peak von Mises','unit':'MPa','values':peak_stress}]}]
        result={'frames':info,'fields':['displacement','amplitude','vonMises'],'summary':summary,'warnings':warnings,
                'charts':charts,'solverNote':'eigen',
                'checks':[mass_check(study,model),
                          {'label':'Natural frequencies in range','values':in_range or [0],'unit':'Hz','digits':1},
                          {'label':'Modes used, highest','values':[len(modes),max(modes) if modes else 0],'unit':'Hz','digits':1},
                          {'label':'Largest response at','values':[hz[top]],'unit':'Hz','digits':1}]}
        return result,[shapes[i] for i in keep]

    def key_results(self, result):
        s=result['summary']
        return [{'id':'peakAmplitude','label':'Peak displacement amplitude','unit':'mm','value':s['peakAmplitude']},
                {'id':'peakStress','label':'Peak stress amplitude','unit':'MPa','value':s['peakStress'],'peak':True}]
