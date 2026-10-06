"""Assembly fixtures: STEP files holding several solids.

split-beam:  the 100 × 20 × 10 mm beam as two 50 mm solids meeting at x = 50.
post-plate:  a 20 × 20 × 40 mm post standing on an 80 × 60 × 6 mm plate.
gap-pair:    two blocks with a 1 mm gap between them (not connected).
bolted-joint: a lap joint, two 60 × 30 × 8 mm plates overlapping 25 mm,
             clamped by a bolt with a 10 mm shank in 11 mm holes, its head
             and nut 16 mm across and 6 mm thick. The plates touch each
             other, the head and the nut; the shank touches nothing."""
from pathlib import Path
import gmsh
root=Path(__file__).resolve().parent.parent/'samples'
gmsh.initialize()
gmsh.option.setNumber('General.Terminal',0)
def save(name,boxes):
    gmsh.clear();gmsh.model.add(name)
    for b in boxes: gmsh.model.occ.addBox(*b)
    gmsh.model.occ.synchronize()
    gmsh.write(str(root/f'{name}.step'))
save('split-beam',[(0,0,0,50,20,10),(50,0,0,50,20,10)])
save('post-plate',[(0,0,0,80,60,6),(30,20,6,20,20,40)])
save('gap-pair',[(0,0,0,40,20,10),(41,0,0,40,20,10)])
gmsh.clear();gmsh.model.add('bolted-joint');occ=gmsh.model.occ
for plate in (occ.addBox(0,0,0,60,30,8),occ.addBox(35,0,8,60,30,8)):
    occ.cut([(3,plate)],[(3,occ.addCylinder(47.5,15,-1,0,0,18,5.5))])
head=occ.addCylinder(47.5,15,16,0,0,6,8)
occ.fuse([(3,head)],[(3,occ.addCylinder(47.5,15,-6,0,0,28,5)),(3,occ.addCylinder(47.5,15,-6,0,0,6,8))])
occ.synchronize();gmsh.write(str(root/'bolted-joint.step'))
gmsh.finalize()
