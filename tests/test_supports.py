"""Frictionless and cylindrical supports through real meshing and CalculiX
solves, on parts turned off the global axes so the supports become linear
constraints, checked against exact solutions."""
import unittest, sys, tempfile, shutil, math
from pathlib import Path
import numpy as np
import gmsh
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import worker
ROOT=Path(__file__).resolve().parents[1]
E=68900;NU=.33
MATERIAL={'name':'Aluminum','young':E,'poisson':NU,'density':2700,'yield':276}
# A rotation about an oblique axis, so no face lines up with X, Y or Z.
AXIS=(1,2,3);ANGLE=.7

def turned(point):
    a=np.asarray(AXIS,float)/np.linalg.norm(AXIS);p=np.asarray(point,float)
    return (p*math.cos(ANGLE)+np.cross(a,p)*math.sin(ANGLE)+a*np.dot(a,p)*(1-math.cos(ANGLE))).tolist()

def build(folder, shape):
    gmsh.initialize();gmsh.option.setNumber('General.Terminal',0)
    shape(gmsh.model.occ)
    gmsh.model.occ.rotate(gmsh.model.occ.getEntities(3),0,0,0,*AXIS,ANGLE)
    gmsh.model.occ.synchronize();gmsh.write(str(folder/'part.step'));gmsh.finalize()
    return worker.import_part(folder)

def face_at(geo, point):
    """The face whose center is nearest a point."""
    return min(geo['faces'],key=lambda f:np.linalg.norm(np.subtract(f['center'],point)))['id']

def study(supports, loads, size):
    return {'material':MATERIAL,'supports':supports,'loads':loads,'masses':[],'meshSize':size}

class Supports(unittest.TestCase):
    def test_frictionless_planes_allow_free_contraction(self):
        # A 100 × 20 × 10 bar on three frictionless planes through one
        # corner, pulled along its length: uniform stress F/A, and the far
        # end moves FL/(EA) along the bar while the sides contract freely.
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp)
            geo=build(folder,lambda occ:occ.addBox(0,0,0,100,20,10))
            planes=[face_at(geo,turned(p)) for p in [(0,10,5),(50,0,5),(50,10,0)]]
            end=face_at(geo,turned((100,10,5)))
            force=(1000*np.asarray(turned((1,0,0)))).tolist()
            frictionless=lambda f:{'faces':[f],'axes':[True,False,False],'frame':'normal'}
            s=study([frictionless(f) for f in planes],[{'kind':'force','faces':[end],'vector':force}],5)
            mesh=worker.mesh_part(folder,s)
            result=worker.solve(folder,s)
            self.assertIn('*EQUATION',(folder/'analysis.inp').read_text())
            np.testing.assert_allclose(result['stress'],1000/200,rtol=1e-3)
            np.testing.assert_allclose(result['summary']['reactions'],-np.asarray(force),atol=1e-3)
            self.assertLess(result['summary']['forceBalanceError'],1e-6)
            # Displacement of the far end along the bar.
            ids=mesh['faces'][str(end)]['nodes'];index={n:i for i,n in enumerate(mesh['surface']['nodeIds'])}
            along=np.asarray(result['displacements'])[[index[n] for n in ids]]@turned((1,0,0))
            np.testing.assert_allclose(along,1000*100/(E*200),rtol=1e-4)
            # One frictionless plane leaves the bar free to slide and turn in it.
            with self.assertRaisesRegex(ValueError,'3 rigid motions'):
                worker.write_deck(folder,{**s,'supports':[frictionless(planes[0])]},mesh)

    def test_cylindrical_support_holds_a_bore_radially(self):
        # A thick tube, bore held radially and around its axis, ends on
        # frictionless planes (plane strain), squeezed by outside pressure.
        # Lamé: u = Ar + B/r with u(a) = 0 and σr(b) = −p.
        a,b,p=10.,20.,10.
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp)
            def tube(occ):
                outer=occ.addCylinder(0,0,0,0,0,30,b);inner=occ.addCylinder(0,0,0,0,0,30,a)
                occ.cut([(3,outer)],[(3,inner)])
            geo=build(folder,tube)
            axis=np.asarray(turned((0,0,1)))
            # The bore is the smaller of the two cylinders.
            bore,outside=[[f['id']] for f in sorted((f for f in geo['faces'] if f['type']=='Cylinder'),key=lambda f:f['area'])]
            ends=[f['id'] for f in geo['faces'] if f['type']=='Plane']
            self.assertEqual(len(ends),2)
            s=study([{'faces':bore,'axes':[True,True,False],'frame':'cylinder'},
                      {'faces':ends,'axes':[True,False,False],'frame':'normal'}],
                     [{'kind':'pressure','faces':outside,'magnitude':p}],3)
            mesh=worker.mesh_part(folder,s)
            result=worker.solve(folder,s)
            A=-p*(1+NU)*(1-2*NU)/(E*(1+(1-2*NU)*a**2/b**2))
            expected=A*(b-a**2/b)
            xyz=np.asarray(mesh['surface']['positions']).reshape(-1,3)
            u=np.asarray(result['displacements'])
            nodes={n for f in outside for n in mesh['faces'][str(f)]['nodes']}
            index={n:i for i,n in enumerate(mesh['surface']['nodeIds'])}
            radial=[]
            for n in nodes:
                r=xyz[index[n]]-np.dot(xyz[index[n]],axis)*axis
                radial.append(np.dot(u[index[n]],r/np.linalg.norm(r)))
            self.assertLess(abs(np.mean(radial)/expected-1),.01)
            # Pressure all round: no net force on the supports.
            np.testing.assert_allclose(result['summary']['reactions'],[0,0,0],atol=1e-2)
            with self.assertRaisesRegex(ValueError,'cylindrical faces'):
                worker.write_deck(folder,{**s,'supports':[{'faces':ends[:1],'axes':[True,True,True],'frame':'cylinder'}]},mesh)

    def test_each_hole_of_a_pin_support_keeps_its_own_axis(self):
        # The bracket's two bolt holes (faces 6 and 7, both along X), pinned:
        # one hole lets the bracket turn about it, two hold it. The load
        # passes to the pins, on a mesh coarse enough to facet the holes.
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);shutil.copy(ROOT/'samples/bracket.step',folder/'part.step')
            geo=worker.import_part(folder)
            pin=lambda faces:{'faces':faces,'axes':[True,False,True],'frame':'cylinder'}
            s=study([pin([6,7])],[{'kind':'force','faces':[10],'vector':[0,0,-100]}],geo['recommendedSize'])
            mesh=worker.mesh_part(folder,s)
            with self.assertRaisesRegex(ValueError,'1 rigid motions'):
                worker.write_deck(folder,{**s,'supports':[pin([6])]},mesh)
            result=worker.solve(folder,s)
            np.testing.assert_allclose(result['summary']['reactions'],[0,0,100],atol=1e-2)

if __name__=='__main__':unittest.main()
