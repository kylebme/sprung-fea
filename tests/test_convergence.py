"""Mesh convergence studies on real meshes and solves."""
import unittest, sys, tempfile, shutil
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
sys.path.insert(0,str(Path(__file__).resolve().parent))
import worker
from convergence import converge, richardson, RATIO
from complex_cases import setup
ROOT=Path(__file__).resolve().parents[1]

def part(name):
    temp=tempfile.TemporaryDirectory();folder=Path(temp.name)
    shutil.copy(ROOT/f'samples/{name}.step',folder/'part.step')
    return temp,folder,worker.import_part(folder)

class Convergence(unittest.TestCase):
    def test_richardson_recovers_the_limit_of_a_second_order_sequence(self):
        # v(h) = 2 + 3h², refined by RATIO: the limit is 2, the order 2.
        values=[2+3*(RATIO**k)**2 for k in range(3)]
        estimate=richardson(values,RATIO)
        self.assertAlmostEqual(estimate['value'],2,places=10)
        self.assertAlmostEqual(estimate['order'],2,places=10)
        # Oscillating or growing changes give no estimate.
        self.assertIsNone(richardson([1,2,1.5],RATIO))
        self.assertIsNone(richardson([1,2,4],RATIO))

    def test_cantilever_converges_and_keeps_the_finest_mesh(self):
        temp,folder,geo=part('beam')
        with temp:
            s={'material':{'name':'Al','young':68900,'poisson':.33,'density':2700,'yield':276},
               'supports':[{'faces':[1],'axes':[True]*3}],'loads':[{'kind':'force','faces':[2],'vector':[0,0,-100]}],'meshSize':4}
            mesh,result=converge(folder,s,{'runs':4,'tolerance':.02})
            c=result['convergence']
            # Displacement and peak stress settle within 2% on the second mesh.
            self.assertEqual(len(c['meshes']),2)
            self.assertTrue(all(q['converged'] for q in c['quantities']))
            self.assertAlmostEqual(c['meshes'][1]['size'],4*RATIO)
            self.assertGreater(c['meshes'][1]['elementCount'],c['meshes'][0]['elementCount'])
            # The returned result is the finest mesh's solve.
            self.assertEqual(mesh['elementCount'],c['meshes'][-1]['elementCount'])
            self.assertEqual(result['elementCount'],mesh['elementCount'])
            self.assertAlmostEqual(c['meshes'][-1]['values'][0],result['summary']['maxMovement'])
            with self.assertRaises(ValueError):converge(folder,s,{'runs':9})

    def test_rising_peak_stress_is_reported_as_a_likely_singularity(self):
        # The gusseted bracket's peak stress sits at a sharp inside corner:
        # displacement settles while peak stress keeps climbing.
        temp,folder,geo=part('ribbed-bracket')
        with temp:
            _,result=converge(folder,setup('ribbed-bracket',geo),{'runs':3,'tolerance':.02})
            moving,peak=result['convergence']['quantities']
            self.assertTrue(moving['converged'])
            self.assertFalse(peak['converged'])
            self.assertTrue(peak.get('singular'))
            self.assertTrue(any('sharp inside corner' in w for w in result['warnings']))

if __name__=='__main__':unittest.main()
