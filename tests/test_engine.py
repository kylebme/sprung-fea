"""Subsystem acceptance tests using real STEP, Gmsh, and CalculiX."""
import unittest, sys, tempfile, shutil, json, copy, math
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import worker
ROOT=Path(__file__).resolve().parents[1]

def study(load=None,size=4):
    return {'material':{'name':'Aluminum','young':68900,'poisson':.33,'density':2700,'yield':276},
            'supports':[{'faces':[1],'axes':[True,True,True]}],
            'loads':[load or {'kind':'force','faces':[2],'vector':[0,0,-100]}], 'meshSize':size}

class Pipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        shutil.copy(ROOT/'samples/beam.step',cls.folder/'part.step')
        cls.geo=worker.import_part(cls.folder)
        cls.mesh=worker.mesh_part(cls.folder,study())
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()
    def test_step_length_units_are_converted_to_mm(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp)
            source=(ROOT/'samples/beam.step').read_text()
            self.assertIn('SI_UNIT(.MILLI.,.METRE.)',source)
            (folder/'part.step').write_text(source.replace('SI_UNIT(.MILLI.,.METRE.)','SI_UNIT($,.METRE.)'))
            geo=worker.import_part(folder)
            np.testing.assert_allclose(geo['dimensions'],[100000,20000,10000],rtol=1e-6)
    def test_repeat_solves_are_reproducible(self):
        first=worker.solve(self.folder,study())
        for _ in range(8):
            again=worker.solve(self.folder,study())
            np.testing.assert_allclose(again['movement'],first['movement'],rtol=1e-10,atol=1e-12)
            np.testing.assert_allclose(again['stress'],first['stress'],rtol=1e-10,atol=1e-12)
    def test_loads_on_supported_nodes_report_real_reactions(self):
        s=study({'kind':'force','faces':[1],'vector':[0,0,-100]})
        result=worker.solve(self.folder,s)
        self.assertAlmostEqual(result['summary']['reactions'][2],100,delta=.001)
        self.assertLess(result['summary']['maxMovement'],1e-10)
    def test_overlapping_pressures_add(self):
        s=study({'kind':'pressure','faces':[2],'magnitude':2})
        s['loads'].append({'kind':'pressure','faces':[2],'magnitude':3})
        result=worker.solve(self.folder,s)
        self.assertAlmostEqual(result['summary']['reactions'][0],1000,delta=.02)
    def test_step_face_identity_survives_remeshing(self):
        self.assertEqual([f['id'] for f in self.geo['faces']],[f['id'] for f in self.mesh['surface']['faces']])
        np.testing.assert_allclose(self.geo['dimensions'],[100,20,10],atol=1e-5)
        self.assertAlmostEqual(self.geo['volume'],20000)
        self.assertGreater(self.mesh['minQuality'],0)
        self.assertEqual(len(self.mesh['elements'][0]),10)
    def test_cantilever_bending_and_reaction_balance(self):
        result=worker.solve(self.folder,study())
        expected=100*100**3/(3*68900*(20*10**3/12))
        self.assertLess(abs(result['summary']['maxMovement']/expected-1),.04)
        np.testing.assert_allclose(result['summary']['reactions'],[0,0,100],atol=.01)
        self.assertGreater(result['summary']['maxStress'],20)
    def test_axial_extension(self):
        result=worker.solve(self.folder,study({'kind':'force','faces':[2],'vector':[1000,0,0]}))
        nodes=np.asarray(self.mesh['surface']['positions']).reshape(-1,3)
        end=np.isclose(nodes[:,0],100)
        ux=np.asarray(result['displacements'])[end,0].mean()
        expected=1000*100/(200*68900)
        self.assertLess(abs(ux/expected-1),.015)
        self.assertAlmostEqual(result['summary']['reactions'][0],-1000,delta=.02)
    def test_pressure_faces_and_sign(self):
        result=worker.solve(self.folder,study({'kind':'pressure','faces':[2],'magnitude':5}))
        self.assertAlmostEqual(result['summary']['reactions'][0],1000,delta=.02)
        nodes=np.asarray(self.mesh['surface']['positions']).reshape(-1,3)
        end=np.isclose(nodes[:,0],100)
        ux=np.asarray(result['displacements'])[end,0].mean()
        self.assertAlmostEqual(ux,-1000*100/(200*68900),delta=.00015)
    def test_gravity_density_units(self):
        result=worker.solve(self.folder,study({'kind':'gravity','faces':[],'vector':[0,0,-9.81]}))
        self.assertAlmostEqual(result['summary']['reactions'][2],.02*.0027*1000*9.81,delta=.002)
    def test_force_is_total_over_multiple_faces(self):
        s=study({'kind':'force','faces':[2,6],'vector':[20,-30,-40]})
        worker.write_deck(self.folder,s,self.mesh)
        lines=(self.folder/'analysis.inp').read_text().splitlines();start=lines.index('*CLOAD')+1
        force=np.zeros(3)
        for line in lines[start:]:
            if line.startswith('*'):break
            node,axis,value=line.split(',');force[int(axis)-1]+=float(value)
        np.testing.assert_allclose(force,[20,-30,-40],atol=1e-8)
    def test_rigid_motion_is_rejected(self):
        s=study();s['supports'][0]['axes']=[False,False,True]
        with self.assertRaisesRegex(ValueError,'still move freely'):worker.validate(s,self.mesh)
    def test_directional_supports_can_stabilize(self):
        s=study();s['supports']=[{'faces':[1],'axes':[True,False,False]},{'faces':[3],'axes':[False,True,False]},{'faces':[5],'axes':[False,False,True]}]
        worker.validate(s,self.mesh)
    def test_bad_inputs_rejected(self):
        for change in ['face','poisson','zero','nan','repeat']:
            s=study()
            if change=='face':s['loads'][0]['faces']=[999]
            if change=='poisson':s['material']['poisson']=.5
            if change=='zero':s['loads'][0]['vector']=[0,0,0]
            if change=='nan':s['material']['young']=float('nan')
            if change=='repeat':s['loads'][0]['faces']=[2,2]
            with self.subTest(change=change),self.assertRaises(ValueError):worker.validate(s,self.mesh)
    def test_refinement_keeps_deflection_stable(self):
        before=worker.solve(self.folder,study())
        fine=worker.mesh_part(self.folder,study(size=2.8))
        after=worker.solve(self.folder,study(size=2.8))
        self.assertGreater(fine['elementCount'],self.mesh['elementCount'])
        self.assertLess(abs(after['summary']['maxMovement']/before['summary']['maxMovement']-1),.02)
        (self.folder/'mesh.json').write_text(json.dumps(self.mesh))
    def test_bracket_curved_faces_and_pressure(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);shutil.copy(ROOT/'samples/bracket.step',folder/'part.step')
            geo=worker.import_part(folder)
            self.assertTrue(any(f['type']=='Cylinder' for f in geo['faces']))
            held=min(geo['faces'],key=lambda f:f['center'][0]);load=max(geo['faces'],key=lambda f:f['center'][0])
            s=study({'kind':'pressure','faces':[load['id']],'magnitude':1});s['supports'][0]['faces']=[held['id']];s['meshSize']=5
            mesh=worker.mesh_part(folder,s);result=worker.solve(folder,s)
            self.assertGreater(result['summary']['maxMovement'],0)
            self.assertGreater(mesh['minQuality'],0)
            self.assertTrue(math.isfinite(result['summary']['maxStress']))

if __name__=='__main__':unittest.main()
