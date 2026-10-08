"""Direct solvers and threads: real CalculiX solves on the beam, on one mesh.

Threads must not change answers beyond round-off, and every direct solver
the solver build has (PARDISO: Apple Accelerate, or Intel oneMKL's in
sprung-solve; SPOOLES) must agree. SPOOLES 2.2 as released loses updates
between threads on Apple silicon and returns wrong answers, so a threaded
SPOOLES solve is compared too."""
import unittest, sys, os, tempfile, shutil, subprocess
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
        for analysis,key in [('frequency','frequencies'),('buckling','factors')]:
            for name in self.faster_solvers():
                with self.subTest(analysis=analysis,solver=name):
                    s=study(analysis=analysis,modes=4)
                    if analysis=='frequency': s['loads']=[]
                    fast=solve(self.folder,s,8,name)['summary'][key]
                    reference=solve(self.folder,s,1,'spooles')['summary'][key]
                    # ARPACK iterates each eigenvalue to its own tolerance:
                    # factorizations that differ by round-off (threaded MKL's
                    # vary run to run) move it a few units in the 7th digit.
                    np.testing.assert_allclose(fast,reference,rtol=1e-6)

    def test_a_free_part_has_six_rigid_modes_with_every_solver(self):
        # Unsupported, CalculiX factors K - M: six rigid-body directions far
        # below the elastic ones. Refined PARDISO solves once turned the
        # first elastic mode into a seventh rigid one.
        s=study(analysis='frequency',modes=4,supports=[],loads=[])
        reference=solve(self.folder,s,1,'spooles')['summary']
        self.assertEqual(reference['rigidModes'],6)
        for name in self.faster_solvers():
            with self.subTest(solver=name):
                found=solve(self.folder,s,8,name)['summary']
                self.assertEqual(found['rigidModes'],6)
                self.assertTrue(all(f<1 for f in found['frequencies'][:6]),found['frequencies'])
                np.testing.assert_allclose(found['frequencies'][6:],reference['frequencies'][6:],rtol=1e-4)

    def test_without_a_working_sprung_solve_spooles_solves(self):
        if not calculix.built_capabilities().get('pardisoHelper'):
            self.skipTest('PARDISO is not in sprung-solve here.')
        with mock.patch.dict(os.environ,{'SPRUNG_FEA_SOLVE':str(self.folder/'missing')}):
            self.assertEqual(list(calculix.direct_solvers()),['spooles'])
            result=solve(self.folder,study(),8)
        self.assertIn('SPOOLES',result['solver'])
        self.assertSameAnswer(result,self.serial)


class SprungSolve(unittest.TestCase):
    """sprung-solve on its own, as anyone can run it: Matrix Market systems,
    symmetric indefinite and unsymmetric, against NumPy's dense solve."""

    def test_it_solves_matrix_market_systems(self):
        helper=calculix.find_helper()
        if not helper: self.skipTest('There is no sprung-solve here.')
        rng=np.random.default_rng(1);n=300
        sparse=(rng.random((n,n))<0.02)*rng.standard_normal((n,n))
        symmetric=sparse+sparse.T+0.5*np.eye(n)
        unsymmetric=symmetric+0.3*np.triu(sparse)
        b=rng.standard_normal(n)
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp)
            (folder/'b.mtx').write_text(f'%%MatrixMarket matrix array real general\n{n} 1\n'+''.join(f'{v!r}\n' for v in b.tolist()))
            for name,matrix,kind in [('symmetric',symmetric,'symmetric'),('unsymmetric',unsymmetric,'general')]:
                with self.subTest(matrix=name):
                    rows,columns=np.nonzero(np.tril(matrix) if kind=='symmetric' else matrix)
                    lines=[f'{r+1} {c+1} {float(matrix[r,c])!r}' for r,c in zip(rows.tolist(),columns.tolist())]
                    (folder/'A.mtx').write_text(f'%%MatrixMarket matrix coordinate real {kind}\n{n} {n} {len(lines)}\n'+'\n'.join(lines)+'\n')
                    out=subprocess.run([helper,str(folder/'A.mtx'),str(folder/'b.mtx')],capture_output=True,text=True,check=True).stdout
                    np.testing.assert_allclose(np.array(out.split(),float),np.linalg.solve(matrix,b),rtol=0,atol=1e-9*np.abs(np.linalg.solve(matrix,b)).max())


class NonlinearContact(unittest.TestCase):
    """A nonlinear, nonsymmetric system: the bolted lap joint tightened, then
    pulled, with friction. Its increments refactor one matrix structure
    every iteration, which the PARDISO interfaces keep the ordering of.
    Every direct solver must reach the same state."""

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
