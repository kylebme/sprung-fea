"""Direct solvers and threads: real CalculiX solves on the beam, on one mesh.

Threads must not change answers beyond round-off, and every direct solver
the solver build has (PARDISO: Apple Accelerate, or an installed Intel MKL;
PaStiX; SPOOLES) must agree. SPOOLES 2.2 as released loses updates between
threads on Apple silicon and returns wrong answers, so a threaded SPOOLES
solve is compared too."""
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
    # to round-off can still differ in a value's last printed digit: up to
    # 1e-5 of the largest value. Threaded factorizations (MKL's) are not
    # bit-reproducible, so such a flip comes and goes between runs.
    def assertSameAnswer(self, result, reference, rtol=1e-5):
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

    def faster_solvers(self):
        found={n:d for n,d in calculix.direct_solvers().items() if n!='spooles'}
        if not found: self.skipTest('This CalculiX build has only SPOOLES.')
        return found

    def test_direct_solvers_match_spooles(self):
        for name,description in self.faster_solvers().items():
            with self.subTest(solver=name):
                first=solve(self.folder,study(),8,name)
                self.assertIn(description,first['solver'])
                self.assertIn('SOLVER='+calculix.DIRECT[name],(self.folder/'analysis.inp').read_text())
                self.assertSameAnswer(first,self.serial)
                self.assertSameAnswer(solve(self.folder,study(),1,name),self.serial)
                # Equilibrium to the six digits the .frd file keeps.
                self.assertLess(first['summary']['forceBalanceError'],1e-5)

    def test_the_fastest_solver_is_the_default(self):
        fastest=next(iter(self.faster_solvers()))
        self.assertIn(calculix.direct_solvers()[fastest],solve(self.folder,study(),8)['solver'])

    def test_eigenvalue_analyses_agree_across_direct_solvers(self):
        # PaStiX is not used for eigenvalues (calculix.direct_solver).
        names=[n for n in self.faster_solvers() if n!='pastix']
        if not names: self.skipTest('This CalculiX build has no PARDISO-interface solver.')
        for analysis,key in [('frequency','frequencies'),('buckling','factors')]:
            for name in names:
                with self.subTest(analysis=analysis,solver=name):
                    s=study(analysis=analysis,modes=4)
                    if analysis=='frequency': s['loads']=[]
                    fast=solve(self.folder,s,8,name)['summary'][key]
                    reference=solve(self.folder,s,1,'spooles')['summary'][key]
                    # ARPACK iterates each eigenvalue to its own tolerance:
                    # factorizations that differ by round-off (threaded MKL's
                    # vary run to run) move it a few units in the 7th digit.
                    np.testing.assert_allclose(fast,reference,rtol=1e-6)

    def test_eigenvalue_analyses_pass_over_pastix(self):
        if 'pastix' not in calculix.direct_solvers(): self.skipTest('This CalculiX build has no PaStiX.')
        s=study(analysis='frequency',modes=4,loads=[])
        result=solve(self.folder,s,8,'pastix')
        self.assertNotIn('SOLVER=PASTIX',(self.folder/'analysis.inp').read_text())
        np.testing.assert_allclose(result['summary']['frequencies'],
                                   solve(self.folder,s,1,'spooles')['summary']['frequencies'],rtol=1e-6)


class NonlinearContact(unittest.TestCase):
    """A nonlinear, nonsymmetric system: the bolted lap joint tightened, then
    pulled, with friction. Its increments refactor one matrix structure
    every iteration, which the PaStiX and PARDISO interfaces keep the
    ordering of. Every direct solver must reach the same state."""

    def test_every_direct_solver_reaches_the_same_state(self):
        sys.path.insert(0,str(Path(__file__).resolve().parent))
        import test_contact as joint
        names=list(calculix.direct_solvers())
        if len(names)<2: self.skipTest('This CalculiX build has only SPOOLES.')
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);shutil.copy(ROOT/'samples/bolted-joint.step',folder/'part.step')
            worker.import_part(folder)
            s=joint.study([{'kind':'force','faces':[joint.LOADED],'vector':[3000,0,0]}])
            worker.mesh_part(folder,s)
            results={n:solve(folder,s,8,n) for n in names}
        reference=results.pop('spooles')
        scale=np.abs(reference['displacements']).max()
        for name,result in results.items():
            with self.subTest(solver=name):
                self.assertIn(calculix.direct_solvers()[name],result['solver'])
                # Within the nonlinear iterations' own tolerance.
                np.testing.assert_allclose(result['displacements'],reference['displacements'],rtol=0,atol=1e-3*scale)
                for bolt,expected in zip(result['summary']['bolts'],reference['summary']['bolts']):
                    self.assertAlmostEqual(bolt['tightened'],expected['tightened'],delta=1e-3*bolt['preload'])
                    self.assertAlmostEqual(bolt['loaded'],expected['loaded'],delta=1e-3*bolt['preload'])
                for c in result['summary']['contacts']:
                    expected=next(e for e in reference['summary']['contacts'] if e['id']==c['id'])
                    self.assertEqual(c['state'],expected['state'])
                    self.assertAlmostEqual(c['normal'],expected['normal'],delta=1e-3*20000)
