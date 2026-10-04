"""Stress measures beyond von Mises: principal stresses and Tresca shear."""
import unittest, sys, tempfile, shutil, json
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import worker
from analyses import stress_fields, strain_fields
ROOT=Path(__file__).resolve().parents[1]

def study(load):
    return {'material':{'name':'Al','young':68900,'poisson':.33,'density':2700,'yield':276},
            'supports':[{'faces':[1],'axes':[True]*3}],'loads':[load],'masses':[],'meshSize':4}

def fields(folder):
    """Arrays of view.bin by name."""
    data=(folder/'view.bin').read_bytes()
    n=int(np.frombuffer(data[8:12],'<u4')[0]);header=json.loads(data[12:12+n]);offset=12+n;out={}
    for a in header['arrays']:
        dtype={'float64':'<f8','int32':'<i4'}[a['type']];count=int(np.prod(a['shape']))
        out[a['name']]=np.frombuffer(data,dtype,count,offset).reshape(a['shape'])
        offset+=-(-count*np.dtype(dtype).itemsize//8)*8
    return out

class StressMeasures(unittest.TestCase):
    def test_measures_of_known_tensors(self):
        # Uniaxial tension, pure shear, and equal biaxial compression.
        f=stress_fields([[5,0,0,0,0,0],[0,0,0,3,0,0],[-2,-2,0,0,0,0]])
        np.testing.assert_allclose(f['principalMax'],[5,3,0],atol=1e-12)
        np.testing.assert_allclose(f['principalMin'],[0,-3,-2],atol=1e-12)
        np.testing.assert_allclose(f['shear'],[2.5,3,1],atol=1e-12)
        np.testing.assert_allclose(f['vonMises'],[5,3*np.sqrt(3),2],atol=1e-12)
        # Uniaxial stress strains: ε, −νε, −νε; equivalent (2/3)(1 + ν)ε.
        e,nu=1e-3,.3
        s=strain_fields([[e,-nu*e,-nu*e,0,0,0],[0,0,0,e,0,0]])
        np.testing.assert_allclose(s['strainMax'],[1000,1000],atol=1e-9)
        np.testing.assert_allclose(s['strainMin'],[-300,-1000],atol=1e-9)
        np.testing.assert_allclose(s['strain'][0],2/3*(1+nu)*1000,atol=1e-9)

    def test_bending_puts_tension_on_top_and_compression_below(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);shutil.copy(ROOT/'samples/beam.step',folder/'part.step')
            worker.import_part(folder)
            s=study({'kind':'force','faces':[2],'vector':[0,0,-100]})
            worker.mesh_part(folder,s);result=worker.solve(folder,s)
            self.assertEqual(result['fields'],['displacement','vonMises','principalMax','principalMin','shear',
                                               'strain','strainMax','strainMin'])
            v=fields(folder);xyz=v['points']
            # Surface nodes near mid-span, away from the side edges.
            mid=(np.abs(xyz[:,0]-50)<6)&(np.abs(xyz[:,1]-10)<6)
            top=mid&np.isclose(xyz[:,2],10);bottom=mid&np.isclose(xyz[:,2],0)
            self.assertGreater(top.sum(),2);self.assertGreater(bottom.sum(),2)
            # σ = M c / I at each node: 100 N × (100 − x) × 5 mm / 1666.7 mm⁴;
            # compare the mean over the band with the moment at its mean x.
            sigma=100*(100-xyz[top,0].mean())*5/(20*10**3/12)
            self.assertLess(abs(v['principalMax'][top].mean()/sigma-1),.03)
            sigma_bottom=100*(100-xyz[bottom,0].mean())*5/(20*10**3/12)
            self.assertLess(abs(-v['principalMin'][bottom].mean()/sigma_bottom-1),.03)
            # Uniaxial at the surface: Tresca shear is half the stress.
            self.assertLess(abs(v['shear'][top].mean()/(sigma/2)-1),.03)
            # Surface strain along the beam is σ/E, sideways −νσ/E.
            strain=sigma/68900*1e6
            self.assertLess(abs(v['strainMax'][top].mean()/strain-1),.03)
            self.assertLess(abs(-v['strainMin'][top].mean()/(.33*strain)-1),.05)

if __name__=='__main__':unittest.main()
