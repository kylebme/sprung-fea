"""Optional fixture generator: Python 3.10+, cadquery==2.7.0.

Committed STEP files make tests independent of CadQuery at runtime.
Bearing-block construction draws on CadQuery's public quickstart example:
https://cadquery.readthedocs.io/en/stable/quickstart.html
All dimensions and other constructions are specific to BetterSim.
"""
from pathlib import Path
import json
import cadquery as cq

ROOT = Path(__file__).resolve().parents[1] / 'samples'

def export(name, part, features):
    solid = part.val()
    assert solid.isValid(), f'{name}: invalid CAD solid'
    assert len(part.solids().vals()) == 1, f'{name}: expected one connected solid'
    cq.exporters.export(part, str(ROOT / f'{name}.step'))
    bb = solid.BoundingBox()
    return {'name': name, 'features': features, 'volume': solid.Volume(),
            'dimensions': [bb.xlen, bb.ylen, bb.zlen]}

# A thick, rounded plate with a shaft bore and four counterbored fasteners.
bearing = (cq.Workplane('XY').box(80, 60, 16, centered=(True, True, False))
           .edges('|Z').fillet(6)
           .faces('>Z').workplane().hole(24)
           .faces('>Z').workplane().pushPoints([(-30,-20),(-30,20),(30,-20),(30,20)])
           .cboreHole(5.5, 10, 4))

# Cast-style bracket with a rounded base, two triangular gussets, and six holes.
base = (cq.Workplane('XY').box(90, 60, 8, centered=(False,True,False))
        .edges('|Z').fillet(4))
upright = cq.Workplane('XY').box(8, 60, 55, centered=(False,True,False)).translate((0,0,8))
bracket = base.union(upright)
for y in [-18, 24]:
    rib = (cq.Workplane('XZ').polyline([(8,8),(42,8),(8,42)]).close().extrude(6)
           .translate((0,y,0)))
    bracket = bracket.union(rib)
for x,y in [(60,-20),(60,20),(80,-20),(80,20)]:
    bracket = bracket.cut(cq.Workplane('XY').center(x,y).circle(3.5).extrude(10).translate((0,0,-1)))
for y in [-15, 15]:
    bracket = bracket.cut(cq.Workplane('YZ').center(y,48).circle(4.5).extrude(10).translate((-1,0,0)))

# Open electronics/mechanical housing. Thin walls, rounded pocket, crossing bores,
# and counterbored mounting holes place demands on CAD and curved tetrahedra.
housing = (cq.Workplane('XY').box(80,60,32,centered=(True,True,False))
           .edges('|Z').fillet(5))
pocket = (cq.Workplane('XY').box(64,44,26,centered=(True,True,False))
          .edges('|Z').fillet(6).translate((0,0,8)))
housing = housing.cut(pocket)
x_bore = cq.Workplane('YZ').center(0,20).circle(6).extrude(82).translate((-41,0,0))
y_bore = cq.Workplane('XZ').center(0,20).circle(5).extrude(62).translate((0,31,0))
housing = housing.cut(x_bore).cut(y_bore)
for x,y in [(-34,-24),(-34,24),(34,-24),(34,24)]:
    through = cq.Workplane('XY').center(x,y).circle(2).extrude(34).translate((0,0,-1))
    recess = cq.Workplane('XY').center(x,y).circle(3).extrude(4).translate((0,0,29))
    housing = housing.cut(through).cut(recess)

# Hollow quarter-circle elbow with annular end collars. The load path bends
# through toroidal surfaces instead of a collection of rectangular extrusions.
# center() also moves the revolve-axis coordinates, so define it relative to
# the moved workplane origin: x=-40 is the world Z axis.
elbow = cq.Workplane('XZ').center(40,0).circle(10).circle(7).revolve(90,(-40,0),(-40,1))
# XZ normal points toward -Y: first collar extends backward from the inlet.
inlet = cq.Workplane('XZ').center(40,0).circle(16).circle(7).extrude(5)
# YZ normal points toward +X: second collar extends backward from the outlet.
outlet = cq.Workplane('YZ').center(40,0).circle(16).circle(7).extrude(-5)
elbow = elbow.union(inlet).union(outlet)

manifest = [
    export('bearing-block', bearing, ['central bearing bore','four counterbores','rounded corners']),
    export('ribbed-bracket', bracket, ['two triangular ribs','rounded base','six mounting holes']),
    export('pocketed-housing', housing, ['rounded deep pocket','intersecting side bores','four counterbores','thin walls']),
    export('tube-elbow', elbow, ['toroidal inner and outer walls','90-degree bend','annular end collars']),
]
(ROOT / 'complex-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2))
