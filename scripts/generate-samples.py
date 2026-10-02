from pathlib import Path
import gmsh
root=Path(__file__).resolve().parent.parent/'samples'
root.mkdir(exist_ok=True)
gmsh.initialize()
gmsh.option.setNumber('General.Terminal',0)
gmsh.model.add('Cantilever beam')
gmsh.model.occ.addBox(0,0,0,100,20,10)
gmsh.model.occ.synchronize()
gmsh.write(str(root/'beam.step'))
gmsh.clear()
gmsh.model.add('Mounting bracket')
a=gmsh.model.occ.addBox(0,0,0,70,45,8)
b=gmsh.model.occ.addBox(0,0,8,8,45,42)
s=gmsh.model.occ.fuse([(3,a)],[(3,b)])[0]
holes=[]
for y in [10,35]:
    holes.append((3,gmsh.model.occ.addCylinder(52,y,-1,0,0,10,4)))
    holes.append((3,gmsh.model.occ.addCylinder(-1,y,34,10,0,0,4)))
gmsh.model.occ.cut(s,holes)
gmsh.model.occ.synchronize()
gmsh.write(str(root/'bracket.step'))
gmsh.finalize()
