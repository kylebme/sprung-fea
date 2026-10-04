"""Steady heat transfer and thermal stress through real CalculiX solves,
checked against one-dimensional solutions."""
import unittest, sys, tempfile, shutil, json
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import worker
ROOT=Path(__file__).resolve().parents[1]
k=167;alpha=23.6e-6;E=68900
MATERIAL={'name':'Al','young':E,'poisson':.33,'density':2700,'yield':276,'conductivity':k,'expansion':23.6}

def heat(*conditions,**changes):
    return {'analysis':'thermal','material':MATERIAL,'supports':[],'loads':[],'masses':[],'meshSize':4,
            'thermal':[{'id':str(i),'name':c['kind'],'faces':[],**c} for i,c in enumerate(conditions)],**changes}

# Planes that allow free expansion: x = 0 in X, y = 0 in Y, z = 0 in Z.
SLIDING=[{'faces':[1],'axes':[True,False,False]},{'faces':[3],'axes':[False,True,False]},{'faces':[5],'axes':[False,False,True]}]

class Thermal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        shutil.copy(ROOT/'samples/beam.step',cls.folder/'part.step')
        worker.import_part(cls.folder)
        cls.mesh=worker.mesh_part(cls.folder,heat())
        cls.x=np.asarray(cls.mesh['surface']['positions']).reshape(-1,3)[:,0]
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def temperatures(self):
        data=(self.folder/'view.bin').read_bytes()
        n=int(np.frombuffer(data[8:12],'<u4')[0]);header=json.loads(data[12:12+n]);offset=12+n
        for a in header['arrays']:
            dtype={'float64':'<f8','int32':'<i4'}[a['type']];count=int(np.prod(a['shape']))
            if a['name']=='temperature': return np.frombuffer(data,dtype,count,offset)
            offset+=-(-count*np.dtype(dtype).itemsize//8)*8

    def test_conduction_through_a_bar(self):
        result=worker.solve(self.folder,heat({'kind':'temperature','faces':[1],'value':20},{'kind':'temperature','faces':[2],'value':120}))
        # Linear profile, and q = kAΔT/L = 167 × 2e-4 m² × 100 K / 0.1 m.
        np.testing.assert_allclose(self.temperatures(),20+self.x,atol=1e-3)
        b=result['summary']['heatBalance']
        self.assertAlmostEqual(b['in'],33.4,places=3);self.assertAlmostEqual(b['out'],33.4,places=3)
        self.assertLess(b['error'],1e-6)

    def test_generation_with_one_cooled_end(self):
        # q''' = 5 W / 20 cm³, one end at 20 °C, the rest insulated:
        # T(L) = T0 + q'''L²/(2k), exact for quadratic elements.
        result=worker.solve(self.folder,heat({'kind':'generation','value':5},{'kind':'temperature','faces':[1],'value':20}))
        q=5/2e-5
        self.assertAlmostEqual(result['summary']['maxTemperature'],20+q*.1**2/(2*k),places=4)
        self.assertLess(result['summary']['heatBalance']['error'],1e-6)

    def test_heat_flow_leaves_by_convection(self):
        result=worker.solve(self.folder,heat({'kind':'heat','faces':[2],'value':10},
                                             {'kind':'convection','faces':[1,3,4,5,6],'value':25,'ambient':20}))
        b=result['summary']['heatBalance']
        self.assertAlmostEqual(b['out'],10,places=4)
        self.assertLess(b['error'],1e-5)
        # The heated end is the hottest; nothing drops below the air.
        T=self.temperatures()
        self.assertAlmostEqual(T.max(),T[np.isclose(self.x,100)].max())
        self.assertGreater(T.min(),20)

    def test_free_expansion_has_no_stress(self):
        s=heat({'kind':'temperature','faces':[1,2,3,4,5,6],'value':120},analysis='thermalStress',supports=SLIDING)
        result=worker.solve(self.folder,s)
        u=np.asarray(result['displacements'])
        np.testing.assert_allclose(u[np.isclose(self.x,100),0],alpha*100*100,rtol=1e-9)
        self.assertLess(result['summary']['maxStress'],1e-6)
        # At the stress-free temperature nothing moves.
        result=worker.solve(self.folder,{**s,'referenceTemperature':120})
        self.assertLess(result['summary']['maxMovement'],1e-12)

    def test_blocked_expansion_stresses_the_bar(self):
        s=heat({'kind':'temperature','faces':[1,2,3,4,5,6],'value':120},analysis='thermalStress',
               supports=SLIDING+[{'faces':[2],'axes':[True,False,False]}])
        result=worker.solve(self.folder,s)
        # Uniaxial: σ = EαΔT, and the end reactions cancel.
        np.testing.assert_allclose(result["stress"],E*alpha*100,rtol=1e-4)  # .frd keeps 5 significant digits
        self.assertLess(result['summary']['forceBalanceError'],1e-6)
        self.assertTrue(any('exceeds the material yield' in w for w in result['warnings'])==(E*alpha*100>276))

    def test_thermal_and_mechanical_loads_combine(self):
        s=heat({'kind':'temperature','faces':[1],'value':20},{'kind':'temperature','faces':[2],'value':120},
               analysis='thermalStress',supports=[{'faces':[1],'axes':[True]*3}],
               loads=[{'kind':'force','faces':[2],'vector':[0,0,-100]}])
        result=worker.solve(self.folder,s)
        np.testing.assert_allclose(result['summary']['reactions'],[0,0,100],atol=.01)
        self.assertGreater(result['summary']['maxTemperature'],119.99)

    def test_invalid_thermal_studies(self):
        mesh=json.loads((self.folder/'mesh.json').read_text())
        cases=[(heat({'kind':'heat','faces':[2],'value':10}),'leave the part'),
               (heat({'kind':'temperature','faces':[1],'value':20},material={**MATERIAL,'conductivity':None}),'conductivity'),
               (heat({'kind':'temperature','faces':[1],'value':20},analysis='thermalStress',supports=SLIDING,
                     material={**MATERIAL,'expansion':None}),'expansion'),
               (heat({'kind':'convection','faces':[1],'value':-5,'ambient':20}),'Film coefficient'),
               (heat({'kind':'temperature','faces':[1],'value':20},analysis='thermalStress'),'support')]
        for s,message in cases:
            with self.subTest(message=message),self.assertRaisesRegex(ValueError,message):
                worker.write_deck(self.folder,s,mesh)

if __name__=='__main__':unittest.main()
