"""Direct solvers and threads: real CalculiX solves on the beam, on one mesh.

Threads must not change answers beyond round-off, and every direct solver
the solver build has (PARDISO: Apple Accelerate, or Intel oneMKL's in
sprung-solve; SPOOLES) must agree. SPOOLES 2.2 as released loses updates
between threads on Apple silicon and returns wrong answers, so a threaded
SPOOLES solve is compared too. So must sprung-solve's conjugate gradients
with BoomerAMG (hypre), where the build has it."""
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

    def test_iterative_is_the_best_iterative_solver_here(self):
        # A study chooses direct or iterative, and gets the best of each this
        # computer has: CG with BoomerAMG where sprung-solve carries hypre,
        # else CalculiX's incomplete Cholesky.
        options=calculix.solver_options()
        amg=options['iterativeThreaded']
        self.assertEqual(amg,bool(calculix.capabilities().get('amg')))
        self.assertEqual(options['direct'],calculix.direct_solver()[1])
        result=solve(self.folder,study(solver='iterative'),8)
        self.assertIn(options['iterative'] if amg else 'incomplete Cholesky',result['solver'])
        self.assertGreater(result['iterations'],0)
        if amg: self.assertSameAnswer(result,self.serial)
        # The GPU applies to multigrid alone; asked for elsewhere, the CPU solves.
        with mock.patch.dict(os.environ,{'SPRUNG_FEA_DEVICE':'gpu'}):
            direct=solve(self.folder,study(),8)
        self.assertNotIn('GPU',direct['solver'])

    def test_cg_with_algebraic_multigrid_matches_spooles(self):
        if not calculix.capabilities().get('amg'): self.skipTest('This CalculiX build has no hypre.')
        result=solve(self.folder,study(solver='iterative-amg'),8)
        self.assertIn('BoomerAMG',result['solver'])
        self.assertIn('SOLVER=PARDISO',(self.folder/'analysis.inp').read_text())
        log=(self.folder/'solver.log').read_text()
        # Each direction coarsened apart: CalculiX told the client its numbering.
        self.assertIn('3 unknowns a node',log)
        self.assertGreater(result['iterations'],0)
        # Converged to 1e-8, CG gives the direct answer to the .frd's digits.
        self.assertSameAnswer(result,self.serial)
        self.assertLess(result['summary']['forceBalanceError'],1e-5)
        # Other analyses factor shifted, indefinite matrices: always direct.
        frequency=solve(self.folder,study(solver='iterative-amg',analysis='frequency',modes=2,loads=[]),8)
        self.assertNotIn('BoomerAMG',frequency['solver'])

    def test_without_a_working_sprung_solve_spooles_solves(self):
        if not calculix.built_capabilities().get('pardisoHelper'):
            self.skipTest('PARDISO is not in sprung-solve here.')
        with mock.patch.dict(os.environ,{'SPRUNG_FEA_SOLVE':str(self.folder/'missing')}):
            self.assertEqual(list(calculix.direct_solvers()),['spooles'])
            result=solve(self.folder,study(),8)
        self.assertIn('SPOOLES',result['solver'])
        self.assertSameAnswer(result,self.serial)


