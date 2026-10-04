"""Automated mesh convergence: solve on successively finer meshes until the
key results stop changing, and judge each one."""
import math
from cad import emit, mesh_part, mesh_info
from analyses import analysis_of, solve

# Each refinement multiplies the element size by this: about 2.4 times the
# elements, so three meshes span roughly a factor of six.
RATIO=.75


def options_of(options):
    runs=int(options.get('runs',3))
    tolerance=float(options.get('tolerance',.02))
    if not 2<=runs<=6:
        raise ValueError('A convergence study uses 2 to 6 meshes.')
    if not .001<=tolerance<=.2:
        raise ValueError('The convergence tolerance must lie between 0.1% and 20%.')
    return runs,tolerance


def richardson(values, ratio):
    """Extrapolated limit of the last three values of a sequence refined by a
    constant ratio, with the observed order. None unless the changes shrink
    monotonically at a plausible order (0.5 to 4)."""
    if len(values)<3: return None
    a,b,c=values[-3:]
    d1,d2=b-a,c-b
    if d1==0 or d2==0 or d1*d2<0 or abs(d2)>=abs(d1): return None
    order=math.log(d1/d2)/math.log(1/ratio)
    if not .5<=order<=4: return None
    return {'value':c+d2/((1/ratio)**order-1),'order':order}


def judge(quantity, values, tolerance):
    """Verdict for one key result over the meshes."""
    change=abs(values[-1]/values[-2]-1) if len(values)>1 and values[-2] else None
    converged=change is not None and change<=tolerance
    verdict={'converged':converged,'change':change,'estimate':richardson(values,RATIO)}
    if not converged and quantity.get('peak') and len(values)>=3:
        rising=values[-3]<values[-2]<values[-1]
        if rising and (values[-1]-values[-2])>=.8*(values[-2]-values[-3]):
            # Peak stress that keeps climbing by similar steps does not settle:
            # a sharp re-entrant corner or the edge of a support.
            verdict['singular']=True
    return verdict


def converge(folder, study, options):
    runs,tolerance=options_of(options)
    analysis=analysis_of(study)
    size=float(study['meshSize'])
    meshes=[];result=None
    for k in range(runs):
        current={**study,'meshSize':size,'detail':'custom'}
        emit('meshing',f'Mesh {k+1} of up to {runs}: {size:.3g} mm')
        mesh=mesh_part(folder,current)
        emit('solving',f'Solving mesh {k+1} of up to {runs}: {mesh["elementCount"]:,} elements')
        result=solve(folder,current)
        keys=analysis.key_results(result)
        meshes.append({'size':size,'elementCount':mesh['elementCount'],'nodeCount':mesh['nodeCount'],
                       'seconds':result['summary']['seconds'],'values':[q['value'] for q in keys]})
        if k>=1 and all(judge(q,[m['values'][i] for m in meshes],tolerance)['converged'] for i,q in enumerate(keys)):
            break
        size*=RATIO
    quantities=[{**{k:v for k,v in q.items() if k!='value'},
                 **judge(q,[m['values'][i] for m in meshes],tolerance)} for i,q in enumerate(keys)]
    result['convergence']={'tolerance':tolerance,'ratio':RATIO,'meshes':meshes,'quantities':quantities}
    if any(q.get('singular') for q in quantities):
        result['warnings'].append('Peak stress keeps rising as the mesh is refined. It is likely at a sharp inside corner or the edge of a support, where the ideal model has no finite stress. Judge strength away from that spot, or model the real fillet.')
    return mesh,result
