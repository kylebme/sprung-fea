"""Cross-exporter CAD acceptance: real curved solids, mesh refinement, and solves."""
import unittest, tempfile, shutil, json, copy, sys
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import worker
from complex_cases import setup
ROOT = Path(__file__).resolve().parents[1]

class ComplexParts(unittest.TestCase):
    def test_cadquery_parts_refinement_equilibrium_and_linearity(self):
        report = []
        for reference in json.loads((ROOT/'samples/complex-manifest.json').read_text()):
            name = reference['name']
            with self.subTest(part=name), tempfile.TemporaryDirectory() as temp:
                folder = Path(temp)
                shutil.copy(ROOT/'samples'/f'{name}.step', folder/'part.step')
                geo = worker.import_part(folder)
                np.testing.assert_allclose(geo['dimensions'], reference['dimensions'], atol=2e-5)
                self.assertAlmostEqual(geo['volume']/reference['volume'],1,delta=1e-8)
                self.assertGreaterEqual(len(geo['faces']),10)
                self.assertTrue(any(f['type'] != 'Plane' for f in geo['faces']))
                s = setup(name,geo)
                mesh = worker.mesh_part(folder,s)
                self.assertGreater(mesh['minQuality'],0)
                self.assertEqual([f['id'] for f in geo['faces']], [f['id'] for f in mesh['surface']['faces']])
                coarse = worker.solve(folder,s)
                self.assertTrue(np.isfinite(coarse['stress']).all())
                self.assertGreater(coarse['summary']['maxMovement'],0)
                np.testing.assert_allclose(coarse['summary']['reactions'], -np.array(s['loads'][0]['vector']),atol=.02)
                self.assertLess(coarse['summary']['forceBalanceError'],1e-4)
                doubled = copy.deepcopy(s)
                doubled['loads'][0]['vector'] = (2*np.array(s['loads'][0]['vector'])).tolist()
                twice = worker.solve(folder,doubled)
                np.testing.assert_allclose(twice['displacements'],2*np.array(coarse['displacements']),rtol=3e-5,atol=1e-9)
                np.testing.assert_allclose(twice['stress'],2*np.array(coarse['stress']),rtol=3e-5,atol=1e-5)
                fine_s = copy.deepcopy(s);fine_s['meshSize'] *= .7
                fine_mesh = worker.mesh_part(folder,fine_s)
                fine = worker.solve(folder,fine_s)
                self.assertGreater(fine_mesh['elementCount'],mesh['elementCount'])
                change = abs(fine['summary']['maxMovement']/coarse['summary']['maxMovement']-1)
                self.assertLess(change,.08, 'Global displacement changed more than 8%; investigate mesh resolution')
                self.assertLess(fine['summary']['forceBalanceError'],1e-4)
                report.append({'part':name,'faces':len(geo['faces']),'support':s['supports'][0]['faces'],
                               'load':s['loads'][0]['faces'],'vector':s['loads'][0]['vector'],
                               'coarseElements':mesh['elementCount'],'fineElements':fine_mesh['elementCount'],
                               'minQuality':fine_mesh['minQuality'],'coarseMovement':coarse['summary']['maxMovement'],
                               'fineMovement':fine['summary']['maxMovement'],'movementChangePercent':100*change,
                               'coarsePeakStress':coarse['summary']['maxStress'],'finePeakStress':fine['summary']['maxStress'],
                               'forceBalanceError':fine['summary']['forceBalanceError']})
        (ROOT/'output').mkdir(exist_ok=True)
        (ROOT/'output/complex-validation.json').write_text(json.dumps(report,indent=2)+'\n')

    def test_toroidal_pressure_matches_projected_area(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            shutil.copy(ROOT/'samples/tube-elbow.step', folder/'part.step')
            geo = worker.import_part(folder)
            s = setup('tube-elbow',geo)
            toroidal = [f for f in geo['faces'] if f['type'] == 'Torus']
            self.assertEqual(len(toroidal),2)
            inner = min(toroidal,key=lambda f:f['area'])
            s['loads'] = [{'kind':'pressure','faces':[inner['id']],'magnitude':1}]
            worker.mesh_part(folder,s)
            result = worker.solve(folder,s)
            # For an open 90-degree toroidal wall: integral(p*n*dA)
            # has X and Y resultants p*pi*r^2 and no Z component.
            expected = np.array([np.pi*7**2,np.pi*7**2,0])
            np.testing.assert_allclose(result['summary']['appliedForce'],expected,atol=.25)
            np.testing.assert_allclose(result['summary']['reactions'],-expected,atol=.25)
            self.assertLess(result['summary']['forceBalanceError'],1e-4)

    def test_bore_pressure_with_zero_resultant_stays_in_equilibrium(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            shutil.copy(ROOT/'samples/bearing-block.step', folder/'part.step')
            geo = worker.import_part(folder)
            s = setup('bearing-block',geo)
            s['loads'] = [{'kind':'pressure','faces':s['loads'][0]['faces'],'magnitude':2}]
            worker.mesh_part(folder,s)
            result = worker.solve(folder,s)
            self.assertGreater(result['summary']['maxMovement'],0)
            np.testing.assert_allclose(result['summary']['appliedForce'],[0,0,0],atol=.02)
            np.testing.assert_allclose(result['summary']['reactions'],[0,0,0],atol=.02)
            self.assertLess(result['summary']['forceBalanceError'],1e-4)

if __name__ == '__main__':unittest.main()