class AlgebraicMultigrid(unittest.TestCase):
    """CG with BoomerAMG on systems less tidy than the beam's, and its
    failure, through real CalculiX solves."""
    def setUp(self):
        if not calculix.capabilities().get('amg'): self.skipTest('This CalculiX build has no hypre.')

    def test_pinned_holes_solve_as_with_the_direct_solver(self):
        # Holes pinned in a cylindrical frame: *EQUATION constraints remove
        # one or two directions of a node, so equations no longer come in
        # threes, and the bracket is held only just enough.
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);shutil.copy(ROOT/'samples/bracket.step',folder/'part.step')
            geo=worker.import_part(folder)
            s={'material':MATERIAL,'supports':[{'faces':[6,7],'axes':[True,False,True],'frame':'cylinder'}],
               'loads':[{'kind':'force','faces':[10],'vector':[0,0,-100]}],'masses':[],'meshSize':geo['recommendedSize']}
            worker.mesh_part(folder,s)
            direct=solve(folder,s,8)
            self.assertIn('*EQUATION',(folder/'analysis.inp').read_text())
            result=solve(folder,{**s,'solver':'iterative-amg'},8)
            self.assertIn('BoomerAMG',result['solver'])
            DirectSolvers.assertSameAnswer(self,result,direct)

    def test_pardiso_takes_over_where_cg_stalls(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);shutil.copy(ROOT/'samples/beam.step',folder/'part.step')
            worker.import_part(folder);s=study(meshSize=8)
            worker.mesh_part(folder,s)
            direct=solve(folder,s,8)
            # A residual no solve reaches.
            with mock.patch.dict(os.environ,{'SPRUNG_FEA_SOLVE_TOLERANCE':'1e-30'}):
                result=solve(folder,{**s,'solver':'iterative-amg'},8)
            self.assertIn('with PARDISO where CG stalled',result['solver'])
            self.assertIn('CG with BoomerAMG stalled: 500 iterations',(folder/'solver.log').read_text())
            DirectSolvers.assertSameAnswer(self,result,direct)


class GraphicsCard(unittest.TestCase):
    """CG with BoomerAMG on an NVIDIA GPU, from the second sprung-solve that
    build-solver.py --cuda builds, where it works."""
    def setUp(self):
        self.gpu=calculix.gpu_amg()
        if not self.gpu: self.skipTest('No GPU build of sprung-solve works here.')

    def test_the_gpu_gives_the_cpus_answer(self):
        self.assertIn('on the GPU',calculix.solver_options()['gpu'])
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);shutil.copy(ROOT/'samples/beam.step',folder/'part.step')
            worker.import_part(folder);s={**study(meshSize=4),'solver':'iterative'}
            worker.mesh_part(folder,s)
            cpu=solve(folder,s,8)
            self.assertNotIn('GPU',cpu['solver'])
            with mock.patch.dict(os.environ,{'SPRUNG_FEA_DEVICE':'gpu'}):
                gpu=solve(folder,s,8)
            self.assertEqual(gpu['solver'],'CalculiX, iterative, '+self.gpu)
            log=(folder/'solver.log').read_text()
            self.assertIn('on the GPU',log)
            self.assertIn('3 unknowns a node',log)
            DirectSolvers.assertSameAnswer(self,gpu,cpu)


