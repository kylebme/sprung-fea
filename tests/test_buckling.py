"""Linear buckling through real CalculiX solves, checked against Euler."""
import unittest, sys, tempfile, shutil, math
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import worker
ROOT=Path(__file__).resolve().parents[1]
E=68900;L=100;I_weak=20*10**3/12;I_strong=10*20**3/12

def study(vector=(-1000,0,0),**changes):
    return {'analysis':'buckling','material':{'name':'Al','young':E,'poisson':.33,'density':2700,'yield':276},
            'supports':[{'faces':[1],'axes':[True]*3}],'loads':[{'kind':'force','faces':[2],'vector':list(vector)}],
            'masses':[],'meshSize':4,'modes':3,**changes}

class Buckling(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        shutil.copy(ROOT/'samples/beam.step',cls.folder/'part.step')
        worker.import_part(cls.folder)
        worker.mesh_part(cls.folder,study())
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def test_fixed_free_column_buckles_at_the_euler_load(self):
        result=worker.solve(self.folder,study())
        factors=result['summary']['factors']
        # P = π²EI/(4L²) about the thin, then the thick direction.
        self.assertLess(abs(factors[0]*1000/(math.pi**2*E*I_weak/(4*L**2))-1),.02)
        self.assertLess(abs(factors[1]*1000/(math.pi**2*E*I_strong/(4*L**2))-1),.04)
        self.assertEqual(result['keys'][0]['value'],factors[0])
        self.assertEqual([f['label'] for f in result['frames']],['Mode 1','Mode 2','Mode 3'])
        # 28 × the 5 MPa axial stress stays below yield: no yield warning.
        self.assertFalse(any('yields before' in w for w in result['warnings']))

    def test_overload_and_yield_before_buckling_are_flagged(self):
        result=worker.solve(self.folder,study((-40000,0,0)))
        self.assertLess(result['summary']['firstFactor'],1)
        self.assertTrue(any('buckles under the applied loads' in w for w in result['warnings']))
        # With a 100 MPa yield strength, 28 × the 6 MPa peak exceeds it.
        s=study();s['material']={**s['material'],'yield':100}
        result=worker.solve(self.folder,s)
        self.assertTrue(any('yields before it buckles' in w for w in result['warnings']))

    def test_tension_reports_reversed_buckling(self):
        result=worker.solve(self.folder,study((1000,0,0)))
        self.assertTrue(all(f<0 for f in result['summary']['factors']))
        self.assertIsNone(result['summary']['firstFactor'])
        self.assertEqual(result['keys'],[])
        self.assertTrue(any('reversed' in w for w in result['warnings']))

if __name__=='__main__':unittest.main()
