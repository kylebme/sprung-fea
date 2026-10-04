"""Assembly fixtures: STEP files holding several solids.

split-beam:  the 100 × 20 × 10 mm beam as two 50 mm solids meeting at x = 50.
post-plate:  a 20 × 20 × 40 mm post standing on an 80 × 60 × 6 mm plate.
gap-pair:    two blocks with a 1 mm gap between them (not connected)."""
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
gmsh.finalize()
