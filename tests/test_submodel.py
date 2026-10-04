"""Submodeling: a refined region driven by the whole-part solution."""
import unittest, sys, tempfile, shutil, json
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import worker
from submodel import submodel, interpolate
ROOT=Path(__file__).resolve().parents[1]

def study(*loads):
    return {'material':{'name':'Al','young':68900,'poisson':.33,'density':2700,'yield':276},
            'supports':[{'faces':[1],'axes':[True]*3}],'loads':list(loads),'meshSize':4,'solver':'spooles'}

class Submodel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        shutil.copy(ROOT/'samples/beam.step',cls.folder/'part.step')
        worker.import_part(cls.folder)
        cls.study=study({'kind':'force','faces':[2],'vector':[0,0,-100]})
        cls.mesh=worker.mesh_part(cls.folder,cls.study)
        cls.whole=worker.solve(cls.folder,cls.study)
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def test_region_follows_the_whole_part_at_its_cut_faces(self):
        # Mid-span, away from the support and the load: bending stress is
        # smooth, so the fine region must agree with the whole part.
        mesh,result,geometry=submodel(self.folder,self.study,{'center':[50,10,5],'size':[20,30,20],'meshSize':1.5})
        self.assertGreater(mesh['elementCount'],self.mesh['elementCount']/4)
        cut=[f for f in geometry['faces'] if f['cut']]
        self.assertEqual(len(cut),2)
        self.assertTrue(all(f['type']=='Plane' for f in cut))
        # The four side faces keep their part faces 3–6.
        self.assertEqual(sorted(f['original'] for f in geometry['faces'] if not f['cut']),[3,4,5,6])
        self.assertLess(result['summary']['boundaryDifference'],.1)
        self.assertEqual(result['warnings'],[])
        # Beam theory at x = 40 mm, the region's highest bending moment:
        # σ = M c / I with M = 100 N × 60 mm.
        expected=100*60*5/(20*10**3/12)
        self.assertLess(abs(result['summary']['maxStress']/expected-1),.08)
        # Displacements at the cut faces are the whole part's.
        nodes=dict(zip(mesh['surface']['nodeIds'],np.asarray(mesh['surface']['positions']).reshape(-1,3)))
        boundary=sorted({n for f in cut for n in mesh['faces'][str(f['id'])]['nodes']})
        index={n:i for i,n in enumerate(mesh['surface']['nodeIds'])}
        points=np.array([nodes[n] for n in boundary])
        whole=json.loads((self.folder/'result.json').read_text())
        parent=json.loads((self.folder/'mesh.json').read_text())
        uz=interpolate(parent,np.asarray(whole['displacements'])[:,2],points)
        refined=np.asarray(result['displacements'])[[index[n] for n in boundary],2]
        np.testing.assert_allclose(refined,uz,atol=1e-3*whole['summary']['maxMovement'])

    def test_region_at_the_support_keeps_supports_and_refines_the_peak(self):
        mesh,result,geometry=submodel(self.folder,self.study,{'center':[10,10,5],'size':[20,30,20],'meshSize':1})
        self.assertIn(1,[f['original'] for f in geometry['faces']])
        deck=(self.folder/'region/analysis.inp').read_text()
        self.assertIn('*SUBMODEL, TYPE=NODE, INPUT=global.frd',deck)
        self.assertIn('*BOUNDARY, SUBMODEL, STEP=1',deck)
        # The refined region resolves the support's stress concentration.
        self.assertGreater(result['summary']['maxStress'],result['summary']['globalPeak'])
        whole=json.loads((self.folder/'result.json').read_text())
        self.assertAlmostEqual(result['summary']['globalPeak'],whole['summary']['maxStress'],delta=1e-9)

    def test_force_on_a_partly_included_face_keeps_its_traction(self):
        # 100 N spread over the whole bottom face (z = 0); a region over its
        # last 40% carries 40 N of it.
        s=study({'kind':'force','faces':[5],'vector':[0,0,-100]})
        worker.mesh_part(self.folder,s);worker.solve(self.folder,s)
        submodel(self.folder,s,{'center':[80,10,5],'size':[40,30,20],'meshSize':2})
        lines=(self.folder/'region/analysis.inp').read_text().splitlines()
        start=lines.index('*CLOAD')+1;total=0
        for line in lines[start:]:
            if line.startswith('*'):break
            total+=float(line.split(',')[2])
        self.assertAlmostEqual(total,-40,places=6)
        worker.mesh_part(self.folder,self.study);worker.solve(self.folder,self.study)

    def test_invalid_regions_are_rejected(self):
        for region,message in [({'center':[500,0,0],'size':[10,10,10],'meshSize':1},'does not overlap'),
                               ({'center':[50,10,5],'size':[300,300,300],'meshSize':5},'whole part'),
                               ({'center':[50,10,5],'size':[0,10,10],'meshSize':1},'positive size')]:
            with self.subTest(message=message),self.assertRaisesRegex(ValueError,message):
                submodel(self.folder,self.study,region)
        s=study({'kind':'remote','faces':[2],'vector':[0,0,-100],'point':[150,10,5]})
        with self.assertRaisesRegex(ValueError,'Remote forces'):
            submodel(self.folder,s,{'center':[90,10,5],'size':[20,30,20],'meshSize':2})

if __name__=='__main__':unittest.main()