class WithoutAGraphicsCard(unittest.TestCase):
    """The NVIDIA builds on a computer with no NVIDIA GPU (none visible to
    CUDA): the GPU sprung-solve starts and runs PARDISO alone, and the
    iterative solver is BoomerAMG on the CPU, even when the GPU is asked
    for."""
    def setUp(self):
        if not calculix.built_capabilities().get('amgGpuHelper'):
            self.skipTest('This solver has no GPU build of sprung-solve.')
        hidden=mock.patch.dict(os.environ,{'CUDA_VISIBLE_DEVICES':'-1'})
        hidden.start();self.addCleanup(hidden.stop)
        # What was found with the GPU visible no longer holds.
        calculix._working_helper.cache_clear();self.addCleanup(calculix._working_helper.cache_clear)

    def test_boomeramg_runs_on_the_cpu(self):
        path=Path(calculix.find_ccx()).resolve().parent/calculix.built_capabilities()['amgGpuHelper']
        version=subprocess.run([str(path),'--version'],capture_output=True,text=True,check=True).stdout
        self.assertTrue(version.startswith(calculix.HELPER_BANNER),version)
        self.assertNotIn('amg:',version)
        options=calculix.solver_options()
        self.assertIsNone(options['gpu'])
        self.assertIn('BoomerAMG',options['iterative'])
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);shutil.copy(ROOT/'samples/beam.step',folder/'part.step')
            worker.import_part(folder);s={**study(meshSize=4),'solver':'iterative'}
            worker.mesh_part(folder,s)
            with mock.patch.dict(os.environ,{'SPRUNG_FEA_DEVICE':'gpu'}):
                result=solve(folder,s,8)
        self.assertEqual(result['solver'],'CalculiX, iterative, '+options['iterative'])
        self.assertGreater(result['iterations'],0)


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

    def test_it_solves_positive_definite_matrix_market_systems_with_amg(self):
        if not calculix.capabilities().get('amg'): self.skipTest('This sprung-solve has no hypre.')
        # A 3D grid Laplacian with a shift: positive definite.
        m=12;n=m**3;index=np.arange(n).reshape(m,m,m)
        rows=[np.arange(n)];columns=[np.arange(n)];values=[np.full(n,6.5)]
        for axis in range(3):
            a=np.take(index,range(1,m),axis=axis).ravel();c=np.take(index,range(m-1),axis=axis).ravel()
            rows.append(a);columns.append(c);values.append(np.full(len(a),-1.))
        rows,columns,values=map(np.concatenate,(rows,columns,values))
        matrix=np.zeros((n,n));matrix[rows,columns]=values;matrix[columns,rows]=values
        b=np.random.default_rng(2).standard_normal(n)
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp)
            (folder/'A.mtx').write_text(f'%%MatrixMarket matrix coordinate real symmetric\n{n} {n} {len(rows)}\n'
                                        +''.join(f'{r+1} {c+1} {v!r}\n' for r,c,v in zip(rows.tolist(),columns.tolist(),values.tolist())))
            (folder/'b.mtx').write_text(f'%%MatrixMarket matrix array real general\n{n} 1\n'+''.join(f'{v!r}\n' for v in b.tolist()))
            done=subprocess.run([calculix.find_helper(),'--amg',str(folder/'A.mtx'),str(folder/'b.mtx')],capture_output=True,text=True,check=True)
        self.assertIn('CG with BoomerAMG:',done.stderr)
        expected=np.linalg.solve(matrix,b)
        np.testing.assert_allclose(np.array(done.stdout.split(),float),expected,rtol=0,atol=1e-9*np.abs(expected).max())


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
        amg=bool(calculix.capabilities().get('amg'))
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);shutil.copy(ROOT/'samples/bolted-joint.step',folder/'part.step')
            worker.import_part(folder)
            s=joint.study([{'kind':'force','faces':[joint.LOADED],'vector':[3000,0,0]}])
            worker.mesh_part(folder,s)
            results={n:solve(folder,s,8,n) for n in names}
            if amg:
                # Friction makes the systems nonsymmetric, which CG cannot
                # take: sprung-solve factors them with PARDISO.
                results['amg']=solve(folder,{**s,'solver':'iterative-amg'},8)
                self.assertIn('CG needs a symmetric matrix',(folder/'solver.log').read_text())
        reference=results.pop('spooles')
        scale=np.abs(reference['displacements']).max()
        for name,result in results.items():
            with self.subTest(solver=name):
                if name!='amg': self.assertIn(calculix.direct_solvers()[name],result['solver'])
                # Within the nonlinear iterations' own tolerance.
                np.testing.assert_allclose(result['displacements'],reference['displacements'],rtol=0,atol=1e-3*scale)
                for bolt,expected in zip(result['summary']['bolts'],reference['summary']['bolts']):
                    self.assertAlmostEqual(bolt['tightened'],expected['tightened'],delta=1e-3*bolt['preload'])
                    self.assertAlmostEqual(bolt['loaded'],expected['loaded'],delta=1e-3*bolt['preload'])
                for c in result['summary']['contacts']:
                    expected=next(e for e in reference['summary']['contacts'] if e['id']==c['id'])
                    self.assertEqual(c['state'],expected['state'])
                    self.assertAlmostEqual(c['normal'],expected['normal'],delta=1e-3*20000)
