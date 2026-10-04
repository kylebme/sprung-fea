"""Elastic–plastic material through real CalculiX solves: a bar pulled past
yield, then released."""
import unittest, sys, tempfile, shutil, json
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
sys.path.insert(0,str(Path(__file__).resolve().parent))
import worker
ROOT=Path(__file__).resolve().parents[1]
E=68900;Sy=276;Su=310;elongation=12
MATERIAL={'name':'Aluminum','young':E,'poisson':.33,'density':2700,'yield':Sy,'ultimate':Su,'elongation':elongation}
# Bilinear hardening slope: ultimate at the plastic part of the elongation.
H=(Su-Sy)/(elongation/100-Su/E)
# Planes that let the bar contract sideways freely.
SLIDING=[{'faces':[1],'axes':[True,False,False]},{'faces':[3],'axes':[False,True,False]},{'faces':[5],'axes':[False,False,True]}]

def study(stress,**changes):
    return {'material':MATERIAL,'supports':SLIDING,'loads':[{'kind':'force','faces':[2],'vector':[stress*200,0,0]}],
            'masses':[],'meshSize':4,'plasticity':True,**changes}

class Plasticity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        shutil.copy(ROOT/'samples/beam.step',cls.folder/'part.step')
        worker.import_part(cls.folder)
        mesh=worker.mesh_part(cls.folder,study(100))
        cls.end=np.isclose(np.asarray(mesh['surface']['positions']).reshape(-1,3)[:,0],100)
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def test_bar_beyond_yield_and_its_permanent_stretch(self):
        stress=1.05*Sy
        result=worker.solve(self.folder,study(stress,unload=True))
        plastic=(stress-Sy)/H
        # Uniform plastic strain, the loaded stretch, then the set left.
        np.testing.assert_allclose(result['peeq'],plastic,rtol=1e-3)
        self.assertAlmostEqual(result['summary']['maxPlastic'],plastic,delta=1e-4)
        u=np.asarray(result['displacements'])[self.end,0].mean()
        self.assertAlmostEqual(u,(stress/E+plastic)*100,delta=2e-3)
        # After unloading the bar keeps its plastic stretch along X (the
        # reported magnitude adds the matching sideways contraction).
        from test_stress import fields
        view=fields(self.folder)
        last=max(int(k.split('@')[1]) for k in view if k.startswith('displacement@'))
        self.assertAlmostEqual(view[f'displacement@{last}'][self.end,0].mean(),plastic*100,delta=2e-3)
        self.assertLess(abs(result['summary']['permanentSet']/(plastic*100)-1),.01)
        self.assertEqual(result['frames'][-1]['label'],'Unloaded')
        self.assertEqual(result['fields'][-1],'peeq')
        np.testing.assert_allclose(result['summary']['reactions'],[-stress*200,0,0],rtol=1e-4,atol=.05)
        self.assertIn('*PLASTIC',(self.folder/'analysis.inp').read_text())

    def test_below_yield_matches_the_elastic_answer(self):
        result=worker.solve(self.folder,study(.5*Sy))
        self.assertEqual(result['summary']['maxPlastic'],0)
        self.assertTrue(any('does not yield' in w for w in result['warnings']))
        u=np.asarray(result['displacements'])[self.end,0].mean()
        self.assertAlmostEqual(u,.5*Sy/E*100,delta=1e-4)

    def test_beyond_ultimate_strength_the_bar_cannot_carry_the_load(self):
        with self.assertRaisesRegex(ValueError,'could not be applied'):
            worker.solve(self.folder,study(1.2*Sy))

    def test_elastic_studies_point_to_plasticity(self):
        result=worker.solve(self.folder,study(1.05*Sy,plasticity=False))
        self.assertTrue(any('turn on Plasticity' in w for w in result['warnings']))

    def test_plasticity_needs_strength_data(self):
        mesh=json.loads((self.folder/'mesh.json').read_text())
        for material,message in [({**MATERIAL,'ultimate':None},'ultimate strength'),
                                 ({**MATERIAL,'ultimate':200},'above its yield'),
                                 ({**MATERIAL,'elongation':.1},'elongation')]:
            with self.subTest(message=message),self.assertRaisesRegex(ValueError,message):
                worker.write_deck(self.folder,study(100,material=material),mesh)

if __name__=='__main__':unittest.main()
