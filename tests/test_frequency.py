"""Natural frequencies through real CalculiX eigenvalue solves, checked
against beam theory."""
import unittest, sys, tempfile, shutil, math
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import worker
from convergence import converge
ROOT=Path(__file__).resolve().parents[1]
E=68900e6;rho=2700;L=.1;A=20e-3*10e-3
EI_weak=E*20e-3*10e-3**3/12;EI_strong=E*10e-3*20e-3**3/12
beam_mass=rho*A*L

def bending(EI,beta):
    """Euler–Bernoulli bending frequency, Hz, for the mode constant βL."""
    return beta**2/(2*math.pi)*math.sqrt(EI/(rho*A*L**4))

def study(**changes):
    return {'analysis':'frequency','material':{'name':'Al','young':68900,'poisson':.33,'density':2700,'yield':276},
            'supports':[{'faces':[1],'axes':[True]*3}],'loads':[],'masses':[],'meshSize':4,'modes':4,**changes}

class Frequency(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        shutil.copy(ROOT/'samples/beam.step',cls.folder/'part.step')
        worker.import_part(cls.folder)
        worker.mesh_part(cls.folder,study())
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def test_cantilever_bending_frequencies(self):
        result=worker.solve(self.folder,study())
        f=result['summary']['frequencies']
        self.assertEqual(len(f),4)
        # First bending about the thin and thick directions (βL = 1.875).
        self.assertLess(abs(f[0]/bending(EI_weak,1.8751)-1),.01)
        self.assertLess(abs(f[1]/bending(EI_strong,1.8751)-1),.03)
        self.assertEqual([x['label'] for x in result['frames']],['Mode 1','Mode 2','Mode 3','Mode 4'])
        # Mode 1 moves in Z: most of its effective mass is in Z.
        x,y,z=result['summary']['effectiveMass'][0]
        self.assertGreater(z,.5);self.assertLess(x+y,1e-6)
        # CalculiX counts only mass that can move: supported nodes' share
        # is left out of the total that effective masses are fractions of.
        self.assertLess(result['summary']['totalMass'],beam_mass)
        self.assertGreater(result['summary']['totalMass'],.98*beam_mass)
        self.assertEqual(result['keys'][0]['value'],f[0])

    def test_loads_are_ignored_and_not_required(self):
        s=study(loads=[{'kind':'force','faces':[2],'vector':[0,0,0]}])
        result=worker.solve(self.folder,s)
        self.assertGreater(result['summary']['frequencies'][0],800)

    def test_tip_mass_lowers_the_frequency(self):
        # 100 g at the free end: k = 3EI/L³ with 0.2235 of the beam's mass.
        s=study(masses=[{'id':'m','name':'Tip mass','faces':[2],'mass':.1,'point':[100,10,5]}])
        f=worker.solve(self.folder,s)['summary']['frequencies'][0]
        expected=math.sqrt(3*EI_weak/L**3/(.1+.2235*beam_mass))/(2*math.pi)
        self.assertLess(abs(f/expected-1),.01)
        # 50 mm beyond the end, on a rigid arm: the flexibility at the mass
        # is (L³/3 + aL² + a²L)/EI. Its inertia follows the face's rotation.
        a=.05
        s['masses'][0]['point']=[150,10,5]
        f=worker.solve(self.folder,s)['summary']['frequencies'][0]
        expected=math.sqrt(EI_weak/(L**3/3+a*L**2+a**2*L)/.1)/(2*math.pi)
        self.assertLess(abs(f/expected-1),.03)

    def test_free_part_reports_six_rigid_motions(self):
        result=worker.solve(self.folder,study(supports=[]))
        s=result['summary']
        self.assertEqual(s['rigidModes'],6)
        self.assertEqual([x['label'] for x in result['frames'][:6]],['Rigid motion']*6)
        self.assertTrue(all(f<1 for f in s['frequencies'][:6]))
        # First free–free bending, βL = 4.730; shear lowers it a few percent
        # at this length-to-depth ratio.
        self.assertLess(abs(s['frequencies'][6]/bending(EI_weak,4.7300)-1),.05)
        self.assertEqual(result['keys'][0]['value'],s['frequencies'][6])
        self.assertTrue(any('rigid motions' in w for w in result['warnings']))

    def test_invalid_frequency_studies(self):
        mesh=__import__('json').loads((self.folder/'mesh.json').read_text())
        for s,message in [(study(modes=0),'modes'),(study(material=None),'material'),
                          (study(masses=[{'id':'m','name':'M','faces':[1],'mass':1,'point':[0,10,5]}]),'fully supported')]:
            with self.subTest(message=message),self.assertRaisesRegex(ValueError,message):
                worker.write_deck(self.folder,s,mesh)

    def test_convergence_follows_the_first_frequency(self):
        _,result=converge(self.folder,study(),{'runs':2,'tolerance':.05})
        q=result['convergence']['quantities']
        self.assertEqual([x['id'] for x in q],['f1'])
        self.assertTrue(q[0]['converged'])
        worker.mesh_part(self.folder,study())

if __name__=='__main__':unittest.main()
