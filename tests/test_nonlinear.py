"""Large deformation (geometric nonlinearity) through real CalculiX solves."""
import unittest, sys, tempfile, shutil, json
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import worker
ROOT=Path(__file__).resolve().parents[1]
E=68900;I=20*10**3/12;L=100

def study(load,**changes):
    return {'material':{'name':'Al','young':E,'poisson':.33,'density':2700,'yield':None},
            'supports':[{'faces':[1],'axes':[True]*3}],'loads':[load],'masses':[],'meshSize':4,
            'largeDeformation':True,**changes}

class LargeDeformation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        shutil.copy(ROOT/'samples/beam.step',cls.folder/'part.step')
        worker.import_part(cls.folder)
        cls.mesh=worker.mesh_part(cls.folder,study({'kind':'force','faces':[2],'vector':[0,0,-1]}))
        cls.end=np.isclose(np.asarray(cls.mesh['surface']['positions']).reshape(-1,3)[:,0],L)
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def test_cantilever_elastica(self):
        # PL²/EI = 1: the tip moves 0.3017 L down and 0.0566 L inward
        # (Bisshopp and Drucker), where linear theory says 0.3333 L down.
        P=E*I/L**2
        result=worker.solve(self.folder,study({'kind':'force','faces':[2],'vector':[0,0,-P]}))
        tip=np.asarray(result['displacements'])[self.end].mean(0)/L
        self.assertLess(abs(-tip[2]/.3017-1),.02)
        self.assertLess(abs(-tip[0]/.0566-1),.03)
        values=[f['value'] for f in result['frames']]
        self.assertGreater(len(values),2)
        self.assertEqual(values,sorted(values));self.assertAlmostEqual(values[-1],100)
        self.assertTrue(all(f['label'].startswith('Load ') for f in result['frames']))
        # The load path stiffens: below the straight line from its start.
        chart=result['charts'][0]
        nonlinear,linear=(s['values'] for s in chart['series'])
        self.assertLess(nonlinear[-1],linear[-1])
        self.assertAlmostEqual(chart['x']['values'][-1],100)
        # A fixed-direction force: reactions still balance it.
        np.testing.assert_allclose(result['summary']['reactions'],[0,0,P],rtol=1e-4,atol=.05)

    def test_small_loads_match_linear_theory(self):
        load={'kind':'force','faces':[2],'vector':[0,0,-100]}
        nonlinear=worker.solve(self.folder,study(load))
        linear=worker.solve(self.folder,study(load,largeDeformation=False))
        self.assertLess(abs(nonlinear['summary']['maxMovement']/linear['summary']['maxMovement']-1),.005)
        self.assertEqual(len(linear['frames']),1)

    def test_follower_pressure_skips_force_balance(self):
        result=worker.solve(self.folder,study({'kind':'pressure','faces':[6],'magnitude':5}))
        labels=[c['label'] for c in result['checks']]
        self.assertNotIn('Force balance error',labels)
        self.assertTrue(any('follows the deformed surface' in w for w in result['warnings']))

    def test_linear_study_suggests_large_deformation(self):
        result=worker.solve(self.folder,study({'kind':'force','faces':[2],'vector':[0,0,-3000]},largeDeformation=False))
        self.assertTrue(any('Large deformation' in w for w in result['warnings']))

if __name__=='__main__':unittest.main()
