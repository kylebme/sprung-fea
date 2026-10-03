"""Remote force, moment, bearing and rotation loads through real CalculiX
solves, checked against beam theory and exact resultants."""
import unittest, sys, tempfile, shutil, json, math
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
sys.path.insert(0,str(Path(__file__).resolve().parent))
import worker
ROOT=Path(__file__).resolve().parents[1]
E=68900;I=20*10**3/12;L=100

def study(*loads,size=4,faces=(1,)):
    return {'material':{'name':'Aluminum','young':E,'poisson':.33,'density':2700,'yield':276},
            'supports':[{'faces':list(faces),'axes':[True,True,True]}],'loads':list(loads),'meshSize':size}

def applied(folder):
    """Equivalent nodal loads written for reaction recovery: (resultant,
    moment about the origin)."""
    data=json.loads((folder/'applied.json').read_text())
    mesh=json.loads((folder/'mesh.json').read_text())
    nodes=dict(zip(map(str,mesh['surface']['nodeIds']),np.asarray(mesh['surface']['positions']).reshape(-1,3)))
    force=np.sum([v for v in data.values()],axis=0)
    moment=np.sum([np.cross(nodes[n],v) for n,v in data.items()],axis=0)
    return force,moment,data,nodes

def tip(result,mesh,axis=2):
    nodes=np.asarray(mesh['surface']['positions']).reshape(-1,3)
    end=np.isclose(nodes[:,0],L)
    return np.asarray(result['displacements'])[end,axis].mean()

class Loads(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        shutil.copy(ROOT/'samples/beam.step',cls.folder/'part.step')
        worker.import_part(cls.folder)
        cls.mesh=worker.mesh_part(cls.folder,study({'kind':'force','faces':[2],'vector':[0,0,-1]}))
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def test_remote_force_adds_the_moment_of_its_offset(self):
        # 100 N down, acting 50 mm beyond the free end of the cantilever.
        point=[150,10,5];force=[0,0,-100]
        result=worker.solve(self.folder,study({'kind':'remote','faces':[2],'vector':force,'point':point}))
        total,moment,_,_=applied(self.folder)
        np.testing.assert_allclose(total,force,atol=1e-9)
        np.testing.assert_allclose(moment,np.cross(point,force),atol=1e-7)
        np.testing.assert_allclose(result['summary']['reactions'],[0,0,100],atol=.01)
        # Tip deflection: end force F plus end moment F × 50 mm.
        expected=-(100*L**3/(3*E*I)+100*50*L**2/(2*E*I))
        self.assertLess(abs(tip(result,self.mesh)/expected-1),.04)

    def test_moment_bends_without_net_force(self):
        result=worker.solve(self.folder,study({'kind':'moment','faces':[2],'vector':[0,5000,0]}))
        total,moment,_,nodes=applied(self.folder)
        np.testing.assert_allclose(total,[0,0,0],atol=1e-9)
        np.testing.assert_allclose(moment,[0,5000,0],atol=1e-7)
        np.testing.assert_allclose(result['summary']['reactions'],[0,0,0],atol=.01)
        # A moment +My on the free end bends it toward -Z: uz = -M L²/(2EI).
        self.assertLess(abs(tip(result,self.mesh)/(-5000*L**2/(2*E*I))-1),.04)

    def test_rotation_reaction_is_mass_times_centripetal_acceleration(self):
        # 3000 rpm about a Z axis through the fixed end's center.
        rpm=3000;omega=rpm*2*math.pi/60
        result=worker.solve(self.folder,study({'kind':'rotation','faces':[],'magnitude':rpm,'axis':[0,0,1],'point':[0,10,5]}))
        deck=(self.folder/'analysis.inp').read_text()
        self.assertIn(f'PART, CENTRIF, {omega**2:.12g}, 0, 10, 5, 0, 0, 1',deck)
        mass=2700e-12*20000
        np.testing.assert_allclose(result['summary']['appliedForce'],[mass*omega**2*50,0,0],rtol=1e-9,atol=1e-9)
        np.testing.assert_allclose(result['summary']['reactions'],[-mass*omega**2*50,0,0],rtol=1e-4,atol=1e-3)
        self.assertLess(result['summary']['forceBalanceError'],1e-6)
        # Uniform bar spinning about one end: axial stress ρω²(L² − x²)/2 at
        # the root, ρω²L²/2.
        root=2700e-12*omega**2*L**2/2
        nodes=np.asarray(self.mesh['surface']['positions']).reshape(-1,3)
        mid=np.isclose(nodes[:,0],50)
        self.assertLess(abs(np.mean(np.asarray(result['stress'])[mid])/(root*.75)-1),.05)

    def test_invalid_remote_and_rotation_inputs(self):
        cases=[{'kind':'remote','faces':[2],'vector':[0,0,-1]},
               {'kind':'moment','faces':[2],'vector':[0,0,0]},
               {'kind':'rotation','faces':[],'magnitude':100,'axis':[0,0,0],'point':[0,0,0]},
               {'kind':'bearing','faces':[2],'vector':[0,0,-100]}]
        for load in cases:
            with self.subTest(load=load['kind']),self.assertRaises(ValueError):
                worker.write_deck(self.folder,study(load),self.mesh)

class Bearing(unittest.TestCase):
    def test_bearing_load_pushes_on_the_loaded_half_of_a_bore(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);shutil.copy(ROOT/'samples/bearing-block.step',folder/'part.step')
            geo=worker.import_part(folder)
            from complex_cases import setup
            s=setup('bearing-block',geo)
            bore=s['loads'][0]['faces']
            self.assertTrue(all(next(f for f in geo['faces'] if f['id']==b)['type']=='Cylinder' for b in bore))
            # The bore's axis is Z: load it radially, toward -Y.
            force=[0,-800,0]
            s['loads']=[{'kind':'bearing','faces':bore,'vector':force}]
            mesh=worker.mesh_part(folder,s)
            result=worker.solve(folder,s)
            np.testing.assert_allclose(result['summary']['appliedForce'],force,atol=.5)
            np.testing.assert_allclose(result['summary']['reactions'],[0,800,0],atol=.5)
            self.assertLess(result['summary']['forceBalanceError'],1e-4)
            # Only the half of the bore facing the load is pushed: nodes on
            # the far half carry almost nothing (consistent quadratic loads
            # leave small forces on nodes beside the loaded half).
            _,_,data,nodes=applied(folder)
            far=sum(np.linalg.norm(v) for n,v in data.items() if nodes[n][1]>1e-6)
            near=sum(np.linalg.norm(v) for n,v in data.items() if nodes[n][1]<=1e-6)
            self.assertLess(far,.01*near)
            # A force along the axis cannot be carried as a bearing load.
            s['loads'][0]['vector']=[0,0,-800]
            with self.assertRaisesRegex(ValueError,'along its axis'):
                worker.write_deck(folder,s,mesh)

if __name__=='__main__':unittest.main()
