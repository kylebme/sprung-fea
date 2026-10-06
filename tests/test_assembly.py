"""Bonded assemblies: STEP files with several solids, through real meshing
and CalculiX solves."""
import unittest, sys, tempfile, shutil, json
from pathlib import Path
import numpy as np
import gmsh
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import worker
ROOT=Path(__file__).resolve().parents[1]
ALUMINUM={'name':'Aluminum','young':68900,'poisson':.33,'density':2700,'yield':276}
STEEL={'name':'Steel','young':200000,'poisson':.3,'density':7850,'yield':250}

def part(name):
    temp=tempfile.TemporaryDirectory();folder=Path(temp.name)
    shutil.copy(ROOT/f'samples/{name}.step',folder/'part.step')
    return temp,folder,worker.import_part(folder)

def face_at(geo,axis,value):
    return next(f['id'] for f in geo['faces'] if f['type']=='Plane' and abs(f['center'][axis]-value)<1e-6
                and abs(abs(f['normal'][axis])-1)<1e-9)

def study(supports,loads,**changes):
    return {'material':ALUMINUM,'supports':supports,'loads':loads,'masses':[],'meshSize':4,**changes}

class Assembly(unittest.TestCase):
    def test_split_beam_bends_like_the_solid_beam(self):
        temp,folder,geo=part('split-beam')
        with temp:
            self.assertEqual(len(geo['bodies']),2)
            self.assertEqual(geo['components'],[[1,2]])
            # The shared face at x = 50 is inside: ten outer faces remain.
            self.assertEqual(len(geo['faces']),10)
            self.assertFalse(any(abs(f['center'][0]-50)<1e-6 and abs(f['normal'][0])>.99 for f in geo['faces']))
            s=study([{'faces':[face_at(geo,0,0)],'axes':[True]*3}],[{'kind':'force','faces':[face_at(geo,0,100)],'vector':[0,0,-100]}])
            mesh=worker.mesh_part(folder,s)
            self.assertEqual(sorted(mesh['bodies']),['1','2'])
            result=worker.solve(folder,s)
            expected=100*100**3/(3*68900*(20*10**3/12))
            self.assertLess(abs(result['summary']['maxMovement']/expected-1),.04)
            np.testing.assert_allclose(result['summary']['reactions'],[0,0,100],atol=.01)
            mass=next(c for c in result['checks'] if c['label']=='Mass')['values'][0]
            self.assertAlmostEqual(mass,.054,places=6)

    def test_shared_faces_show_from_each_side(self):
        # The view draws the face two bodies share once per side, so hiding
        # either body leaves the other closed; outer faces face the outside.
        temp,folder,geo=part('split-beam')
        with temp:
            shared=geo['interfaces'][0]
            self.assertEqual(shared['bodies'],[1,2])
            self.assertTrue(shared['indices'])
            from cad import mesh_view
            view=mesh_view(worker.mesh_part(folder,{'meshSize':5}))
            faces=view['triangleFaces'][1];pairs=view['triangleBodies'][1]
            inside=faces==shared['id']
            self.assertTrue(np.all(pairs[~inside,1]==0))
            sides=[tuple(p) for p in pairs[inside]]
            self.assertEqual(sides.count((1,2)),sides.count((2,1)))
            self.assertEqual(sides.count((1,2))*2,len(sides))

    def test_two_materials_stretch_like_springs_in_series(self):
        temp,folder,geo=part('split-beam')
        with temp:
            # Aluminum for x < 50, steel beyond; the far end pulled by 1 kN,
            # the near end free to contract sideways.
            end=face_at(geo,0,100)
            s=study([{'faces':[face_at(geo,0,0)],'axes':[True,False,False]},
                     {'faces':[next(f['id'] for f in geo['faces'] if abs(f['center'][1])<1e-6 and f['body']==1)],'axes':[False,True,False]},
                     {'faces':[next(f['id'] for f in geo['faces'] if abs(f['center'][2])<1e-6 and f['body']==1)],'axes':[False,False,True]}],
                    [{'kind':'force','faces':[end],'vector':[1000,0,0]}],bodyMaterials={'2':STEEL})
            mesh=worker.mesh_part(folder,s);result=worker.solve(folder,s)
            xyz=np.asarray(mesh['surface']['positions']).reshape(-1,3)
            ux=np.asarray(result['displacements'])[np.isclose(xyz[:,0],100),0].mean()
            expected=1000*50/(68900*200)+1000*50/(200000*200)
            self.assertLess(abs(ux/expected-1),.01)
            # Mass: 27 g of aluminum and 78.5 g of steel.
            mass=next(c for c in result['checks'] if c['label']=='Mass')['values'][0]
            self.assertAlmostEqual(mass,.027+.0785,places=6)
            self.assertIn('*ELSET, ELSET=BODIES2',(folder/'analysis.inp').read_text())

    def test_separate_bodies_each_need_supports(self):
        temp,folder,geo=part('gap-pair')
        with temp:
            self.assertEqual(geo['components'],[[1],[2]])
            left=face_at(geo,0,0);right=face_at(geo,0,81)
            s=study([{'faces':[left],'axes':[True]*3}],[{'kind':'force','faces':[right],'vector':[0,0,-10]}])
            mesh=worker.mesh_part(folder,s)
            with self.assertRaisesRegex(ValueError,'Body 2 can still move freely'):
                worker.write_deck(folder,s,mesh)
            s['supports'].append({'faces':[face_at(geo,0,41)],'axes':[True]*3})
            result=worker.solve(folder,s)
            self.assertGreater(result['summary']['maxMovement'],0)
            # Free vibration: six rigid motions per body.
            free=worker.solve(folder,study([],[],analysis='frequency',modes=2))
            self.assertEqual(free['summary']['rigidModes'],12)

    def test_post_on_plate_bonds_through_the_imprinted_footprint(self):
        temp,folder,geo=part('post-plate')
        with temp:
            bottom=face_at(geo,2,0);top=face_at(geo,2,46)
            self.assertEqual(next(f['body'] for f in geo['faces'] if f['id']==top),2)
            s=study([{'faces':[bottom],'axes':[True]*3}],[{'kind':'gravity','vector':[0,0,-9.81],'faces':[]}],
                    bodyMaterials={'2':STEEL})
            worker.mesh_part(folder,s);result=worker.solve(folder,s)
            weight=(80*60*6*2700+20*20*40*7850)*1e-12*9810
            np.testing.assert_allclose(result['summary']['reactions'],[0,0,weight],rtol=1e-6,atol=1e-6)

    def test_overlapping_bodies_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp)
            gmsh.initialize();gmsh.option.setNumber('General.Terminal',0)
            gmsh.model.occ.addBox(0,0,0,10,10,10);gmsh.model.occ.addBox(5,0,0,10,10,10)
            gmsh.model.occ.synchronize();gmsh.write(str(folder/'part.step'));gmsh.finalize()
            with self.assertRaisesRegex(ValueError,'overlap'):
                worker.import_part(folder)

if __name__=='__main__':unittest.main()
