"""Contact and bolt pretension through real meshing and CalculiX solves, on
the bolted lap joint sample: two plates (bodies 1 and 2) clamped by a bolt
(body 3) whose head and nut touch them. Checked against equilibrium and
the friction law, which hold on any mesh."""
import unittest, sys, tempfile, shutil, json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import worker
ROOT=Path(__file__).resolve().parents[1]
STEEL={'name':'Steel','young':200000,'poisson':.3,'density':7850,'yield':250}
SHANK,HELD,LOADED=21,1,16  # bolt shank; plate 1's free end; plate 2's free end
MU=.2

def study(loads=(),preload=20000,**changes):
    friction=lambda pair:{'id':pair,'kind':'frictional','friction':MU}
    return {'analysis':'static','contact':True,'material':STEEL,'meshSize':5,
            'contacts':[friction('1-2'),friction('1-3'),friction('2-3')],
            'bolts':[{'id':'b','name':'Bolt','faces':[SHANK],'preload':preload}],
            'supports':[{'faces':[HELD],'axes':[True]*3}],'loads':list(loads),'masses':[],**changes}

def contacts(result):
    return {c['id']:c for c in result['summary']['contacts']}

class Contact(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        shutil.copy(ROOT/'samples/bolted-joint.step',cls.folder/'part.step')
        cls.geometry=worker.import_part(cls.folder)
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def solve(self,s):
        worker.mesh_part(self.folder,s)
        return worker.solve(self.folder,s)

    def test_cutting_the_bolt_keeps_face_names(self):
        self.assertEqual([i['bodies'] for i in self.geometry['interfaces']],[[1,2],[1,3],[2,3]])
        plain=worker.mesh_part(self.folder,{'meshSize':5})
        cut=worker.mesh_part(self.folder,study())
        self.assertEqual(sorted(cut['faces']),sorted(plain['faces']))
        self.assertEqual(sorted(f['id'] for f in cut['surface']['faces']),sorted(int(f) for f in plain['faces']))
        self.assertEqual(sorted(cut['bodies']),['1','2','3'])
        self.assertIn('b',cut['cuts'])
        self.assertEqual(sorted(cut['interfaces']),sorted(plain['interfaces']))

    def test_tightened_bolt_clamps_the_plates(self):
        # Preload alone: the bolt's force is the preload, and the head, the
        # nut and the plates' interface each carry it.
        result=self.solve(study())
        bolt=result['summary']['bolts'][0]
        self.assertAlmostEqual(bolt['tightened'],20000,delta=1)
        for c in contacts(result).values():
            self.assertAlmostEqual(c['normal'],20000,delta=40)
            self.assertNotEqual(c['state'],'open')
        self.assertTrue(all(f['label'].startswith('Tightening') for f in result['frames']))
        self.assertLess(result['summary']['forceBalanceError'],1e-6)
        steady=next(c for c in result['checks'] if c['label'].startswith('Steadying springs'))
        self.assertLess(steady['values'][0],1e-4*20000)

    def test_friction_holds_then_slides(self):
        # Pulling the plates apart along the joint: below μ times the clamp
        # force the interface sticks; beyond it, it slides at that limit and
        # the head and nut carry the rest through the bolt.
        held=self.solve(study([{'kind':'force','faces':[LOADED],'vector':[3000,0,0]}]))
        plates=contacts(held)['1-2']
        self.assertEqual(plates['state'],'stuck')
        self.assertLess(plates['shear'],MU*plates['normal'])
        self.assertTrue(any(f['label']=='Load 100%' for f in held['frames']))
        self.assertIn('boltForce',[c['id'] for c in held['charts']])
        slid=self.solve(study([{'kind':'force','faces':[LOADED],'vector':[6000,0,0]}]))
        plates=contacts(slid)['1-2']
        self.assertEqual(plates['state'],'sliding')
        self.assertAlmostEqual(plates['shear'],MU*plates['normal'],delta=.01*plates['shear'])
        through_bolt=contacts(slid)['2-3']['shear']
        self.assertAlmostEqual(plates['shear']+through_bolt,6000,delta=.03*6000)
        self.assertTrue(any('Sliding' in w for w in slid['warnings']))
        np=__import__('numpy')
        np.testing.assert_allclose(slid['summary']['reactions'],[-6000,0,0],atol=1)

    def test_invalid_contact_studies(self):
        mesh=worker.mesh_part(self.folder,{'meshSize':5})
        cases=[(study(contacts=[{'id':'1-9','kind':'frictional'}]),'do not touch'),
               (study(contacts=[{'id':'1-2','kind':'frictional','friction':-1}]),'friction coefficient'),
               (study(contacts=[{'id':'1-2','kind':'glued'}]),'bonded, frictional or frictionless'),
               (study(preload=0),'preload'),
               (study(contactStiffness=0),'stiffness factor')]
        for s,message in cases:
            with self.subTest(message=message),self.assertRaisesRegex(ValueError,message):
                worker.write_deck(self.folder,s,mesh)
        # A bolt is cut across a cylindrical shank.
        with self.assertRaisesRegex(ValueError,'cylindrical face'):
            worker.mesh_part(self.folder,study(bolts=[{'id':'b','name':'Bolt','faces':[HELD],'preload':1000}]))

if __name__=='__main__':unittest.main()
