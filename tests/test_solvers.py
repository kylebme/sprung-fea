"""Direct solvers and threads: real CalculiX solves on the beam, on one mesh.

Threads must not change answers beyond round-off, and the two direct
solvers (Apple Accelerate through CalculiX's PARDISO interface, where the
solver build has it, and SPOOLES) must agree. SPOOLES 2.2 as released loses
updates between threads on Apple silicon and returns wrong answers, so a
threaded SPOOLES solve is compared too."""
import unittest, sys, os, tempfile, shutil
from pathlib import Path
from unittest import mock
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import worker, calculix
ROOT=Path(__file__).resolve().parents[1]
MATERIAL={'name':'Al','young':68900,'poisson':.33,'density':2700,'yield':276}

def study(**changes):
    return {'material':MATERIAL,'supports':[{'faces':[1],'axes':[True]*3}],
            'loads':[{'kind':'force','faces':[2],'vector':[300,-200,-100]},{'kind':'gravity','faces':[],'vector':[0,0,-9.81]}],
            'masses':[],'meshSize':2,**changes}

def solve(folder, s, threads, direct=None):
    env={'SPRUNG_FEA_THREADS':str(threads)}
    if direct: env['SPRUNG_FEA_DIRECT_SOLVER']=direct
    with mock.patch.dict(os.environ,env):
        return worker.solve(folder,s)

class DirectSolvers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        shutil.copy(ROOT/'samples/beam.step',cls.folder/'part.step')
        worker.import_part(cls.folder)
        cls.mesh=worker.mesh_part(cls.folder,study())
        cls.serial=solve(cls.folder,study(),1,'spooles')
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    # The .frd file carries six significant digits, so answers that agree
    # to round-off can still differ in a value's last printed digit.
    def assertSameAnswer(self, result, reference, rtol=1e-6):
        scale=np.abs(reference['displacements']).max()
        np.testing.assert_allclose(result['displacements'],reference['displacements'],rtol=0,atol=rtol*scale)
        np.testing.assert_allclose(result['stress'],reference['stress'],rtol=0,atol=rtol*np.abs(reference['stress']).max())
        np.testing.assert_allclose(result['summary']['reactions'],reference['summary']['reactions'],rtol=0,atol=rtol*np.abs(reference['summary']['reactions']).max())

    def test_the_mesh_is_reused_while_it_still_applies(self):
        saved=self.folder/'mesh.json';made=saved.stat().st_mtime_ns
        # Loads do not shape the mesh.
        again=worker.mesh_part(self.folder,{**study(),'loads':[]})
        self.assertEqual(saved.stat().st_mtime_ns,made)
        self.assertEqual(again['elements'],self.mesh['elements'])
        self.assertEqual((self.folder/'view.bin').read_bytes()[:8],b'SFEAVIEW')
        # The element size does.
        coarser=worker.mesh_part(self.folder,study(meshSize=4))
        self.assertLess(coarser['elementCount'],self.mesh['elementCount'])
        # Back on a solve mesh for the other tests.
        self.__class__.mesh=worker.mesh_part(self.folder,study())
        self.__class__.serial=solve(self.folder,study(),1,'spooles')

    def test_threaded_spooles_matches_one_thread(self):
        if not calculix.capabilities().get('threadSafeSpooles'):
            self.skipTest('This CalculiX build runs SPOOLES on one thread.')
        # Unpatched, about one solve in four here goes wrong.
        for _ in range(8):
            threaded=solve(self.folder,study(),8,'spooles')
            self.assertIn('SPOOLES',threaded['solver'])
            self.assertSameAnswer(threaded,self.serial)

    def test_accelerate_matches_spooles(self):
        if not calculix.capabilities().get('pardiso'):
            self.skipTest('This CalculiX build has no PARDISO-interface solver.')
        first=solve(self.folder,study(),8)
        self.assertIn('Accelerate',first['solver'])
        self.assertIn('SOLVER=PARDISO',(self.folder/'analysis.inp').read_text())
        self.assertSameAnswer(first,self.serial)
        self.assertSameAnswer(solve(self.folder,study(),1),self.serial)
        # Equilibrium to the six digits the .frd file keeps.
        self.assertLess(first['summary']['forceBalanceError'],1e-5)

    def test_eigenvalue_analyses_agree_across_direct_solvers(self):
        if not calculix.capabilities().get('pardiso'):
            self.skipTest('This CalculiX build has no PARDISO-interface solver.')
        for analysis,key in [('frequency','frequencies'),('buckling','factors')]:
            with self.subTest(analysis=analysis):
                s=study(analysis=analysis,modes=4)
                if analysis=='frequency': s['loads']=[]
                fast=solve(self.folder,s,8)['summary'][key]
                reference=solve(self.folder,s,1,'spooles')['summary'][key]
                np.testing.assert_allclose(fast,reference,rtol=1e-7)
