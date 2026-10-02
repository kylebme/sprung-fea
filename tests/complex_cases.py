"""Engineering setups defined by CAD surface geometry, rather than mesh IDs."""
import copy


def setup(name, geometry):
    faces = geometry['faces']
    planes = [f for f in faces if f['type'] == 'Plane']
    def plane_at(axis, value):
        candidates = [f for f in planes if abs(f['center'][axis] - value) < 1e-4]
        if not candidates:
            raise AssertionError(f'{name}: missing plane at {axis}={value}')
        return max(candidates, key=lambda f:f['area'])['id']
    if name == 'bearing-block':
        held = plane_at(2, 0)
        cylinders = [f for f in faces if f['type'] == 'Cylinder']
        loaded = max(cylinders, key=lambda f:f['area'])['id']
        vector = [500, 0, 0]
        size = 5
    elif name == 'ribbed-bracket':
        held = plane_at(2, 0)
        loaded = plane_at(0, 8)
        vector = [300, 0, 0]
        size = 5
    elif name == 'pocketed-housing':
        held = plane_at(2, 0)
        loaded = plane_at(2, 32)
        vector = [0, 0, -500]
        size = 4
    elif name == 'tube-elbow':
        held = plane_at(1, -5)
        loaded = plane_at(0, -5)
        vector = [0, 0, -100]
        size = 4
    else:
        raise AssertionError(name)
    return {'material': {'name': 'Aluminum 6061-T6', 'young':68900, 'poisson':.33,
                         'density':2700, 'yield':276},
            'supports':[{'id':'support-1','name':'Mounting surface','faces':[held],'axes':[True]*3}],
            'loads':[{'id':'load-1','name':'Service force','kind':'force','faces':[loaded],'vector':vector,'magnitude':1}],
            'meshSize':size, 'detail':'custom'}
